from PIL import Image, ImageDraw, ImageFilter, ImageChops
S = 2048
def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

def gradient(size, c1, c2, direction='diag'):
    w, h = size
    g = Image.new('RGBA', size)
    px = g.load()
    for y in range(h):
        for x in range(0, w):
            t = ((x / w) * 0.45 + (y / h) * 0.55) if direction == 'diag' else y / h
            px[x, y] = lerp(c1, c2, t)
    return g

# --- background squircle with sky gradient
small = gradient((256, 256), (30, 32, 38, 255), (0, 0, 0, 255))  # black background
bg = small.resize((S, S), Image.BICUBIC)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([64, 64, S - 64, S - 64], radius=470, fill=255)
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(bg, (0, 0), mask)

# soft highlight top-left
hl = Image.new('L', (S, S), 0)
ImageDraw.Draw(hl).ellipse([-500, -700, 1500, 900], fill=28)
hl = hl.filter(ImageFilter.GaussianBlur(220))
hl = ImageChops.multiply(hl, mask)
img.alpha_composite(Image.merge('RGBA', [Image.new('L', (S, S), 255)] * 3 + [hl]))

# --- cloud shape
cloud = Image.new('L', (S, S), 0)
d = ImageDraw.Draw(cloud)
for (cx, cy, rr) in [(640, 1180, 210), (920, 960, 330), (1270, 1030, 270), (1470, 1240, 185)]:
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=255)
d.rounded_rectangle([440, 1190, 1660, 1430], radius=120, fill=255)
# smooth the joins between the puffs, then make the edge crisp again
cloud = cloud.filter(ImageFilter.GaussianBlur(20)).point(lambda v: 255 if v > 128 else 0).filter(ImageFilter.GaussianBlur(2))

# shadow under the cloud
shadow = cloud.filter(ImageFilter.GaussianBlur(55)).point(lambda v: int(v * 0.32))
shadow = ImageChops.offset(shadow, 0, 60)
shadow = ImageChops.multiply(shadow, mask)
img.alpha_composite(Image.merge('RGBA', [Image.new('L', (S, S), 14), Image.new('L', (S, S), 40), Image.new('L', (S, S), 120), shadow]))

# cloud body: white -> soft blue at the bottom
body = gradient((64, 256), (255, 255, 255, 255), (214, 230, 255, 255), 'vert').resize((S, S), Image.BICUBIC)
# gradient only across cloud's vertical span
span = Image.new('RGBA', (S, S))
band = gradient((8, 860), (255, 255, 255, 255), (208, 225, 255, 255), 'vert').resize((S, 860), Image.BICUBIC)
span.paste((255, 255, 255, 255), (0, 0, S, 570))
span.paste(band, (0, 570))
span.paste((208, 225, 255, 255), (0, 1430, S, S))
img.paste(span, (0, 0), cloud)

# subtle inner rim light along the cloud top
rim = cloud.filter(ImageFilter.GaussianBlur(18))
rim = ImageChops.subtract(cloud, ImageChops.offset(rim, 0, 26))
img.alpha_composite(Image.merge('RGBA', [Image.new('L', (S, S), 255)] * 3 + [rim.point(lambda v: int(v * 0.6))]))

final = img.resize((1024, 1024), Image.LANCZOS)
final.save('build/icon.png')
final.resize((256, 256), Image.LANCZOS).save('src/ui/icon.png')
final.resize((256, 256), Image.LANCZOS).save('src/pages/icon.png')
final.save('build/icon.ico', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
# preview sheet
sheet = Image.new('RGBA', (1024 + 40 + 256 + 20 + 64 + 20 + 32 + 20 + 16 + 40, 1064), (236, 240, 246, 255))
x = 20
for sz in [1024, 256, 64, 32, 16]:
    sheet.alpha_composite(final.resize((sz, sz), Image.LANCZOS), (x, 20 + (1024 - sz) // 2))
    x += sz + 20
sheet.convert('RGB').save('/tmp/logo-sheet.png')
