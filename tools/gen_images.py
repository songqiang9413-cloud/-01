# -*- coding: utf-8 -*-
"""生成小程序需要的少量 PNG 资源（tabBar 图标 + 默认头像），全部用代码画，避免引入第三方素材版权问题。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'images')
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

SIZE = 81
SS = 8  # 超采样倍数，先用大图画完再缩小，边缘才平滑


def canvas():
    img = Image.new('RGBA', (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def save(img, name):
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path, 'PNG')
    print('wrote', path)


def draw_home(d, color, width):
    s = SIZE * SS
    # 屋顶
    d.line([(s * 0.14, s * 0.46), (s * 0.5, s * 0.16), (s * 0.86, s * 0.46)],
           fill=color, width=width, joint='curve')
    # 墙体
    d.line([(s * 0.22, s * 0.43), (s * 0.22, s * 0.82), (s * 0.78, s * 0.82), (s * 0.78, s * 0.43)],
           fill=color, width=width, joint='curve')
    # 门
    d.line([(s * 0.42, s * 0.82), (s * 0.42, s * 0.6), (s * 0.58, s * 0.6), (s * 0.58, s * 0.82)],
           fill=color, width=width, joint='curve')


def draw_home_filled(d, color):
    s = SIZE * SS
    d.polygon([(s * 0.5, s * 0.13), (s * 0.92, s * 0.49), (s * 0.8, s * 0.49),
               (s * 0.8, s * 0.84), (s * 0.58, s * 0.84), (s * 0.58, s * 0.58),
               (s * 0.42, s * 0.58), (s * 0.42, s * 0.84), (s * 0.2, s * 0.84),
               (s * 0.2, s * 0.49), (s * 0.08, s * 0.49)], fill=color)


def draw_mine(d, color, width):
    s = SIZE * SS
    # 头
    d.ellipse([(s * 0.36, s * 0.16), (s * 0.64, s * 0.44)], outline=color, width=width)
    # 身体
    d.arc([(s * 0.18, s * 0.48), (s * 0.82, s * 1.02)], start=180, end=360, fill=color, width=width)


def draw_mine_filled(d, color):
    s = SIZE * SS
    d.ellipse([(s * 0.35, s * 0.15), (s * 0.65, s * 0.45)], fill=color)
    d.pieslice([(s * 0.17, s * 0.47), (s * 0.83, s * 1.03)], start=180, end=360, fill=color)


W = int(SIZE * SS * 0.075)

GRAY = (154, 163, 178, 255)
BLUE = (51, 122, 255, 255)
LIGHT = (200, 208, 220, 255)

img, d = canvas(); draw_home(d, GRAY, W); save(img, 'tab-home.png')
img, d = canvas(); draw_home_filled(d, BLUE); save(img, 'tab-home-active.png')
img, d = canvas(); draw_mine(d, GRAY, W); save(img, 'tab-mine.png')
img, d = canvas(); draw_mine_filled(d, BLUE); save(img, 'tab-mine-active.png')

# 默认头像：浅灰圆底 + 人形
img, d = canvas()
s = SIZE * SS
d.ellipse([(0, 0), (s - 1, s - 1)], fill=(236, 240, 247, 255))
draw_mine_filled(d, LIGHT)
save(img, 'avatar-default.png')
