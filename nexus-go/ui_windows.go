//go:build windows

// Platform: Windows — runtime flags, ẩn cửa sổ process con, WebView2 UI, mở trình duyệt.
// Cửa sổ tự detect màn hình (GetSystemMetrics) và bị chặn TỐI ĐA trong vùng làm việc —
// hết cảnh thanh tiêu đề (nút X) bị văng khỏi màn hình trên laptop màn nhỏ.
package main

import (
	"log"
	"os/exec"
	"runtime"
	"syscall"

	"github.com/jchv/go-webview2"
)

var runtimeIsWindows = true

func setHideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

/** Kích thước màn hình chính (pixel logic của process — trùng hệ quy chiếu CreateWindow) */
func screenMetrics() (w, h int) {
	u32 := syscall.NewLazyDLL("user32.dll")
	gsm := u32.NewProc("GetSystemMetrics")
	const smCxScreen, smCyScreen = 0, 1
	cx, _, _ := gsm.Call(uintptr(smCxScreen))
	cy, _, _ := gsm.Call(uintptr(smCyScreen))
	return int(int32(cx)), int(int32(cy))
}

/** Fit kích thước cửa sổ vào màn hình: không bao giờ to hơn màn (trừ 24px ngang,
 * 72px dọc cho taskbar + margin) — nút đóng luôn nằm trong vùng nhìn thấy. */
func fitToScreen(w, h int) (int, int) {
	sw, sh := screenMetrics()
	if sw > 0 && w > sw-24 {
		w = sw - 24
	}
	if sh > 0 && h > sh-72 {
		h = sh - 72
	}
	if w < 640 {
		w = 640
	}
	if h < 480 {
		h = 480
	}
	return w, h
}

/** Mở cửa sổ WebView2 trỏ tới URL nội bộ; trả false nếu runtime WebView2 thiếu/lỗi */
func runWebView(baseURL string) bool {
	w, h := fitToScreen(1360, 860)
	// Thử tạo webview — thiếu WebView2 Runtime (Win10/11 cũ chưa cập nhật) sẽ trả nil → fallback
	done := make(chan bool, 1)
	go func() {
		// FIX "No Responding": HWND phải được tạo VÀ bơm message trên CÙNG MỘT thread OS.
		// go-webview2 không tự LockOSThread — scheduler dời goroutine sang thread khác là
		// GetMessage bơm nhầm queue → cửa sổ treo trắng kiểu "Not Responding" ngẫu nhiên.
		runtime.LockOSThread()
		wv := webview2.NewWithOptions(webview2.WebViewOptions{
			Debug:     false,
			AutoFocus: true,
			WindowOptions: webview2.WindowOptions{
				Title:  "Sakura Tool " + AppVersion,
				Width:  uint(w),
				Height: uint(h),
				Center: true,
				IconId: 2,
			},
		})
		if wv == nil {
			done <- false
			return
		}
		defer wv.Destroy()
		wv.SetTitle("Sakura Tool " + AppVersion)
		// Chốt lại kích thước sau khi window đã tạo (phòng DPI/màn hình khác mặc định)
		wv.SetSize(w, h, webview2.HintNone)
		wv.Navigate(baseURL)
		wv.Init(`window.addEventListener('keydown',function(e){if(e.key==='F5'){location.reload();}});`)
		wv.Run()
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
