package main

import (
	"debug/elf"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxReleaseHasNoDynamicRuntimeDependency(t *testing.T) {
	binaryPath := filepath.Join("..", "bin", "VisualWaveDrom-server-linux-amd64")
	if _, err := os.Stat(binaryPath); errors.Is(err, os.ErrNotExist) {
		t.Skip("Linux release binary has not been built")
	}
	binary, err := elf.Open(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer binary.Close()
	for _, program := range binary.Progs {
		if program.Type == elf.PT_INTERP {
			t.Fatal("Linux release contains a dynamic interpreter")
		}
	}
	libraries, err := binary.ImportedLibraries()
	if err == nil && len(libraries) != 0 {
		t.Fatalf("Linux release imports dynamic libraries: %v", libraries)
	}
}
