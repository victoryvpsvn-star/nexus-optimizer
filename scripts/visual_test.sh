#!/bin/bash
# Chụp ảnh UI: Overview (sakura) → Script panel → Settings panel
cd /home/z/my-project
mkdir -p /tmp/render
rm -f /tmp/render/*.png

setsid nohup bun run dev > /dev/null 2>&1 < /dev/null & disown
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "ROOT: $code"

agent-browser open http://localhost:3000 2>&1 | head -2
sleep 6
agent-browser screenshot /tmp/render/01-overview.png 2>&1 | tail -1
echo "--- snapshot tìm nav Script ---"
SNAP=$(agent-browser snapshot -i 2>&1)
echo "$SNAP" | grep -iE "script|setting|backup" | head -8

REF_SCRIPT=$(echo "$SNAP" | grep -i "Script nâng cao" | grep -oE "@e[0-9]+" | head -1)
REF_SET=$(echo "$SNAP" | grep -i "Cài đặt" | grep -oE "@e[0-9]+" | head -1)
REF_BACKUP=$(echo "$SNAP" | grep -i "Sao lưu" | grep -oE "@e[0-9]+" | head -1)
echo "REF script=$REF_SCRIPT settings=$REF_SET backup=$REF_BACKUP"

if [ -n "$REF_SCRIPT" ]; then
  agent-browser click "$REF_SCRIPT" 2>&1 | tail -1
  sleep 3
  agent-browser screenshot /tmp/render/02-script.png 2>&1 | tail -1
fi
if [ -n "$REF_SET" ]; then
  agent-browser click "$REF_SET" 2>&1 | tail -1
  sleep 3
  agent-browser screenshot --full /tmp/render/03-settings.png 2>&1 | tail -1
fi
if [ -n "$REF_BACKUP" ]; then
  agent-browser click "$REF_BACKUP" 2>&1 | tail -1
  sleep 3
  agent-browser screenshot /tmp/render/04-backup.png 2>&1 | tail -1
fi
agent-browser close 2>&1 | tail -1
ls -la /tmp/render/
echo "--- dev.log cuối ---"
tail -5 dev.log
