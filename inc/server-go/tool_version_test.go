package main

import (
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func toolTestRoot(t *testing.T) string {
	t.Helper()
	base, _ := filepath.Abs("../../.tmp")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "version-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	return root
}

func toolTestWrite(t *testing.T, root, name, data string) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func toolTestRelease(t *testing.T, root, version string) {
	t.Helper()
	for name, data := range map[string]string{
		"VisualWaveDrom.html": "<html>" + version + "</html>\n", "ReadMe.md": version,
		"inc/app.js": "// " + version + "\n", "inc/fail.js": version,
		"bin/VisualWaveDrom-server.exe": version, "bin/VisualWaveDrom-server-linux-amd64": version,
		"VisualWaveDrom.bat": "@echo off\r\nset \"HTML_FILE_NAME=VisualWaveDrom.html\"\r\nset \"WAVE_LIBRARY_RELATIVE_PATH=Wave/default.sqlite\"\r\nrem " + version + "\r\n",
		"VisualWaveDrom.sh":  "HTML_FILE_NAME=\"VisualWaveDrom.html\"\nWAVE_LIBRARY_RELATIVE_PATH=\"Wave/default.sqlite\"\n# " + version + "\n",
	} {
		toolTestWrite(t, root, name, data)
	}
	if err := makeToolRelease(root, "VisualWaveDrom.html", version); err != nil {
		t.Fatal(err)
	}
}

func TestToolVersionComparisonAndStatus(t *testing.T) {
	if compareToolVersions("2026.9.12.10", "2026.9.12.9") != 1 || compareToolVersions("2026.10.1.1", "2026.9.30.2") != 1 {
		t.Fatal("numeric comparison failed")
	}
	root := toolTestRoot(t)
	t.Setenv("APPDATA", filepath.Join(root, "system"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "system"))
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	toolTestRelease(t, a, "2026.9.12.1")
	toolTestRelease(t, b, "2026.9.12.2")
	if err := writeToolRecord(toolVersionRecord{Directory: a, Version: "2026.9.12.1", HTML: "VisualWaveDrom.html"}); err != nil {
		t.Fatal(err)
	}
	if got := inspectToolVersion(config{rootDir: b}).State; got != "publish" {
		t.Fatal(got)
	}
	if got := inspectToolVersion(config{rootDir: a}).State; got != "equal" {
		t.Fatal(got)
	}
	if err := checkToolVersionBeforeLaunch(config{rootDir: a, htmlName: "VisualWaveDrom.html"}); err != nil {
		t.Fatal(err)
	}
	if err := writeToolRecord(toolVersionRecord{Directory: b, Version: "2026.9.12.2", HTML: "VisualWaveDrom.html"}); err != nil {
		t.Fatal(err)
	}
	if got := inspectToolVersion(config{rootDir: a}).State; got != "upgrade" {
		t.Fatal(got)
	}
	toolTestRelease(t, b, "2026.9.12.1")
	if got := inspectToolVersion(config{rootDir: a}).State; got != "unavailable" {
		t.Fatal(got)
	}
}

func TestToolUpdatePreservesProjectAndData(t *testing.T) {
	root := toolTestRoot(t)
	source, target := filepath.Join(root, "new"), filepath.Join(root, "old")
	toolTestRelease(t, source, "2026.9.12.2")
	toolTestRelease(t, target, "2026.9.12.1")
	if err := os.Rename(filepath.Join(target, "VisualWaveDrom.html"), filepath.Join(target, "Project.html")); err != nil {
		t.Fatal(err)
	}
	bat, _ := os.ReadFile(filepath.Join(target, "VisualWaveDrom.bat"))
	batText := strings.ReplaceAll(strings.ReplaceAll(string(bat), "VisualWaveDrom.html", "Project.html"), "Wave/default.sqlite", "Wave/my-project.sqlite")
	toolTestWrite(t, target, "VisualWaveDrom.bat", batText)
	for _, name := range []string{"Wave/my-project.sqlite", "inc/import/Scheme/custom.json", "inc/import/SchemeCollection/user.json", ".git/config"} {
		toolTestWrite(t, target, name, "USER DATA")
	}
	toolTestWrite(t, source, "inc/import/Scheme/private.json", "DO NOT DISTRIBUTE")
	// The manifest tolerates the normal Git CRLF/LF checkout difference.
	data, _ := os.ReadFile(filepath.Join(source, "inc/app.js"))
	toolTestWrite(t, source, "inc/app.js", strings.ReplaceAll(string(data), "\n", "\r\n"))
	if err := updateToolDirectory(source, target, "VisualWaveDrom.html", "Project.html"); err != nil {
		t.Fatal(err)
	}
	release, err := readToolRelease(target)
	if err != nil || release.Version != "2026.9.12.2" || release.HTML != "Project.html" {
		t.Fatalf("%+v %v", release, err)
	}
	bat, _ = os.ReadFile(filepath.Join(target, "VisualWaveDrom.bat"))
	if string(bat) != batText {
		t.Fatal(string(bat))
	}
	for _, name := range []string{"Wave/my-project.sqlite", "inc/import/Scheme/custom.json", "inc/import/SchemeCollection/user.json", ".git/config"} {
		data, _ := os.ReadFile(filepath.Join(target, filepath.FromSlash(name)))
		if string(data) != "USER DATA" {
			t.Fatal(name)
		}
	}
	if _, err = os.Stat(filepath.Join(target, "inc/import/Scheme/private.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("copied source user preset")
	}
	destination := filepath.Join(root, "empty")
	if err = updateToolDirectory(target, destination, "Project.html", "Project.html"); err != nil {
		t.Fatal(err)
	}
	if err = updateToolDirectory(source, target, "VisualWaveDrom.html", "Project.html"); err == nil {
		t.Fatal("allowed same-version update")
	}
}

func TestToolUpdateFailureAndLocks(t *testing.T) {
	root := toolTestRoot(t)
	source, target := filepath.Join(root, "new"), filepath.Join(root, "old")
	toolTestRelease(t, source, "2026.9.12.2")
	toolTestRelease(t, target, "2026.9.12.1")
	unlock, err := toolInstallationLock(target, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = updateToolDirectory(source, target, "VisualWaveDrom.html", "VisualWaveDrom.html"); err == nil {
		t.Fatal("updated a running directory")
	}
	unlock()
	originalRename := renameToolFile
	renameToolFile = func(from, to string) error {
		if strings.Contains(filepath.ToSlash(from), "/new/inc/fail.js") {
			return errors.New("injected disk failure")
		}
		return os.Rename(from, to)
	}
	t.Cleanup(func() { renameToolFile = originalRename })
	if err = updateToolDirectory(source, target, "VisualWaveDrom.html", "VisualWaveDrom.html"); err == nil {
		t.Fatal("expected rollback")
	}
	release, err := readToolRelease(target)
	if err != nil || release.Version != "2026.9.12.1" {
		t.Fatal(release, err)
	}
	for name, expected := range release.Files {
		hash, e := hashToolFile(filepath.Join(target, filepath.FromSlash(name)))
		if e != nil || hash != expected {
			t.Fatal("rollback mismatch", name, e)
		}
	}
	renameToolFile = originalRename
	toolTestWrite(t, target, "inc/app.js", "local changes")
	if err = updateToolDirectory(source, target, "VisualWaveDrom.html", "VisualWaveDrom.html"); err == nil || !strings.Contains(err.Error(), "modified") {
		t.Fatal(err)
	}
	for _, name := range []string{"Wave/data.sqlite", "inc/import/Scheme/x.json", "inc/Import/Scheme/x.json", "../outside", "inc/../Wave/x", "C:/data", "inc/server-go/main.go"} {
		if managedToolFile(name, "VisualWaveDrom.html") {
			t.Fatal("unsafe path", name)
		}
	}
	if err = updateToolDirectory(source, filepath.Join(source, "child"), "VisualWaveDrom.html", "VisualWaveDrom.html"); err == nil {
		t.Fatal("allowed nested target")
	}
}

func TestToolVersionAPIConfirmation(t *testing.T) {
	root := toolTestRoot(t)
	t.Setenv("APPDATA", filepath.Join(root, "system"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "system"))
	source := filepath.Join(root, "source")
	toolTestRelease(t, source, "2026.9.12.1")
	service := &service{config: config{rootDir: source, htmlName: "VisualWaveDrom.html"}, versionToken: "secret"}
	body := `{"directory":` + strconv.Quote(filepath.Join(root, "destination")) + `}`
	req := httptest.NewRequest("POST", "http://127.0.0.1:4173/api/tool-version", strings.NewReader(body))
	res := httptest.NewRecorder()
	service.handleToolVersion(res, req)
	if res.Code != 403 {
		t.Fatal(res.Code)
	}
	req = httptest.NewRequest("POST", "http://127.0.0.1:4173/api/tool-version", strings.NewReader(body))
	req.Header.Set("Origin", "http://127.0.0.1:4173")
	req.Header.Set("X-VWD-Version-Token", "secret")
	res = httptest.NewRecorder()
	service.handleToolVersion(res, req)
	if res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	record, err := readToolRecord()
	if err != nil || record.Directory != filepath.Join(root, "destination") {
		t.Fatal(record, err)
	}
	if runtime.GOOS == "windows" && !strings.Contains(res.Body.String(), "publish") {
		t.Fatal(res.Body.String())
	}
}

func TestToolVersionStartupDecisions(t *testing.T) {
	root := toolTestRoot(t)
	t.Setenv("APPDATA", filepath.Join(root, "system"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "system"))
	a, b, c := filepath.Join(root, "recorded"), filepath.Join(root, "newer"), filepath.Join(root, "older")
	toolTestRelease(t, a, "2026.9.12.1")
	toolTestRelease(t, b, "2026.9.12.2")
	toolTestRelease(t, c, "2026.9.12.1")
	prompts := 0
	accepted := true
	ask := func(message string, question bool) (bool, error) {
		if !question {
			t.Fatal(message)
		}
		prompts++
		return accepted, nil
	}
	run := func(directory string) {
		t.Helper()
		if err := checkToolVersionWithPrompt(config{rootDir: directory, htmlName: "VisualWaveDrom.html"}, ask, nil); err != nil {
			t.Fatal(err)
		}
	}
	run(a)
	if prompts != 1 {
		t.Fatal(prompts)
	}
	run(a)
	run(c)
	if prompts != 1 {
		t.Fatal("same version prompted", prompts)
	}
	accepted = false
	run(b)
	if prompts != 2 {
		t.Fatal(prompts)
	}
	record, _ := readToolRecord()
	if record.Version != "2026.9.12.1" {
		t.Fatal("decline changed version")
	}
	accepted = true
	run(b)
	if prompts != 3 {
		t.Fatal(prompts)
	}
	record, _ = readToolRecord()
	if record.Version != "2026.9.12.2" {
		t.Fatal(record)
	}
	run(c)
	if prompts != 4 {
		t.Fatal(prompts)
	}
	updated, _ := readToolRelease(c)
	if updated.Version != "2026.9.12.2" {
		t.Fatal(updated)
	}
	run(c)
	if prompts != 4 {
		t.Fatal("equal version prompted")
	}
}

func TestToolVersionHistoryInterval(t *testing.T) {
	root := toolTestRoot(t)
	history := []toolHistoryRelease{
		{Version: "2026.9.12.1", Notes: []string{"baseline"}},
		{Version: "2026.9.12.2", Commits: []toolCommit{{ID: "abcdef123456", Title: "Second version feature", Body: "Detailed change"}}},
		{Version: "2026.9.12.3", Notes: []string{"Third version feature"}},
	}
	if err := writeJSONAtomically(filepath.Join(root, filepath.FromSlash(toolHistoryPath)), history); err != nil {
		t.Fatal(err)
	}
	interval := toolHistoryBetween(root, "", "2026.9.12.1", "2026.9.12.3")
	if len(interval) != 2 || interval[0].Version != "2026.9.12.3" || interval[1].Version != "2026.9.12.2" {
		t.Fatal(interval)
	}
	text := formatToolHistory(interval)
	if !strings.Contains(text, "abcdef12") || !strings.Contains(text, "Detailed change") || strings.Contains(text, "baseline") {
		t.Fatal(text)
	}
	if len(toolHistoryBetween(root, "", "2026.9.12.3", "2026.9.12.3")) != 3 {
		t.Fatal("full history missing")
	}
}
