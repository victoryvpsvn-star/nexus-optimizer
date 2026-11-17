// stats.go — giám sát hệ thống bằng gopsutil (thuần Go, không PowerShell): CPU/RAM/disk/net
// realtime, danh sách tiến trình + kill, thông tin mạng + cổng LISTEN. Nhanh và nhẹ hơn hẳn
// bản TS (trước phải spawn PowerShell cho từng loại số liệu).
package main

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	gnet "github.com/shirou/gopsutil/v4/net"
	load "github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/mem"
)

type CpuInfo struct {
	Usage   float64  `json:"usage"`
	Cores   int      `json:"cores"`
	Model   string   `json:"model"`
	Loadavg []float64 `json:"loadavg"`
}

type MemInfo struct {
	TotalMB     uint64  `json:"totalMB"`
	UsedMB      uint64  `json:"usedMB"`
	AvailableMB uint64  `json:"availableMB"`
	UsagePct    float64 `json:"usagePct"`
	SwapTotalMB uint64  `json:"swapTotalMB"`
	SwapUsedMB  uint64  `json:"swapUsedMB"`
}

type DiskInfo struct {
	Mount    string  `json:"mount"`
	TotalGB  float64 `json:"totalGB"`
	UsedGB   float64 `json:"usedGB"`
	FreeGB   float64 `json:"freeGB"`
	UsagePct float64 `json:"usagePct"`
}

type NetInfo struct {
	RxKBs     float64 `json:"rxKBs"`
	TxKBs     float64 `json:"txKBs"`
	RxTotalMB float64 `json:"rxTotalMB"`
	TxTotalMB float64 `json:"txTotalMB"`
}

type StatsSnapshot struct {
	CPU          CpuInfo    `json:"cpu"`
	Mem          MemInfo    `json:"mem"`
	Disks        []DiskInfo `json:"disks"`
	Net          NetInfo    `json:"net"`
	UptimeSec    uint64     `json:"uptimeSec"`
	Hostname     string     `json:"hostname"`
	Platform     string     `json:"platform"`
	ProcessCount int        `json:"processCount"`
	Timestamp    int64      `json:"timestamp"`
}

var lastNet struct {
	rx, tx uint64
	at     time.Time
	have   bool
}

var cpuModelCache struct {
	val  string
	done bool
}

func cpuModel() string {
	if !cpuModelCache.done {
		if infos, err := cpu.Info(); err == nil && len(infos) > 0 {
			cpuModelCache.val = strings.TrimSpace(infos[0].ModelName)
		}
		cpuModelCache.done = true
	}
	return cpuModelCache.val
}

/** Snapshot thống nhất cho GET /api/stats — client polls vài giây/lần */
func getStats() StatsSnapshot {
	s := StatsSnapshot{Timestamp: time.Now().Unix()}
	s.Hostname, _ = os.Hostname()
	if hi, err := host.Info(); err == nil {
		s.Platform = hi.Platform + " " + hi.PlatformVersion
		s.UptimeSec = hi.Uptime
	}
	if s.Platform == "" {
		s.Platform = runtime.GOOS
	}
	if pct, err := cpu.Percent(time.Second, false); err == nil && len(pct) > 0 {
		s.CPU.Usage = round1(pct[0])
	} else if pct, err := cpu.Percent(0, false); err == nil && len(pct) > 0 {
		s.CPU.Usage = round1(pct[0])
	}
	if ci, err := cpu.Counts(true); err == nil {
		s.CPU.Cores = ci
	}
	s.CPU.Model = cpuModel()
	if la, err := load.Avg(); err == nil {
		s.CPU.Loadavg = []float64{round2(la.Load1), round2(la.Load5), round2(la.Load15)}
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		s.Mem.TotalMB = vm.Total / 1024 / 1024
		s.Mem.UsedMB = vm.Used / 1024 / 1024
		s.Mem.AvailableMB = vm.Available / 1024 / 1024
		if vm.Total > 0 {
			s.Mem.UsagePct = round1(float64(vm.Used) / float64(vm.Total) * 100)
		}
	}
	if sm, err := mem.SwapMemory(); err == nil {
		s.Mem.SwapTotalMB = sm.Total / 1024 / 1024
		s.Mem.SwapUsedMB = sm.Used / 1024 / 1024
	}
	// Disk: các phân vùng thực có dung lượng, gộp trùng mount
	seen := map[string]bool{}
	if parts, err := disk.Partitions(false); err == nil {
		for _, p := range parts {
			if seen[p.Mountpoint] {
				continue
			}
			seen[p.Mountpoint] = true
			if du, err := disk.Usage(p.Mountpoint); err == nil && du.Total > 0 {
				s.Disks = append(s.Disks, DiskInfo{
					Mount:    p.Mountpoint,
					TotalGB:  round2(float64(du.Total) / 1e9),
					UsedGB:   round2(float64(du.Used) / 1e9),
					FreeGB:   round2(float64(du.Free) / 1e9),
					UsagePct: round1(du.UsedPercent),
				})
				if len(s.Disks) >= 8 {
					break
				}
			}
		}
	}
	// Net: tốc độ hiện tại = delta giữa 2 lần đo
	if io, err := gnet.IOCounters(false); err == nil && len(io) > 0 {
		rx, tx := io[0].BytesRecv, io[0].BytesSent
		now := time.Now()
		if lastNet.have {
			dt := now.Sub(lastNet.at).Seconds()
			if dt > 0.2 {
				s.Net.RxKBs = round1(float64(rx-lastNet.rx) / dt / 1024)
				s.Net.TxKBs = round1(float64(tx-lastNet.tx) / dt / 1024)
			}
		}
		lastNet.rx, lastNet.tx, lastNet.at, lastNet.have = rx, tx, now, true
		s.Net.RxTotalMB = round2(float64(rx) / 1e6)
		s.Net.TxTotalMB = round2(float64(tx) / 1e6)
	}
	if n, err := process.Pids(); err == nil {
		s.ProcessCount = len(n)
	}
	return s
}

// ---------- Tiến trình ----------

type ProcessInfo struct {
	PID   int32   `json:"pid"`
	User  string  `json:"user"`
	Name  string  `json:"name"`
	CpuPct float64 `json:"cpuPct"`
	MemPct float64 `json:"memPct"`
	RssMB float64 `json:"rssMB"`
}

type ProcListResponse struct {
	List []ProcessInfo `json:"list"`
}

/** Danh sách tiến trình sắp theo CPU giảm dần, tối đa 80 mục — đủ cho UI, nhẹ cho máy yếu */
func listProcesses() ([]ProcessInfo, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}
	out := make([]ProcessInfo, 0, len(procs))
	for _, p := range procs {
		name, _ := p.Name()
		if name == "" {
			continue
		}
		pct, _ := p.CPUPercent()
		memPct, _ := p.MemoryPercent()
		rss, _ := p.MemoryInfo()
		user := ""
		if u, err := p.Username(); err == nil {
			user = u
		}
		out = append(out, ProcessInfo{
			PID: p.Pid, User: user, Name: name,
			CpuPct: round1(pct), MemPct: round1(float64(memPct)),
			RssMB: round1(float64(rss.RSS) / 1024 / 1024),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CpuPct > out[j].CpuPct })
	if len(out) > 80 {
		out = out[:80]
	}
	return out, nil
}

/** Kill tiến trình: Windows dùng taskkill /T /F (giết cả cây); Linux SIGKILL.
 * v3.9.0 (theo audit P2-31): khi UI gửi kèm `name`, đối chiếu tên tiến trình thật qua
 * tasklist trước khi kill — PID tái sử dụng (process chết rồi PID bị nhặt lại) sẽ bị chặn. */
func killProcess(pid int, expectedName string) (bool, string) {
	if expectedName != "" {
		if runtimeIsWindows {
			r := runSysExe("tasklist.exe", []string{"/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH"}, 8*time.Second)
			line := strings.TrimSpace(r.Stdout)
			// CSV: "name","pid","sess",... — lấy cột 1
			cols := strings.Split(line, `","`)
			real := ""
			if len(cols) > 1 {
				real = strings.TrimPrefix(cols[0], `"`)
			}
			if !r.OK || line == "" || line == "INFO: No tasks are running" || strings.Contains(line, "INFO:") {
				return false, fmt.Sprintf("PID %d không còn chạy — không kill gì cả", pid)
			}
			if !strings.EqualFold(real, expectedName) {
				return false, fmt.Sprintf("PID %d giờ là tiến trình khác (%s ≠ %s) — chặn theo audit P2-31, không kill nhầm", pid, real, expectedName)
			}
		} else if ps, err := process.NewProcess(int32(pid)); err == nil {
			if n, err := ps.Name(); err == nil && !strings.EqualFold(n, expectedName) {
				return false, fmt.Sprintf("PID %d giờ là tiến trình khác (%s ≠ %s) — chặn, không kill nhầm", pid, n, expectedName)
			}
		}
	}
	if runtimeIsWindows {
		r := runSysExe("taskkill.exe", []string{"/PID", fmt.Sprint(pid), "/T", "/F"}, 15*time.Second)
		if r.OK {
			return true, fmt.Sprintf("Đã kết thúc tiến trình %d (taskkill /T /F)", pid)
		}
		return false, truncateShort(fmt.Sprintf("taskkill PID %d thất bại (exit %d): %s",
			pid, r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do")))
	}
	r := runCmd(fmt.Sprintf("kill -9 %d", pid), 5*time.Second)
	if r.OK {
		return true, fmt.Sprintf("Đã kết thúc tiến trình %d (kill -9)", pid)
	}
	return false, truncateShort("kill thất bại: " + r.Stderr)
}

// ---------- Mạng ----------

type IfaceInfo struct {
	Name string   `json:"name"`
	IPv4 []string `json:"ipv4"`
	Mac  string   `json:"mac,omitempty"`
}

type PortInfo struct {
	Port  uint32 `json:"port"`
	Proto string `json:"proto"`
}

type NetworkResponse struct {
	Ifaces    []IfaceInfo `json:"ifaces"`
	Ports     []PortInfo  `json:"ports"`
	Fqdn      string      `json:"fqdn"`
	Timestamp int64       `json:"timestamp"`
}

func getNetwork() NetworkResponse {
	res := NetworkResponse{Timestamp: time.Now().UnixMilli(), Ifaces: []IfaceInfo{}, Ports: []PortInfo{}}
	res.Fqdn, _ = os.Hostname()
	if arr, err := gnet.Interfaces(); err == nil {
		iostats, _ := gnet.IOCounters(true)
		_ = iostats
		for _, ifc := range arr {
			if ifc.HardwareAddr == "" && len(ifc.Addrs) == 0 {
				continue
			}
			info := IfaceInfo{Name: ifc.Name, IPv4: []string{}, Mac: ifc.HardwareAddr}
			for _, a := range ifc.Addrs {
				if strings.Contains(a.Addr, ":") {
					continue // chỉ lấy IPv4 cho UI gọn
				}
				info.IPv4 = append(info.IPv4, a.Addr)
			}
			if len(info.IPv4) > 0 || info.Mac != "" {
				res.Ifaces = append(res.Ifaces, info)
			}
		}
	}
	// Cổng LISTEN qua GetExtendedTcpTable/procfs — gopsutil connection stat
	if cons, err := gnet.Connections("inet"); err == nil {
		seen := map[uint32]bool{}
		for _, c := range cons {
			if c.Status != "LISTEN" {
				continue
			}
			if seen[c.Laddr.Port] {
				continue
			}
			seen[c.Laddr.Port] = true
			res.Ports = append(res.Ports, PortInfo{Port: c.Laddr.Port, Proto: "tcp"})
		}
		sort.Slice(res.Ports, func(i, j int) bool { return res.Ports[i].Port < res.Ports[j].Port })
		if len(res.Ports) > 40 {
			res.Ports = res.Ports[:40]
		}
	}
	return res
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int(v*100+0.5)) / 100 }
