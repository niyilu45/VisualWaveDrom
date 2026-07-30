package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	importMaxOutputBytes  = 64 * 1024 * 1024
	importMaxWaveColumns  = 10 * 1000 * 1000
	importSampleLineLimit = 5
)

type pythonRuntime struct {
	Available  bool     `json:"available"`
	Command    string   `json:"-"`
	PrefixArgs []string `json:"-"`
	Version    string   `json:"version"`
	Error      string   `json:"error"`
}

type importMapping struct {
	File        string
	Signal      string
	Parser      string
	Options     map[string]any
	SourcePath  string
	DisplayPath string
}

type importScheme struct {
	ID          string
	Version     int
	Name        string
	Description string
	Mappings    []importMapping
}

type importCatalog struct {
	Schemes []map[string]any `json:"schemes"`
	Invalid []map[string]any `json:"invalid"`
}

type importManager struct {
	rootDir       string
	importRootDir string
	schemeDir     string
	fileProcPath  string
	pythonOnce    sync.Once
	python        pythonRuntime
}

type outputLimit struct {
	mu       sync.Mutex
	used     int
	maximum  int
	exceeded bool
}

type limitedOutputBuffer struct {
	buffer *bytes.Buffer
	limit  *outputLimit
}

func (writer *limitedOutputBuffer) Write(data []byte) (int, error) {
	writer.limit.mu.Lock()
	defer writer.limit.mu.Unlock()
	remaining := writer.limit.maximum - writer.limit.used
	if remaining <= 0 {
		writer.limit.exceeded = true
		return 0, errors.New("import output limit exceeded")
	}
	toWrite := len(data)
	if toWrite > remaining {
		toWrite = remaining
		writer.limit.exceeded = true
	}
	written, err := writer.buffer.Write(data[:toWrite])
	writer.limit.used += written
	if err != nil {
		return written, err
	}
	if toWrite < len(data) {
		return written, errors.New("import output limit exceeded")
	}
	return written, nil
}

func newImportManager(rootDir string) *importManager {
	importRoot := filepath.Join(rootDir, "import")
	return &importManager{
		rootDir:       rootDir,
		importRootDir: importRoot,
		schemeDir:     filepath.Join(importRoot, "Scheme"),
		fileProcPath:  filepath.Join(importRoot, "inc", "fileProc.py"),
	}
}

func (m *importManager) probePython(command string, prefix []string) *pythonRuntime {
	if filepath.IsAbs(command) {
		info, err := os.Stat(command)
		if err != nil || info.IsDir() {
			return nil
		}
	} else if _, err := exec.LookPath(command); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := append(append([]string{}, prefix...), "-c",
		`import sys; print("%d.%d.%d" % sys.version_info[:3])`)
	output, err := exec.CommandContext(ctx, command, args...).Output()
	if err != nil {
		return nil
	}
	version := strings.TrimSpace(string(output))
	match := regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)`).FindStringSubmatch(version)
	if len(match) != 4 {
		return nil
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	if major < 3 || (major == 3 && minor < 6) {
		return nil
	}
	return &pythonRuntime{
		Available: true, Command: command, PrefixArgs: append([]string{}, prefix...),
		Version: match[1] + "." + match[2] + "." + match[3],
	}
}

func (m *importManager) pythonRuntime() pythonRuntime {
	m.pythonOnce.Do(func() {
		type candidate struct {
			command string
			prefix  []string
		}
		candidates := make([]candidate, 0)
		if configured := strings.TrimSpace(os.Getenv("VWD_PYTHON_EXE")); configured != "" {
			candidates = append(candidates, candidate{command: configured})
		}
		if runtime.GOOS == "windows" {
			candidates = append(candidates,
				candidate{command: filepath.Join(m.importRootDir, "python-runtime", "python.exe")},
				candidate{command: "py.exe", prefix: []string{"-3"}},
				candidate{command: "python.exe"},
				candidate{command: "python3.exe"},
			)
		} else {
			candidates = append(candidates,
				candidate{command: filepath.Join(m.importRootDir, "python-runtime", "bin", "python3")},
				candidate{command: "python3"},
				candidate{command: "python"},
			)
		}
		for _, item := range candidates {
			if found := m.probePython(item.command, item.prefix); found != nil {
				m.python = *found
				return
			}
		}
		m.python = pythonRuntime{
			Available: false, Version: "", Error: "Python 3.6 or newer was not found",
		}
	})
	return m.python
}

func pathInside(rootPath, targetPath string) bool {
	relative, err := filepath.Rel(rootPath, targetPath)
	if err != nil {
		return false
	}
	return relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
			!filepath.IsAbs(relative))
}

func (m *importManager) resolveSource(fileName string) (string, error) {
	sourceName := strings.TrimSpace(fileName)
	if sourceName == "" || filepath.IsAbs(sourceName) ||
		strings.ContainsAny(sourceName, "\x00\r\n") {
		return "", fmt.Errorf("invalid import source file: %s", sourceName)
	}
	slashPath := strings.TrimPrefix(strings.ReplaceAll(sourceName, `\`, "/"), "./")
	if strings.HasPrefix(strings.ToLower(slashPath), "import/") {
		slashPath = slashPath[len("import/"):]
	}
	resolved, err := filepath.Abs(filepath.Join(m.importRootDir, filepath.FromSlash(slashPath)))
	if err != nil || !pathInside(m.importRootDir, resolved) {
		return "", fmt.Errorf("import source must stay inside the import folder: %s", sourceName)
	}
	info, err := os.Stat(resolved)
	if err != nil || info.IsDir() {
		return "", fmt.Errorf("import source file not found: %s", sourceName)
	}
	realRoot := canonicalExistingPath(m.importRootDir)
	realSource := canonicalExistingPath(resolved)
	if !pathInside(realRoot, realSource) {
		return "", fmt.Errorf("import source must stay inside the import folder: %s", sourceName)
	}
	return realSource, nil
}

func mapSlice(value any) ([]map[string]any, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		mapping, ok := item.(map[string]any)
		if !ok {
			return nil, false
		}
		result = append(result, mapping)
	}
	return result, true
}

func (m *importManager) normalizeScheme(raw map[string]any, schemeID string) (importScheme, error) {
	var rawMappings []map[string]any
	var ok bool
	for _, key := range []string{"mappings", "imports", "entries"} {
		if rawMappings, ok = mapSlice(raw[key]); ok {
			break
		}
	}
	if !ok || len(rawMappings) == 0 {
		return importScheme{}, errors.New("import scheme must contain at least one mapping")
	}
	parserPattern := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	seenSignals := make(map[string]bool)
	mappings := make([]importMapping, 0, len(rawMappings))
	for index, rawMapping := range rawMappings {
		signal := strings.TrimSpace(stringValue(rawMapping["signal"]))
		parser := strings.TrimSpace(stringValue(rawMapping["parser"]))
		if parser == "" {
			parser = strings.TrimSpace(stringValue(rawMapping["function"]))
		}
		fileName := strings.TrimSpace(stringValue(rawMapping["file"]))
		if signal == "" {
			return importScheme{}, fmt.Errorf("mapping %d is missing signal", index+1)
		}
		if seenSignals[signal] {
			return importScheme{}, fmt.Errorf("signal is mapped more than once: %s", signal)
		}
		seenSignals[signal] = true
		if !parserPattern.MatchString(parser) {
			return importScheme{}, fmt.Errorf("mapping %d has an invalid parser function", index+1)
		}
		options := make(map[string]any)
		if rawOptions := rawMapping["options"]; rawOptions != nil {
			var optionsOK bool
			options, optionsOK = rawOptions.(map[string]any)
			if !optionsOK {
				return importScheme{}, fmt.Errorf("mapping %d options must be an object", index+1)
			}
		}
		sourcePath, err := m.resolveSource(fileName)
		if err != nil {
			return importScheme{}, err
		}
		displayPath, _ := filepath.Rel(m.rootDir, sourcePath)
		mappings = append(mappings, importMapping{
			File: fileName, Signal: signal, Parser: parser, Options: options,
			SourcePath: sourcePath, DisplayPath: filepath.ToSlash(displayPath),
		})
	}
	version := intValue(raw["version"], 1)
	name := strings.TrimSpace(stringValue(raw["name"]))
	if name == "" {
		name = strings.TrimSuffix(schemeID, filepath.Ext(schemeID))
	}
	return importScheme{
		ID: schemeID, Version: version, Name: name,
		Description: strings.TrimSpace(stringValue(raw["description"])), Mappings: mappings,
	}, nil
}

func (m *importManager) schemePath(schemeID string) (string, error) {
	requested := strings.TrimSpace(schemeID)
	if requested == "" || filepath.Base(requested) != requested ||
		!strings.EqualFold(filepath.Ext(requested), ".json") || containsControl(requested) {
		return "", errors.New("invalid import scheme id")
	}
	schemePath := filepath.Join(m.schemeDir, requested)
	info, err := os.Stat(schemePath)
	if err != nil || info.IsDir() {
		return "", fmt.Errorf("import scheme not found: %s", requested)
	}
	realRoot := canonicalExistingPath(m.schemeDir)
	realPath := canonicalExistingPath(schemePath)
	if !pathInside(realRoot, realPath) {
		return "", fmt.Errorf("import scheme must stay inside import/Scheme: %s", requested)
	}
	return realPath, nil
}

func (m *importManager) loadScheme(schemeID string) (importScheme, error) {
	schemePath, err := m.schemePath(schemeID)
	if err != nil {
		return importScheme{}, err
	}
	data, err := os.ReadFile(schemePath)
	if err != nil {
		return importScheme{}, err
	}
	var raw map[string]any
	if err = json.Unmarshal(data, &raw); err != nil {
		return importScheme{}, err
	}
	return m.normalizeScheme(raw, filepath.Base(schemePath))
}

func publicScheme(scheme importScheme) map[string]any {
	mappings := make([]map[string]any, 0, len(scheme.Mappings))
	for index, mapping := range scheme.Mappings {
		mappings = append(mappings, map[string]any{
			"mappingIndex": index, "file": mapping.DisplayPath, "signal": mapping.Signal,
			"parser": mapping.Parser, "options": cloneJSONValue(mapping.Options, map[string]any{}),
		})
	}
	return map[string]any{
		"id": scheme.ID, "version": scheme.Version, "name": scheme.Name,
		"description": scheme.Description, "mappings": mappings,
	}
}

func (m *importManager) listSchemes() importCatalog {
	catalog := importCatalog{Schemes: []map[string]any{}, Invalid: []map[string]any{}}
	entries, err := os.ReadDir(m.schemeDir)
	if err != nil {
		return catalog
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		scheme, loadErr := m.loadScheme(entry.Name())
		if loadErr != nil {
			catalog.Invalid = append(catalog.Invalid, map[string]any{
				"id": entry.Name(), "error": loadErr.Error(),
			})
			continue
		}
		catalog.Schemes = append(catalog.Schemes, publicScheme(scheme))
	}
	return catalog
}

func countDelimitedColumns(line string, delimiter rune) int {
	count := 1
	quoted := false
	characters := []rune(line)
	for index := 0; index < len(characters); index++ {
		character := characters[index]
		if character == '"' {
			if quoted && index+1 < len(characters) && characters[index+1] == '"' {
				index++
			} else {
				quoted = !quoted
			}
		} else if !quoted && character == delimiter {
			count++
		}
	}
	return count
}

func splitSampleColumns(line, delimiter string) []string {
	text := strings.TrimSpace(line)
	switch delimiter {
	case "tab":
		parts := strings.Split(text, "\t")
		for index := range parts {
			parts[index] = strings.TrimSpace(parts[index])
		}
		return parts
	case "comma":
		reader := csv.NewReader(strings.NewReader(text))
		reader.FieldsPerRecord = -1
		parts, err := reader.Read()
		if err != nil {
			return []string{text}
		}
		for index := range parts {
			parts[index] = strings.TrimSpace(parts[index])
		}
		return parts
	case "whitespace":
		return strings.Fields(text)
	default:
		return []string{text}
	}
}

func analyzeImportSample(fileName string, suppliedLines []string) map[string]any {
	firstLines := append([]string{}, suppliedLines...)
	if len(firstLines) > importSampleLineLimit {
		firstLines = firstLines[:importSampleLineLimit]
	}
	meaningful := make([]string, 0, len(firstLines))
	for _, line := range firstLines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "//") {
			meaningful = append(meaningful, trimmed)
		}
	}
	if len(meaningful) == 0 {
		return map[string]any{
			"firstLines": firstLines, "meaningfulLineCount": 0, "delimiter": "unknown",
			"delimiterLabel": "无法判断", "columnCount": 0, "explicitIndex": false,
			"headerLikely": false, "recommendedParser": "parse_index_data",
			"reason": "前 5 行没有可分析的数据，建议先尝试通用序号/数据解析函数",
		}
	}
	delimiter := "single"
	tabCount := 0
	commaCount := 0
	for _, line := range meaningful {
		if countDelimitedColumns(line, '\t') > 1 {
			tabCount++
		}
		if countDelimitedColumns(line, ',') > 1 {
			commaCount++
		}
	}
	extension := strings.ToLower(filepath.Ext(fileName))
	if tabCount > 0 && tabCount >= commaCount {
		delimiter = "tab"
	} else if commaCount > 0 {
		delimiter = "comma"
	} else {
		for _, line := range meaningful {
			if len(strings.Fields(line)) > 1 {
				delimiter = "whitespace"
				break
			}
		}
		if delimiter == "single" && extension == ".csv" {
			delimiter = "comma"
		} else if delimiter == "single" && extension == ".tsv" {
			delimiter = "tab"
		}
	}
	rows := make([][]string, len(meaningful))
	columnCount := 0
	for index, line := range meaningful {
		rows[index] = splitSampleColumns(line, delimiter)
		if len(rows[index]) > columnCount {
			columnCount = len(rows[index])
		}
	}
	indexPattern := regexp.MustCompile(`^\+?\d+$`)
	headerLikely := len(rows) > 1 && len(rows[0]) > 1 && !indexPattern.MatchString(strings.TrimSpace(rows[0][0]))
	if headerLikely {
		for _, row := range rows[1:] {
			if len(row) < 2 || !indexPattern.MatchString(strings.TrimSpace(row[0])) {
				headerLikely = false
				break
			}
		}
	}
	dataRows := rows
	if headerLikely {
		dataRows = rows[1:]
	}
	explicitIndex := columnCount > 1 && len(dataRows) > 0
	previousIndex := -1
	for _, row := range dataRows {
		if len(row) < 2 || !indexPattern.MatchString(strings.TrimSpace(row[0])) {
			explicitIndex = false
			break
		}
		value, _ := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(row[0]), "+"))
		if value <= previousIndex {
			explicitIndex = false
			break
		}
		previousIndex = value
	}
	recommendedParser := "parse_index_data"
	if columnCount <= 1 {
		recommendedParser = "parse_single_column"
	} else if delimiter == "comma" {
		recommendedParser = "parse_csv_index_data"
	} else if delimiter == "tab" {
		recommendedParser = "parse_tsv_index_data"
	}
	labels := map[string]string{
		"single": "单列", "comma": "逗号分隔", "tab": "Tab 分隔", "whitespace": "空白分隔",
	}
	details := []string{labels[delimiter], fmt.Sprintf("%d 列", columnCount)}
	if explicitIndex {
		details = append(details, "第一列为递增序号")
	} else if columnCount > 1 {
		details = append(details, "第一列未完全匹配递增序号")
	}
	if headerLikely {
		details = append(details, "首行可能是表头")
	}
	return map[string]any{
		"firstLines": firstLines, "meaningfulLineCount": len(meaningful),
		"delimiter": delimiter, "delimiterLabel": labels[delimiter],
		"columnCount": columnCount, "explicitIndex": explicitIndex,
		"headerLikely": headerLikely, "recommendedParser": recommendedParser,
		"reason": "检测到" + strings.Join(details, "，") + "，建议使用 " + recommendedParser,
	}
}

func parserCompatibilityScore(parser, recommended string) int {
	if parser == recommended {
		return 100
	}
	if parser == "parse_index_data" {
		return 75
	}
	if recommended == "parse_index_data" &&
		(parser == "parse_csv_index_data" || parser == "parse_tsv_index_data") {
		return 45
	}
	return 10
}

func recommendScheme(schemes []map[string]any, analysis map[string]any) map[string]any {
	var recommended map[string]any
	recommendedParser := stringValue(analysis["recommendedParser"])
	delimiter := stringValue(analysis["delimiter"])
	headerLikely, _ := analysis["headerLikely"].(bool)
	for _, scheme := range schemes {
		mappings, _ := scheme["mappings"].([]map[string]any)
		if mappings == nil {
			if rawMappings, ok := scheme["mappings"].([]any); ok {
				for _, raw := range rawMappings {
					if mapping, ok := raw.(map[string]any); ok {
						mappings = append(mappings, mapping)
					}
				}
			}
		}
		for index, mapping := range mappings {
			parser := stringValue(mapping["parser"])
			score := parserCompatibilityScore(parser, recommendedParser)
			options, _ := mapping["options"].(map[string]any)
			if headerLikely && intValue(options["skipRows"], 0) > 0 {
				score += 8
			}
			if (delimiter == "comma" && stringValue(options["delimiter"]) == "comma") ||
				(delimiter == "tab" && stringValue(options["delimiter"]) == "tab") {
				score += 5
			}
			if recommended == nil || score > intValue(recommended["score"], 0) {
				mappingIndex := intValue(mapping["mappingIndex"], index)
				recommended = map[string]any{
					"schemeId": scheme["id"], "schemeName": scheme["name"],
					"mappingIndex": mappingIndex, "parser": parser, "score": score,
				}
			}
		}
	}
	return recommended
}

func normalizeSampleLines(payload map[string]any) []string {
	lines := make([]string, 0)
	if supplied, ok := payload["sampleLines"].([]string); ok {
		lines = append(lines, supplied...)
	} else if supplied, ok := payload["sampleLines"].([]any); ok {
		for _, line := range supplied {
			lines = append(lines, stringValue(line))
		}
	} else {
		lines = strings.Split(stringValue(payload["sampleText"]), "\n")
	}
	if len(lines) > importSampleLineLimit {
		lines = lines[:importSampleLineLimit]
	}
	for index, line := range lines {
		if len(line) > 4096 {
			lines[index] = line[:4096]
		}
	}
	return lines
}

func (m *importManager) analyzeRequest(payload map[string]any) map[string]any {
	catalog := m.listSchemes()
	analysis := analyzeImportSample(stringValue(payload["fileName"]), normalizeSampleLines(payload))
	return map[string]any{
		"analysis": analysis, "recommended": recommendScheme(catalog.Schemes, analysis),
		"schemes": catalog.Schemes, "invalid": catalog.Invalid,
	}
}

func (m *importManager) runParser(mapping importMapping, python pythonRuntime) (map[string]any, error) {
	if info, err := os.Stat(m.fileProcPath); err != nil || info.IsDir() {
		return nil, errors.New("import/inc/fileProc.py was not found")
	}
	optionsJSON, err := json.Marshal(mapping.Options)
	if err != nil {
		return nil, err
	}
	args := append(append([]string{}, python.PrefixArgs...),
		m.fileProcPath, "--parser", mapping.Parser, "--file", mapping.SourcePath,
		"--options-json", string(optionsJSON))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, python.Command, args...)
	command.Dir = m.rootDir
	var stdout, stderr bytes.Buffer
	limit := &outputLimit{maximum: importMaxOutputBytes}
	command.Stdout = &limitedOutputBuffer{buffer: &stdout, limit: limit}
	command.Stderr = &limitedOutputBuffer{buffer: &stderr, limit: limit}
	err = command.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, errors.New("Python parser timed out after 60 seconds")
	}
	if limit.exceeded {
		return nil, fmt.Errorf("import output is larger than %d bytes", importMaxOutputBytes)
	}
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(stdout.String())
		}
		if detail == "" {
			detail = err.Error()
		}
		return nil, errors.New(detail)
	}
	var result map[string]any
	if err = json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return nil, fmt.Errorf("Python parser returned invalid JSON: %w", err)
	}
	wave, waveOK := result["wave"].(string)
	data, dataOK := result["data"].([]any)
	if !waveOK || !dataOK {
		return nil, errors.New("Python parser result must contain wave and data")
	}
	if len([]rune(wave)) > importMaxWaveColumns {
		return nil, fmt.Errorf("imported waveform exceeds %d columns", importMaxWaveColumns)
	}
	normalizedData := make([]string, len(data))
	for index, value := range data {
		normalizedData[index] = stringValue(value)
	}
	result["data"] = normalizedData
	return result, nil
}

func importUpdate(mapping importMapping, result map[string]any, signalName string) map[string]any {
	samples := result["samples"]
	if samples == nil {
		samples = []any{}
	}
	return map[string]any{
		"signal": signalName, "wave": result["wave"], "data": result["data"],
		"sourceFile": mapping.DisplayPath, "parser": mapping.Parser,
		"pointCount":    intValue(result["pointCount"], 0),
		"firstIndex":    intValue(result["firstIndex"], 0),
		"lastIndex":     intValue(result["lastIndex"], 0),
		"explicitIndex": result["explicitIndex"], "sampleKind": stringValue(result["sampleKind"]),
		"samples": samples,
	}
}

func (m *importManager) runScheme(schemeID string) (map[string]any, error) {
	python := m.pythonRuntime()
	if !python.Available {
		return nil, errors.New(python.Error)
	}
	scheme, err := m.loadScheme(schemeID)
	if err != nil {
		return nil, err
	}
	updates := make([]map[string]any, 0, len(scheme.Mappings))
	for _, mapping := range scheme.Mappings {
		result, runErr := m.runParser(mapping, python)
		if runErr != nil {
			return nil, runErr
		}
		updates = append(updates, importUpdate(mapping, result, mapping.Signal))
	}
	return map[string]any{
		"scheme": publicScheme(scheme), "pythonVersion": python.Version, "updates": updates,
	}, nil
}

func resolvePastedImportPath(rawPath, baseDir string) (string, os.FileInfo, error) {
	value := strings.TrimSpace(rawPath)
	if len(value) >= 2 {
		first, last := value[0], value[len(value)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			value = strings.TrimSpace(value[1 : len(value)-1])
		}
	}
	if value == "" {
		return "", nil, errors.New("waveform data file path is required")
	}
	if strings.HasPrefix(strings.ToLower(value), "file:") {
		parsed, err := url.Parse(value)
		if err != nil || !strings.EqualFold(parsed.Scheme, "file") {
			return "", nil, errors.New("invalid waveform data file URL")
		}
		decodedPath, decodeErr := url.PathUnescape(parsed.EscapedPath())
		if decodeErr != nil {
			return "", nil, errors.New("invalid waveform data file URL")
		}
		if parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost") {
			if runtime.GOOS != "windows" {
				return "", nil, errors.New("remote file URLs are not supported")
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
			return "", nil, fmt.Errorf("could not resolve home directory: %w", err)
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
		return "", nil, fmt.Errorf("invalid waveform data file path: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", nil, fmt.Errorf("waveform data file was not found: %s", resolved)
	}
	if !info.Mode().IsRegular() {
		return "", nil, errors.New("waveform data path must point to a regular file")
	}
	if info.Size() == 0 {
		return "", nil, errors.New("waveform data file is empty")
	}
	if info.Size() > importMaxUploadBytes {
		return "", nil, errors.New("waveform data file exceeds 128 MB")
	}
	return filepath.Clean(resolved), info, nil
}

func importSampleLinesFromBytes(data []byte) []string {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) > importSampleLineLimit {
		lines = lines[:importSampleLineLimit]
	}
	return lines
}

func readImportSampleLines(sourcePath string) ([]string, error) {
	file, err := os.Open(sourcePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64*1024))
	if err != nil {
		return nil, err
	}
	return importSampleLinesFromBytes(data), nil
}

func safeUploadName(fileName string) string {
	name := filepath.Base(fileName)
	invalid := regexp.MustCompile(`[\x00-\x1f<>:"/\\|?*]`)
	name = invalid.ReplaceAllString(name, "_")
	runes := []rune(name)
	if len(runes) > 180 {
		name = string(runes[:180])
	}
	if name == "" || name == "." || name == ".." {
		return "waveform-data.txt"
	}
	return name
}

func normalizeSignalName(value string) (string, error) {
	name := strings.TrimSpace(value)
	if name == "" {
		return "", errors.New("signal name is required")
	}
	if len([]rune(name)) > 256 || strings.IndexFunc(name, func(r rune) bool { return r < 0x20 }) >= 0 {
		return "", errors.New("signal name is invalid")
	}
	return name, nil
}

func (m *importManager) runSourceFile(
	schemeID string,
	mappingIndex int,
	signalName string,
	sourcePath string,
	displayName string,
) (map[string]any, error) {
	python := m.pythonRuntime()
	if !python.Available {
		return nil, errors.New(python.Error)
	}
	info, err := os.Stat(sourcePath)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("waveform data file is not available")
	}
	if info.Size() == 0 {
		return nil, errors.New("waveform data file is empty")
	}
	if info.Size() > importMaxUploadBytes {
		return nil, errors.New("waveform data file exceeds 128 MB")
	}
	scheme, err := m.loadScheme(schemeID)
	if err != nil {
		return nil, err
	}
	if mappingIndex < 0 || mappingIndex >= len(scheme.Mappings) {
		return nil, errors.New("invalid import scheme mapping")
	}
	signalName, err = normalizeSignalName(signalName)
	if err != nil {
		return nil, err
	}
	lines, err := readImportSampleLines(sourcePath)
	if err != nil {
		return nil, err
	}
	displayName = filepath.Base(strings.TrimSpace(displayName))
	if displayName == "" || displayName == "." {
		displayName = filepath.Base(sourcePath)
	}
	analysis := analyzeImportSample(displayName, lines)
	source := scheme.Mappings[mappingIndex]
	options := cloneJSONValue(source.Options, map[string]any{}).(map[string]any)
	headerLikely, _ := analysis["headerLikely"].(bool)
	if _, supplied := options["skipRows"]; headerLikely && !supplied {
		options["skipRows"] = 1
	}
	effective := source
	effective.SourcePath = sourcePath
	effective.DisplayPath = displayName
	effective.Options = options
	result, err := m.runParser(effective, python)
	if err != nil {
		return nil, err
	}
	update := importUpdate(effective, result, signalName)
	update["createIfMissing"] = true
	return map[string]any{
		"scheme": publicScheme(scheme), "mappingIndex": mappingIndex,
		"parser": source.Parser, "pythonVersion": python.Version, "analysis": analysis,
		"updates": []map[string]any{update},
	}, nil
}

func (m *importManager) runUploaded(
	schemeID string,
	mappingIndex int,
	signalName string,
	fileName string,
	data []byte,
) (map[string]any, error) {
	if len(data) == 0 {
		return nil, errors.New("uploaded waveform data file is empty")
	}
	if len(data) > importMaxUploadBytes {
		return nil, errors.New("uploaded waveform data file exceeds 128 MB")
	}
	uploadedName := safeUploadName(fileName)
	tempDirectory, err := os.MkdirTemp("", "visualwavedrom-import-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDirectory)
	tempPath := filepath.Join(tempDirectory, uploadedName)
	if err = os.WriteFile(tempPath, data, 0o600); err != nil {
		return nil, err
	}
	return m.runSourceFile(schemeID, mappingIndex, signalName, tempPath, uploadedName)
}

func (m *importManager) runLocalFile(
	schemeID string,
	mappingIndex int,
	signalName string,
	sourcePath string,
) (map[string]any, error) {
	return m.runSourceFile(
		schemeID,
		mappingIndex,
		signalName,
		sourcePath,
		filepath.Base(sourcePath),
	)
}
