package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
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

func TestLegacyLibraryReadsAndCopiesWithoutChunkTable(t *testing.T) {
	for _, version := range []int{1, 2} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			root := t.TempDir()
			source, target := root+"/old.sqlite", root+"/new.sqlite"
			library := testLibrary(`{"title":"Legacy","signal":[{"name":"data","wave":"2...","data":["old value"]}]}`)
			library.Parameters = map[string]any{"revision": 3, "tables": []any{map[string]any{"id": "old", "name": "Parameters", "rows": []any{map[string]any{"name": "N", "val": "8"}}}}, "directories": []any{}, "presets": []any{}}
			writer := newSQLiteStore()
			if err := writer.writeLibrary(source, library); err != nil {
				t.Fatal(err)
			}
			db, err := writer.open(source, false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec("DROP TABLE vwd_document_chunks; PRAGMA user_version=" + fmt.Sprint(version)); err != nil {
				t.Fatal(err)
			}
			db.Close()
			before, err := os.ReadFile(source)
			if err != nil {
				t.Fatal(err)
			}
			reader := newSQLiteStore()
			if err = reader.copyLibrary(source, target); err != nil {
				t.Fatalf("copy legacy library: %v", err)
			}
			for _, file := range []string{source, target} {
				info, err := reader.getLibraryInfo(file)
				if err != nil || info.DocumentCount != 1 {
					t.Fatalf("legacy index: %#v, %v", info, err)
				}
				loaded, err := reader.readLibrary(file, false)
				if err != nil {
					t.Fatal(err)
				}
				if len(loaded.Documents) != 1 || loaded.Documents[0]["content"] != library.Documents[0]["content"] {
					t.Fatal("legacy waveform content changed")
				}
				if !reflect.DeepEqual(loaded.Parameters, cloneJSONValue(library.Parameters, nil)) {
					t.Fatal("legacy parameters changed")
				}
				document, err := reader.readDocument(file, "wave-one")
				if err != nil || document["content"] != library.Documents[0]["content"] {
					t.Fatalf("legacy document: %#v, %v", document, err)
				}
			}
			after, err := os.ReadFile(source)
			if err != nil {
				t.Fatal(err)
			}
			if sha256.Sum256(before) != sha256.Sum256(after) {
				t.Fatal("opening/copying a legacy library modified its source file")
			}
			if err = reader.copyLibrary(target, source); err != nil {
				t.Fatalf("save back to legacy source: %v", err)
			}
			if _, err = reader.readDocument(source, "wave-one"); err != nil {
				t.Fatalf("read saved legacy document: %v", err)
			}
		})
	}
}

func TestDisplayLibraryRestoresOnlyMissingReferencedDocuments(t *testing.T) {
	root := t.TempDir()
	source, working := root+"/source.sqlite", root+"/working.sqlite"
	store := newSQLiteStore()
	library := testLibrary(`{"title":"Original","signal":[{"name":"clk","wave":"p..."}]}`)
	library.RootDocuments = []any{}
	library.Directories = []any{map[string]any{"id": "group", "label": "Group", "documents": []any{"wave-one", "wave-two"}}}
	library.Documents = append(library.Documents, map[string]any{"name": "wave-two", "content": `{"signal":[{"wave":"01"}]}`})
	if err := store.writeLibrary(source, library); err != nil {
		t.Fatal(err)
	}
	if err := store.copyLibrary(source, working); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	current := `{"title":"Unsaved local edit","signal":[]}`
	if _, err = store.updateDocument(working, "wave-one", nil, map[string]any{"content": current}); err != nil {
		t.Fatal(err)
	}
	db, err := store.open(working, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DELETE FROM vwd_documents WHERE name='wave-two'"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	instance := &service{store: store}
	loaded, err := instance.readDisplayLibrary(source, working, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Documents) != 2 || loaded.Documents[0]["content"] != current || loaded.Documents[1]["content"] != library.Documents[1]["content"] {
		t.Fatal("missing waveform was not restored without losing local edits")
	}
	if !reflect.DeepEqual(loaded.Directories, cloneJSONValue(library.Directories, nil)) {
		t.Fatal("directory assignments changed")
	}
	if _, err = store.patchLibraryState(working, map[string]any{"deletedDocuments": []any{"wave-two"}, "directories": []any{map[string]any{"id": "group", "label": "Group", "documents": []any{"wave-one"}}}}); err != nil {
		t.Fatal(err)
	}
	loaded, err = instance.readDisplayLibrary(source, working, true)
	if err != nil || len(loaded.Documents) != 1 {
		t.Fatalf("intentional deletion was restored: %#v, %v", loaded, err)
	}
	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("draft recovery changed the original source")
	}
}
