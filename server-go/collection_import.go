package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	collectionPresetMaxBytes     = 1024 * 1024
	collectionMaxVariables       = 64
	collectionMaxPaths           = 128
	collectionMaxVisitedFiles    = 100000
	collectionMaxMatchesPerPath  = 100
	collectionMaxTotalColumns    = 20 * 1000 * 1000
	collectionSearchCacheLimit   = 32
	collectionParserWorkers      = 4
	collectionSearchCacheTTL     = 10 * time.Minute
	collectionPresetInnerType    = "VisualWaveDrom.BatchWaveImportPreset"
	collectionPresetScanLimit    = 100000
	collectionPresetResultLimit  = 2000
	collectionPreviewRowLimit    = 5
	collectionPreviewColumnLimit = 32
	collectionPreviewCellLimit   = 120
	collectionMaxFilterLength    = 512
	collectionSinglePreviewLines = 5
	collectionSinglePreviewMax   = 200
	collectionSinglePreviewRunes = 2000
	collectionSingleIndexStride  = 256
	collectionSingleIndexLimit   = 32
	collectionSingleIndexTTL     = 10 * time.Minute
	collectionImportProgressTTL  = 10 * time.Minute
	collectionImportProgressMax  = 32
)

var collectionVariableNamePattern = regexp.MustCompile(`^[\p{L}_][\p{L}\p{N}_.-]*$`)
var collectionPythonVariableNamePattern = regexp.MustCompile(`^[\p{L}_][\p{L}\p{N}_]*$`)
var collectionTemplateVariablePattern = regexp.MustCompile(
	`\$\{([\p{L}_][\p{L}\p{N}_.-]*)\}|\{\{([\p{L}_][\p{L}\p{N}_.-]*)\}\}|\{([\p{L}_][\p{L}\p{N}_.-]*)\}`,
)
var collectionUnresolvedVariablePattern = regexp.MustCompile(
	`\$\{[\p{L}_][\p{L}\p{N}_.-]*\}|\{\{[\p{L}_][\p{L}\p{N}_.-]*\}\}|\{[\p{L}_][\p{L}\p{N}_.-]*\}`,
)
var collectionImportProgressTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type collectionPresetPath struct {
	UsrGen  collectionRuleConfig     `json:"usrGen"`
	AutoGen collectionRuleConfig     `json:"autoGen"`
	Formula *collectionFormulaConfig `json:"-"`

	// Effective values keep the search/import code and legacy tests simple.
	Folder      string                   `json:"-"`
	GrepKeys    string                   `json:"-"`
	HasSeq      bool                     `json:"-"`
	Name        string                   `json:"-"`
	ImportMode  string                   `json:"-"`
	HeaderRow   int                      `json:"-"`
	IndexColumn string                   `json:"-"`
	Delimiter   string                   `json:"-"`
	Parser      string                   `json:"-"`
	Columns     []collectionColumnConfig `json:"-"`
	SchemaHash  string                   `json:"-"`
	Tbl         map[string]string        `json:"-"`
}

type collectionFormulaConfig struct {
	Cycle0  string `json:"cycle0,omitempty"`
	Cycle05 string `json:"cycle05,omitempty"`
}

type collectionColumnConfig struct {
	Source  string `json:"source"`
	Enabled bool   `json:"enabled"`
	Name    string `json:"name,omitempty"`
	Filter  string `json:"filter,omitempty"`
}

type collectionRuleConfig struct {
	Folder      string                   `json:"folder,omitempty"`
	GrepKeys    string                   `json:"grepKeys,omitempty"`
	Name        string                   `json:"name,omitempty"`
	ImportMode  string                   `json:"importMode,omitempty"`
	HeaderRow   int                      `json:"headerRow,omitempty"`
	IndexColumn string                   `json:"indexColumn,omitempty"`
	Delimiter   string                   `json:"delimiter,omitempty"`
	HasSeq      *bool                    `json:"hasSeq,omitempty"`
	Parser      string                   `json:"parser,omitempty"`
	Columns     []collectionColumnConfig `json:"columns,omitempty"`
	SchemaHash  string                   `json:"schemaHash,omitempty"`
	Tbl         map[string]string        `json:"tbl,omitempty"`
	Formula     *collectionFormulaConfig `json:"formula,omitempty"`
}

type collectionPreset struct {
	Vars  []string               `json:"vars"`
	Paths []collectionPresetPath `json:"paths"`
}

type collectionPresetFile struct {
	InnerType string                 `json:"InnerType"`
	Vars      []string               `json:"vars"`
	Paths     []collectionPresetPath `json:"paths"`
}

type collectionPresetDocument struct {
	Text        string
	Preset      collectionPreset
	Valid       bool
	PresetError string
	ErrorLine   int
	ErrorColumn int
}

type collectionPresetDiscoveryEntry struct {
	RelativePath string `json:"relativePath"`
	FileName     string `json:"fileName"`
	Size         int64  `json:"size"`
	ModifiedAt   string `json:"modifiedAt"`
}

type collectionPresetDiscoveryResult struct {
	Entries      []collectionPresetDiscoveryEntry `json:"entries"`
	ResultCount  int                              `json:"resultCount"`
	VisitedFiles int                              `json:"visitedFiles"`
	SkippedFiles int                              `json:"skippedFiles,omitempty"`
	Truncated    bool                             `json:"truncated,omitempty"`
	DurationMS   int64                            `json:"durationMs"`
}

type collectionFileMatch struct {
	Path         string `json:"path"`
	RelativePath string `json:"relativePath"`
	FileName     string `json:"fileName"`
	Size         int64  `json:"size"`
	ModifiedAt   string `json:"modifiedAt"`
}

type collectionSearchEntry struct {
	Index            int                      `json:"index"`
	Folder           string                   `json:"folder"`
	SearchPath       string                   `json:"searchPath"`
	GrepKeys         string                   `json:"grepKeys"`
	ResolvedPattern  string                   `json:"resolvedPattern"`
	HasSeq           bool                     `json:"hasSeq"`
	Name             string                   `json:"name"`
	ImportMode       string                   `json:"importMode"`
	Formula          *collectionFormulaConfig `json:"formula,omitempty"`
	HeaderRow        int                      `json:"headerRow,omitempty"`
	IndexColumn      string                   `json:"indexColumn,omitempty"`
	Delimiter        string                   `json:"delimiter,omitempty"`
	Parser           string                   `json:"parser,omitempty"`
	Columns          []collectionColumnConfig `json:"columns,omitempty"`
	SchemaHash       string                   `json:"schemaHash,omitempty"`
	OutputNames      []string                 `json:"outputNames,omitempty"`
	ComplexDetected  bool                     `json:"complexDetected,omitempty"`
	ComplexSources   []string                 `json:"complexSources,omitempty"`
	PreviewColumns   []string                 `json:"previewColumns,omitempty"`
	PreviewRows      [][]string               `json:"previewRows,omitempty"`
	PreviewTruncated bool                     `json:"previewTruncated,omitempty"`
	AutoGenChanged   bool                     `json:"autoGenChanged,omitempty"`
	Status           string                   `json:"status"`
	Message          string                   `json:"message,omitempty"`
	Matches          []collectionFileMatch    `json:"matches"`
}

func collectionTableComplexSources(
	lines []string,
	headerRow int,
	delimiter string,
	headers []string,
	configuredColumns []collectionColumnConfig,
	indexColumn string,
) ([]string, error) {
	headerIndexes := make(map[string]int, len(headers))
	for index, header := range headers {
		headerIndexes[header] = index
	}
	filters := make([]collectionPreviewFilter, 0)
	selected := make([]collectionColumnConfig, 0, len(configuredColumns))
	for _, column := range configuredColumns {
		columnIndex, found := headerIndexes[column.Source]
		if !found {
			continue
		}
		if strings.TrimSpace(column.Filter) != "" {
			groups, err := compileCollectionPreviewFilter(column.Filter, column.Source)
			if err != nil {
				return nil, err
			}
			filters = append(filters, collectionPreviewFilter{
				columnIndex: columnIndex,
				groups:      groups,
			})
		}
		if column.Enabled && column.Source != indexColumn {
			selected = append(selected, column)
		}
	}
	complexSources := make(map[string]bool)
	for index := headerRow; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		values := collectionSplitColumns(line, delimiter)
		matches := true
		for _, filter := range filters {
			value := ""
			if filter.columnIndex < len(values) {
				value = values[filter.columnIndex]
			}
			if !collectionPreviewFilterMatches(value, filter.groups) {
				matches = false
				break
			}
		}
		if !matches {
			continue
		}
		for _, column := range selected {
			columnIndex := headerIndexes[column.Source]
			if columnIndex < len(values) && looksComplexLiteral(values[columnIndex]) {
				complexSources[column.Source] = true
			}
		}
	}
	result := make([]string, 0, len(complexSources))
	for _, column := range selected {
		if complexSources[column.Source] {
			result = append(result, column.Source)
		}
	}
	return result, nil
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

type collectionSinglePreviewIndex struct {
	createdAt   time.Time
	sourcePath  string
	size        int64
	modifiedAt  string
	totalLines  int
	checkpoints []int64
}

type collectionSinglePreviewLine struct {
	Number    int    `json:"number"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

type collectionImportEntryResult struct {
	updates []map[string]any
	file    map[string]any
	err     error
}

type collectionImportProgress struct {
	ProgressToken   string `json:"progressToken"`
	Phase           string `json:"phase"`
	TotalFiles      int    `json:"totalFiles"`
	CompletedFiles  int    `json:"completedFiles"`
	SuccessfulFiles int    `json:"successfulFiles"`
	FailedFiles     int    `json:"failedFiles"`
	SignalCount     int    `json:"signalCount"`
	Done            bool   `json:"done"`
	Error           string `json:"error,omitempty"`
	DurationMS      int64  `json:"durationMs"`
	startedAt       time.Time
	updatedAt       time.Time
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

func collectionOptionalString(
	raw map[string]any,
	key string,
	fieldPath string,
) (string, error) {
	value, supplied := raw[key]
	if !supplied || value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s.%s must be a string", fieldPath, key)
	}
	return strings.TrimSpace(text), nil
}

func collectionOptionalInt(
	raw map[string]any,
	key string,
	fieldPath string,
) (int, error) {
	value, supplied := raw[key]
	if !supplied || value == nil {
		return 0, nil
	}
	var parsed int
	switch typed := value.(type) {
	case float64:
		parsed = int(typed)
		if float64(parsed) != typed {
			return 0, fmt.Errorf("%s.%s must be an integer", fieldPath, key)
		}
	case int:
		parsed = typed
	case json.Number:
		value64, err := typed.Int64()
		if err != nil {
			return 0, fmt.Errorf("%s.%s must be an integer", fieldPath, key)
		}
		parsed = int(value64)
	default:
		return 0, fmt.Errorf("%s.%s must be an integer", fieldPath, key)
	}
	if parsed < 0 {
		return 0, fmt.Errorf("%s.%s must not be negative", fieldPath, key)
	}
	return parsed, nil
}

func normalizeCollectionColumns(
	value any,
	renamesValue any,
	fieldPath string,
) ([]collectionColumnConfig, error) {
	if value == nil {
		return nil, nil
	}
	rawColumns, ok := anyList(value)
	if !ok {
		return nil, fmt.Errorf("%s.columns must be an array", fieldPath)
	}
	renames := map[string]string{}
	if renamesValue != nil {
		rawRenames, renameOK := renamesValue.(map[string]any)
		if !renameOK {
			return nil, fmt.Errorf("%s.renames must be an object", fieldPath)
		}
		for source, rawName := range rawRenames {
			name, nameOK := rawName.(string)
			if !nameOK {
				return nil, fmt.Errorf("%s.renames.%s must be a string", fieldPath, source)
			}
			renames[source] = strings.TrimSpace(name)
		}
	}
	columns := make([]collectionColumnConfig, 0, len(rawColumns))
	seenSources := make(map[string]bool)
	for index, rawColumn := range rawColumns {
		column := collectionColumnConfig{Enabled: true}
		switch typed := rawColumn.(type) {
		case string:
			column.Source = strings.TrimSpace(typed)
			column.Name = renames[column.Source]
		case map[string]any:
			source, sourceOK := typed["source"].(string)
			if !sourceOK {
				return nil, fmt.Errorf("%s.columns[%d].source must be a string", fieldPath, index)
			}
			column.Source = strings.TrimSpace(source)
			if enabled, supplied := typed["enabled"]; supplied {
				value, enabledOK := enabled.(bool)
				if !enabledOK {
					return nil, fmt.Errorf("%s.columns[%d].enabled must be true or false", fieldPath, index)
				}
				column.Enabled = value
			}
			if name, supplied := typed["name"]; supplied {
				value, nameOK := name.(string)
				if !nameOK {
					return nil, fmt.Errorf("%s.columns[%d].name must be a string", fieldPath, index)
				}
				column.Name = strings.TrimSpace(value)
			}
			if filter, supplied := typed["filter"]; supplied {
				value, filterOK := filter.(string)
				if !filterOK {
					return nil, fmt.Errorf("%s.columns[%d].filter must be a string", fieldPath, index)
				}
				column.Filter = strings.TrimSpace(value)
				if utf8.RuneCountInString(column.Filter) > collectionMaxFilterLength {
					return nil, fmt.Errorf(
						"%s.columns[%d].filter cannot exceed %d characters",
						fieldPath, index, collectionMaxFilterLength,
					)
				}
			}
		default:
			return nil, fmt.Errorf("%s.columns[%d] must be a string or object", fieldPath, index)
		}
		if column.Source == "" {
			return nil, fmt.Errorf("%s.columns[%d].source must not be empty", fieldPath, index)
		}
		if seenSources[column.Source] {
			return nil, fmt.Errorf("%s.columns contains duplicate source %s", fieldPath, column.Source)
		}
		if column.Name == "" {
			column.Name = column.Source
		}
		if _, err := normalizeSignalName(column.Name); err != nil {
			return nil, fmt.Errorf("%s.columns[%d].name: %w", fieldPath, index, err)
		}
		seenSources[column.Source] = true
		columns = append(columns, column)
	}
	return columns, nil
}

func normalizeCollectionRuleConfig(
	raw map[string]any,
	fieldPath string,
	autoGenerated bool,
) (collectionRuleConfig, error) {
	config := collectionRuleConfig{}
	var err error
	if config.Folder, err = collectionOptionalString(raw, "folder", fieldPath); err != nil {
		return config, err
	}
	if config.GrepKeys, err = collectionOptionalString(raw, "grepKeys", fieldPath); err != nil {
		return config, err
	}
	if config.Name, err = collectionOptionalString(raw, "name", fieldPath); err != nil {
		return config, err
	}
	if config.ImportMode, err = collectionOptionalString(raw, "importMode", fieldPath); err != nil {
		return config, err
	}
	config.ImportMode = strings.ToLower(config.ImportMode)
	if config.ImportMode != "" && config.ImportMode != "single" && config.ImportMode != "table" {
		return config, fmt.Errorf("%s.importMode must be single or table", fieldPath)
	}
	if config.HeaderRow, err = collectionOptionalInt(raw, "headerRow", fieldPath); err != nil {
		return config, err
	}
	if config.IndexColumn, err = collectionOptionalString(raw, "indexColumn", fieldPath); err != nil {
		return config, err
	}
	if utf8.RuneCountInString(config.IndexColumn) > 256 {
		return config, fmt.Errorf("%s.indexColumn cannot exceed 256 characters", fieldPath)
	}
	if config.Delimiter, err = collectionOptionalString(raw, "delimiter", fieldPath); err != nil {
		return config, err
	}
	if len(config.Delimiter) > 1 {
		normalizedDelimiter := strings.ToLower(config.Delimiter)
		allowed := map[string]bool{
			"auto": true, "comma": true, "csv": true, "tab": true,
			"tsv": true, "whitespace": true, "space": true, "single": true,
			"unknown": true,
		}
		if !allowed[normalizedDelimiter] {
			if autoGenerated {
				config.Delimiter = ""
			} else {
				return config, fmt.Errorf(
					"%s.delimiter %q is not supported", fieldPath, config.Delimiter)
			}
		} else {
			config.Delimiter = normalizedDelimiter
		}
	}
	if config.Parser, err = collectionOptionalString(raw, "parser", fieldPath); err != nil {
		return config, err
	}
	if config.SchemaHash, err = collectionOptionalString(raw, "schemaHash", fieldPath); err != nil {
		return config, err
	}
	if rawHasSeq, supplied := raw["hasSeq"]; supplied {
		hasSeq, ok := rawHasSeq.(bool)
		if !ok {
			return config, fmt.Errorf("%s.hasSeq must be true or false", fieldPath)
		}
		config.HasSeq = &hasSeq
	}
	if rawTable, supplied := raw["tbl"]; supplied {
		table, ok := rawTable.(map[string]any)
		if !ok {
			return config, fmt.Errorf("%s.tbl must be an object", fieldPath)
		}
		config.Tbl = make(map[string]string, len(table))
		for rawValue, rawKeyword := range table {
			keyword, keywordOK := rawKeyword.(string)
			if !keywordOK {
				return config, fmt.Errorf("%s.tbl[%q] must be a string", fieldPath, rawValue)
			}
			config.Tbl[rawValue] = keyword
		}
	}
	config.Columns, err = normalizeCollectionColumns(raw["columns"], raw["renames"], fieldPath)
	if err != nil {
		return config, err
	}
	return config, nil
}

func effectiveCollectionPresetPath(
	usrGen collectionRuleConfig,
	autoGen collectionRuleConfig,
) collectionPresetPath {
	effective := collectionPresetPath{UsrGen: usrGen, AutoGen: autoGen}
	effective.Formula = usrGen.Formula
	effective.Folder = usrGen.Folder
	if effective.Folder == "" {
		effective.Folder = autoGen.Folder
	}
	if effective.Folder == "" {
		effective.Folder = "."
	}
	effective.GrepKeys = usrGen.GrepKeys
	if effective.GrepKeys == "" {
		effective.GrepKeys = autoGen.GrepKeys
	}
	effective.Name = usrGen.Name
	if effective.Name == "" {
		effective.Name = autoGen.Name
	}
	effective.ImportMode = usrGen.ImportMode
	if effective.ImportMode == "" {
		effective.ImportMode = autoGen.ImportMode
	}
	effective.HeaderRow = usrGen.HeaderRow
	if effective.HeaderRow == 0 {
		effective.HeaderRow = autoGen.HeaderRow
	}
	effective.IndexColumn = usrGen.IndexColumn
	if effective.IndexColumn == "" {
		effective.IndexColumn = autoGen.IndexColumn
	}
	effective.Delimiter = usrGen.Delimiter
	if effective.Delimiter == "" {
		effective.Delimiter = autoGen.Delimiter
	}
	effective.Parser = usrGen.Parser
	if effective.Parser == "" {
		effective.Parser = autoGen.Parser
	}
	effective.SchemaHash = usrGen.SchemaHash
	if effective.SchemaHash == "" {
		effective.SchemaHash = autoGen.SchemaHash
	}
	if usrGen.HasSeq != nil {
		effective.HasSeq = *usrGen.HasSeq
	} else if autoGen.HasSeq != nil {
		effective.HasSeq = *autoGen.HasSeq
	}
	if len(usrGen.Columns) > 0 {
		effective.Columns = append([]collectionColumnConfig{}, usrGen.Columns...)
	} else {
		effective.Columns = append([]collectionColumnConfig{}, autoGen.Columns...)
	}
	if len(usrGen.Tbl) > 0 {
		effective.Tbl = maps.Clone(usrGen.Tbl)
	} else if len(autoGen.Tbl) > 0 {
		effective.Tbl = maps.Clone(autoGen.Tbl)
	}
	return effective
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

func normalizeCollectionFormula(value any, fieldPath string) (*collectionFormulaConfig, error) {
	raw := map[string]any{}
	if text, ok := value.(string); ok {
		raw["cycle0"] = text
	} else {
		var valid bool
		raw, valid = value.(map[string]any)
		if !valid {
			return nil, fmt.Errorf("%s must be an object", fieldPath)
		}
	}
	readExpression := func(keys ...string) (string, error) {
		for _, key := range keys {
			value, supplied := raw[key]
			if !supplied || value == nil {
				continue
			}
			text, ok := value.(string)
			if !ok {
				return "", fmt.Errorf("%s.%s must be a string", fieldPath, key)
			}
			if len(text) > 65536 {
				return "", fmt.Errorf("%s.%s is too long", fieldPath, key)
			}
			return text, nil
		}
		return "", nil
	}
	cycle0, err := readExpression("cycle0", "0 cycle", "at0")
	if err != nil {
		return nil, err
	}
	cycle05, err := readExpression("cycle05", "cycle0_5", "0.5 cycle", "at05")
	if err != nil {
		return nil, err
	}
	return &collectionFormulaConfig{Cycle0: cycle0, Cycle05: cycle05}, nil
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
	declaredVariables := make([]string, 0, len(rawVars))
	seenDeclaredVariables := make(map[string]bool)
	for index, rawVariable := range rawVars {
		name, ok := rawVariable.(string)
		name = strings.TrimSpace(name)
		if !ok || name == "" || !collectionVariableNamePattern.MatchString(name) {
			return collectionPreset{}, fmt.Errorf("vars[%d] is not a valid variable name", index)
		}
		if seenDeclaredVariables[name] {
			return collectionPreset{}, fmt.Errorf("vars contains duplicate variable %s", name)
		}
		seenDeclaredVariables[name] = true
		declaredVariables = append(declaredVariables, name)
	}
	referencedVariables := []string{}
	seenReferencedVariables := make(map[string]bool)
	collectReferencedVariables := func(template string) error {
		for _, variableName := range extractCollectionTemplateVariables(template) {
			if seenReferencedVariables[variableName] {
				continue
			}
			if len(referencedVariables) >= collectionMaxVariables {
				return fmt.Errorf(
					"preset templates cannot contain more than %d variables",
					collectionMaxVariables,
				)
			}
			seenReferencedVariables[variableName] = true
			referencedVariables = append(referencedVariables, variableName)
		}
		return nil
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
		usrRaw := map[string]any{}
		autoRaw := map[string]any{}
		_, nestedUsr := entry["usrGen"]
		_, nestedAuto := entry["autoGen"]
		if nestedUsr || nestedAuto {
			if rawUsr, supplied := entry["usrGen"]; supplied {
				var valid bool
				usrRaw, valid = rawUsr.(map[string]any)
				if !valid {
					return collectionPreset{}, fmt.Errorf("paths[%d].usrGen must be an object", index)
				}
			}
			if rawAuto, supplied := entry["autoGen"]; supplied {
				var valid bool
				autoRaw, valid = rawAuto.(map[string]any)
				if !valid {
					return collectionPreset{}, fmt.Errorf("paths[%d].autoGen must be an object", index)
				}
			}
			if value, supplied := entry["tbl"]; supplied {
				if _, nested := usrRaw["tbl"]; !nested {
					usrRaw["tbl"] = value
				}
			}
		} else {
			// Legacy presets are migrated without changing their single-signal behavior.
			for _, key := range []string{"folder", "grepKeys", "name", "tbl"} {
				if value, supplied := entry[key]; supplied {
					usrRaw[key] = value
				}
			}
			autoRaw["importMode"] = "single"
			if value, supplied := entry["hasSeq"]; supplied {
				autoRaw["hasSeq"] = value
			}
		}
		var formula *collectionFormulaConfig
		rawFormula, formulaSupplied := usrRaw["formula"]
		formulaPath := fmt.Sprintf("paths[%d].usrGen.formula", index)
		if !formulaSupplied {
			rawFormula, formulaSupplied = entry["formula"]
			formulaPath = fmt.Sprintf("paths[%d].formula", index)
		}
		if formulaSupplied {
			var formulaErr error
			formula, formulaErr = normalizeCollectionFormula(rawFormula, formulaPath)
			if formulaErr != nil {
				return collectionPreset{}, formulaErr
			}
		}
		usrGen, configErr := normalizeCollectionRuleConfig(
			usrRaw, fmt.Sprintf("paths[%d].usrGen", index), false)
		if configErr != nil {
			return collectionPreset{}, configErr
		}
		autoGen, configErr := normalizeCollectionRuleConfig(
			autoRaw, fmt.Sprintf("paths[%d].autoGen", index), true)
		if configErr != nil {
			return collectionPreset{}, configErr
		}
		if formula != nil {
			usrGen.Formula = formula
			if usrGen.Name == "" {
				return collectionPreset{}, fmt.Errorf(
					"paths[%d].usrGen.name must be a non-empty signal name", index)
			}
			if len(usrGen.Name) > 256 {
				return collectionPreset{}, fmt.Errorf("paths[%d].usrGen.name is too long", index)
			}
			if _, nameErr := normalizeSignalName(usrGen.Name); nameErr != nil {
				return collectionPreset{}, fmt.Errorf("paths[%d].usrGen.name: %w", index, nameErr)
			}
			effective := effectiveCollectionPresetPath(usrGen, autoGen)
			effective.ImportMode = "formula"
			preset.Paths = append(preset.Paths, effective)
			continue
		}
		if usrGen.Folder == "" {
			usrGen.Folder = "."
		}
		if usrGen.GrepKeys == "" {
			return collectionPreset{}, fmt.Errorf(
				"paths[%d].usrGen.grepKeys must be a non-empty regex string", index)
		}
		if len(usrGen.Folder) > 2048 || len(usrGen.GrepKeys) > 4096 ||
			len(usrGen.Name) > 256 {
			return collectionPreset{}, fmt.Errorf("paths[%d] contains an overlong value", index)
		}
		if usrGen.Name != "" {
			if _, nameErr := normalizeSignalName(usrGen.Name); nameErr != nil {
				return collectionPreset{}, fmt.Errorf("paths[%d].usrGen.name: %w", index, nameErr)
			}
		}
		for _, template := range []string{usrGen.Folder, usrGen.GrepKeys, usrGen.Name} {
			if collectErr := collectReferencedVariables(template); collectErr != nil {
				return collectionPreset{}, collectErr
			}
		}
		preset.Paths = append(
			preset.Paths,
			effectiveCollectionPresetPath(usrGen, autoGen),
		)
	}
	addedVariables := make(map[string]bool)
	for _, name := range declaredVariables {
		if !seenReferencedVariables[name] || addedVariables[name] {
			continue
		}
		addedVariables[name] = true
		preset.Vars = append(preset.Vars, name)
	}
	for _, name := range referencedVariables {
		if addedVariables[name] {
			continue
		}
		addedVariables[name] = true
		preset.Vars = append(preset.Vars, name)
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

func collectionJSONErrorLocation(data []byte, err error) (int, int) {
	var syntaxError *json.SyntaxError
	if !errors.As(err, &syntaxError) {
		return 0, 0
	}
	offset := int(syntaxError.Offset) - 1
	if offset < 0 {
		offset = 0
	}
	if offset > len(data) {
		offset = len(data)
	}
	line, column := 1, 1
	for index := 0; index < offset; index++ {
		if data[index] == '\n' {
			line, column = line+1, 1
		} else {
			column++
		}
	}
	return line, column
}

func loadCollectionPresetDocument(
	rawPath string,
	baseDir string,
) (collectionPresetDocument, string, error) {
	presetPath, err := resolveCollectionPresetFile(rawPath, baseDir)
	if err != nil {
		return collectionPresetDocument{}, "", err
	}
	info, err := os.Stat(presetPath)
	if err != nil {
		return collectionPresetDocument{}, "", err
	}
	if info.Size() > collectionPresetMaxBytes {
		return collectionPresetDocument{}, "", errors.New("preset JSON cannot exceed 1 MB")
	}
	data, err := os.ReadFile(presetPath)
	if err != nil {
		return collectionPresetDocument{}, "", err
	}
	text := strings.TrimPrefix(string(data), "\uFEFF")
	document := collectionPresetDocument{Text: text}
	jsonData := []byte(text)
	var raw map[string]any
	if err = json.Unmarshal(jsonData, &raw); err != nil {
		document.PresetError = fmt.Sprintf("preset JSON is invalid: %v", err)
		document.ErrorLine, document.ErrorColumn = collectionJSONErrorLocation(jsonData, err)
		return document, presetPath, nil
	}
	preset, err := normalizeCollectionPreset(raw)
	if err != nil {
		document.PresetError = err.Error()
		return document, presetPath, nil
	}
	document.Preset = preset
	document.Valid = true
	return document, presetPath, nil
}

func loadCollectionPreset(rawPath, baseDir string) (collectionPreset, string, error) {
	document, presetPath, err := loadCollectionPresetDocument(rawPath, baseDir)
	if err != nil {
		return collectionPreset{}, "", err
	}
	if !document.Valid {
		return collectionPreset{}, "", errors.New(document.PresetError)
	}
	return document.Preset, presetPath, nil
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
	stored := collectionPresetFile{
		InnerType: collectionPresetInnerType,
		Vars:      preset.Vars,
		Paths:     preset.Paths,
	}
	if err = writeJSONAtomically(resolved, stored); err != nil {
		return "", err
	}
	return resolved, nil
}

func readCollectionPresetInnerType(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > collectionPresetMaxBytes {
		return "", errors.New("preset file has an unsupported size or type")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var marker struct {
		InnerType string `json:"InnerType"`
	}
	if err = json.Unmarshal(data, &marker); err != nil {
		return "", err
	}
	return strings.TrimSpace(marker.InnerType), nil
}

func discoverCollectionPresets(
	rawRootPath string,
	baseDir string,
) (collectionPresetDiscoveryResult, error) {
	startedAt := time.Now()
	result := collectionPresetDiscoveryResult{
		Entries: []collectionPresetDiscoveryEntry{},
	}
	rootPath, err := resolveCollectionRoot(rawRootPath, baseDir)
	if err != nil {
		return result, err
	}
	scanLimitReached := errors.New("collection preset scan limit reached")
	err = filepath.WalkDir(rootPath, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if samePath(path, rootPath) {
				return walkErr
			}
			result.SkippedFiles++
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		result.VisitedFiles++
		if result.VisitedFiles > collectionPresetScanLimit {
			result.Truncated = true
			return scanLimitReached
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			return nil
		}
		innerType, markerErr := readCollectionPresetInnerType(path)
		if markerErr != nil || innerType != collectionPresetInnerType {
			return nil
		}
		if len(result.Entries) >= collectionPresetResultLimit {
			result.Truncated = true
			return scanLimitReached
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			result.SkippedFiles++
			return nil
		}
		relativePath, relativeErr := filepath.Rel(rootPath, path)
		if relativeErr != nil || relativePath == "." || relativePath == ".." ||
			strings.HasPrefix(relativePath, ".."+string(os.PathSeparator)) {
			result.SkippedFiles++
			return nil
		}
		result.Entries = append(result.Entries, collectionPresetDiscoveryEntry{
			RelativePath: filepath.ToSlash(relativePath),
			FileName:     entry.Name(),
			Size:         info.Size(),
			ModifiedAt:   info.ModTime().UTC().Format(timeFormatRFC3339Nano),
		})
		return nil
	})
	if err != nil && !errors.Is(err, scanLimitReached) {
		return collectionPresetDiscoveryResult{}, err
	}
	sort.Slice(result.Entries, func(left, right int) bool {
		return strings.ToLower(result.Entries[left].RelativePath) <
			strings.ToLower(result.Entries[right].RelativePath)
	})
	result.ResultCount = len(result.Entries)
	result.DurationMS = time.Since(startedAt).Milliseconds()
	return result, nil
}

func resolveDiscoveredCollectionPreset(
	rawRootPath string,
	rawRelativePath string,
	baseDir string,
) (string, string, error) {
	presetPath, normalizedRelative, err := resolveDiscoveredCollectionPresetFile(
		rawRootPath, rawRelativePath, baseDir)
	if err != nil {
		return "", "", err
	}
	innerType, err := readCollectionPresetInnerType(presetPath)
	if err != nil || innerType != collectionPresetInnerType {
		return "", "", errors.New("selected file is not a batch waveform import preset")
	}
	return presetPath, normalizedRelative, nil
}

func resolveDiscoveredCollectionPresetFile(
	rawRootPath string,
	rawRelativePath string,
	baseDir string,
) (string, string, error) {
	rootPath, err := resolveCollectionRoot(rawRootPath, baseDir)
	if err != nil {
		return "", "", err
	}
	relativePath := filepath.Clean(filepath.FromSlash(strings.TrimSpace(rawRelativePath)))
	if relativePath == "." || filepath.IsAbs(relativePath) || filepath.VolumeName(relativePath) != "" {
		return "", "", errors.New("preset relative path is invalid")
	}
	candidate := canonicalExistingPath(filepath.Join(rootPath, relativePath))
	containedPath, err := filepath.Rel(rootPath, candidate)
	if err != nil || containedPath == ".." || strings.HasPrefix(containedPath, ".."+string(os.PathSeparator)) {
		return "", "", errors.New("preset path is outside the search folder")
	}
	presetPath, err := resolveCollectionPresetFile(candidate, baseDir)
	if err != nil {
		return "", "", err
	}
	normalizedRelative, err := filepath.Rel(rootPath, presetPath)
	if err != nil || normalizedRelative == ".." ||
		strings.HasPrefix(normalizedRelative, ".."+string(os.PathSeparator)) {
		return "", "", errors.New("preset path is outside the search folder")
	}
	return presetPath, filepath.ToSlash(normalizedRelative), nil
}

func loadDiscoveredCollectionPresetDocument(
	rawRootPath string,
	rawRelativePath string,
	baseDir string,
) (collectionPresetDocument, string, string, error) {
	presetPath, relativePath, err := resolveDiscoveredCollectionPresetFile(
		rawRootPath, rawRelativePath, baseDir)
	if err != nil {
		return collectionPresetDocument{}, "", "", err
	}
	document, resolvedPath, err := loadCollectionPresetDocument(presetPath, baseDir)
	if err != nil {
		return collectionPresetDocument{}, "", "", err
	}
	return document, resolvedPath, relativePath, nil
}

func loadDiscoveredCollectionPreset(
	rawRootPath string,
	rawRelativePath string,
	baseDir string,
) (collectionPreset, string, string, error) {
	presetPath, relativePath, err := resolveDiscoveredCollectionPreset(
		rawRootPath, rawRelativePath, baseDir)
	if err != nil {
		return collectionPreset{}, "", "", err
	}
	preset, resolvedPath, err := loadCollectionPreset(presetPath, baseDir)
	if err != nil {
		return collectionPreset{}, "", "", err
	}
	return preset, resolvedPath, relativePath, nil
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

type collectionHeaderCandidate struct {
	HeaderRow int
	Delimiter string
	Headers   []string
	Score     int
}

func readCollectionPreviewLines(sourcePath string) ([]string, error) {
	file, err := os.Open(sourcePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 512*1024)
	lines := make([]string, 0, 32)
	for scanner.Scan() && len(lines) < 256 {
		lines = append(lines, strings.TrimSuffix(scanner.Text(), "\r"))
	}
	if err = scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

func collectionSinglePreviewCacheKey(match collectionFileMatch) string {
	return canonicalExistingPath(match.Path) + "\x00" +
		strconv.FormatInt(match.Size, 10) + "\x00" + match.ModifiedAt
}

func buildCollectionSinglePreviewIndex(
	match collectionFileMatch,
) (collectionSinglePreviewIndex, error) {
	sourcePath := canonicalExistingPath(match.Path)
	file, err := os.Open(sourcePath)
	if err != nil {
		return collectionSinglePreviewIndex{}, err
	}
	defer file.Close()

	buffer := make([]byte, 64*1024)
	checkpoints := []int64{0}
	totalLines := 0
	offset := int64(0)
	hasBytes := false
	lastByte := byte(0)
	for {
		count, readErr := file.Read(buffer)
		if count > 0 {
			hasBytes = true
			lastByte = buffer[count-1]
			for index, value := range buffer[:count] {
				if value != '\n' {
					continue
				}
				totalLines++
				if totalLines%collectionSingleIndexStride == 0 {
					checkpoints = append(checkpoints, offset+int64(index)+1)
				}
			}
			offset += int64(count)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return collectionSinglePreviewIndex{}, readErr
		}
	}
	if hasBytes && lastByte != '\n' {
		totalLines++
	}
	return collectionSinglePreviewIndex{
		createdAt: time.Now(), sourcePath: sourcePath,
		size: match.Size, modifiedAt: match.ModifiedAt,
		totalLines: totalLines, checkpoints: checkpoints,
	}, nil
}

func (s *service) collectionSinglePreviewIndex(
	match collectionFileMatch,
) (collectionSinglePreviewIndex, error) {
	key := collectionSinglePreviewCacheKey(match)
	now := time.Now()
	s.collectionPreviewMu.Lock()
	if cached, found := s.collectionPreviewCache[key]; found &&
		now.Sub(cached.createdAt) <= collectionSingleIndexTTL {
		s.collectionPreviewMu.Unlock()
		return cached, nil
	}
	s.collectionPreviewMu.Unlock()

	indexed, err := buildCollectionSinglePreviewIndex(match)
	if err != nil {
		return collectionSinglePreviewIndex{}, err
	}
	s.collectionPreviewMu.Lock()
	defer s.collectionPreviewMu.Unlock()
	if s.collectionPreviewCache == nil {
		s.collectionPreviewCache = make(map[string]collectionSinglePreviewIndex)
	}
	for cacheKey, cached := range s.collectionPreviewCache {
		if now.Sub(cached.createdAt) > collectionSingleIndexTTL {
			delete(s.collectionPreviewCache, cacheKey)
		}
	}
	for len(s.collectionPreviewCache) >= collectionSingleIndexLimit {
		oldestKey := ""
		var oldestTime time.Time
		for cacheKey, cached := range s.collectionPreviewCache {
			if oldestKey == "" || cached.createdAt.Before(oldestTime) {
				oldestKey = cacheKey
				oldestTime = cached.createdAt
			}
		}
		if oldestKey == "" {
			break
		}
		delete(s.collectionPreviewCache, oldestKey)
	}
	s.collectionPreviewCache[key] = indexed
	return indexed, nil
}

func readCollectionSinglePreviewLine(
	reader *bufio.Reader,
) (string, bool, bool, error) {
	const captureByteLimit = 16 * 1024
	data := make([]byte, 0, 512)
	found := false
	truncated := false
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(fragment) > 0 {
			found = true
			remaining := captureByteLimit - len(data)
			if remaining > 0 {
				copyCount := len(fragment)
				if copyCount > remaining {
					copyCount = remaining
				}
				data = append(data, fragment[:copyCount]...)
			}
			if len(fragment) > remaining {
				truncated = true
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if !found {
				return "", false, false, nil
			}
			break
		}
		if err != nil {
			return "", false, false, err
		}
		break
	}
	text := strings.TrimSuffix(string(data), "\n")
	text = strings.TrimSuffix(text, "\r")
	text = strings.ToValidUTF8(text, "\uFFFD")
	runes := []rune(text)
	if len(runes) > collectionSinglePreviewRunes {
		text = string(runes[:collectionSinglePreviewRunes])
		truncated = true
	}
	if truncated {
		text += "..."
	}
	return text, true, truncated, nil
}

func readCollectionSinglePreviewHead(
	sourcePath string,
	lineCount int,
) ([]collectionSinglePreviewLine, bool, error) {
	file, err := os.Open(sourcePath)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	lines := make([]collectionSinglePreviewLine, 0, lineCount)
	for lineNumber := 1; lineNumber <= lineCount+1; lineNumber++ {
		text, found, truncated, readErr := readCollectionSinglePreviewLine(reader)
		if readErr != nil {
			return nil, false, readErr
		}
		if !found {
			return lines, false, nil
		}
		if lineNumber > lineCount {
			return lines, true, nil
		}
		lines = append(lines, collectionSinglePreviewLine{
			Number: lineNumber, Text: text, Truncated: truncated,
		})
	}
	return lines, false, nil
}

func readCollectionSinglePreviewRange(
	indexed collectionSinglePreviewIndex,
	startLine int,
	lineCount int,
) ([]collectionSinglePreviewLine, error) {
	if indexed.totalLines == 0 {
		return []collectionSinglePreviewLine{}, nil
	}
	checkpoint := (startLine - 1) / collectionSingleIndexStride
	if checkpoint < 0 || checkpoint >= len(indexed.checkpoints) {
		return nil, errors.New("单文件预览起始行超出范围")
	}
	file, err := os.Open(indexed.sourcePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err = file.Seek(indexed.checkpoints[checkpoint], io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(file, 64*1024)
	currentLine := checkpoint*collectionSingleIndexStride + 1
	for currentLine < startLine {
		_, found, _, readErr := readCollectionSinglePreviewLine(reader)
		if readErr != nil {
			return nil, readErr
		}
		if !found {
			return nil, errors.New("单文件预览起始行超出范围")
		}
		currentLine++
	}
	lines := make([]collectionSinglePreviewLine, 0, lineCount)
	for len(lines) < lineCount && currentLine <= indexed.totalLines {
		text, found, truncated, readErr := readCollectionSinglePreviewLine(reader)
		if readErr != nil {
			return nil, readErr
		}
		if !found {
			break
		}
		lines = append(lines, collectionSinglePreviewLine{
			Number: currentLine, Text: text, Truncated: truncated,
		})
		currentLine++
	}
	return lines, nil
}

func collectionSinglePreviewDelimiter(delimiter, line, fileName string) string {
	delimiter = strings.ToLower(strings.TrimSpace(delimiter))
	switch delimiter {
	case "csv":
		return "comma"
	case "tsv":
		return "tab"
	case "space":
		return "whitespace"
	case "", "auto", "unknown":
		return collectionDelimiterForLine(line, fileName)
	default:
		return delimiter
	}
}

func joinCollectionSinglePreviewColumns(columns []string, delimiter string) string {
	switch delimiter {
	case "comma":
		var output strings.Builder
		writer := csv.NewWriter(&output)
		if err := writer.Write(columns); err != nil {
			return strings.Join(columns, ",")
		}
		writer.Flush()
		if writer.Error() != nil {
			return strings.Join(columns, ",")
		}
		return strings.TrimSuffix(strings.TrimSuffix(output.String(), "\n"), "\r")
	case "tab":
		return strings.Join(columns, "\t")
	case "whitespace":
		return strings.Join(columns, " ")
	default:
		if utf8.RuneCountInString(delimiter) == 1 {
			return strings.Join(columns, delimiter)
		}
		return strings.Join(columns, " ")
	}
}

func collectionSinglePreviewWithoutSequenceColumn(
	lines []collectionSinglePreviewLine,
	delimiter string,
	fileName string,
) []collectionSinglePreviewLine {
	result := make([]collectionSinglePreviewLine, len(lines))
	copy(result, lines)
	for index := range result {
		trimmed := strings.TrimSpace(result[index].Text)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") ||
			strings.HasPrefix(trimmed, "//") {
			continue
		}
		effectiveDelimiter := collectionSinglePreviewDelimiter(
			delimiter, result[index].Text, fileName)
		columns := collectionSplitColumns(result[index].Text, effectiveDelimiter)
		if len(columns) <= 1 {
			result[index].Text = ""
			continue
		}
		result[index].Text = joinCollectionSinglePreviewColumns(
			columns[1:], effectiveDelimiter)
	}
	return result
}

func collectionDelimiterForLine(line, fileName string) string {
	if countDelimitedColumns(line, '\t') > 1 {
		return "tab"
	}
	if countDelimitedColumns(line, ',') > 1 {
		return "comma"
	}
	if len(strings.Fields(line)) > 1 {
		return "whitespace"
	}
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".csv":
		return "comma"
	case ".tsv":
		return "tab"
	default:
		return "single"
	}
}

func collectionSplitColumns(line, delimiter string) []string {
	delimiter = strings.ToLower(strings.TrimSpace(delimiter))
	switch delimiter {
	case "csv":
		delimiter = "comma"
	case "tsv":
		delimiter = "tab"
	case "space":
		delimiter = "whitespace"
	}
	if len(delimiter) == 1 && delimiter != " " {
		parts := strings.Split(strings.TrimSpace(line), delimiter)
		for index := range parts {
			parts[index] = strings.TrimSpace(parts[index])
		}
		return parts
	}
	return splitSampleColumns(line, delimiter)
}

func collectionHeaderCellsValid(headers []string) bool {
	if len(headers) < 2 {
		return false
	}
	seen := make(map[string]bool, len(headers))
	textual := 0
	numberPattern := regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`)
	for _, rawHeader := range headers {
		header := strings.TrimSpace(rawHeader)
		if header == "" || seen[header] {
			return false
		}
		seen[header] = true
		if !numberPattern.MatchString(header) && !looksComplexLiteral(header) {
			textual++
		}
	}
	return textual > 0 && textual*2 >= len(headers)
}

func collectionHeaderAt(
	lines []string,
	fileName string,
	headerRow int,
	delimiter string,
) (collectionHeaderCandidate, bool) {
	if headerRow < 1 || headerRow > len(lines) {
		return collectionHeaderCandidate{}, false
	}
	line := strings.TrimSpace(lines[headerRow-1])
	if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
		return collectionHeaderCandidate{}, false
	}
	if delimiter == "" || delimiter == "auto" {
		delimiter = collectionDelimiterForLine(line, fileName)
	}
	if delimiter == "single" {
		return collectionHeaderCandidate{}, false
	}
	headers := collectionSplitColumns(line, delimiter)
	if !collectionHeaderCellsValid(headers) {
		return collectionHeaderCandidate{}, false
	}
	matchingRows := 0
	for index := headerRow; index < len(lines) && matchingRows < 3; index++ {
		candidate := strings.TrimSpace(lines[index])
		if candidate == "" || strings.HasPrefix(candidate, "#") ||
			strings.HasPrefix(candidate, "//") {
			continue
		}
		if len(collectionSplitColumns(candidate, delimiter)) == len(headers) {
			matchingRows++
		}
	}
	if matchingRows == 0 {
		return collectionHeaderCandidate{}, false
	}
	return collectionHeaderCandidate{
		HeaderRow: headerRow,
		Delimiter: delimiter,
		Headers:   headers,
		Score:     matchingRows*4 + len(headers),
	}, true
}

func detectCollectionHeader(
	lines []string,
	fileName string,
	preferredRow int,
	preferredDelimiter string,
) (collectionHeaderCandidate, bool) {
	if preferredRow > 0 {
		if candidate, ok := collectionHeaderAt(
			lines, fileName, preferredRow, preferredDelimiter); ok {
			candidate.Score += 100
			return candidate, true
		}
	}
	best := collectionHeaderCandidate{}
	limit := len(lines)
	if limit > 32 {
		limit = 32
	}
	for index := 0; index < limit; index++ {
		candidate, ok := collectionHeaderAt(lines, fileName, index+1, "auto")
		if !ok {
			continue
		}
		if index == 0 {
			candidate.Score++
		}
		if strings.EqualFold(filepath.Ext(fileName), ".csv") &&
			candidate.Delimiter == "comma" {
			candidate.Score += 2
		}
		if strings.EqualFold(filepath.Ext(fileName), ".tsv") &&
			candidate.Delimiter == "tab" {
			candidate.Score += 2
		}
		if candidate.Score > best.Score {
			best = candidate
		}
	}
	return best, best.Score > 0
}

func collectionSchemaHash(mode, delimiter string, headers []string) string {
	payload := mode + "\x00" + delimiter + "\x00" + strings.Join(headers, "\x00")
	sum := sha256.Sum256([]byte(payload))
	return fmt.Sprintf("%x", sum[:8])
}

func mergeCollectionColumns(
	headers []string,
	existing []collectionColumnConfig,
) []collectionColumnConfig {
	bySource := make(map[string]collectionColumnConfig, len(existing))
	for _, column := range existing {
		bySource[column.Source] = column
	}
	merged := make([]collectionColumnConfig, 0, len(headers))
	for _, source := range headers {
		column, found := bySource[source]
		if !found {
			column = collectionColumnConfig{Source: source, Enabled: true, Name: source}
		}
		column.Source = source
		if strings.TrimSpace(column.Name) == "" {
			column.Name = source
		}
		merged = append(merged, column)
	}
	return merged
}

func collectionDefaultSignalName(fileName string) string {
	name := strings.TrimSuffix(filepath.Base(fileName), filepath.Ext(fileName))
	name = strings.TrimSpace(name)
	if name == "" {
		return "signal"
	}
	return name
}

func collectionPreviewCell(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= collectionPreviewCellLimit {
		return string(runes)
	}
	return string(runes[:collectionPreviewCellLimit]) + "..."
}

type collectionPreviewFilterClause struct {
	operator       string
	operand        string
	operandNumber  float64
	operandNumeric bool
}

type collectionPreviewFilter struct {
	columnIndex int
	groups      [][]collectionPreviewFilterClause
}

func collectionFilterNumber(value string) (float64, bool) {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return number, err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func collectionFilterOperand(value string) (string, error) {
	text := strings.TrimSpace(value)
	if len(text) < 2 || text[0] != text[len(text)-1] ||
		(text[0] != '\'' && text[0] != '"') {
		return text, nil
	}
	if text[0] == '"' {
		var decoded string
		if err := json.Unmarshal([]byte(text), &decoded); err != nil {
			return "", errors.New("filter contains an invalid quoted value")
		}
		return decoded, nil
	}
	body := text[1 : len(text)-1]
	body = strings.ReplaceAll(body, `\'`, `'`)
	body = strings.ReplaceAll(body, `\\`, `\`)
	return body, nil
}

func compileCollectionPreviewFilter(
	expression string,
	source string,
) ([][]collectionPreviewFilterClause, error) {
	text := strings.TrimSpace(expression)
	if text == "" {
		return nil, nil
	}
	groups := make([][]collectionPreviewFilterClause, 0)
	for _, rawGroup := range strings.Split(text, "||") {
		if strings.TrimSpace(rawGroup) == "" {
			return nil, fmt.Errorf("filter for %s contains an empty OR condition", source)
		}
		clauses := make([]collectionPreviewFilterClause, 0)
		for _, rawClause := range strings.Split(rawGroup, "&&") {
			clauseText := strings.TrimSpace(rawClause)
			if clauseText == "" {
				return nil, fmt.Errorf("filter for %s contains an empty AND condition", source)
			}
			operator := "=="
			operandText := clauseText
			for _, candidate := range []string{"==", "!=", ">=", "<=", ">", "<", "="} {
				if strings.HasPrefix(clauseText, candidate) {
					operator = candidate
					operandText = strings.TrimSpace(clauseText[len(candidate):])
					break
				}
			}
			if operandText == "" {
				return nil, fmt.Errorf("filter for %s is missing a comparison value", source)
			}
			operand, err := collectionFilterOperand(operandText)
			if err != nil {
				return nil, err
			}
			operandNumber, operandNumeric := collectionFilterNumber(operand)
			if (operator == ">" || operator == ">=" || operator == "<" || operator == "<=") &&
				!operandNumeric {
				return nil, fmt.Errorf(
					"filter for %s requires a numeric value after %s", source, operator)
			}
			clauses = append(clauses, collectionPreviewFilterClause{
				operator: operator, operand: operand,
				operandNumber: operandNumber, operandNumeric: operandNumeric,
			})
		}
		groups = append(groups, clauses)
	}
	return groups, nil
}

func collectionPreviewFilterClauseMatches(
	value string,
	clause collectionPreviewFilterClause,
) bool {
	valueText := strings.TrimSpace(value)
	valueNumber, valueNumeric := collectionFilterNumber(valueText)
	if clause.operator == "=" || clause.operator == "==" || clause.operator == "!=" {
		matched := valueText == clause.operand
		if valueNumeric && clause.operandNumeric {
			matched = valueNumber == clause.operandNumber
		}
		if clause.operator == "!=" {
			return !matched
		}
		return matched
	}
	if !valueNumeric {
		return false
	}
	switch clause.operator {
	case ">":
		return valueNumber > clause.operandNumber
	case ">=":
		return valueNumber >= clause.operandNumber
	case "<":
		return valueNumber < clause.operandNumber
	default:
		return valueNumber <= clause.operandNumber
	}
}

func collectionPreviewFilterMatches(value string, groups [][]collectionPreviewFilterClause) bool {
	for _, group := range groups {
		matched := true
		for _, clause := range group {
			if !collectionPreviewFilterClauseMatches(value, clause) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func collectionTablePreview(
	lines []string,
	headerRow int,
	delimiter string,
	headers []string,
	configuredColumns []collectionColumnConfig,
) ([]string, [][]string, bool, error) {
	columnCount := len(headers)
	truncated := columnCount > collectionPreviewColumnLimit
	if columnCount > collectionPreviewColumnLimit {
		columnCount = collectionPreviewColumnLimit
	}
	columns := make([]string, columnCount)
	for index := 0; index < columnCount; index++ {
		columns[index] = collectionPreviewCell(headers[index])
	}
	headerIndexes := make(map[string]int, len(headers))
	for index, header := range headers {
		headerIndexes[header] = index
	}
	filters := make([]collectionPreviewFilter, 0)
	for _, column := range configuredColumns {
		if strings.TrimSpace(column.Filter) == "" {
			continue
		}
		columnIndex, found := headerIndexes[column.Source]
		if !found {
			return nil, nil, false, fmt.Errorf(
				"selected table column is missing: %s", column.Source)
		}
		groups, err := compileCollectionPreviewFilter(column.Filter, column.Source)
		if err != nil {
			return nil, nil, false, err
		}
		filters = append(filters, collectionPreviewFilter{
			columnIndex: columnIndex,
			groups:      groups,
		})
	}
	rows := make([][]string, 0, collectionPreviewRowLimit)
	for index := headerRow; index < len(lines) && len(rows) < collectionPreviewRowLimit; index++ {
		line := strings.TrimSpace(lines[index])
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		values := collectionSplitColumns(line, delimiter)
		matches := true
		for _, filter := range filters {
			value := ""
			if filter.columnIndex < len(values) {
				value = values[filter.columnIndex]
			}
			if !collectionPreviewFilterMatches(value, filter.groups) {
				matches = false
				break
			}
		}
		if !matches {
			continue
		}
		row := make([]string, columnCount)
		for column := 0; column < columnCount && column < len(values); column++ {
			row[column] = collectionPreviewCell(values[column])
		}
		rows = append(rows, row)
	}
	return columns, rows, truncated, nil
}

func prepareCollectionEntry(
	rule collectionPresetPath,
	match collectionFileMatch,
	forcedHeaderRow int,
) (collectionPresetPath, collectionSearchEntry, error) {
	lines, err := readCollectionPreviewLines(match.Path)
	if err != nil {
		return rule, collectionSearchEntry{}, err
	}
	prepared := rule
	entry := collectionSearchEntry{
		Index: -1, Name: rule.Name, HasSeq: rule.HasSeq,
		IndexColumn: rule.IndexColumn,
		Columns:     []collectionColumnConfig{}, OutputNames: []string{},
	}
	preferredRow := rule.HeaderRow
	if forcedHeaderRow > 0 {
		preferredRow = forcedHeaderRow
	}
	header, tableDetected := detectCollectionHeader(
		lines, match.FileName, preferredRow, rule.Delimiter)
	mode := rule.UsrGen.ImportMode
	if forcedHeaderRow > 0 {
		mode = "table"
	} else if mode == "" {
		if tableDetected {
			mode = "table"
		} else {
			mode = "single"
		}
	}
	if mode == "table" {
		if !tableDetected {
			return rule, entry, errors.New("无法识别表格标题行，请修改标题行")
		}
		columns := mergeCollectionColumns(header.Headers, rule.Columns)
		indexColumn := strings.TrimSpace(rule.IndexColumn)
		if indexColumn != "" {
			found := false
			for _, headerName := range header.Headers {
				if headerName == indexColumn {
					found = true
					break
				}
			}
			if !found {
				if strings.TrimSpace(rule.UsrGen.IndexColumn) != "" {
					return rule, entry, fmt.Errorf(
						"selected table index column is missing: %s", indexColumn)
				}
				indexColumn = ""
			}
		}
		autoGen := rule.AutoGen
		autoGen.ImportMode = "table"
		autoGen.HeaderRow = header.HeaderRow
		autoGen.Delimiter = header.Delimiter
		autoGen.Parser = "parse_table_data"
		autoGen.Columns = columns
		autoGen.IndexColumn = indexColumn
		autoGen.SchemaHash = collectionSchemaHash("table", header.Delimiter, header.Headers)
		autoGen.HasSeq = nil
		prepared = effectiveCollectionPresetPath(rule.UsrGen, autoGen)
		entry.Name = rule.Name
		if entry.Name == "" {
			entry.Name = collectionDefaultSignalName(match.FileName)
		}
		entry.ImportMode = "table"
		entry.HeaderRow = header.HeaderRow
		entry.IndexColumn = indexColumn
		entry.Delimiter = header.Delimiter
		entry.Parser = autoGen.Parser
		entry.Columns = columns
		entry.SchemaHash = autoGen.SchemaHash
		previewColumns, previewRows, previewTruncated, previewErr := collectionTablePreview(
			lines, header.HeaderRow, header.Delimiter, header.Headers, columns)
		if previewErr != nil {
			return rule, entry, previewErr
		}
		entry.PreviewColumns = previewColumns
		entry.PreviewRows = previewRows
		entry.PreviewTruncated = previewTruncated
		complexSources, complexErr := collectionTableComplexSources(
			lines, header.HeaderRow, header.Delimiter, header.Headers, columns, indexColumn)
		if complexErr != nil {
			return rule, entry, complexErr
		}
		entry.ComplexDetected = len(complexSources) > 0
		entry.ComplexSources = complexSources
		complexSourceSet := make(map[string]bool, len(complexSources))
		for _, source := range complexSources {
			complexSourceSet[source] = true
		}
		for _, column := range columns {
			if column.Enabled && column.Source != indexColumn {
				if complexSourceSet[column.Source] {
					entry.OutputNames = append(
						entry.OutputNames, column.Name+"_I", column.Name+"_Q")
				} else {
					entry.OutputNames = append(entry.OutputNames, column.Name)
				}
			}
		}
		if len(entry.OutputNames) == 0 {
			return rule, entry, errors.New(
				"select at least one waveform signal column besides the index column")
		}
	} else {
		hasSeqConfigured := rule.UsrGen.HasSeq != nil || rule.AutoGen.HasSeq != nil
		var analysis map[string]any
		if hasSeqConfigured {
			analysis = analyzeImportSample(match.FileName, lines, rule.HasSeq)
		} else {
			analysis = analyzeImportSample(match.FileName, lines)
		}
		hasSeq := boolValue(analysis["hasIndex"], rule.HasSeq)
		if hasSeqConfigured {
			hasSeq = rule.HasSeq
		}
		autoGen := rule.AutoGen
		autoGen.ImportMode = "single"
		autoGen.HeaderRow = 0
		autoGen.IndexColumn = ""
		autoGen.Delimiter = stringValue(analysis["delimiter"])
		autoGen.Parser = stringValue(analysis["recommendedParser"])
		autoGen.Columns = nil
		autoGen.SchemaHash = collectionSchemaHash(
			"single", autoGen.Delimiter,
			[]string{fmt.Sprintf("%d", intValue(analysis["columnCount"], 0))},
		)
		autoGen.HasSeq = &hasSeq
		prepared = effectiveCollectionPresetPath(rule.UsrGen, autoGen)
		entry.Name = rule.Name
		if entry.Name == "" {
			entry.Name = collectionDefaultSignalName(match.FileName)
		}
		if normalized, nameErr := normalizeSignalName(entry.Name); nameErr == nil {
			entry.Name = normalized
		} else {
			return rule, entry, nameErr
		}
		entry.HasSeq = hasSeq
		entry.ImportMode = "single"
		entry.Delimiter = autoGen.Delimiter
		entry.Parser = autoGen.Parser
		entry.SchemaHash = autoGen.SchemaHash
		entry.ComplexDetected = boolValue(analysis["complexDetected"], false)
		if entry.ComplexDetected {
			entry.OutputNames = []string{entry.Name + "_I", entry.Name + "_Q"}
		} else {
			entry.OutputNames = []string{entry.Name}
		}
	}
	before, _ := json.Marshal(rule.AutoGen)
	after, _ := json.Marshal(prepared.AutoGen)
	entry.AutoGenChanged = string(before) != string(after)
	return prepared, entry, nil
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
		if rule.Formula != nil {
			signalName, expandErr := expandCollectionTemplate(
				rule.Name, preset, variables, false)
			if expandErr != nil {
				return collectionSearchResult{}, fmt.Errorf("paths[%d].name: %w", index, expandErr)
			}
			signalName, expandErr = normalizeSignalName(signalName)
			if expandErr != nil {
				return collectionSearchResult{}, fmt.Errorf("paths[%d].name: %w", index, expandErr)
			}
			result.Entries = append(result.Entries, collectionSearchEntry{
				Index: index, Name: signalName, ImportMode: "formula",
				Formula: rule.Formula, OutputNames: []string{signalName},
				Status: "formula", Matches: []collectionFileMatch{},
			})
			result.ResultCount++
			continue
		}
		folder, expandErr := expandCollectionTemplate(rule.Folder, preset, variables, false)
		if expandErr != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].folder: %w", index, expandErr)
		}
		patternText, expandErr := expandCollectionTemplate(
			rule.GrepKeys, preset, variables, true)
		if expandErr != nil {
			return collectionSearchResult{}, fmt.Errorf("paths[%d].grepKeys: %w", index, expandErr)
		}
		signalName := ""
		if rule.Name != "" {
			signalName, expandErr = expandCollectionTemplate(rule.Name, preset, variables, false)
			if expandErr != nil {
				return collectionSearchResult{}, fmt.Errorf("paths[%d].name: %w", index, expandErr)
			}
			signalName, expandErr = normalizeSignalName(signalName)
			if expandErr != nil {
				return collectionSearchResult{}, fmt.Errorf("paths[%d].name: %w", index, expandErr)
			}
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
		if entry.Status == "formula" {
			continue
		}
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
		default:
			entry.Status = "multiple"
			entry.Message = "匹配到多个文件，默认选择排序后的第一个文件"
		}
		if entry.Status != "matched" && entry.Status != "multiple" {
			continue
		}
		runtimeRule := preset.Paths[entry.Index]
		runtimeRule.Name = entry.Name
		preparedRule, preparedEntry, prepareErr := prepareCollectionEntry(
			runtimeRule, entry.Matches[0], 0)
		if prepareErr != nil {
			entry.Status = "config-error"
			entry.Message = prepareErr.Error()
			entry.ImportMode = runtimeRule.ImportMode
			entry.HeaderRow = runtimeRule.HeaderRow
			entry.IndexColumn = runtimeRule.IndexColumn
			entry.Delimiter = runtimeRule.Delimiter
			entry.Parser = runtimeRule.Parser
			entry.Columns = runtimeRule.Columns
			continue
		}
		preset.Paths[entry.Index] = effectiveCollectionPresetPath(
			preset.Paths[entry.Index].UsrGen,
			preparedRule.AutoGen,
		)
		entry.Name = preparedEntry.Name
		entry.HasSeq = preparedEntry.HasSeq
		entry.ImportMode = preparedEntry.ImportMode
		entry.HeaderRow = preparedEntry.HeaderRow
		entry.IndexColumn = preparedEntry.IndexColumn
		entry.Delimiter = preparedEntry.Delimiter
		entry.Parser = preparedEntry.Parser
		entry.Columns = preparedEntry.Columns
		entry.SchemaHash = preparedEntry.SchemaHash
		entry.OutputNames = preparedEntry.OutputNames
		entry.ComplexDetected = preparedEntry.ComplexDetected
		entry.ComplexSources = preparedEntry.ComplexSources
		entry.PreviewColumns = preparedEntry.PreviewColumns
		entry.PreviewRows = preparedEntry.PreviewRows
		entry.PreviewTruncated = preparedEntry.PreviewTruncated
		entry.AutoGenChanged = preparedEntry.AutoGenChanged
		result.ResultCount++
	}
	result.Preset = preset
	result.Ready = result.ResultCount > 0

	nameEntries := make(map[string][]int)
	for index, entry := range result.Entries {
		if entry.Status == "matched" || entry.Status == "multiple" {
			for _, name := range entry.OutputNames {
				nameEntries[name] = append(nameEntries[name], index)
			}
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
	type searchRule struct {
		Folder   string                   `json:"folder"`
		GrepKeys string                   `json:"grepKeys"`
		Name     string                   `json:"name"`
		Formula  *collectionFormulaConfig `json:"formula,omitempty"`
	}
	rules := make([]searchRule, len(preset.Paths))
	for index, rule := range preset.Paths {
		rules[index] = searchRule{
			Folder: rule.Folder, GrepKeys: rule.GrepKeys, Name: rule.Name,
			Formula: rule.Formula,
		}
	}
	payload := struct {
		RootPath  string            `json:"rootPath"`
		Vars      []string          `json:"vars"`
		Rules     []searchRule      `json:"rules"`
		Variables map[string]string `json:"variables"`
	}{
		RootPath: rootPath, Vars: preset.Vars, Rules: rules, Variables: variables,
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

func validateCachedCollectionFiles(
	result collectionSearchResult,
	requireReady ...bool,
) error {
	mustBeReady := len(requireReady) == 0 || requireReady[0]
	if mustBeReady && !result.Ready {
		return errors.New("cached search results are incomplete")
	}
	matchedCount := 0
	formulaCount := 0
	for _, entry := range result.Entries {
		if entry.Status == "formula" && entry.ImportMode == "formula" {
			formulaCount++
			continue
		}
		if entry.Status == "missing" || entry.Status == "folder-missing" {
			if len(entry.Matches) != 0 {
				return errors.New("cached skipped search result contains a match")
			}
			continue
		}
		if len(entry.Matches) < 1 {
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
	selectedCount := matchedCount + formulaCount
	if selectedCount == 0 || (mustBeReady && selectedCount != result.ResultCount) {
		return errors.New("cached search result count is invalid")
	}
	return nil
}

func (s *service) cachedCollectionSearch(
	token string,
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
	requireReady ...bool,
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
	if err = validateCachedCollectionFiles(cached.result, requireReady...); err != nil {
		return collectionSearchResult{}, fmt.Errorf("%w; search again", err)
	}
	return cached.result, nil
}

func (s *service) parseCollectionEntry(
	catalog importCatalog,
	search collectionSearchResult,
	entry collectionSearchEntry,
	rule collectionPresetPath,
) collectionImportEntryResult {
	match := entry.Matches[0]
	sourcePath := canonicalExistingPath(match.Path)
	if !pathInside(search.RootPath, sourcePath) {
		return collectionImportEntryResult{
			err: errors.New("a matched file moved outside the selected data folder"),
		}
	}
	rule.Name = entry.Name
	preparedRule, preparedEntry, err := prepareCollectionEntry(rule, match, 0)
	if err != nil {
		return collectionImportEntryResult{err: fmt.Errorf("%s: %w", match.RelativePath, err)}
	}
	var result map[string]any
	var parser any
	var analysis map[string]any
	if preparedEntry.ImportMode == "table" {
		result, err = s.imports.runTableLocalFileWithOptions(
			sourcePath,
			tableImportOptions{
				HeaderRow:   preparedRule.HeaderRow,
				IndexColumn: preparedRule.IndexColumn,
				Delimiter:   preparedRule.Delimiter,
				Columns:     preparedRule.Columns,
				Tbl:         preparedRule.Tbl,
			},
		)
		parser = "parse_table_data"
		analysis = map[string]any{
			"importMode": "table", "headerRow": preparedRule.HeaderRow,
			"indexColumn": preparedRule.IndexColumn,
			"delimiter":   preparedRule.Delimiter,
		}
	} else {
		lines, readErr := readImportSampleLines(sourcePath)
		if readErr != nil {
			return collectionImportEntryResult{err: readErr}
		}
		analysis = analyzeImportSample(match.FileName, lines, preparedRule.HasSeq)
		recommended := recommendScheme(catalog.Schemes, analysis)
		if recommended == nil {
			return collectionImportEntryResult{
				err: fmt.Errorf("no parser preset can process %s", match.RelativePath),
			}
		}
		parser = recommended["parser"]
		result, err = s.imports.runLocalFileWithOptions(
			stringValue(recommended["schemeId"]),
			intValue(recommended["mappingIndex"], -1),
			preparedEntry.Name,
			sourcePath,
			preparedRule.HasSeq,
			map[string]any{"tbl": preparedRule.Tbl},
		)
	}
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
			"signal": preparedEntry.Name, "hasSeq": preparedRule.HasSeq,
			"importMode": preparedEntry.ImportMode,
			"parser":     parser, "analysis": analysis,
			"updateCount": len(fileUpdates), "matchCount": len(entry.Matches),
		},
	}
}

func normalizeCollectionImportProgressToken(raw string) (string, error) {
	token := strings.TrimSpace(raw)
	if token == "" {
		return "", nil
	}
	if !collectionImportProgressTokenPattern.MatchString(token) {
		return "", errors.New("collection import progress token is invalid")
	}
	return token, nil
}

func (s *service) pruneCollectionImportProgressLocked(now time.Time) {
	for token, progress := range s.collectionImportJobs {
		if now.Sub(progress.updatedAt) > collectionImportProgressTTL {
			delete(s.collectionImportJobs, token)
		}
	}
	for len(s.collectionImportJobs) >= collectionImportProgressMax {
		oldestToken := ""
		var oldestAt time.Time
		for token, progress := range s.collectionImportJobs {
			if oldestToken == "" || progress.updatedAt.Before(oldestAt) {
				oldestToken = token
				oldestAt = progress.updatedAt
			}
		}
		if oldestToken == "" {
			break
		}
		delete(s.collectionImportJobs, oldestToken)
	}
}

func (s *service) beginCollectionImportProgress(rawToken string) (string, error) {
	token, err := normalizeCollectionImportProgressToken(rawToken)
	if err != nil || token == "" {
		return token, err
	}
	now := time.Now()
	s.collectionImportMu.Lock()
	defer s.collectionImportMu.Unlock()
	if s.collectionImportJobs == nil {
		s.collectionImportJobs = make(map[string]collectionImportProgress)
	}
	s.pruneCollectionImportProgressLocked(now)
	s.collectionImportJobs[token] = collectionImportProgress{
		ProgressToken: token,
		Phase:         "preparing",
		startedAt:     now,
		updatedAt:     now,
	}
	return token, nil
}

func (s *service) setCollectionImportProgressTotal(token string, total int) {
	if token == "" {
		return
	}
	s.collectionImportMu.Lock()
	defer s.collectionImportMu.Unlock()
	progress, found := s.collectionImportJobs[token]
	if !found {
		return
	}
	progress.TotalFiles = total
	progress.Phase = "parsing"
	progress.updatedAt = time.Now()
	s.collectionImportJobs[token] = progress
}

func (s *service) recordCollectionImportProgress(
	token string,
	result collectionImportEntryResult,
) {
	if token == "" {
		return
	}
	s.collectionImportMu.Lock()
	defer s.collectionImportMu.Unlock()
	progress, found := s.collectionImportJobs[token]
	if !found {
		return
	}
	progress.CompletedFiles++
	if result.err != nil {
		progress.FailedFiles++
	} else {
		progress.SuccessfulFiles++
		progress.SignalCount += len(result.updates)
	}
	progress.updatedAt = time.Now()
	s.collectionImportJobs[token] = progress
}

func (s *service) finishCollectionImportProgress(token string, importErr error) {
	if token == "" {
		return
	}
	now := time.Now()
	s.collectionImportMu.Lock()
	defer s.collectionImportMu.Unlock()
	progress, found := s.collectionImportJobs[token]
	if !found {
		return
	}
	progress.Done = true
	progress.Phase = "complete"
	if importErr != nil {
		progress.Phase = "error"
		progress.Error = importErr.Error()
	}
	progress.DurationMS = now.Sub(progress.startedAt).Milliseconds()
	progress.updatedAt = now
	s.collectionImportJobs[token] = progress
}

func (s *service) collectionImportProgressSnapshot(
	rawToken string,
) (collectionImportProgress, error) {
	token, err := normalizeCollectionImportProgressToken(rawToken)
	if err != nil {
		return collectionImportProgress{}, err
	}
	if token == "" {
		return collectionImportProgress{}, errors.New("collection import progress token is required")
	}
	now := time.Now()
	s.collectionImportMu.Lock()
	defer s.collectionImportMu.Unlock()
	if s.collectionImportJobs == nil {
		return collectionImportProgress{}, errors.New("collection import progress was not found")
	}
	progress, found := s.collectionImportJobs[token]
	if !found || now.Sub(progress.updatedAt) > collectionImportProgressTTL {
		if found {
			delete(s.collectionImportJobs, token)
		}
		return collectionImportProgress{}, errors.New("collection import progress was not found")
	}
	if !progress.Done {
		progress.DurationMS = now.Sub(progress.startedAt).Milliseconds()
	}
	return progress, nil
}

func (s *service) importCollectionFiles(
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
	searchToken string,
	progressToken string,
) (map[string]any, error) {
	startedAt := time.Now()
	search, err := s.cachedCollectionSearch(
		searchToken, rawRootPath, preset, variables, false)
	if err != nil {
		return nil, err
	}
	importEntries := make([]collectionSearchEntry, 0, search.ResultCount)
	formulaCount := 0
	for _, entry := range search.Entries {
		if entry.ImportMode == "formula" && entry.Status == "formula" {
			formulaCount++
		} else if len(entry.Matches) > 0 {
			importEntries = append(importEntries, entry)
		}
	}
	if len(importEntries) == 0 && formulaCount == 0 {
		return nil, errors.New("search did not find any files to import")
	}
	s.setCollectionImportProgressTotal(progressToken, len(importEntries))
	if len(importEntries) == 0 {
		return map[string]any{
			"rootPath": search.RootPath, "preset": preset, "variables": variables,
			"search": search, "files": []map[string]any{}, "updates": []map[string]any{},
			"skippedCount": len(search.Entries) - formulaCount,
			"formulaCount": formulaCount, "workerCount": 0, "parseDurationMs": int64(0),
			"durationMs": time.Since(startedAt).Milliseconds(),
		}, nil
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
				entry := importEntries[index]
				var result collectionImportEntryResult
				if entry.Index < 0 || entry.Index >= len(preset.Paths) {
					result = collectionImportEntryResult{
						err: errors.New("collection rule index is invalid"),
					}
				} else {
					result = s.parseCollectionEntry(
						catalog, search, entry, preset.Paths[entry.Index])
				}
				entryResults[index] = result
				s.recordCollectionImportProgress(progressToken, result)
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
		"skippedCount": len(search.Entries) - len(importEntries) - formulaCount,
		"formulaCount": formulaCount,
		"workerCount":  workerCount, "parseDurationMs": parseDurationMS,
		"durationMs": time.Since(startedAt).Milliseconds(),
	}, nil
}

func (s *service) previewCollectionEntry(
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
	searchToken string,
	ruleIndex int,
	headerRow int,
) (map[string]any, error) {
	if ruleIndex < 0 || ruleIndex >= len(preset.Paths) {
		return nil, errors.New("preview rule index is invalid")
	}
	if headerRow < 1 {
		return nil, errors.New("标题行必须大于或等于 1")
	}
	search, err := s.cachedCollectionSearch(
		searchToken, rawRootPath, preset, variables, false)
	if err != nil {
		return nil, err
	}
	var cachedEntry *collectionSearchEntry
	for index := range search.Entries {
		if search.Entries[index].Index == ruleIndex && len(search.Entries[index].Matches) > 0 {
			cachedEntry = &search.Entries[index]
			break
		}
	}
	if cachedEntry == nil {
		return nil, errors.New("该规则没有可预览的匹配文件")
	}
	runtimeRule := preset.Paths[ruleIndex]
	runtimeRule.Name = cachedEntry.Name
	preparedRule, preparedEntry, err := prepareCollectionEntry(
		runtimeRule, cachedEntry.Matches[0], headerRow)
	if err != nil {
		return nil, err
	}
	preset.Paths[ruleIndex] = effectiveCollectionPresetPath(
		preset.Paths[ruleIndex].UsrGen,
		preparedRule.AutoGen,
	)
	entry := *cachedEntry
	entry.Name = preparedEntry.Name
	entry.HasSeq = preparedEntry.HasSeq
	entry.ImportMode = preparedEntry.ImportMode
	entry.HeaderRow = preparedEntry.HeaderRow
	entry.IndexColumn = preparedEntry.IndexColumn
	entry.Delimiter = preparedEntry.Delimiter
	entry.Parser = preparedEntry.Parser
	entry.Columns = preparedEntry.Columns
	entry.SchemaHash = preparedEntry.SchemaHash
	entry.OutputNames = preparedEntry.OutputNames
	entry.PreviewColumns = preparedEntry.PreviewColumns
	entry.PreviewRows = preparedEntry.PreviewRows
	entry.PreviewTruncated = preparedEntry.PreviewTruncated
	entry.AutoGenChanged = preparedEntry.AutoGenChanged
	if len(entry.Matches) == 1 {
		entry.Status = "matched"
	} else {
		entry.Status = "multiple"
	}
	entry.Message = ""
	return map[string]any{
		"ok": true, "preset": preset, "entry": entry,
	}, nil
}

func (s *service) previewCollectionSingleFile(
	rawRootPath string,
	preset collectionPreset,
	variables map[string]string,
	searchToken string,
	ruleIndex int,
	startLine int,
	lineCount int,
	quickMode ...bool,
) (map[string]any, error) {
	if ruleIndex < 0 || ruleIndex >= len(preset.Paths) {
		return nil, errors.New("单文件预览规则序号无效")
	}
	if startLine == 0 {
		startLine = 1
	}
	if lineCount == 0 {
		lineCount = collectionSinglePreviewLines
	}
	if startLine < 1 {
		return nil, errors.New("起始行必须是大于或等于 1 的整数")
	}
	if lineCount < 1 || lineCount > collectionSinglePreviewMax {
		return nil, fmt.Errorf("显示行数必须介于 1 和 %d 之间", collectionSinglePreviewMax)
	}
	search, err := s.cachedCollectionSearch(
		searchToken, rawRootPath, preset, variables, false)
	if err != nil {
		return nil, err
	}
	var selected *collectionSearchEntry
	for index := range search.Entries {
		if search.Entries[index].Index == ruleIndex && len(search.Entries[index].Matches) > 0 {
			selected = &search.Entries[index]
			break
		}
	}
	if selected == nil {
		return nil, errors.New("该规则没有可预览的匹配文件")
	}
	if selected.ImportMode != "single" {
		return nil, errors.New("只有单波形文件支持文本范围预览")
	}
	match := selected.Matches[0]
	quick := len(quickMode) > 0 && quickMode[0] && startLine == 1
	if quick {
		lines, hasMore, readErr := readCollectionSinglePreviewHead(match.Path, lineCount)
		if readErr != nil {
			return nil, fmt.Errorf("读取文件快速预览失败：%w", readErr)
		}
		sequenceColumnHidden := preset.Paths[ruleIndex].HasSeq
		if sequenceColumnHidden {
			delimiter := preset.Paths[ruleIndex].Delimiter
			if strings.TrimSpace(delimiter) == "" {
				delimiter = selected.Delimiter
			}
			lines = collectionSinglePreviewWithoutSequenceColumn(
				lines, delimiter, match.FileName)
		}
		return map[string]any{
			"ok": true, "index": ruleIndex,
			"path": match.Path, "relativePath": match.RelativePath,
			"totalLines": 0, "totalLinesKnown": false, "startLine": startLine,
			"lineCount": lineCount, "displayedCount": len(lines),
			"hasMore":              hasMore,
			"sequenceColumnHidden": sequenceColumnHidden,
			"lines":                lines,
		}, nil
	}
	indexed, err := s.collectionSinglePreviewIndex(match)
	if err != nil {
		return nil, fmt.Errorf("读取文件行索引失败：%w", err)
	}
	if indexed.totalLines > 0 && startLine > indexed.totalLines {
		return nil, fmt.Errorf("起始行不能超过文件总行数 %d", indexed.totalLines)
	}
	lines, err := readCollectionSinglePreviewRange(indexed, startLine, lineCount)
	if err != nil {
		return nil, fmt.Errorf("读取文件预览失败：%w", err)
	}
	sequenceColumnHidden := preset.Paths[ruleIndex].HasSeq
	if sequenceColumnHidden {
		delimiter := preset.Paths[ruleIndex].Delimiter
		if strings.TrimSpace(delimiter) == "" {
			delimiter = selected.Delimiter
		}
		lines = collectionSinglePreviewWithoutSequenceColumn(
			lines, delimiter, match.FileName)
	}
	return map[string]any{
		"ok": true, "index": ruleIndex,
		"path": match.Path, "relativePath": match.RelativePath,
		"totalLines": indexed.totalLines, "startLine": startLine,
		"lineCount": lineCount, "displayedCount": len(lines),
		"hasMore":              startLine+len(lines)-1 < indexed.totalLines,
		"sequenceColumnHidden": sequenceColumnHidden,
		"lines":                lines,
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
			if errors.Is(err, errNativePathPickerUnavailable) {
				message := "当前 Linux 桌面无法打开原生文件窗口，请直接在页面中输入本地路径"
				if kind == "save-preset" {
					message = "当前 Linux 桌面无法打开保存窗口，请修改页面中的预设路径后再次保存"
				}
				sendJSON(writer, 200, map[string]any{
					"ok": true, "manual": true, "path": initialPath,
					"cancelled": false, "message": message, "detail": err.Error(),
				})
				return
			}
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(writer, 200, map[string]any{
			"ok": true, "path": selected, "cancelled": cancelled,
		})
	case "load":
		document, presetPath, err := loadCollectionPresetDocument(
			stringValue(payload["presetPath"]), s.config.rootDir)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		response := map[string]any{
			"ok": true, "presetPath": presetPath,
			"presetText": document.Text, "presetValid": document.Valid,
		}
		if document.Valid {
			response["preset"] = document.Preset
		} else {
			response["presetError"] = document.PresetError
			response["errorLine"] = document.ErrorLine
			response["errorColumn"] = document.ErrorColumn
		}
		sendJSON(writer, 200, response)
	case "scan-presets":
		result, err := discoverCollectionPresets(
			stringValue(payload["searchPath"]), s.config.rootDir)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(writer, 200, result)
	case "load-discovered":
		document, presetPath, relativePath, err := loadDiscoveredCollectionPresetDocument(
			stringValue(payload["searchPath"]),
			stringValue(payload["relativePath"]),
			s.config.rootDir,
		)
		if err != nil {
			sendJSON(writer, 400, map[string]any{"error": err.Error()})
			return
		}
		response := map[string]any{
			"ok": true, "presetPath": presetPath,
			"relativePath": relativePath, "presetText": document.Text,
			"presetValid": document.Valid,
		}
		if document.Valid {
			response["preset"] = document.Preset
		} else {
			response["presetError"] = document.PresetError
			response["errorLine"] = document.ErrorLine
			response["errorColumn"] = document.ErrorColumn
		}
		sendJSON(writer, 200, response)
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
	case "import-progress":
		progress, err := s.collectionImportProgressSnapshot(
			stringValue(payload["progressToken"]))
		if err != nil {
			sendJSON(writer, 404, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(writer, 200, map[string]any{"ok": true, "progress": progress})
	case "search", "preview", "single-preview", "import":
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
		if action == "preview" {
			result, previewErr := s.previewCollectionEntry(
				stringValue(payload["rootPath"]),
				preset,
				variables,
				stringValue(payload["searchToken"]),
				intValue(payload["index"], -1),
				intValue(payload["headerRow"], 0),
			)
			if previewErr != nil {
				sendJSON(writer, 400, map[string]any{"error": previewErr.Error()})
				return
			}
			sendJSON(writer, 200, result)
			return
		}
		if action == "single-preview" {
			result, previewErr := s.previewCollectionSingleFile(
				stringValue(payload["rootPath"]),
				preset,
				variables,
				stringValue(payload["searchToken"]),
				intValue(payload["index"], -1),
				intValue(payload["startLine"], 1),
				intValue(payload["lineCount"], collectionSinglePreviewLines),
				boolValue(payload["quick"], false),
			)
			if previewErr != nil {
				sendJSON(writer, 400, map[string]any{"error": previewErr.Error()})
				return
			}
			sendJSON(writer, 200, result)
			return
		}
		progressToken, progressErr := s.beginCollectionImportProgress(
			stringValue(payload["progressToken"]))
		if progressErr != nil {
			sendJSON(writer, 400, map[string]any{"error": progressErr.Error()})
			return
		}
		result, importErr := s.importCollectionFiles(
			stringValue(payload["rootPath"]),
			preset,
			variables,
			stringValue(payload["searchToken"]),
			progressToken,
		)
		s.finishCollectionImportProgress(progressToken, importErr)
		if importErr != nil {
			sendJSON(writer, 400, map[string]any{"error": importErr.Error()})
			return
		}
		if progressToken != "" {
			if progress, snapshotErr := s.collectionImportProgressSnapshot(progressToken); snapshotErr == nil {
				result["progress"] = progress
			}
		}
		result["ok"] = true
		sendJSON(writer, 200, result)
	default:
		sendJSON(writer, 400, map[string]any{"error": "unknown collection import action"})
	}
}
