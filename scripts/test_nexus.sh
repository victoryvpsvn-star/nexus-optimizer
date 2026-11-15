#!/bin/bash
# Test toàn diện NEXUS OPTIMIZER sau cập nhật Sakura + Script + Config
cd /home/z/my-project
mkdir -p /tmp/render

# 1. Start dev server (detached)
setsid nohup bun run dev > /dev/null 2>&1 < /dev/null & disown

# 2. Chờ sẵn sàng
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "ROOT: $code"

# 3. Đặt settings về Sakura mặc định
echo "--- PUT settings sakura ---"
curl -s --max-time 30 -X PUT http://localhost:3000/api/settings -H 'Content-Type: application/json' \
  -d '{"accent":"sakura-pink","background":"sakura","customBgUrl":"","radius":1.25,"petals":true}'
echo

# 4. Test script APIs
echo "--- SCRIPT GET ---"
curl -s --max-time 30 http://localhost:3000/api/script | head -c 200; echo
echo "--- SCRIPT RUN bash ---"
curl -s --max-time 60 -X PUT http://localhost:3000/api/script -H 'Content-Type: application/json' \
  -d '{"action":"run-direct","language":"bash","code":"echo hello-nexus; df -h / | tail -1"}' | head -c 400; echo
echo "--- SCRIPT RUN python ---"
curl -s --max-time 60 -X PUT http://localhost:3000/api/script -H 'Content-Type: application/json' \
  -d '{"action":"run-direct","language":"python","code":"print(6*7)"}' | head -c 300; echo
echo "--- SCRIPT RUN powershell (mong lỗi thân thiện) ---"
curl -s --max-time 60 -X PUT http://localhost:3000/api/script -H 'Content-Type: application/json' \
  -d '{"action":"run-direct","language":"powershell","code":"Get-Date"}' | head -c 300; echo
echo "--- SCRIPT SAVE ---"
curl -s --max-time 30 -X POST http://localhost:3000/api/script -H 'Content-Type: application/json' \
  -d '{"name":"test-hello","language":"bash","code":"echo saved-ok"}' | head -c 250; echo
echo "--- SCRIPT SAVE invalid (mong 400) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 30 -X POST http://localhost:3000/api/script \
  -H 'Content-Type: application/json' -d '{"name":"","language":"bash","code":""}'
echo "--- SCRIPT RUN SAVED id=1 ---"
curl -s --max-time 60 -X PUT http://localhost:3000/api/script -H 'Content-Type: application/json' \
  -d '{"action":"run","id":1}' | head -c 250; echo
echo "--- SCRIPT DELETE id=1 ---"
curl -s --max-time 30 -X DELETE "http://localhost:3000/api/script?id=1"; echo

# 5. Các API khác
echo "--- TWEAKS GET (head) ---"
curl -s --max-time 30 http://localhost:3000/api/tweaks | head -c 120; echo
echo "--- GAMING GET ---"
curl -s --max-time 30 http://localhost:3000/api/gaming; echo
echo "--- BACKUPS GET (head) ---"
curl -s --max-time 60 http://localhost:3000/api/backups | head -c 150; echo
echo "--- STATS GET (head) ---"
curl -s --max-time 30 http://localhost:3000/api/stats | head -c 120; echo

# 6. Lint toàn dự án
echo "--- LINT ---"
bun run lint 2>&1 | tail -6
