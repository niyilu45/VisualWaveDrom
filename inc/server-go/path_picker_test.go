package main

import (
	"errors"
	"testing"
)

func TestNativePathPickerSessionFailure(t *testing.T) {
	tests := []struct {
		name   string
		detail string
		want   bool
	}{
		{
			name:   "missing dbus launcher",
			detail: "Error spawning command line 'dbus-launch --autolaunch': No such file",
			want:   true,
		},
		{
			name:   "missing display",
			detail: "Gtk-WARNING **: cannot open display: :0",
			want:   true,
		},
		{
			name:   "harmless transient parent warning",
			detail: "Gtk-WARNING **: GtkDialog mapped without a transient parent",
			want:   false,
		},
		{
			name:   "dconf warning can accompany cancellation",
			detail: "failed to commit changes to dconf: Cannot autolaunch D-Bus without X11 $DISPLAY",
			want:   false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativePathPickerSessionFailure(test.detail); got != test.want {
				t.Fatalf("nativePathPickerSessionFailure(%q) = %v, want %v", test.detail, got, test.want)
			}
		})
	}
}

func TestNativePathPickerUnavailableWrapsSentinel(t *testing.T) {
	err := nativePathPickerUnavailable("  dbus-launch\nwas not found  ")
	if !errors.Is(err, errNativePathPickerUnavailable) {
		t.Fatalf("error %q does not wrap errNativePathPickerUnavailable", err)
	}
	if got, want := err.Error(), "native path picker unavailable: dbus-launch was not found"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
}
