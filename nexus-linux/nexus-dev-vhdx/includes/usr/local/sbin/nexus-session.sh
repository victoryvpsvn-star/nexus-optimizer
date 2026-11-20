#!/bin/bash
# NEXUS session hook (pam_exec): ACTIVE khi login — IDLE khi thoat SSH/console cuoi cung
# -> thoat: drop page cache (RAM giam thuc te) + dung apt timers (CPU/disk nhan roi)
# -> login: bat lai fail2ban + apt timers
# fail2ban GIU CHAY SUOT (guard brute-force) — khong tat khi idle
RUN=/run/nexus-idle.flag

idle_mode() {
    local n
    n=$(awk '$4=="01" && ($2 ~ /:0016$/ || $3 ~ /:0016$/)' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l)
    [ "$n" -gt 0 ] && return 0          # con session SSH thi khong lam gi
    [ -e "$RUN" ] && return 0           # da idle roi (timer goi lai) — khong drop cache lap
    systemctl stop apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
    systemctl stop unattended-upgrades.service >/dev/null 2>&1 || true
    sync
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    touch "$RUN" 2>/dev/null || true
}
active_mode() {
    rm -f "$RUN" 2>/dev/null || true
    systemctl start fail2ban.service >/dev/null 2>&1 || true
    systemctl start apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
}

case "${1:-}" in
    timer)
        # goi boi nexus-idle-check.timer — chi chuyen idle neu khong con session nao
        idle_mode ;;
    *)
        case "$PAM_TYPE" in
            open_session)  active_mode ;;
            close_session) idle_mode ;;
        esac ;;
esac
exit 0
