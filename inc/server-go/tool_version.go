package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const toolReleasePath = "inc/visualwavedrom-release.json"
const toolVersionScript = "inc/visualwavedrom-version.js"

type toolRelease struct {
	App       string            `json:"app"`
	Version   string            `json:"version"`
	HTML      string            `json:"html"`
	Files     map[string]string `json:"files"`
	Launchers map[string]string `json:"launchers"`
}

type toolVersionRecord struct {
	Directory string `json:"directory"`
	Version   string `json:"version"`
	HTML      string `json:"html"`
}

type toolVersionStatus struct {
	Current string               `json:"current"`
	Root    string               `json:"root"`
	Record  toolVersionRecord    `json:"record"`
	State   string               `json:"state"`
	Message string               `json:"message,omitempty"`
	Token   string               `json:"token,omitempty"`
	History []toolHistoryRelease `json:"history,omitempty"`
}

var toolVersionPattern = regexp.MustCompile(`^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$`)
var renameToolFile = os.Rename
var toolLauncherSettings = regexp.MustCompile(`(?mi)^(?:set ")?(HTML_FILE_NAME|WAVE_LIBRARY_RELATIVE_PATH)=[^\r\n]*`)

func toolLauncherHash(data []byte) string {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	normalized := toolLauncherSettings.ReplaceAll(data, []byte("$1=<project-setting>"))
	hash := sha256.Sum256(normalized)
	return hex.EncodeToString(hash[:])
}

func compareToolVersions(a, b string) int {
	aa, bb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 4; i++ {
		av, bv := 0, 0
		if i < len(aa) {
			av, _ = strconv.Atoi(aa[i])
		}
		if i < len(bb) {
			bv, _ = strconv.Atoi(bb[i])
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

func safeToolHTML(name string) bool {
	return filepath.Base(name) == name && !strings.ContainsAny(name, `\/:`) &&
		(strings.HasSuffix(strings.ToLower(name), ".html") || strings.HasSuffix(strings.ToLower(name), ".htm"))
}

func managedToolFile(name, html string) bool {
	if name == html {
		return safeToolHTML(html)
	}
	if strings.ContainsAny(name, `\:`) || strings.HasPrefix(name, "/") || filepath.ToSlash(filepath.Clean(name)) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." || strings.HasPrefix(part, ".") {
			return false
		}
	}
	switch name {
	case "VisualWaveDrom.bat", "VisualWaveDrom.sh", "ReadMe.md", "bin/VisualWaveDrom-server.exe", "bin/VisualWaveDrom-server-linux-amd64", "bin/SHA256SUMS.txt":
		return true
	}
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "inc/") && lower != toolReleasePath &&
		!strings.HasPrefix(lower, "inc/server-go/") && !strings.HasPrefix(lower, "inc/import/scheme/") &&
		!strings.HasPrefix(lower, "inc/import/schemecollection/") && !strings.Contains(lower, "/__pycache__/") &&
		!strings.HasSuffix(lower, ".pyc")
}

// Refuse symlinks/junctions, including parent directories, before touching an installation.
func plainToolPath(name string) error {
	absolute, err := filepath.Abs(name)
	if err != nil {
		return err
	}
	for p := absolute; ; p = filepath.Dir(p) {
		info, e := os.Lstat(p)
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if e == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("linked paths are not supported: %s", p)
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return nil
}

func readToolRelease(root string) (toolRelease, error) {
	var release toolRelease
	file := filepath.Join(root, filepath.FromSlash(toolReleasePath))
	if err := plainToolPath(file); err != nil {
		return release, err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return release, err
	}
	if len(data) > 2*1024*1024 {
		return release, errors.New("release manifest is too large")
	}
	if err = json.Unmarshal(data, &release); err != nil {
		return release, err
	}
	if release.App != appID || !toolVersionPattern.MatchString(release.Version) || !safeToolHTML(release.HTML) || len(release.Files) == 0 {
		return release, errors.New("invalid VisualWaveDrom release manifest")
	}
	for name, hash := range release.Files {
		decoded, e := hex.DecodeString(hash)
		if !managedToolFile(name, release.HTML) || e != nil || len(decoded) != sha256.Size {
			return release, fmt.Errorf("invalid release entry: %s", name)
		}
	}
	for _, required := range []string{release.HTML, toolVersionScript, "bin/VisualWaveDrom-server.exe", "bin/VisualWaveDrom-server-linux-amd64", "VisualWaveDrom.bat", "VisualWaveDrom.sh"} {
		if release.Files[required] == "" {
			return release, fmt.Errorf("release is missing %s", required)
		}
	}
	return release, nil
}

func hashToolFile(file string) (string, error) {
	if err := plainToolPath(file); err != nil {
		return "", err
	}
	info, err := os.Stat(file)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular file: %s", file)
	}
	input, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer input.Close()
	digest := sha256.New()
	// Git may check text files out with CRLF on Windows and LF on Linux.
	switch strings.ToLower(filepath.Ext(file)) {
	case ".js", ".css", ".html", ".htm", ".bat", ".sh", ".json", ".py", ".md", ".txt", ".svg", ".xml":
		data, e := io.ReadAll(input)
		if e != nil {
			return "", e
		}
		_, err = digest.Write(bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n")))
	default:
		_, err = io.Copy(digest, input)
	}
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func toolRecordPath() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, appID, "tool-version.json"), nil
}

func readToolRecord() (toolVersionRecord, error) {
	var record toolVersionRecord
	name, err := toolRecordPath()
	if err != nil {
		return record, err
	}
	data, err := os.ReadFile(name)
	if errors.Is(err, os.ErrNotExist) {
		return record, nil
	}
	if err != nil {
		return record, err
	}
	if err = json.Unmarshal(data, &record); err != nil {
		return record, err
	}
	if !filepath.IsAbs(record.Directory) || (record.Version != "" && !toolVersionPattern.MatchString(record.Version)) || !safeToolHTML(record.HTML) {
		return record, errors.New("invalid system version record; choose the version directory again")
	}
	return record, nil
}

func writeToolRecord(record toolVersionRecord) error {
	name, err := toolRecordPath()
	if err != nil {
		return err
	}
	return writeJSONAtomically(name, record)
}

func lockToolFile(file string, exclusive bool) (func(), error) {
	if err := plainToolPath(file); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return nil, err
	}
	return lockToolFileNative(file, exclusive)
}

func lockToolRecord() (func(), error) {
	file, err := toolRecordPath()
	if err != nil {
		return nil, err
	}
	return lockToolFile(file+".lock", true)
}

func toolInstallationLock(root string, exclusive bool) (func(), error) {
	if !exclusive {
		root = canonicalExistingPath(root)
	}
	unlock, err := lockToolFile(filepath.Join(root, ".tmp", "tool-version.lock"), exclusive)
	if err != nil {
		return nil, fmt.Errorf("directory is in use or not writable; close its BAT/SH and browser windows first: %s (%w)", root, err)
	}
	return unlock, nil
}

func inspectToolVersion(configuration config) toolVersionStatus {
	status := toolVersionStatus{Root: configuration.rootDir, State: "unregistered"}
	local, err := readToolRelease(configuration.rootDir)
	if err != nil {
		status.State = "error"
		status.Message = err.Error()
		return status
	}
	status.Current = local.Version
	record, err := readToolRecord()
	status.Record = record
	if err != nil {
		status.State = "error"
		status.Message = err.Error()
		return status
	}
	if record.Directory == "" {
		return status
	}
	remote, err := readToolRelease(record.Directory)
	if errors.Is(err, os.ErrNotExist) && record.Version == "" {
		status.State = "publish"
		return status
	}
	if err != nil {
		status.State = "unavailable"
		status.Message = err.Error()
		return status
	}
	if compareToolVersions(remote.Version, record.Version) < 0 {
		status.State = "unavailable"
		status.Message = "The recorded latest directory was replaced by an older version."
		return status
	}
	status.Record.Version = remote.Version
	switch compareToolVersions(local.Version, remote.Version) {
	case -1:
		status.State = "upgrade"
	case 0:
		status.State = "equal"
	case 1:
		status.State = "publish"
	}
	return status
}

func validateToolDestination(directory string) (toolVersionRecord, error) {
	record := toolVersionRecord{HTML: "VisualWaveDrom.html"}
	if !filepath.IsAbs(directory) {
		return record, errors.New("please enter an absolute directory path")
	}
	directory = filepath.Clean(directory)
	record.Directory = directory
	if err := plainToolPath(directory); err != nil {
		return record, err
	}
	if release, err := readToolRelease(directory); err == nil {
		record.Version = release.Version
		record.HTML = release.HTML
		return record, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return record, err
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return record, nil
	}
	if err != nil {
		return record, err
	}
	for _, entry := range entries {
		if entry.Name() != ".tmp" {
			return record, errors.New("select an empty folder or a versioned VisualWaveDrom folder")
		}
	}
	return record, nil
}

func copyToolFile(from, to string) error {
	if err := plainToolPath(from); err != nil {
		return err
	}
	if err := plainToolPath(to); err != nil {
		return err
	}
	input, err := os.Open(from)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("release contains a non-regular file")
	}
	if err = os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	mode := info.Mode().Perm()
	if strings.HasSuffix(to, "VisualWaveDrom-server-linux-amd64") || strings.HasSuffix(to, ".sh") {
		mode = 0o755
	}
	output, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err == nil {
		err = closeErr
	}
	return err
}

func mappedToolFile(name string, release toolRelease, html string) string {
	if name == release.HTML {
		return html
	}
	return name
}

func updateToolDirectory(source, target, sourceHTML, targetHTML string) (err error) {
	if samePath(source, target) || pathInside(source, target) || pathInside(target, source) {
		return errors.New("source and destination must be separate, non-nested directories")
	}
	if !safeToolHTML(sourceHTML) || !safeToolHTML(targetHTML) {
		return errors.New("invalid HTML file name")
	}
	if _, err = validateToolDestination(target); err != nil {
		return err
	}
	unlock, err := toolInstallationLock(target, true)
	if err != nil {
		return err
	}
	defer unlock()
	release, err := readToolRelease(source)
	if err != nil {
		return err
	}
	previous, oldErr := readToolRelease(target)
	if oldErr == nil && compareToolVersions(release.Version, previous.Version) <= 0 {
		return errors.New("update source is not newer than destination")
	}
	if oldErr != nil && !errors.Is(oldErr, os.ErrNotExist) {
		return oldErr
	}
	stage, err := os.MkdirTemp(filepath.Join(target, ".tmp"), "tool-update-")
	if err != nil {
		return err
	}
	keepBackup := false
	defer func() {
		if !keepBackup {
			_ = os.RemoveAll(stage)
		}
	}()
	next := toolRelease{App: appID, Version: release.Version, HTML: targetHTML, Files: make(map[string]string), Launchers: release.Launchers}
	names := make([]string, 0, len(release.Files))
	for name := range release.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fromName, toName := mappedToolFile(name, release, sourceHTML), mappedToolFile(name, release, targetHTML)
		from := filepath.Join(source, filepath.FromSlash(fromName))
		to := filepath.Join(target, filepath.FromSlash(toName))
		actual, e := hashToolFile(from)
		if e != nil {
			return e
		}
		launcher := name == "VisualWaveDrom.bat" || name == "VisualWaveDrom.sh"
		var launcherData []byte
		if launcher {
			launcherData, e = os.ReadFile(from)
			if e != nil {
				return e
			}
		}
		if actual != release.Files[name] && (!launcher || toolLauncherHash(launcherData) != release.Launchers[name]) {
			return fmt.Errorf("source was modified or is incomplete: %s; rebuild its release manifest before updating", fromName)
		}
		targetHash, e := hashToolFile(to)
		exists := e == nil
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if launcher {
			if exists {
				oldData, readErr := os.ReadFile(to)
				if readErr != nil {
					return readErr
				}
				// BAT/SH are project configuration and may still be executing this check.
				next.Files[toName] = targetHash
				next.Launchers[name] = toolLauncherHash(oldData)
				continue
			}
			staged := filepath.Join(stage, "new", filepath.FromSlash(toName))
			if e = os.MkdirAll(filepath.Dir(staged), 0o755); e != nil {
				return e
			}
			if e = os.WriteFile(staged, launcherData, 0o755); e != nil {
				return e
			}
			actual, e = hashToolFile(staged)
			if e != nil {
				return e
			}
			release.Files[name] = actual
			next.Files[toName] = actual
			continue
		}
		if exists && targetHash != release.Files[name] {
			previousHash := previous.Files[toName]
			if previousHash == "" && toName == targetHTML {
				previousHash = previous.Files[previous.HTML]
			}
			if previousHash == "" || targetHash != previousHash {
				return fmt.Errorf("local program file was modified; no files were updated: %s", toName)
			}
		}
		next.Files[toName] = release.Files[name]
		if e = copyToolFile(from, filepath.Join(stage, "new", filepath.FromSlash(toName))); e != nil {
			return e
		}
		stagedHash, e := hashToolFile(filepath.Join(stage, "new", filepath.FromSlash(toName)))
		if e != nil {
			return e
		}
		if stagedHash != release.Files[name] {
			return fmt.Errorf("source changed during update: %s", fromName)
		}
	}
	if err = writeJSONAtomically(filepath.Join(stage, "new", filepath.FromSlash(toolReleasePath)), next); err != nil {
		return err
	}
	var install []string
	err = filepath.WalkDir(filepath.Join(stage, "new"), func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		name, _ := filepath.Rel(filepath.Join(stage, "new"), file)
		if filepath.ToSlash(name) != toolReleasePath {
			install = append(install, name)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(install)
	install = append(install, filepath.FromSlash(toolReleasePath))
	type replacedFile struct {
		name      string
		hadOld    bool
		installed bool
	}
	var replaced []replacedFile
	defer func() {
		if err == nil {
			return
		}
		for i := len(replaced) - 1; i >= 0; i-- {
			item := replaced[i]
			to := filepath.Join(target, item.name)
			if item.installed {
				if e := os.Remove(to); e != nil {
					keepBackup = true
					continue
				}
			}
			if item.hadOld {
				if e := os.Rename(filepath.Join(stage, "backup", item.name), to); e != nil {
					keepBackup = true
				}
			}
		}
		if keepBackup {
			err = fmt.Errorf("%w; some files could not be restored; backup retained at %s", err, stage)
		}
	}()
	for _, name := range install {
		to := filepath.Join(target, name)
		if err = plainToolPath(to); err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return err
		}
		item := replacedFile{name: name}
		if _, e := os.Stat(to); e == nil {
			backup := filepath.Join(stage, "backup", name)
			if err = os.MkdirAll(filepath.Dir(backup), 0o755); err != nil {
				return err
			}
			if err = renameToolFile(to, backup); err != nil {
				return err
			}
			item.hadOld = true
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		replaced = append(replaced, item)
		if err = renameToolFile(filepath.Join(stage, "new", name), to); err != nil {
			return err
		}
		replaced[len(replaced)-1].installed = true
	}
	return nil
}

func makeToolRelease(root, html, version string) error {
	if !toolVersionPattern.MatchString(version) || !safeToolHTML(html) {
		return errors.New("release version must be four numeric components, e.g. 2026.9.12.1")
	}
	versionJSON, _ := json.Marshal(map[string]any{"version": version, "history": readToolHistory(root)})
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(toolVersionScript)), append(append([]byte("window.VisualWaveDromVersion = Object.freeze("), versionJSON...), []byte(");\n")...), 0o644); err != nil {
		return err
	}
	release := toolRelease{App: appID, Version: version, HTML: html, Files: make(map[string]string), Launchers: make(map[string]string)}
	for _, directory := range []string{"inc", "bin"} {
		err := filepath.WalkDir(filepath.Join(root, directory), func(file string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, _ := filepath.Rel(root, file)
			rel = filepath.ToSlash(rel)
			if entry.IsDir() {
				if rel == "inc/server-go" || rel == "inc/import/Scheme" || rel == "inc/import/SchemeCollection" || entry.Name() == "__pycache__" || strings.HasPrefix(entry.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !managedToolFile(rel, html) {
				return nil
			}
			hash, e := hashToolFile(file)
			if e != nil {
				return e
			}
			release.Files[rel] = hash
			return nil
		})
		if err != nil {
			return err
		}
	}
	for _, name := range []string{html, "VisualWaveDrom.bat", "VisualWaveDrom.sh", "ReadMe.md"} {
		hash, err := hashToolFile(filepath.Join(root, name))
		if err != nil {
			return err
		}
		release.Files[name] = hash
		if strings.HasSuffix(name, ".bat") || strings.HasSuffix(name, ".sh") {
			data, e := os.ReadFile(filepath.Join(root, name))
			if e != nil {
				return e
			}
			release.Launchers[name] = toolLauncherHash(data)
		}
	}
	return writeJSONAtomically(filepath.Join(root, filepath.FromSlash(toolReleasePath)), release)
}

func (s *service) handleToolVersion(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet {
		status := inspectToolVersion(s.config)
		status.History = toolHistoryBetween(s.config.rootDir, status.Record.Directory, status.Current, status.Record.Version)
		status.Token = s.versionToken
		writer.Header().Set("Cache-Control", "no-store")
		sendJSON(writer, 200, status)
		return
	}
	origin, err := url.Parse(request.Header.Get("Origin"))
	if request.Method != http.MethodPost || err != nil || s.versionToken == "" || origin.Host != request.Host ||
		origin.Scheme != "http" || request.Header.Get("X-VWD-Version-Token") != s.versionToken {
		sendJSON(writer, 403, map[string]string{"error": "version settings require a same-origin confirmation"})
		return
	}
	var input struct {
		Directory string `json:"directory"`
		Pick      bool   `json:"pick"`
	}
	if err = json.NewDecoder(io.LimitReader(request.Body, 16384)).Decode(&input); err != nil {
		sendJSON(writer, 400, map[string]string{"error": err.Error()})
		return
	}
	if input.Pick {
		selected, canceled, pickErr := pickLocalPathNative("tool-folder", input.Directory)
		if pickErr != nil {
			sendJSON(writer, 400, map[string]string{"error": pickErr.Error()})
			return
		}
		sendJSON(writer, 200, map[string]any{"directory": selected, "canceled": canceled})
		return
	}
	record, err := validateToolDestination(strings.TrimSpace(input.Directory))
	if err == nil && !samePath(record.Directory, s.config.rootDir) &&
		(pathInside(record.Directory, s.config.rootDir) || pathInside(s.config.rootDir, record.Directory)) {
		err = errors.New("choose a separate tool folder, not a parent or child of the current installation")
	}
	if err == nil && (samePath(record.Directory, s.config.rootDir) || record.Version == "") {
		record.HTML = s.config.htmlName
	}
	if err == nil {
		unlock, lockErr := lockToolRecord()
		err = lockErr
		if err == nil {
			defer unlock()
			err = writeToolRecord(record)
		}
	}
	if err != nil {
		sendJSON(writer, 400, map[string]string{"error": err.Error()})
		return
	}
	status := inspectToolVersion(s.config)
	status.History = toolHistoryBetween(s.config.rootDir, status.Record.Directory, status.Current, status.Record.Version)
	status.Token = s.versionToken
	sendJSON(writer, 200, status)
}
