"""
Bake the Nevermore gate plate into terminal cells.

Reads the gate artwork out of wednesday-theme/tui-design.html, rasterises it
with headless Chrome at the sub-pixel resolution the CLI will draw at, then
runs the quantiser from the design board (family I, section 2) and prints a
TypeScript data module.

This is a BUILD-TIME tool. Its output (factory/harness/plate-gate-data.ts) is
committed, so the CLI has no rasteriser and no runtime dependency: the harness
only ever reads strings.

    python scripts/bake-plate.py                 # default: the gate
    python scripts/bake-plate.py --symbol plate-crest --cols 40 --rows 16 --out /tmp/plate-crest-data.ts

Quantiser, transcribed from the board so a port is transcription rather than
interpretation:

    for each cell (c, r):
      read the four sub-pixels at (c*2 + qx, r*2 + qy)
      snap each to the nearest of SEVEN on-brand tones
      fg = brightest tone present      # detail, highlights
      bg = darkest tone present        # shadow, sky
      if fg == bg: emit a solid cell
      for each quadrant q: emit fg if nearer fg else bg
      mask bits: 1 = UL, 2 = UR, 4 = LL, 8 = LR
      flatten runs of "same fg and bg" -> one entry per run
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
BOARD = REPO / "wednesday-theme" / "tui-design.html"

# The seven on-brand tones. Quantising to a FIXED palette is what keeps the
# run count down and the colour on-system; per-cell averages do neither.
TONES = [
    ("#07070c", "voidInk"),      # 0 darkest
    ("#141020", "plumInk"),      # 1
    ("#2b2340", "ironViolet"),   # 2
    ("#5d43a0", "nevermoreDeep"),# 3
    ("#8b6fd4", "nevermore"),    # 4
    ("#ffb84d", "amber"),        # 5
    ("#ece6da", "bone"),         # 6 brightest
]

# mask bit -> character. Bits are 1=UL, 2=UR, 4=LL, 8=LR (sample() order
# UL,UR,LL,LR). Quadrant blocks are Unicode 2.0 and safe everywhere; sextants
# (U+1FB00+) and octants (U+1CD00+) were measured and both render as tofu.
QUADRANT = {
    0b0000: " ",   # nothing set -> the cell is all background
    0b0001: "▘",   # upper-left
    0b0010: "▝",   # upper-right
    0b0011: "▀",   # upper half
    0b0100: "▖",   # lower-left
    0b0101: "▌",   # left half
    0b0110: "▞",   # UR+LL diagonal
    0b0111: "▛",   # all but lower-right
    0b1000: "▗",   # lower-right
    0b1001: "▚",   # UL+LR diagonal
    0b1010: "▐",   # right half
    0b1011: "▜",   # all but lower-left
    0b1100: "▄",   # lower half
    0b1101: "▙",   # all but upper-right
    0b1110: "▟",   # all but upper-left
    0b1111: "█",   # solid
}

SOLID = "█"


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


RGB_TONES = [hex_to_rgb(hexv) for hexv, _ in TONES]


def luma(rgb: tuple[int, int, int]) -> float:
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


# Ordered by brightness so index order IS lightness order; the quantiser relies
# on that when it picks "brightest tone present" and "darkest tone present".
ORDER = sorted(range(len(RGB_TONES)), key=lambda i: luma(RGB_TONES[i]))
TONES_BY_LUMA = [RGB_TONES[i] for i in ORDER]
NAMES_BY_LUMA = [TONES[i][1] for i in ORDER]


def nearest_tone(rgb: tuple[int, int, int]) -> int:
    """Index into the luma-ordered tone list of the nearest on-brand tone."""
    best, best_d = 0, None
    for i, tone in enumerate(TONES_BY_LUMA):
        # Weighted distance: the eye is most sensitive to green, least to blue,
        # so a flat euclidean metric picks colours the display will not show.
        # Green highest, red middle, blue lowest.
        d = 2 * (rgb[0] - tone[0]) ** 2 + 4 * (rgb[1] - tone[1]) ** 2 + 1 * (rgb[2] - tone[2]) ** 2
        if best_d is None or d < best_d:
            best, best_d = i, d
    return best


def extract_symbol(board: Path, symbol_id: str) -> tuple[str, tuple[int, int]]:
    """
    Pull one <symbol id=...>...</symbol> out of the design board and return its
    INNER content plus its viewBox.

    The <symbol> wrapper is dropped: a <symbol> is a template that only paints
    through <use>, so pasting one into a document renders nothing at all and
    the screenshot comes back as a single flat colour. The inner markup is what
    actually draws.
    """
    text = board.read_text(encoding="utf-8")
    start = text.find(f'<symbol id="{symbol_id}"')
    if start < 0:
        raise SystemExit(f"symbol {symbol_id!r} not found in {board}")
    open_end = text.find(">", start)
    header = text[start:open_end]
    end = text.find("</symbol>", open_end)
    if end < 0:
        raise SystemExit(f"unterminated symbol {symbol_id!r}")
    viewbox = viewbox_of(header)
    return text[open_end + 1 : end], viewbox


def viewbox_of(svg: str) -> tuple[int, int]:
    m = re.search(r'viewBox="([\d.\s-]+)"', svg)
    if not m:
        raise SystemExit("symbol has no viewBox")
    parts = [float(v) for v in m.group(1).split()]
    return int(parts[2]), int(parts[3])


def fit_box(aspect_w: int, aspect_h: int, cols: int, rows: int) -> tuple[int, int]:
    """
    Fit is DERIVED, never fixed (design board section 3): the cell box comes from
    the artwork's own aspect and the row budget, so a portrait window and a
    landscape gate both look deliberate instead of one being letterboxed into a
    shape it does not belong in.
    """
    aspect = aspect_w / aspect_h
    w = max(8, min(cols, round(rows * aspect)))
    h = round(w / aspect)
    if h > rows:
        h = rows
        w = max(8, round(h * aspect))
    return w, h


def rasterise(svg_inner: str, width: int, height: int, chrome: str, viewbox: tuple[int, int]) -> Image.Image:
    """
    Render the symbol to a width x height bitmap using headless Chrome.

    The SVG is wrapped in a minimal HTML document rather than loaded as a bare
    .svg file: Chrome's file:// SVG handling leaves a transparent page whose
    screenshot comes back empty at the sizes we need, whereas an inline <svg> in
    a document renders on the first paint.

    The viewBox stays the artwork's OWN (0 0 1200 320) and only the pixel size
    changes — that is what scales the drawing to the sub-pixel canvas. Overriding
    the viewBox with the output size would crop the plate to its top-left
    corner, which is the same class of silent failure as the blank render.
    """
    doc = f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;background:#07070c}}
svg{{display:block;width:{width}px;height:{height}px}}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"
     viewBox="0 0 {viewbox[0]} {viewbox[1]}">{svg_inner}</svg>
</body></html>"""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "plate.html").write_text(doc, encoding="utf-8")
        png = tmp_path / "plate.png"
        result = subprocess.run(
            [
                chrome,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--no-sandbox",
                "--force-device-scale-factor=1",
                "--virtual-time-budget=4000",
                f"--screenshot={png}",
                f"--window-size={width},{height}",
                (tmp_path / "plate.html").as_uri(),
            ],
            capture_output=True,
        )
        if result.returncode != 0 or not png.exists():
            sys.stderr.write(result.stderr.decode("utf-8", "replace"))
            raise SystemExit(f"chrome failed ({result.returncode})")
        image = Image.open(png).convert("RGB")
        # A blank render is a silent failure mode: an all-one-colour plate would
        # bake into a field of solid blocks and look like a working result.
        # Count distinct colors exactly (getcolors caps at maxcolors and returns
        # None past it — treating None as blank would refuse good renders).
        distinct = set(image.getdata())
        if len(distinct) <= 1:
            raise SystemExit("chrome produced a blank image — refusing to bake a solid plate")
        return image


def sample(image: Image.Image, cols: int, rows: int) -> list[list[tuple[int, int, int]]]:
    """
    Run the quantiser. Returns one (fg, bg, char) triple per cell.

    The canvas is (cols*2) x (rows*2) SUB-PIXELS: a terminal cell is about
    8x17 device pixels and Unicode gives us four of them, each cell carrying an
    independent foreground and background colour. So a 68-column frame is a
    136 x 48 pixel canvas with two tones per four pixels, and that is the
    resolution at which the real artwork still reads.
    """
    sub_w, sub_h = cols * 2, rows * 2
    src = image.resize((sub_w, sub_h), Image.LANCZOS)
    pixels = src.load()
    cells: list[list[tuple[int, int, int]]] = []
    for r in range(rows):
        row: list[tuple[int, int, int]] = []
        for c in range(cols):
            quad_px = []
            quad = []
            for qy in range(2):
                for qx in range(2):
                    px = pixels[c * 2 + qx, r * 2 + qy]
                    quad_px.append(px)
                    quad.append(nearest_tone(px))
            fg = max(quad)   # brightest tone present -> detail, highlights
            bg = min(quad)   # darkest tone present  -> shadow, sky
            if fg == bg:
                row.append((fg, bg, SOLID))
                continue
            mask = 0
            for index, px in enumerate(quad_px):
                # RGB distance to the two candidate tones, not rank distance:
                # adjacent ranks can be far apart in color (nevermore to
                # amber), and rank distance gave those quadrants away wrongly.
                fg_rgb, bg_rgb = TONES_BY_LUMA[fg], TONES_BY_LUMA[bg]
                d_fg = 2 * (px[0] - fg_rgb[0]) ** 2 + 4 * (px[1] - fg_rgb[1]) ** 2 + 1 * (px[2] - fg_rgb[2]) ** 2
                d_bg = 2 * (px[0] - bg_rgb[0]) ** 2 + 4 * (px[1] - bg_rgb[1]) ** 2 + 1 * (px[2] - bg_rgb[2]) ** 2
                if d_fg <= d_bg:
                    mask |= 1 << index
            row.append((fg, bg, QUADRANT[mask]))
        cells.append(row)
    return cells


def to_typescript(cells, cols, rows, symbol_id) -> str:
    """
    Flatten into runs of "same fg and bg". A 132 x 26 frame is ~3,400 cells and
    roughly 1,900 spans without this; merging runs before writing is the single
    cheapest win in the whole renderer.
    """
    lines: list[str] = []
    for row in cells:
        runs: list[dict] = []
        for fg, bg, char in row:
            if runs and runs[-1]["fg"] == fg and runs[-1]["bg"] == bg:
                runs[-1]["chars"].append(char)
            else:
                runs.append({"fg": fg, "bg": bg, "chars": [char]})
        parts = []
        for run in runs:
            text = "".join(run["chars"])
            parts.append(
                f'{{ f: {run["fg"]}, b: {run["bg"]}, s: {json.dumps(text, ensure_ascii=False)} }}'
            )
        lines.append("    [" + ", ".join(parts) + "],")
    body = "\n".join(lines)
    return f'''/**
 * The `{symbol_id}` plate, baked into terminal cells.
 *
 * GENERATED FILE — do not edit. Rebuild with:
 *   python scripts/bake-plate.py --symbol {symbol_id}
 *
 * Source artwork: the `{symbol_id}` symbol in wednesday-theme/tui-design.html,
 * the design record. That file is the review surface; this is the CLI's copy,
 * and the two must not drift.
 *
 * NOTE: export names are GATE_* (the only plate wired into `plate.ts`).
 * Baking another symbol with the default --out overwrites the gate module with
 * mislabeled exports — pass --out explicitly and wire the new names before
 * baking anything but plate-gate.
 *
 * {cols} x {rows} cells, each cell one quadrant-block glyph (U+2580/U+2584/U+2588/U+258C/U+2590/U+2596..U+259F) with an
 * independent foreground and background tone, so a cell is 2x2 sub-pixels and
 * the whole plate is {cols * 2} x {rows * 2} at two tones each. Tone indices
 * are positions in TONE_NAMES below (luma order: 0 darkest, 6 brightest).
 *
 * Rows are top to bottom; each row is a list of runs, and a run is a maximal
 * stretch of cells sharing one foreground and one background. Runs, not cells,
 * because a plate is mostly large flat areas and 3,400 individual cells would
 * be 3,400 escape sequences.
 */
export const GATE_COLS = {cols}
export const GATE_ROWS = {rows}

export const TONE_NAMES = [
{chr(10).join(f"  '{name}'," for name in NAMES_BY_LUMA)}
] as const

/** Tone index -> 256-colour code, for terminals without truecolor. */
export const TONE_256 = [
{chr(10).join(f"  {hex_to_ansi(hexv)}," for hexv, _ in [TONES[i] for i in ORDER])}
] as const

export interface PlateRun {{
  /** Tone index used as the foreground (the brightest in the cell). */
  f: number
  /** Tone index used as the background (the darkest in the cell). */
  b: number
  /** One glyph per cell; U+2596..U+259F, or a space. */
  s: string
}}

export const GATE_PLATE: PlateRun[][] = [
{body}
]
'''


def hex_to_ansi(hexv: str) -> int:
    """Nearest xterm-256 index, matching factory/harness/theme.ts hexTo256."""
    r, g, b = hex_to_rgb(hexv)
    if abs(r - g) < 8 and abs(g - b) < 8:
        gray = round((r + g + b) / 3)
        if 8 <= gray <= 238:
            return 232 + round((gray - 8) / 10)
    q = lambda v: 0 if v < 48 else min(5, round((v - 55) / 40))
    return 16 + 36 * q(r) + 6 * q(g) + q(b)


CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome(explicit: str | None) -> str:
    if explicit:
        return explicit
    for candidate in CHROME_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    raise SystemExit("no Chrome/Chromium found; pass --chrome <path>")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", default="plate-gate")
    ap.add_argument("--cols", type=int, default=68)
    ap.add_argument("--rows", type=int, default=14)
    ap.add_argument("--out", default="factory/harness/plate-gate-data.ts")
    ap.add_argument("--chrome", default=None)
    args = ap.parse_args()

    chrome = find_chrome(args.chrome)
    svg_inner, (aspect_w, aspect_h) = extract_symbol(BOARD, args.symbol)
    cols, rows = fit_box(aspect_w, aspect_h, args.cols, args.rows)
    print(f"symbol {args.symbol} viewBox {aspect_w}x{aspect_h} -> cells {cols}x{rows}")

    image = rasterise(svg_inner, cols * 2, rows * 2, chrome, (aspect_w, aspect_h))
    cells = sample(image, cols, rows)
    out_path = REPO / args.out
    out_path.write_text(to_typescript(cells, cols, rows, args.symbol), encoding="utf-8")
    runs = sum(len(row) for row in cells)
    print(f"wrote {out_path.relative_to(REPO)} ({runs} runs across {rows} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
