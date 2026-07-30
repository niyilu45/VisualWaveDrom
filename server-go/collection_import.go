package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	collectionPresetMaxBytes    = 1024 * 1024
	collectionMaxVariables      = 64
	collectionMaxPaths          = 128
	collectionMaxVisitedFiles   = 100000
	collectionMaxMatchesPerPath = 100
	collectionMaxTotalColumns   = 20 * 1000 * 1000
	collectionSearchCacheLimit  = 32
	collectionParserWorkers     = 4
	collectionSearchCacheTTL    = 10 * time.Minute
)

var collectionVariableNamePattern = regexp.MustCompile(`^[\p{L}_][\p{L}\p{N}_.-]*$`)
var collectionPythonVariableNamePattern = regexp.MustCompile(`^[\p{L}_][\p{L}\p{N}_]*$`)
var collectionTemplateVariablePattern = regexp.MustCompile(
	`\$\{([\p{L}_][\p{L}\p{N}_.-]*)\}|\{\{([\p{L}_][\p{L}\p{N}_.-]*)\}\}|\{([\p{L}_][\p{L}\p{N}_.-]*)\}`,
)
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
	RootPath     string                  `json:"rootPath"`
	Preset       collectionPreset        `json:"preset"`
	Variables    map[string]string       `json:"variables"`
	Entries      []collectionSearchEntry `json:"entries"`
	ResultCount  int                     `json:"resultCount"`
	Ready        bool                    `json:"ready"`
	SearchToken  string                  `json:"searchToken,omitempty"`
	ScanCount    int                     `json:"scanCount"`
	VisitedFiles int                     `json:"visitedFiles"`
	DurationMS   int64                   `json:"durationMs"`
	RegexEngine  string                  `json:"regexEngine"`
}

type collectionCompiledRule struct {
	entryIndex int
	searchPath string
	pattern    string
}

type collectionRegexSearchRule struct {
	EntryIndex int    `json:"entryIndex"`
	SearchPath string `json:"searchPath"`
	Pattern    string `json:"pattern"`
}

type collectionRegexSearchRequest struct {
	RootPath          string                      `json:"rootPath"`
	ScanRoots         []string                    `json:"scanRoots"`
	Rules             []collectionRegexSearchRule `json:"rules"`
	MaxVisitedFiles   int                         `json:"maxVisitedFiles"`
	MaxMatchesPerRule int                         `json:"maxMatchesPerRule"`
}

type collectionRegexMatchGroup struct {
	EntryIndex int      `json:"entryIndex"`
	Paths      []string `json:"paths"`
}

type collectionRegexSearchResponse struct {
	VisitedFiles int                         `json:"visitedFiles"`
	Matches      []collectionRegexMatchGroup `json:"matches"`
}

type collectionRegexSearchRunner func(
	request collectionRegexSearchRequest,
) (collectionRegexSearchResponse, error)

type collectionSearchCacheEntry struct {
	createdAt time.Time
	signature string
	result    collectionSearchResult
}

type collectionImportEntryResult struct {
	updates []map[string]any
	file    map[string]any
	err     error
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

func parseCollectionPythonFString(template string) (string, bool) {
	text := strings.TrimSpace(template)
	if len(text) < 3 {
		return text, false
	}
	quoteIndex := -1
	lower := strings.ToLower(text)
	if lower[0] == 'f' && (text[1] == '"' || text[1] == '\'') {
		quoteIndex = 1
	} else if len(text) >= 4 &&
		((lower[:2] == "fr") || (lower[:2] == "rf")) &&
		(text[2] == '"' || text[2] == '\'') {
		quoteIndex = 2
	}
	if quoteIndex < 0 || text[len(text)-1] != text[quoteIndex] {
		return text, false
	}
	return text[quoteIndex+1 : len(text)-1], true
}

func extractCollectionTemplateVariables(template string) []string {
	result := []string{}
	seen := make(map[string]bool)
	if body, isFString := parseCollectionPythonFString(template); isFString {
		for index := 0; index < len(body); index++ {
			if body[index] != '{' {
				continue
			}
			if index+1 < len(body) && body[index+1] == '{' {
				index++
				continue
			}
			endOffset := strings.IndexByte(body[index+1:], '}')
			if endOffset < 0 {
				break
			}
			end := index + 1 + endOffset
			name := strings.TrimSpace(body[index+1 : end])
			if collectionPythonVariableNamePattern.MatchString(name) && !seen[name] {
				seen[name] = true
				result = append(result, name)
			}
			index = end
		}
		return result
	}
	for _, match := range collectionTemplateVariablePattern.FindAllStringSubmatch(template, -1) {
		for groupIndex := 1; groupIndex < len(match); groupIndex++ {
			name := match[groupIndex]
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			result = append(result, name)
			break
		}
	}
	return result
}

func normalizeCollectionPreset(value any) (collectionPreset, error) {
	raw, ok := value.(map[string]any)
	if !ok {
		return collectionPreset{}, errors.New("preset must be a JSON object")
	}
	rawVars := []any{}
	if rawValue, supplied := raw["vars"]; supplied {
		rawVars, ok = anyList(rawValue)
		if !ok {
			return collectionPreset{}, errors.New(
				"vars must be an array or may be omitted for automatic extraction",
			)
		}
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
		for _, variableName := range extractCollectionTemplateVariables(grepKeys) {
			if seenVariables[variableName] {
				continue
			}
			if len(preset.Vars) >= collectionMaxVariables {
				return collectionPreset{}, fmt.Errorf(
					"grepKeys cannot contain more than %d variables",
					collectionMaxVariables,
				)
			}
			seenVariables[variableName] = true
			preset.Vars = append(preset.Vars, variableName)
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
	raw := map[string]any{}
	if value != nil {
		var ok bool
		raw, ok = value.(map[string]any)
		if !ok {
			return nil, errors.New("variables must be an object")
		}
	}
	result := make(map[string]string, len(preset.Vars))
	for _, name := range preset.Vars {
		rawValue, supplied := raw[name]
		text := ""
		if supplied {
			var ok bool
			text, ok = rawValue.(string)
			if !ok {
				return nil, fmt.Errorf("variable %s must be a string", name)
			}
			text = strings.TrimSpace(text)
		}
		if text == "" {
			text = "0"
		}
		if len(text) > 512 {
			return nil, fmt.Errorf("variable %s is too long", name)
		}
		result[name] = text
	}
	return result, nil
}

func renderCollectionPythonFString(
	body string,
	preset collectionPreset,
	values map[string]string,
	regexValues bool,
) (string, error) {
	knownVariables := make(map[string]bool, len(preset.Vars))
	for _, name := range preset.Vars {
		knownVariables[name] = true
	}
	var result strings.Builder
	result.Grow(len(body))
	for index := 0; index < len(body); {
		if index+1 < len(body) && body[index:index+2] == "{{" {
			result.WriteByte('{')
			index += 2
			continue
		}
		if index+1 < len(body) && body[index:index+2] == "}}" {
			result.WriteByte('}')
			index += 2
			continue
		}
		if body[index] != '{' {
			result.WriteByte(body[index])
			index++
			continue
		}
		endOffset := strings.IndexByte(body[index+1:], '}')
		if endOffset < 0 {
			return "", errors.New("unterminated Python f-string placeholder")
		}
		end := index + 1 + endOffset
		name := strings.TrimSpace(body[index+1 : end])
		if !collectionPythonVariableNamePattern.MatchString(name) {
			return "", fmt.Errorf(
				"unsupported Python f-string expression {%s}; use a variable name",
				name,
			)
		}
		if !knownVariables[name] {
			return "", fmt.Errorf("unresolved preset variable {%s}", name)
		}
		value := strings.TrimSpace(values[name])
		if value == "" {
			value = "0"
		}
		if regexValues {
			value = regexp.QuoteMeta(value)
		}
		result.WriteString(value)
		index = end + 1
	}
	return result.String(), nil
}

func expandCollectionTemplate(
	template string,
	preset collectionPreset,
	values map[string]string,
	regexValues bool,
) (string, error) {
	if body, isFString := parseCollectionPythonFString(template); isFString {
		return renderCollectionPythonFString(body, preset, values, regexValues)
	}
	result := template
	for _, name := range preset.Vars {
		value := strings.TrimSpace(values[name])
		if value == "" {
			value = "0"
		}
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

const timeFormatRFC3339Nano = "2006-01-02T15:04:05.999999999Z07:00"

func collectionPathKey(value string) string {
	value = filepath.Clean(value)
	if runtime.GOOS == "windows" {
		return strings.ToLower(value)
	}
	return value
}

func collectionScanRoots(rules []collectionCompiledRule) []string {
	unique := make(map[string]string)
	for _, rule := range rules {
		unique[collectionPathKey(rule.searchPath)] = rule.searchPath
	}
	candidates := make([]string, 0, len(unique))
	for _, searchPath := range unique {
		candidates = append(candidates, searchPath)
	}
	sort.Slice(candidates, func(left, right int) bool {
		return collectionPathKey(candidates[left]) < collectionPathKey(candidates[right])
	})
	return candidates
}

func collectionFileInFolder(folderPath, filePath string) bool {
	return collectionPathKey(filepath.Dir(filePath)) == collectionPathKey(folderPath)
}

func scanCollectionFiles(
	rootPath string,
	rules []collectionCompiledRule,
	result *collectionSearchResult,
	runner collectionRegexSearchRunner,
) error {
	scanRoots := collectionScanRoots(rules)
	result.ScanCount = len(scanRoots)
	if len(rules) == 0 {
		return nil
	}
	if runner == nil {
		return errors.New("Python regex matcher is not available")
	}
	requestRules := make([]collectionRegexSearchRule, len(rules))
	rulesByEntry := make(map[int]collectionCompiledRule, len(rules))
	for index, rule := range rules {
		requestRules[index] = collectionRegexSearchRule{
			EntryIndex: rule.entryIndex,
			SearchPath: rule.searchPath,
			Pattern:    rule.pattern,
		}
		rulesByEntry[rule.entryIndex] = rule
	}
	response, err := runner(collectionRegexSearchRequest{
		RootPath: rootPath, ScanRoots: scanRoots, Rules: requestRules,
		MaxVisitedFiles:   collectionMaxVisitedFiles,
		MaxMatchesPerRule: collectionMaxMatchesPerPath,
	})
	if err != nil {
		return err
	}
	if response.VisitedFiles < 0 || response.VisitedFiles > collectionMaxVisitedFiles {
		return errors.New("Python regex matcher returned an invalid visited file count")
	}
	result.VisitedFiles = response.VisitedFiles
	seenGroups := make(map[int]bool)
	for _, group := range response.Matches {
		rule, found := rulesByEntry[group.EntryIndex]
		if !found || seenGroups[group.EntryIndex] {
			return errors.New("Python regex matcher returned an invalid rule result")
		}
		seenGroups[group.EntryIndex] = true
		if len(group.Paths) > collectionMaxMatchesPerPath {
			return fmt.Errorf(
				"paths[%d] matched more than %d files",
				result.Entries[group.EntryIndex].Index,
				collectionMaxMatchesPerPath,
			)
		}
		seenPaths := make(map[string]bool, len(group.Paths))
		for _, rawPath := range group.Paths {
			path := canonicalExistingPath(rawPath)
			pathKey := collectionPathKey(path)
			if seenPaths[pathKey] || !collectionFileInFolder(rule.searchPath, path) {
				return errors.New("Python regex matcher returned an invalid file path")
			}
			seenPaths[pathKey] = true
			info, statErr := os.Stat(path)
			if statErr != nil || !info.Mode().IsRegular() {
				if statErr != nil {
					return statErr
				}
				return fmt.Errorf("matched path is not a regular file: %s", path)
			}
			relative, relativeErr := filepath.Rel(rootPath, path)
			if relativeErr != nil {
				relative = filepath.Base(path)
			}
			result.Entries[group.EntryIndex].Matches = append(
				result.Entries[group.EntryIndex].Matches,
				collectionFileMatch{
					Path: path, RelativePath: filepath.ToSlash(relative),
					FileName: filepath.Base(path), Size: info.Size(),
					ModifiedAt: info.ModTime().UTC().Format(timeFormatRFC3339Nano),
				},
			)
		}
	}
	if len(seenGroups) != len(rules) {
		return errors.New("Python regex matcher returned incomplete rule results")
	}
	return nil
}

func searchCollectionFiles(
	rawRootPath string,
	baseDir string,
	preset collectionPreset,
	variables map[string]string,
	runner collectionRegexSearchRunner,
) (collectionSearchResult, error) {
	startedAt := time.Now()
	rootPath, err := resolveCollectionRoot(rawRootPath, baseDir)
	if err != nil {
		return collectionSearchResult{}, err
	}
	result := collectionSearchResult{
		RootPath: rootPath, Preset: preset, Variables: variables,
		Entries:     []collectionSearchEntry{},
		RegexEngine: "python-re",
	}
	rules := make([]collectionCompiledRule, 0, len(preset.Paths))
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
		entry := collectionSearchEntry{
			Index: index, Folder: folder, SearchPath: searchPath,
			GrepKeys: rule.GrepKeys, ResolvedPattern: patternText,
			HasSeq: rule.HasSeq, Name: signalName, Matches: []collectionFileMatch{},
		}
		info, statErr := os.Stat(searchPath)
		if statErr != nil || !info.IsDir() {
			entry.Status = "folder-missing"
			entry.Message = "搜索目录不存在"
			result.Entries = append(result.Entries, entry)
			continue
		}
		searchPath = canonicalExistingPath(searchPath)
		entry.SearchPath = searchPath
		if !pathInside(rootPath, searchPath) {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].folder resolves outside the selected folder", index)
		}
		entryIndex := len(result.Entries)
		result.Entries = append(result.Entries, entry)
		rules = append(rules, collectionCompiledRule{
			entryIndex: entryIndex, searchPath: searchPath, pattern: patternText,
		})
	}
	if err = scanCollectionFiles(rootPath, rules, &result, runner); err != nil {
		return collectionSearchResult{}, fmt.Errorf("collection search failed: %w", err)
	}
	for index := range result.Entries {
		entry := &result.Entries[index]
		sort.Slice(entry.Matches, func(left, right int) bool {
			return entry.Matches[left].RelativePath < entry.Matches[right].RelativePath
		})
		switch len(entry.Matches) {
		case 0:
			if entry.Status != "folder-missing" {
				entry.Status = "missing"
				entry.Message = "没有找到匹配文件"
			}
		case 1:
			entry.Status = "matched"
			result.ResultCount++
		default:
			entry.Status = "multiple"
			entry.Message = "匹配到多个文件，默认选择排序后的第一个文件"
			result.ResultCount++
		}
	}
	result.Ready = result.ResultCount > 0

	nameEntries := make(map[string][]int)
	for index, entry := range result.Entries {
		if entry.Status == "matched" || entry.Status == "multiple" {
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
	result.DurationMS = time.Since(startedAt).Milliseconds()
	return result, nil
}

func collectionSearchSignature(
	rootPath string,
	preset collectionPreset,
	variables map[string]string,
) string {
	payload := struct {
		RootPath  string            `json:"rootPath"`
		Preset    collectionPreset  `json:"preset"`
		Variables map[string]string `json:"variables"`
	}{
		RootPath: rootPath, Preset: preset, Variables: variables,
	}
	data, _ := json.Marshal(payload)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum[:])
}

func (s *service) rememberCollectionSearch(
	result collectionSearchResult,
) collectionSearchResult {
	now := time.Now()
	token := stableID("collection-search")
	result.SearchToken = token
	entry := collectionSearchCacheEntry{
		createdAt: now,
		signature: collectionSearchSignature(result.RootPath, result.Preset, result.Variables),
		result:    result,
	}
	s.collectionSearchMu.Lock()
	defer s.collectionSearchMu.Unlock()
	if s.collectionSearchCache == nil {
		s.collectionSearchCache = make(map[string]collectionSearchCacheEntry)
	}
	for key, cached := range s.collectionSearchCache {
		if now.Sub(cached.createdAt) > collectionSearchCacheTTL {
			delete(s.collectionSearchCache, key)
		}
	}
	for len(s.collectionSearchCache) >= collectionSearchCacheLimit {
		oldestKey := ""
		var oldestTime time.Time
		for key, cached := range s.collectionSearchCache {
			if oldestKey == "" || cached.createdAt.Before(oldestTime) {
				oldestKey = key
				oldestTime = cached.createdAt
			}
		}
		if oldestKey == "" {
			break
		}
		delete(s.collectionSearchCache, oldestKey)
	}
	s.collectionSearchCache[token] = entry
	return result
}

func validateCachedCollectionFiles(result collectionSearchResult) error {
	if !result.Ready {
		return errors.New("cached search results are incomplete")
	}
	matchedCount := 0
	for _, entry := range result.Entries {
		if entry.Status == "missing" || entry.Status == "folder-missing" {
			if len(entry.Matches) != 0 {
				return errors.New("cached skipped search result contains a match")
			}
			continue
		}
		if (entry.Status != "matched" && entry.Status != "multiple") ||
			len(entry.Matches) < 1 {
			return errors.New("cached search results are incomplete")
		}
		matchedCount++
		match := entry.Matches[0]
		sourcePath := canonicalExistingPath(match.Path)
		if !pathInside(result.RootPath, sourcePath) {
			return errors.New("a matched file moved outside the selected data folder")
		}
		info, err := os.Stat(sourcePath)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("matched file is no longer available: %s", match.RelativePath)
		}
		if info.Size() != match.Size ||
			info.ModTime().UTC().Format(timeFormatRFC3339Nano) != match.ModifiedAt {
			return fmt.Errorf("matched file changed after searching: %s", match.RelativePath)
		}
	}
	if matchedCount == 0 || matchedCount != result.ResultCount {
		return errors.New("cached search result count is invalid")
	}
	return nil
}

func (s *service) cachedCollectionSearch(
	token string,
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
) (collectionSearchResult, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return collectionSearchResult{}, errors.New("search token is missing; search again")
	}
	rootPath, err := resolveCollectionRoot(rawRootPath, s.config.rootDir)
	if err != nil {
		return collectionSearchResult{}, err
	}
	signature := collectionSearchSignature(rootPath, preset, variables)
	s.collectionSearchMu.Lock()
	cached, found := s.collectionSearchCache[token]
	if found && time.Since(cached.createdAt) > collectionSearchCacheTTL {
		delete(s.collectionSearchCache, token)
		found = false
	}
	s.collectionSearchMu.Unlock()
	if !found {
		return collectionSearchResult{}, errors.New("search results expired; search again")
	}
	if cached.signature != signature {
		return collectionSearchResult{}, errors.New("folder, variables, or preset changed; search again")
	}
	if err = validateCachedCollectionFiles(cached.result); err != nil {
		return collectionSearchResult{}, fmt.Errorf("%w; search again", err)
	}
	return cached.result, nil
}

func (s *service) parseCollectionEntry(
	catalog importCatalog,
	search collectionSearchResult,
	entry collectionSearchEntry,
) collectionImportEntryResult {
	match := entry.Matches[0]
	sourcePath := canonicalExistingPath(match.Path)
	if !pathInside(search.RootPath, sourcePath) {
		return collectionImportEntryResult{
			err: errors.New("a matched file moved outside the selected data folder"),
		}
	}
	lines, err := readImportSampleLines(sourcePath)
	if err != nil {
		return collectionImportEntryResult{err: err}
	}
	analysis := analyzeImportSample(match.FileName, lines, entry.HasSeq)
	recommended := recommendScheme(catalog.Schemes, analysis)
	if recommended == nil {
		return collectionImportEntryResult{
			err: fmt.Errorf("no parser preset can process %s", match.RelativePath),
		}
	}
	result, err := s.imports.runLocalFile(
		stringValue(recommended["schemeId"]),
		intValue(recommended["mappingIndex"], -1),
		entry.Name,
		sourcePath,
		entry.HasSeq,
	)
	if err != nil {
		return collectionImportEntryResult{
			err: fmt.Errorf("%s: %w", match.RelativePath, err),
		}
	}
	fileUpdates, _ := result["updates"].([]map[string]any)
	if len(fileUpdates) == 0 {
		return collectionImportEntryResult{
			err: fmt.Errorf("%s produced no signal updates", match.RelativePath),
		}
	}
	return collectionImportEntryResult{
		updates: fileUpdates,
		file: map[string]any{
			"path": match.Path, "relativePath": match.RelativePath,
			"signal": entry.Name, "hasSeq": entry.HasSeq,
			"parser": recommended["parser"], "analysis": analysis,
			"updateCount": len(fileUpdates), "matchCount": len(entry.Matches),
		},
	}
}

func (s *service) importCollectionFiles(
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
	searchToken string,
) (map[string]any, error) {
	startedAt := time.Now()
	search, err := s.cachedCollectionSearch(
		searchToken, rawRootPath, preset, variables)
	if err != nil {
		return nil, err
	}
	if !search.Ready {
		return nil, errors.New("search results are incomplete or ambiguous; search again after editing the preset")
	}
	importEntries := make([]collectionSearchEntry, 0, search.ResultCount)
	for _, entry := range search.Entries {
		if entry.Status == "matched" || entry.Status == "multiple" {
			importEntries = append(importEntries, entry)
		}
	}
	if len(importEntries) == 0 {
		return nil, errors.New("search did not find any files to import")
	}
	catalog := s.imports.listSchemes()
	if len(catalog.Schemes) == 0 {
		return nil, errors.New("import/Scheme does not contain a usable parser preset")
	}
	python := s.imports.pythonRuntime()
	if !python.Available {
		return nil, errors.New(python.Error)
	}
	entryResults := make([]collectionImportEntryResult, len(importEntries))
	workerCount := runtime.GOMAXPROCS(0)
	if workerCount > collectionParserWorkers {
		workerCount = collectionParserWorkers
	}
	if workerCount > len(importEntries) {
		workerCount = len(importEntries)
	}
	if workerCount < 1 {
		workerCount = 1
	}
	parseStartedAt := time.Now()
	jobs := make(chan int)
	var workers sync.WaitGroup
	for workerIndex := 0; workerIndex < workerCount; workerIndex++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				entryResults[index] = s.parseCollectionEntry(
					catalog, search, importEntries[index])
			}
		}()
	}
	for index := range importEntries {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	parseDurationMS := time.Since(parseStartedAt).Milliseconds()

	updates := make([]map[string]any, 0, len(importEntries))
	files := make([]map[string]any, 0, len(importEntries))
	updateNames := make(map[string]bool)
	totalColumns := 0
	for _, entryResult := range entryResults {
		if entryResult.err != nil {
			return nil, entryResult.err
		}
		for _, update := range entryResult.updates {
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
		files = append(files, entryResult.file)
	}
	return map[string]any{
		"rootPath": search.RootPath, "preset": preset, "variables": variables,
		"search": search, "files": files, "updates": updates,
		"skippedCount": len(search.Entries) - len(importEntries),
		"workerCount":  workerCount, "parseDurationMs": parseDurationMS,
		"durationMs": time.Since(startedAt).Milliseconds(),
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
				stringValue(payload["rootPath"]),
				s.config.rootDir,
				preset,
				variables,
				s.imports.runCollectionRegexSearch,
			)
			if searchErr != nil {
				sendJSON(writer, 400, map[string]any{"error": searchErr.Error()})
				return
			}
			result = s.rememberCollectionSearch(result)
			sendJSON(writer, 200, result)
			return
		}
		result, importErr := s.importCollectionFiles(
			stringValue(payload["rootPath"]),
			preset,
			variables,
			stringValue(payload["searchToken"]),
		)
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
