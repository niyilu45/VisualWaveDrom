package main

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
)

var undoOwnerPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *service) handleUndoHistory(w http.ResponseWriter, r *http.Request) {
	origin, originErr := url.Parse(r.Header.Get("Origin"))
	if r.Header.Get("X-VWD-Undo") != "1" || originErr != nil || origin.Scheme != "http" || origin.Host != r.Host {
		http.Error(w, "local undo request required", http.StatusForbidden)
		return
	}
	query := r.URL.Query()
	owner, action := query.Get("owner"), query.Get("action")
	id, idErr := strconv.ParseInt(query.Get("id"), 10, 64)
	if !undoOwnerPattern.MatchString(owner) || (action != "clear" && (idErr != nil || id <= 0)) {
		http.Error(w, "invalid undo record", http.StatusBadRequest)
		return
	}
	db, err := openOperations(s.config.tempDir)
	if err != nil {
		http.Error(w, "undo storage unavailable", http.StatusInternalServerError)
		return
	}
	defer db.Close()
	session := filepath.Base(s.workingDir)
	switch action {
	case "write":
		limit, limitErr := strconv.ParseInt(query.Get("limit"), 10, 64)
		if limitErr != nil || limit < 1<<20 || limit > 64<<30 {
			http.Error(w, "invalid undo storage limit", http.StatusBadRequest)
			return
		}
		body, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, min(limit, 512<<20)))
		if readErr != nil || len(body) == 0 {
			http.Error(w, "undo record is too large or invalid", http.StatusRequestEntityTooLarge)
			return
		}
		var result sql.Result
		result, err = db.ExecContext(r.Context(), `INSERT INTO undo_snapshots(session, owner, id, payload)
SELECT ?, ?, ?, ? WHERE ? + (SELECT COALESCE(SUM(length(payload)), 0)
 FROM undo_snapshots WHERE session=? AND owner=?) <= ?`, session, owner, id, body, len(body), session, owner, limit)
		if err == nil {
			var written int64
			written, err = result.RowsAffected()
			if err == nil && written == 0 {
				http.Error(w, "undo storage limit reached", http.StatusInsufficientStorage)
				return
			}
		}
	case "read":
		var body []byte
		err = db.QueryRowContext(r.Context(), "SELECT payload FROM undo_snapshots WHERE session=? AND owner=? AND id=?", session, owner, id).Scan(&body)
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if err == nil {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(body)
			return
		}
	case "delete":
		_, err = db.ExecContext(r.Context(), "DELETE FROM undo_snapshots WHERE session=? AND owner=? AND id=?", session, owner, id)
	case "clear":
		_, err = db.ExecContext(r.Context(), "DELETE FROM undo_snapshots WHERE session=? AND owner=?", session, owner)
	default:
		http.Error(w, "unknown undo action", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, "undo storage unavailable", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
