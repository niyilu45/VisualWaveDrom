package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestOperationsSingleFileIsolationAndTransactionalSave(t *testing.T) {
	configuration := restartTestConfig(t)
	first, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer second.cleanupTemporaryFiles()
	firstPath, _ := first.ensureWorkingLibrary(configuration.configuredLibrary)
	secondPath, _ := second.ensureWorkingLibrary(configuration.configuredLibrary)
	if firstPath == secondPath {
		t.Fatal("sessions share a draft namespace")
	}
	library, err := first.store.readLibrary(firstPath, false)
	if err != nil {
		t.Fatal(err)
	}
	content := `{"signal":[{"name":"vwd_signal","wave":"` + strings.Repeat("1.", 200000) + `"}],"description":"large"}`
	library.Documents[0]["content"] = content
	library.Documents[0]["presentation"] = `{"steps":[{"text":"vwd_annotation"}]}`
	if err = first.store.writeLibrary(firstPath, library); err != nil {
		t.Fatal(err)
	}
	otherSource := filepath.Join(configuration.waveDir, "other", "library.sqlite")
	otherPath, err := first.ensureWorkingLibrary(otherSource)
	if err != nil {
		t.Fatal(err)
	}
	library.LibraryID = "other-library"
	if err = first.store.writeLibrary(otherPath, library); err != nil {
		t.Fatal(err)
	}
	first.registerLibrarySource(library.LibraryID, otherSource)
	first.rememberLibraryName("other")
	if second.readRecentLibraryName() != "other" {
		t.Fatal("recent-library state not shared")
	}
	entries, err := os.ReadDir(configuration.tempDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "operations.sqlite" {
		t.Fatalf("expected one operations file: %v, %v", entries, err)
	}
	if _, err = os.Stat(otherSource); !os.IsNotExist(err) {
		t.Fatal("draft was written to Wave before explicit save")
	}
	if _, err = first.commitWorkingLibrary("other-library"); err != nil {
		t.Fatal(err)
	}
	copy, err := newSQLiteStore().readLibrary(otherSource, false)
	if err != nil || stringValue(copy.Documents[0]["content"]) != content || copy.Documents[0]["presentation"] != library.Documents[0]["presentation"] {
		t.Fatalf("chunked content or metadata changed during save: %v", err)
	}
	// Force a mid-copy failure, after DELETE/metadata copy have run. The
	// committed library must survive intact through SQLite rollback.
	db, _ := first.store.open(otherPath, false)
	_, err = db.Exec("DROP TABLE vwd_document_chunks")
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = first.store.copyLibrary(otherPath, otherSource); err == nil {
		t.Fatal("broken source unexpectedly copied")
	}
	copy, err = newSQLiteStore().readLibrary(otherSource, false)
	if err != nil || stringValue(copy.Documents[0]["content"]) != content {
		t.Fatalf("failed save damaged original library: %v", err)
	}
	first.cleanupTemporaryFiles()
	if !second.store.isLibraryFile(secondPath) {
		t.Fatal("cleaning one session deleted another session")
	}
	if first.store.isLibraryFile(firstPath) {
		t.Fatal("closed session was not cleaned")
	}
	if second.readRecentLibraryName() != "other" {
		t.Fatal("cleanup removed persistent operation settings")
	}
}

func TestOperationsConcurrentSessions(t *testing.T) {
	configuration := restartTestConfig(t)
	services := make([]*service, 3)
	paths := make([]string, len(services))
	for i := range services {
		instance, err := newService(configuration)
		if err != nil {
			t.Fatal(err)
		}
		services[i] = instance
		paths[i], _ = instance.ensureWorkingLibrary(configuration.configuredLibrary)
		defer instance.cleanupTemporaryFiles()
	}
	var group sync.WaitGroup
	for i, instance := range services {
		group.Add(1)
		go func(i int, instance *service) {
			defer group.Done()
			for revision := 0; revision < 12; revision++ {
				result, err := instance.store.updateDocument(paths[i], "default-wave", &revision, map[string]any{
					"content": fmt.Sprintf(`{"signal":[{"name":"session-%d","wave":"1.."}]}`, i),
				})
				if err != nil || result.Status == 409 {
					t.Errorf("concurrent session %d revision %d: %v / %+v", i, revision, err, result)
					return
				}
				instance.rememberLibraryName(fmt.Sprintf("library-%d", i))
			}
		}(i, instance)
	}
	group.Wait()
	for i, instance := range services {
		document, err := instance.store.readDocument(paths[i], "default-wave")
		if err != nil || intValue(document["revision"], 0) != 12 || !strings.Contains(stringValue(document["content"]), fmt.Sprintf("session-%d", i)) {
			t.Fatalf("cross-session corruption: %v / %v", document, err)
		}
	}
}

func TestOperationsMigratesLegacyAndBlocksStaticDownload(t *testing.T) {
	configuration := restartTestConfig(t)
	session := stableID("server")
	directory := filepath.Join(configuration.tempDir, "sessions", session)
	oldPath := filepath.Join(directory, "library-0001", "library.sqlite")
	store := newSQLiteStore()
	library := waveLibrary{Kind: libraryKind, LibraryID: "legacy", Documents: []map[string]any{
		{"name": "legacy-wave", "content": `{"signal":[{"wave":"01"}]}`, "revision": 9},
	}}
	if err := store.writeLibrary(oldPath, library); err != nil {
		t.Fatal(err)
	}
	saved := serverRestartState{Root: configuration.rootDir, HTML: configuration.htmlName, Library: configuration.configuredLibrary,
		Port: 49151, WorkingLibraries: map[string]string{normalizedPath(configuration.configuredLibrary): oldPath},
		LibrarySources: map[string]string{"legacy": configuration.configuredLibrary}}
	if err := writeJSONAtomically(filepath.Join(directory, "restart.json"), saved); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomically(filepath.Join(configuration.tempDir, ".visualwavedrom-state.json"), map[string]any{"recentLibrary": "example"}); err != nil {
		t.Fatal(err)
	}
	configuration.openURL = recoveryProtocolScheme(configuration) + "://resume?session=" + session
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	instance.preserveWorkingFiles = false
	defer instance.cleanupTemporaryFiles()
	reference := instance.libraryPathByID("legacy")
	document, err := store.readDocument(reference, "legacy-wave")
	if err != nil || intValue(document["revision"], 0) != 9 || instance.readRecentLibraryName() != "example" {
		t.Fatalf("legacy migration lost data: %v / %v", document, err)
	}
	entries, _ := os.ReadDir(configuration.tempDir)
	if len(entries) != 1 || entries[0].Name() != "operations.sqlite" {
		t.Fatalf("legacy files remain after successful migration: %v", entries)
	}
	before, _ := os.ReadFile(operationsPath(configuration.tempDir))
	if err = migrateLegacyOperations(configuration); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(operationsPath(configuration.tempDir))
	if !bytes.Equal(before, after) {
		t.Fatal("repeated migration rewrote draft data")
	}
	for _, path := range []string{"/.tmp/operations.sqlite", "/%2etmp/operations.sqlite"} {
		response := httptest.NewRecorder()
		instance.serveStatic(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("temporary database was publicly served: %s", path)
		}
	}
}
