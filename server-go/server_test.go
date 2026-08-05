package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLinuxBrowserCommandsIncludeDesktopFallbacks(t *testing.T) {
	commands := browserCommands("linux", "http://127.0.0.1:4173/VisualWaveDrom.html")
	expected := []string{"xdg-open", "gio", "sensible-browser", "kde-open5", "kde-open", "gnome-open"}
	if len(commands) != len(expected) {
		t.Fatalf("expected %d browser commands, got %d", len(expected), len(commands))
	}
	for index, name := range expected {
		if len(commands[index]) == 0 || commands[index][0] != name {
			t.Fatalf("browser command %d = %#v, expected %q", index, commands[index], name)
		}
	}
}

func TestBrowserLauncherDetectsImmediateFailure(t *testing.T) {
	var command []string
	if runtime.GOOS == "windows" {
		command = []string{"cmd.exe", "/c", "exit", "7"}
	} else {
		command = []string{"sh", "-c", "exit 7"}
	}
	if err := launchBrowserCommand(command, time.Second); err == nil {
		t.Fatal("expected immediate browser launcher failure")
	}
}

func TestPruneExpiredClientsRemovesOnlyStaleLeases(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	instance := &service{
		clients: map[string]clientLease{
			"active": {
				token:    "active-token",
				lastSeen: now.Add(-clientLeaseTimeout / 2),
			},
			"stale": {
				token:    "stale-token",
				lastSeen: now.Add(-clientLeaseTimeout),
			},
		},
	}
	instance.pruneExpiredClientsLocked(now)
	if _, found := instance.clients["stale"]; found {
		t.Fatal("stale client lease was not removed")
	}
	if _, found := instance.clients["active"]; !found {
		t.Fatal("active client lease was removed")
	}
}

func TestResolvePastedImportPathAcceptsQuotedAndRelativePaths(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "sample data.csv")
	if err := os.WriteFile(sourcePath, []byte("0,1\n1,0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	expectedInfo, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, supplied := range []string{
		`"` + sourcePath + `"`,
		"'sample data.csv'",
	} {
		resolved, info, resolveErr := resolvePastedImportPath(supplied, root)
		if resolveErr != nil {
			t.Fatalf("resolve %q: %v", supplied, resolveErr)
		}
		if filepath.Clean(resolved) != filepath.Clean(sourcePath) {
			t.Fatalf("resolve %q = %q, expected %q", supplied, resolved, sourcePath)
		}
		if !os.SameFile(expectedInfo, info) {
			t.Fatalf("resolve %q returned different file info", supplied)
		}
	}
}

func TestImportSampleLinesSupportsLinuxAndWindowsNewlines(t *testing.T) {
	lines := importSampleLinesFromBytes([]byte("a\r\nb\nc\rd\ne\nf\n"))
	expected := []string{"a", "b", "c", "d", "e"}
	if len(lines) != len(expected) {
		t.Fatalf("sample line count = %d, expected %d", len(lines), len(expected))
	}
	for index, value := range expected {
		if lines[index] != value {
			t.Fatalf("sample line %d = %q, expected %q", index, lines[index], value)
		}
	}
}

func TestDecimalSingleColumnSampleUsesSingleColumnParser(t *testing.T) {
	analysis := analyzeImportSample("SeqConvInA.txt", []string{
		"0.814724", "0.905792", "0.126987", "0.913376", "0.632359",
	})
	if parser := stringValue(analysis["recommendedParser"]); parser != "parse_single_column" {
		t.Fatalf("recommended parser = %q, expected parse_single_column", parser)
	}
	if explicit, _ := analysis["explicitIndex"].(bool); explicit {
		t.Fatal("decimal single-column data must not be treated as an explicit index")
	}
}

func TestComplexSampleWithoutIndexUsesIQChannels(t *testing.T) {
	analysis := analyzeImportSample("complex.csv", []string{
		"1.25,-2.5", "2.5,-1.25", "3.75,0",
	}, false)
	if parser := stringValue(analysis["recommendedParser"]); parser != "parse_single_column" {
		t.Fatalf("recommended parser = %q, expected parse_single_column", parser)
	}
	if explicit, _ := analysis["explicitIndex"].(bool); explicit {
		t.Fatal("unchecked sequence option must use automatic row numbering")
	}
	if complexDetected, _ := analysis["complexDetected"].(bool); !complexDetected {
		t.Fatal("two data columns must be detected as complex I/Q data")
	}
}

func TestComplexSampleWithIndexUsesIndexedParser(t *testing.T) {
	analysis := analyzeImportSample("complex.tsv", []string{
		"index\tI\tQ", "4\t1.25\t-2.5", "8\t2.5\t-1.25",
	}, true)
	if parser := stringValue(analysis["recommendedParser"]); parser != "parse_tsv_index_data" {
		t.Fatalf("recommended parser = %q, expected parse_tsv_index_data", parser)
	}
	if explicit, _ := analysis["explicitIndex"].(bool); !explicit {
		t.Fatal("checked sequence option must use the first column as the index")
	}
	if complexDetected, _ := analysis["complexDetected"].(bool); !complexDetected {
		t.Fatal("indexed I/Q columns must be detected as complex data")
	}
	if headerLikely, _ := analysis["headerLikely"].(bool); !headerLikely {
		t.Fatal("index/I/Q heading must be detected")
	}
}

func TestPresetValueTableAddsLabelsWithoutChangingSamples(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	python := manager.pythonRuntime()
	if !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "state.txt")
	if err = os.WriteFile(sourcePath, []byte("0\n1\n1\n0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runParser(importMapping{
		Parser:      "parse_single_column",
		SourcePath:  sourcePath,
		DisplayPath: "state.txt",
		Options: map[string]any{
			"hasIndex": false,
			"tbl":      map[string]string{"1": "abc"},
		},
	}, python)
	if err != nil {
		t.Fatal(err)
	}
	if wave := stringValue(result["wave"]); wave != "0=.0" {
		t.Fatalf("mapped wave = %q, expected %q", wave, "0=.0")
	}
	labels, ok := result["data"].([]string)
	if !ok || len(labels) != 1 || labels[0] != "1:abc" {
		t.Fatalf("mapped labels = %#v, expected [1:abc]", result["data"])
	}
	samples, ok := result["samples"].([]any)
	if !ok || len(samples) != 4 || intValue(samples[0], -1) != 0 ||
		intValue(samples[1], -1) != 1 || intValue(samples[2], -1) != 1 ||
		intValue(samples[3], -1) != 0 {
		t.Fatalf("mapped samples changed: %#v", result["samples"])
	}

	unmatched, err := manager.runParser(importMapping{
		Parser:      "parse_single_column",
		SourcePath:  sourcePath,
		DisplayPath: "state.txt",
		Options: map[string]any{
			"hasIndex": false,
			"tbl":      map[string]string{"2": "unused"},
		},
	}, python)
	if err != nil {
		t.Fatal(err)
	}
	if wave := stringValue(unmatched["wave"]); wave != "01.0" {
		t.Fatalf("unmatched value table changed the wave: %q", wave)
	}
	if labels, ok = unmatched["data"].([]string); !ok || len(labels) != 0 {
		t.Fatalf("unmatched value table added labels: %#v", unmatched["data"])
	}
}

func TestTableImportPassesPresetValueTable(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "states.csv")
	if err = os.WriteFile(sourcePath, []byte("State\n0\n1\n1\n0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow: 1,
		Delimiter: "comma",
		Tbl:       map[string]string{"1": "active"},
	})
	if err != nil {
		t.Fatal(err)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok || len(updates) != 1 {
		t.Fatalf("unexpected table updates: %#v", result["updates"])
	}
	labels, ok := updates[0]["data"].([]string)
	if !ok || len(labels) != 3 || labels[0] != "0" ||
		labels[1] != "1:active" || labels[2] != "0" {
		t.Fatalf("table labels = %#v, expected [0 1:active 0]", updates[0]["data"])
	}
	samples, ok := updates[0]["samples"].([]any)
	if !ok || len(samples) != 4 || intValue(samples[0], -1) != 0 ||
		intValue(samples[1], -1) != 1 || intValue(samples[2], -1) != 1 ||
		intValue(samples[3], -1) != 0 {
		t.Fatalf("table samples changed: %#v", updates[0]["samples"])
	}
}

func TestTableImportUsesSelectedHeaderAndSplitsComplexSignals(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "signals.csv")
	data := "generated table\nclk,bus,iq\n0,wifi,1+2j\n1,proj,3-4j\n0,done,5+0j\n"
	if err = os.WriteFile(sourcePath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFile(sourcePath, 2)
	if err != nil {
		t.Fatal(err)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok {
		t.Fatalf("table updates have unexpected type: %T", result["updates"])
	}
	expectedNames := []string{"clk", "bus", "iq_I", "iq_Q"}
	if len(updates) != len(expectedNames) {
		t.Fatalf("update count = %d, expected %d", len(updates), len(expectedNames))
	}
	for index, expected := range expectedNames {
		if name := stringValue(updates[index]["signal"]); name != expected {
			t.Fatalf("update %d signal = %q, expected %q", index, name, expected)
		}
	}
	if pointCount := intValue(result["pointCount"], 0); pointCount != 3 {
		t.Fatalf("point count = %d, expected 3", pointCount)
	}
	if !boolValue(result["complexDetected"], false) {
		t.Fatal("complex table column was not detected")
	}
}

func TestTableImportOnlyParsesEnabledColumnsAndAppliesNames(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "signals.csv")
	data := "clk,bus,iq\n0,wifi,1+2j\n1,proj,3-4j\n"
	if err = os.WriteFile(sourcePath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow: 1,
		Delimiter: "comma",
		Columns: []collectionColumnConfig{
			{Source: "clk", Enabled: false, Name: "clk"},
			{Source: "bus", Enabled: true, Name: "payload"},
			{Source: "iq", Enabled: true, Name: "feedback"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok {
		t.Fatalf("table updates have unexpected type: %T", result["updates"])
	}
	expected := []string{"payload", "feedback_I", "feedback_Q"}
	if len(updates) != len(expected) {
		t.Fatalf("update count = %d, expected %d", len(updates), len(expected))
	}
	for index, name := range expected {
		if actual := stringValue(updates[index]["signal"]); actual != name {
			t.Fatalf("update %d signal = %q, expected %q", index, actual, name)
		}
	}
}

func TestTableImportUsesSelectedIndexColumn(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "indexed-signals.csv")
	data := "Sample,SigA,Flag\n2,10,1\n4,20,0\n"
	if err = os.WriteFile(sourcePath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow:   1,
		IndexColumn: "Sample",
		Delimiter:   "comma",
		Columns: []collectionColumnConfig{
			{Source: "Sample", Enabled: true, Name: "Sample"},
			{Source: "SigA", Enabled: true, Name: "SigA"},
			{Source: "Flag", Enabled: true, Name: "Flag"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if actual := stringValue(result["indexColumn"]); actual != "Sample" {
		t.Fatalf("index column = %q, expected Sample", actual)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok || len(updates) != 2 {
		t.Fatalf("index column should not produce a signal: %#v", result["updates"])
	}
	if stringValue(updates[0]["signal"]) != "SigA" ||
		stringValue(updates[1]["signal"]) != "Flag" {
		t.Fatalf("unexpected indexed signal names: %#v", updates)
	}
	if wave := stringValue(updates[0]["wave"]); wave != "x.=.=" {
		t.Fatalf("indexed SigA wave = %q, expected %q", wave, "x.=.=")
	}
	if wave := stringValue(updates[1]["wave"]); wave != "x.1.0" {
		t.Fatalf("indexed Flag wave = %q, expected %q", wave, "x.1.0")
	}
	samples, ok := updates[0]["samples"].([]any)
	if !ok || len(samples) != 5 || samples[0] != nil || samples[1] != nil ||
		intValue(samples[2], 0) != 10 || intValue(samples[3], 0) != 10 ||
		intValue(samples[4], 0) != 20 {
		t.Fatalf("indexed samples = %#v, expected [nil nil 10 10 20]", updates[0]["samples"])
	}
}

func TestTableImportRejectsInvalidSelectedIndexColumnValue(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "invalid-index.csv")
	if err = os.WriteFile(sourcePath, []byte("Sample,SigA\n0.5,10\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow:   1,
		IndexColumn: "Sample",
		Delimiter:   "comma",
	})
	if err == nil || !strings.Contains(err.Error(), "invalid sequence number") {
		t.Fatalf("invalid selected index value returned an unclear error: %v", err)
	}
}

func TestTableImportFiltersRowsUsingDisabledControlColumn(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "signals.csv")
	data := "Value,CurSt\n10,0\n11,1\n12,2\n13,3\n"
	if err = os.WriteFile(sourcePath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow: 1,
		Delimiter: "comma",
		Columns: []collectionColumnConfig{
			{Source: "Value", Enabled: true, Name: "Value"},
			{Source: "CurSt", Enabled: false, Name: "CurSt", Filter: ">=1&&<=2"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if pointCount := intValue(result["pointCount"], 0); pointCount != 2 {
		t.Fatalf("filtered point count = %d, expected 2", pointCount)
	}
	if filtered := intValue(result["filteredOutRowCount"], 0); filtered != 2 {
		t.Fatalf("filtered row count = %d, expected 2", filtered)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok || len(updates) != 1 || stringValue(updates[0]["signal"]) != "Value" {
		t.Fatalf("unexpected filtered updates: %#v", result["updates"])
	}
	labels, ok := updates[0]["data"].([]string)
	if !ok || len(labels) != 2 || labels[0] != "11" || labels[1] != "12" {
		t.Fatalf("filtered values = %#v, expected [11 12]", updates[0]["data"])
	}
	if wave := stringValue(updates[0]["wave"]); wave != "==x." {
		t.Fatalf("filtered wave = %q, expected reindexed data followed by unknowns %q", wave, "==x.")
	}
	samples, ok := updates[0]["samples"].([]any)
	if !ok || len(samples) != 4 || intValue(samples[0], 0) != 11 ||
		intValue(samples[1], 0) != 12 || samples[2] != nil || samples[3] != nil {
		t.Fatalf("filtered samples = %#v, expected [11 12 nil nil]", updates[0]["samples"])
	}
}

func TestTableImportRecognizesMultiStateIntegerColumnAsData(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "states.csv")
	data := "CurSt\n1\n1\n2\n2\n"
	if err = os.WriteFile(sourcePath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFile(sourcePath, 1)
	if err != nil {
		t.Fatal(err)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok || len(updates) != 1 {
		t.Fatalf("unexpected state updates: %#v", result["updates"])
	}
	if wave := stringValue(updates[0]["wave"]); wave != "=.=." {
		t.Fatalf("CurSt wave = %q, expected data waveform %q", wave, "=.=.")
	}
	labels, ok := updates[0]["data"].([]string)
	if !ok || len(labels) != 2 || labels[0] != "1" || labels[1] != "2" {
		t.Fatalf("CurSt labels = %#v, expected [1 2]", updates[0]["data"])
	}
	if kind := stringValue(updates[0]["sampleKind"]); kind != "bus" {
		t.Fatalf("CurSt sample kind = %q, expected bus", kind)
	}

	filtered, err := manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow: 1,
		Delimiter: "comma",
		Columns: []collectionColumnConfig{
			{Source: "CurSt", Enabled: true, Name: "CurSt", Filter: "=1"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	filteredUpdates, ok := filtered["updates"].([]map[string]any)
	if !ok || len(filteredUpdates) != 1 {
		t.Fatalf("unexpected filtered state updates: %#v", filtered["updates"])
	}
	if wave := stringValue(filteredUpdates[0]["wave"]); wave != "=.x." {
		t.Fatalf("filtered CurSt wave = %q, expected reindexed data and unknown tail %q", wave, "=.x.")
	}
	if kind := stringValue(filteredUpdates[0]["sampleKind"]); kind != "bus" {
		t.Fatalf("filtered CurSt sample kind = %q, expected bus", kind)
	}
}

func TestTableImportUsesContinuationForAdjacentEqualValues(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "repeated-signals.csv")
	data := "CurSt,BusState,StateName\n0,10,IDLE\n0,10,IDLE\n1,20,RUN\n1,20,RUN\n"
	if err = os.WriteFile(sourcePath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := manager.runTableLocalFile(sourcePath, 1)
	if err != nil {
		t.Fatal(err)
	}
	updates, ok := result["updates"].([]map[string]any)
	if !ok || len(updates) != 3 {
		t.Fatalf("unexpected repeated-value updates: %#v", result["updates"])
	}
	if wave := stringValue(updates[0]["wave"]); wave != "0.1." {
		t.Fatalf("CurSt wave = %q, expected %q", wave, "0.1.")
	}
	for _, index := range []int{1, 2} {
		if wave := stringValue(updates[index]["wave"]); wave != "=.=." {
			t.Fatalf("update %d wave = %q, expected %q", index, wave, "=.=.")
		}
	}
	if labels, ok := updates[1]["data"].([]string); !ok || len(labels) != 2 || labels[0] != "10" || labels[1] != "20" {
		t.Fatalf("BusState data = %#v, expected [10 20]", updates[1]["data"])
	}
	if labels, ok := updates[2]["data"].([]string); !ok || len(labels) != 2 || labels[0] != "IDLE" || labels[1] != "RUN" {
		t.Fatalf("StateName data = %#v, expected [IDLE RUN]", updates[2]["data"])
	}
}

func TestTableImportRejectsInvalidColumnFilter(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(filepath.Dir(workingDirectory))
	if python := manager.pythonRuntime(); !python.Available {
		t.Skip("Python runtime is not available")
	}
	sourcePath := filepath.Join(t.TempDir(), "signals.csv")
	if err = os.WriteFile(sourcePath, []byte("CurSt\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = manager.runTableLocalFileWithOptions(sourcePath, tableImportOptions{
		HeaderRow: 1,
		Delimiter: "comma",
		Columns: []collectionColumnConfig{
			{Source: "CurSt", Enabled: true, Name: "CurSt", Filter: ">=ready"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "filter for CurSt requires a numeric value") {
		t.Fatalf("invalid filter returned an unclear error: %v", err)
	}
}

func TestSameRunningServiceRequiresCurrentAPIVersion(t *testing.T) {
	root := t.TempDir()
	instance := &service{config: config{
		rootDir: root, htmlName: "VisualWaveDrom.html",
		configuredName: "test-library", waveDir: filepath.Join(root, "Wave"),
	}}
	info := map[string]any{
		"app": appID, "htmlName": instance.config.htmlName,
		"currentLibrary": instance.config.configuredName,
		"rootDir":        root, "libraryDir": instance.config.waveDir,
	}
	if instance.sameRunningService(info) {
		t.Fatal("service without an API version must not be reused")
	}
	info["serviceAPIVersion"] = serviceAPIVersion - 1
	if instance.sameRunningService(info) {
		t.Fatal("service with an older API version must not be reused")
	}
	info["serviceAPIVersion"] = serviceAPIVersion
	if !instance.sameRunningService(info) {
		t.Fatal("service with the current API version should be reused")
	}
}

func TestWaveDocumentHTTPRoundTrip(t *testing.T) {
	root := t.TempDir()
	htmlName := "VisualWaveDrom.html"
	if err := os.WriteFile(filepath.Join(root, htmlName), []byte("<!doctype html><title>test</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	libraryPath := filepath.Join(root, "Wave", "test-library", "library.sqlite")
	configuration := config{
		rootDir: root, htmlName: htmlName, htmlPath: filepath.Join(root, htmlName),
		configuredLibrary: libraryPath, configuredName: "test-library",
		waveDir: filepath.Join(root, "Wave"), statePath: filepath.Join(root, "Wave", ".visualwavedrom-state.json"),
		noOpen: true, port: 0,
	}
	instance, err := newService(configuration)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(instance.routes())
	defer server.Close()

	summary := requestJSON(t, http.MethodGet,
		server.URL+"/api/wave-library?summary=1&file=test-library", nil)
	documents := summary["documents"].([]any)
	if len(documents) != 1 {
		t.Fatalf("expected one default document, got %d", len(documents))
	}
	waveID := documents[0].(map[string]any)["name"].(string)
	libraryID := summary["libraryId"].(string)
	loaded := requestJSON(t, http.MethodGet, server.URL+"/api/wave-document?libraryId="+
		urlQueryEscape(libraryID)+"&waveId="+urlQueryEscape(waveID), nil)
	document := loaded["document"].(map[string]any)
	payload := map[string]any{
		"libraryId": libraryID, "waveId": waveID,
		"expectedRevision": document["revision"],
		"document": map[string]any{
			"content": document["content"], "hscale": 1.5, "waveEditMode": "modify",
		},
	}
	saved := requestJSON(t, http.MethodPatch, server.URL+"/api/wave-document", payload)
	if saved["ok"] != true {
		t.Fatalf("unexpected save response: %#v", saved)
	}
	savedDocument := saved["document"].(map[string]any)
	if savedDocument["hscale"] != 1.5 || intValue(savedDocument["revision"], -1) != 1 {
		t.Fatalf("document was not updated: %#v", savedDocument)
	}
}

func requestJSON(t *testing.T, method, address string, payload any) map[string]any {
	t.Helper()
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, address, body)
	if err != nil {
		t.Fatal(err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode >= 400 {
		t.Fatalf("HTTP %d: %#v", response.StatusCode, result)
	}
	return result
}

func urlQueryEscape(value string) string {
	return url.QueryEscape(value)
}
