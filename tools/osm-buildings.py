# 区域マップ：OpenStreetMap の建物を、会衆の範囲の分だけ取り出して osm/buildings.json にする
# ・GitHub Actions「OSM の建物」から動く。Apps Script（Google のサーバー）からは地図サーバー（Overpass）が混んでいて取れないため、こちらで作る
# ・まず Overpass に聞き、だめなら Geofabrik の関東のデータ（.osm.pbf）から osmium で取り出す
# ・中身は建物の重心・広さ（㎡）・種類・名前だけ。© OpenStreetMap contributors／ODbL（このファイルも ODbL）
import json, math, os, re, subprocess, sys, time, urllib.parse, urllib.request
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

def inside(lat, lng, poly):
    c = False
    for k in range(len(poly)):
        y1, x1 = poly[k]; y2, x2 = poly[k - 1]
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1: c = not c
    return c

def shape(pts):  # pts: [(lat, lng), ...] → 重心と広さ（㎡）
    lat0, lng0 = pts[0]; a2 = cx = cy = 0.0
    for k in range(len(pts)):
        y1, x1 = pts[k][0] - lat0, pts[k][1] - lng0
        y2, x2 = pts[(k + 1) % len(pts)][0] - lat0, pts[(k + 1) % len(pts)][1] - lng0
        f = x1 * y2 - x2 * y1; a2 += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    if abs(a2) < 1e-16:
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), 0
    lat, lng = lat0 + cy / (3 * a2), lng0 + cx / (3 * a2)
    return lat, lng, abs(a2) / 2 * 111320 * 111320 * math.cos(math.radians(lat))

def from_overpass(bb):
    s, w, n, e = bb
    q = f'[out:json][timeout:180];way["building"]({s},{w},{n},{e});out geom tags qt;relation["building"]({s},{w},{n},{e});out center tags qt;'
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
                    t = el.get('tags') or {}
                    g = el.get('geometry')
                    if g and len(g) >= 3:
                        lat, lng, area = shape([(p['lat'], p['lon']) for p in g])
                    elif el.get('center'):
                        lat, lng, area = el['center']['lat'], el['center']['lon'], None
                    else: continue
                    out.append((lat, lng, area, t.get('building', ''), t.get('name', '')))
                print('Overpass で取れました：', url, len(out), '件')
                return out
            except Exception as ex:
                print('Overpass だめ：', url, ex); time.sleep(10)
    return None

def from_geofabrik(bb):
    s, w, n, e = bb
    subprocess.run(['curl', '-sSL', '--retry', '3', '-o', 'kanto.osm.pbf', 'https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf'], check=True)
    subprocess.run(['osmium', 'extract', '-b', f'{w},{s},{e},{n}', 'kanto.osm.pbf', '-o', 'area.osm.pbf', '--overwrite'], check=True)
    subprocess.run(['osmium', 'tags-filter', 'area.osm.pbf', 'wr/building', '-o', 'bld.osm.pbf', '--overwrite'], check=True)
    subprocess.run(['osmium', 'export', 'bld.osm.pbf', '-o', 'bld.geojson', '--overwrite', '-f', 'geojson', '--geometry-types=polygon'], check=True)
    out = []
    for ft in json.load(open('bld.geojson'))['features']:
        g, t = ft['geometry'], ft.get('properties') or {}
        if not t.get('building'): continue
        ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
        lat, lng, area = shape([(p[1], p[0]) for p in ring])
        out.append((lat, lng, area, t.get('building', ''), t.get('name', '')))
    print('Geofabrik から取り出しました：', len(out), '件')
    return out

area = config_area()
lats = [p[0] for p in area]; lngs = [p[1] for p in area]
bb = (min(lats) - 0.003, min(lngs) - 0.003, max(lats) + 0.003, max(lngs) + 0.003)
rows = from_overpass(bb)
src = 'overpass'
if rows is None:
    rows = from_geofabrik(bb); src = 'geofabrik'
# 会衆の範囲（の少し外まで）に入るものだけ。範囲の線のすぐ外の家も区域に入ることがあるので、四角で少し広めに残す
keep = []
for lat, lng, a, b, name in rows:
    if not (bb[0] <= lat <= bb[2] and bb[1] <= lng <= bb[3]): continue
    keep.append([round(lat, 6), round(lng, 6), None if a is None else round(a), b, name[:30]])
keep.sort()
os.makedirs('osm', exist_ok=True)
json.dump({'v': 1, 'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'from': src, 'bbox': [round(x, 5) for x in bb],
           'license': '© OpenStreetMap contributors（ODbL 1.0：https://www.openstreetmap.org/copyright）',
           'cols': ['lat', 'lng', 'area_m2', 'building', 'name'], 'b': keep},
          open('osm/buildings.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('osm/buildings.json：', len(keep), '件', os.path.getsize('osm/buildings.json'), 'バイト')
if len(keep) < 100: sys.exit('建物が少なすぎます（範囲か取り出しがおかしい）')
