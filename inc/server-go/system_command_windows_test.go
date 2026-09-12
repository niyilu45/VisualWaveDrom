//go:build windows

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsSystemCommandsIgnorePath(t *testing.T) {
	directory, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	shadow := t.TempDir()
	for _, name := range []string{"rundll32.exe", "powershell.exe", "cmd.exe"} {
		if err := os.WriteFile(filepath.Join(shadow, name), []byte("not a system executable"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(shadow)
	t.Setenv("PATHEXT", "")
	t.Setenv("SystemRoot", shadow)
	t.Setenv("WINDIR", shadow)
	address := "http://127.0.0.1:4173/Wave%20Example.html?waveId=%E6%B5%8B%E8%AF%95&view=single&libraryId=a%26b"
	for _, searchPath := range []string{"", shadow} {
		t.Setenv("PATH", searchPath)
		for _, item := range []struct {
			name     string
			relative string
			args     []string
		}{
			{"rundll32.exe", "rundll32.exe", []string{"url.dll,FileProtocolHandler", address}},
			{"powershell.exe", filepath.Join("WindowsPowerShell", "v1.0", "powershell.exe"), []string{"-NoProfile", "-Command", "exit 0"}},
			{"cmd.exe", "cmd.exe", []string{"/c", "exit", "7"}},
		} {
			command := systemCommand(item.name, item.args...)
			want := filepath.Join(directory, item.relative)
			if command.Err != nil || !strings.EqualFold(command.Path, want) {
				t.Fatalf("%s resolved to %q (%v), want %q", item.name, command.Path, command.Err, want)
			}
			if !reflect.DeepEqual(command.Args[1:], item.args) {
				t.Fatalf("%s changed arguments: %#v", item.name, command.Args)
			}
			if _, err := os.Stat(command.Path); err != nil {
				t.Fatalf("system executable unavailable: %v", err)
			}
		}
	}
	custom := filepath.Join(shadow, "custom launcher.exe")
	if got, err := systemExecutable(custom); err != nil || got != custom {
		t.Fatalf("explicit launcher path changed: %q, %v", got, err)
	}
}

func TestWindowsSystemCommandsRunWithoutPath(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("PATHEXT", "")
	command := systemCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write('vwd-path-ok')")
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	output, err := command.CombinedOutput()
	if err != nil || string(output) != "vwd-path-ok" {
		t.Fatalf("PowerShell without PATH returned %q: %v", output, err)
	}
	if err := launchBrowserCommand([]string{"cmd.exe", "/c", "exit", "0"}, time.Second); err != nil {
		t.Fatalf("browser launcher command without PATH failed: %v", err)
	}
}
