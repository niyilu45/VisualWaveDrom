package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var restartSessionPattern = regexp.MustCompile(`^server-[0-9a-f-]{36}$`)

type serverRestartState struct {
	Root             string            `json:"root"`
	HTML             string            `json:"html"`
	Library          string            `json:"library"`
	Port             int               `json:"port"`
	WorkingLibraries map[string]string `json:"workingLibraries"`
	LibrarySources   map[string]string `json:"librarySources"`
}

func recoveryProtocolScheme(configuration config) string {
	identity := normalizedPath(canonicalExistingPath(configuration.rootDir)) + "\n" + configuration.htmlName
	hash := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("visualwavedrom-recover-%x", hash[:12])
}

func pathWithin(directory, target string) bool {
	relative, err := filepath.Rel(canonicalExistingPath(directory), canonicalExistingPath(target))
	return err == nil && relative != "." && relative != ".." &&
		!filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// The URL carries only a session identifier. Paths and the original port come
// from our own temporary session record, never from external URL parameters.
func loadServerRestart(configuration *config) (*serverRestartState, error) {
	parsed, err := url.Parse(configuration.openURL)
	if err != nil || !strings.HasPrefix(parsed.Scheme, "visualwavedrom-recover-") {
		return nil, nil
	}
	if parsed.Scheme != recoveryProtocolScheme(*configuration) || parsed.Host != "resume" ||
		parsed.Path != "" || parsed.User != nil {
		return nil, errors.New("recovery link belongs to a different project")
	}
	sessionID := parsed.Query().Get("session")
	if !restartSessionPattern.MatchString(sessionID) {
		return nil, errors.New("invalid recovery session")
	}
	directory := filepath.Join(configuration.tempDir, "sessions", sessionID)
	if !pathWithin(filepath.Join(configuration.tempDir, "sessions"), directory) {
		return nil, errors.New("invalid recovery directory")
	}
	data, err := os.ReadFile(filepath.Join(directory, "restart.json"))
	if err != nil {
		return nil, fmt.Errorf("recovery session is unavailable: %w", err)
	}
	var saved serverRestartState
	if err = json.Unmarshal(data, &saved); err != nil {
		return nil, err
	}
	if !samePath(saved.Root, configuration.rootDir) || saved.HTML != configuration.htmlName ||
		!samePath(saved.Library, configuration.configuredLibrary) || saved.Port < 1 || saved.Port > 65535 {
		return nil, errors.New("recovery session does not match the launcher settings")
	}
	for source, working := range saved.WorkingLibraries {
		if !pathWithin(directory, working) || !strings.EqualFold(filepath.Base(working), "library.sqlite") ||
			(!samePath(source, configuration.configuredLibrary) && !pathWithin(configuration.waveDir, source)) {
			return nil, errors.New("invalid recovery library path")
		}
		if _, err = os.Stat(working); err != nil {
			return nil, fmt.Errorf("recovery library is unavailable: %w", err)
		}
	}
	for _, source := range saved.LibrarySources {
		if saved.WorkingLibraries[normalizedPath(source)] == "" {
			return nil, errors.New("recovery library mapping is incomplete")
		}
	}
	if len(saved.WorkingLibraries) == 0 {
		return nil, errors.New("recovery session contains no libraries")
	}
	configuration.port = saved.Port
	configuration.noOpen = true
	configuration.resumeSession = sessionID
	return &saved, nil
}

func (s *service) persistRestartStateLocked() {
	if s.workingDir == "" || s.config.rootDir == "" {
		return
	}
	sources := make(map[string]string)
	for id, source := range s.librarySources {
		if s.workingLibraries[normalizedPath(source)] != "" {
			sources[id] = source
		}
	}
	err := writeJSONAtomically(filepath.Join(s.workingDir, "restart.json"), serverRestartState{
		Root: s.config.rootDir, HTML: s.config.htmlName, Library: s.config.configuredLibrary,
		Port: s.config.port, WorkingLibraries: s.workingLibraries, LibrarySources: sources,
	})
	if err != nil {
		log.Printf("Could not record server recovery information: %v", err)
	}
}

func (s *service) recoveryDetails() map[string]string {
	if s.config.protocolHandlerPath == "" || s.config.port < 1 {
		return nil
	}
	if _, err := os.Stat(filepath.Join(s.workingDir, "restart.json")); err != nil {
		return nil
	}
	sessionID := filepath.Base(s.workingDir)
	return map[string]string{
		"sessionId": sessionID,
		"url":       recoveryProtocolScheme(s.config) + "://resume?session=" + url.QueryEscape(sessionID),
	}
}
