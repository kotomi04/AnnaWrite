#!/usr/bin/env python3
"""Create a local style-draft PNG for AnnaVisual tests.

Usage:
  python3 scripts/save-style-draft-to-desktop-test.py [package.json]

If package.json is omitted, the script writes a neutral preview so the target
folder exists and the user can verify where future draft images should live.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path("/Users/qinghuasun/Desktop/test")


def hex_to_rgb(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))
    return fallback


def collect_colors(pkg: dict) -> list[str]:
    colors: list[str] = []
    req = pkg.get("design_requirements", {})
    color_system = req.get("color_system", {})
    for key in ("primary_colors", "auxiliary_colors", "primary", "secondary"):
        for item in color_system.get(key, []) or []:
            if isinstance(item, dict) and item.get("hex"):
                colors.append(item["hex"])
            elif isinstance(item, str):
                colors.append(item)
    preview = pkg.get("final_prompt_object", {}).get("preview", {})
    colors.extend(preview.get("palette", []) or [])
    unique = []
    for color in colors:
        if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color) and color.upper() not in unique:
            unique.append(color.upper())
    return unique[:6] or ["#F0F0F0", "#FFFFFF", "#1070D0", "#17151C"]


def safe_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def draw_round(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill, outline=None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def build_image(pkg: dict, out_path: Path) -> None:
    colors = collect_colors(pkg)
    c1 = hex_to_rgb(colors[0], (240, 240, 240))
    c2 = hex_to_rgb(colors[1] if len(colors) > 1 else colors[0], (255, 255, 255))
    c3 = hex_to_rgb(colors[2] if len(colors) > 2 else "#1070D0", (16, 112, 208))
    ink = hex_to_rgb(colors[-1], (23, 21, 28))

    w, h = 960, 540
    img = Image.new("RGB", (w, h), c1)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        for x in range(w):
            s = x / max(1, w - 1)
            mix = 0.55 * t + 0.45 * s
            px[x, y] = tuple(int(c1[i] * (1 - mix) + c2[i] * mix) for i in range(3))

    draw = ImageDraw.Draw(img, "RGBA")
    draw.ellipse((520, 70, 1020, 570), fill=(*c3, 42))
    draw.ellipse((660, -120, 1060, 250), fill=(*c2, 78))

    draw_round(draw, (44, 46, 360, 494), 28, (255, 255, 255, 118), (255, 255, 255, 170), 2)
    title_font = safe_font(34, bold=True)
    body_font = safe_font(18)
    small_font = safe_font(14, bold=True)
    brand = pkg.get("user_context", {}).get("brand_name") or pkg.get("design_requirements", {}).get("brand_profile", {}).get("description") or "AnnaVisual"
    draw.text((78, 104), "STYLE CUES", fill=(*ink, 220), font=title_font)
    draw.text((78, 148), str(brand)[:32], fill=(*ink, 150), font=body_font)
    labels = ["palette", "layout", "type", "asset rules"]
    for i, label in enumerate(labels):
        y = 210 + i * 52
        fill = hex_to_rgb(colors[i % len(colors)], c3)
        draw_round(draw, (78, y, 180 + i * 24, y + 30), 10, (*fill, 210))
        draw.text((204, y + 5), label.upper(), fill=(*ink, 145), font=small_font)

    cx, cy = 640, 284
    draw.ellipse((cx - 230, cy - 148, cx + 230, cy + 148), outline=(*c3, 150), width=4)
    for x, y, label in [
        (430, 142, "color"),
        (680, 130, "surface"),
        (410, 350, "layout"),
        (704, 348, "rules"),
    ]:
        draw_round(draw, (x, y, x + 174, y + 96), 22, (255, 255, 255, 116), (255, 255, 255, 170), 2)
        draw_round(draw, (x + 18, y + 20, x + 52, y + 54), 10, (*c3, 115))
        draw.text((x + 66, y + 28), label.upper(), fill=(*ink, 180), font=small_font)
        draw_round(draw, (x + 66, y + 58, x + 142, y + 67), 4, (*ink, 45))

    draw_round(draw, (560, 180, 730, 410), 42, (*c3, 148), (255, 255, 255, 190), 3)
    draw.text((598, 260), "STYLE", fill=(*ink, 165), font=safe_font(22, bold=True))
    draw.text((590, 292), "ANCHOR", fill=(*ink, 165), font=safe_font(22, bold=True))
    draw.text((44, h - 34), "Generated from AnnaVisual Brand Profile + JSON prompt", fill=(*ink, 150), font=safe_font(14, bold=True))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)


def main() -> None:
    pkg: dict = {}
    if len(sys.argv) > 1:
        pkg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    brand = pkg.get("user_context", {}).get("brand_name") or "AnnaVisual"
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", brand).strip("_") or "AnnaVisual"
    out = OUT_DIR / f"{safe_name}_abstract_style_draft.png"
    build_image(pkg, out)
    print(out)


if __name__ == "__main__":
    main()
