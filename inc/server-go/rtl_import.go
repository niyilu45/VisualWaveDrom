package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func rtlUSDBConverter() (string, error) {
	for _, env := range []string{"UVD_HOME", "UVS_HOME"} {
		if home := strings.TrimSpace(os.Getenv(env)); filepath.IsAbs(home) {
			if path, err := exec.LookPath(filepath.Join(home, "bin", "usdb2vcd")); err == nil {
				return path, nil
			}
		}
	}
	return exec.LookPath("usdb2vcd")
}

type rtlToolLog []byte

func (log *rtlToolLog) Write(p []byte) (int, error) {
	*log = append(*log, p[:min(len(p), 4096-len(*log))]...)
	return len(p), nil
}

func convertRTLUSDB(ctx context.Context, executable, source, output, signal string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := []string{"-i", source}
	if signal != "" {
		args = append(args, "-signal", signal)
	}
	args = append(args, "-vcd", output)
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = filepath.Dir(output)
	cmd.WaitDelay = 2 * time.Second
	var log rtlToolLog
	cmd.Stdout, cmd.Stderr = &log, &log
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if info, err := os.Stat(output); err == nil && info.Size() > importMaxUploadBytes {
				cancel()
				<-done
				return errors.New("转换后的 VCD 超过 128 MiB，请缩小导出范围")
			}
		case err := <-done:
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				details := strings.TrimSpace(string(log))
				if details == "" {
					details = err.Error()
				}
				return errors.New(details)
			}
			return nil
		}
	}
}

func (s *service) handleRTLImport(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, details string) { sendJSON(w, status, map[string]string{"error": details}) }
	if r.Header.Get("X-VWD-RTL-Import") != "1" {
		fail(http.StatusForbidden, "无效的 RTL 导入请求")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, r.Host) {
			fail(http.StatusForbidden, "RTL 导入只允许从本地服务页面发起")
			return
		}
	}
	query := r.URL.Query()
	name, path, signal := query.Get("name"), strings.TrimSpace(query.Get("path")), strings.TrimSpace(query.Get("signal"))
	if path != "" {
		if !filepath.IsAbs(path) {
			fail(http.StatusBadRequest, "请输入 RTL 文件的绝对路径")
			return
		}
		path = filepath.Clean(path)
		name = path
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext != ".usdb" && (path == "" || ext != ".txt" && ext != ".vcd") {
		fail(http.StatusBadRequest, "请选择 TXT、VCD 或 USDB 文件")
		return
	}
	if signal != "" && (len(signal) > 1024 || strings.HasPrefix(signal, "-") || strings.ContainsAny(signal, "\r\n\x00")) {
		fail(http.StatusBadRequest, "USDB 信号名无效")
		return
	}
	var size int64
	if path != "" {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			fail(http.StatusBadRequest, "RTL 文件不存在或不是普通文件")
			return
		}
		size = info.Size()
	}
	if ext == ".usdb" {
		executable, err := rtlUSDBConverter()
		if err != nil {
			fail(http.StatusServiceUnavailable, "未找到 usdb2vcd。请安装 UniVista UVD 工具并将其 bin 加入 PATH，或先在 UVD 中导出 VCD/TXT")
			return
		}
		dir, err := os.MkdirTemp("", "vwd-rtl-")
		if err != nil {
			fail(http.StatusInternalServerError, "无法创建 RTL 转换临时目录")
			return
		}
		defer os.RemoveAll(dir)
		if path == "" {
			path = filepath.Join(dir, "input.usdb")
			f, createErr := os.Create(path)
			if createErr != nil {
				fail(http.StatusInternalServerError, "无法暂存 USDB 文件")
				return
			}
			defer r.Body.Close()
			written, copyErr := io.Copy(f, http.MaxBytesReader(w, r.Body, importMaxUploadBytes))
			closeErr := f.Close()
			if copyErr != nil || closeErr != nil || written == 0 {
				var maxErr *http.MaxBytesError
				if errors.As(copyErr, &maxErr) {
					fail(http.StatusRequestEntityTooLarge, "USDB 上传超过 128 MiB，请粘贴本地文件路径")
				} else {
					fail(http.StatusBadRequest, "无法读取上传的 USDB 文件")
				}
				return
			}
		}
		output := filepath.Join(dir, "output.vcd")
		if err := convertRTLUSDB(r.Context(), executable, path, output, signal); err != nil {
			hint := ""
			if signal == "" {
				hint = "；如果该版本要求指定信号，可填写 USDB 信号名后重试"
			}
			fail(http.StatusUnprocessableEntity, "USDB 转换失败："+err.Error()+hint)
			return
		}
		info, err := os.Stat(output)
		if err != nil || info.Size() == 0 || !info.Mode().IsRegular() {
			fail(http.StatusUnprocessableEntity, "USDB 转换未生成 VCD 文件")
			return
		}
		path, size = output, info.Size()
	}
	if size > importMaxUploadBytes {
		fail(http.StatusRequestEntityTooLarge, "RTL 文本超过 128 MiB，请缩小导出范围")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		fail(http.StatusBadRequest, "无法打开 RTL 文件")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, io.LimitReader(f, size))
}
