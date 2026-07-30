package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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
			"grepKeys": `^ch_${channel}_${case}\.txt$`,
			"hasSeq":   false,
			"name":     "${channel}_${case}",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(root, root, preset, map[string]string{
		"channel": "A",
		"case":    "10",
	})
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

func TestCollectionSearchRequiresUniqueMatch(t *testing.T) {
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
	result, err := searchCollectionFiles(root, root, preset, map[string]string{"channel": "A"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Ready || len(result.Entries) != 1 ||
		result.Entries[0].Status != "multiple" ||
		len(result.Entries[0].Matches) != 2 {
		t.Fatalf("ambiguous search was not rejected: %#v", result)
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
			"grepKeys": `^sig_${id}\.txt$`,
			"hasSeq":   false,
			"name":     "${id}",
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := searchCollectionFiles(root, root, preset, map[string]string{"id": "A+B"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.Entries[0].Matches[0].FileName != "sig_A+B.txt" {
		t.Fatalf("variable value was treated as regex syntax: %#v", result)
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
