// Store — thay thế Prisma/SQLite bằng 1 file JSON nguyên tử + mutex.
// Giữ đủ: UISettings, webhook Discord, trạng thái tweaks, gaming state, cleanup logs, activity.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type UISettings struct {
	Accent      string  `json:"accent"`
	Background  string  `json:"background"`
	CustomBgURL string  `json:"customBgUrl"`
	Radius      float64 `json:"radius"`
	Petals      bool    `json:"petals"`
	Lang        string  `json:"lang"`
	WelcomeSeen bool    `json:"welcomeSeen"`
}

func defaultUISettings() UISettings {
	return UISettings{Accent: "sakura-pink", Background: "sakura", CustomBgURL: "", Radius: 1.25, Petals: true, Lang: "vi"}
}

type TweakState struct {
	Applied    bool       `json:"applied"`
	Partial    bool       `json:"partial,omitempty"` // v4.1.0 (phát hiện 08-E): multi-step fail dọc đường — một phần máy đã bị đổi
	AppliedAt  *time.Time `json:"appliedAt,omitempty"`
	LastResult string     `json:"lastResult,omitempty"`
}

type CleanupLogEntry struct {
	ID         int       `json:"id"`
	Kind       string    `json:"kind"`
	Target     string    `json:"target"`
	FreedBytes int64     `json:"freedBytes"`
	Success    bool      `json:"success"`
	Message    string    `json:"message,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

type GamingEffect struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type ScriptRecord struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Language  string    `json:"language"`
	Code      string    `json:"code,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type storeData struct {
	Settings   UISettings   `json:"settings"`
	WebhookURL string       `json:"webhookUrl"`
	Perf       PerfSettings `json:"perf"`
	Gaming     struct {
		Enabled   bool           `json:"enabled"`
		EnabledAt *time.Time     `json:"enabledAt,omitempty"`
		Effects   []GamingEffect `json:"effects"`
	} `json:"gaming"`
	TweakStates       map[string]TweakState `json:"tweakStates"`
	AppOptStates      map[string]TweakState `json:"appoptStates"`
	CleanupLogs       []CleanupLogEntry     `json:"cleanupLogs"`
	CleanupTotalFreed int64                 `json:"cleanupTotalFreed"`
	NextLogID         int                   `json:"nextLogId"`
	NextScriptID      int                   `json:"nextScriptId"`
	Scripts           []ScriptRecord        `json:"scripts"`
}

type Store struct {
	mu     sync.Mutex
	dir    string
	data   storeData
	stopCh chan struct{}
}

func NewStore(dir string) *Store {
	s := &Store{dir: dir, stopCh: make(chan struct{})}
	s.data = storeData{
		Settings:    defaultUISettings(),
		TweakStates: map[string]TweakState{},
		AppOptStates: map[string]TweakState{},
		CleanupLogs: []CleanupLogEntry{},
		Scripts:     []ScriptRecord{},
	}
	return s
}

func (s *Store) file() string { return filepath.Join(s.dir, "config.json") }

func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.file())
	if err != nil {
		if os.IsNotExist(err) {
			return nil // lần đầu chạy — dùng mặc định
		}
		return err
	}
	var d storeData
	if err := json.Unmarshal(b, &d); err != nil {
		// v3.9.0 (theo audit P2-09): file hỏng được CÁCH LY (rename) thay vì để autosave
		// 3s sau ghi đè mất bản gốc — user còn mang file đó đi khôi phục thủ công được.
		q := fmt.Sprintf("%s.corrupt-%s", s.file(), time.Now().Format("20060102-150405"))
		if rerr := os.Rename(s.file(), q); rerr == nil {
			return fmt.Errorf("config.json hỏng: %w — đã giữ bản lỗi lại tại %q, dùng cấu hình mặc định", err, filepath.Base(q))
		}
		return fmt.Errorf("config.json hỏng: %w", err)
	}
	if d.Settings.Accent == "" {
		d.Settings = defaultUISettings()
	}
	if d.TweakStates == nil {
		d.TweakStates = map[string]TweakState{}
	}
	if d.AppOptStates == nil {
		d.AppOptStates = map[string]TweakState{}
	}
	if d.CleanupLogs == nil {
		d.CleanupLogs = []CleanupLogEntry{}
	}
	if d.Scripts == nil {
		d.Scripts = []ScriptRecord{}
	}
	// v3.5.0: mặc định hiệu năng (config cũ không có mục "perf")
	if d.Perf.FpsTarget <= 0 {
		d.Perf = defaultPerfSettings()
	} else {
		if d.Perf.TimerRes == "" {
			d.Perf.TimerRes = "auto"
		}
		if d.Perf.OcLevel != "safe" && d.Perf.OcLevel != "balanced" && d.Perf.OcLevel != "max" {
			d.Perf.OcLevel = "balanced"
		}
	}
	s.data = d
	return nil
}

// saveLocked ghi file nguyên tử (tmp + rename) — gọi khi đang giữ mu
// v3.9.0: perm 0600 trên Unix (config chứa webhook/scripts — audit P2-09/21)
func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(&s.data, "", " ")
	if err != nil {
		return err
	}
	tmp := s.file() + ".tmp"
	if err := os.WriteFile(tmp, b, filePerm()); err != nil {
		return err
	}
	return os.Rename(tmp, s.file())
}

func (s *Store) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}

// StartAutosave ghi định kỳ — hạn chế mất dữ liệu khi app bị tắt đột ngột
func (s *Store) StartAutosave(every time.Duration) {
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-s.stopCh:
				return
			case <-t.C:
				_ = s.Save()
			}
		}
	}()
}

func (s *Store) GetSettings() UISettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Settings
}

var accentKeys = map[string]bool{
	"sakura-pink": true, "sakura-lavender": true, "cyan-violet": true,
	"emerald-amber": true, "rose-magenta": true, "amber-crimson": true,
}
var backgroundKeys = map[string]bool{
	"sakura": true, "wall-sakura": true, "gradient": true, "glow": true,
	"mesh": true, "wall-default": true, "wall-gaming": true, "custom": true,
	// v3.4.0: key hình nền mới (wallpaper.js) — ảnh có sẵn + 3 ảnh AI gen
	"sakura-bg": true, "sakura-bg2": true, "sakura-gaming": true, "sakura-hero": true,
	"bg-ai-night": true, "bg-ai-sunset": true, "bg-ai-petals": true,
}

// ValidateSettings kiểm tra giá trị — trả lỗi nếu không hợp lệ (giữ hành vi route cũ)
func (s *Store) ValidateSettings(u UISettings) error {
	if !accentKeys[u.Accent] {
		return fmt.Errorf("accent không hợp lệ")
	}
	if !backgroundKeys[u.Background] {
		return fmt.Errorf("background không hợp lệ")
	}
	if u.Radius < 0 || u.Radius > 2.5 {
		return fmt.Errorf("radius phải từ 0 đến 2.5")
	}
	if u.Lang != "" && u.Lang != "vi" && u.Lang != "en" {
		return fmt.Errorf("lang chỉ hỗ trợ vi/en")
	}
	if u.CustomBgURL != "" && !strings.HasPrefix(u.CustomBgURL, "http://") &&
		!strings.HasPrefix(u.CustomBgURL, "https://") && !strings.HasPrefix(u.CustomBgURL, "data:image/") {
		return fmt.Errorf("customBgUrl chỉ chấp nhận http(s):// hoặc data:image/")
	}
	return nil
}

func (s *Store) PutSettings(u UISettings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u.Lang == "" { // config cũ (v3.3.0) không có lang — chuẩn hóa thay vì để rỗng
		u.Lang = "vi"
	}
	s.data.Settings = u
	_ = s.saveLocked()
}

// GetWebhookURL: URL người dùng cấu hình ưu tiên, dự phòng env DISCORD_WEBHOOK_URL
func (s *Store) GetWebhookURL() string {
	s.mu.Lock()
	u := s.data.WebhookURL
	s.mu.Unlock()
	if u != "" && isValidWebhook(u) {
		return u
	}
	if env := os.Getenv("DISCORD_WEBHOOK_URL"); env != "" && isValidWebhook(env) {
		return env
	}
	return ""
}

func (s *Store) SetWebhookURL(url string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.WebhookURL = url
	_ = s.saveLocked()
}

func (s *Store) GetTweakState(id string) TweakState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.TweakStates[id]
}

func (s *Store) PutTweakState(id string, st TweakState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.TweakStates[id] = st
	_ = s.saveLocked()
}

// v3.7.0: trạng thái App Optimizer — map riêng để không đụng TweakStates của catalog
func (s *Store) GetAppOptStates() map[string]TweakState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]TweakState, len(s.data.AppOptStates))
	for k, v := range s.data.AppOptStates {
		out[k] = v
	}
	return out
}

func (s *Store) PutAppOptState(id string, st TweakState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.AppOptStates[id] = st
	_ = s.saveLocked()
}

// AddCleanupLog thêm log + giữ tối đa 100 mục gần nhất (giống take:15 DB cũ nhưng dư dả hơn)
/** Tổng dung lượng đã giải phóng từ trước tới nay (persistent, autosave) */
func (s *Store) CleanupTotalFreed() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.CleanupTotalFreed
}

func (s *Store) AddCleanupLog(kind, target string, freed int64, success bool, msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if success && freed > 0 {
		s.data.CleanupTotalFreed += freed
	}
	s.data.NextLogID++
	s.data.CleanupLogs = append(s.data.CleanupLogs, CleanupLogEntry{
		ID: s.data.NextLogID, Kind: kind, Target: target, FreedBytes: freed,
		Success: success, Message: msg, CreatedAt: time.Now(),
	})
	sort.Slice(s.data.CleanupLogs, func(i, j int) bool {
		return s.data.CleanupLogs[i].CreatedAt.After(s.data.CleanupLogs[j].CreatedAt)
	})
	if len(s.data.CleanupLogs) > 100 {
		s.data.CleanupLogs = s.data.CleanupLogs[:100]
	}
	_ = s.saveLocked()
}

func (s *Store) GetCleanupLogs() []CleanupLogEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CleanupLogEntry, len(s.data.CleanupLogs))
	copy(out, s.data.CleanupLogs)
	return out
}

func (s *Store) GetGaming() (bool, *time.Time, []GamingEffect) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ef := make([]GamingEffect, len(s.data.Gaming.Effects))
	copy(ef, s.data.Gaming.Effects)
	return s.data.Gaming.Enabled, s.data.Gaming.EnabledAt, ef
}

func (s *Store) PutGaming(enabled bool, effects []GamingEffect) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var at *time.Time
	if enabled {
		now := time.Now()
		at = &now
	}
	s.data.Gaming.Enabled = enabled
	s.data.Gaming.EnabledAt = at
	s.data.Gaming.Effects = effects
	_ = s.saveLocked()
}

func (s *Store) ListScripts() []ScriptRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ScriptRecord, len(s.data.Scripts))
	copy(out, s.data.Scripts)
	return out
}

func (s *Store) UpsertScript(rec ScriptRecord) ScriptRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec.UpdatedAt = time.Now()
	if rec.ID == 0 {
		s.data.NextScriptID++
		rec.ID = s.data.NextScriptID
		s.data.Scripts = append(s.data.Scripts, rec)
	} else {
		found := false
		for i := range s.data.Scripts {
			if s.data.Scripts[i].ID == rec.ID {
				s.data.Scripts[i] = rec
				found = true
				break
			}
		}
		if !found {
			s.data.NextScriptID++
			rec.ID = s.data.NextScriptID
			s.data.Scripts = append(s.data.Scripts, rec)
		}
	}
	_ = s.saveLocked()
	return rec
}

func (s *Store) DeleteScript(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Scripts {
		if s.data.Scripts[i].ID == id {
			s.data.Scripts = append(s.data.Scripts[:i], s.data.Scripts[i+1:]...)
			_ = s.saveLocked()
			return true
		}
	}
	return false
}
