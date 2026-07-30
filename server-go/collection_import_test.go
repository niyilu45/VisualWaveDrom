package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
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
