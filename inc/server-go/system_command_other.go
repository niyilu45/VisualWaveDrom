//go:build !windows

package main

func systemExecutable(name string) (string, error) {
	return name, nil
}
