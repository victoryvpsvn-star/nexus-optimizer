// Sakura Tool — bản Go (single-file exe, không Electron, không server con)
// Kiến trúc: 1 tiến trình duy nhất — HTTP server lắng nghe 127.0.0.1:<cổng ngẫu nhiên trống>,
// UI nhúng trong exe, mở cửa sổ WebView2 (Windows) hoặc trình duyệt mặc định (fallback).
// Không còn cổng cố định 32123 → không còn lỗi kẹt cổng / tiến trình zombie giữ cổng.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const AppVersion = "3.5.0"

// buildNumber: số run CI ghim qua -ldflags "-X main.buildNumber=..." (0 = build tay)
var buildNumber = "0"

var appState *Store

func main() {
	web := flag.Bool("web", false, "Chạy chế độ web (mở trình duyệt, không mở cửa sổ app)")
	port := flag.Int("port", 0, "Cổng HTTP cụ thể (mặc định: 32199 — bận thì thử +1…+10 rồi mới cổng trống bất kỳ)")
	flag.Parse()

	if p, e := os.Executable(); e == nil {
		_ = os.Remove(p + ".old") // dọn bản cũ còn sót sau khi tự cập nhật
	}
	appState = NewStore(dataDir())
	if err := appState.Load(); err != nil {
		log.Printf("[store] đọc config lỗi (dùng mặc định): %v", err)
	}
	appState.StartAutosave(3 * time.Second)

	// HTTP server — v3.4.1 fix: mặc định CỔNG CỐ ĐỊNH 32199. Trước đây mỗi lần mở chọn cổng
	// ngẫu nhiên → origin 127.0.0.1:PORT đổi liên tục → localStorage của UI (welcome seen,
	// ngôn ngữ, tinh chỉnh wallpaper) bị "mất" giữa các lần mở tool.
	mux := buildMux()
	var ln net.Listener
	var err error
	if *port > 0 {
		ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(*port)))
		if err != nil {
			log.Fatalf("Không mở được cổng HTTP %d: %v", *port, err)
		}
	} else {
		ln, err = net.Listen("tcp", "127.0.0.1:32199")
		if err != nil {
			for p := 32200; p <= 32210; p++ {
				ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(p)))
				if err == nil {
					break
				}
			}
		}
		if err != nil { // hết cổng dự phòng — giao OS chọn cổng trống bất kỳ
			ln, err = net.Listen("tcp", "127.0.0.1:0")
		}
		if err != nil {
			log.Fatalf("Không mở được cổng HTTP: %v", err)
		}
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server dừng: %v", err)
		}
	}()
	log.Printf("Sakura Tool %s (%s/%s) — %s — dữ liệu: %s", AppVersion, runtime.GOOS, runtime.GOARCH, baseURL, dataDir())

	// Mở UI: cửa sổ WebView2 trên Windows (không có runtime WebView2 → tự fallback trình duyệt);
	// --web hoặc không phải Windows → mở trình duyệt mặc định.
	if *web || runtime.GOOS != "windows" {
		openBrowser(baseURL)
		fmt.Println("Chế độ web đang chạy — mở", baseURL, "(Ctrl+C để thoát)")
		select {} // giữ tiến trình sống
	}
	if !runWebView(baseURL) {
		log.Printf("WebView2 không khả dụng — mở trình duyệt mặc định")
		openBrowser(baseURL)
		select {}
	}
}

/** Thư mục dữ liệu: %APPDATA%/Sakura Tool (Windows) hoặc NEXUS_DATA_DIR/XDG (khác) */
func dataDir() string {
	if v := os.Getenv("NEXUS_DATA_DIR"); v != "" {
		_ = os.MkdirAll(v, 0o755)
		return v
	}
	if runtime.GOOS == "windows" {
		if ad := os.Getenv("APPDATA"); ad != "" {
			p := filepath.Join(ad, "Sakura Tool")
			_ = os.MkdirAll(p, 0o755)
			return p
		}
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		p := filepath.Join(x, "nexus-optimizer")
		_ = os.MkdirAll(p, 0o755)
		return p
	}
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".local", "share", "nexus-optimizer")
	_ = os.MkdirAll(p, 0o755)
	return p
}
