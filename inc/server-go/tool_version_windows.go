//go:build windows

package main

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

func lockToolFileNative(file string, exclusive bool) (func(), error) {
	name, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if exclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	overlap := new(windows.Overlapped)
	if err = windows.LockFileEx(handle, flags, 0, 1, 0, overlap); err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	return func() { windows.UnlockFileEx(handle, 0, 1, 0, overlap); windows.CloseHandle(handle) }, nil
}

func toolVersionDialog(message string, question bool) (bool, error) {
	text, err := windows.UTF16PtrFromString(message)
	if err != nil {
		return false, err
	}
	title, _ := windows.UTF16PtrFromString("VisualWaveDrom \u7248\u672c\u7ba1\u7406")
	flags := uintptr(0x00010000 | 0x00040000 | 0x00000040)
	if question {
		flags = 0x00010000 | 0x00040000 | 0x00000004 | 0x00000020 | 0x00000100
	}
	result, _, callErr := windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0,
		uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), flags)
	if result == 0 {
		return false, fmt.Errorf("cannot show version prompt: %v", callErr)
	}
	return result == 6, nil
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
	const dialogScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$form = [System.Windows.Forms.Form]::new()
$form.Text = $env:VWD_VERSION_TITLE
$form.StartPosition = 'CenterScreen'
$form.Size = [System.Drawing.Size]::new(720, 380)
$form.MinimumSize = [System.Drawing.Size]::new(560, 340)
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)
$form.TopMost = $true
$form.Padding = [System.Windows.Forms.Padding]::new(12)
$actions = [System.Windows.Forms.FlowLayoutPanel]::new()
$actions.Dock = 'Bottom'
$actions.Height = 48
$actions.FlowDirection = 'RightToLeft'
$skip = [System.Windows.Forms.Button]::new()
$skip.Text = $env:VWD_VERSION_SKIP
$skip.AutoSize = $true
$skip.DialogResult = 'No'
$update = [System.Windows.Forms.Button]::new()
$update.Text = $env:VWD_VERSION_UPDATE
$update.AutoSize = $true
$update.DialogResult = 'Yes'
$view = [System.Windows.Forms.Button]::new()
$view.Text = $env:VWD_VERSION_HISTORY
$view.AutoSize = $true
$actions.Controls.AddRange(@($skip, $update, $view))
$body = [System.Windows.Forms.TextBox]::new()
$body.Multiline = $true
$body.ReadOnly = $true
$body.ScrollBars = 'Vertical'
$body.Dock = 'Fill'
$body.BorderStyle = 'None'
$body.Text = $env:VWD_VERSION_MESSAGE
$view.Add_Click({
 if ($view.Tag -eq 'history') {
  $body.Text = $env:VWD_VERSION_MESSAGE
  $view.Text = $env:VWD_VERSION_HISTORY
  $view.Tag = ''
 } else {
  $body.Text = [System.IO.File]::ReadAllText($env:VWD_VERSION_HISTORY_FILE, [System.Text.Encoding]::UTF8).Replace([string][char]10, ([string][char]13 + [char]10))
  $view.Text = $env:VWD_VERSION_BACK
  $view.Tag = 'history'
  $area = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
  $form.Size = [System.Drawing.Size]::new([Math]::Min(940, $area.Width - 32), [Math]::Min(760, $area.Height - 48))
  $form.Location = [System.Drawing.Point]::new($area.Left + ($area.Width - $form.Width) / 2, $area.Top + ($area.Height - $form.Height) / 2)
 }
 $body.SelectionStart = 0
 $body.SelectionLength = 0
 $body.ScrollToCaret()
})
$form.Controls.Add($body)
$form.Controls.Add($actions)
$form.AcceptButton = $skip
$form.CancelButton = $skip
try {
 if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Write('yes') }
} finally { $form.Dispose() }
`
	command := exec.Command("powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", dialogScript)
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	command.Env = append(os.Environ(), "VWD_VERSION_MESSAGE="+strings.ReplaceAll(message, "\n", "\r\n"), "VWD_VERSION_HISTORY_FILE="+historyFile,
		"VWD_VERSION_TITLE=VisualWaveDrom \u7248\u672c\u66f4\u65b0", "VWD_VERSION_SKIP=\u6682\u4e0d\u66f4\u65b0", "VWD_VERSION_UPDATE=\u7acb\u5373\u66f4\u65b0", "VWD_VERSION_HISTORY=\u67e5\u770b\u7248\u672c\u5386\u53f2", "VWD_VERSION_BACK=\u8fd4\u56de\u66f4\u65b0\u8bf4\u660e")
	output, err := command.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("version confirmation failed: %s (%w)", strings.TrimSpace(string(output)), err)
	}
	return strings.TrimSpace(string(output)) == "yes", nil
}
