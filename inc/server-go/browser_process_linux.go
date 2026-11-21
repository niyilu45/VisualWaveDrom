package main

import (
	"os/exec"
	"syscall"
)

func detachBrowserProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
