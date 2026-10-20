package main

import (
	"testing"
	"time"
)

func newClientTestService(t *testing.T) *service {
	t.Helper()
	instance := &service{clients: make(map[string]clientLease)}
	t.Cleanup(func() {
		instance.clientMu.Lock()
		defer instance.clientMu.Unlock()
		instance.stopClientTimerLocked()
	})
	return instance
}

func TestClientHeartbeatPreservesStreamToken(t *testing.T) {
	instance := newClientTestService(t)
	instance.touchClient("page", "stream")
	instance.touchClient("page", "heartbeat")
	if got := instance.clients["page"].token; got != "stream" {
		t.Fatalf("heartbeat replaced the active stream token: %q", got)
	}
}

func TestStreamDisconnectRetainsHeartbeatLease(t *testing.T) {
	instance := newClientTestService(t)
	instance.touchClient("page", "stream")
	if got := instance.removeClient("page", "stream", false); got != 1 {
		t.Fatalf("interrupted stream removed the open page: %d clients", got)
	}
	lease := instance.clients["page"]
	if lease.token != "heartbeat" || time.Since(lease.lastSeen) >= clientShutdownDelay {
		t.Fatalf("interrupted stream did not retain a fresh heartbeat lease: %+v", lease)
	}
	instance.touchClient("page", "heartbeat")
	if got := instance.removeClient("page", "", true); got != 0 {
		t.Fatalf("explicit page close retained %d clients", got)
	}
	instance.removeClient("page", "stream", false)
	if len(instance.clients) != 0 {
		t.Fatal("late stream cleanup resurrected a closed page")
	}
}

func TestOldStreamCannotRemoveReplacementOrOtherPage(t *testing.T) {
	instance := newClientTestService(t)
	instance.touchClient("page", "old-stream")
	instance.touchClient("page", "new-stream")
	instance.touchClient("other", "other-stream")
	instance.removeClient("page", "old-stream", false)
	if instance.clients["page"].token != "new-stream" {
		t.Fatal("old stream cleanup changed the replacement stream")
	}
	if got := instance.removeClient("page", "", true); got != 1 {
		t.Fatalf("closing one page affected the other: %d clients", got)
	}
}

func TestInterruptedStreamLeaseStillExpires(t *testing.T) {
	instance := newClientTestService(t)
	instance.touchClient("page", "stream")
	instance.removeClient("page", "stream", false)
	lease := instance.clients["page"]
	instance.pruneExpiredClientsLocked(lease.lastSeen.Add(clientLeaseTimeout))
	if len(instance.clients) != 0 {
		t.Fatal("orphaned interrupted stream never expired")
	}
}
