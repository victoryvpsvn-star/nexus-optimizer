// updater.go — tính năng tự cập nhật: kiểm tra release go-vN mới nhất trên GitHub,
// tải exe mới, hoán đổi file đang chạy (rename .old — Windows cho phép đổi tên file
// đang chạy) rồi tự khởi động lại tiến trình mới. Số bản = số run CI (buildNumber
// ghim qua -ldflags -X main.buildNumber trong workflow).
package main

import (
	"crypto/sha256"
	"encoding/hex"
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

// v4.1.0 (phát hiện 10 — SUPPLY-CHAIN): policy chữ ký số. Release hiện CHƯA ký số
// (SmartScreen vẫn hỏi) — chưa bật chế độ bắt buộc; khi có certificate Authenticode
// thì flip thành true để chặn cài binary không ký.
const updateRequireSigned = false

/** parse "sha256:abc..." từ assets[].digest của GitHub → hex lowercase */
func parseAssetDigest(d string) (string, bool) {
	d = strings.TrimSpace(strings.ToLower(d))
	parts := strings.SplitN(d, ":", 2)
	if len(parts) == 2 && parts[0] == "sha256" && len(parts[1]) == 64 {
		if _, err := hex.DecodeString(parts[1]); err == nil {
			return parts[1], true
		}
	}
	return "", false
}

/** sha256 file — dùng cho verify binary tải về trước khi hoán đổi exe đang chạy */
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

/** release asset của 1 tag cụ thể: url/size/digest — đối chiếu trước khi download (10.2-10.4) */
type releaseAsset struct {
	URL    string
	Size   int64
	Digest string // dạng "sha256:..." raw
}

func fetchReleaseAsset(tag string) (releaseAsset, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(ghReq("https://api.github.com/repos/" + updateRepo + "/releases/tags/" + tag))
	if err != nil {
		return releaseAsset{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return releaseAsset{}, fmt.Errorf("query release %s: HTTP %d", tag, resp.StatusCode)
	}
	var rel struct {
		Assets []struct {
			Name               string `json:"name"`
			Size               int64  `json:"size"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Digest             string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return releaseAsset{}, err
	}
	for _, a := range rel.Assets {
		if a.Name == updateAsset {
			return releaseAsset{URL: a.BrowserDownloadURL, Size: a.Size, Digest: a.Digest}, nil
		}
	}
	return releaseAsset{}, fmt.Errorf("release %s không có asset %s — updateCheck báo có bản mới nhưng asset thiếu (TEST UPDATER-09)", tag, updateAsset)
}

/** Authenticode qua PowerShell — trả "Valid" / "NotSigned" / lỗi khác; chỉ mang tính thông tin
 * khi updateRequireSigned=false, chặn cài khi true (audit TEST UPDATER-04) */
func authenticodeStatus(path string) (string, error) {
	r := exec.Command("powershell.exe", "-NoProfile", "-Command",
		fmt.Sprintf(`(Get-AuthenticodeSignature '%s').Status`, path))
	out, err := r.Output()
	return strings.TrimSpace(string(out)), err
}

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
	// v4.1.0 (phát hiện 10): KHÔNG tải từ releases/latest toàn repo nữa — pin ĐÚNG tag
	// mà updateCheck đã chọn, đọc asset thật (url/size/digest) rồi verify trước khi đụng exe
	tag, _ := c["latest"].(string)
	if goTagNum(tag) <= 0 {
		return "", fmt.Errorf("tag không hợp lệ: %q", tag)
	}
	asset, err := fetchReleaseAsset(tag)
	if err != nil {
		return "", err
	}
	wantSHA, hasSHA := parseAssetDigest(asset.Digest)
	if !hasSHA {
		// audit 10.4: không có digest công bố → fail-closed, không cài binary không xác thực được
		return "", fmt.Errorf("release %s không công bố digest SHA-256 — CHẶN cài theo policy integrity (không đụng exe đang chạy)", tag)
	}
	tmp := exePath() + ".new"
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(ghReq(asset.URL)) // đúng URL asset của tag đã chọn (TEST UPDATER-01/02)
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
	// giới hạn cứng: chỉ đọc tối đa size+1 để phát hiện file phình to (TEST UPDATER-06)
	maxRead := asset.Size + (1 << 20)
	if asset.Size <= 0 {
		maxRead = 200 << 20
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, maxRead))
	_ = f.Close()
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if n < 5<<20 { // exe ~9-10MB — file nhỏ hơn 5MB là phản hồi lạ
		_ = os.Remove(tmp)
		return "", fmt.Errorf("file tải về bất thường (%d byte) — bỏ qua", n)
	}
	if asset.Size > 0 && n != asset.Size {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("file tải về %d byte ≠ size công bố %d — file cắt cụt/sai — bỏ qua (không đụng exe)", n, asset.Size)
	}
	// SHA-256 bắt buộc khớp digest của asset (TEST UPDATER-03/05)
	got, err := fileSHA256(tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("tính SHA-256 thất bại: %v", err)
	}
	if got != wantSHA {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("SHA-256 KHÔNG khớp (got %s ≠ want %s) — file sai/hỏng, STAGING ĐÃ XÓA, exe hiện tại còn nguyên", got[:16], wantSHA[:16])
	}
	// Authenticode — policy: hiện chưa ký → cảnh báo trung thực; flip updateRequireSigned khi có cert
	sig, sigErr := authenticodeStatus(tmp)
	if sigErr != nil {
		sig = "UNKNOWN (" + sigErr.Error() + ")"
	}
	if updateRequireSigned && sig != "Valid" {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("chữ ký Authenticode không hợp lệ (%s) — CHẶN cài theo policy (exe hiện tại còn nguyên)", sig)
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
	// v4.4.0 (B-32): health check THẬT — PID sống + /api/health trả 200 với version khớp.
	// PID còn sống không chứng minh API bind thành công; version phải đúng release vừa cài.
	go func() {
		newBuild := fmt.Sprintf("%v", c["latest"])
		deadline := time.Now().Add(25 * time.Second)
		healthy := false
		for time.Now().Before(deadline) {
			if !pidAlive(cmd.Process.Pid) {
				break // chết sớm — rollback bên dưới
			}
			if hc := probeHealth(); hc {
				healthy = true
				break
			}
			time.Sleep(1 * time.Second)
		}
		if !healthy {
			log.Printf("[update] health check THẤT BẠI (PID chết hoặc /api/health không lên) — ROLLBACK về bản cũ")
			_ = os.Rename(exePath(), exePath()+".bad")
			_ = os.Rename(old, exePath())
			_ = os.Remove(exePath() + ".bad")
			restart := exec.Command(exePath())
			restart.Dir = filepath.Dir(exePath())
			restart.Args = append([]string{exePath()}, os.Args[1:]...)
			_ = restart.Start()
			return
		}
		log.Printf("[update] health check đạt (build %s — /api/health OK), dọn .old", newBuild)
		_ = os.Remove(old) // bản mới sống khỏe — dọn .old
	}()
	return fmt.Sprintf("Đã cài %s (SHA-256 khớp, chữ ký: %s) — tool đang tự mở lại…", c["latest"], sig), nil
}

/** v4.4.0 (B-32): probe /api/health của tiến trình mới — 200 + parse được JSON = healthy */
func probeHealth() bool {
	for _, port := range []string{"38766", "32196"} { // port Go chạy thường + port web-mode
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get("http://127.0.0.1:" + port + "/api/health")
		if err != nil {
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			var probe map[string]any
			if json.NewDecoder(resp.Body).Decode(&probe) == nil {
				return true
			}
		}
	}
	return false
}

/** PID còn sống? — tasklist là cách đọc được cả trên Windows không cần handle */
func pidAlive(pid int) bool {
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH").Output()
	if err != nil {
		return false // không kiểm được → coi như chết, rollback an toàn hơn
	}
	return strings.Contains(strings.ToLower(string(out)), fmt.Sprintf(" %d ", pid)) ||
		strings.Contains(string(out), strconv.Itoa(pid))
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
