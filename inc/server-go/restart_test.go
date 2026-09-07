package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func restartTestConfig(t *testing.T) config {
	t.Helper()
	root := t.TempDir()
	html := filepath.Join(root, "Example.html")
	if err := os.WriteFile(html, []byte("<!doctype html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	return config{
		rootDir: root, htmlName: "Example.html", htmlPath: html,
		configuredLibrary: filepath.Join(root, "Wave", "example", "library.sqlite"),
		configuredName:    "example", waveDir: filepath.Join(root, "Wave"),
		tempDir: filepath.Join(root, ".tmp"), protocolHandlerPath: filepath.Join(root, "VisualWaveDrom.bat"),
		port: 49151, noOpen: true,
	}
}

func TestRestartRestoresDraftRevisionsAndSavesPendingEdits(t *testing.T) {
	configuration := restartTestConfig(t)
	first, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	working, _ := first.ensureWorkingLibrary(configuration.configuredLibrary)
	library, err := first.store.readLibrary(working, false)
	if err != nil {
		t.Fatal(err)
	}
	library.Documents[0]["content"] = `{"signal":[{"name":"before shutdown","wave":"1..."}]}`
	library.Documents[0]["revision"] = 7
	library.Documents = append(library.Documents, map[string]any{
		"name": "single-window", "content": `{"signal":[{"wave":"0..."}]}`, "revision": 3,
	})
	if err = first.store.writeLibrary(working, library); err != nil {
		t.Fatal(err)
	}
	// Catalog entries that have never been edited must not invalidate recovery.
	first.registerLibrarySource("unopened", filepath.Join(configuration.waveDir, "other", "library.sqlite"))
	first.clients["still-open"] = clientLease{lastSeen: time.Now()}
	first.cleanupTemporaryFiles()
	configuration.openURL = first.recoveryDetails()["url"]
	second, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer second.cleanupTemporaryFiles()
	if second.workingDir != first.workingDir || second.config.port != first.config.port || !second.config.noOpen {
		t.Fatal("recovery must keep the original session and port without opening another page")
	}
	if _, err = os.Stat(configuration.configuredLibrary); !os.IsNotExist(err) {
		t.Fatal("recovery wrote the formal Wave library before explicit save")
	}
	server := httptest.NewServer(second.routes())
	defer server.Close()
	for _, item := range []struct {
		name     string
		revision int
		content  string
	}{
		{"default-wave", 7, `{"signal":[{"name":"edited while offline","wave":"10.."}]}`},
		{"single-window", 3, `{"signal":[{"wave":"01.."}]}`},
	} {
		result := requestJSON(t, http.MethodPatch, server.URL+"/api/wave-document", map[string]any{
			"libraryId": library.LibraryID, "waveId": item.name, "expectedRevision": item.revision,
			"document": map[string]any{"name": item.name, "content": item.content},
		})
		if intValue(result["document"].(map[string]any)["revision"], 0) != item.revision+1 {
			t.Fatal("document revision was not preserved across restart")
		}
	}
	stale, _ := json.Marshal(map[string]any{
		"libraryId": library.LibraryID, "waveId": "default-wave", "expectedRevision": 7,
		"document": map[string]any{"content": `{"signal":[]}`},
	})
	request, _ := http.NewRequest(http.MethodPatch, server.URL+"/api/wave-document", bytes.NewReader(stale))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatal("stale edits must not overwrite the other window")
	}
	requestJSON(t, http.MethodPost, server.URL+"/api/wave-library-commit", map[string]any{"libraryId": library.LibraryID})
	saved, err := second.store.readLibrary(configuration.configuredLibrary, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Documents) != 2 || intValue(saved.Documents[0]["revision"], 0) != 8 ||
		intValue(saved.Documents[1]["revision"], 0) != 4 {
		t.Fatalf("recovered documents were not committed together: %#v", saved.Documents)
	}
}

func TestRestartRejectsForeignOrInvalidSession(t *testing.T) {
	configuration := restartTestConfig(t)
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.cleanupTemporaryFiles()
	validURL := instance.recoveryDetails()["url"]
	parsed, _ := url.Parse(validURL)
	for _, badURL := range []string{
		parsed.Scheme + "://resume?session=../../outside",
		parsed.Scheme + "://resume?session=server-00000000-0000-0000-0000-000000000000",
		"visualwavedrom-recover-000000000000000000000000://resume?" + parsed.RawQuery,
	} {
		bad := configuration
		bad.openURL = badURL
		if _, err = newService(bad); err == nil {
			t.Fatalf("accepted invalid recovery: %s", badURL)
		}
	}
	copyConfig := configuration
	copyConfig.rootDir = t.TempDir()
	if recoveryProtocolScheme(copyConfig) == recoveryProtocolScheme(configuration) {
		t.Fatal("different project folders must have distinct recovery handlers")
	}
}

func TestRestartDoesNotSwitchPortsOrDeleteBusyDrafts(t *testing.T) {
	configuration := restartTestConfig(t)
	configuration.protocolHandlerPath = ""
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.cleanupTemporaryFiles()
	listener, err := listenLocal(0)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	instance.config.port = listener.Addr().(*net.TCPAddr).Port
	instance.config.resumeSession = filepath.Base(instance.workingDir)
	instance.preserveWorkingFiles = true
	if err = instance.run(); err == nil {
		t.Fatal("recovery must fail when the original port is unavailable")
	}
	instance.cleanupTemporaryFiles()
	if _, err = os.Stat(instance.workingDir); err != nil {
		t.Fatal("failed recovery deleted the original drafts")
	}
}
