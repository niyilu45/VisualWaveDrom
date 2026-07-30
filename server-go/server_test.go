package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestWaveDocumentHTTPRoundTrip(t *testing.T) {
	root := t.TempDir()
	htmlName := "VisualWaveDrom.html"
	if err := os.WriteFile(filepath.Join(root, htmlName), []byte("<!doctype html><title>test</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	libraryPath := filepath.Join(root, "Wave", "test-library", "library.sqlite")
	configuration := config{
		rootDir: root, htmlName: htmlName, htmlPath: filepath.Join(root, htmlName),
		configuredLibrary: libraryPath, configuredName: "test-library",
		waveDir: filepath.Join(root, "Wave"), statePath: filepath.Join(root, "Wave", ".visualwavedrom-state.json"),
		noOpen: true, port: 0,
	}
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(instance.routes())
	defer server.Close()

	summary := requestJSON(t, http.MethodGet,
		server.URL+"/api/wave-library?summary=1&file=test-library", nil)
	documents := summary["documents"].([]any)
	if len(documents) != 1 {
		t.Fatalf("expected one default document, got %d", len(documents))
	}
	waveID := documents[0].(map[string]any)["name"].(string)
	libraryID := summary["libraryId"].(string)
	loaded := requestJSON(t, http.MethodGet, server.URL+"/api/wave-document?libraryId="+
		urlQueryEscape(libraryID)+"&waveId="+urlQueryEscape(waveID), nil)
	document := loaded["document"].(map[string]any)
	payload := map[string]any{
		"libraryId": libraryID, "waveId": waveID,
		"expectedRevision": document["revision"],
		"document": map[string]any{
			"content": document["content"], "hscale": 1.5, "waveEditMode": "modify",
		},
	}
	saved := requestJSON(t, http.MethodPatch, server.URL+"/api/wave-document", payload)
	if saved["ok"] != true {
		t.Fatalf("unexpected save response: %#v", saved)
	}
	savedDocument := saved["document"].(map[string]any)
	if savedDocument["hscale"] != 1.5 || intValue(savedDocument["revision"], -1) != 1 {
		t.Fatalf("document was not updated: %#v", savedDocument)
	}
}

func requestJSON(t *testing.T, method, address string, payload any) map[string]any {
	t.Helper()
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, address, body)
	if err != nil {
		t.Fatal(err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode >= 400 {
		t.Fatalf("HTTP %d: %#v", response.StatusCode, result)
	}
	return result
}

func urlQueryEscape(value string) string {
	return url.QueryEscape(value)
}
