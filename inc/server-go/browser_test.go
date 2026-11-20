package main

import (
	"bytes"
	"flag"
	"log"
	"os"
	"reflect"
	"testing"
)

func TestBrowserSelectionCommands(t *testing.T) {
	address := "http://127.0.0.1:4173/VisualWaveDrom.html?libraryId=a&waveId=b"
	for _, test := range []struct {
		selection string
		names     []string
	}{
		{"firefox", []string{"firefox"}},
		{"chrome", []string{"google-chrome", "google-chrome-stable"}},
		{"chromium", []string{"chromium", "chromium-browser"}},
		{"edge", []string{"microsoft-edge", "microsoft-edge-stable"}},
		{"/opt/Browser App/firefox", []string{"/opt/Browser App/firefox"}},
		{"firefox; echo unexpected", []string{"firefox; echo unexpected"}},
	} {
		commands := browserCommands("linux", address, test.selection)
		want := make([][]string, 0, len(test.names))
		for _, name := range test.names {
			want = append(want, []string{name, address})
		}
		if !reflect.DeepEqual(commands, want) {
			t.Errorf("%q: got %#v, want %#v", test.selection, commands, want)
		}
	}
	for _, platform := range []string{"linux", "windows", "darwin"} {
		for _, selection := range []string{"default", "system", " DEFAULT "} {
			if !reflect.DeepEqual(browserCommands(platform, address, selection), browserCommands(platform, address, "")) {
				t.Errorf("%s %q should use the existing system default", platform, selection)
			}
		}
	}
}

func TestBrowserFlagAndNoOpenPriority(t *testing.T) {
	oldArgs, oldFlags := os.Args, flag.CommandLine
	oldLog := log.Writer()
	t.Cleanup(func() {
		os.Args, flag.CommandLine = oldArgs, oldFlags
		log.SetOutput(oldLog)
	})
	flag.CommandLine = flag.NewFlagSet("browser-test", flag.ContinueOnError)
	os.Args = []string{"server", "--root", t.TempDir(), "--browser", "/opt/Browser App/firefox", "--no-open"}
	configuration, err := parseConfig()
	if err != nil || configuration.browser != "/opt/Browser App/firefox" || !configuration.noOpen {
		t.Fatalf("browser flag: %#v %v", configuration, err)
	}
	var output bytes.Buffer
	log.SetOutput(&output)
	openBrowser("not-a-valid-url", true, "/not/an/executable")
	if output.Len() != 0 {
		t.Fatalf("--no-open must skip browser selection and launch entirely: %s", output.String())
	}
}
