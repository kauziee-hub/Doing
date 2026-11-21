"""Renders the website's social card (1200x630) from the hero cut-out and the brand mark.

    python -I tools/make-og.py

Uses Segoe UI from C:\\Windows\\Fonts (Outfit ships only as woff2). Output:
apps/website/public/img/og.png
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'apps' / 'website' / 'public'
FONTS = Path('C:/Windows/Fonts')
INK = (29, 28, 53)
MUTED = (107, 106, 125)
W, H = 1200, 630


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


img = Image.new('RGB', (W, H), (255, 255, 255))

# Soft aurora behind the person.
glow = Image.new('RGBA', (W, H), (255, 255, 255, 0))
g = ImageDraw.Draw(glow)
for (cx, cy, r, col) in [(880, 300, 230, (230, 225, 251, 255)), (980, 380, 200, (220, 243, 230, 255)), (820, 420, 180, (251, 225, 231, 255))]:
    g.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)
glow = glow.filter(ImageFilter.GaussianBlur(60))
img.paste(glow, (0, 0), glow)

d = ImageDraw.Draw(img)
for r, col in [(250, (236, 235, 230)), (320, (240, 239, 235))]:
    d.ellipse((900 - r, 330 - r, 900 + r, 330 + r), outline=col, width=2)

person = Image.open(SITE / 'img' / 'hero-person.webp').convert('RGBA')
ph = 600
person = person.resize((round(person.width * ph / person.height), ph), Image.LANCZOS)
fade = Image.linear_gradient('L').rotate(180).resize((person.width, ph))
alpha = person.getchannel('A')
mask = Image.composite(alpha, Image.new('L', alpha.size, 0), fade.point(lambda v: 255 if v > 60 else v * 4))
person.putalpha(mask)
img.paste(person, (900 - person.width // 2, H - ph + 40), person)

# Brand mark (same geometry as Logo.tsx, drawn at 4x then reduced).
S = 4
mark = Image.new('RGBA', (64 * S, 64 * S), (0, 0, 0, 0))
m = ImageDraw.Draw(mark)
m.rounded_rectangle((0, 0, 64 * S - 1, 64 * S - 1), radius=19 * S, fill=INK)
sw = round(7.2 * S)
m.line((20 * S, 16.5 * S, 20 * S, 49 * S), fill='white', width=sw)
m.arc((20 * S, 26.5 * S, 40 * S, 46.5 * S), 180, 360, fill='white', width=sw)
m.line((40 * S, 36.5 * S, 40 * S, 49 * S), fill='white', width=sw)
for (x, y) in [(20, 16.5), (20, 49), (40, 49)]:
    m.ellipse(((x - 3.6) * S, (y - 3.6) * S, (x + 3.6) * S, (y + 3.6) * S), fill='white')
m.ellipse(((45 - 5.4) * S, (16 - 5.4) * S, (45 + 5.4) * S, (16 + 5.4) * S), fill=(244, 163, 180))
mark = mark.resize((64, 64), Image.LANCZOS)
img.paste(mark, (72, 70), mark)
d.text((150, 80), 'Hirora', font=font('segoeuib.ttf', 40), fill=INK)

d.text((72, 200), 'Interview ', font=font('segoeuil.ttf', 74), fill=INK)
x = 72 + d.textlength('Interview ', font=font('segoeuil.ttf', 74))
d.text((x, 200), 'Calmer,', font=font('segoeuib.ttf', 74), fill=INK)
d.text((72, 290), 'Answer ', font=font('segoeui.ttf', 74), fill=INK)
x = 72 + d.textlength('Answer ', font=font('segoeui.ttf', 74))
d.text((x, 290), 'Smarter', font=font('segoeuib.ttf', 74), fill=INK)
d.text((74, 410), 'Live transcripts and résumé-grounded answer cues', font=font('segoeui.ttf', 26), fill=MUTED)
d.text((74, 446), 'in a quiet overlay on Windows. Free, no account.', font=font('segoeui.ttf', 26), fill=MUTED)

d.rounded_rectangle((72, 520, 372, 580), radius=30, fill=INK)
d.text((222, 550), 'Download for Windows', font=font('segoeuib.ttf', 22), fill='white', anchor='mm')

out = SITE / 'img' / 'og.png'
img.save(out, optimize=True)
print('wrote', out)
