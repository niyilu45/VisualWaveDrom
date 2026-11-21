package main

import "sync"

const browserOutputLimit = 16 * 1024

type browserOutputTail struct {
	mu   sync.Mutex
	data []byte
}

func (tail *browserOutputTail) Write(data []byte) (int, error) {
	count := len(data)
	tail.mu.Lock()
	defer tail.mu.Unlock()
	if len(data) >= browserOutputLimit {
		tail.data = append(tail.data[:0], data[len(data)-browserOutputLimit:]...)
	} else {
		if excess := len(tail.data) + len(data) - browserOutputLimit; excess > 0 {
			copy(tail.data, tail.data[excess:])
			tail.data = tail.data[:len(tail.data)-excess]
		}
		tail.data = append(tail.data, data...)
	}
	return count, nil
}

func (tail *browserOutputTail) String() string {
	tail.mu.Lock()
	defer tail.mu.Unlock()
	return string(tail.data)
}
