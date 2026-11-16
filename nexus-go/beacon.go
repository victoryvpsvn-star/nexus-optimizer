// beacon.go — cổng beacon cố định để extension Cat Status biết Sakura Tool đang mở.
// Extension poll http://127.0.0.1:32123/api/presence-beacon (fallback 32124):
// thấy JSON app=sakura-tool → set Discord activity qua API (KHÔNG cần Discord desktop);
// không thấy → xóa presence. Section/note lấy từ presenceSt (UI tool đang xem gì).
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync/atomic"
	"time"
)

// Extension poll beacon bao nhiêu lâu một lần — tool dùng để hiển thị "extension đang sống"
var beaconLastPoll int64
var beaconPortActive int32

func beaconSeenSec() int64 {
	lp := atomic.LoadInt64(&beaconLastPoll)
	if lp == 0 {
		return -1
	}
	return time.Now().Unix() - lp
}

func beaconActivePort() int { return int(atomic.LoadInt32(&beaconPortActive)) }

/** Chạy nền từ main: chiếm 1 cổng cố định làm beacon */
func startBeacon() {
	for _, p := range []int{32123, 32124} {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			continue // cổng bận → thử cổng kế
		}
		mux := http.NewServeMux()
		mux.HandleFunc("GET /api/presence-beacon", func(w http.ResponseWriter, r *http.Request) {
			atomic.StoreInt64(&beaconLastPoll, time.Now().Unix()) // extension vừa hỏi → còn sống
			_, _, _, sec, note := presenceStatus()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"app":     "sakura-tool",
				"section": sec,
				"note":    note,
				"started": presenceStarted(),
				"ts":      time.Now().Unix(),
			})
		})
		srv := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
		atomic.StoreInt32(&beaconPortActive, int32(p))
		go func(port int, l net.Listener, s *http.Server) {
			log.Printf("[beacon] Sakura beacon chạy tại 127.0.0.1:%d (extension sẽ thấy tool mở)", port)
			_ = s.Serve(l)
		}(p, ln, srv)
		return
	}
	log.Printf("[beacon] không mở được cổng 32123/32124 (bị app khác chiếm) — extension sẽ fallback quét tab")
}
