package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

func validPresentation(value string) bool {
	var state struct {
		Kind    string            `json:"kind"`
		Version int               `json:"version"`
		Steps   []json.RawMessage `json:"steps"`
	}
	return json.Unmarshal([]byte(value), &state) == nil &&
		state.Kind == "VisualWaveDromPresentation" && state.Version == 1 && len(state.Steps) > 0
}

// Presentation writes leave waveform content, chunks and revisions unchanged.
func (s *sqliteStore) savePresentation(filePath, waveID, expected, value string) (int, error) {
	if !validPresentation(value) {
		return http.StatusBadRequest, errors.New("Invalid presentation data")
	}
	if err := s.ensureSchema(filePath); err != nil {
		return http.StatusInternalServerError, err
	}
	db, err := s.open(filePath, false)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return http.StatusInternalServerError, err
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRow("SELECT extra_json FROM vwd_documents WHERE name=?", waveID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return http.StatusNotFound, errors.New("Wave document not found")
	}
	if err != nil {
		return http.StatusInternalServerError, err
	}
	extra := make(map[string]any)
	if err = json.Unmarshal([]byte(raw), &extra); err != nil || extra == nil {
		return http.StatusBadRequest, errors.New("Invalid document metadata")
	}
	previous, _ := extra["presentation"].(string)
	if previous != expected && previous != value {
		return http.StatusConflict, errors.New("Presentation changed in another window")
	}
	extra["presentation"] = value
	encoded, err := json.Marshal(extra)
	if err != nil {
		return http.StatusBadRequest, err
	}
	result, err := tx.Exec("UPDATE vwd_documents SET extra_json=? WHERE name=? AND extra_json=?", string(encoded), waveID, raw)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return http.StatusConflict, errors.New("Presentation changed in another window")
	}
	if _, err = tx.Exec("UPDATE vwd_library SET updated_at=? WHERE singleton=1", isoNow()); err != nil {
		return http.StatusInternalServerError, err
	}
	if err = tx.Commit(); err != nil {
		return http.StatusInternalServerError, err
	}
	return http.StatusOK, nil
}

func (s *service) handlePresentation(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		LibraryID    string `json:"libraryId"`
		WaveID       string `json:"waveId"`
		Expected     string `json:"expected"`
		Presentation string `json:"presentation"`
	}
	if err := decodeJSONBody(writer, request, 16*1024*1024, &payload); err != nil {
		sendJSON(writer, 400, map[string]any{"error": err.Error()})
		return
	}
	filePath := s.libraryPathByID(payload.LibraryID)
	if filePath == "" || payload.WaveID == "" {
		sendJSON(writer, 404, map[string]any{"error": "Wave document not found"})
		return
	}
	status, err := s.store.savePresentation(filePath, payload.WaveID, payload.Expected, payload.Presentation)
	if err != nil {
		sendJSON(writer, status, map[string]any{"error": err.Error()})
		return
	}
	sendJSON(writer, 200, map[string]any{"ok": true, "presentation": payload.Presentation})
}
