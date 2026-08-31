//go:build !windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func graphicalPickerCommand(kind, initialPath string) (string, []string, bool) {
	initial := strings.TrimSpace(initialPath)
	for _, program := range []string{"zenity", "yad", "kdialog"} {
		executable, err := exec.LookPath(program)
		if err != nil {
			continue
		}
		if program == "kdialog" {
			switch kind {
			case "folder":
				return executable, []string{
					"--getexistingdirectory", initial, "--title", "选择波形数据文件夹",
				}, true
			case "preset":
				return executable, []string{
					"--getopenfilename", initial, "*.json|JSON presets",
					"--title", "选择预设集合 JSON",
				}, true
			case "save-preset":
				return executable, []string{
					"--getsavefilename", initial, "*.json|JSON presets",
					"--title", "保存预设集合 JSON",
				}, true
			}
		}
		args := []string{"--file-selection"}
		switch kind {
		case "folder":
			args = append(args, "--directory", "--title=选择波形数据文件夹")
			if initial != "" {
				args = append(args, "--filename="+filepath.Clean(initial)+string(os.PathSeparator))
			}
		case "preset":
			args = append(
				args,
				"--title=选择预设集合 JSON",
				"--file-filter=JSON presets | *.json",
			)
			if initial != "" {
				args = append(args, "--filename="+initial)
			}
		case "save-preset":
			args = append(
				args,
				"--save",
				"--confirm-overwrite",
				"--title=保存预设集合 JSON",
				"--file-filter=JSON presets | *.json",
			)
			if initial != "" {
				args = append(args, "--filename="+initial)
			}
		}
		return executable, args, true
	}
	return "", nil, false
}

func pickLocalPathNative(kind, initialPath string) (string, bool, error) {
	switch kind {
	case "folder", "preset", "save-preset":
	default:
		return "", false, fmt.Errorf("unsupported path picker kind %q", kind)
	}
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return "", false, nativePathPickerUnavailable(
			"no graphical desktop was detected; paste the local path into the input instead",
		)
	}
	executable, args, available := graphicalPickerCommand(kind, initialPath)
	if !available {
		return "", false, nativePathPickerUnavailable(
			"no supported file picker was found; install zenity, yad, or kdialog, or paste the path",
		)
	}
	command := exec.Command(executable, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	selected := strings.TrimSpace(strings.TrimPrefix(stdout.String(), "\ufeff"))
	detail := strings.TrimSpace(stderr.String())
	if err != nil {
		if nativePathPickerSessionFailure(detail) {
			return "", false, nativePathPickerUnavailable(detail)
		}
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 1 && selected == "" {
			return "", true, nil
		}
		if detail == "" {
			detail = err.Error()
		}
		return "", false, fmt.Errorf("path picker failed: %s", detail)
	}
	return selected, selected == "", nil
}
