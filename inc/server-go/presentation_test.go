package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testPresentation = `{"kind":"VisualWaveDromPresentation","version":1,"activeStep":0,"steps":[{"title":"Step 1","notes":"Notes\nline 2","annotations":{"marks":[],"focus":null,"cursorA":1,"cursorB":4}}]}`

func TestPresentationSavePreservesWaveData(t *testing.T) {
	store := newSQLiteStore()
	file := filepath.Join(t.TempDir(), "library.sqlite")
	content := `{"title":"Large","signal":[{"name":"clk","wave":"` + strings.Repeat("p", documentChunkThreshold+100) + `"}]}`
	if err := store.writeLibrary(file, testLibrary(content)); err != nil {
		t.Fatal(err)
	}
	before, _ := store.readDocument(file, "wave-one")
	status, err := store.savePresentation(file, "wave-one", "", testPresentation)
	if err != nil || status != 200 {
		t.Fatalf("save: %d %v", status, err)
	}
	after, _ := store.readDocument(file, "wave-one")
	for _, key := range []string{"content", "revision", "savedAt", "custom", "hscale", "waveEditMode"} {
		if before[key] != after[key] {
			t.Fatalf("presentation save changed waveform field %s", key)
		}
	}
	if after["presentation"] != testPresentation {
		t.Fatal("presentation did not round trip")
	}
	if status, err = store.savePresentation(file, "wave-one", "", testPresentation); err != nil || status != 200 {
		t.Fatalf("idempotent retry: %d %v", status, err)
	}
	updated := strings.Replace(testPresentation, "Step 1", "Step 2", 1)
	if status, _ = store.savePresentation(file, "wave-one", "", updated); status != 409 {
		t.Fatal("a stale presenter overwrote another presenter")
	}
	if status, err = store.savePresentation(file, "wave-one", testPresentation, updated); err != nil || status != 200 {
		t.Fatalf("save newer state: %d %v", status, err)
	}
	before["presentation"] = testPresentation
	before["content"] = `{"title":"Edited wave","signal":[{"wave":"01"}]}`
	zero := 0
	result, err := store.updateDocument(file, "wave-one", &zero, before)
	if err != nil || result.Status != 200 || result.Document["presentation"] != updated {
		t.Fatalf("ordinary wave edit lost the newest steps: %#v %v", result, err)
	}
	result.Document["presentation"] = testPresentation
	patch, err := store.patchLibraryState(file, map[string]any{"documents": []any{result.Document}})
	if err != nil || patch.Status != 200 {
		t.Fatalf("library patch: %#v %v", patch, err)
	}
	after, _ = store.readDocument(file, "wave-one")
	if after["presentation"] != updated {
		t.Fatal("library save lost the newest steps")
	}
}

func TestPresentationAPIAndInvalidData(t *testing.T) {
	waveDir := filepath.Join(t.TempDir(), "Wave")
	directory := filepath.Join(waveDir, "one")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	store := newSQLiteStore()
	if err := store.writeLibrary(filepath.Join(directory, "library.sqlite"), testLibrary(`{"signal":[]}`)); err != nil {
		t.Fatal(err)
	}
	instance := &service{config: config{waveDir: waveDir}, store: store}
	for _, item := range []struct {
		method, wave, value string
		status              int
	}{
		{http.MethodPatch, "wave-one", testPresentation, 200},
		{http.MethodPatch, "missing", testPresentation, 404},
		{http.MethodPatch, "wave-one", `{"version":1}`, 400},
		{http.MethodPatch, "wave-one", `not-json`, 400},
		{http.MethodGet, "wave-one", testPresentation, 405},
	} {
		body, _ := json.Marshal(map[string]any{"libraryId": "library-test", "waveId": item.wave, "expected": "", "presentation": item.value})
		request := httptest.NewRequest(item.method, "/api/wave-presentation", bytes.NewReader(body))
		response := httptest.NewRecorder()
		instance.routes().ServeHTTP(response, request)
		if response.Code != item.status {
			t.Fatalf("%s %s: got %d %s", item.method, item.wave, response.Code, response.Body.String())
		}
	}
}
