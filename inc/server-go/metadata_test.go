package main

import (
	"reflect"
	"testing"
)

func TestDocumentMetadataWithUnmaterializedSignals(t *testing.T) {
	content := `{"title":" Example ","description":"two\nlines","head":{"text":"head"},"parameterTables":{"ids":["table-a"]},"signal":[{"scope":{"samples":[1,2,3,null]}}]}`
	title, description, links, err := documentMetadata(content, "fallback")
	if err != nil || title != "Example" || description != "two\nlines" ||
		!reflect.DeepEqual(links, map[string]any{"ids": []any{"table-a"}}) {
		t.Fatalf("metadata changed: %q %q %#v %v", title, description, links, err)
	}
	title, _, _, err = documentMetadata(`{"title":{},"head":{"text":" Header "}}`, "fallback")
	if err != nil || title != "Header" {
		t.Fatalf("head fallback changed: %q %v", title, err)
	}
	for _, invalid := range []string{`null`, `[]`, `"text"`, `{"signal":[{"scope":{"samples":[1,]}}]}`} {
		if _, _, _, err := documentMetadata(invalid, "fallback"); err == nil {
			t.Fatalf("invalid document accepted: %s", invalid)
		}
	}
}
