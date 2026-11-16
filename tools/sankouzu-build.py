#!/usr/bin/env python3
# 市町村の「固定資産（土地）地番参考図」など（市町村のホームページの SHP の zip）→ 区域マップ用の kuiki-sankouzu.json.gz
# ・使う前に、市町村の利用規約を読み、必要なら了解を取る
# ・平面直角座標の系（1〜19）は、SHP の範囲と会衆の範囲から自動で選ぶ。字の列が無いときは、およそ1km の四角ごとに分ける
# ・法務省の線（chiban/）が無い所だけ、会衆の範囲（config.js の area＋150m）の筆の「線の形」だけを入れる。地番は入れない
# ・できたファイルは、持ち主のドライブ「区域マップ_地番参考図」に置く（公開ページ・GitHub には置かない）。サーバー（gas/sankouzu.gs）が読む
# ・使い方：python3 tools/sankouzu-build.py <地番参考図の zip> <出力 .json.gz> [<データの時点 例 2027-01>]
#   時点を省くと unknown。外の道具は使わない（SHP・DBF・平面直角座標の計算は、この中に書いてある）
import io, json, math, os, re, struct, sys, unicodedata, zipfile, gzip, collections
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def dbf(path, enc='cp932'):
    f = open(path, 'rb'); h = f.read(32)
    n, hl, rl = struct.unpack('<IHH', h[4:12])
    fields = []
    while True:
        d = f.read(32)
        if d[0] == 0x0D: break
        name = d[:11].split(b'\0')[0].decode(enc, 'replace'); typ = chr(d[11]); ln = d[16]
        fields.append((name, typ, ln))
    f.seek(hl)
    def rows():
        for _ in range(n):
            r = f.read(rl); pos = 1; o = {}
            for name, typ, ln in fields:
                o[name] = r[pos:pos + ln].decode(enc, 'replace').strip(); pos += ln
            yield o
    return n, fields, rows()
def shapes(path):
    f = open(path, 'rb'); h = f.read(100)
    stype = struct.unpack('<i', h[32:36])[0]; bbox = struct.unpack('<4d', h[36:68])
    def it():
        while True:
            rh = f.read(8)
            if len(rh) < 8: return
            num, ln = struct.unpack('>2i', rh); c = f.read(ln * 2)
            t = struct.unpack('<i', c[:4])[0]
            if t == 0: yield None; continue
            if t in (5, 3, 15, 13, 25, 23):
                nparts, npts = struct.unpack('<2i', c[36:44])
                parts = list(struct.unpack('<%di' % nparts, c[44:44 + 4 * nparts]))
                off = 44 + 4 * nparts
                xy = struct.unpack('<%dd' % (2 * npts), c[off:off + 16 * npts])
                pts = list(zip(xy[0::2], xy[1::2]))
                parts.append(npts)
                yield [pts[parts[k]:parts[k + 1]] for k in range(nparts)]
            elif t in (1, 11, 21):
                yield [[struct.unpack('<2d', c[4:20])]]
            else: yield None
    return stype, bbox, it()

a = 6378137.0; F = 298.257222101; n = 1 / (2 * F - 1); m0 = 0.9999
ORIGIN = {1: (33, 129.5), 2: (33, 131), 3: (36, 132 + 1 / 6), 4: (33, 133.5), 5: (36, 134 + 1 / 3), 6: (36, 136), 7: (36, 137 + 1 / 6),
          8: (36, 138.5), 9: (36, 139 + 5 / 6), 10: (40, 140 + 5 / 6), 11: (44, 140.25), 12: (44, 142.25), 13: (44, 144.25), 14: (26, 142), 15: (26, 127.5),
          16: (26, 124), 17: (26, 131), 18: (20, 136), 19: (26, 154)}
phi0 = lam0 = 0.0  # set_zone で決める
A = [1 + n**2 / 4 + n**4 / 64,
     -3 / 2 * (n - n**3 / 8 - n**5 / 64),
     15 / 16 * (n**2 - n**4 / 4),
     -35 / 48 * (n**3 - 5 / 16 * n**5),
     315 / 512 * n**4,
     -693 / 1280 * n**5]
al = [None, n / 2 - 2 / 3 * n**2 + 5 / 16 * n**3 + 41 / 180 * n**4 - 127 / 288 * n**5,
      13 / 48 * n**2 - 3 / 5 * n**3 + 557 / 1440 * n**4 + 281 / 630 * n**5,
      61 / 240 * n**3 - 103 / 140 * n**4 + 15061 / 26880 * n**5,
      49561 / 161280 * n**4 - 179 / 168 * n**5, 34729 / 80640 * n**5]
be = [None, n / 2 - 2 / 3 * n**2 + 37 / 96 * n**3 - 1 / 360 * n**4 - 81 / 512 * n**5,
      1 / 48 * n**2 + 1 / 15 * n**3 - 437 / 1440 * n**4 + 46 / 105 * n**5,
      17 / 480 * n**3 - 37 / 840 * n**4 - 209 / 4480 * n**5,
      4397 / 161280 * n**4 - 11 / 504 * n**5, 4583 / 161280 * n**5]
de = [None, 2 * n - 2 / 3 * n**2 - 2 * n**3 + 116 / 45 * n**4 + 26 / 45 * n**5 - 2854 / 675 * n**6,
      7 / 3 * n**2 - 8 / 5 * n**3 - 227 / 45 * n**4 + 2704 / 315 * n**5 + 2323 / 945 * n**6,
      56 / 15 * n**3 - 136 / 35 * n**4 - 1262 / 105 * n**5 + 73814 / 2835 * n**6,
      4279 / 630 * n**4 - 332 / 35 * n**5 - 399572 / 14175 * n**6,
      4174 / 315 * n**5 - 144838 / 6237 * n**6, 601676 / 22275 * n**6]
Abar = m0 * a / (1 + n) * A[0]
Sbar0 = 0.0
def set_zone(z):
    global phi0, lam0, Sbar0
    phi0 = math.radians(ORIGIN[z][0]); lam0 = math.radians(ORIGIN[z][1])
    Sbar0 = m0 * a / (1 + n) * (A[0] * phi0 + sum(A[j] * math.sin(2 * j * phi0) for j in range(1, 6)))
def to_xy(lat, lon):  # (緯度, 経度) → x：北（m）、y：東（m）
    phi, lam = math.radians(lat), math.radians(lon)
    t = math.sinh(math.atanh(math.sin(phi)) - 2 * math.sqrt(n) / (1 + n) * math.atanh(2 * math.sqrt(n) / (1 + n) * math.sin(phi)))
    tb = math.sqrt(1 + t * t); lc, ls = math.cos(lam - lam0), math.sin(lam - lam0)
    xi = math.atan(t / lc); eta = math.atanh(ls / tb)
    x = Abar * (xi + sum(al[j] * math.sin(2 * j * xi) * math.cosh(2 * j * eta) for j in range(1, 6))) - Sbar0
    y = Abar * (eta + sum(al[j] * math.cos(2 * j * xi) * math.sinh(2 * j * eta) for j in range(1, 6)))
    return x, y
def to_ll(x, y):  # x：北（m）、y：東（m）→ (緯度, 経度)
    xi = (x + Sbar0) / Abar; eta = y / Abar
    xi2 = xi - sum(be[j] * math.sin(2 * j * xi) * math.cosh(2 * j * eta) for j in range(1, 6))
    eta2 = eta - sum(be[j] * math.cos(2 * j * xi) * math.sinh(2 * j * eta) for j in range(1, 6))
    chi = math.asin(math.sin(xi2) / math.cosh(eta2))
    lat = chi + sum(de[j] * math.sin(2 * j * chi) for j in range(1, 7))
    lon = lam0 + math.atan(math.sinh(eta2) / math.cos(xi2))
    return math.degrees(lat), math.degrees(lon)

def norm(x):
    x = unicodedata.normalize('NFKC', x or '').strip()
    return re.sub(r'^(大字|字)', '', x)
def centroid(r):
    lat0, lng0 = r[0]; a2 = cx = cy = 0
    for k in range(len(r)):
        y1, x1 = r[k][0] - lat0, r[k][1] - lng0; y2, x2 = r[(k + 1) % len(r)][0] - lat0, r[(k + 1) % len(r)][1] - lng0
        f = x1 * y2 - x2 * y1; a2 += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    if abs(a2) < 1e-14: return sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)
    return lat0 + cy / (3 * a2), lng0 + cx / (3 * a2)
def inside(lat, lng, r):
    c = False
    for k in range(len(r)):
        y1, x1 = r[k]; y2, x2 = r[k - 1]
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1: c = not c
    return c
def near(lat, lng, r, m):
    ky, kx = 111000, 111000 * math.cos(math.radians(lat))
    for k in range(len(r)):
        y1, x1 = r[k - 1]; y2, x2 = r[k]
        ax, ay = (x2 - x1) * kx, (y2 - y1) * ky; px, py = (lng - x1) * kx, (lat - y1) * ky
        t = max(0, min(1, (px * ax + py * ay) / max(ax * ax + ay * ay, 1e-9)))
        if math.hypot(px - t * ax, py - t * ay) < m: return True
    return False

def main():
    zpath, out = sys.argv[1], sys.argv[2]
    asof = sys.argv[3] if len(sys.argv) > 3 else None
    # 会衆の範囲
    s = cfg = open(os.path.join(ROOT, 'config.js'), encoding='utf-8').read(); i = s.index('area: [') + 6; d = 0
    for j in range(i, len(s)):
        if s[j] == '[': d += 1
        elif s[j] == ']':
            d -= 1
            if d == 0: break
    AREA = json.loads(s[i:j + 1])
    S = min(p[0] for p in AREA) - 0.004; N = max(p[0] for p in AREA) + 0.004
    W = min(p[1] for p in AREA) - 0.005; E = max(p[1] for p in AREA) + 0.005
    # zip から「固定資産土地」の .shp・.dbf を取り出す（名前は Shift_JIS のことがある）
    z = zipfile.ZipFile(zpath); tmp = os.path.join(os.path.dirname(os.path.abspath(out)), '_sankouzu_tmp'); os.makedirs(tmp, exist_ok=True)
    # zip の中の土地の .shp と、同じ名前の .dbf（名前は Shift_JIS のことがある）。「土地」の入った名前を先に選ぶ
    ents = {}
    for info in z.infolist():
        raw = info.filename.encode('cp437') if not (info.flag_bits & 0x800) else info.filename.encode('utf-8')
        try: name = raw.decode('cp932')
        except UnicodeDecodeError: name = info.filename
        stem, ext = os.path.splitext(os.path.basename(name))
        if ext.lower() in ('.shp', '.dbf'): ents.setdefault(stem, {})[ext.lower()[1:]] = info
    pairs = [k for k, v in ents.items() if 'shp' in v and 'dbf' in v]
    if not pairs: sys.exit('zip に、同じ名前の .shp と .dbf がありません')
    stem = max(pairs, key=lambda k: (('土地' in k) * 2 - (('境界' in k) or ('地番' in k)) * 2, ents[k]['shp'].file_size))
    got = {}
    for ext in ('shp', 'dbf'):
        p = os.path.join(tmp, 'land.' + ext); open(p, 'wb').write(z.read(ents[stem][ext])); got[ext] = p
    print('使うファイル：', stem + '.shp / .dbf')
    # 平面直角座標の系：SHP の範囲と会衆の範囲がいちばん重なる系
    with open(got['shp'], 'rb') as f: xmin, ymin, xmax, ymax = struct.unpack('<4d', f.read(100)[36:68])
    best, bestA = 0, 0
    for zz in ORIGIN:
        set_zone(zz)
        c = [to_xy(la, lo) for la in (S, N) for lo in (W, E)]
        w = min(max(q[1] for q in c), xmax) - max(min(q[1] for q in c), xmin)
        h = min(max(q[0] for q in c), ymax) - max(min(q[0] for q in c), ymin)
        if w > 0 and h > 0 and w * h > bestA: best, bestA = zz, w * h
    if not best: sys.exit('この SHP は、会衆の範囲（config.js の area）と重なりません')
    set_zone(best); print('平面直角座標：%d系' % best)
    # 法務省の筆（chiban/ の全部の市町村）：この中にある筆は入れない
    moj, G = [], 0.0005
    grid = collections.defaultdict(list)
    top = os.path.join(ROOT, 'chiban/index.json')
    codes = [m['code'] for m in json.load(open(top, encoding='utf-8'))['munis'].values()] if os.path.exists(top) else []
    for code in codes:
      ix = json.load(open(os.path.join(ROOT, 'chiban', code, 'index.json'), encoding='utf-8'))['azas']
      for name, a in ix.items():
        for e in json.load(open(os.path.join(ROOT, 'chiban', code, a['f'] + '.json'), encoding='utf-8'))['p']:
            cy, cx = e[1], e[2]; ring = [((cy + e[k]) / 1e6, (cx + e[k + 1]) / 1e6) for k in range(3, len(e) - 1, 2)]
            if len(ring) < 3: continue
            la = [q[0] for q in ring]; ln = [q[1] for q in ring]; b = (min(la), min(ln), max(la), max(ln))
            moj.append((b, ring))
            for gy in range(int(b[0] / G), int(b[2] / G) + 1):
                for gx in range(int(b[1] / G), int(b[3] / G) + 1): grid[(gy, gx)].append(len(moj) - 1)
    def in_moj(lat, lng):
        for k in grid.get((int(lat / G), int(lng / G)), []):
            b, r = moj[k]
            if b[0] <= lat <= b[2] and b[1] <= lng <= b[3] and inside(lat, lng, r): return True
        return False
    n_, fields, rows = dbf(got['dbf']); _, _, geoms = shapes(got['shp'])
    cols = {unicodedata.normalize('NFKC', f[0]).strip().upper(): f[0] for f in fields}
    acol = next((cols[c] for c in ('大字名', '大字', '町丁名', '町名', '字名', '大字町丁名', '所在', 'OAZA', 'AZA') if c in cols), None)
    if not acol: print('字の列がないので、およそ1km の四角ごとに分けます')
    groups = collections.defaultdict(list); stat = collections.Counter()
    for r, g in zip(rows, geoms):
        if not g: continue
        ring = g[0]
        la, ln = to_ll(sum(q[1] for q in ring) / len(ring), sum(q[0] for q in ring) / len(ring))
        if not (S <= la <= N and W <= ln <= E): continue
        ll = [to_ll(q[1], q[0]) for q in ring]
        if len(ll) > 3 and ll[0] == ll[-1]: ll = ll[:-1]
        c = centroid(ll)
        if in_moj(*c): stat['法務省の線がある'] += 1; continue
        if not (inside(c[0], c[1], AREA) or near(c[0], c[1], AREA, 150)): stat['範囲の外'] += 1; continue
        cy, cx = round(c[0] * 1e6), round(c[1] * 1e6)
        e = ['', cy, cx]; prev = None   # 地番は入れない
        for q in ll:
            v = (round(q[0] * 1e6) - cy, round(q[1] * 1e6) - cx)
            if v == prev: continue
            e += [v[0], v[1]]; prev = v
        if len(e) >= 9:
            g = (norm(r.get(acol, '')) or '（字なし）') if acol else '区画%d-%d' % (cy // 10000, cx // 10000)
            groups[g].append(e); stat['入れた'] += 1
    azas, files = {}, {}
    for k, a in enumerate(sorted(groups, key=lambda a: -len(groups[a]))):
        f = 's%02d' % k; ps = groups[a]
        lats = [(p[1] + p[i]) / 1e6 for p in ps for i in range(3, len(p), 2)]; lngs = [(p[2] + p[i]) / 1e6 for p in ps for i in range(4, len(p), 2)]
        azas[a] = {'f': f, 'n': len(ps), 'b': [round(min(lats), 6), round(min(lngs), 6), round(max(lats), 6), round(max(lngs), 6)]}
        files[f] = {'p': ps}
    if not asof: asof = 'unknown'
    mm = re.search(r"^\s*muni:\s*'([^']*)'", cfg, re.M); city = mm.group(1) if mm else ''
    allb = [v['b'] for v in azas.values()]
    index = {'v': 1, 'asof': asof, 'name': '地番参考図',
             'src': '「固定資産（土地）地番参考図」（%s）を加工して作成（線だけ。地番は入れていない）' % (city or '市町村'),
             'b': [min(b[0] for b in allb), min(b[1] for b in allb), max(b[2] for b in allb), max(b[3] for b in allb)], 'azas': azas}
    with gzip.open(out, 'wt', encoding='utf-8', compresslevel=9) as o:
        json.dump({'index': index, 'files': files}, o, ensure_ascii=False, separators=(',', ':'))
    for p in got.values(): os.remove(p)
    os.rmdir(tmp)
    print('字', len(azas), dict(stat), os.path.getsize(out), 'バイト')
    for a in list(azas)[:20]: print(' ', a, azas[a]['n'])
main()
