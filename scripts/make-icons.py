#!/usr/bin/env python3
"""Generate the PWA icon set.

Pure stdlib so it runs anywhere without an image library. The mark is an
abstract plate viewed from above: concentric rings in the app's palette.
Re-run with `python3 scripts/make-icons.py` after changing the colours.
"""
import struct
import zlib
from pathlib import Path

INK = (0x1C, 0x19, 0x17)
PAPER = (0xFA, 0xF9, 0xF7)
ACCENT = (0xB4, 0x53, 0x09)

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SS = 4  # supersampling factor, for smooth edges


def render(size: int, scale: float) -> bytes:
    """RGB pixel buffer. `scale` shrinks the mark to leave a maskable safe zone."""
    hi = size * SS
    centre = hi / 2
    rings = [(0.34 * scale, PAPER), (0.26 * scale, ACCENT), (0.10 * scale, PAPER)]
    radii = [(r * hi, colour) for r, colour in rings]

    rows = []
    for y in range(hi):
        row = bytearray()
        dy = y - centre + 0.5
        for x in range(hi):
            dx = x - centre + 0.5
            distance = (dx * dx + dy * dy) ** 0.5
            colour = INK
            for radius, ring_colour in radii:
                if distance <= radius:
                    colour = ring_colour
            row += bytes(colour)
        rows.append(row)

    # Box-downsample back to the target size for antialiasing.
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type: none
        for x in range(size):
            totals = [0, 0, 0]
            for sy in range(SS):
                row = rows[y * SS + sy]
                for sx in range(SS):
                    base = (x * SS + sx) * 3
                    totals[0] += row[base]
                    totals[1] += row[base + 1]
                    totals[2] += row[base + 2]
            count = SS * SS
            out += bytes(total // count for total in totals)
    return bytes(out)


def chunk(tag: bytes, data: bytes) -> bytes:
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def write_png(path: Path, size: int, scale: float = 1.0) -> None:
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(render(size, scale), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"  {path.name}  {size}×{size}  {len(png):,} bytes")


OUT.mkdir(parents=True, exist_ok=True)
write_png(OUT / "icon-192.png", 192)
write_png(OUT / "icon-512.png", 512)
# Maskable icons are cropped to a circle on some launchers; keep the mark
# inside the inner 80% so nothing important is clipped.
write_png(OUT / "icon-512-maskable.png", 512, scale=0.78)
write_png(OUT / "apple-touch-icon.png", 180)
