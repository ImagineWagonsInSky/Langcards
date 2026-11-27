#!/usr/bin/env python3
"""Generate the app icons in assets/icons/ (needs Pillow and the DejaVu fonts)."""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "icons")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_icon(size, maskable=False, rounded=True):
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # diagonal gradient: Spanish red/gold -> Italian green
    grad = Image.new("RGB", (S, S))
    gp = grad.load()
    c1, c2, c3 = (198, 40, 40), (230, 150, 30), (0, 140, 70)
    for y in range(S):
        for x in range(0, S, 4):
            t = (x + y) / (2 * S)
            col = lerp(c1, c2, t * 2) if t < 0.5 else lerp(c2, c3, (t - 0.5) * 2)
            for k in range(4):
                if x + k < S:
                    gp[x + k, y] = col
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    if rounded and not maskable:
        md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    else:
        md.rectangle([0, 0, S, S], fill=255)
    img.paste(grad, (0, 0), mask)

    scale = 0.62 if maskable else 0.8
    cw, ch = int(S * scale), int(S * scale * 0.72)
    cx, cy = S // 2, S // 2
    # back card, blended semi-transparent white (offset to look like a stack of cards)
    off = int(S * 0.05)
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        [cx - cw // 2 + off, cy - ch // 2 - off, cx + cw // 2 + off, cy + ch // 2 - off],
        radius=int(S * 0.06), fill=(255, 255, 255, 110))
    img = Image.alpha_composite(img, layer)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([cx - cw // 2, cy - ch // 2, cx + cw // 2, cy + ch // 2],
                        radius=int(S * 0.06), fill=(255, 255, 255, 255))
    f_big = ImageFont.truetype(FONT, int(ch * 0.42))
    f_small = ImageFont.truetype(FONT, int(ch * 0.17))
    t1, t2 = "¡hola!", "ciao"
    w1 = d.textlength(t1, font=f_small)
    w2 = d.textlength(t2, font=f_big)
    d.text((cx - w1 / 2, cy - ch * 0.36), t1, font=f_small, fill=(198, 40, 40, 255))
    d.text((cx - w2 / 2, cy - ch * 0.17), t2, font=f_big, fill=(0, 120, 60, 255))
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in (192, 512):
        draw_icon(s).save(os.path.join(OUT, f"icon-{s}.png"))
        draw_icon(s, maskable=True).save(os.path.join(OUT, f"maskable-{s}.png"))
    # iOS ignores transparency: use a full-bleed square (iOS rounds the corners itself)
    draw_icon(180, rounded=False).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    draw_icon(64).save(os.path.join(OUT, "favicon.png"))
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
