package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestParameterCatalogRoundTripAndConflict(t *testing.T) {
	configuration := restartTestConfig(t)
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.cleanupTemporaryFiles()
	working, _ := instance.ensureWorkingLibrary(configuration.configuredLibrary)
	library, err := instance.store.readLibrary(working, false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(instance.routes())
	defer server.Close()
	address := server.URL + "/api/wave-parameters?libraryId=" + library.LibraryID
	parameters := map[string]any{
		"revision":    0,
		"directories": []any{map[string]any{"id": "folder", "name": "RF", "parentId": ""}},
		"tables":      []any{map[string]any{"id": "table", "name": "Rates", "parentId": "folder", "rows": []any{map[string]any{"name": "rate", "val": "200", "description": "MHz"}}}},
		"presets":     []any{map[string]any{"id": "preset", "name": "Fast", "tableIds": []any{"table"}}},
	}
	result := requestJSON(t, http.MethodPut, address, map[string]any{"expectedRevision": 0, "parameters": parameters})
	if intValue(result["revision"], 0) != 1 {
		t.Fatal("missing catalog revision")
	}
	stale, _ := json.Marshal(map[string]any{"expectedRevision": 0, "parameters": parameters})
	request, _ := http.NewRequest(http.MethodPut, address, bytes.NewReader(stale))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 409 {
		t.Fatalf("stale parameters overwrote catalog: %d", response.StatusCode)
	}
	library.Documents[0]["content"] = `{"title":"Rate {$rate}","parameterTables":["table"],"signal":[{"name":"A","wave":"=.","data":["{$rate}"]}]}`
	// A normal wave save from a stale window must preserve newer parameters.
	requestJSON(t, http.MethodPost, server.URL+"/api/wave-library?libraryId="+library.LibraryID, library)
	loaded := requestJSON(t, http.MethodGet, address, nil)
	if intValue(loaded["revision"], 0) != 1 {
		t.Fatal("wave save replaced parameters")
	}
	if _, err = os.Stat(configuration.configuredLibrary); !os.IsNotExist(err) {
		t.Fatal("parameter edit modified Wave before explicit save")
	}
	if _, err = instance.commitWorkingLibrary(library.LibraryID); err != nil {
		t.Fatal(err)
	}
	formal, err := newSQLiteStore().readLibrary(configuration.configuredLibrary, false)
	if err != nil {
		t.Fatal(err)
	}
	if intValue(formal.Parameters["revision"], 0) != 1 || len(formal.Parameters["tables"].([]any)) != 1 || formal.Documents[0]["content"] != library.Documents[0]["content"] {
		t.Fatal("catalog, order or placeholder text lost on formal save")
	}
	summary, err := instance.store.readLibrary(working, true)
	if err != nil || len(summary.Documents[0]["parameterTables"].([]any)) != 1 {
		t.Fatal("summary lost table bindings", err)
	}
}

func TestParameterExtensionReadsLegacyLibraryWithoutWritingSource(t *testing.T) {
	configuration := restartTestConfig(t)
	store := newSQLiteStore()
	library := waveLibrary{Kind: libraryKind, LibraryID: "legacy-parameters", Documents: []map[string]any{{"name": "one", "content": `{"signal":[]}`}}}
	if err := store.writeLibrary(configuration.configuredLibrary, library); err != nil {
		t.Fatal(err)
	}
	db, _ := store.open(configuration.configuredLibrary, false)
	_, err := db.Exec("DROP TABLE vwd_parameters")
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(configuration.configuredLibrary)
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.cleanupTemporaryFiles()
	after, _ := os.ReadFile(configuration.configuredLibrary)
	if !bytes.Equal(before, after) {
		t.Fatal("legacy library was migrated in Wave before explicit save")
	}
	working, _ := instance.ensureWorkingLibrary(configuration.configuredLibrary)
	copy, err := instance.store.readLibrary(working, true)
	if err != nil || len(copy.Parameters["tables"].([]any)) != 0 {
		t.Fatal("legacy catalog default", err)
	}
}
