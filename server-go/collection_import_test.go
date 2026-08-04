package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func runTestCollectionRegexSearch(
	request collectionRegexSearchRequest,
) (collectionRegexSearchResponse, error) {
	type testRule struct {
		collectionRegexSearchRule
		pattern *regexp.Regexp
	}
	rules := make([]testRule, len(request.Rules))
	groups := make([]collectionRegexMatchGroup, len(request.Rules))
	for index, rule := range request.Rules {
		pattern, err := regexp.Compile(rule.Pattern)
		if err != nil {
			return collectionRegexSearchResponse{}, err
		}
		rules[index] = testRule{collectionRegexSearchRule: rule, pattern: pattern}
		groups[index] = collectionRegexMatchGroup{
			EntryIndex: rule.EntryIndex,
			Paths:      []string{},
		}
	}
	visited := 0
	for _, scanRoot := range request.ScanRoots {
		entries, err := os.ReadDir(scanRoot)
		if err != nil {
			return collectionRegexSearchResponse{}, err
		}
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
				continue
			}
			path := filepath.Join(scanRoot, entry.Name())
			visited++
			if visited > request.MaxVisitedFiles {
				return collectionRegexSearchResponse{}, fmt.Errorf("too many files")
			}
			for index, rule := range rules {
				if !collectionFileInFolder(rule.SearchPath, path) ||
					!rule.pattern.MatchString(entry.Name()) {
					continue
				}
				if len(groups[index].Paths) >= request.MaxMatchesPerRule {
					return collectionRegexSearchResponse{}, fmt.Errorf("too many matches")
				}
				groups[index].Paths = append(groups[index].Paths, path)
			}
		}
	}
	return collectionRegexSearchResponse{
		VisitedFiles: visited,
		Matches:      groups,
	}, nil
}

func collectionPresetValue(
	variables []any,
	paths ...map[string]any,
) map[string]any {
	pathValues := make([]any, len(paths))
	for index, item := range paths {
		pathValues[index] = item
	}
	return map[string]any{
		"vars":  variables,
		"paths": pathValues,
	}
}

func TestCollectionSearchSubstitutesVariables(t *testing.T) {
	root := t.TempDir()
	capture := filepath.Join(root, "capture")
	if err := os.MkdirAll(capture, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"ch_A_10.txt": "0\n1\n",
		"noise.txt":   "0\n",
	} {
		if err := os.WriteFile(filepath.Join(capture, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{"channel", "case"},
		map[string]any{
			"folder":   "capture",
			"grepKeys": `^ch_{channel}_{case}\.txt$`,
			"hasSeq":   false,
			"name":     `{channel}_{case}`,
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(root, root, preset, map[string]string{
		"channel": "A",
		"case":    "10",
	}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.ResultCount != 1 || len(result.Entries) != 1 {
		t.Fatalf("unexpected search result: %#v", result)
	}
	entry := result.Entries[0]
	if entry.Name != "A_10" || entry.Status != "matched" || len(entry.Matches) != 1 {
		t.Fatalf("unexpected search entry: %#v", entry)
	}
	if entry.Matches[0].FileName != "ch_A_10.txt" {
		t.Fatalf("matched %q", entry.Matches[0].FileName)
	}
}

func TestCollectionPresetInfersVariablesFromGrepKeys(t *testing.T) {
	preset, err := normalizeCollectionPreset(map[string]any{
		"paths": []any{
			map[string]any{
				"folder":   ".",
				"grepKeys": `^{channel}_{case}_\d{2}_{slot}\.txt$`,
				"hasSeq":   false,
				"name":     `{channel}_{case}_{slot}`,
			},
			map[string]any{
				"folder":   ".",
				"grepKeys": `^again_{channel}\.txt$`,
				"hasSeq":   false,
				"name":     "again",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"channel", "case", "slot"}
	if len(preset.Vars) != len(expected) {
		t.Fatalf("inferred variables = %#v", preset.Vars)
	}
	for index, name := range expected {
		if preset.Vars[index] != name {
			t.Fatalf("inferred variables = %#v", preset.Vars)
		}
	}
}

func TestCollectionPresetMigratesLegacyAndPersistsAutoGen(t *testing.T) {
	root := t.TempDir()
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^signal\.txt$`,
			"hasSeq": false, "name": "signal",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	if preset.Paths[0].UsrGen.GrepKeys != `^signal\.txt$` ||
		preset.Paths[0].AutoGen.ImportMode != "single" ||
		preset.Paths[0].AutoGen.HasSeq == nil || *preset.Paths[0].AutoGen.HasSeq {
		t.Fatalf("legacy preset was not migrated: %#v", preset.Paths[0])
	}
	presetPath, err := saveCollectionPreset("migrated.json", root, preset)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(presetPath)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err = json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	paths, _ := raw["paths"].([]any)
	path, _ := paths[0].(map[string]any)
	if raw["InnerType"] != collectionPresetInnerType {
		t.Fatalf("saved preset did not include InnerType: %s", data)
	}
	if path["usrGen"] == nil || path["autoGen"] == nil || path["folder"] != nil {
		t.Fatalf("saved preset did not use usrGen/autoGen: %s", data)
	}
}

func TestCollectionPresetDiscoveryFiltersByInnerType(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested", "group")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{"folder": ".", "grepKeys": `^signal\.txt$`, "name": "signal"},
	))
	if err != nil {
		t.Fatal(err)
	}
	validPath, err := saveCollectionPreset(filepath.Join(nested, "valid.json"), root, preset)
	if err != nil {
		t.Fatal(err)
	}
	manualData, err := json.Marshal(collectionPresetValue(
		[]any{},
		map[string]any{"folder": ".", "grepKeys": `^manual\.txt$`, "name": "manual"},
	))
	if err != nil {
		t.Fatal(err)
	}
	manualPath := filepath.Join(root, "manual.json")
	if err = os.WriteFile(manualPath, manualData, 0o600); err != nil {
		t.Fatal(err)
	}
	wrongType := []byte(`{"InnerType":"AnotherTool","vars":[],"paths":[]}`)
	if err = os.WriteFile(filepath.Join(root, "wrong.json"), wrongType, 0o600); err != nil {
		t.Fatal(err)
	}

	discovered, err := discoverCollectionPresets(root, root)
	if err != nil {
		t.Fatal(err)
	}
	if discovered.ResultCount != 1 || len(discovered.Entries) != 1 {
		t.Fatalf("unexpected discovered presets: %#v", discovered)
	}
	wantRelative := filepath.ToSlash(filepath.Join("nested", "group", "valid.json"))
	if discovered.Entries[0].RelativePath != wantRelative ||
		filepath.IsAbs(discovered.Entries[0].RelativePath) {
		t.Fatalf("discovery did not return a relative path: %#v", discovered.Entries[0])
	}
	loaded, loadedPath, relativePath, err := loadDiscoveredCollectionPreset(
		root, wantRelative, root)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(loadedPath, validPath) || relativePath != wantRelative || len(loaded.Paths) != 1 {
		t.Fatalf("unexpected discovered preset load: %q %q %#v", loadedPath, relativePath, loaded)
	}
	if _, _, _, err = loadDiscoveredCollectionPreset(root, "../manual.json", root); err == nil {
		t.Fatal("expected traversal outside the preset search folder to fail")
	}

	manualPreset, _, err := loadCollectionPreset(manualPath, root)
	if err != nil || len(manualPreset.Paths) != 1 {
		t.Fatalf("manual preset without InnerType should still load: %#v %v", manualPreset, err)
	}
}

func TestCollectionTableDetectionIncrementallyMergesColumns(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "capture.csv")
	if err := os.WriteFile(
		sourcePath,
		[]byte("generated table\na,b\n0,1\n1,2\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(map[string]any{
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": `^capture\.csv$`,
			},
			"autoGen": map[string]any{
				"importMode": "table", "headerRow": 2, "delimiter": "comma",
				"columns": []any{
					map[string]any{"source": "a", "enabled": true, "name": "a"},
					map[string]any{
						"source": "b", "enabled": false, "name": "renamed_b",
						"filter": ">=1&&<=2",
					},
					map[string]any{"source": "removed", "enabled": true, "name": "old"},
				},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	entry := result.Entries[0]
	if entry.ImportMode != "table" || entry.HeaderRow != 2 || len(entry.Columns) != 2 {
		t.Fatalf("unexpected table preview: %#v", entry)
	}
	if entry.Columns[1].Source != "b" || entry.Columns[1].Enabled ||
		entry.Columns[1].Name != "renamed_b" || entry.Columns[1].Filter != ">=1&&<=2" {
		t.Fatalf("existing column settings were not preserved: %#v", entry.Columns)
	}
	if entry.SchemaHash == "" || result.Preset.Paths[0].AutoGen.SchemaHash == "" {
		t.Fatal("detected schema was not persisted into autoGen")
	}
	savedPath, err := saveCollectionPreset("detected.json", root, result.Preset)
	if err != nil {
		t.Fatal(err)
	}
	savedPreset, _, err := loadCollectionPreset(savedPath, root)
	if err != nil {
		t.Fatal(err)
	}
	savedColumns := savedPreset.Paths[0].AutoGen.Columns
	if savedPreset.Paths[0].AutoGen.HeaderRow != 2 || len(savedColumns) != 2 ||
		savedColumns[1].Enabled || savedColumns[1].Name != "renamed_b" ||
		savedColumns[1].Filter != ">=1&&<=2" {
		t.Fatalf("saved autoGen was not restored: %#v", savedPreset.Paths[0].AutoGen)
	}

	if err = os.WriteFile(
		sourcePath,
		[]byte("generated table\nb,c\n3,4\n5,6\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	result, err = searchCollectionFiles(
		root, root, result.Preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	columns := result.Entries[0].Columns
	if len(columns) != 2 || columns[0].Source != "b" || columns[0].Enabled ||
		columns[0].Name != "renamed_b" || columns[0].Filter != ">=1&&<=2" ||
		columns[1].Source != "c" ||
		!columns[1].Enabled || columns[1].Name != "c" {
		t.Fatalf("changed table columns were not incrementally merged: %#v", columns)
	}
}

func TestCollectionTableIndexColumnPersistsAndClearsWhenMissing(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "capture.csv")
	if err := os.WriteFile(
		sourcePath,
		[]byte("Sample,SigA\n2,10\n4,20\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(map[string]any{
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": `^capture\.csv$`,
			},
			"autoGen": map[string]any{
				"importMode": "table", "headerRow": 1, "delimiter": "comma",
				"indexColumn": "Sample",
				"columns": []any{
					map[string]any{"source": "Sample", "enabled": true, "name": "Sample"},
					map[string]any{"source": "SigA", "enabled": true, "name": "SigA"},
				},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	entry := result.Entries[0]
	if !result.Ready || entry.IndexColumn != "Sample" ||
		len(entry.OutputNames) != 1 || entry.OutputNames[0] != "SigA" ||
		result.Preset.Paths[0].AutoGen.IndexColumn != "Sample" {
		t.Fatalf("selected index column was not preserved: %#v %#v", entry, result.Preset.Paths[0])
	}
	savedPath, err := saveCollectionPreset("indexed.json", root, result.Preset)
	if err != nil {
		t.Fatal(err)
	}
	saved, _, err := loadCollectionPreset(savedPath, root)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Paths[0].AutoGen.IndexColumn != "Sample" {
		t.Fatalf("saved index column = %q, expected Sample", saved.Paths[0].AutoGen.IndexColumn)
	}

	if err = os.WriteFile(sourcePath, []byte("Tick,SigA\n0,30\n1,40\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err = searchCollectionFiles(
		root, root, result.Preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if result.Entries[0].IndexColumn != "" ||
		result.Preset.Paths[0].AutoGen.IndexColumn != "" {
		t.Fatalf("missing generated index column was not cleared: %#v", result.Preset.Paths[0])
	}
}

func TestCollectionTablePreviewAppliesColumnFilters(t *testing.T) {
	lines := []string{
		"CurSt,Value",
		"0,zero-a",
		"0,zero-b",
		"0,zero-c",
		"0,zero-d",
		"0,zero-e",
		"1,one",
		"2,two",
		"3,three",
	}
	columns, rows, truncated, err := collectionTablePreview(
		lines,
		1,
		"comma",
		[]string{"CurSt", "Value"},
		[]collectionColumnConfig{
			{Source: "CurSt", Enabled: false, Name: "CurSt", Filter: ">=1&&<=2"},
			{Source: "Value", Enabled: true, Name: "Value"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if truncated || len(columns) != 2 || len(rows) != 2 {
		t.Fatalf("unexpected filtered preview shape: %#v %#v", columns, rows)
	}
	if rows[0][0] != "1" || rows[0][1] != "one" ||
		rows[1][0] != "2" || rows[1][1] != "two" {
		t.Fatalf("preview did not apply CurSt filter: %#v", rows)
	}
}

func TestCollectionCSVRedetectsStaleSingleModeAndBuildsPreview(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "SeqMany.csv")
	content := "\n\n\nSigA,SigB,CurSt\n" +
		"0.128411,0.933530,0\n" +
		"0.933530,0.933530,0\n" +
		"1.678996,0.933530,0\n" +
		"1.134207,1.604885,1\n" +
		"1.107732,1.604885,1\n" +
		"1.503390,1.604885,1\n"
	if err := os.WriteFile(sourcePath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(map[string]any{
		"vars": []any{},
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": "SeqMany.*",
			},
			"autoGen": map[string]any{
				"importMode": "single", "delimiter": "comma",
				"parser": "parse_single_column", "hasSeq": false,
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	entry := result.Entries[0]
	if !result.Ready || entry.ImportMode != "table" || entry.HeaderRow != 4 ||
		len(entry.Columns) != 3 || len(entry.PreviewColumns) != 3 ||
		len(entry.PreviewRows) != collectionPreviewRowLimit {
		t.Fatalf("CSV was not redetected as a previewable table: %#v", entry)
	}
	if entry.PreviewColumns[0] != "SigA" || entry.PreviewRows[0][0] != "0.128411" ||
		entry.PreviewRows[0][2] != "0" {
		t.Fatalf("unexpected CSV preview: %#v %#v", entry.PreviewColumns, entry.PreviewRows)
	}
	if result.Preset.Paths[0].AutoGen.ImportMode != "table" ||
		result.Preset.Paths[0].AutoGen.Parser != "parse_table_data" {
		t.Fatalf("table autoGen was not refreshed: %#v", result.Preset.Paths[0].AutoGen)
	}
}

func TestCollectionSearchSignatureIgnoresAutoGenEdits(t *testing.T) {
	preset, err := normalizeCollectionPreset(map[string]any{
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": `^capture\.csv$`,
			},
			"autoGen": map[string]any{},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	before := collectionSearchSignature("root", preset, map[string]string{})
	preset.Paths[0].AutoGen = collectionRuleConfig{
		ImportMode: "table", HeaderRow: 2, Delimiter: "comma",
		Columns: []collectionColumnConfig{{Source: "a", Enabled: false, Name: "renamed"}},
	}
	preset.Paths[0] = effectiveCollectionPresetPath(
		preset.Paths[0].UsrGen, preset.Paths[0].AutoGen)
	after := collectionSearchSignature("root", preset, map[string]string{})
	if before != after {
		t.Fatal("autoGen edits invalidated the cached file search")
	}
}

func TestCollectionSearchSignatureIgnoresHasSeqParsingEdit(t *testing.T) {
	withoutSequence := false
	withSequence := true
	preset := collectionPreset{
		Vars: []string{},
		Paths: []collectionPresetPath{effectiveCollectionPresetPath(
			collectionRuleConfig{
				Folder: ".", GrepKeys: `^signal\.txt$`, Name: "signal",
				ImportMode: "single", HasSeq: &withoutSequence,
			},
			collectionRuleConfig{},
		)},
	}
	before := collectionSearchSignature("root", preset, map[string]string{})
	rule := preset.Paths[0]
	rule.UsrGen.HasSeq = &withSequence
	rule.AutoGen.HasSeq = &withSequence
	preset.Paths[0] = effectiveCollectionPresetPath(rule.UsrGen, rule.AutoGen)
	after := collectionSearchSignature("root", preset, map[string]string{})
	if before != after {
		t.Fatal("hasSeq parsing edit invalidated unchanged file matches")
	}
}

func TestCollectionSingleFilePreviewTracksHasSeqToggle(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "signal.txt")
	content := "seq value\n0 10\n2 20\n"
	if err := os.WriteFile(sourcePath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(map[string]any{
		"vars": []any{},
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": `^signal\.txt$`, "name": "signal",
				"importMode": "single", "hasSeq": false,
			},
			"autoGen": map[string]any{},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	instance := &service{
		config:                 config{rootDir: root},
		collectionSearchCache:  make(map[string]collectionSearchCacheEntry),
		collectionPreviewCache: make(map[string]collectionSinglePreviewIndex),
	}
	result = instance.rememberCollectionSearch(result)

	toggled := result.Preset
	toggled.Paths = append([]collectionPresetPath{}, result.Preset.Paths...)
	rule := toggled.Paths[0]
	withSequence := true
	rule.UsrGen.HasSeq = &withSequence
	rule.AutoGen.HasSeq = &withSequence
	toggled.Paths[0] = effectiveCollectionPresetPath(rule.UsrGen, rule.AutoGen)

	preview, err := instance.previewCollectionSingleFile(
		root, toggled, map[string]string{}, result.SearchToken, 0, 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	lines, ok := preview["lines"].([]collectionSinglePreviewLine)
	if !ok || len(lines) != 3 || lines[0].Text != "value" ||
		lines[1].Text != "10" || lines[2].Text != "20" {
		t.Fatalf("hasSeq preview did not hide the sequence column: %#v", preview["lines"])
	}
	if hidden, _ := preview["sequenceColumnHidden"].(bool); !hidden {
		t.Fatalf("hasSeq preview was not marked as sequence-column hidden: %#v", preview)
	}
	rawPreview, err := instance.previewCollectionSingleFile(
		root, result.Preset, map[string]string{}, result.SearchToken, 0, 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	rawLines, ok := rawPreview["lines"].([]collectionSinglePreviewLine)
	if !ok || len(rawLines) != 3 || rawLines[0].Text != "seq value" ||
		rawLines[1].Text != "0 10" || rawLines[2].Text != "2 20" {
		t.Fatalf("automatic-index preview did not keep the full file: %#v", rawPreview["lines"])
	}
	if hidden, _ := rawPreview["sequenceColumnHidden"].(bool); hidden {
		t.Fatalf("automatic-index preview unexpectedly hid the first column: %#v", rawPreview)
	}
	_, prepared, err := prepareCollectionEntry(
		toggled.Paths[0], result.Entries[0].Matches[0], 0)
	if err != nil {
		t.Fatal(err)
	}
	if !prepared.HasSeq || prepared.Parser != "parse_index_data" {
		t.Fatalf("hasSeq parser was not refreshed: %#v", prepared)
	}
}

func TestCollectionSingleFilePreviewHidesQuotedCSVSequenceColumn(t *testing.T) {
	lines := []collectionSinglePreviewLine{
		{Number: 1, Text: `0,"value,with,commas",tail`},
		{Number: 2, Text: "# preview comment"},
	}
	result := collectionSinglePreviewWithoutSequenceColumn(lines, "comma", "signal.csv")
	if result[0].Text != `"value,with,commas",tail` {
		t.Fatalf("quoted CSV preview was corrupted: %q", result[0].Text)
	}
	if result[1].Text != lines[1].Text {
		t.Fatalf("preview comments should remain unchanged: %q", result[1].Text)
	}
}

func TestCollectionSingleColumnAutoGenCanBeSearchedAgain(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "SeqConvOutC.txt")
	if err := os.WriteFile(sourcePath, []byte("0.128411\n0.933530\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(map[string]any{
		"vars": []any{},
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": "SeqConvOutC.*", "name": "SeqConvOutC",
			},
			"autoGen": map[string]any{},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Ready || first.ResultCount != 1 ||
		first.Preset.Paths[0].AutoGen.Delimiter != "single" {
		t.Fatalf("unexpected first search result: %#v", first)
	}

	encoded, err := json.Marshal(first.Preset)
	if err != nil {
		t.Fatal(err)
	}
	var generatedValue map[string]any
	if err = json.Unmarshal(encoded, &generatedValue); err != nil {
		t.Fatal(err)
	}
	generatedPreset, err := normalizeCollectionPreset(generatedValue)
	if err != nil {
		t.Fatalf("generated single-column preset could not be parsed again: %v", err)
	}
	second, err := searchCollectionFiles(
		root, root, generatedPreset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Ready || second.ResultCount != 1 ||
		len(second.Entries) != 1 || second.Entries[0].Status != "matched" {
		t.Fatalf("second search lost the original match: %#v", second)
	}
}

func TestCollectionAutoGenDelimiterCompatibility(t *testing.T) {
	for _, delimiter := range []string{"single", "unknown", "Comma"} {
		preset, err := normalizeCollectionPreset(map[string]any{
			"paths": []any{map[string]any{
				"usrGen": map[string]any{
					"folder": ".", "grepKeys": "signal.*",
				},
				"autoGen": map[string]any{"delimiter": delimiter},
			}},
		})
		if err != nil {
			t.Fatalf("generated delimiter %q was rejected: %v", delimiter, err)
		}
		if preset.Paths[0].AutoGen.Delimiter != strings.ToLower(delimiter) {
			t.Fatalf("generated delimiter %q was not normalized: %#v", delimiter, preset.Paths[0])
		}
	}

	preset, err := normalizeCollectionPreset(map[string]any{
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": "signal.*",
			},
			"autoGen": map[string]any{"delimiter": "legacy-generated-value"},
		}},
	})
	if err != nil || preset.Paths[0].AutoGen.Delimiter != "" {
		t.Fatalf("unknown generated delimiter was not migrated: %#v %v", preset, err)
	}

	_, err = normalizeCollectionPreset(map[string]any{
		"paths": []any{map[string]any{
			"usrGen": map[string]any{
				"folder": ".", "grepKeys": "signal.*",
				"delimiter": "user-unsupported-value",
			},
			"autoGen": map[string]any{},
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "user-unsupported-value") {
		t.Fatalf("unsupported user delimiter did not produce a useful error: %v", err)
	}
}

func TestCollectionVariablesDefaultMissingAndBlankValuesToZero(t *testing.T) {
	preset := collectionPreset{Vars: []string{"channel", "case", "slot"}}
	values, err := normalizeCollectionVariables(map[string]any{
		"channel": "A",
		"case":    " ",
	}, preset)
	if err != nil {
		t.Fatal(err)
	}
	if values["channel"] != "A" || values["case"] != "0" || values["slot"] != "0" {
		t.Fatalf("normalized variables = %#v", values)
	}
	pattern, err := expandCollectionTemplate(
		`f"^\d{{2}}_{case}_{slot}$"`,
		preset,
		values,
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if pattern != `^\d{2}_0_0$` {
		t.Fatalf("expanded Python f-string = %q", pattern)
	}
}

func TestCollectionSearchDefaultsToFirstSortedMatch(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"ch_A_10.txt", "ch_A_11.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("0\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{"channel"},
		map[string]any{
			"folder":   ".",
			"grepKeys": `^ch_${channel}_.*\.txt$`,
			"hasSeq":   false,
			"name":     "${channel}_signal",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{"channel": "A"},
		runTestCollectionRegexSearch,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.ResultCount != 1 || len(result.Entries) != 1 ||
		result.Entries[0].Status != "multiple" ||
		len(result.Entries[0].Matches) != 2 {
		t.Fatalf("multiple matches should remain importable: %#v", result)
	}
	if result.Entries[0].Matches[0].FileName != "ch_A_10.txt" {
		t.Fatalf("first sorted match = %q", result.Entries[0].Matches[0].FileName)
	}
	if err := validateCachedCollectionFiles(result); err != nil {
		t.Fatalf("multiple-match result should remain valid in the search cache: %v", err)
	}
}

func TestCollectionSearchAllowsMissingRulesWhenAnotherRuleMatches(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "found.txt"),
		[]byte("0\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^missing\.txt$`,
			"hasSeq": false, "name": "missing",
		},
		map[string]any{
			"folder": ".", "grepKeys": `^found\.txt$`,
			"hasSeq": false, "name": "found",
		},
		map[string]any{
			"folder": "not-there", "grepKeys": `^ignored\.txt$`,
			"hasSeq": false, "name": "missing_folder",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.ResultCount != 1 ||
		len(result.Entries) != 3 ||
		result.Entries[0].Status != "missing" ||
		result.Entries[1].Status != "matched" ||
		result.Entries[2].Status != "folder-missing" {
		t.Fatalf("missing rules blocked a matched subset: %#v", result)
	}
	if err = validateCachedCollectionFiles(result); err != nil {
		t.Fatalf("matched subset should remain importable: %v", err)
	}
}

func TestCollectionVariableValuesAreRegexEscaped(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"sig_A+B.txt", "sig_AAB.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("0\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{"id"},
		map[string]any{
			"folder":   ".",
			"grepKeys": `^sig_{id}\.txt$`,
			"hasSeq":   false,
			"name":     `{id}`,
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{"id": "A+B"},
		runTestCollectionRegexSearch,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.Entries[0].Matches[0].FileName != "sig_A+B.txt" {
		t.Fatalf("variable value was treated as regex syntax: %#v", result)
	}
}

func TestCollectionSearchUsesPythonReSyntax(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	root := t.TempDir()
	for _, name := range []string{"capture_AB_AB.txt", "capture_AB_CD.txt"} {
		if err = os.WriteFile(filepath.Join(root, name), []byte("0\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder":   ".",
			"grepKeys": `(?<=^capture_)(?P<word>[A-Z]+)_(?P=word)\.txt$`,
			"hasSeq":   false,
			"name":     "python_re_signal",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root,
		root,
		preset,
		map[string]string{},
		manager.runCollectionRegexSearch,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || len(result.Entries) != 1 ||
		len(result.Entries[0].Matches) != 1 ||
		result.Entries[0].Matches[0].FileName != "capture_AB_AB.txt" {
		t.Fatalf("Python re syntax did not match as expected: %#v", result)
	}
}

func TestCollectionPythonSearchDoesNotEnterSubdirectories(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err = os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(
		filepath.Join(nested, "nested-only.txt"),
		[]byte("1\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^nested-only\.txt$`,
			"hasSeq": false, "name": "nested_only",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root,
		root,
		preset,
		map[string]string{},
		manager.runCollectionRegexSearch,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Ready || result.ResultCount != 0 ||
		len(result.Entries) != 1 || result.Entries[0].Status != "missing" {
		t.Fatalf("Python search entered a subdirectory: %#v", result)
	}
}

func TestCollectionPresetSaveAndLoad(t *testing.T) {
	root := t.TempDir()
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{"case"},
		map[string]any{
			"folder":   "data",
			"grepKeys": `^${case}\.txt$`,
			"hasSeq":   true,
			"name":     "signal_${case}",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	presetPath, err := saveCollectionPreset("collection.json", root, preset)
	if err != nil {
		t.Fatal(err)
	}
	loaded, loadedPath, err := loadCollectionPreset(presetPath, root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(loadedPath) != filepath.Clean(presetPath) ||
		len(loaded.Vars) != 1 || len(loaded.Paths) != 1 ||
		loaded.Paths[0].Name != "signal_${case}" {
		t.Fatalf("unexpected loaded preset: %#v (%s)", loaded, loadedPath)
	}
	raw, err := os.ReadFile(presetPath)
	if err != nil {
		t.Fatal(err)
	}
	var ordered map[string]json.RawMessage
	if err = json.Unmarshal(raw, &ordered); err != nil {
		t.Fatal(err)
	}
	if _, ok := ordered["vars"]; !ok {
		t.Fatal("saved preset is missing vars")
	}
	if _, ok := ordered["paths"]; !ok {
		t.Fatal("saved preset is missing paths")
	}
}

func TestCollectionPresetDocumentLoadsInvalidJSON(t *testing.T) {
	root := t.TempDir()
	presetText := "{\n  \"vars\": [],\n  \"paths\": [}\n"
	presetPath := filepath.Join(root, "invalid.json")
	if err := os.WriteFile(presetPath, []byte(presetText), 0o600); err != nil {
		t.Fatal(err)
	}

	document, loadedPath, err := loadCollectionPresetDocument(presetPath, root)
	if err != nil {
		t.Fatal(err)
	}
	if document.Valid || document.Text != presetText || document.PresetError == "" {
		t.Fatalf("invalid preset was not returned as editable text: %#v", document)
	}
	if document.ErrorLine != 3 || document.ErrorColumn < 1 {
		t.Fatalf("unexpected JSON error location: line %d column %d", document.ErrorLine, document.ErrorColumn)
	}
	if !samePath(loadedPath, presetPath) {
		t.Fatalf("unexpected loaded path: %q", loadedPath)
	}
	if _, _, err = loadCollectionPreset(presetPath, root); err == nil {
		t.Fatal("strict preset loading should still reject invalid JSON")
	}
}

func TestCollectionSearchScansSharedFolderOnce(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{
		"first.txt":   "0\n",
		"second.txt":  "1\n",
		"ignored.log": "2\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^first\.txt$`,
			"hasSeq": false, "name": "first",
		},
		map[string]any{
			"folder": ".", "grepKeys": `^second\.txt$`,
			"hasSeq": false, "name": "second",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.ResultCount != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.ScanCount != 1 {
		t.Fatalf("shared folder was scanned %d times", result.ScanCount)
	}
	if result.VisitedFiles != 3 {
		t.Fatalf("visited %d files, want 3", result.VisitedFiles)
	}
}

func TestCollectionSearchScansNestedFoldersSeparately(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(root, "root.txt"):     "0\n",
		filepath.Join(nested, "nested.txt"): "1\n",
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^root\.txt$`,
			"hasSeq": false, "name": "root",
		},
		map[string]any{
			"folder": "nested", "grepKeys": `^nested\.txt$`,
			"hasSeq": false, "name": "nested",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.ScanCount != 2 || result.VisitedFiles != 2 {
		t.Fatalf("nested folders were not scanned separately: %#v", result)
	}
}

func TestCollectionSearchDoesNotEnterSubdirectories(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(nested, "nested-only.txt"),
		[]byte("1\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^nested-only\.txt$`,
			"hasSeq": false, "name": "root_search",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	if result.Ready || result.ResultCount != 0 ||
		len(result.Entries) != 1 || result.Entries[0].Status != "missing" {
		t.Fatalf("root folder search entered a subdirectory: %#v", result)
	}
}

func TestCollectionSearchCacheValidatesMatchedFile(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "signal.txt")
	if err := os.WriteFile(sourcePath, []byte("0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^signal\.txt$`,
			"hasSeq": false, "name": "signal",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	instance := &service{
		config:                config{rootDir: root},
		collectionSearchCache: make(map[string]collectionSearchCacheEntry),
	}
	result = instance.rememberCollectionSearch(result)
	cached, err := instance.cachedCollectionSearch(
		result.SearchToken, root, preset, map[string]string{})
	if err != nil || cached.ResultCount != 1 {
		t.Fatalf("cached result was not reusable: %#v (%v)", cached, err)
	}
	if err = os.WriteFile(sourcePath, []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = instance.cachedCollectionSearch(
		result.SearchToken, root, preset, map[string]string{}); err == nil {
		t.Fatal("changed matched file reused a stale search result")
	}
}

func TestCollectionSingleFilePreviewUsesSparseLineIndex(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "signal.txt")
	var content strings.Builder
	for line := 1; line <= 600; line++ {
		fmt.Fprintf(&content, "line-%03d\n", line)
	}
	if err := os.WriteFile(sourcePath, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	indexed, err := buildCollectionSinglePreviewIndex(collectionFileMatch{
		Path: sourcePath, RelativePath: "signal.txt", FileName: "signal.txt",
		Size: info.Size(), ModifiedAt: info.ModTime().UTC().Format(timeFormatRFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	if indexed.totalLines != 600 || len(indexed.checkpoints) < 3 {
		t.Fatalf("unexpected sparse index: lines=%d checkpoints=%#v",
			indexed.totalLines, indexed.checkpoints)
	}
	lines, err := readCollectionSinglePreviewRange(indexed, 514, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 5 || lines[0].Number != 514 || lines[0].Text != "line-514" ||
		lines[4].Number != 518 || lines[4].Text != "line-518" {
		t.Fatalf("unexpected sparse preview range: %#v", lines)
	}
}

func TestCollectionSingleFilePreviewReturnsTotalAndRequestedLines(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "signal.txt")
	if err := os.WriteFile(sourcePath, []byte("zero\none\ntwo\nthree\nfour\nsix"), 0o600); err != nil {
		t.Fatal(err)
	}
	preset, err := normalizeCollectionPreset(collectionPresetValue(
		[]any{},
		map[string]any{
			"folder": ".", "grepKeys": `^signal\.txt$`,
			"hasSeq": false, "name": "signal",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(
		root, root, preset, map[string]string{}, runTestCollectionRegexSearch)
	if err != nil {
		t.Fatal(err)
	}
	instance := &service{
		config:                 config{rootDir: root},
		collectionSearchCache:  make(map[string]collectionSearchCacheEntry),
		collectionPreviewCache: make(map[string]collectionSinglePreviewIndex),
	}
	result = instance.rememberCollectionSearch(result)
	preview, err := instance.previewCollectionSingleFile(
		root, result.Preset, map[string]string{}, result.SearchToken, 0, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if intValue(preview["totalLines"], 0) != 6 ||
		intValue(preview["displayedCount"], 0) != 3 ||
		!boolValue(preview["hasMore"], false) {
		t.Fatalf("unexpected single preview metadata: %#v", preview)
	}
	lines, ok := preview["lines"].([]collectionSinglePreviewLine)
	if !ok || len(lines) != 3 || lines[0].Number != 2 || lines[0].Text != "one" ||
		lines[2].Number != 4 || lines[2].Text != "three" {
		t.Fatalf("unexpected single preview lines: %#v", preview["lines"])
	}
	if _, err = instance.previewCollectionSingleFile(
		root, result.Preset, map[string]string{}, result.SearchToken, 0, 7, 1,
	); err == nil || !strings.Contains(err.Error(), "不能超过文件总行数") {
		t.Fatalf("out-of-range preview returned an unclear error: %v", err)
	}
}

func TestCollectionImportProgressTracksCompletedFiles(t *testing.T) {
	instance := &service{
		collectionImportJobs: make(map[string]collectionImportProgress),
	}
	token, err := instance.beginCollectionImportProgress("import-test-1")
	if err != nil {
		t.Fatal(err)
	}
	instance.setCollectionImportProgressTotal(token, 3)
	instance.recordCollectionImportProgress(token, collectionImportEntryResult{
		updates: []map[string]any{{"signal": "I"}, {"signal": "Q"}},
	})
	instance.recordCollectionImportProgress(token, collectionImportEntryResult{
		err: fmt.Errorf("parse failed"),
	})

	progress, err := instance.collectionImportProgressSnapshot(token)
	if err != nil {
		t.Fatal(err)
	}
	if progress.Phase != "parsing" || progress.TotalFiles != 3 ||
		progress.CompletedFiles != 2 || progress.SuccessfulFiles != 1 ||
		progress.FailedFiles != 1 || progress.SignalCount != 2 || progress.Done {
		t.Fatalf("unexpected in-flight import progress: %#v", progress)
	}

	instance.finishCollectionImportProgress(token, nil)
	progress, err = instance.collectionImportProgressSnapshot(token)
	if err != nil {
		t.Fatal(err)
	}
	if !progress.Done || progress.Phase != "complete" || progress.Error != "" {
		t.Fatalf("unexpected completed import progress: %#v", progress)
	}
}

func TestCollectionImportProgressRejectsInvalidToken(t *testing.T) {
	instance := &service{
		collectionImportJobs: make(map[string]collectionImportProgress),
	}
	if _, err := instance.beginCollectionImportProgress("invalid token"); err == nil {
		t.Fatal("invalid progress token was accepted")
	}
	if _, err := instance.collectionImportProgressSnapshot(""); err == nil {
		t.Fatal("empty progress token returned a snapshot")
	}
}
