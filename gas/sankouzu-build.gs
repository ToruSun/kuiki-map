/* =========================================================
   区域マップ：市町村の「固定資産（土地）地番参考図」など（SHP）から、土地の区切りの線のデータ（kuiki-sankouzu.json.gz）を
   Apps Script だけで作る（Claude なしで、入れかえができるように）

   手作業（区域係）：
     0. 使う前に、市町村の利用規約を読み、必要なら市町村の了解を取る
     1. 市町村のホームページから zip をダウンロードし、パソコンで展開する
     2. 中の土地の .shp と、同じ名前の .dbf の2つだけを、ドライブの「区域マップ_地番参考図」に入れる
        （zip のままは読めないことが多い：Apps Script が開ける大きさをこえる）
        会衆がいくつかの市町村にまたがるときは、「区域マップ_地番参考図」の中に市町村の名前のフォルダ（例「〇〇市」）を作り、
        市町村ごとにそこへ入れる（フォルダの名前が、出典に出る市町村の名前になる）
     3. メニュー「地番参考図から土地の区切りを作る」→ 時点（年-月）を入れる → 5分ごとに自動で続く
   しくみ：
     ・SHP はドライブの API から 8MB ずつ（Range）読み、筆（多角形）を1つずつ取り出す。DBF からは字の名前だけを読む
       （字の列が無いときは、およそ1km の四角ごとに分ける）
     ・平面直角座標（1〜19系。SHP の範囲と会衆の範囲から、合う系を自動で選ぶ）→ 緯度・経度。
       会衆の範囲（公開ページの config.js の area＋150m）の筆だけ
     ・法務省の線（公開ページの chiban/）がある所の筆は入れない。地番は入れない（線の形だけ）
     ・できあがりを kuiki-sankouzu.json.gz として同じフォルダに置き、古いのはゴミ箱へ。サーバー（sankouzu.gs）が次の問い合わせで使う
   ========================================================= */
const SB_STATE = 'SAN_BUILD';
const SB_WORK = 'kuiki-sankouzu-work.json';
const SB_CHUNK = 8 * 1024 * 1024;
const SB_RUN_MS = 4.5 * 60 * 1000;
const SB_NEAR_M = 150;

/* ---------- 平面直角座標 ⇔ 経緯度（JGD2011・国土地理院の計算式。tools/sankouzu-build.py と同じ） ---------- */
const SB_TM = (function () {
  const a = 6378137.0, F = 298.257222101, n = 1 / (2 * F - 1), m0 = 0.9999;
  const A = [1 + n * n / 4 + Math.pow(n, 4) / 64, -3 / 2 * (n - Math.pow(n, 3) / 8 - Math.pow(n, 5) / 64), 15 / 16 * (n * n - Math.pow(n, 4) / 4),
    -35 / 48 * (Math.pow(n, 3) - 5 / 16 * Math.pow(n, 5)), 315 / 512 * Math.pow(n, 4), -693 / 1280 * Math.pow(n, 5)];
  const al = [0, n / 2 - 2 / 3 * n * n + 5 / 16 * Math.pow(n, 3) + 41 / 180 * Math.pow(n, 4) - 127 / 288 * Math.pow(n, 5),
    13 / 48 * n * n - 3 / 5 * Math.pow(n, 3) + 557 / 1440 * Math.pow(n, 4) + 281 / 630 * Math.pow(n, 5),
    61 / 240 * Math.pow(n, 3) - 103 / 140 * Math.pow(n, 4) + 15061 / 26880 * Math.pow(n, 5),
    49561 / 161280 * Math.pow(n, 4) - 179 / 168 * Math.pow(n, 5), 34729 / 80640 * Math.pow(n, 5)];
  const be = [0, n / 2 - 2 / 3 * n * n + 37 / 96 * Math.pow(n, 3) - 1 / 360 * Math.pow(n, 4) - 81 / 512 * Math.pow(n, 5),
    1 / 48 * n * n + 1 / 15 * Math.pow(n, 3) - 437 / 1440 * Math.pow(n, 4) + 46 / 105 * Math.pow(n, 5),
    17 / 480 * Math.pow(n, 3) - 37 / 840 * Math.pow(n, 4) - 209 / 4480 * Math.pow(n, 5),
    4397 / 161280 * Math.pow(n, 4) - 11 / 504 * Math.pow(n, 5), 4583 / 161280 * Math.pow(n, 5)];
  const de = [0, 2 * n - 2 / 3 * n * n - 2 * Math.pow(n, 3) + 116 / 45 * Math.pow(n, 4) + 26 / 45 * Math.pow(n, 5) - 2854 / 675 * Math.pow(n, 6),
    7 / 3 * n * n - 8 / 5 * Math.pow(n, 3) - 227 / 45 * Math.pow(n, 4) + 2704 / 315 * Math.pow(n, 5) + 2323 / 945 * Math.pow(n, 6),
    56 / 15 * Math.pow(n, 3) - 136 / 35 * Math.pow(n, 4) - 1262 / 105 * Math.pow(n, 5) + 73814 / 2835 * Math.pow(n, 6),
    4279 / 630 * Math.pow(n, 4) - 332 / 35 * Math.pow(n, 5) - 399572 / 14175 * Math.pow(n, 6),
    4174 / 315 * Math.pow(n, 5) - 144838 / 6237 * Math.pow(n, 6), 601676 / 22275 * Math.pow(n, 6)];
  const Abar = m0 * a / (1 + n) * A[0];
  // 平面直角座標系の原点（1〜19系）
  const ORIGIN = { 1: [33, 129.5], 2: [33, 131], 3: [36, 132 + 1 / 6], 4: [33, 133.5], 5: [36, 134 + 1 / 3], 6: [36, 136], 7: [36, 137 + 1 / 6],
    8: [36, 138.5], 9: [36, 139 + 5 / 6], 10: [40, 140 + 5 / 6], 11: [44, 140.25], 12: [44, 142.25], 13: [44, 144.25], 14: [26, 142], 15: [26, 127.5],
    16: [26, 124], 17: [26, 131], 18: [20, 136], 19: [26, 154] };
  const rad = d => d * Math.PI / 180;
  function sys(k) {
    const o = ORIGIN[k] || ORIGIN[9], phi0 = rad(o[0]);
    let s = A[0] * phi0; for (let j = 1; j <= 5; j++) s += A[j] * Math.sin(2 * j * phi0);
    return { lam0: rad(o[1]), Sbar0: m0 * a / (1 + n) * s };
  }
  function toLL(k, x, y) { // x：北、y：東（m）
    const z = sys(k), xi = (x + z.Sbar0) / Abar, eta = y / Abar;
    let xi2 = xi, eta2 = eta;
    for (let j = 1; j <= 5; j++) { xi2 -= be[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); eta2 -= be[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
    const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
    let lat = chi; for (let j = 1; j <= 6; j++) lat += de[j] * Math.sin(2 * j * chi);
    const lon = z.lam0 + Math.atan(Math.sinh(eta2) / Math.cos(xi2));
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
  }
  function toXY(k, lat, lon) {
    const z = sys(k), phi = rad(lat), dl = rad(lon) - z.lam0, sq = 2 * Math.sqrt(n) / (1 + n);
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - sq * Math.atanh(sq * Math.sin(phi))), tb = Math.sqrt(1 + t * t);
    const xi = Math.atan(t / Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / tb);
    let x = xi, y = eta;
    for (let j = 1; j <= 5; j++) { x += al[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); y += al[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
    return [Abar * x - z.Sbar0, Abar * y];
  }
  return { toLL: toLL, toXY: toXY };
})();

/* ---------- 形の計算 ---------- */
function sbCentroid_(r) {
  const lat0 = r[0][0], lng0 = r[0][1]; let a2 = 0, cx = 0, cy = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k], q = r[(k + 1) % r.length];
    const y1 = p[0] - lat0, x1 = p[1] - lng0, y2 = q[0] - lat0, x2 = q[1] - lng0, f = x1 * y2 - x2 * y1;
    a2 += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a2) < 1e-14) { let sy = 0, sx = 0; r.forEach(p => { sy += p[0]; sx += p[1]; }); return [sy / r.length, sx / r.length]; }
  return [lat0 + cy / (3 * a2), lng0 + cx / (3 * a2)];
}
function sbInside_(lat, lng, r) {
  let c = false;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
    const y1 = r[k][0], x1 = r[k][1], y2 = r[j][0], x2 = r[j][1];
    if ((y1 > lat) !== (y2 > lat) && lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
function sbNear_(lat, lng, r, m) {
  const ky = 111000, kx = 111000 * Math.cos(lat * Math.PI / 180);
  for (let k = 0; k < r.length; k++) {
    const p = r[(k + r.length - 1) % r.length], q = r[k];
    const ax = (q[1] - p[1]) * kx, ay = (q[0] - p[0]) * ky, px = (lng - p[1]) * kx, py = (lat - p[0]) * ky;
    const t = Math.max(0, Math.min(1, (px * ax + py * ay) / Math.max(ax * ax + ay * ay, 1e-9)));
    if (Math.hypot(px - t * ax, py - t * ay) < m) return true;
  }
  return false;
}
function sbNorm_(s) {
  return String(s || '').normalize('NFKC').trim().replace(/^(大字|字)/, '');
}

/* ---------- DBF：字の名前だけを読む。くり返しの多い字は、同じ並びのバイトを1回だけ文字にする ---------- */
const SB_AZA_COLS = ['大字名', '大字', '町丁名', '町名', '字名', '大字町丁名', '所在', 'OAZA', 'AZA'];
function sbDbfAza_(u8, decode) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(4, true), hl = dv.getUint16(8, true), rl = dv.getUint16(10, true);
  let pos = 32, off = 1, fOff = -1, fLen = 0, rank = 99;
  while (u8[pos] !== 0x0D && pos < hl) {
    let e = pos; while (e < pos + 11 && u8[e] !== 0) e++;
    const name = String(decode(u8.subarray(pos, e))).normalize('NFKC').trim().toUpperCase(), len = u8[pos + 16];
    const k = SB_AZA_COLS.indexOf(name);
    if (k >= 0 && k < rank) { fOff = off; fLen = len; rank = k; }
    off += len; pos += 32;
  }
  if (fOff < 0) return null; // 字の列が無い：四角ごとに分ける
  const names = [], idx = new Array(n), seen = {};
  for (let i = 0; i < n; i++) {
    const b = hl + i * rl + fOff; let key = '';
    for (let k = 0; k < fLen; k++) key += String.fromCharCode(u8[b + k]);
    let v = seen[key];
    if (v === undefined) { v = names.length; names.push(sbNorm_(decode(u8.subarray(b, b + fLen)).replace(/\u0000/g, ''))); seen[key] = v; }
    idx[i] = v;
  }
  return { names: names, idx: idx };
}

/* ---------- SHP：かたまりの中の、まるごと入っている筆を取り出す ---------- */
// cb(recNo, rings[[[x東, y北], ...]])。返り値＝読み終えたバイト数（次はそこから）
function sbShpChunk_(u8, cb) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 0;
  while (pos + 8 <= u8.length) {
    const recNo = dv.getInt32(pos, false), len = dv.getInt32(pos + 4, false) * 2;
    if (pos + 8 + len > u8.length) break;
    const c = pos + 8, t = dv.getInt32(c, true);
    if (t === 5 || t === 15 || t === 25) {
      const nParts = dv.getInt32(c + 36, true), nPts = dv.getInt32(c + 40, true);
      const parts = []; for (let k = 0; k < nParts; k++) parts.push(dv.getInt32(c + 44 + 4 * k, true));
      parts.push(nPts);
      const p0 = c + 44 + 4 * nParts, rings = [];
      for (let k = 0; k < nParts; k++) {
        const ring = [];
        for (let q = parts[k]; q < parts[k + 1]; q++) ring.push([dv.getFloat64(p0 + 16 * q, true), dv.getFloat64(p0 + 16 * q + 8, true)]);
        rings.push(ring);
      }
      cb(recNo, rings);
    }
    pos += 8 + len;
  }
  return pos;
}

/* ---------- 1つの筆を、区域マップの形にする（入れないものは null） ---------- */
function sbParcel_(ctx, rings) {
  const ring = rings[0]; if (!ring || ring.length < 3) return null;
  let sx = 0, sy = 0; ring.forEach(p => { sx += p[0]; sy += p[1]; });
  const ex = sx / ring.length, ny = sy / ring.length;     // 平面のまま、まず四角で絞る（速い）
  if (ny < ctx.xy[0] || ny > ctx.xy[2] || ex < ctx.xy[1] || ex > ctx.xy[3]) return null;
  let ll = ring.map(p => SB_TM.toLL(ctx.zone, p[1], p[0]));
  if (ll.length > 3 && ll[0][0] === ll[ll.length - 1][0] && ll[0][1] === ll[ll.length - 1][1]) ll = ll.slice(0, -1);
  const c = sbCentroid_(ll);
  if (ctx.inMoj(c[0], c[1])) { ctx.stat.moj++; return null; }
  if (!(sbInside_(c[0], c[1], ctx.area) || sbNear_(c[0], c[1], ctx.area, SB_NEAR_M))) { ctx.stat.out++; return null; }
  const cy = Math.round(c[0] * 1e6), cx = Math.round(c[1] * 1e6), e = ['', cy, cx]; // 地番は入れない
  let py = null, px = null;
  ll.forEach(p => { const y = Math.round(p[0] * 1e6) - cy, x = Math.round(p[1] * 1e6) - cx; if (y === py && x === px) return; e.push(y, x); py = y; px = x; });
  return e.length >= 9 ? e : null;
}

/* ---------- 公開ページから：会衆の範囲（config.js）と法務省の筆（chiban/） ---------- */
function sbPagesBase_() {
  const base = props_().getProperty('PAGES_URL');
  if (!base) throw new Error('公開ページのURLが設定されていません（メニュー「② 公開ページのURLを設定」）');
  return String(base).replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
}
function sbFetchText_(url) {
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (r.getResponseCode() !== 200) throw new Error(url + ' が読めません（' + r.getResponseCode() + '）');
  return r.getContentText('UTF-8');
}
function sbArea_(configText) {
  const i = configText.indexOf('area: ['); if (i < 0) throw new Error('config.js に area がありません');
  let d = 0, j = i + 6;
  for (; j < configText.length; j++) { const ch = configText[j]; if (ch === '[') d++; else if (ch === ']') { d--; if (d === 0) break; } }
  return JSON.parse(configText.slice(i + 6, j + 1));
}
/** 法務省の筆の「中にあるか」を調べる関数を作る（box にかかる字だけ読む） */
function sbMojIndex_(getJson, box) {
  const G = 0.0005, grid = {}, polys = [];
  let top = null; try { top = getJson('chiban/index.json'); } catch (e) { top = null; }
  const hit = b => !(b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]);
  if (top && top.munis) Object.keys(top.munis).forEach(m => {
    const mv = top.munis[m]; if (mv.b && !hit(mv.b)) return;
    const ix = getJson('chiban/' + mv.code + '/index.json');
    Object.keys(ix.azas || {}).forEach(az => {
      const v = ix.azas[az]; if (!v.b || !hit(v.b)) return;
      getJson('chiban/' + mv.code + '/' + v.f + '.json').p.forEach(e => {
        const cy = e[1], cx = e[2], r = [];
        for (let k = 3; k + 1 < e.length; k += 2) r.push([(cy + e[k]) / 1e6, (cx + e[k + 1]) / 1e6]);
        if (r.length < 3) return;
        let s = 90, w = 180, n = -90, ea = -180; r.forEach(p => { if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; if (p[1] < w) w = p[1]; if (p[1] > ea) ea = p[1]; });
        const id = polys.push({ b: [s, w, n, ea], r: r }) - 1;
        for (let gy = Math.floor(s / G); gy <= Math.floor(n / G); gy++) for (let gx = Math.floor(w / G); gx <= Math.floor(ea / G); gx++) (grid[gy + ':' + gx] = grid[gy + ':' + gx] || []).push(id);
      });
    });
  });
  return function (lat, lng) {
    const l = grid[Math.floor(lat / G) + ':' + Math.floor(lng / G)]; if (!l) return false;
    for (let k = 0; k < l.length; k++) { const p = polys[l[k]]; if (lat >= p.b[0] && lat <= p.b[2] && lng >= p.b[1] && lng <= p.b[3] && sbInside_(lat, lng, p.r)) return true; }
    return false;
  };
}
/** SHP の範囲（ヘッダーの四角）と会衆の範囲がいちばん重なる系（1〜19）を選ぶ。どれも重ならなければ 0 */
function sbZone_(hdr, area) {
  const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
  const xmin = dv.getFloat64(36, true), ymin = dv.getFloat64(44, true), xmax = dv.getFloat64(52, true), ymax = dv.getFloat64(60, true); // x：東、y：北
  let best = 0, bestA = 0;
  for (let z = 1; z <= 19; z++) {
    const b = sbBoxes_(area, z).xy; // [北の最小, 東の最小, 北の最大, 東の最大]
    const w = Math.min(b[3], xmax) - Math.max(b[1], xmin), h = Math.min(b[2], ymax) - Math.max(b[0], ymin);
    if (w > 0 && h > 0 && w * h > bestA) { bestA = w * h; best = z; }
  }
  return best;
}
/** config.js の muni（市の名前）。フォルダに分けていないときの、出典の市町村 */
function sbMuni_(configText) {
  const m = String(configText).match(/^\s*muni:\s*'([^']*)'/m);
  return m ? m[1] : '';
}
function sbSrc_(cities) {
  const c = (Array.isArray(cities) ? cities : [cities]).filter(Boolean);
  return '「固定資産（土地）地番参考図」（' + (c.length ? c.join('・') : '市町村') + '）を加工して作成（線だけ。地番は入れていない）';
}
/** 字の列が無いとき：およそ1km の四角の名前 */
function sbGridName_(e) {
  return '区画' + Math.floor(e[1] / 1e4) + '-' + Math.floor(e[2] / 1e4);
}
/** 会衆の範囲から、絞りこむ四角（経緯度と平面直角座標） */
function sbBoxes_(area, zone) {
  let S = 90, N = -90, W = 180, E = -180;
  area.forEach(p => { if (p[0] < S) S = p[0]; if (p[0] > N) N = p[0]; if (p[1] < W) W = p[1]; if (p[1] > E) E = p[1]; });
  const ll = [S - 0.004, W - 0.005, N + 0.004, E + 0.005];
  const c = [SB_TM.toXY(zone, ll[0], ll[1]), SB_TM.toXY(zone, ll[0], ll[3]), SB_TM.toXY(zone, ll[2], ll[1]), SB_TM.toXY(zone, ll[2], ll[3])];
  const xy = [Math.min.apply(null, c.map(v => v[0])) , Math.min.apply(null, c.map(v => v[1])), Math.max.apply(null, c.map(v => v[0])), Math.max.apply(null, c.map(v => v[1]))];
  return { ll: ll, xy: xy }; // xy：[北の最小, 東の最小, 北の最大, 東の最大]
}
/** 最後に：字ごとにまとめて、一覧（index）とファイルを作る */
function sbFinish_(groups, asof, cities) {
  const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const azas = {}, files = {}, allb = [];
  names.forEach((a, k) => {
    const f = 's' + ('0' + k).slice(-2), ps = groups[a];
    let s = 90, w = 180, n = -90, e = -180;
    ps.forEach(p => { for (let i = 3; i + 1 < p.length; i += 2) { const la = (p[1] + p[i]) / 1e6, ln = (p[2] + p[i + 1]) / 1e6; if (la < s) s = la; if (la > n) n = la; if (ln < w) w = ln; if (ln > e) e = ln; } });
    const r6 = v => Math.round(v * 1e6) / 1e6;
    azas[a] = { f: f, n: ps.length, b: [r6(s), r6(w), r6(n), r6(e)] }; files[f] = { p: ps }; allb.push(azas[a].b);
  });
  return {
    index: { v: 1, asof: asof, name: '地番参考図', cities: cities, src: sbSrc_(cities),
      b: [Math.min.apply(null, allb.map(b => b[0])), Math.min.apply(null, allb.map(b => b[1])), Math.max.apply(null, allb.map(b => b[2])), Math.max.apply(null, allb.map(b => b[3]))],
      azas: azas },
    files: files
  };
}

/* ========== ここから下は Apps Script（ドライブ・メニュー・続きの予約） ========== */
function sbFolder_() {
  const it = DriveApp.getFoldersByName('区域マップ_地番参考図');
  return it.hasNext() ? it.next() : DriveApp.createFolder('区域マップ_地番参考図');
}
function sbPick_(folder, ext, base) {
  let best = null; const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next(); if (f.isTrashed()) continue;
    const nm = f.getName();
    if (!new RegExp('\\.' + ext + '$', 'i').test(nm)) continue;
    if (base && nm.replace(/\.[^.]*$/, '') === base) return f; // .shp と同じ名前の .dbf
    const score = (/土地/.test(nm) ? 2 : 0) + (/境界|地番/.test(nm) ? -2 : 0);
    if (!best || score > best.score || (score === best.score && f.getLastUpdated() > best.f.getLastUpdated())) best = { f: f, score: score };
  }
  return best ? best.f : null;
}
function sbRange_(id, a, b) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + a + '-' + b }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code !== 206 && code !== 200) throw new Error('ドライブから読めませんでした（' + code + '）');
  return new Uint8Array(res.getContent());
}
const sbSjis_ = u8 => Utilities.newBlob(Array.from(u8, v => (v > 127 ? v - 256 : v))).getDataAsString('Shift_JIS');

/** メニュー：地番参考図から土地の区切りを作る */
function sanBuildMenu() {
  const ui = SpreadsheetApp.getUi();
  const st = parseJson_(props_().getProperty(SB_STATE), null);
  if (st && !st.done) {
    if (ui.alert('作っている途中です', sbSummary_(st) + '\n\n止めて、はじめから作り直しますか？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  }
  const folder = sbFolder_();
  // 使うファイル：フォルダの中（市町村は config.js の muni）と、市町村の名前の小さなフォルダの中
  const found = [];
  const pair = (f, city) => {
    const shp = sbPick_(f, 'shp'), dbf = shp ? sbPick_(f, 'dbf', shp.getName().replace(/\.[^.]*$/, '')) : null;
    if (shp && dbf) found.push({ shp: shp, dbf: dbf, city: city });
  };
  pair(folder, '');
  const subs = folder.getFolders();
  while (subs.hasNext()) { const sf = subs.next(); if (!sf.isTrashed()) pair(sf, sf.getName().trim()); }
  if (!found.length) {
    ui.alert('ファイルが足りません',
      'ドライブのフォルダ「' + folder.getName() + '」に、次の2つを入れてください。\n\n' +
      '・土地の区切りの .shp（ファイル名に「土地」が入っているものを先に選びます）\n・同じ名前の .dbf\n\n' +
      '会衆がいくつかの市町村にまたがるときは、この中に市町村の名前のフォルダ（例「〇〇市」）を作り、市町村ごとに入れます。\n\n' +
      '市町村のホームページの zip をパソコンで展開すると、中に入っています（ほかのファイルは要りません）。\n' +
      'zip のままは読めません（大きすぎるため）。', ui.ButtonSet.OK);
    return;
  }
  const y = new Date(found[0].shp.getLastUpdated()).getFullYear();
  const ask = ui.prompt('データの時点',
    '使うファイル：\n' + found.map(x => '・' + (x.city || '（会衆の市町村）') + '：' + x.shp.getName() + '（' + Math.round(x.shp.getSize() / 1048576) + 'MB）と ' + x.dbf.getName()).join('\n') + '\n\n' +
    'データの時点を「年-月」の形で入れてください（例 ' + y + '-01）。市町村のホームページに書いてあります。', ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;
  const asof = (ask.getResponseText().trim() || (y + '-01'));
  if (!/^\d{4}-\d{2}$/.test(asof)) { ui.alert('「' + y + '-01」のような形（年-月）で入れてください。'); return; }
  // 範囲と字を先に用意（DBF はここで読む。8MB くらいなので1回で読める）
  let work;
  try {
    const cfg = sbFetchText_(sbPagesBase_() + 'config.js');
    const area = sbArea_(cfg), def = sbMuni_(cfg);
    const jobs = found.map(x => {
      const zone = sbZone_(sbRange_(x.shp.getId(), 0, 99), area);
      if (!zone) throw new Error((x.city || x.shp.getName()) + '：この SHP は、会衆の範囲（config.js の area）と重なりません。ちがう市町村のファイルではありませんか？');
      const az = sbDbfAza_(new Uint8Array(x.dbf.getBlob().getBytes()), sbSjis_);
      return { shp: x.shp.getId(), size: x.shp.getSize(), city: x.city || def, zone: zone, names: az ? az.names : null, idx: az ? az.idx : null };
    });
    work = { asof: asof, area: area, jobs: jobs, groups: {} };
  } catch (e) {
    ui.alert('始められませんでした', String(e && e.message ? e.message : e).slice(0, 300), ui.ButtonSet.OK);
    return;
  }
  sbSaveWork_(folder, work);
  props_().setProperty(SB_STATE, JSON.stringify({ jobs: work.jobs.map(x => ({ shp: x.shp, size: x.size, city: x.city })), j: 0, off: 100, asof: asof, done: false,
    stat: { got: 0, moj: 0, out: 0 }, note: '', at: new Date().toISOString() }));
  sbEnsureTrigger_();
  ui.alert('作り始めました', '1回に4分半ずつ進み、5分ごとに自動で続きます（全部で10〜20分くらい）。\n' +
    'メニュー「地番参考図の作成の進み具合」で確かめられます。\n終わると、区域マップの土地の区切りが新しくなります。', ui.ButtonSet.OK);
  sanBuildRun();
}
function sbSaveWork_(folder, work) {
  const it = folder.getFilesByName(SB_WORK); while (it.hasNext()) it.next().setTrashed(true);
  folder.createFile(SB_WORK, JSON.stringify(work), 'application/json');
}
function sbLoadWork_(folder) {
  const it = folder.getFilesByName(SB_WORK); if (!it.hasNext()) return null;
  return JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
}
function sbEnsureTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sanBuildRun');
  if (!has) ScriptApp.newTrigger('sanBuildRun').timeBased().everyMinutes(5).create();
}
function sbDropTrigger_() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'sanBuildRun') ScriptApp.deleteTrigger(t); });
}

/** 本体（5分ごと）：SHP を少しずつ読んで進める */
function sanBuildRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const st = parseJson_(props_().getProperty(SB_STATE), null);
    if (!st || st.done) { sbDropTrigger_(); return; }
    const t0 = Date.now(), folder = sbFolder_();
    const work = sbLoadWork_(folder);
    if (!work) { st.done = true; st.note = '途中のファイルがなくなりました。もう一度メニューから作ってください。'; props_().setProperty(SB_STATE, JSON.stringify(st)); sbDropTrigger_(); return; }
    const base = sbPagesBase_(), cache = {};
    const getJson = p => cache[p] || (cache[p] = JSON.parse(sbFetchText_(base + p)));
    const inMoj = sbMojIndex_(getJson, sbBoxes_(work.area, work.jobs[0].zone).ll);
    const many = work.jobs.length > 1;
    let first = true; // 1回に、少なくとも1かたまりは進める
    while (st.j < work.jobs.length && (first || Date.now() - t0 < SB_RUN_MS)) {
      first = false;
      const job = work.jobs[st.j];
      const ctx = { zone: job.zone, xy: sbBoxes_(work.area, job.zone).xy, area: work.area, inMoj: inMoj, stat: st.stat };
      const end = Math.min(job.size, st.off + SB_CHUNK) - 1;
      const u8 = sbRange_(job.shp, st.off, end);
      const used = sbShpChunk_(u8, (recNo, rings) => {
        const e = sbParcel_(ctx, rings); if (!e) return;
        let a = job.names ? (job.names[job.idx[recNo - 1]] || '（字なし）') : sbGridName_(e);
        if (many) a = job.city + ' ' + a; // 市町村がちがえば、同じ字の名前でも別にする
        (work.groups[a] = work.groups[a] || []).push(e); st.stat.got++;
      });
      if (!used) throw new Error('SHP の読み取りが進みません（ファイルがこわれている？）');
      st.off += used;
      if (st.off >= job.size) { st.j++; st.off = 100; } // 次の市町村へ
    }
    if (st.j >= work.jobs.length) {
      const out = sbFinish_(work.groups, work.asof, work.jobs.map(x => x.city).filter((c, k, a) => c && a.indexOf(c) === k));
      const blob = Utilities.gzip(Utilities.newBlob(JSON.stringify(out), 'application/json'), SAN_FILE);
      const old = DriveApp.getFilesByName(SAN_FILE); while (old.hasNext()) old.next().setTrashed(true);
      folder.createFile(blob.setName(SAN_FILE));
      const w = folder.getFilesByName(SB_WORK); while (w.hasNext()) w.next().setTrashed(true);
      props_().deleteProperty(SAN_PROP); // サーバーが次の問い合わせで、字ごとに分け直す
      st.done = true; st.azas = Object.keys(out.index.azas).length;
      sbDropTrigger_();
    } else {
      sbSaveWork_(folder, work);
    }
    st.at = new Date().toISOString(); st.err = 0;
    props_().setProperty(SB_STATE, JSON.stringify(st));
  } catch (e) {
    const st = parseJson_(props_().getProperty(SB_STATE), {}) || {};
    st.note = String(e && e.message ? e.message : e).slice(0, 200);
    st.err = (st.err || 0) + 1;
    if (st.err >= 3) { st.done = true; st.note += '（3回続けて失敗したので止めました）'; sbDropTrigger_(); } // 同じ失敗をくり返さない
    props_().setProperty(SB_STATE, JSON.stringify(st));
    console.error('地番参考図の作成', e);
  } finally { lock.releaseLock(); }
}
function sbSummary_(st) {
  const jobs = st.jobs || [], total = jobs.reduce((a, x) => a + (x.size || 0), 0);
  const done = jobs.slice(0, st.j || 0).reduce((a, x) => a + (x.size || 0), 0) + (st.j < jobs.length ? (st.off || 0) : 0);
  const cities = jobs.map(x => x.city).filter((c, k, a) => c && a.indexOf(c) === k);
  return '進み具合：' + (st.done ? 100 : Math.min(99, Math.round(done / Math.max(1, total) * 100))) + '%' + (st.done ? '（終わりました）' : '') +
    (jobs.length > 1 && !st.done ? '（' + Math.min(jobs.length, (st.j || 0) + 1) + '／' + jobs.length + '：' + ((jobs[st.j] || {}).city || '') + '）' : '') +
    '\n入れた筆：' + ((st.stat && st.stat.got) || 0) + '（法務省の線がある所：' + ((st.stat && st.stat.moj) || 0) + '・範囲の外：' + ((st.stat && st.stat.out) || 0) + '）' +
    (st.done && st.azas ? '\n字の数：' + st.azas : '') + (st.note ? '\n\nお知らせ：' + st.note : '') +
    '\n\n出典：' + sbSrc_(cities);
}
/** メニュー：進み具合 */
function sanBuildStatus() {
  const ui = SpreadsheetApp.getUi();
  const st = parseJson_(props_().getProperty(SB_STATE), null);
  if (!st) { ui.alert('まだ作っていません。メニュー「地番参考図から土地の区切りを作る」から始めます。'); return; }
  if (!st.done) {
    if (ui.alert('地番参考図の作成', sbSummary_(st) + '\n\n止めますか？', ui.ButtonSet.YES_NO) === ui.Button.YES) {
      st.done = true; st.note = '止めました'; props_().setProperty(SB_STATE, JSON.stringify(st)); sbDropTrigger_();
    }
    return;
  }
  ui.alert('地番参考図の作成', sbSummary_(st), ui.ButtonSet.OK);
}
