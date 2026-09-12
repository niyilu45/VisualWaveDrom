//go:build !windows

package main

import "runtime"

func (s *service) registerPlatformProtocol(handler string) {
	if runtime.GOOS == "linux" {
		s.registerLinuxProtocol(handler)
	}
}
