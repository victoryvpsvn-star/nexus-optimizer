//go:build windows

// Platform: Windows — runtime flags, ẩn cửa sổ process con, WebView2 UI, mở trình duyệt.
package main

import (
	"log"
	"os/exec"
	"syscall"

	"github.com/jchv/go-webview2"
)

var runtimeIsWindows = true

func setHideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

/** Mở cửa sổ WebView2 trỏ tới URL nội bộ; trả false nếu runtime WebView2 thiếu/lỗi */
func runWebView(baseURL string) bool {
	// Thử tạo webview — thiếu WebView2 Runtime (Win10/11 cũ chưa cập nhật) sẽ trả nil → fallback
	done := make(chan bool, 1)
	go func() {
		w := webview2.NewWithOptions(webview2.WebViewOptions{
			Debug:     false,
			AutoFocus: true,
			WindowOptions: webview2.WindowOptions{
				Title:  "NEXUS Optimizer " + AppVersion,
				Width:  1440,
				Height: 920,
				Center: true,
				IconId: 2,
			},
		})
		if w == nil {
			done <- false
			return
		}
		defer w.Destroy()
		w.SetTitle("NEXUS Optimizer " + AppVersion)
		w.Navigate(baseURL)
		// Nhấn F5 trong app = refresh; AuthoredJS tha lỗi không cần Bind
		w.Init(`window.addEventListener('keydown',function(e){if(e.key==='F5'){location.reload();}});`)
		w.Run()
		done <- true
	}()
	return <-done
}

/** Mở URL bằng trình duyệt mặc định (cmd start) — fallback khi thiếu WebView2 hoặc --web */
func openBrowser(url string) {
	c := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	if err := c.Start(); err != nil {
		log.Printf("Không mở được trình duyệt: %v — hãy mở tay: %s", err, url)
	}
}
