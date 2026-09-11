package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// A draft reference names tables inside operations.sqlite, not a disk file.
func draftLibraryPath(tempDir, session, source string) string {
	hash := sha256.Sum256([]byte(session + "\n" + normalizedPath(source)))
	return filepath.Join(tempDir, "operations.sqlite", "@draft", fmt.Sprintf("%x", hash))
}

func libraryLocation(reference string) (file, prefix string) {
	parent := filepath.Dir(reference)
	file = filepath.Dir(parent)
	id := filepath.Base(reference)
	decoded, err := hex.DecodeString(id)
	if filepath.Base(parent) == "@draft" && filepath.Base(file) == "operations.sqlite" && err == nil && len(decoded) == 32 {
		return file, "draft_" + id + "_"
	}
	return reference, ""
}

// Only application-owned SQL templates pass through here. Values are always
// bound separately; the namespace is a SHA-256 identifier, never user SQL.
type libraryDB struct {
	*sql.DB
	prefix string
}

func librarySQL(query, prefix string) string {
	if prefix == "" {
		return query
	}
	return strings.ReplaceAll(query, "vwd_", prefix+"vwd_")
}

func (db *libraryDB) Exec(query string, args ...any) (sql.Result, error) {
	return db.DB.Exec(librarySQL(query, db.prefix), args...)
}

func (db *libraryDB) Query(query string, args ...any) (*sql.Rows, error) {
	return db.DB.Query(librarySQL(query, db.prefix), args...)
}

func (db *libraryDB) QueryRow(query string, args ...any) *sql.Row {
	return db.DB.QueryRow(librarySQL(query, db.prefix), args...)
}

type libraryTx struct {
	*sql.Tx
	prefix string
}

func (db *libraryDB) Begin() (*libraryTx, error) {
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, err
	}
	return &libraryTx{Tx: tx, prefix: db.prefix}, nil
}

func (tx *libraryTx) Exec(query string, args ...any) (sql.Result, error) {
	return tx.Tx.Exec(librarySQL(query, tx.prefix), args...)
}

func (tx *libraryTx) QueryRow(query string, args ...any) *sql.Row {
	return tx.Tx.QueryRow(librarySQL(query, tx.prefix), args...)
}

// SQLite copies the existing indexed rows/chunks without parsing large JSON
// documents or materializing a second library-sized object in Go memory.
func (s *sqliteStore) copyLibrary(source, target string) error {
	if err := s.ensureSchema(target); err != nil {
		return err
	}
	db, err := s.open(target, true)
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err = db.Exec(parameterSchemaSQL); err != nil {
		return err
	}
	sourceFile, sourcePrefix := libraryLocation(source)
	if _, err = db.DB.Exec("ATTACH DATABASE ? AS incoming", sourceFile); err != nil {
		return err
	}
	defer db.DB.Exec("DETACH DATABASE incoming")
	var hasParameters int
	if err = db.DB.QueryRow("SELECT COUNT(*) FROM incoming.sqlite_master WHERE type='table' AND name=?", sourcePrefix+"vwd_parameters").Scan(&hasParameters); err != nil {
		return err
	}
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM main." + db.prefix + "vwd_parameters"); err != nil {
		return err
	}
	if hasParameters != 0 {
		if _, err = tx.Exec("INSERT INTO main." + db.prefix + "vwd_parameters SELECT * FROM incoming." + sourcePrefix + "vwd_parameters"); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("DELETE FROM main." + db.prefix + "vwd_documents; DELETE FROM main." + db.prefix + "vwd_library;"); err != nil {
		return err
	}
	for _, item := range []struct{ table, columns string }{
		{"vwd_library", "singleton,kind,version,library_id,updated_at,directories_json,root_documents_json,active_document_name,selected_directory_id"},
		{"vwd_documents", "name,sort_order,content,hscale,wave_edit_mode,revision,saved_at,title_cache,description_cache,content_length,extra_json"},
		{"vwd_document_chunks", "document_name,chunk_index,content_chunk"},
	} {
		query := "INSERT INTO main." + db.prefix + item.table + " (" + item.columns + ") SELECT " + item.columns + " FROM incoming." + sourcePrefix + item.table
		if _, err = tx.Exec(query); err != nil {
			return err
		}
	}
	return tx.Commit()
}
