package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// External copies may share an embedded ID. A path-scoped session ID keeps
// their drafts, window messages and save destinations separate.
func externalLibraryID(path string) string {
	return fmt.Sprintf("library-path-%x", sha256.Sum256([]byte(normalizedPath(canonicalExistingPath(path)))))
}

func (s *service) isDefaultLibraryPath(path string) bool {
	return samePath(path, s.config.configuredLibrary) || samePath(filepath.Dir(filepath.Dir(path)), s.config.waveDir) && filepath.Base(path) == "library.sqlite"
}

func registeredExternalLibraries(configuration config) map[string]string {
	paths := make(map[string]string)
	if configuration.tempDir == "" {
		return paths
	}
	if _, err := os.Stat(operationsPath(configuration.tempDir)); err != nil {
		return paths
	}
	_ = readOperationRecord(configuration.tempDir, "external-libraries", &paths)
	for id, path := range paths {
		if !filepath.IsAbs(path) || id != externalLibraryID(path) || !strings.EqualFold(filepath.Ext(path), ".sqlite") {
			delete(paths, id)
		}
	}
	return paths
}

func (s *service) externalLibraryIdentity(path string) string {
	id := externalLibraryID(path)
	s.draftMu.Lock()
	defer s.draftMu.Unlock()
	if samePath(s.librarySources[id], path) {
		return id
	}
	return ""
}

func (s *service) registerExternalLibrary(path string) error {
	id := externalLibraryID(path)
	s.draftMu.Lock()
	defer s.draftMu.Unlock()
	paths := registeredExternalLibraries(s.config)
	paths[id] = path
	if err := writeOperationRecord(s.config.tempDir, "external-libraries", paths); err != nil {
		return err
	}
	s.librarySources[id] = path
	s.persistRestartStateLocked()
	return nil
}

func (s *service) libraryEntry(path, identity string) (libraryListItem, error) {
	info, err := s.store.getLibraryInfo(path)
	if err != nil {
		return libraryListItem{}, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return libraryListItem{}, err
	}
	if identity == "" {
		identity = info.LibraryID
	}
	return libraryListItem{Name: s.libraryNameFromPath(path), LibraryID: identity,
		Path: path, DocumentCount: info.DocumentCount, MtimeMS: float64(stat.ModTime().UnixNano()) / 1e6}, nil
}

func (s *service) searchLibraryDirectory(directory string) ([]libraryListItem, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	result := make([]libraryListItem, 0)
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			path = filepath.Join(path, "library.sqlite")
		}
		if !strings.EqualFold(filepath.Ext(path), ".sqlite") {
			continue
		}
		path = canonicalExistingPath(path)
		item, err := s.libraryEntry(path, "")
		if err != nil {
			continue
		}
		if s.isDefaultLibraryPath(path) {
			s.registerLibrarySource(item.LibraryID, path)
		} else {
			if err = s.registerExternalLibrary(path); err != nil {
				return nil, err
			}
			item.LibraryID = externalLibraryID(path)
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].MtimeMS > result[j].MtimeMS })
	return result, nil
}

func (s *service) handleLibrarySearch(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Directory string `json:"directory"`
	}
	if err := decodeJSONBody(writer, request, 64*1024, &input); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	directory, err := normalizeLocalPathInput(input.Directory, s.config.rootDir)
	if err == nil && strings.TrimSpace(input.Directory) == "" {
		directory = s.config.waveDir
	}
	var libraries []libraryListItem
	if err == nil {
		libraries, err = s.searchLibraryDirectory(directory)
	}
	if err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	sendJSON(writer, 200, map[string]any{"ok": true, "directory": directory, "libraries": libraries})
}

func (s *service) handleLibraryPathPicker(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Kind        string `json:"kind"`
		InitialPath string `json:"initialPath"`
	}
	if err := decodeJSONBody(writer, request, 64*1024, &input); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	if input.Kind != "library-folder" && input.Kind != "save-library" {
		sendJSON(writer, 400, map[string]any{"error": "Invalid library picker"})
		return
	}
	if input.InitialPath == "" {
		input.InitialPath = s.config.waveDir
	}
	path, canceled, err := pickLocalPathNative(input.Kind, input.InitialPath)
	if errors.Is(err, errNativePathPickerUnavailable) {
		sendJSON(writer, 200, map[string]any{"ok": true, "manual": true})
		return
	}
	if err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	sendJSON(writer, 200, map[string]any{"ok": true, "path": path, "cancelled": canceled})
}

func (s *service) handleLibrarySaveAs(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		LibraryID string `json:"libraryId"`
		Path      string `json:"path"`
	}
	if err := decodeJSONBody(writer, request, 64*1024, &input); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	path, err := normalizeLocalPathInput(input.Path, s.config.rootDir)
	if err != nil || strings.TrimSpace(input.Path) == "" || !strings.EqualFold(filepath.Ext(path), ".sqlite") {
		sendJSON(writer, 400, map[string]any{"error": "请选择 .sqlite 文件路径"})
		return
	}
	s.libraryMu.Lock()
	defer s.libraryMu.Unlock()
	working := s.libraryPathByID(input.LibraryID)
	if working == "" || !s.store.isLibraryFile(working) {
		sendJSON(writer, 404, map[string]any{"error": "源波形库不存在"})
		return
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	// Never replace an existing/open library behind another editing window.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		sendJSON(writer, 409, map[string]any{"error": "目标文件已存在或无法创建，请选择新的文件名"})
		return
	}
	file.Close()
	if err = s.store.copyLibraryWithIdentity(working, path, stableID("library")); err != nil {
		os.Remove(path)
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	path = canonicalExistingPath(path)
	identity := ""
	if !s.isDefaultLibraryPath(path) {
		if err = s.registerExternalLibrary(path); err != nil {
			sendJSON(writer, 500, map[string]any{"error": "文件已保存，但登记路径失败：" + err.Error()})
			return
		}
		identity = externalLibraryID(path)
	}
	item, err := s.libraryEntry(path, identity)
	if err != nil {
		sendJSON(writer, 500, map[string]any{"error": err.Error()})
		return
	}
	s.registerLibrarySource(item.LibraryID, path)
	sendJSON(writer, 200, map[string]any{"ok": true, "libraryId": item.LibraryID, "file": item.Name, "path": path})
}
