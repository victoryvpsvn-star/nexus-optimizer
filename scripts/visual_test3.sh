#!/bin/bash
# Kiểm tra cuối: overview + bật Gaming Mode (fix #1: ép nền tối) + petal
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
sleep 7
agent-browser screenshot /tmp/render/01-overview.png 2>&1 | tail -1

SNAP=$(agent-browser snapshot -i 2>&1)
REF_SWITCH=$(echo "$SNAP" | grep -i "Gaming Mode" | grep -iE "switch" | grep -oE "e[0-9]+" | head -1)
echo "REF gaming-switch=e$REF_SWITCH"

if [ -n "$REF_SWITCH" ]; then
  agent-browser click "@$REF_SWITCH" 2>&1 | tail -1
  sleep 5
  agent-browser screenshot /tmp/render/02-gaming.png 2>&1 | tail -1
  # tắt lại gaming để trạng thái trả về ban đầu
  agent-browser click "@$REF_SWITCH" 2>&1 | tail -1
  sleep 3
fi
agent-browser close 2>&1 | tail -1
ls -la /tmp/render/*.png
echo "--- dev.log ---"
tail -6 dev.log
