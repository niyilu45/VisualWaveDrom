package main

import (
	"errors"
	"fmt"
	"strings"
)

var errNativePathPickerUnavailable = errors.New("native path picker unavailable")

func nativePathPickerUnavailable(detail string) error {
	detail = strings.Join(strings.Fields(strings.TrimSpace(detail)), " ")
	if detail == "" {
		return errNativePathPickerUnavailable
	}
	return fmt.Errorf("%w: %s", errNativePathPickerUnavailable, detail)
}

func nativePathPickerSessionFailure(detail string) bool {
	normalized := strings.ToLower(detail)
	for _, marker := range []string{
		"dbus-launch",
		"cannot open display",
		"failed to open display",
		"could not connect to display",
		"unable to init server",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}
