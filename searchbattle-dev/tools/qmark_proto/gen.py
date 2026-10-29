# 境界線（くねくね）の座標を作る。中心付近は左上へふくらませて○の点を○側に残し、
# 外の輪と交わるところは直径の近くを通して、◎と○が半分ずつに見えるようにする
import math
d = (-0.6, 0.8)      # 右上から左下へ
n = (0.8, 0.6)       # ○側（右下）を向く向き
def w(t): return -4.6 * math.exp(-(t / 6.5) ** 2) + 1.3 * math.sin(0.55 * t + 0.4)
ts = [x * 2.5 for x in range(-14, 15)]
pts = [(20 + t * d[0] + w(t) * n[0], 20 + t * d[1] + w(t) * n[1]) for t in ts]
def cr(pts):
    s = 'M%.1f %.1f' % pts[0]
    for i in range(len(pts) - 1):
        p0 = pts[i - 1] if i > 0 else pts[i]; p1 = pts[i]; p2 = pts[i + 1]; p3 = pts[i + 2] if i + 2 < len(pts) else pts[i + 1]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        s += 'C%.1f %.1f %.1f %.1f %.1f %.1f' % (c1 + c2 + p2)
    return s
line = cr(pts)
region = line + 'L-12 52L-12 -12L%.1f -12Z' % pts[0][0]
open('paths.js', 'w').write('const QM_LINE = %r;\nconst QM_REGION = %r;\n' % (line, region))
print(pts[0], pts[-1], 'center w', w(0), 'ring', w(-14), w(14), 'len', len(line))
