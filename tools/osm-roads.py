# 区域マップ：OpenStreetMap の道・線路・川の真ん中の線を、会衆の範囲の分だけ取り出して osm/roads.json にする
# ・GitHub Actions「OSM の道」から動く（osm-buildings.py と同じく、まず Overpass、だめなら Geofabrik の関東のデータ）
# ・画面の「道で囲む」（michi.js）が、ブロックを大まかに囲んだとき、まわりの道の真ん中に線を引くのに使う
# ・中身は線の形と種類（数字）だけ。© OpenStreetMap contributors／ODbL（このファイルも ODbL）
#
# 種類（c）：1 大きい道　2 ふつうの道　3 細い道・通路　4 線路　5 川　6 小川・水路
# 線の形：[c, 緯度0, 経度0, 差, 差, ...]（100万分の1度の整数。2点目からは前の点との差）
import json, os, subprocess, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

def config_area():
    s = open('config.js', encoding='utf-8').read()
    i = s.index('area: [') + 6; d = 0
    for j in range(i, len(s)):
        if s[j] == '[': d += 1
        elif s[j] == ']':
            d -= 1
            if d == 0: break
    return json.loads(s[i:j + 1])

ROAD1 = {'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'}
ROAD2 = {'residential', 'unclassified', 'living_street', 'road'}
ROAD3 = {'service', 'pedestrian', 'footway', 'path', 'track', 'steps', 'cycleway'}
RAIL = {'rail', 'light_rail', 'narrow_gauge'}
RIVER = {'river', 'canal'}
SMALLW = {'stream', 'drain', 'ditch'}

def kind(t):
    # 地下（トンネル）・広場の面・高速道路（高架で、下の道とは関係ない）は使わない
    if t.get('tunnel') not in (None, 'no') or t.get('area') == 'yes' or t.get('location') == 'underground': return 0
    h, r, w = t.get('highway'), t.get('railway'), t.get('waterway')
    if h in ROAD1: return 1
    if h in ROAD2: return 2
    if h in ROAD3: return 3
    if r in RAIL and t.get('service') not in ('yard', 'siding', 'spur'): return 4
    if w in RIVER: return 5
    if w in SMALLW: return 6
    return 0

def from_overpass(bb):
    s, w, n, e = bb
    b = f'({s},{w},{n},{e})'
    q = (f'[out:json][timeout:180];(way["highway"]{b};way["railway"~"^(rail|light_rail|narrow_gauge)$"]{b};'
         f'way["waterway"~"^(river|canal|stream|drain|ditch)$"]{b};);out geom tags qt;')
    for url in ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
                'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(),
                                             headers={'User-Agent': 'kuiki-map (GitHub Actions; territory map for a congregation)'})
                with urllib.request.urlopen(req, timeout=240) as r:
                    j = json.load(r)
                out = []
                for el in j.get('elements', []):
                    g = el.get('geometry')
                    if el.get('type') != 'way' or not g or len(g) < 2: continue
                    out.append((el.get('tags') or {}, [(p['lat'], p['lon']) for p in g]))
                print('Overpass で取れました：', url, len(out), '本')
                return out
            except Exception as ex:
                print('Overpass だめ：', url, ex); time.sleep(10)
    return None

def from_geofabrik(bb):
    s, w, n, e = bb
    subprocess.run(['curl', '-sSL', '--retry', '3', '-o', 'kanto.osm.pbf', 'https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf'], check=True)
    subprocess.run(['osmium', 'extract', '-b', f'{w},{s},{e},{n}', 'kanto.osm.pbf', '-o', 'area.osm.pbf', '--overwrite'], check=True)
    subprocess.run(['osmium', 'tags-filter', 'area.osm.pbf', 'w/highway', 'w/railway', 'w/waterway', '-o', 'rd.osm.pbf', '--overwrite'], check=True)
    subprocess.run(['osmium', 'export', 'rd.osm.pbf', '-o', 'rd.geojson', '--overwrite', '-f', 'geojson', '--geometry-types=linestring'], check=True)
    out = []
    for ft in json.load(open('rd.geojson'))['features']:
        g = ft['geometry']
        if g['type'] != 'LineString' or len(g['coordinates']) < 2: continue
        out.append((ft.get('properties') or {}, [(p[1], p[0]) for p in g['coordinates']]))
    print('Geofabrik から取り出しました：', len(out), '本')
    return out

def encode(c, pts):
    q = [(round(a * 1e6), round(b * 1e6)) for a, b in pts]
    row = [c, q[0][0], q[0][1]]
    for k in range(1, len(q)):
        dy, dx = q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]
        if dy == 0 and dx == 0: continue
        row += [dy, dx]
    return row if len(row) >= 5 else None

area = config_area()
lats = [p[0] for p in area]; lngs = [p[1] for p in area]
bb = (min(lats) - 0.004, min(lngs) - 0.005, max(lats) + 0.004, max(lngs) + 0.005)  # 範囲の外の道も、境になるので少し広く（約400m）
ways = from_overpass(bb)
src = 'overpass'
if ways is None:
    ways = from_geofabrik(bb); src = 'geofabrik'

rows, cnt = [], [0] * 7
for t, pts in ways:
    c = kind(t)
    if not c: continue
    # 四角の外に全部出ている線は入れない
    if all(not (bb[0] <= a <= bb[2] and bb[1] <= b <= bb[3]) for a, b in pts):
        if max(a for a, _ in pts) < bb[0] or min(a for a, _ in pts) > bb[2] or max(b for _, b in pts) < bb[1] or min(b for _, b in pts) > bb[3]: continue
    r = encode(c, pts)
    if r: rows.append(r); cnt[c] += 1
rows.sort()
os.makedirs('osm', exist_ok=True)
json.dump({'v': 1, 'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'from': src, 'bbox': [round(x, 5) for x in bb],
           'license': '© OpenStreetMap contributors（ODbL 1.0：https://www.openstreetmap.org/copyright）',
           'kinds': {'1': '大きい道', '2': 'ふつうの道', '3': '細い道・通路', '4': '線路', '5': '川', '6': '小川・水路'},
           'w': rows},
          open('osm/roads.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('osm/roads.json：', len(rows), '本', dict(zip(['', '大', '普', '細', '線', '川', '小'], cnt)), os.path.getsize('osm/roads.json'), 'バイト')
if cnt[1] + cnt[2] < 50: sys.exit('道が少なすぎます（範囲か取り出しがおかしい）')
