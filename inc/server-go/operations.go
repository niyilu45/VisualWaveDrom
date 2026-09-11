package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func operationsPath(tempDir string) string {
	return filepath.Join(tempDir, "operations.sqlite")
}

func openOperations(tempDir string) (*libraryDB, error) {
	db, err := newSQLiteStore().open(operationsPath(tempDir), true)
	if err != nil {
		return nil, err
	}
	_, err = db.Exec(`PRAGMA journal_mode=DELETE;
CREATE TABLE IF NOT EXISTS operation_records (
 key TEXT PRIMARY KEY, value TEXT NOT NULL
);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func readOperationRecord(tempDir, key string, target any) error {
	db, err := openOperations(tempDir)
	if err != nil {
		return err
	}
	defer db.Close()
	var value string
	if err = db.QueryRow("SELECT value FROM operation_records WHERE key=?", key).Scan(&value); err != nil {
		return err
	}
	return json.Unmarshal([]byte(value), target)
}

func writeOperationRecord(tempDir, key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	db, err := openOperations(tempDir)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec("INSERT INTO operation_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, string(data))
	return err
}

func (s *service) deleteOperationSession() error {
	db, err := openOperations(s.config.tempDir)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, reference := range s.workingLibraries {
		file, prefix := libraryLocation(reference)
		if prefix == "" || !samePath(file, operationsPath(s.config.tempDir)) {
			continue
		}
		for _, table := range []string{"vwd_document_chunks", "vwd_documents", "vwd_library", "vwd_parameters"} {
			if _, err = tx.Exec("DROP TABLE IF EXISTS " + prefix + table); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec("DELETE FROM operation_records WHERE key=?", "session:"+filepath.Base(s.workingDir)); err != nil {
		return err
	}
	// Freed SQLite pages are reused by subsequent sessions; no expensive VACUUM
	// or full-file rewrite is needed on every exit.
	return tx.Commit()
}

func validateRestartLibraries(configuration config, directory string, saved serverRestartState, legacy bool) error {
	for source, working := range saved.WorkingLibraries {
		valid := samePath(working, draftLibraryPath(configuration.tempDir, filepath.Base(directory), source))
		if legacy {
			valid = pathWithin(directory, working) && filepath.Base(working) == "library.sqlite"
		}
		if !valid || (!samePath(source, configuration.configuredLibrary) && !pathWithin(configuration.waveDir, source)) {
			return errors.New("invalid recovery library path")
		}
		if !newSQLiteStore().isLibraryFile(working) {
			return errors.New("recovery library is unavailable")
		}
	}
	for _, source := range saved.LibrarySources {
		if saved.WorkingLibraries[normalizedPath(source)] == "" {
			return errors.New("recovery library mapping is incomplete")
		}
	}
	if len(saved.WorkingLibraries) == 0 {
		return errors.New("recovery session contains no libraries")
	}
	return nil
}

func migrateLegacySession(configuration config, directory string) error {
	data, err := os.ReadFile(filepath.Join(directory, "restart.json"))
	if err != nil {
		return err
	}
	var saved serverRestartState
	if err = json.Unmarshal(data, &saved); err != nil {
		return err
	}
	if !samePath(saved.Root, configuration.rootDir) {
		return errors.New("legacy session belongs to a different project")
	}
	legacyConfig := configuration
	legacyConfig.configuredLibrary = saved.Library
	// An old executable may still be editing its separate database. Do not
	// migrate/delete it while any listener occupies its recorded server port.
	if saved.Port > 0 {
		connection, dialErr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(saved.Port)), 100*time.Millisecond)
		if dialErr == nil {
			connection.Close()
			return errors.New("legacy session is still running; migration deferred")
		}
	}
	if err = validateRestartLibraries(legacyConfig, directory, saved, true); err != nil {
		return err
	}
	session := filepath.Base(directory)
	var existing serverRestartState
	recordErr := readOperationRecord(configuration.tempDir, "session:"+session, &existing)
	if recordErr != nil && !errors.Is(recordErr, sql.ErrNoRows) {
		return recordErr
	}
	oldPaths := make([]string, 0, len(saved.WorkingLibraries))
	store := newSQLiteStore()
	for source, oldPath := range saved.WorkingLibraries {
		reference := draftLibraryPath(configuration.tempDir, session, source)
		if recordErr == nil {
			if existing.WorkingLibraries[source] != reference || !store.isLibraryFile(reference) {
				return errors.New("incomplete migrated session; legacy files retained")
			}
		} else if !store.isLibraryFile(reference) {
			if err = store.copyLibrary(oldPath, reference); err != nil {
				return err
			}
		}
		oldPaths = append(oldPaths, oldPath)
		saved.WorkingLibraries[source] = reference
	}
	if recordErr != nil {
		if err = writeOperationRecord(configuration.tempDir, "session:"+session, saved); err != nil {
			return err
		}
	}
	// Only known migrated files are removed. Unknown files/backups and live
	// sessions are retained rather than recursively deleting recovery data.
	for _, path := range oldPaths {
		if err = os.Remove(path); err != nil {
			return err
		}
		_ = os.Remove(filepath.Dir(path))
	}
	_ = os.Remove(filepath.Join(directory, "restart.json"))
	_ = os.Remove(directory)
	return nil
}

func migrateLegacyOperations(configuration config) error {
	db, err := openOperations(configuration.tempDir)
	if err != nil {
		return err
	}
	db.Close()
	legacyState := configuration.statePath
	if legacyState == "" {
		legacyState = filepath.Join(configuration.tempDir, ".visualwavedrom-state.json")
	}
	if data, readErr := os.ReadFile(legacyState); readErr == nil {
		var state map[string]any
		if json.Unmarshal(data, &state) == nil {
			err = readOperationRecord(configuration.tempDir, "recent-library", &map[string]any{})
			if errors.Is(err, sql.ErrNoRows) {
				err = writeOperationRecord(configuration.tempDir, "recent-library", state)
			}
			if err != nil {
				return err
			}
			if pathWithin(configuration.tempDir, legacyState) {
				_ = os.Remove(legacyState)
			}
		}
	}
	sessions := filepath.Join(configuration.tempDir, "sessions")
	entries, err := os.ReadDir(sessions)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && restartSessionPattern.MatchString(entry.Name()) {
			if err = migrateLegacySession(configuration, filepath.Join(sessions, entry.Name())); err != nil {
				log.Printf("Temporary session %s retained: %v", entry.Name(), err)
			}
		}
	}
	_ = os.Remove(sessions)
	return nil
}

func readRestartRecord(configuration config, session string) (serverRestartState, error) {
	var saved serverRestartState
	err := readOperationRecord(configuration.tempDir, "session:"+session, &saved)
	if err != nil {
		return saved, fmt.Errorf("recovery session is unavailable: %w", err)
	}
	return saved, nil
}
