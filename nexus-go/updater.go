// updater.go — tính năng tự cập nhật: kiểm tra release go-vN mới nhất trên GitHub,
// tải exe mới, hoán đổi file đang chạy (rename .old — Windows cho phép đổi tên file
// đang chạy) rồi tự khởi động lại tiến trình mới. Số bản = số run CI (buildNumber
// ghim qua -ldflags -X main.buildNumber trong workflow).
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// updateMtx: chống double-apply updater
var updateMtx sync.Mutex

const updateRepo = "victoryvpsvn-star/nexus-optimizer"
const updateAsset = "NEXUS-Optimizer-Go-x64.exe"

var updMtx sync.Mutex
var updCache struct {
	at        time.Time
	latest    string
	num       int
	available bool
	err       string
}

func goTagNum(tag string) int {
	t := strings.TrimSpace(tag)
	if !strings.HasPrefix(t, "go-v") {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimPrefix(t, "go-v"))
	return n
}

func buildNum() int { n, _ := strconv.Atoi(strings.TrimSpace(buildNumber)); return n }

func exePath() string { p, _ := os.Executable(); return p }

/** Token GitHub TÙY CHỌN để cập nhật khi repo đang private: đặt PAT vào <data>/gh-token.txt */
func ghToken() string {
	b, err := os.ReadFile(filepath.Join(dataDir(), "gh-token.txt"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func ghReq(url string) *http.Request {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Sakura-Tool/"+AppVersion)
	if tok := ghToken(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req
}

/** Kiểm tra bản mới (cache 10 phút). buildNumber=0 (build tay) → không tự nhắc update */
func updateCheck(force bool) map[string]any {
	updMtx.Lock()
	defer updMtx.Unlock()
	emit := func() map[string]any {
		return map[string]any{
			"current": AppVersion, "build": buildNum(), "latest": updCache.latest,
			"num": updCache.num, "available": updCache.available,
			"error": updCache.err, "checked": !updCache.at.IsZero(),
		}
	}
	if !force && !updCache.at.IsZero() && time.Since(updCache.at) < 10*time.Minute {
		return emit()
	}
	// v3.9.0 (theo audit P1-10): repo có 2 họ tag (go-vN của Go edition + win-x64-vN của
	// edition cũ) — releases/latest có thể trượt sang họ khác. Giờ query danh sách releases
	// và chỉ nhận tag go-vN có asset đúng tên; fallback releases/latest nếu API lỗi.
	client := &http.Client{Timeout: 12 * time.Second}
	tag := ""
	resp, err := client.Do(ghReq("https://api.github.com/repos/" + updateRepo + "/releases?per_page=15"))
	if err == nil {
		var rels []struct {
			TagName    string `json:"tag_name"`
			Draft      bool   `json:"draft"`
			Prerelease bool   `json:"prerelease"`
		}
		je := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&rels)
		resp.Body.Close()
		if je == nil {
			for _, rl := range rels {
				if !rl.Draft && !rl.Prerelease && goTagNum(rl.TagName) > 0 {
					tag = rl.TagName // danh sách trả theo thứ tự mới → cũ; chọn go-vN mới nhất
					break
				}
			}
		}
	}
	// Fallback: redirect releases/latest (không rate limit khi repo public) — chỉ dùng nếu
	// tag đó đúng là họ go-vN, tránh nhầm win-x64-vN
	if tag == "" {
		resp, err = client.Do(ghReq("https://github.com/" + updateRepo + "/releases/latest"))
		if err == nil {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if u := resp.Request.URL; u != nil {
				parts := strings.Split(u.Path, "/releases/tag/")
				if len(parts) == 2 && goTagNum(parts[1]) > 0 {
					tag = parts[1]
				}
			}
		}
	}
	// Fallback cuối: REST releases/latest — chỉ dùng nếu đúng họ go-vN
	if tag == "" {
		resp2, err2 := client.Do(ghReq("https://api.github.com/repos/" + updateRepo + "/releases/latest"))
		if err2 == nil {
			var rel struct {
				TagName string `json:"tag_name"`
				Message string `json:"message"`
			}
			je := json.NewDecoder(io.LimitReader(resp2.Body, 1<<20)).Decode(&rel)
			resp2.Body.Close()
			if je == nil && goTagNum(rel.TagName) > 0 {
				tag = rel.TagName
			} else if rel.Message != "" && strings.Contains(rel.Message, "Not Found") {
				updCache.err = "repo đang PRIVATE — tự cập nhật cần repo Public, hoặc đặt PAT vào gh-token.txt trong thư mục dữ liệu"
				return emit()
			}
		}
	}
	if tag == "" {
		updCache.err = "chưa kiểm tra được release (repo private/mạng?)"
		return emit()
	}
	updCache.at = time.Now()
	updCache.err = ""
	updCache.latest = tag
	updCache.num = goTagNum(tag)
	bn := buildNum()
	updCache.available = bn > 0 && updCache.num > bn
	return emit()
}

/** Tải exe mới → đổi tên hoán đổi (.old) → khởi động tiến trình mới (tiến trình cũ tự thoát ở caller) */
func updateApply() (string, error) {
	updateMtx.Lock() // v3.4.0: chặn bấm Cài 2 lần → 2 goroutine rename chồng nhau
	defer updateMtx.Unlock()
	c := updateCheck(true)
	if s, _ := c["error"].(string); s != "" {
		return "", fmt.Errorf("%s", s)
	}
	if !c["available"].(bool) {
		if buildNum() == 0 {
			return "", fmt.Errorf("bản hiện tại build tay (không gắn số CI) — chỉ tự cập nhật cho bản tải từ release")
		}
		return "", fmt.Errorf("đã là bản mới nhất (%s)", c["latest"])
	}
	url := "https://github.com/" + updateRepo + "/releases/latest/download/" + updateAsset
	tmp := exePath() + ".new"
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(ghReq(url))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("tải bản mới thất bại: HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, resp.Body)
	_ = f.Close()
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if n < 5<<20 { // exe ~9-10MB — file nhỏ hơn 5MB là phản hồi lạ
		_ = os.Remove(tmp)
		return "", fmt.Errorf("file tải về bất thường (%d byte) — bỏ qua", n)
	}
	old := exePath() + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exePath(), old); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, exePath()); err != nil {
		_ = os.Rename(old, exePath()) // lùi lại an toàn
		_ = os.Remove(tmp)
		return "", err
	}
	cmd := exec.Command(exePath())
	cmd.Dir = filepath.Dir(exePath())
	cmd.Args = append([]string{exePath()}, os.Args[1:]...) // v3.4.1 fix: giữ --web/--port của phiên trước
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("đã cài xong nhưng tự mở lại lỗi: %v — hãy mở tool tay", err)
	}
	return fmt.Sprintf("Đã cài %s — tool đang tự mở lại…", c["latest"]), nil
}

/** POST /api/update: action=check → tra cứu; action=apply → trả lời UI trước, tải + hoán đổi nền, thoát khi xong */
func handleUpdatePost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string `json:"action"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Action == "" {
		req.Action = "check"
	}
	if req.Action == "check" {
		writeJSON(w, http.StatusOK, updateCheck(true))
		return
	}
	if req.Action != "apply" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "action lạ: " + req.Action})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"started": true,
		"message": "⬇️ Đang tải bản mới… tool sẽ TỰ ĐÓNG và TỰ MỞ LẠI (tối đa ~1 phút). Đừng bấm gì trong lúc đó.",
	})
	go func() {
		time.Sleep(1500 * time.Millisecond) // để UI kịp nhận phản hồi
		msg, err := updateApply()
		if err != nil {
			log.Printf("[update] áp dụng lỗi: %v — tool tiếp tục chạy bản cũ", err)
			return
		}
		log.Printf("[update] %s", msg)
		time.Sleep(600 * time.Millisecond)
		os.Exit(0)
	}()
}
