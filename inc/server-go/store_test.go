package main

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func testLibrary(content string) waveLibrary {
	return waveLibrary{
		Kind: libraryKind, Version: 2, LibraryID: "library-test",
		UpdatedAt: isoNow(), Directories: []any{}, RootDocuments: []any{"wave-one"},
		ActiveDocumentName: "wave-one", SelectedDirectoryID: "nav-root",
		Documents: []map[string]any{{
			"name": "wave-one", "content": content, "hscale": 1,
			"waveEditMode": "modify", "revision": 0, "savedAt": isoNow(),
			"custom": "preserved",
		}},
	}
}

func TestSQLiteStoreRoundTripAndRevision(t *testing.T) {
	store := newSQLiteStore()
	filePath := t.TempDir() + "/library.sqlite"
	longDescription := strings.Repeat("说明🙂", documentChunkThreshold/3)
	content := `{"title":"测试","description":` + quotedJSON(longDescription) +
		`,"signal":[{"name":"clk","wave":"p..."}]}`
	if err := store.writeLibrary(filePath, testLibrary(content)); err != nil {
		t.Fatal(err)
	}
	if !store.isLibraryFile(filePath) {
		t.Fatal("written database was not recognized as a wave library")
	}
	summary, err := store.readLibrary(filePath, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Documents) != 1 || summary.Documents[0]["deferred"] != true {
		t.Fatalf("unexpected summary: %#v", summary.Documents)
	}
	if summary.Documents[0]["titleCache"] != "测试" {
		t.Fatalf("title cache was not preserved: %#v", summary.Documents[0])
	}
	full, err := store.readLibrary(filePath, false)
	if err != nil {
		t.Fatal(err)
	}
	if full.Documents[0]["content"] != content || full.Documents[0]["custom"] != "preserved" {
		t.Fatal("full document did not round-trip")
	}

	expected := 0
	result, err := store.updateDocument(filePath, "wave-one", &expected, map[string]any{
		"content": content, "hscale": 2.0, "waveEditMode": "insert",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 200 || intValue(result.Document["revision"], -1) != 1 {
		t.Fatalf("unexpected update result: %#v", result)
	}
	conflict, err := store.updateDocument(filePath, "wave-one", &expected, map[string]any{
		"content": content, "hscale": 3.0, "waveEditMode": "modify",
	})
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Status != 409 {
		t.Fatalf("expected revision conflict, got %#v", conflict)
	}
}

func TestPatchLibraryStateAddsAndDeletesDocuments(t *testing.T) {
	store := newSQLiteStore()
	filePath := t.TempDir() + "/library.sqlite"
	content := `{"title":"One","signal":[]}`
	if err := store.writeLibrary(filePath, testLibrary(content)); err != nil {
		t.Fatal(err)
	}
	newContent := `{"title":"Two","signal":[{"name":"a","wave":"01"}]}`
	result, err := store.patchLibraryState(filePath, map[string]any{
		"directories":         []any{map[string]any{"id": "dir-one", "label": "Group"}},
		"rootDocuments":       []any{"wave-two"},
		"activeDocumentName":  "wave-two",
		"selectedDirectoryId": "dir-one",
		"deletedDocuments":    []any{"wave-one"},
		"documents": []any{map[string]any{
			"name": "wave-two", "content": newContent, "hscale": 1.0,
			"waveEditMode": "modify", "revision": 0,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 200 || len(result.Revisions) != 1 {
		t.Fatalf("unexpected patch result: %#v", result)
	}
	library, err := store.readLibrary(filePath, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(library.Documents) != 1 || library.Documents[0]["name"] != "wave-two" {
		t.Fatalf("unexpected documents after patch: %#v", library.Documents)
	}
	if library.ActiveDocumentName != "wave-two" || library.SelectedDirectoryID != "dir-one" {
		t.Fatalf("library state was not updated: %#v", library)
	}
}

func TestReadingCurrentSchemaDoesNotRewriteDatabase(t *testing.T) {
	filePath := t.TempDir() + "/library.sqlite"
	writer := newSQLiteStore()
	if err := writer.writeLibrary(filePath, testLibrary(`{"title":"Read only","signal":[]}`)); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	reader := newSQLiteStore()
	if _, err = reader.readLibrary(filePath, true); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("reading a current-schema library rewrote the database")
	}
}

func quotedJSON(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}
