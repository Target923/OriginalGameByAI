# サーチバトル：キューブの柄（素材の質感）の SVG を作り、CSS（src/template.html）に data URI として書き込む。
#
# ねらい：色の見え方に特性があっても、どの個体かを見分けられるようにする（ui.js の patHTML）。
#  形の柄（図形）は使わず、石・木・金属の「質感」だけで見分ける（ユーザーの希望。2026-10-29）。
#  白と黒の半透明だけで描くので、下のキューブの色がそのまま透けて、どの色のキューブにも合う。
#
# 割り当て（色の番号＝置いた順）：
#  1 御影石（細かい粒）／2 コンクリート（くもりと気泡）／3 トラバーチン（横の層と細長い穴）／4 ヘアライン（金属の細い縦筋）
#  5 大理石（うねる筋）／6 木目／7 スレート（斜めの層）／8 テラゾー（石のかけら）
#  色覚の特性で近く見える色の組（1と4・2と5・3と7・6と8・2と6 など）は、「粒・穴」と「筋」のように系統の違う質感にした。
#
# 2つの描き方：
#  ・粒・穴・筋の細かい質感（1・2・4・8）：決まった大きさ（px）の「つなぎ目なく並べられる1区画」。
#    マスが小さくても粒が潰れない。マスごとに区画の見える位置をずらす（となりのマスと同じ見た目にしない）
#  ・大きな模様（3・5・6・7）：1マスに1枚。マスごとに反転・回転して、同じ見た目が並ばないようにする
#
# 使い方：python3 tools/tile_patterns.py            → src/template.html の印（tile-patterns:start〜end）のあいだを書き換える
#         python3 tools/tile_patterns.py --svg 出力先 → 確認用に p1.svg〜p8.svg も書き出す
import math, os, random, sys

def n(x):
    s = ('%.1f' % x)
    return s[:-2] if s.endswith('.0') else s

def svg(w, h, body, defs='', stretch=False):
    par = " preserveAspectRatio='none'" if stretch else ''
    return f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {n(w)} {n(h)}'{par}>" + (f"<defs>{defs}</defs>" if defs else '') + body + "</svg>"

def wraps(x, y, r, T):
    # 区画の端にかかる粒は、反対側にも描く（並べたときに切れ目ができない）
    xs = [0] + ([T] if x - r < 0 else []) + ([-T] if x + r > T else [])
    ys = [0] + ([T] if y - r < 0 else []) + ([-T] if y + r > T else [])
    return [(dx, dy) for dx in xs for dy in ys]

def dots(pts, color, alpha, width):
    # 丸い粒：長さ0の線を丸い端で描く（circle を並べるより短く書ける）
    if not pts: return ''
    d = ''.join(f"M{n(x)} {n(y)}h0" for x, y in pts)
    return f"<path d='{d}' stroke='{color}' stroke-opacity='{alpha}' stroke-width='{n(width)}' stroke-linecap='round'/>"

# 1 御影石：黒と白の細かい粒がびっしり（52px 四方の区画）
def granite():
    T = 52; R = random.Random(11); out = []
    for color, alpha, width, count in (('#000', .30, 1.3, 70), ('#000', .2, 2.4, 22), ('#fff', .36, 1.2, 46), ('#fff', .5, .8, 14)):
        pts = []
        for _ in range(count):
            x, y = R.uniform(0, T), R.uniform(0, T)
            pts += [(x + dx, y + dy) for dx, dy in wraps(x, y, width, T)]
        out.append(dots(pts, color, alpha, width))
    return svg(T, T, ''.join(out)), T

# 2 コンクリート：大きなくもり（明るい・暗い）と、まばらな気泡の穴（96px 四方）
def concrete():
    T = 96; R = random.Random(23); out = []
    defs = ("<radialGradient id='w'><stop offset='0' stop-color='#fff' stop-opacity='.13'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
            "<radialGradient id='k'><stop offset='0' stop-color='#000' stop-opacity='.12'/><stop offset='1' stop-color='#000' stop-opacity='0'/></radialGradient>")
    for gid, count in (('w', 6), ('k', 6)):
        for _ in range(count):
            x, y, rx, ry = R.uniform(0, T), R.uniform(0, T), R.uniform(14, 30), R.uniform(10, 22)
            for dx, dy in wraps(x, y, max(rx, ry), T):
                out.append(f"<ellipse cx='{n(x + dx)}' cy='{n(y + dy)}' rx='{n(rx)}' ry='{n(ry)}' fill='url(#{gid})'/>")
    # 細かい砂
    for color, alpha in (('#000', .14), ('#fff', .16)):
        pts = []
        for _ in range(45):
            x, y = R.uniform(0, T), R.uniform(0, T)
            pts += [(x + dx, y + dy) for dx, dy in wraps(x, y, 1, T)]
        out.append(dots(pts, color, alpha, .8))
    # 気泡の穴：右下に明るい縁（へこんで見える）を先に描き、その上に暗い穴
    holes = [(R.uniform(0, T), R.uniform(0, T), R.uniform(1.8, 3.6)) for _ in range(17)]
    for color, alpha, off in (('#fff', .34, .7), ('#000', .44, 0)):
        for w in sorted(set(round(h[2], 1) for h in holes)):
            pts = []
            for x, y, d in holes:
                if round(d, 1) != w: continue
                pts += [(x + dx + off, y + dy + off) for dx, dy in wraps(x, y, d, T)]
            out.append(dots(pts, color, alpha, w))
    return svg(T, T, ''.join(out), defs), T

# 3 トラバーチン：横に流れる淡い層と、横長の小さな穴（1マスに1枚）
def travertine():
    R = random.Random(37)
    stops = [(0, '#fff', .07), (.1, '#fff', 0), (.19, '#000', .07), (.27, '#000', 0), (.38, '#fff', .09), (.47, '#fff', 0),
             (.58, '#000', .06), (.66, '#fff', .06), (.76, '#fff', 0), (.86, '#000', .07), (1, '#000', .02)]
    defs = "<linearGradient id='b' x1='0' y1='0' x2='0' y2='1'>" + ''.join(f"<stop offset='{o}' stop-color='{c}' stop-opacity='{a}'/>" for o, c, a in stops) + "</linearGradient>"
    out = ["<rect width='100' height='100' fill='url(#b)'/>"]
    # 層の境目の細い線（ゆるくうねる）
    for y0, color, alpha in ((22, '#000', .13), (49, '#fff', .17), (71, '#000', .11), (90, '#fff', .13)):
        d = f"M-2 {n(y0)}" + ''.join(f"Q{n(x - 8)} {n(y0 + R.uniform(-2.2, 2.2))} {n(x)} {n(y0 + R.uniform(-1.2, 1.2))}" for x in range(16, 118, 16))
        out.append(f"<path d='{d}' fill='none' stroke='{color}' stroke-opacity='{alpha}' stroke-width='.7'/>")
    # 横長の穴：下に明るい縁、その上に暗い穴
    pits = [(R.uniform(4, 96), R.uniform(5, 95), R.uniform(3, 11), R.uniform(1.4, 2.8)) for _ in range(16)]
    for color, alpha, off in (('#fff', .26, .9), ('#000', .32, 0)):
        for x, y, L, t in pits:
            out.append(f"<path d='M{n(x - L / 2)} {n(y + off)}h{n(L)}' stroke='{color}' stroke-opacity='{alpha}' stroke-width='{n(t)}' stroke-linecap='round'/>")
    return svg(100, 100, ''.join(out), defs, stretch=True), None

# 4 ヘアライン：金属を一方向に磨いた、細い縦の筋（60px 四方。上下はそのまま続く）
def hairline():
    T = 60; R = random.Random(41); out = []
    groups = {}
    for _ in range(64):
        x = R.uniform(0, T); color = '#fff' if R.random() < .55 else '#000'
        alpha = R.choice((.1, .16, .24)); width = R.choice((.4, .7))
        groups.setdefault((color, alpha, width), []).append(x)
    for (color, alpha, width), xs in sorted(groups.items()):
        d = ''.join(f"M{n(x)} 0V{T}" for x in xs) + ''.join(f"M{n(x + T)} 0V{T}M{n(x - T)} 0V{T}" for x in xs if x < width or x > T - width)
        out.append(f"<path d='{d}' stroke='{color}' stroke-opacity='{alpha}' stroke-width='{n(width)}'/>")
    return svg(T, T, ''.join(out)), T

# 5 大理石：やわらかなくもりと、斜めにうねる白い筋・細い枝・灰色の細い筋（1マスに1枚）
def marble():
    defs = ("<radialGradient id='c'><stop offset='0' stop-color='#fff' stop-opacity='.14'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
            "<radialGradient id='d'><stop offset='0' stop-color='#000' stop-opacity='.08'/><stop offset='1' stop-color='#000' stop-opacity='0'/></radialGradient>")
    body = ("<ellipse cx='28' cy='70' rx='40' ry='30' fill='url(#c)'/><ellipse cx='78' cy='26' rx='34' ry='26' fill='url(#d)'/>"
            # 主な筋（にじみ＋芯）
            "<path d='M-4 72C14 66 22 50 38 46S60 32 70 20S88 6 104 2' fill='none' stroke='#fff' stroke-opacity='.12' stroke-width='5'/>"
            "<path d='M-4 72C14 66 22 50 38 46S60 32 70 20S88 6 104 2' fill='none' stroke='#fff' stroke-opacity='.48' stroke-width='1.4'/>"
            # 枝分かれ
            "<path d='M38 46C44 58 56 60 62 72S76 88 104 92' fill='none' stroke='#fff' stroke-opacity='.3' stroke-width='.9'/>"
            "<path d='M70 20C74 30 84 32 90 42' fill='none' stroke='#fff' stroke-opacity='.26' stroke-width='.7'/>"
            # 灰色の細い筋
            "<path d='M-4 26C10 28 18 20 30 22S46 14 54 4' fill='none' stroke='#000' stroke-opacity='.2' stroke-width='.6'/>"
            "<path d='M10 104C18 92 28 94 36 84' fill='none' stroke='#000' stroke-opacity='.16' stroke-width='.5'/>")
    return svg(100, 100, body, defs, stretch=True), None

# 6 木目：横に流れる年輪の筋（濃い筋と明るい筋）と、やわらかな色むら（1マスに1枚）
def wood():
    R = random.Random(53); out = []
    y = 3.0
    while y < 100:
        amp = R.uniform(.8, 2.6); ph = R.uniform(0, 6.28); wl = R.uniform(38, 70)
        pts = [(x, y + amp * math.sin(ph + x / wl * 6.28) + .6 * math.sin(x / 9 + ph)) for x in range(-4, 108, 8)]
        d = f"M{n(pts[0][0])} {n(pts[0][1])}" + ''.join(f"L{n(px)} {n(py)}" for px, py in pts[1:])
        dark = R.random() < .62
        out.append(f"<path d='{d}' fill='none' stroke='{'#000' if dark else '#fff'}' stroke-opacity='{n(R.uniform(.12, .22) if dark else R.uniform(.14, .22))}' stroke-width='{n(R.uniform(.5, 1.1))}' stroke-linejoin='round'/>")
        if R.random() < .35:   # 色むら（幅の広い淡い帯）
            out.append(f"<path d='{d}' fill='none' stroke='#fff' stroke-opacity='.06' stroke-width='{n(R.uniform(3, 5))}'/>")
        y += R.uniform(4.5, 8.5)
    return svg(100, 100, ''.join(out), stretch=True), None

# 7 スレート：斜めに重なる石の層。層の段差を、暗い線と明るい線の組で表す（1マスに1枚）
def slate():
    R = random.Random(61); out = []
    c = -40.0
    while c < 150:
        # 左下から右上へ（y = c - 0.55x のまわりを、小さな段を付けてたどる）
        pts = []; x = -6.0
        while x < 112:
            pts.append((x, c - .55 * x + R.uniform(-1.6, 1.6)))
            x += R.uniform(6, 13)
        d = f"M{n(pts[0][0])} {n(pts[0][1])}" + ''.join(f"L{n(px)} {n(py)}" for px, py in pts[1:])
        dl = f"M{n(pts[0][0])} {n(pts[0][1] + 1)}" + ''.join(f"L{n(px)} {n(py + 1)}" for px, py in pts[1:])
        out.append(f"<path d='{d}' fill='none' stroke='#000' stroke-opacity='{n(R.uniform(.22, .32))}' stroke-width='1.1' stroke-linejoin='round'/>")
        out.append(f"<path d='{dl}' fill='none' stroke='#fff' stroke-opacity='{n(R.uniform(.2, .28))}' stroke-width='.8' stroke-linejoin='round'/>")
        if R.random() < .5:
            out.append(f"<path d='{d}' fill='none' stroke='#fff' stroke-opacity='.05' stroke-width='6'/>")
        c += R.uniform(9, 16)
    return svg(100, 100, ''.join(out), stretch=True), None

# 8 テラゾー：大小の石のかけら（白っぽい・黒っぽい）が散らばる（88px 四方）
def terrazzo():
    T = 88; R = random.Random(71); out = []
    chips = {}
    for _ in range(30):
        x, y, r = R.uniform(0, T), R.uniform(0, T), R.uniform(1.6, 5.2)
        k = R.randint(5, 7); a0 = R.uniform(0, 6.28)
        shape = [(r * R.uniform(.6, 1.15) * math.cos(a0 + i * 6.28 / k), r * R.uniform(.55, 1.1) * math.sin(a0 + i * 6.28 / k)) for i in range(k)]
        tone = R.choices((('#fff', .38), ('#fff', .26), ('#000', .26)), weights=(4, 3, 3))[0]
        for dx, dy in wraps(x, y, r * 1.2, T):
            chips.setdefault(tone, []).append('M' + 'L'.join(f"{n(x + dx + px)} {n(y + dy + py)}" for px, py in shape) + 'Z')
    for (color, alpha), ds in sorted(chips.items()):
        out.append(f"<path d='{''.join(ds)}' fill='{color}' fill-opacity='{alpha}'/>")
    for color, alpha in (('#fff', .3), ('#000', .22)):
        pts = []
        for _ in range(36):
            x, y = R.uniform(0, T), R.uniform(0, T)
            pts += [(x + dx, y + dy) for dx, dy in wraps(x, y, 1.2, T)]
        out.append(dots(pts, color, alpha, R.choice((.9, 1.2))))
    return svg(T, T, ''.join(out)), T

PATS = [granite, concrete, travertine, hairline, marble, wood, slate, terrazzo]

def uri(s):
    return "url(\"data:image/svg+xml," + s.replace('%', '%25').replace('<', '%3C').replace('>', '%3E').replace('#', '%23').replace('"', "'") + "\")"

def css():
    lines = []
    for i, fn in enumerate(PATS, 1):
        s, T = fn()
        # T あり＝決まった大きさの区画を並べる（--pmt）。T なし＝1マスに1枚（--pmt: 0px で、ずらさない）
        size = f"--pmsz: {T}px {T}px; --pmt: {T}px;" if T else "--pmsz: 100% 100%; --pmt: 0px;"
        lines.append(f".pm{i} {{ {size} --pm: {uri(s)}; }}")
    return '\n'.join(lines) + '\n'

if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    tpl = os.path.join(here, '..', 'src', 'template.html')
    text = css()
    s = open(tpl, encoding='utf-8').read()
    a, b = '/* tile-patterns:start */\n', '/* tile-patterns:end */'
    i, j = s.index(a) + len(a), s.index(b)
    open(tpl, 'w', encoding='utf-8').write(s[:i] + text + s[j:])
    if '--svg' in sys.argv:
        out = sys.argv[sys.argv.index('--svg') + 1]
        for k, fn in enumerate(PATS, 1): open(os.path.join(out, f'p{k}.svg'), 'w').write(fn()[0])
    print('textures:', ', '.join(f'{k}:{len(uri(fn()[0]))}' for k, fn in enumerate(PATS, 1)), 'chars')
