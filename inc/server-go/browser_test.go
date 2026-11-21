package main

import (
	"bytes"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestBrowserSelectionCommands(t *testing.T) {
	address := "http://127.0.0.1:4173/VisualWaveDrom.html?libraryId=a&waveId=b"
	for _, test := range []struct {
		selection string
		names     []string
	}{
		{"firefox", []string{"firefox"}},
		{"chrome", []string{"chrome", "google-chrome", "google-chrome-stable"}},
		{"chromium", []string{"chromium", "chromium-browser"}},
		{"edge", []string{"microsoft-edge", "microsoft-edge-stable"}},
		{"/opt/Browser App/firefox", []string{"/opt/Browser App/firefox"}},
		{"/opt/浏览器/chrome", []string{"/opt/浏览器/chrome"}},
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

func TestBrowserLaunchOutlivesLauncher(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux browser lifetime regression")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "browser-ready")
	output, err := os.Create(filepath.Join(directory, "browser.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	command := exec.Command(executable, "-test.run=TestBrowserLifecycleHelper", "--", "launcher")
	command.Env = append(os.Environ(), "VWD_BROWSER_LIFECYCLE_TEST=1", "VWD_BROWSER_READY="+marker)
	command.Stderr = output
	if err = command.Run(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(marker); err == nil {
			data, _ := os.ReadFile(output.Name())
			if !strings.Contains(string(data), "late browser startup log") {
				t.Fatal("browser output did not survive the launcher")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("browser died after launcher exit, before completing cold startup")
}

func TestBrowserLifecycleHelper(t *testing.T) {
	if os.Getenv("VWD_BROWSER_LIFECYCLE_TEST") != "1" {
		return
	}
	if os.Args[len(os.Args)-1] == "browser" {
		time.Sleep(300 * time.Millisecond)
		fmt.Fprintln(os.Stderr, "late browser startup log")
		if err := os.WriteFile(os.Getenv("VWD_BROWSER_READY"), []byte("ready"), 0o600); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	executable, _ := os.Executable()
	if err := launchBrowserCommand([]string{executable, "-test.run=TestBrowserLifecycleHelper", "--", "browser"}, 10*time.Millisecond); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
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
