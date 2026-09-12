//go:build windows

package main

import (
	"fmt"
	"log"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func (s *service) registerPlatformProtocol(handler string) {
	if !strings.EqualFold(filepath.Ext(handler), ".bat") || strings.Contains(handler, `"`) {
		log.Printf("Protocol handler BAT not found: %s", handler)
		return
	}
	command := fmt.Sprintf(`"%s" "%%1"`, handler)
	icon := `"` + s.config.htmlPath + `",0`
	schemes := []string{s.activeScheme, recoveryProtocolScheme(s.config)}
	if s.activeScheme != protocolScheme {
		schemes = append(schemes, protocolScheme)
	}
	for _, scheme := range schemes {
		if err := writeProtocolRegistry(registry.CURRENT_USER, `Software\Classes\`+scheme, icon, command); err != nil {
			log.Printf("Could not register the VisualWaveDrom URL protocol %s: %v; the editor can still be opened from the server URL.", scheme, err)
			return
		}
	}
}

// Use the per-user registry directly; PATH and external utilities are not required.
func writeProtocolRegistry(root registry.Key, keyPath, icon, command string) error {
	values := []struct{ path, name, value string }{
		{keyPath, "", "URL:VisualWaveDrom Protocol"},
		{keyPath, "URL Protocol", ""},
		{keyPath + `\DefaultIcon`, "", icon},
		{keyPath + `\shell\open\command`, "", command},
	}
	for _, value := range values {
		key, _, err := registry.CreateKey(root, value.path, registry.SET_VALUE)
		if err != nil {
			return fmt.Errorf("open registry key %q: %w", value.path, err)
		}
		err = key.SetStringValue(value.name, value.value)
		closeErr := key.Close()
		if err != nil {
			return fmt.Errorf("write registry key %q: %w", value.path, err)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
