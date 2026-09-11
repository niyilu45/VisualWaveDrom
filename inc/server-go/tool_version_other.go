//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func lockToolFileNative(file string, exclusive bool) (func(), error) {
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	operation := unix.LOCK_SH
	if exclusive {
		operation = unix.LOCK_EX
	}
	if err = unix.Flock(int(handle.Fd()), operation|unix.LOCK_NB); err != nil {
		handle.Close()
		return nil, err
	}
	return func() { unix.Flock(int(handle.Fd()), unix.LOCK_UN); handle.Close() }, nil
}

func toolVersionDialog(message string, question bool) (bool, error) {
	if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		for _, program := range []string{"zenity", "kdialog"} {
			executable, err := exec.LookPath(program)
			if err != nil {
				continue
			}
			args := []string{"--info", "--title=VisualWaveDrom", "--text=" + message}
			if question {
				args[0] = "--question"
				args = append(args, "--default-cancel")
			}
			if program == "kdialog" {
				mode := "--msgbox"
				if question {
					mode = "--yesno"
				}
				args = []string{mode, message, "--title", "VisualWaveDrom"}
			}
			err = exec.Command(executable, args...).Run()
			if err == nil {
				return question, nil
			}
			if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
				return false, nil
			}
		}
	}
	fmt.Println(message)
	if !question {
		return false, nil
	}
	fmt.Print("Confirm [y/N]: ")
	reply, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.EqualFold(strings.TrimSpace(reply), "y"), nil
}

func toolVersionUpdateDialog(message, history string) (bool, error) {
	directory, err := os.MkdirTemp(filepath.Join(defaultRootDir(), ".tmp"), "version-dialog-")
	if err != nil {
		return false, err
	}
	defer os.RemoveAll(directory)
	historyFile := filepath.Join(directory, "history.txt")
	if err = os.WriteFile(historyFile, []byte(history), 0o600); err != nil {
		return false, err
	}
	for {
		if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
			if executable, e := exec.LookPath("zenity"); e == nil {
				output, e := exec.Command(executable, "--question", "--title=VisualWaveDrom", "--text="+message, "--ok-label=\u7acb\u5373\u66f4\u65b0", "--cancel-label=\u6682\u4e0d\u66f4\u65b0", "--extra-button=\u67e5\u770b\u7248\u672c\u5386\u53f2", "--default-cancel").Output()
				if strings.TrimSpace(string(output)) == "\u67e5\u770b\u7248\u672c\u5386\u53f2" {
					_ = exec.Command(executable, "--text-info", "--title=\u7248\u672c\u5386\u53f2", "--filename="+historyFile, "--width=900", "--height=700").Run()
					continue
				}
				if e == nil {
					return true, nil
				}
				if exit, ok := e.(*exec.ExitError); ok && exit.ExitCode() == 1 {
					return false, nil
				}
			}
		}
		fmt.Println(message)
		fmt.Print("Update [y/N], history [h]: ")
		reply, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		switch strings.ToLower(strings.TrimSpace(reply)) {
		case "y":
			return true, nil
		case "h":
			fmt.Println(history)
		default:
			return false, nil
		}
	}
}
