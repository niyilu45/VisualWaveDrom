package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSystemPresetPathsFollowToolRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tool with spaces")
	configPath := filepath.Join(root, "bin", "config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	writeConfig := func(path string) {
		t.Helper()
		data, _ := json.Marshal(map[string]string{"sysWaveJsonPath": path})
		if err := os.WriteFile(configPath, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"presets/nested", "../shared presets", t.TempDir()} {
		writeConfig(path)
		settings, err := readSystemPresetSettings(root)
		if err != nil {
			t.Fatal(err)
		}
		want := path
		if !filepath.IsAbs(want) {
			want = filepath.Join(root, want)
		}
		if settings.SearchPath != filepath.Clean(want) || settings.ConfigPath != configPath || settings.UsingDefault {
			t.Fatalf("unexpected settings for %q: %#v", path, settings)
		}
	}
	if err := os.WriteFile(configPath, []byte("\xef\xbb\xbf"+`{"sysWaveJsonPath":"presets"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if settings, err := readSystemPresetSettings(root); err != nil || settings.SearchPath != filepath.Join(root, "presets") {
		t.Fatalf("BOM config: %#v %v", settings, err)
	}
}

func TestSystemPresetMissingAndInvalidConfig(t *testing.T) {
	root := t.TempDir()
	settings, err := readSystemPresetSettings(root)
	if err != nil || !settings.UsingDefault || settings.SearchPath != filepath.Join(root, filepath.FromSlash(defaultSystemPresetPath)) {
		t.Fatalf("missing config fallback: %#v %v", settings, err)
	}
	if _, err = os.Stat(settings.ConfigPath); !os.IsNotExist(err) {
		t.Fatalf("reading defaults should not create a config: %v", err)
	}
	if err = os.MkdirAll(filepath.Dir(settings.ConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{
		`{`, `null`, `[]`, `{}`, `{"sysWaveJsonPath":null}`,
		`{"sysWaveJsonPath":" "}`, `{"sysWaveJsonPath":123}`,
		strings.Repeat(" ", 1024*1024+1),
	} {
		if err = os.WriteFile(settings.ConfigPath, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		result, readErr := readSystemPresetSettings(root)
		if readErr == nil || !strings.Contains(readErr.Error(), settings.ConfigPath) || !strings.Contains(readErr.Error(), "sysWaveJsonPath") || result.ConfigPath != settings.ConfigPath {
			t.Fatalf("invalid config must identify the setting and file: %#v %v", result, readErr)
		}
	}
}

func TestSystemPresetHTTPReadsFreshConfig(t *testing.T) {
	root := t.TempDir()
	instance := &service{config: config{rootDir: root}}
	configPath := filepath.Join(root, "bin", "config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"first", "second"} {
		data, _ := json.Marshal(map[string]string{"sysWaveJsonPath": path})
		if err := os.WriteFile(configPath, data, 0o600); err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		instance.handleImportCollection(response, httptest.NewRequest(http.MethodPost, "/api/import-wave-collection", strings.NewReader(`{"action":"system-preset-config"}`)))
		var result systemPresetSettings
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.SearchPath != filepath.Join(root, path) {
			t.Fatalf("config action: %d %s", response.Code, response.Body.String())
		}
	}
	if err := os.WriteFile(configPath, []byte("invalid json"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	instance.handleImportCollection(response, httptest.NewRequest(http.MethodPost, "/api/import-wave-collection", strings.NewReader(`{"action":"system-preset-config"}`)))
	var result systemPresetSettings
	if response.Code != http.StatusBadRequest || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.ConfigPath != configPath || result.Error == "" {
		t.Fatalf("invalid config action: %d %s", response.Code, response.Body.String())
	}
}
