package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestImportResourcesUnderInc(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	manager := newImportManager(root)
	if _, err := os.Stat(manager.fileProcPath); err != nil {
		t.Fatalf("relocated Python parser is missing: %v", err)
	}
	catalog := manager.listSchemes()
	if len(catalog.Schemes) != 4 || len(catalog.Invalid) != 0 {
		t.Fatalf("relocated parser presets were not loaded: %#v", catalog)
	}
	expected := canonicalExistingPath(filepath.Join(root, "inc", "import", "Data", "basic-signal.txt"))
	for _, path := range []string{
		"Data/basic-signal.txt",
		"import/Data/basic-signal.txt",
		"inc/import/Data/basic-signal.txt",
		`inc\import\Data\basic-signal.txt`,
	} {
		resolved, err := manager.resolveSource(path)
		if err != nil || resolved != expected {
			t.Fatalf("resolve %q = %q, %v; expected %q", path, resolved, err, expected)
		}
	}
	for _, path := range []string{
		"../server-go/main.go",
		"import/../../VisualWaveDrom.html",
		"inc/import/../../VisualWaveDrom.html",
	} {
		if _, err := manager.resolveSource(path); err == nil {
			t.Fatalf("source escaped the import directory: %q", path)
		}
	}
	document, _, err := loadCollectionPresetDocument("inc/import/SchemeCollection/example.json", root)
	if err != nil || !document.Valid {
		t.Fatalf("relocated collection example was not loaded: %v, %#v", err, document)
	}
}

func TestRememberedImportPathsFollowMove(t *testing.T) {
	root := t.TempDir()
	importRoot := filepath.Join(root, "inc", "import")
	dataDir := filepath.Join(importRoot, "Data")
	presetDir := filepath.Join(importRoot, "SchemeCollection")
	for _, directory := range []string{dataDir, presetDir} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	source := filepath.Join(dataDir, "sample.txt")
	if err := os.WriteFile(source, []byte("0\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"import/Data/sample.txt",
		filepath.Join(root, "import", "Data", "sample.txt"),
		"inc/import/Data/sample.txt",
	} {
		resolved, _, err := resolvePastedImportPath(path, root)
		if err != nil || resolved != source {
			t.Fatalf("remembered source %q = %q, %v", path, resolved, err)
		}
	}
	for _, test := range []struct{ path, want string }{
		{"import/SchemeCollection", presetDir},
		{filepath.Join(root, "import", "SchemeCollection"), presetDir},
		{"import/SchemeCollection/new.json", filepath.Join(presetDir, "new.json")},
		{"import-other/example.json", filepath.Join(root, "import-other", "example.json")},
	} {
		resolved, err := normalizeLocalPathInput(test.path, root)
		if err != nil || resolved != test.want {
			t.Fatalf("remembered preset path %q = %q, %v; expected %q", test.path, resolved, err, test.want)
		}
	}
	resolved, err := resolveCollectionRoot("import/SchemeCollection", root)
	if err != nil || resolved != canonicalExistingPath(presetDir) {
		t.Fatalf("remembered preset search directory = %q, %v", resolved, err)
	}
	legacyRoot := filepath.Join(root, "import")
	if err := os.Mkdir(legacyRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(legacyRoot, "sample.txt")
	if resolved := relocateLegacyImportPath(legacyPath, root); resolved != legacyPath {
		t.Fatalf("an existing user import directory was redirected to %q", resolved)
	}
}
