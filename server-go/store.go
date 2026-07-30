package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	_ "modernc.org/sqlite"
)

const (
	libraryKind            = "VisualWaveDromWaveLibrary"
	sqliteSchemaVersion    = 2
	documentChunkThreshold = 256 * 1024
	documentChunkSize      = 64 * 1024
)

var sqliteHeader = []byte("SQLite format 3\x00")

const schemaSQL = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS vwd_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  library_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  directories_json TEXT NOT NULL DEFAULT '[]',
  root_documents_json TEXT NOT NULL DEFAULT '[]',
  active_document_name TEXT NOT NULL DEFAULT '',
  selected_directory_id TEXT NOT NULL DEFAULT 'nav-root'
);
CREATE TABLE IF NOT EXISTS vwd_documents (
  name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  content TEXT NOT NULL,
  hscale REAL NOT NULL DEFAULT 1,
  wave_edit_mode TEXT NOT NULL DEFAULT 'modify',
  revision INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT NOT NULL DEFAULT '',
  title_cache TEXT NOT NULL DEFAULT '',
  description_cache TEXT NOT NULL DEFAULT '',
  content_length INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS vwd_documents_sort_order
  ON vwd_documents(sort_order, name);
CREATE TABLE IF NOT EXISTS vwd_document_chunks (
  document_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_chunk TEXT NOT NULL,
  PRIMARY KEY (document_name, chunk_index),
  FOREIGN KEY (document_name) REFERENCES vwd_documents(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS vwd_document_chunks_document
  ON vwd_document_chunks(document_name, chunk_index);
PRAGMA user_version=2;
`

type waveLibrary struct {
	Kind                string           `json:"kind"`
	Version             int              `json:"version"`
	LibraryID           string           `json:"libraryId"`
	UpdatedAt           string           `json:"updatedAt"`
	Documents           []map[string]any `json:"documents"`
	Directories         any              `json:"directories"`
	RootDocuments       any              `json:"rootDocuments"`
	ActiveDocumentName  string           `json:"activeDocumentName"`
	SelectedDirectoryID string           `json:"selectedDirectoryId"`
}

type preparedDocument struct {
	Name             string
	SortOrder        int
	Content          string
	InlineContent    string
	ContentChunks    []string
	Hscale           float64
	WaveEditMode     string
	Revision         int
	SavedAt          string
	TitleCache       string
	DescriptionCache string
	ContentLength    int
	ExtraJSON        string
}

type documentRow struct {
	Name             string
	Content          string
	Hscale           float64
	WaveEditMode     string
	Revision         int
	SavedAt          string
	TitleCache       string
	DescriptionCache string
	ContentLength    int
	ExtraJSON        string
}

type libraryInfo struct {
	LibraryID     string `json:"libraryId"`
	DocumentCount int    `json:"documentCount"`
	UpdatedAt     string `json:"updatedAt"`
}

type revisionResult struct {
	Name     string `json:"name"`
	Revision int    `json:"revision"`
	SavedAt  string `json:"savedAt"`
}

type patchResult struct {
	Status           int
	Error            string
	WaveID           string
	Revisions        []revisionResult
	DeletedDocuments []string
}

type documentUpdateResult struct {
	Status   int
	Error    string
	Document map[string]any
}

type sqliteStore struct {
	prepared sync.Map
}

func newSQLiteStore() *sqliteStore {
	return &sqliteStore{}
}

func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func cloneJSONValue(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fallback
	}
	var cloned any
	if json.Unmarshal(data, &cloned) != nil {
		return fallback
	}
	return cloned
}

func (s *sqliteStore) open(filePath string, create bool) (*sql.DB, error) {
	if create {
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filePath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err = db.Exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func (s *sqliteStore) ensureSchema(filePath string) error {
	resolved, err := filepath.Abs(filePath)
	if err != nil {
		return err
	}
	if _, ready := s.prepared.Load(resolved); ready {
		return nil
	}
	if hasSQLiteHeader(filePath) {
		db, openErr := s.open(filePath, false)
		if openErr == nil {
			var version int
			queryErr := db.QueryRow("PRAGMA user_version").Scan(&version)
			closeErr := db.Close()
			if queryErr == nil && closeErr == nil && version >= sqliteSchemaVersion {
				s.prepared.Store(resolved, true)
				return nil
			}
		}
	}
	db, err := s.open(filePath, true)
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err = db.Exec(schemaSQL); err != nil {
		return err
	}
	s.prepared.Store(resolved, true)
	return nil
}

func hasSQLiteHeader(filePath string) bool {
	file, err := os.Open(filePath)
	if err != nil {
		return false
	}
	defer file.Close()
	header := make([]byte, len(sqliteHeader))
	if _, err = io.ReadFull(file, header); err != nil {
		return false
	}
	return string(header) == string(sqliteHeader)
}

func (s *sqliteStore) isLibraryFile(filePath string) bool {
	if !hasSQLiteHeader(filePath) {
		return false
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return false
	}
	defer db.Close()
	var kind, id string
	err = db.QueryRow("SELECT kind, library_id FROM vwd_library WHERE singleton=1 LIMIT 1").Scan(&kind, &id)
	return err == nil && kind == libraryKind && id != ""
}

func utf16Length(text string) int {
	return len(utf16.Encode([]rune(text)))
}

func splitDocumentContent(content string) []string {
	if utf16Length(content) < documentChunkThreshold {
		return nil
	}
	chunks := make([]string, 0, utf16Length(content)/documentChunkSize+1)
	startByte := 0
	units := 0
	for byteIndex, character := range content {
		characterUnits := 1
		if character > 0xffff {
			characterUnits = 2
		}
		if units > 0 && units+characterUnits > documentChunkSize {
			chunks = append(chunks, content[startByte:byteIndex])
			startByte = byteIndex
			units = 0
		}
		units += characterUnits
	}
	if startByte < len(content) {
		chunks = append(chunks, content[startByte:])
	}
	return chunks
}

var knownDocumentFields = map[string]struct{}{
	"name": {}, "content": {}, "json": {}, "hscale": {}, "waveEditMode": {},
	"revision": {}, "savedAt": {}, "deferred": {}, "titleCache": {},
	"descriptionCache": {}, "contentLength": {}, "sortOrder": {},
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func floatValue(value any, fallback float64) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case float32:
		return float64(number)
	case int:
		return float64(number)
	case int64:
		return float64(number)
	case json.Number:
		if parsed, err := number.Float64(); err == nil {
			return parsed
		}
	}
	return fallback
}

func intValue(value any, fallback int) int {
	number, ok := integerValue(value)
	if !ok {
		return fallback
	}
	return number
}

func integerValue(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, true
	case int64:
		return int(number), true
	case float64:
		converted := int(number)
		return converted, float64(converted) == number
	case json.Number:
		converted, err := number.Int64()
		return int(converted), err == nil
	}
	return 0, false
}

func documentMetadata(content, fallbackName string) (string, string, error) {
	var source map[string]any
	if err := json.Unmarshal([]byte(content), &source); err != nil {
		return "", "", err
	}
	if source == nil {
		return "", "", errors.New("wave document root must be an object")
	}
	title, _ := source["title"].(string)
	title = strings.TrimSpace(title)
	head := ""
	if headObject, ok := source["head"].(map[string]any); ok {
		if headText, ok := headObject["text"].(string); ok {
			head = strings.TrimSpace(headText)
		}
	}
	description, _ := source["description"].(string)
	if title == "" {
		title = head
	}
	if title == "" {
		title = fallbackName
	}
	return title, description, nil
}

func prepareDocument(document map[string]any, sortOrder int) (preparedDocument, error) {
	name := strings.TrimSpace(stringValue(document["name"]))
	content, contentOK := document["content"].(string)
	if name == "" || !contentOK {
		return preparedDocument{}, errors.New("invalid wave document")
	}
	titleCache, descriptionCache, err := documentMetadata(content, name)
	if err != nil {
		return preparedDocument{}, err
	}
	chunks := splitDocumentContent(content)
	inlineContent := content
	if len(chunks) > 0 {
		inlineContent = ""
	}
	mode := stringValue(document["waveEditMode"])
	if mode != "insert" {
		mode = "modify"
	}
	revision := intValue(document["revision"], 0)
	if revision < 0 {
		revision = 0
	}
	hscale := floatValue(document["hscale"], 1)
	extra := make(map[string]any)
	for key, value := range document {
		if _, known := knownDocumentFields[key]; !known {
			extra[key] = value
		}
	}
	extraBytes, err := json.Marshal(extra)
	if err != nil {
		return preparedDocument{}, err
	}
	return preparedDocument{
		Name:             name,
		SortOrder:        sortOrder,
		Content:          content,
		InlineContent:    inlineContent,
		ContentChunks:    chunks,
		Hscale:           hscale,
		WaveEditMode:     mode,
		Revision:         revision,
		SavedAt:          stringValue(document["savedAt"]),
		TitleCache:       titleCache,
		DescriptionCache: descriptionCache,
		ContentLength:    utf16Length(content),
		ExtraJSON:        string(extraBytes),
	}, nil
}

func writeLibraryRow(tx *sql.Tx, library waveLibrary) error {
	directories, err := json.Marshal(library.Directories)
	if err != nil {
		return err
	}
	rootDocuments, err := json.Marshal(library.RootDocuments)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`
INSERT INTO vwd_library (
 singleton, kind, version, library_id, updated_at, directories_json,
 root_documents_json, active_document_name, selected_directory_id
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(singleton) DO UPDATE SET
 kind=excluded.kind, version=excluded.version, library_id=excluded.library_id,
 updated_at=excluded.updated_at, directories_json=excluded.directories_json,
 root_documents_json=excluded.root_documents_json,
 active_document_name=excluded.active_document_name,
 selected_directory_id=excluded.selected_directory_id`,
		library.Kind, library.Version, library.LibraryID, library.UpdatedAt,
		string(directories), string(rootDocuments), library.ActiveDocumentName,
		library.SelectedDirectoryID)
	return err
}

func writePreparedDocument(tx *sql.Tx, document preparedDocument, insertOnly bool) error {
	query := `
INSERT INTO vwd_documents (
 name, sort_order, content, hscale, wave_edit_mode, revision, saved_at,
 title_cache, description_cache, content_length, extra_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if !insertOnly {
		query += `
ON CONFLICT(name) DO UPDATE SET
 sort_order=excluded.sort_order, content=excluded.content, hscale=excluded.hscale,
 wave_edit_mode=excluded.wave_edit_mode, revision=excluded.revision,
 saved_at=excluded.saved_at, title_cache=excluded.title_cache,
 description_cache=excluded.description_cache,
 content_length=excluded.content_length, extra_json=excluded.extra_json`
	}
	if _, err := tx.Exec(query, document.Name, document.SortOrder, document.InlineContent,
		document.Hscale, document.WaveEditMode, document.Revision, document.SavedAt,
		document.TitleCache, document.DescriptionCache, document.ContentLength,
		document.ExtraJSON); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM vwd_document_chunks WHERE document_name=?", document.Name); err != nil {
		return err
	}
	for index, chunk := range document.ContentChunks {
		if _, err := tx.Exec(`INSERT INTO vwd_document_chunks
			(document_name, chunk_index, content_chunk) VALUES (?, ?, ?)`,
			document.Name, index, chunk); err != nil {
			return err
		}
	}
	return nil
}

func normalizeLibrary(library waveLibrary) (waveLibrary, error) {
	if library.Kind != libraryKind || library.Documents == nil {
		return waveLibrary{}, errors.New("invalid wave library")
	}
	if library.LibraryID == "" {
		return waveLibrary{}, errors.New("wave library id is required")
	}
	if library.Version < 2 {
		library.Version = 2
	}
	if library.UpdatedAt == "" {
		library.UpdatedAt = isoNow()
	}
	if library.Directories == nil {
		library.Directories = []any{}
	}
	if library.RootDocuments == nil {
		library.RootDocuments = []any{}
	}
	if library.SelectedDirectoryID == "" {
		library.SelectedDirectoryID = "nav-root"
	}
	return library, nil
}

func (s *sqliteStore) writeLibrary(filePath string, library waveLibrary) error {
	var err error
	if library, err = normalizeLibrary(library); err != nil {
		return err
	}
	if err = s.ensureSchema(filePath); err != nil {
		return err
	}
	db, err := s.open(filePath, true)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM vwd_documents"); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM vwd_library"); err != nil {
		return err
	}
	if err = writeLibraryRow(tx, library); err != nil {
		return err
	}
	for index, raw := range library.Documents {
		document, prepareErr := prepareDocument(raw, index)
		if prepareErr != nil {
			return prepareErr
		}
		if err = writePreparedDocument(tx, document, true); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func decodeJSONOr(text string, fallback any) any {
	var value any
	if json.Unmarshal([]byte(text), &value) != nil {
		return fallback
	}
	return value
}

func (s *sqliteStore) readLibraryRow(filePath string) (waveLibrary, error) {
	if err := s.ensureSchema(filePath); err != nil {
		return waveLibrary{}, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return waveLibrary{}, err
	}
	defer db.Close()
	var library waveLibrary
	var directoriesJSON, rootDocumentsJSON string
	err = db.QueryRow(`SELECT kind, version, library_id, updated_at, directories_json,
		root_documents_json, active_document_name, selected_directory_id
		FROM vwd_library WHERE singleton=1 LIMIT 1`).Scan(
		&library.Kind, &library.Version, &library.LibraryID, &library.UpdatedAt,
		&directoriesJSON, &rootDocumentsJSON, &library.ActiveDocumentName,
		&library.SelectedDirectoryID)
	if err != nil || library.Kind != libraryKind {
		return waveLibrary{}, errors.New("invalid SQLite wave library")
	}
	if library.Version < 2 {
		library.Version = 2
	}
	library.Directories = decodeJSONOr(directoriesJSON, []any{})
	library.RootDocuments = decodeJSONOr(rootDocumentsJSON, []any{})
	if library.SelectedDirectoryID == "" {
		library.SelectedDirectoryID = "nav-root"
	}
	return library, nil
}

func documentFromRow(row documentRow, summaryOnly bool, content string) map[string]any {
	extra := make(map[string]any)
	_ = json.Unmarshal([]byte(row.ExtraJSON), &extra)
	extra["name"] = row.Name
	extra["hscale"] = row.Hscale
	extra["waveEditMode"] = row.WaveEditMode
	extra["revision"] = row.Revision
	extra["savedAt"] = row.SavedAt
	if summaryOnly {
		extra["deferred"] = true
		extra["titleCache"] = row.TitleCache
		extra["descriptionCache"] = row.DescriptionCache
		extra["contentLength"] = row.ContentLength
	} else {
		extra["content"] = content
	}
	return extra
}

func scanDocument(scanner interface{ Scan(...any) error }, withContent bool) (documentRow, error) {
	var row documentRow
	var err error
	if withContent {
		err = scanner.Scan(&row.Name, &row.Content, &row.Hscale, &row.WaveEditMode,
			&row.Revision, &row.SavedAt, &row.TitleCache, &row.DescriptionCache,
			&row.ContentLength, &row.ExtraJSON)
	} else {
		err = scanner.Scan(&row.Name, &row.Hscale, &row.WaveEditMode, &row.Revision,
			&row.SavedAt, &row.TitleCache, &row.DescriptionCache, &row.ContentLength,
			&row.ExtraJSON)
	}
	return row, err
}

func readChunkContent(db *sql.DB, documentName string) (string, bool, error) {
	rows, err := db.Query(`SELECT content_chunk FROM vwd_document_chunks
		WHERE document_name=? ORDER BY chunk_index`, documentName)
	if err != nil {
		return "", false, err
	}
	defer rows.Close()
	var builder strings.Builder
	found := false
	for rows.Next() {
		var part string
		if err = rows.Scan(&part); err != nil {
			return "", false, err
		}
		found = true
		builder.WriteString(part)
	}
	return builder.String(), found, rows.Err()
}

func (s *sqliteStore) readLibrary(filePath string, summaryOnly bool) (waveLibrary, error) {
	library, err := s.readLibraryRow(filePath)
	if err != nil {
		return waveLibrary{}, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return waveLibrary{}, err
	}
	defer db.Close()
	query := `SELECT name, hscale, wave_edit_mode, revision, saved_at,
		title_cache, description_cache, content_length, extra_json
		FROM vwd_documents ORDER BY sort_order, name`
	if !summaryOnly {
		query = `SELECT name, content, hscale, wave_edit_mode, revision, saved_at,
			title_cache, description_cache, content_length, extra_json
			FROM vwd_documents ORDER BY sort_order, name`
	}
	rows, err := db.Query(query)
	if err != nil {
		return waveLibrary{}, err
	}
	documentRows := make([]documentRow, 0)
	for rows.Next() {
		row, scanErr := scanDocument(rows, !summaryOnly)
		if scanErr != nil {
			rows.Close()
			return waveLibrary{}, scanErr
		}
		documentRows = append(documentRows, row)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return waveLibrary{}, err
	}
	if err = rows.Close(); err != nil {
		return waveLibrary{}, err
	}
	library.Documents = make([]map[string]any, 0, len(documentRows))
	for _, row := range documentRows {
		content := row.Content
		if !summaryOnly {
			chunkContent, found, chunkErr := readChunkContent(db, row.Name)
			if chunkErr != nil {
				return waveLibrary{}, chunkErr
			}
			if found {
				content = chunkContent
			}
		}
		library.Documents = append(library.Documents, documentFromRow(row, summaryOnly, content))
	}
	return library, nil
}

func (s *sqliteStore) readDocument(filePath, waveID string) (map[string]any, error) {
	if err := s.ensureSchema(filePath); err != nil {
		return nil, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	row, err := scanDocument(db.QueryRow(`SELECT name, content, hscale, wave_edit_mode,
		revision, saved_at, title_cache, description_cache, content_length, extra_json
		FROM vwd_documents WHERE name=? LIMIT 1`, waveID), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	content, found, err := readChunkContent(db, waveID)
	if err != nil {
		return nil, err
	}
	if !found {
		content = row.Content
	}
	return documentFromRow(row, false, content), nil
}

func (s *sqliteStore) nextSortOrder(tx *sql.Tx) (int, error) {
	var next int
	err := tx.QueryRow("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM vwd_documents").Scan(&next)
	return next, err
}

func documentsHaveSameState(left, right map[string]any) bool {
	return stringValue(left["content"]) == stringValue(right["content"]) &&
		floatValue(left["hscale"], 1) == floatValue(right["hscale"], 1) &&
		stringValue(left["waveEditMode"]) == stringValue(right["waveEditMode"])
}

func (s *sqliteStore) updateDocument(filePath, waveID string, expectedRevision *int, incoming map[string]any) (documentUpdateResult, error) {
	previous, err := s.readDocument(filePath, waveID)
	if err != nil {
		return documentUpdateResult{}, err
	}
	if previous == nil {
		return documentUpdateResult{Status: 404, Error: "Wave document not found"}, nil
	}
	previousRevision := intValue(previous["revision"], 0)
	if expectedRevision != nil && *expectedRevision != previousRevision {
		return documentUpdateResult{
			Status: 409, Error: "Wave document revision conflict", Document: previous,
		}, nil
	}
	if _, ok := incoming["content"].(string); !ok {
		return documentUpdateResult{}, errors.New("invalid wave document content")
	}
	if err = s.ensureSchema(filePath); err != nil {
		return documentUpdateResult{}, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return documentUpdateResult{}, err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return documentUpdateResult{}, err
	}
	defer tx.Rollback()
	var sortOrder int
	if err = tx.QueryRow("SELECT sort_order FROM vwd_documents WHERE name=? LIMIT 1", waveID).Scan(&sortOrder); err != nil {
		return documentUpdateResult{}, err
	}
	merged := make(map[string]any)
	for key, value := range previous {
		merged[key] = value
	}
	for key, value := range incoming {
		merged[key] = value
	}
	savedAt := isoNow()
	merged["name"] = waveID
	merged["revision"] = previousRevision + 1
	merged["savedAt"] = savedAt
	document, err := prepareDocument(merged, sortOrder)
	if err != nil {
		return documentUpdateResult{}, err
	}
	if err = writePreparedDocument(tx, document, false); err != nil {
		return documentUpdateResult{}, err
	}
	if _, err = tx.Exec("UPDATE vwd_library SET updated_at=? WHERE singleton=1", savedAt); err != nil {
		return documentUpdateResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return documentUpdateResult{}, err
	}
	resultRow := documentRow{
		Name: document.Name, Content: document.Content, Hscale: document.Hscale,
		WaveEditMode: document.WaveEditMode, Revision: document.Revision,
		SavedAt: document.SavedAt, ExtraJSON: document.ExtraJSON,
	}
	return documentUpdateResult{
		Status: 200, Document: documentFromRow(resultRow, false, document.Content),
	}, nil
}

func (s *sqliteStore) patchLibraryState(filePath string, payload map[string]any) (patchResult, error) {
	library, err := s.readLibraryRow(filePath)
	if err != nil {
		return patchResult{}, err
	}
	deleted := make([]string, 0)
	if values, ok := payload["deletedDocuments"].([]any); ok {
		for _, value := range values {
			name := strings.TrimSpace(stringValue(value))
			if name != "" {
				deleted = append(deleted, name)
			}
		}
	}
	incomingDocuments := make([]map[string]any, 0)
	previousByName := make(map[string]map[string]any)
	if values, ok := payload["documents"].([]any); ok {
		for _, value := range values {
			document, ok := value.(map[string]any)
			if !ok {
				return patchResult{}, errors.New("invalid wave document")
			}
			name := strings.TrimSpace(stringValue(document["name"]))
			if name == "" {
				return patchResult{}, errors.New("invalid wave document")
			}
			previous, readErr := s.readDocument(filePath, name)
			if readErr != nil {
				return patchResult{}, readErr
			}
			previousByName[name] = previous
			incomingDocuments = append(incomingDocuments, document)
		}
	}
	if err = s.ensureSchema(filePath); err != nil {
		return patchResult{}, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return patchResult{}, err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return patchResult{}, err
	}
	defer tx.Rollback()

	nextSortOrder, err := s.nextSortOrder(tx)
	if err != nil {
		return patchResult{}, err
	}
	prepared := make([]preparedDocument, 0, len(incomingDocuments))
	revisions := make([]revisionResult, 0, len(incomingDocuments))
	for _, incoming := range incomingDocuments {
		name := strings.TrimSpace(stringValue(incoming["name"]))
		if name == "" {
			return patchResult{}, errors.New("invalid wave document")
		}
		if _, ok := incoming["content"].(string); !ok {
			return patchResult{}, errors.New("invalid wave document")
		}
		previous := previousByName[name]
		if expectedRevision, hasExpected := integerValue(incoming["revision"]); previous != nil && hasExpected {
			currentRevision := intValue(previous["revision"], 0)
			if expectedRevision != currentRevision {
				if !documentsHaveSameState(incoming, previous) {
					return patchResult{
						Status: 409, Error: "Wave document revision conflict", WaveID: name,
					}, nil
				}
				revisions = append(revisions, revisionResult{
					Name: name, Revision: currentRevision, SavedAt: stringValue(previous["savedAt"]),
				})
				continue
			}
		}
		sortOrder := nextSortOrder
		nextSortOrder++
		if previous != nil {
			if err = tx.QueryRow("SELECT sort_order FROM vwd_documents WHERE name=? LIMIT 1", name).Scan(&sortOrder); err != nil {
				return patchResult{}, err
			}
		}
		merged := make(map[string]any)
		for key, value := range previous {
			merged[key] = value
		}
		for key, value := range incoming {
			merged[key] = value
		}
		revision := 0
		if previous != nil {
			revision = intValue(previous["revision"], 0) + 1
		}
		savedAt := isoNow()
		merged["name"] = name
		merged["revision"] = revision
		merged["savedAt"] = savedAt
		document, prepareErr := prepareDocument(merged, sortOrder)
		if prepareErr != nil {
			return patchResult{}, prepareErr
		}
		prepared = append(prepared, document)
		revisions = append(revisions, revisionResult{Name: name, Revision: revision, SavedAt: savedAt})
	}

	if value, ok := payload["directories"]; ok {
		library.Directories = cloneJSONValue(value, library.Directories)
	}
	if value, ok := payload["rootDocuments"]; ok {
		library.RootDocuments = cloneJSONValue(value, library.RootDocuments)
	}
	if value, ok := payload["activeDocumentName"].(string); ok {
		library.ActiveDocumentName = value
	}
	if value, ok := payload["selectedDirectoryId"].(string); ok {
		library.SelectedDirectoryID = value
	}
	library.UpdatedAt = isoNow()

	for _, name := range deleted {
		if _, err = tx.Exec("DELETE FROM vwd_documents WHERE name=?", name); err != nil {
			return patchResult{}, err
		}
	}
	for _, document := range prepared {
		if err = writePreparedDocument(tx, document, false); err != nil {
			return patchResult{}, err
		}
	}
	if err = writeLibraryRow(tx, library); err != nil {
		return patchResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return patchResult{}, err
	}
	return patchResult{
		Status: 200, Revisions: revisions, DeletedDocuments: deleted,
	}, nil
}

func (s *sqliteStore) getLibraryInfo(filePath string) (libraryInfo, error) {
	library, err := s.readLibraryRow(filePath)
	if err != nil {
		return libraryInfo{}, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return libraryInfo{}, err
	}
	defer db.Close()
	var count int
	if err = db.QueryRow("SELECT COUNT(*) FROM vwd_documents").Scan(&count); err != nil {
		return libraryInfo{}, err
	}
	return libraryInfo{LibraryID: library.LibraryID, DocumentCount: count, UpdatedAt: library.UpdatedAt}, nil
}

func (s *sqliteStore) runtimeVersion() (string, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return "", err
	}
	defer db.Close()
	var version string
	err = db.QueryRow("SELECT sqlite_version()").Scan(&version)
	return version, err
}
