//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func pickLocalPathNative(kind, initialPath string) (string, bool, error) {
	switch kind {
	case "folder", "preset", "save-preset":
	default:
		return "", false, fmt.Errorf("unsupported path picker kind %q", kind)
	}

	const pickerScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms

$kind = $env:VWD_PICKER_KIND
$initial = $env:VWD_PICKER_INITIAL
$initialDirectory = $initial
$initialFile = ''
if ($initial -and [System.IO.File]::Exists($initial)) {
    $initialDirectory = [System.IO.Path]::GetDirectoryName($initial)
    $initialFile = [System.IO.Path]::GetFileName($initial)
} elseif ($initial -and [System.IO.Path]::HasExtension($initial)) {
    $initialDirectory = [System.IO.Path]::GetDirectoryName($initial)
    $initialFile = [System.IO.Path]::GetFileName($initial)
}
if (-not $initialDirectory -or -not [System.IO.Directory]::Exists($initialDirectory)) {
    $initialDirectory = [Environment]::CurrentDirectory
}

$owner = [System.Windows.Forms.Form]::new()
$owner.Text = 'VisualWaveDrom file picker'
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.Size = [System.Drawing.Size]::new(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
[System.Windows.Forms.Application]::DoEvents()

$selected = ''
try {
    if ($kind -eq 'folder') {
        $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
        $dialog.Description = '选择波形数据文件夹'
        $dialog.ShowNewFolderButton = $false
        $dialog.SelectedPath = $initialDirectory
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $selected = $dialog.SelectedPath
        }
    } elseif ($kind -eq 'preset') {
        $dialog = [System.Windows.Forms.OpenFileDialog]::new()
        $dialog.Title = '选择预设集合 JSON'
        $dialog.Filter = 'JSON 预设 (*.json)|*.json|所有文件 (*.*)|*.*'
        $dialog.InitialDirectory = $initialDirectory
        $dialog.FileName = $initialFile
        $dialog.CheckFileExists = $true
        $dialog.Multiselect = $false
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $selected = $dialog.FileName
        }
    } else {
        $dialog = [System.Windows.Forms.SaveFileDialog]::new()
        $dialog.Title = '保存预设集合 JSON'
        $dialog.Filter = 'JSON 预设 (*.json)|*.json|所有文件 (*.*)|*.*'
        $dialog.DefaultExt = 'json'
        $dialog.AddExtension = $true
        $dialog.OverwritePrompt = $true
        $dialog.InitialDirectory = $initialDirectory
        $dialog.FileName = $initialFile
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $selected = $dialog.FileName
        }
    }
} finally {
    if ($null -ne $dialog) {
        $dialog.Dispose()
    }
    $owner.Close()
    $owner.Dispose()
}
[Console]::Write($selected)
`

	command := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-STA",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		pickerScript,
	)
	const createNoWindow = 0x08000000
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	command.Env = append(
		os.Environ(),
		"VWD_PICKER_KIND="+kind,
		"VWD_PICKER_INITIAL="+initialPath,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			return "", false, fmt.Errorf("path picker failed: %w", err)
		}
		return "", false, fmt.Errorf("path picker failed: %s", detail)
	}
	selected := strings.TrimSpace(strings.TrimPrefix(string(output), "\ufeff"))
	return selected, selected == "", nil
}
