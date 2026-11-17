package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestUndoHistoryQuotaAndIsolation(t *testing.T) {
	dir := t.TempDir()
	s := service{config: config{tempDir: dir}, workingDir: filepath.Join(dir, "undo-test")}
	owner := strings.Repeat("a", 32)
	other := strings.Repeat("b", 32)
	call := func(action, who, id, limit string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://localhost/api/undo-history?action="+action+"&owner="+who+"&id="+id+"&limit="+limit, bytes.NewReader(body))
		req.Header.Set("X-VWD-Undo", "1")
		req.Header.Set("Origin", "http://localhost")
		w := httptest.NewRecorder()
		s.handleUndoHistory(w, req)
		return w
	}
	data := bytes.Repeat([]byte{0, 123, 255}, 240000)
	if got := call("write", owner, "1", "1048576", data).Code; got != 204 {
		t.Fatalf("write: %d", got)
	}
	if got := call("write", owner, "2", "1048576", data).Code; got != 507 {
		t.Fatalf("quota: %d", got)
	}
	if got := call("read", other, "1", "", nil).Code; got != 404 {
		t.Fatalf("owner isolation: %d", got)
	}
	if w := call("read", owner, "1", "", nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatalf("read: %d", w.Code)
	}
	if got := call("write", owner, "2", "2097152", data).Code; got != 204 {
		t.Fatalf("raise limit: %d", got)
	}
	if got := call("delete", owner, "1", "", nil).Code; got != 204 {
		t.Fatalf("delete: %d", got)
	}
	if err := s.deleteOperationSession(); err != nil {
		t.Fatal(err)
	}
	if got := call("read", owner, "2", "", nil).Code; got != 404 {
		t.Fatalf("session cleanup: %d", got)
	}
}
