package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	collectionPresetMaxBytes    = 1024 * 1024
	collectionMaxVariables      = 64
	collectionMaxPaths          = 128
	collectionMaxVisitedFiles   = 100000
	collectionMaxMatchesPerPath = 100
	collectionMaxTotalColumns   = 20 * 1000 * 1000
)

var collectionVariableNamePattern = regexp.MustCompile(`^[\p{L}_][\p{L}\p{N}_.-]*$`)
var collectionUnresolvedVariablePattern = regexp.MustCompile(
	`\$\{[\p{L}_][\p{L}\p{N}_.-]*\}|\{\{[\p{L}_][\p{L}\p{N}_.-]*\}\}|\{[\p{L}_][\p{L}\p{N}_.-]*\}`,
)

type collectionPresetPath struct {
	Folder   string `json:"folder"`
	GrepKeys string `json:"grepKeys"`
	HasSeq   bool   `json:"hasSeq"`
	Name     string `json:"name"`
}

type collectionPreset struct {
	Vars  []string               `json:"vars"`
	Paths []collectionPresetPath `json:"paths"`
}

type collectionFileMatch struct {
	Path         string `json:"path"`
	RelativePath string `json:"relativePath"`
	FileName     string `json:"fileName"`
	Size         int64  `json:"size"`
	ModifiedAt   string `json:"modifiedAt"`
}

type collectionSearchEntry struct {
	Index           int                   `json:"index"`
	Folder          string                `json:"folder"`
	SearchPath      string                `json:"searchPath"`
	GrepKeys        string                `json:"grepKeys"`
	ResolvedPattern string                `json:"resolvedPattern"`
	HasSeq          bool                  `json:"hasSeq"`
	Name            string                `json:"name"`
	Status          string                `json:"status"`
	Message         string                `json:"message,omitempty"`
	Matches         []collectionFileMatch `json:"matches"`
}

type collectionSearchResult struct {
	RootPath    string                  `json:"rootPath"`
	Preset      collectionPreset        `json:"preset"`
	Variables   map[string]string       `json:"variables"`
	Entries     []collectionSearchEntry `json:"entries"`
	ResultCount int                     `json:"resultCount"`
	Ready       bool                    `json:"ready"`
}

func anyList(value any) ([]any, bool) {
	switch typed := value.(type) {
	case []any:
		return typed, true
	case []string:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = item
		}
		return result, true
	default:
		return nil, false
	}
}

func normalizeCollectionPreset(value any) (collectionPreset, error) {
	raw, ok := value.(map[string]any)
	if !ok {
		return collectionPreset{}, errors.New("preset must be a JSON object")
	}
	rawVars, ok := anyList(raw["vars"])
	if !ok {
		return collectionPreset{}, errors.New("vars must be an array")
	}
	if len(rawVars) > collectionMaxVariables {
		return collectionPreset{}, fmt.Errorf("vars cannot contain more than %d items", collectionMaxVariables)
	}
	preset := collectionPreset{
		Vars:  make([]string, 0, len(rawVars)),
		Paths: []collectionPresetPath{},
	}
	seenVariables := make(map[string]bool)
	for index, rawVariable := range rawVars {
		name, ok := rawVariable.(string)
		name = strings.TrimSpace(name)
		if !ok || name == "" || !collectionVariableNamePattern.MatchString(name) {
			return collectionPreset{}, fmt.Errorf("vars[%d] is not a valid variable name", index)
		}
		if seenVariables[name] {
			return collectionPreset{}, fmt.Errorf("vars contains duplicate variable %s", name)
		}
		seenVariables[name] = true
		preset.Vars = append(preset.Vars, name)
	}

	rawPaths, ok := anyList(raw["paths"])
	if !ok {
		return collectionPreset{}, errors.New("paths must be an array")
	}
	if len(rawPaths) > collectionMaxPaths {
		return collectionPreset{}, fmt.Errorf("paths cannot contain more than %d items", collectionMaxPaths)
	}
	for index, rawPath := range rawPaths {
		entry, ok := rawPath.(map[string]any)
		if !ok {
			return collectionPreset{}, fmt.Errorf("paths[%d] must be an object", index)
		}
		folder, folderOK := entry["folder"].(string)
		grepKeys, grepOK := entry["grepKeys"].(string)
		name, nameOK := entry["name"].(string)
		hasSeq, sequenceOK := entry["hasSeq"].(bool)
		grepKeys = strings.TrimSpace(grepKeys)
		name = strings.TrimSpace(name)
		if !folderOK {
			return collectionPreset{}, fmt.Errorf("paths[%d].folder must be a string", index)
		}
		if !grepOK || grepKeys == "" {
			return collectionPreset{}, fmt.Errorf("paths[%d].grepKeys must be a non-empty regex string", index)
		}
		if !sequenceOK {
			return collectionPreset{}, fmt.Errorf("paths[%d].hasSeq must be true or false", index)
		}
		if !nameOK || name == "" {
			return collectionPreset{}, fmt.Errorf("paths[%d].name must be a non-empty string", index)
		}
		if len(folder) > 2048 || len(grepKeys) > 4096 || len(name) > 256 {
			return collectionPreset{}, fmt.Errorf("paths[%d] contains an overlong value", index)
		}
		preset.Paths = append(preset.Paths, collectionPresetPath{
			Folder: folder, GrepKeys: grepKeys, HasSeq: hasSeq, Name: name,
		})
	}
	return preset, nil
}

func normalizeCollectionVariables(
	value any,
	preset collectionPreset,
) (map[string]string, error) {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("variables must be an object")
	}
	result := make(map[string]string, len(preset.Vars))
	for _, name := range preset.Vars {
		rawValue, supplied := raw[name]
		if !supplied {
			return nil, fmt.Errorf("variable %s is required", name)
		}
		text, ok := rawValue.(string)
		text = strings.TrimSpace(text)
		if !ok || text == "" {
			return nil, fmt.Errorf("variable %s must be a non-empty string", name)
		}
		if len(text) > 512 {
			return nil, fmt.Errorf("variable %s is too long", name)
		}
		result[name] = text
	}
	return result, nil
}

func expandCollectionTemplate(
	template string,
	preset collectionPreset,
	values map[string]string,
	regexValues bool,
) (string, error) {
	result := template
	for _, name := range preset.Vars {
		value := values[name]
		if regexValues {
			value = regexp.QuoteMeta(value)
		}
		for _, placeholder := range []string{
			"${" + name + "}",
			"{{" + name + "}}",
			"{" + name + "}",
		} {
			result = strings.ReplaceAll(result, placeholder, value)
		}
	}
	if unresolved := collectionUnresolvedVariablePattern.FindString(result); unresolved != "" {
		return "", fmt.Errorf("unresolved preset variable %s", unresolved)
	}
	return result, nil
}

func normalizeLocalPathInput(rawPath, baseDir string) (string, error) {
	value := strings.TrimSpace(rawPath)
	if len(value) >= 2 {
		first, last := value[0], value[len(value)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			value = strings.TrimSpace(value[1 : len(value)-1])
		}
	}
	if value == "" {
		return "", errors.New("local path is required")
	}
	if strings.HasPrefix(strings.ToLower(value), "file:") {
		parsed, err := url.Parse(value)
		if err != nil || !strings.EqualFold(parsed.Scheme, "file") {
			return "", errors.New("invalid local file URL")
		}
		decodedPath, decodeErr := url.PathUnescape(parsed.EscapedPath())
		if decodeErr != nil {
			return "", errors.New("invalid local file URL")
		}
		if parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost") {
			if runtime.GOOS != "windows" {
				return "", errors.New("remote file URLs are not supported")
			}
			value = `\\` + parsed.Host + filepath.FromSlash(decodedPath)
		} else {
			value = filepath.FromSlash(decodedPath)
			if runtime.GOOS == "windows" && len(value) >= 3 &&
				(value[0] == '\\' || value[0] == '/') && value[2] == ':' {
				value = value[1:]
			}
		}
	}
	if value == "~" || strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("could not resolve home directory: %w", err)
		}
		if value == "~" {
			value = home
		} else {
			value = filepath.Join(home, filepath.FromSlash(value[2:]))
		}
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(baseDir, value)
	}
	resolved, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("invalid local path: %w", err)
	}
	return filepath.Clean(resolved), nil
}

func resolveCollectionRoot(rawPath, baseDir string) (string, error) {
	resolved, err := normalizeLocalPathInput(rawPath, baseDir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("data folder was not found: %s", resolved)
	}
	if !info.IsDir() {
		return "", errors.New("data folder path must point to a directory")
	}
	return canonicalExistingPath(resolved), nil
}

func resolveCollectionPresetFile(rawPath, baseDir string) (string, error) {
	resolved, _, err := resolvePastedImportPath(rawPath, baseDir)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(filepath.Ext(resolved), ".json") {
		return "", errors.New("preset file must use the .json extension")
	}
	return resolved, nil
}

func loadCollectionPreset(rawPath, baseDir string) (collectionPreset, string, error) {
	presetPath, err := resolveCollectionPresetFile(rawPath, baseDir)
	if err != nil {
		return collectionPreset{}, "", err
	}
	info, err := os.Stat(presetPath)
	if err != nil {
		return collectionPreset{}, "", err
	}
	if info.Size() > collectionPresetMaxBytes {
		return collectionPreset{}, "", errors.New("preset JSON cannot exceed 1 MB")
	}
	data, err := os.ReadFile(presetPath)
	if err != nil {
		return collectionPreset{}, "", err
	}
	var raw map[string]any
	if err = json.Unmarshal(data, &raw); err != nil {
		return collectionPreset{}, "", fmt.Errorf("preset JSON is invalid: %w", err)
	}
	preset, err := normalizeCollectionPreset(raw)
	if err != nil {
		return collectionPreset{}, "", err
	}
	return preset, presetPath, nil
}

func saveCollectionPreset(
	rawPath string,
	baseDir string,
	preset collectionPreset,
) (string, error) {
	resolved, err := normalizeLocalPathInput(rawPath, baseDir)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(filepath.Ext(resolved), ".json") {
		resolved += ".json"
	}
	if info, statErr := os.Stat(resolved); statErr == nil && info.IsDir() {
		return "", errors.New("preset save path points to a directory")
	}
	if err = writeJSONAtomically(resolved, preset); err != nil {
		return "", err
	}
	return resolved, nil
}

func collectCollectionMatches(
	rootPath string,
	searchPath string,
	pattern *regexp.Regexp,
) ([]collectionFileMatch, error) {
	matches := make([]collectionFileMatch, 0)
	visited := 0
	err := filepath.WalkDir(searchPath, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		visited++
		if visited > collectionMaxVisitedFiles {
			return fmt.Errorf("search folder contains more than %d files", collectionMaxVisitedFiles)
		}
		if !pattern.MatchString(entry.Name()) {
			return nil
		}
		if len(matches) >= collectionMaxMatchesPerPath {
			return fmt.Errorf("one search rule matched more than %d files", collectionMaxMatchesPerPath)
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return err
		}
		relative, err := filepath.Rel(rootPath, path)
		if err != nil {
			relative = entry.Name()
		}
		matches = append(matches, collectionFileMatch{
			Path: canonicalExistingPath(path), RelativePath: filepath.ToSlash(relative),
			FileName: entry.Name(), Size: info.Size(),
			ModifiedAt: info.ModTime().UTC().Format(timeFormatRFC3339Nano),
		})
		return nil
	})
	sort.Slice(matches, func(left, right int) bool {
		return matches[left].RelativePath < matches[right].RelativePath
	})
	return matches, err
}

const timeFormatRFC3339Nano = "2006-01-02T15:04:05.999999999Z07:00"

func searchCollectionFiles(
	rawRootPath string,
	baseDir string,
	preset collectionPreset,
	variables map[string]string,
) (collectionSearchResult, error) {
	rootPath, err := resolveCollectionRoot(rawRootPath, baseDir)
	if err != nil {
		return collectionSearchResult{}, err
	}
	result := collectionSearchResult{
		RootPath: rootPath, Preset: preset, Variables: variables,
		Entries: []collectionSearchEntry{}, Ready: len(preset.Paths) > 0,
	}
	for index, rule := range preset.Paths {
		folder, expandErr := expandCollectionTemplate(rule.Folder, preset, variables, false)
		if expandErr != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].folder: %w", index, expandErr)
		}
		patternText, expandErr := expandCollectionTemplate(
			rule.GrepKeys, preset, variables, true)
		if expandErr != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].grepKeys: %w", index, expandErr)
		}
		signalName, expandErr := expandCollectionTemplate(rule.Name, preset, variables, false)
		if expandErr != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].name: %w", index, expandErr)
		}
		signalName, expandErr = normalizeSignalName(signalName)
		if expandErr != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].name: %w", index, expandErr)
		}
		if strings.TrimSpace(folder) == "" {
			folder = "."
		}
		if filepath.IsAbs(folder) {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].folder must be relative", index)
		}
		searchPath, pathErr := filepath.Abs(filepath.Join(rootPath, filepath.FromSlash(folder)))
		if pathErr != nil || !pathInside(rootPath, searchPath) {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].folder leaves the selected data folder", index)
		}
		pattern, compileErr := regexp.Compile(patternText)
		if compileErr != nil {
			return collectionSearchResult{}, fmt.Errorf(
				"paths[%d].grepKeys is invalid after variable replacement: %w", index, compileErr)
		}
		entry := collectionSearchEntry{
			Index: index, Folder: folder, SearchPath: searchPath,
			GrepKeys: rule.GrepKeys, ResolvedPattern: patternText,
			HasSeq: rule.HasSeq, Name: signalName, Matches: []collectionFileMatch{},
		}
		info, statErr := os.Stat(searchPath)
		if statErr != nil || !info.IsDir() {
			entry.Status = "folder-missing"
			entry.Message = "搜索目录不存在"
			result.Ready = false
			result.Entries = append(result.Entries, entry)
			continue
		}
		searchPath = canonicalExistingPath(searchPath)
		entry.SearchPath = searchPath
		if !pathInside(rootPath, searchPath) {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].folder resolves outside the selected folder", index)
		}
		entry.Matches, err = collectCollectionMatches(rootPath, searchPath, pattern)
		if err != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d] search failed: %w", index, err)
		}
		switch len(entry.Matches) {
		case 0:
			entry.Status = "missing"
			entry.Message = "没有找到匹配文件"
			result.Ready = false
		case 1:
			entry.Status = "matched"
			result.ResultCount++
		default:
			entry.Status = "multiple"
			entry.Message = "正则表达式匹配到多个文件"
			result.Ready = false
		}
		result.Entries = append(result.Entries, entry)
	}

	nameEntries := make(map[string][]int)
	for index, entry := range result.Entries {
		if entry.Status == "matched" {
			nameEntries[entry.Name] = append(nameEntries[entry.Name], index)
		}
	}
	for name, indexes := range nameEntries {
		if len(indexes) < 2 {
			continue
		}
		result.Ready = false
		for _, index := range indexes {
			result.Entries[index].Status = "duplicate-name"
			result.Entries[index].Message = "多条规则生成了相同信号名：" + name
		}
	}
	return result, nil
}

func (s *service) importCollectionFiles(
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
) (map[string]any, error) {
	search, err := searchCollectionFiles(rawRootPath, s.config.rootDir, preset, variables)
	if err != nil {
		return nil, err
	}
	if !search.Ready {
		return nil, errors.New("search results are incomplete or ambiguous; search again after editing the preset")
	}
	catalog := s.imports.listSchemes()
	if len(catalog.Schemes) == 0 {
		return nil, errors.New("import/Scheme does not contain a usable parser preset")
	}
	updates := make([]map[string]any, 0, len(search.Entries))
	files := make([]map[string]any, 0, len(search.Entries))
	updateNames := make(map[string]bool)
	totalColumns := 0
	for _, entry := range search.Entries {
		match := entry.Matches[0]
		sourcePath := canonicalExistingPath(match.Path)
		if !pathInside(search.RootPath, sourcePath) {
			return nil, errors.New("a matched file moved outside the selected data folder")
		}
		lines, readErr := readImportSampleLines(sourcePath)
		if readErr != nil {
			return nil, readErr
		}
		analysis := analyzeImportSample(match.FileName, lines, entry.HasSeq)
		recommended := recommendScheme(catalog.Schemes, analysis)
		if recommended == nil {
			return nil, fmt.Errorf("no parser preset can process %s", match.RelativePath)
		}
		result, runErr := s.imports.runLocalFile(
			stringValue(recommended["schemeId"]),
			intValue(recommended["mappingIndex"], -1),
			entry.Name,
			sourcePath,
			entry.HasSeq,
		)
		if runErr != nil {
			return nil, fmt.Errorf("%s: %w", match.RelativePath, runErr)
		}
		fileUpdates, _ := result["updates"].([]map[string]any)
		if len(fileUpdates) == 0 {
			return nil, fmt.Errorf("%s produced no signal updates", match.RelativePath)
		}
		for _, update := range fileUpdates {
			name := stringValue(update["signal"])
			if updateNames[name] {
				return nil, fmt.Errorf("multiple imported files generate signal %s", name)
			}
			updateNames[name] = true
			totalColumns += utf8.RuneCountInString(stringValue(update["wave"]))
			if totalColumns > collectionMaxTotalColumns {
				return nil, fmt.Errorf(
					"collection import exceeds %d total waveform columns",
					collectionMaxTotalColumns,
				)
			}
			updates = append(updates, update)
		}
		files = append(files, map[string]any{
			"path": match.Path, "relativePath": match.RelativePath,
			"signal": entry.Name, "hasSeq": entry.HasSeq,
			"parser": recommended["parser"], "analysis": analysis,
			"updateCount": len(fileUpdates),
		})
	}
	return map[string]any{
		"rootPath": search.RootPath, "preset": preset, "variables": variables,
		"search": search, "files": files, "updates": updates,
	}, nil
}

func (s *service) handleImportCollection(writer http.ResponseWriter, request *http.Request) {
	payload := make(map[string]any)
	if err := decodeJSONBody(writer, request, 2*1024*1024, &payload); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	action := strings.ToLower(strings.TrimSpace(stringValue(payload["action"])))
	switch action {
	case "pick":
		kind := strings.TrimSpace(stringValue(payload["kind"]))
		initialPath := strings.TrimSpace(stringValue(payload["initialPath"]))
		if initialPath == "" {
			switch kind {
			case "preset":
				initialPath = filepath.Join(s.config.rootDir, "import", "SchemeCollection")
			case "save-preset":
				initialPath = filepath.Join(
					s.config.rootDir, "import", "SchemeCollection", "preset.json")
			default:
				initialPath = s.config.rootDir
			}
		}
		selected, cancelled, err := pickLocalPathNative(kind, initialPath)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(writer, 200, map[string]any{
			"ok": true, "path": selected, "cancelled": cancelled,
		})
	case "load":
		preset, presetPath, err := loadCollectionPreset(
			stringValue(payload["presetPath"]), s.config.rootDir)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(writer, 200, map[string]any{
			"ok": true, "presetPath": presetPath, "preset": preset,
		})
	case "save":
		preset, err := normalizeCollectionPreset(payload["preset"])
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		presetPath, err := saveCollectionPreset(
			stringValue(payload["presetPath"]), s.config.rootDir, preset)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(writer, 200, map[string]any{
			"ok": true, "presetPath": presetPath, "preset": preset,
		})
	case "search", "import":
		preset, err := normalizeCollectionPreset(payload["preset"])
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		variables, err := normalizeCollectionVariables(payload["variables"], preset)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		if action == "search" {
			result, searchErr := searchCollectionFiles(
				stringValue(payload["rootPath"]), s.config.rootDir, preset, variables)
			if searchErr != nil {
				sendJSON(writer, 400, map[string]any{"error": searchErr.Error()})
				return
			}
			sendJSON(writer, 200, result)
			return
		}
		result, importErr := s.importCollectionFiles(
			stringValue(payload["rootPath"]), preset, variables)
		if importErr != nil {
			sendJSON(writer, 400, map[string]any{"error": importErr.Error()})
			return
		}
		result["ok"] = true
		sendJSON(writer, 200, result)
	default:
		sendJSON(writer, 400, map[string]any{"error": "unknown collection import action"})
	}
}
