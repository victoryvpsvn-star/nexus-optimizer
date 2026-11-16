// presence_install.go — nút "Tự cài đặt" extension Cat Status (kiểu PreMiD) trong Settings.
// Chrome/Edge KHÔNG cho cài extension tự động từ ngoài (chính sách bảo mật), nên tool làm sẵn
// phần khó nhất: bung extension vào Downloads\Sakura-Cat-Status + mở hướng dẫn 3 bước.
package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed extension/cat-status/*
var catStatusFS embed.FS

/** Bung extension Cat Status ra Downloads/Sakura-Cat-Status, trả về (path, hướng dẫn) */
func presenceInstallExtension() (string, string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "Không tìm được thư mục home: " + err.Error()
	}
	dest := filepath.Join(home, "Downloads", "Sakura-Cat-Status")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return "", "Không tạo được thư mục " + dest + ": " + err.Error()
	}
	root := "extension/cat-status"
	n := 0
	err = fs.WalkDir(catStatusFS, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out := filepath.Join(dest, rel)
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		f, err := catStatusFS.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		o, err := os.Create(out)
		if err != nil {
			return err
		}
		defer o.Close()
		if _, err := io.Copy(o, f); err != nil {
			return err
		}
		n++
		return nil
	})
	if err != nil {
		return dest, "Bung extension lỗi: " + err.Error()
	}
	guide := "✅ Đã bung " + fmt.Sprint(n) + " file vào: " + dest + "\n" +
		"Cài 3 bước (Chrome/Edge không cho cài tự động từ ngoài — chính sách bảo mật của trình duyệt):\n" +
		"1. Mở trình duyệt → gõ chrome://extensions (Edge: edge://extensions)\n" +
		"2. Bật 'Developer mode' (góc phải trên)\n" +
		"3. 'Load unpacked' → chọn folder " + dest + " → done. Status nhạc/video kiểu PreMiD đã chạy."
	return dest, strings.ReplaceAll(guide, "\\n", "\n")
}

func presenceDirLabel() string {
	if runtime.GOOS == "windows" {
		return "%USERPROFILE%\\Downloads\\Sakura-Cat-Status"
	}
	return "~/Downloads/Sakura-Cat-Status"
}
