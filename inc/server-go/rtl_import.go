package main

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func (s *service) handleRTLImport(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, details string) { sendJSON(w, status, map[string]string{"error": details}) }
	if r.Header.Get("X-VWD-RTL-Import") != "1" {
		fail(http.StatusForbidden, "无效的 RTL 导入请求")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, r.Host) {
			fail(http.StatusForbidden, "RTL 导入只允许从本地服务页面发起")
			return
		}
	}
	switch r.URL.Query().Get("action") {
	case "search-maps", "read-map":
		handleRTLMaps(w, r)
		return
	case "read-use", "save-use":
		s.handleRTLImportUse(w, r)
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if !filepath.IsAbs(path) {
		fail(http.StatusBadRequest, "请输入 RTL TXT 文件的绝对路径")
		return
	}
	path = filepath.Clean(path)
	if !strings.EqualFold(filepath.Ext(path), ".txt") {
		fail(http.StatusBadRequest, "RTL 导入仅支持 .txt 文件")
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		fail(http.StatusBadRequest, "RTL 文件不存在或不是普通文件")
		return
	}
	if info.Size() > importMaxUploadBytes {
		fail(http.StatusRequestEntityTooLarge, "RTL 文本超过 128 MiB，请缩小导出范围")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		fail(http.StatusBadRequest, "无法打开 RTL 文件")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, io.LimitReader(f, info.Size()))
}

func handleRTLMaps(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, message string) { sendJSON(w, status, map[string]string{"error": message}) }
	query := r.URL.Query()
	dir := strings.TrimSpace(query.Get("path"))
	if !filepath.IsAbs(dir) {
		fail(http.StatusBadRequest, "请输入映射搜索目录的绝对路径")
		return
	}
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		fail(http.StatusBadRequest, "无法打开映射搜索目录")
		return
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		fail(http.StatusBadRequest, "映射搜索路径不是目录")
		return
	}
	if query.Get("action") == "read-map" {
		name := filepath.FromSlash(query.Get("name"))
		if filepath.IsAbs(name) || !strings.EqualFold(filepath.Ext(name), ".toml") || !filepath.IsLocal(name) {
			fail(http.StatusBadRequest, "无效的信号映射文件名")
			return
		}
		path, err := filepath.EvalSymlinks(filepath.Join(dir, name))
		if err != nil || !pathInside(dir, path) {
			fail(http.StatusBadRequest, "信号映射文件不存在或不在搜索目录内")
			return
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
			fail(http.StatusBadRequest, "信号映射文件无效或超过 1 MiB")
			return
		}
		f, err := os.Open(path)
		if err != nil {
			fail(http.StatusBadRequest, "无法读取信号映射文件")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.Copy(w, io.LimitReader(f, info.Size()))
		return
	}
	files := make([]string, 0)
	visited := 0
	err = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if r.Context().Err() != nil {
			return r.Context().Err()
		}
		if walkErr != nil {
			return walkErr
		}
		visited++
		if visited > 100000 || len(files) >= 2000 {
			return errors.New("搜索范围过大，请缩小目录范围")
		}
		if entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(entry.Name()), ".toml") {
			name, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(name))
		}
		return nil
	})
	if err != nil {
		fail(http.StatusBadRequest, "映射搜索失败："+err.Error())
		return
	}
	sendJSON(w, http.StatusOK, files)
}

type rtlImportUse struct {
	SourcePath string `json:"sourcePath"`
	Folder     string `json:"folder"`
	Mapping    string `json:"mapping"`
	Rate       string `json:"rate"`
	Unit       string `json:"unit"`
}

func (s *service) handleRTLImportUse(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, message string) { sendJSON(w, status, map[string]string{"error": message}) }
	query := r.URL.Query()
	library, wave := query.Get("libraryId"), query.Get("waveId")
	if library == "" || wave == "" || len(library) > 512 || len(wave) > 512 || strings.ContainsRune(library+wave, '\x00') {
		fail(http.StatusBadRequest, "缺少波形库或波形图标识")
		return
	}
	key := fmt.Sprintf("rtl-import-use:%x", sha256.Sum256([]byte(library+"\x00"+wave)))
	var state rtlImportUse
	if query.Get("action") == "save-use" {
		if err := decodeJSONBody(w, r, 64<<10, &state); err != nil {
			fail(http.StatusBadRequest, "RTL 导入配置无效")
			return
		}
		if err := writeOperationRecord(s.config.tempDir, key, state); err != nil {
			fail(http.StatusInternalServerError, "无法保存 RTL 导入配置")
			return
		}
	} else if err := readOperationRecord(s.config.tempDir, key, &state); err != nil && !errors.Is(err, sql.ErrNoRows) {
		fail(http.StatusInternalServerError, "无法恢复 RTL 导入配置")
		return
	}
	sendJSON(w, http.StatusOK, state)
}
