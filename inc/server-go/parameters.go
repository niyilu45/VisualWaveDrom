package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

const parameterSchemaSQL = `CREATE TABLE IF NOT EXISTS vwd_parameters (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), content TEXT NOT NULL
);`

func emptyParameters() map[string]any {
	return map[string]any{"revision": 0, "directories": []any{}, "tables": []any{}, "presets": []any{}}
}

func readParameters(db *libraryDB) (map[string]any, error) {
	var exists int
	err := db.DB.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", db.prefix+"vwd_parameters").Scan(&exists)
	if err != nil || exists == 0 {
		return emptyParameters(), err
	}
	var content string
	err = db.QueryRow("SELECT content FROM vwd_parameters WHERE singleton=1").Scan(&content)
	if errors.Is(err, sql.ErrNoRows) {
		return emptyParameters(), nil
	}
	if err != nil {
		return nil, err
	}
	var value map[string]any
	err = json.Unmarshal([]byte(content), &value)
	return value, err
}

func writeParameters(tx *libraryTx, parameters map[string]any) error {
	if parameters == nil {
		parameters = emptyParameters()
	}
	content, err := json.Marshal(parameters)
	if err != nil {
		return err
	}
	_, err = tx.Exec("INSERT INTO vwd_parameters(singleton,content) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET content=excluded.content", string(content))
	return err
}

func (s *service) handleWaveParameters(writer http.ResponseWriter, request *http.Request) {
	path := s.libraryPathByID(request.URL.Query().Get("libraryId"))
	if path == "" || !s.store.isLibraryFile(path) {
		sendJSON(writer, 404, map[string]any{"error": "Wave library not found"})
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPut {
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	db, err := s.store.open(path, false)
	if err != nil {
		sendJSON(writer, 500, map[string]any{"error": err.Error()})
		return
	}
	defer db.Close()
	if request.Method == http.MethodGet {
		value, readErr := readParameters(db)
		if readErr != nil {
			sendJSON(writer, 500, map[string]any{"error": readErr.Error()})
			return
		}
		sendJSON(writer, 200, value)
		return
	}
	var payload struct {
		ExpectedRevision *int           `json:"expectedRevision"`
		Parameters       map[string]any `json:"parameters"`
	}
	if err = decodeJSONBody(writer, request, 8*1024*1024, &payload); err != nil || payload.Parameters == nil || payload.ExpectedRevision == nil {
		sendJSON(writer, 400, map[string]any{"error": "Invalid parameter catalog or revision"})
		return
	}
	for _, key := range []string{"directories", "tables", "presets"} {
		if _, ok := payload.Parameters[key].([]any); !ok {
			sendJSON(writer, 400, map[string]any{"error": "Invalid parameters." + key})
			return
		}
	}
	s.libraryMu.Lock()
	defer s.libraryMu.Unlock()
	if _, err = db.Exec(parameterSchemaSQL); err != nil {
		sendJSON(writer, 500, map[string]any{"error": err.Error()})
		return
	}
	tx, err := db.Begin()
	if err != nil {
		sendJSON(writer, 500, map[string]any{"error": err.Error()})
		return
	}
	defer tx.Rollback()
	var old string
	err = tx.QueryRow("SELECT content FROM vwd_parameters WHERE singleton=1").Scan(&old)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		sendJSON(writer, 500, map[string]any{"error": err.Error()})
		return
	}
	previous := emptyParameters()
	if old != "" {
		if err = json.Unmarshal([]byte(old), &previous); err != nil {
			sendJSON(writer, 500, map[string]any{"error": err.Error()})
			return
		}
	}
	if *payload.ExpectedRevision != intValue(previous["revision"], 0) {
		sendJSON(writer, 409, map[string]any{"error": "参数目录已被其他窗口修改，请重新加载后再修改", "parameters": previous})
		return
	}
	payload.Parameters["revision"] = *payload.ExpectedRevision + 1
	if err = writeParameters(tx, payload.Parameters); err == nil {
		_, err = tx.Exec("UPDATE vwd_library SET updated_at=? WHERE singleton=1", isoNow())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		sendJSON(writer, 500, map[string]any{"error": err.Error()})
		return
	}
	sendJSON(writer, 200, payload.Parameters)
}
