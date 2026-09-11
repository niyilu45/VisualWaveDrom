package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const toolHistoryPath = "inc/visualwavedrom-history.json"

type toolCommit struct {
	ID    string `json:"id"`
	Date  string `json:"date"`
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
}

type toolHistoryRelease struct {
	Version     string       `json:"version"`
	Date        string       `json:"date"`
	Head        string       `json:"head,omitempty"`
	Notes       []string     `json:"notes,omitempty"`
	Commits     []toolCommit `json:"commits"`
	Uncommitted bool         `json:"uncommitted,omitempty"`
	Baseline    bool         `json:"baseline,omitempty"`
}

func readToolHistory(root string) []toolHistoryRelease {
	file := filepath.Join(root, filepath.FromSlash(toolHistoryPath))
	if plainToolPath(file) != nil {
		return nil
	}
	info, err := os.Stat(file)
	if err != nil || info.Size() > 8*1024*1024 {
		return nil
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var history []toolHistoryRelease
	if json.Unmarshal(data, &history) != nil {
		return nil
	}
	return history
}

func toolHistoryBetween(root, recorded, current, other string) []toolHistoryRelease {
	low, high := current, other
	if compareToolVersions(low, high) > 0 {
		low, high = high, low
	}
	all := low == high || low == ""
	byVersion := make(map[string]toolHistoryRelease)
	for _, directory := range []string{recorded, root} {
		if directory == "" {
			continue
		}
		for _, release := range readToolHistory(directory) {
			if !toolVersionPattern.MatchString(release.Version) {
				continue
			}
			if compareToolVersions(release.Version, high) <= 0 && (all || compareToolVersions(release.Version, low) > 0) {
				byVersion[release.Version] = release
			}
		}
	}
	result := make([]toolHistoryRelease, 0, len(byVersion))
	for _, release := range byVersion {
		result = append(result, release)
	}
	sort.Slice(result, func(i, j int) bool { return compareToolVersions(result[i].Version, result[j].Version) > 0 })
	return result
}

func formatToolHistory(history []toolHistoryRelease) string {
	if len(history) == 0 {
		return "\u8fd9\u4e24\u4e2a\u7248\u672c\u7684\u5de5\u5177\u5305\u6ca1\u6709\u63d0\u4f9b\u5bf9\u5e94\u7684\u63d0\u4ea4\u5386\u53f2\u3002"
	}
	var text strings.Builder
	for _, release := range history {
		fmt.Fprintf(&text, "v%s  %s\n", release.Version, release.Date)
		if release.Baseline {
			text.WriteString("\u9996\u6b21\u7f16\u53f7\u53d1\u5e03\uff0c\u5305\u542b\u6b64\u524d\u7684\u57fa\u7ebf\u63d0\u4ea4\u3002\n")
		}
		if release.Uncommitted {
			text.WriteString("\u542b\u5c1a\u672a\u63d0\u4ea4\u7684\u672c\u5730\u6539\u52a8\uff0c\u89c1\u529f\u80fd\u8bf4\u660e\u3002\n")
		}
		for _, note := range release.Notes {
			fmt.Fprintf(&text, "  * %s\n", note)
		}
		for _, commit := range release.Commits {
			id := commit.ID
			if len(id) > 8 {
				id = id[:8]
			}
			fmt.Fprintf(&text, "\n  [%s] %s\n  %s\n", id, commit.Date, commit.Title)
			if commit.Body != "" {
				fmt.Fprintf(&text, "  %s\n", strings.ReplaceAll(commit.Body, "\n", "\n  "))
			}
		}
		text.WriteString("\n")
	}
	return text.String()
}

func makeToolHistory(root, version, notes string) ([]toolHistoryRelease, error) {
	history := readToolHistory(root)
	var previous, existing *toolHistoryRelease
	for i := range history {
		item := &history[i]
		if item.Version == version {
			existing = item
		}
		if compareToolVersions(item.Version, version) < 0 && (previous == nil || compareToolVersions(item.Version, previous.Version) > 0) {
			previous = item
		}
	}
	release := toolHistoryRelease{Version: version, Date: time.Now().UTC().Format(time.RFC3339), Commits: []toolCommit{}, Baseline: previous == nil}
	if existing != nil && strings.TrimSpace(notes) == "" {
		release.Notes = existing.Notes
	}
	for _, note := range strings.Split(notes, "\n") {
		if strings.TrimSpace(note) != "" {
			release.Notes = append(release.Notes, strings.TrimSpace(note))
		}
	}
	head, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if err == nil {
		release.Head = strings.TrimSpace(string(head))
		revision := release.Head
		if previous != nil && len(previous.Head) == 40 {
			if exec.Command("git", "-C", root, "merge-base", "--is-ancestor", previous.Head, release.Head).Run() == nil {
				revision = previous.Head + ".." + release.Head
			}
		}
		output, e := exec.Command("git", "-C", root, "log", "-z", "--format=%H%x00%aI%x00%s%x00%b", revision).Output()
		if e != nil {
			return nil, e
		}
		fields := strings.Split(strings.TrimSuffix(string(output), "\x00"), "\x00")
		if len(fields)%4 != 0 && len(output) > 0 {
			return nil, fmt.Errorf("unexpected git history format")
		}
		for i := 0; i+3 < len(fields); i += 4 {
			release.Commits = append(release.Commits, toolCommit{ID: strings.TrimSpace(fields[i]), Date: fields[i+1], Title: fields[i+2], Body: strings.TrimSpace(fields[i+3])})
		}
		dirty, _ := exec.Command("git", "-C", root, "status", "--porcelain").Output()
		release.Uncommitted = len(dirty) > 0
	} else {
		release.Notes = append(release.Notes, "\u6784\u5efa\u65f6\u65e0\u6cd5\u8bfb\u53d6 Git \u63d0\u4ea4\u8bb0\u5f55\u3002")
	}
	result := []toolHistoryRelease{release}
	for _, item := range history {
		if item.Version != version {
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool { return compareToolVersions(result[i].Version, result[j].Version) > 0 })
	if err := writeJSONAtomically(filepath.Join(root, filepath.FromSlash(toolHistoryPath)), result); err != nil {
		return nil, err
	}
	return result, nil
}
