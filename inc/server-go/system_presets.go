package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const defaultSystemPresetPath = "inc/import/SchemeCollection"

type systemPresetSettings struct {
	ConfigPath     string `json:"configPath"`
	BasePath       string `json:"basePath"`
	ConfiguredPath string `json:"configuredPath"`
	SearchPath     string `json:"searchPath"`
	UsingDefault   bool   `json:"usingDefault"`
	Error          string `json:"error,omitempty"`
}

func readSystemPresetSettings(root string) (systemPresetSettings, error) {
	base, err := filepath.Abs(root)
	if err != nil {
		return systemPresetSettings{}, err
	}
	settings := systemPresetSettings{
		ConfigPath: filepath.Join(base, "bin", "config.json"),
		BasePath:   filepath.Clean(base),
	}
	fail := func(reason error) (systemPresetSettings, error) {
		return settings, fmt.Errorf("%s; please edit sysWaveJsonPath in %s", reason, settings.ConfigPath)
	}
	file, err := os.Open(settings.ConfigPath)
	if os.IsNotExist(err) {
		settings.UsingDefault = true
		settings.ConfiguredPath = defaultSystemPresetPath
	} else if err != nil {
		return fail(err)
	} else {
		defer file.Close()
		const limit = 1024 * 1024
		data, readErr := io.ReadAll(io.LimitReader(file, limit+1))
		if readErr != nil {
			return fail(readErr)
		}
		if len(data) > limit {
			return fail(fmt.Errorf("config.json exceeds 1 MiB"))
		}
		var config *struct {
			SysWaveJSONPath string `json:"sysWaveJsonPath"`
		}
		data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
		if err = json.Unmarshal(data, &config); err != nil {
			return fail(err)
		}
		if config == nil || strings.TrimSpace(config.SysWaveJSONPath) == "" {
			return fail(fmt.Errorf("sysWaveJsonPath must be a non-empty path"))
		}
		settings.ConfiguredPath = strings.TrimSpace(config.SysWaveJSONPath)
	}
	// SH/BAT pass their own tool directory as --root, independently of the caller's cwd.
	settings.SearchPath, err = absoluteLocalPathInput(settings.ConfiguredPath, settings.BasePath)
	if err != nil {
		return fail(err)
	}
	return settings, nil
}
