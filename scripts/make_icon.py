#!/usr/bin/env python3
"""Tạo build/icon.ico nhiều kích thước từ public/img/logo-sakura.png (dùng cho Windows build)."""
from PIL import Image
import pathlib

SRC = pathlib.Path('/home/z/my-project/public/img/logo-sakura.png')
OUT = pathlib.Path('/home/z/my-project/build/icon.ico')
OUT.parent.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert('RGBA')
# Nền trong suốt đã có sẵn; đảm bảo vuông
side = max(img.size)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
canvas = canvas.resize((256, 256), Image.LANCZOS)
canvas.save(OUT, format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print('OK:', OUT, OUT.stat().st_size, 'bytes')
