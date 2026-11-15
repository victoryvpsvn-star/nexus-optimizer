#!/bin/bash
# Push code to GitHub using PAT extracted at runtime from work.txt (never printed).
set -e
cd /home/z/my-project

TOKEN="$(python3 -c "
import re, pathlib
t = pathlib.Path('upload/work.txt').read_text(errors='ignore')
m = re.search(r'github_pat_[A-Za-z0-9_]+', t)
print(m.group(0) if m else '')
")"
if [ -z "$TOKEN" ]; then echo "NO_TOKEN"; exit 1; fi

git config user.email "nexus-bot@tool.local"
git config user.name "NEXUS Bot"
git rm --cached .env >/dev/null 2>&1 || true

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then git branch -M main; fi

git add -A
git commit -m "NEXUS OPTIMIZER v1.0 - multi-tool system suite (monitor, cleanup, gaming, tweaks, backup, screenshot)" || echo "nothing to commit"

git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/victoryvpsvn-star/nexus-optimizer.git"
git push -u origin main 2>&1 | grep -v "x-access-token" | tail -5
git remote set-url origin "https://github.com/victoryvpsvn-star/nexus-optimizer.git"
echo "PUSH_DONE"
