#!/bin/bash
# Chụp lại UI sau fix + chụp các panel Script / Cài đặt / Sao lưu
cd /home/z/my-project
rm -f /tmp/render/*.png

setsid nohup bun run dev > /dev/null 2>&1 < /dev/null & disown
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "ROOT: $code"

agent-browser open http://localhost:3000 2>&1 | head -1
sleep 6
agent-browser screenshot /tmp/render/01-overview.png 2>&1 | tail -1

SNAP=$(agent-browser snapshot -i 2>&1)
REF_SCRIPT=$(echo "$SNAP" | grep -i "Script nâng cao" | grep -oE "e[0-9]+" | head -1)
REF_SET=$(echo "$SNAP" | grep -i "Cài đặt" | grep -oE "e[0-9]+" | head -1)
REF_BACKUP=$(echo "$SNAP" | grep -i "Sao lưu" | grep -oE "e[0-9]+" | head -1)
REF_TWEAKS=$(echo "$SNAP" | grep -i "Tinh chỉnh" | grep -oE "e[0-9]+" | head -1)
echo "REF script=e$REF_SCRIPT settings=e$REF_SET backup=e$REF_BACKUP tweaks=e$REF_TWEAKS"

if [ -n "$REF_SCRIPT" ]; then
  agent-browser click "@$REF_SCRIPT" 2>&1 | tail -1
  sleep 4
  agent-browser screenshot /tmp/render/02-script.png 2>&1 | tail -1
fi
if [ -n "$REF_SET" ]; then
  agent-browser click "@$REF_SET" 2>&1 | tail -1
  sleep 4
  agent-browser screenshot --full /tmp/render/03-settings.png 2>&1 | tail -1
fi
if [ -n "$REF_BACKUP" ]; then
  agent-browser click "@$REF_BACKUP" 2>&1 | tail -1
  sleep 4
  agent-browser screenshot /tmp/render/04-backup.png 2>&1 | tail -1
fi
if [ -n "$REF_TWEAKS" ]; then
  agent-browser click "@$REF_TWEAKS" 2>&1 | tail -1
  sleep 4
  agent-browser screenshot /tmp/render/05-tweaks.png 2>&1 | tail -1
fi
agent-browser close 2>&1 | tail -1
ls -la /tmp/render/*.png
