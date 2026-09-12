//go:build windows

package main

import (
	"fmt"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

func TestProtocolRegistryWithoutPath(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("PATHEXT", "")
	// The isolated key is not under Software\Classes, so no URL association changes.
	path := fmt.Sprintf(`Software\VisualWaveDrom-Protocol-Test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	root, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, subkey := range []string{`sample\shell\open\command`, `sample\shell\open`, `sample\shell`, `sample\DefaultIcon`, `sample`} {
			if err := registry.DeleteKey(root, subkey); err != nil && err != registry.ErrNotExist {
				t.Errorf("cleanup %s: %v", subkey, err)
			}
		}
		root.Close()
		if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil {
			t.Errorf("cleanup test root: %v", err)
		}
	})
	for _, handler := range []string{`D:\Wave tool\VisualWaveDrom.bat`, "D:\\Wave \u6d4b\u8bd5\\Updated.bat"} {
		icon := `"D:\Wave tool\Wave.html",0`
		command := fmt.Sprintf(`"%s" "%%1"`, handler)
		if err := writeProtocolRegistry(root, "sample", icon, command); err != nil {
			t.Fatal(err)
		}
		for _, want := range []struct{ path, name, value string }{
			{"sample", "", "URL:VisualWaveDrom Protocol"},
			{"sample", "URL Protocol", ""},
			{`sample\DefaultIcon`, "", icon},
			{`sample\shell\open\command`, "", command},
		} {
			key, err := registry.OpenKey(root, want.path, registry.QUERY_VALUE)
			if err != nil {
				t.Fatal(err)
			}
			value, kind, err := key.GetStringValue(want.name)
			key.Close()
			if err != nil || kind != registry.SZ || value != want.value {
				t.Fatalf("%s/%s: got %q (%d), error %v; want %q", want.path, want.name, value, kind, err, want.value)
			}
		}
	}
}

func TestProtocolRegistryReportsWriteFailure(t *testing.T) {
	if err := writeProtocolRegistry(registry.Key(0), "sample", "", ""); err == nil {
		t.Fatal("invalid registry handle must report an error")
	}
}
