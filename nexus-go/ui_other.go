//go:build !windows

// Platform: không phải Windows (dev/test trên Linux) — flag runtime, stub ẩn cửa sổ, mở trình duyệt.
package main

import (
	"log"
	"os/exec"
)

var runtimeIsWindows = false

func setHideWindow(c *exec.Cmd) {}

func runWebView(baseURL string) bool { return false }

func openBrowser(url string) {
	try := [][]string{
		{"xdg-open", url},
		{"x-www-browser", url},
	}
	for _, argv := range try {
		c := exec.Command(argv[0], argv[1:]...)
		if err := c.Start(); err == nil {
			return
		}
	}
	log.Printf("Không mở được trình duyệt — hãy mở tay: %s", url)
}
