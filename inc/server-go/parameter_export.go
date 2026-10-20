package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// A new export must not overwrite a file without a second, explicit confirmation.
func saveParameterToml(path, content string, overwrite bool) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if info != nil && !info.Mode().IsRegular() {
		return false, errors.New("保存路径不是普通文件，请选择其他 TOML 文件")
	}
	if info != nil && !overwrite {
		return true, nil
	}
	var file *os.File
	if overwrite {
		file, err = os.CreateTemp(filepath.Dir(path), ".vwd-toml-*.tmp")
	} else {
		file, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, os.ErrExist) {
			return true, nil
		}
	}
	if err != nil {
		return false, err
	}
	name := file.Name()
	completed := false
	defer func() {
		if !completed || overwrite {
			_ = os.Remove(name)
		}
	}()
	if _, err = file.WriteString(content); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil && overwrite {
		if info != nil {
			err = os.Chmod(name, info.Mode().Perm())
		}
		if err == nil {
			err = os.Rename(name, path)
		}
	}
	completed = err == nil
	return false, err
}

func (s *service) handleParameterTomlExport(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Action    string `json:"action"`
		Path      string `json:"path"`
		Content   string `json:"content"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := decodeJSONBody(writer, request, 8*1024*1024, &input); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	if input.Action != "pick" && input.Action != "save" {
		sendJSON(writer, 400, map[string]any{"error": "Invalid TOML export action"})
		return
	}
	path, err := normalizeLocalPathInput(input.Path, s.config.rootDir)
	if err != nil || strings.TrimSpace(input.Path) == "" || !strings.EqualFold(filepath.Ext(path), ".toml") {
		sendJSON(writer, 400, map[string]any{"error": "请指定以 .toml 结尾的保存路径"})
		return
	}
	if input.Action == "pick" {
		selected, canceled, pickErr := pickLocalPathNative("save-toml", path)
		if errors.Is(pickErr, errNativePathPickerUnavailable) {
			sendJSON(writer, 200, map[string]any{"ok": true, "manual": true, "path": path})
			return
		}
		if pickErr != nil {
			sendJSON(writer, 400, map[string]any{"error": pickErr.Error()})
			return
		}
		info, _ := os.Lstat(selected)
		sendJSON(writer, 200, map[string]any{"ok": true, "path": selected, "cancelled": canceled, "exists": info != nil})
		return
	}
	if !utf8.ValidString(input.Content) {
		sendJSON(writer, 400, map[string]any{"error": "TOML 内容必须为有效 UTF-8 文本"})
		return
	}
	exists, err := saveParameterToml(path, input.Content, input.Overwrite)
	if err != nil {
		sendJSON(writer, 400, map[string]any{"error": fmt.Sprintf("无法保存 TOML：%v", err)})
		return
	}
	sendJSON(writer, 200, map[string]any{"ok": true, "path": path, "requiresOverwrite": exists})
}
