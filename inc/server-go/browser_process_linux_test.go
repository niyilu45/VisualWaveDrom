package main

import (
	"os/exec"
	"testing"
)

func TestBrowserUsesIndependentSession(t *testing.T) {
	command := exec.Command("browser")
	detachBrowserProcess(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.Setsid {
		t.Fatal("browser must not stay in the short-lived launcher's terminal session")
	}
}
