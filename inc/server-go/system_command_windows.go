//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func systemExecutable(name string) (string, error) {
	var relative string
	switch strings.ToLower(name) {
	case "rundll32.exe", "cmd.exe":
		relative = name
	case "powershell.exe":
		relative = filepath.Join("WindowsPowerShell", "v1.0", name)
	default:
		return name, nil
	}
	// Use the OS API, not PATH, the current directory, or mutable environment variables.
	directory, err := windows.GetSystemDirectory()
	if err != nil {
		return "", fmt.Errorf("locate Windows system directory for %s: %w", name, err)
	}
	if !filepath.IsAbs(directory) {
		return "", fmt.Errorf("Windows returned an invalid system directory for %s", name)
	}
	return filepath.Join(directory, relative), nil
}
