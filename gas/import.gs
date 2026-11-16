/* =========================================================
   家の一括削除と、地図データからの「仮の家」取り込み
   （Apps Script の import.gs の中身を、これで置きかえてください）

   ・仮の家：地図の建物データから自動で入れた家。アプリでは点線の印で出て、
     記録をつけるとふつうの家に変わり、家がなければその場で消せます。
   ・地図サーバー（Overpass）は1回の問い合わせに1〜4分かかるため、
     広い範囲をまとめて取り、6分の実行制限に当たる前にいったん止めて、
     5分ごとに自動で続きを行います（終わると自動で止まります）。
   ・データの出どころ：OpenStreetMap（© OpenStreetMap contributors / ODbL）
   ========================================================= */

const IMPORT_SHEET = 'import';          // 手で緯度・経度を貼るときに使うシート
const IMPORT_MIN_M = 8;                 // この距離（m）より近い家は、同じ家とみなして入れない
const OVERPASS_URLS = [                 // Googleのサーバーから届く先だけ（届かない先・別の国のサーバーは入れない）
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const TILE_DEG = 0.01;                  // 1回にまとめて取る大きさ（約1km四方）。建物の形も取るので、大きいと地図サーバーが時間切れ（504）になる
const IMPORT_TRIES = 3;                 // 取れなかった範囲は、最後にもう一度（合わせて3回まで）試す
const RUN_MS = 4.5 * 60000;             // 1回の実行で使う時間の上限（実行制限は6分）
const IMPORT_STATE = 'IMPORT_STATE';    // 途中経過の置き場所
let LAST_FETCH_NOTE = '';               // うまくいかなかったときの理由

/* ---------- メニュー（本体の onOpen に入っています） ----------
    .addItem('家をすべて削除（区域線は残す）', 'wipeHouses')
    .addItem('地図から「仮の家」を取り込む', 'importProvHouses')
    .addItem('取り込みの進み具合を見る', 'importStatus')
    .addItem('仮の家をすべて削除', 'wipeProvHouses')
   ------------------------------------------------------------ */

/** 家と訪問記録をすべて消す（区域の線・使う人は残る） */
function wipeHouses() {
  const ui = SpreadsheetApp.getUi();
  const n = rowCount_('houses'), v = rowCount_('visits');
  const r = ui.prompt('家をすべて削除',
    '家 ' + n + '件と、訪問記録 ' + v + '件を、すべて消します。\n区域の線と使う人は残ります（住所のある拒否は、地図の拒否の印として残ります）。元にはもどせません。\n\n消してよければ「削除」と入力してください。',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || r.getResponseText().trim() !== '削除') return;
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    // 住所や場所のある拒否（取り込み・係が追加したもの）は、家が消えても「場所だけの拒否」として残す
    const keepDnc = [], hpos = {};
    readCol_('houses').forEach(function (x, id) { hpos[id] = x.data; });
    readCol_('dnc').forEach(function (x, id) {
      const v = x.data;
      if (!v || typeof v !== 'object' || !(v.a || v.s || v.p)) return;
      if (v.q && !v.p) return; // 訪問しない印は、家と一緒に消す（場所だけの拒否にしない）
      const h = hpos[String(id).split('|')[0]];
      const o = Object.assign({}, v, { p: 1 });
      delete o.auto;
      if (h && o.lat == null) { o.lat = h.lat; o.lng = h.lng; }
      if (h && !o.t && h.terrId) o.t = h.terrId;
      keepDnc.push([String(id).indexOf('|') > 0 ? 'pin:w' + Utilities.getUuid().replace(/-/g, '').slice(0, 10) : String(id), JSON.stringify(o), x.at || new Date(), x.by || '']);
    });
    ['houses', 'visits', 'dnc', 'follows', 'released', 'langs'].forEach(function (name) { // 外国語の印も家と一緒に消す（監査 M6）
      const sh = dataSheet_(name), last = sh.getLastRow();
      if (last >= 2) sh.getRange(2, 1, last - 1, 4).clearContent();
    });
    if (keepDnc.length) dataSheet_('dnc').getRange(2, 1, keepDnc.length, 4).setValues(keepDnc);
    resetJournal_(); // 全員の画面が、次に開いたときに読み直す
  } finally { lock.releaseLock(); }
  ui.alert('家と訪問記録を削除しました。各自のスマホは、次に開いたときに反映されます。');
}

/** まだ確かめていない「仮の家」を消す（記録がついた家は残る） */
function wipeProvHouses() {
  const ui = SpreadsheetApp.getUi();
  const ask = ui.prompt('仮の家を削除',
    '区域番号を入れると、その区域の仮の家だけを消します（例：1）。\n空欄のままOKを押すと、すべての仮の家を消します。',
    ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;
  const want = ask.getResponseText().trim();
  let ids = null;
  if (want) {
    const set = {};
    want.replace(/[、，]/g, ',').split(',').forEach(function (x) { const v = x.trim(); if (v) set[v] = true; });
    ids = {};
    readCol_('territories').forEach(function (x, id) { if (set[String(x.data.no || '')]) ids[id] = true; });
    if (!Object.keys(ids).length) { ui.alert('その番号の区域が見つかりませんでした。'); return; }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  let n = 0;
  try {
    const map = readCol_('houses');
    const keep = [], refused = {}; // 拒否の印がある家は、仮の家でも消さない（拒否が見えなくならないように）
    readCol_('dnc').forEach(function (x, id) { refused[String(id).split('|')[0]] = true; });
    map.forEach(function (x, id) {
      const hit = x.data && x.data.prov && !refused[id] && (!ids || ids[x.data.terrId]);
      if (hit) n++; else keep.push([id, x]);
    });
    if (!n) { ui.alert('消す仮の家はありません。'); return; }
    if (ui.alert('仮の家を削除', '確かめていない仮の家 ' + n + '件を消します。よろしいですか？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    const sh = dataSheet_('houses'), last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, 4).clearContent();
    if (keep.length) {
      sh.getRange(2, 1, keep.length, 4).setValues(keep.map(function (p) {
        return [p[0], JSON.stringify(p[1].data), p[1].at || new Date(), p[1].by || ''];
      }));
    }
    resetJournal_();
  } finally { lock.releaseLock(); }
  ui.alert('仮の家 ' + n + '件を削除しました。');
}

/* ---------- 区域の形と、点がどの区域に入るか ---------- */

function terrBounds_() {
  const ts = [];
  readCol_('territories').forEach(function (x) {
    const p = x.data && x.data.polygon;
    if (!Array.isArray(p) || p.length < 3) return;
    let s = 90, n = -90, w = 180, e = -180;
    p.forEach(function (v) {
      const la = Number(v[0]), ln = Number(v[1]);
      if (!isFinite(la) || !isFinite(ln)) return;
      s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln);
    });
    if (s <= n && w <= e) ts.push({ id: x.data.id, no: String(x.data.no || ''), poly: p, s: s, n: n, w: w, e: e });
  });
  return ts;
}

function inPoly_(lat, lng, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = Number(poly[i][0]), xi = Number(poly[i][1]);
    const yj = Number(poly[j][0]), xj = Number(poly[j][1]);
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function terrOfPoint_(ts, lat, lng) {
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (lat < t.s || lat > t.n || lng < t.w || lng > t.e) continue;
    if (inPoly_(lat, lng, t.poly)) return t.id;
  }
  return null;
}

/** 近い家をすばやく見つけるための、ざっくりした区切り（約11m） */
function gridKey_(lat, lng) { return Math.round(lat * 9000) + ':' + Math.round(lng * 9000); }
function nearExisting_(grid, lat, lng) {
  const gy = Math.round(lat * 9000), gx = Math.round(lng * 9000);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const arr = grid[(gy + dy) + ':' + (gx + dx)];
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const dLat = (lat - arr[i][0]) * 111000;
        const dLng = (lng - arr[i][1]) * 111000 * Math.cos(lat * Math.PI / 180);
        if (Math.sqrt(dLat * dLat + dLng * dLng) < IMPORT_MIN_M) return true;
      }
    }
  }
  return false;
}

/** OpenStreetMap から、その四角の中の建物の中心点を取ってくる */
function fetchBuildings_(s, w, n, e) {
  // 建物（way）は形ごと取り、広さ（小さい物置をよける）と重心を出す。relation は中心だけ
  const bb = '(' + s + ',' + w + ',' + n + ',' + e + ')';
  const q = '[out:json][timeout:90];way["building"]' + bb + ';out geom tags qt;relation["building"]' + bb + ';out center tags qt;';
  for (let i = 0; i < OVERPASS_URLS.length; i++) {
    try {
      const res = UrlFetchApp.fetch(OVERPASS_URLS[i], {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: 'data=' + encodeURIComponent(q),
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      const text = res.getContentText();
      if (code !== 200) {
        LAST_FETCH_NOTE = OVERPASS_URLS[i] + ' → 番号 ' + code + '：' + text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        continue;
      }
      const j = JSON.parse(text);
      return (j.elements || []).map(function (el) {
        const tags = el.tags || {};
        const g = Array.isArray(el.geometry) && el.geometry.length >= 3 ? osmShape_(el.geometry) : null;
        const c = g || el.center || el;
        return { lat: Number(c.lat), lng: Number(c.lon), area: g ? g.area : null, b: String(tags.building || ''), name: String(tags.name || '') };
      }).filter(function (x) { return isFinite(x.lat) && isFinite(x.lng); });
    } catch (err) {
      LAST_FETCH_NOTE = OVERPASS_URLS[i] + ' → ' + (err && err.message ? err.message : String(err)).slice(0, 120);
      console.warn(err);
    }
  }
  return null; // 取れなかった
}

/** 建物の形（[{lat,lon},…]）の重心と広さ（㎡）。数の桁落ちを防ぐため、1点目を原点にして計算する */
function osmShape_(geo) {
  const lat0 = Number(geo[0].lat), lng0 = Number(geo[0].lon), n = geo.length;
  let a2 = 0, cx = 0, cy = 0, sy = 0, sx = 0;
  for (let k = 0; k < n; k++) {
    const p1 = geo[k], p2 = geo[(k + 1) % n];
    const x1 = Number(p1.lon) - lng0, y1 = Number(p1.lat) - lat0, x2 = Number(p2.lon) - lng0, y2 = Number(p2.lat) - lat0;
    const f = x1 * y2 - x2 * y1;
    a2 += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f; sy += Number(p1.lat); sx += Number(p1.lon);
  }
  const lat = Math.abs(a2) > 1e-16 ? lat0 + cy / (3 * a2) : sy / n;
  const lng = Math.abs(a2) > 1e-16 ? lng0 + cx / (3 * a2) : sx / n;
  const area = Math.abs(a2) / 2 * 111320 * 111320 * Math.cos(lat * Math.PI / 180);
  return { lat: lat, lon: lng, area: area };
}

/** 公開ページの osm/buildings.json（GitHub Actions「OSM の建物」が作る）を読む */
function osmBuildings_() {
  const base = props_().getProperty('PAGES_URL');
  if (!base) return { list: null, note: '公開ページのURLが設定されていません。メニューの「② 公開ページのURLを設定」を先に行ってください。' };
  const url = String(base).replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + 'osm/buildings.json';
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
    if (res.getResponseCode() !== 200) return { list: null, note: url + ' が読めません（番号 ' + res.getResponseCode() + '）。GitHub の「Actions」→「OSM の建物」→「Run workflow」で作ってください。' };
    const j = JSON.parse(res.getContentText());
    const list = (j.b || []).map(function (r) { return { lat: Number(r[0]), lng: Number(r[1]), area: r[2] == null ? null : Number(r[2]), b: String(r[3] || ''), name: String(r[4] || '') }; })
      .filter(function (x) { return isFinite(x.lat) && isFinite(x.lng); });
    return { list: list, at: j.at || '', note: '' };
  } catch (e) {
    return { list: null, note: url + ' が読めません：' + (e && e.message ? e.message : String(e)).slice(0, 120) };
  }
}

/** 通信だけを試す（原因さがし用） */
function testOverpass() {
  const ui = SpreadsheetApp.getUi();
  const ts = terrBounds_();
  let s, w, n, e;
  if (ts.length) { s = ts[0].s; w = ts[0].w; n = ts[0].n; e = ts[0].e; }
  else { ui.alert('区域がまだありません。区域の線を引いてから試してください。'); return; }
  const q = '[out:json][timeout:60];(way["building"](' + s + ',' + w + ',' + n + ',' + e + '););out center 20 qt;';
  const lines = [];
  OVERPASS_URLS.forEach(function (url) {
    try {
      const t0 = Date.now();
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/x-www-form-urlencoded',
        payload: 'data=' + encodeURIComponent(q), muteHttpExceptions: true
      });
      const code = res.getResponseCode(), text = res.getContentText();
      let cnt = '-';
      if (code === 200) { try { cnt = (JSON.parse(text).elements || []).length + '件'; } catch (e2) { cnt = '返事の形が違います'; } }
      lines.push(url.replace('https://', '') + '\n　番号 ' + code + '／' + cnt + '／' + Math.round((Date.now() - t0) / 1000) + '秒');
    } catch (err) {
      lines.push(url.replace('https://', '') + '\n　つながりません：' + (err && err.message ? err.message : String(err)).slice(0, 120));
    }
  });
  ui.alert('地図サーバーへの通信の確認', lines.join('\n\n'), ui.ButtonSet.OK);
}

/* 家として入れない建物（車庫・物置・神社など） */
const SKIP_BUILDING = ['garage', 'garages', 'carport', 'shed', 'roof', 'hut', 'greenhouse', 'barn',
  'storage_tank', 'silo', 'container', 'toilets', 'service', 'shrine', 'temple', 'church', 'construction', 'ruins'];
/* 集合住宅として入れる建物 */
const APT_BUILDING = ['apartments', 'residential', 'dormitory'];

/* ---------- 取り込み（始める） ---------- */
function importProvHouses() {
  const ui = SpreadsheetApp.getUi();
  const running = importState_();
  if (running && (running.tiles || running.src === 'file') && !running.done) {
    const go = ui.alert('取り込みは進行中です',
      '前の取り込みが、まだ途中です（' + (running.src === 'file' ? running.off + '／' + running.total : running.idx + '／' + running.tiles.length) + '）。\n\n' +
      '「はい」＝やめて、新しく始める\n「いいえ」＝そのまま続ける（進み具合を見る）', ui.ButtonSet.YES_NO_CANCEL);
    if (go === ui.Button.CANCEL || go === ui.Button.CLOSE) return;
    if (go === ui.Button.NO) { importStatus(); return; }
    stopImport_();
  }
  let ts = terrBounds_();
  if (!ts.length) { ui.alert('区域の線がありません。先に区域を作ってください。'); return; }
  const ask = ui.prompt('どの区域に入れますか',
    '区域番号を入れると、その区域だけに入れます（例：1）。\nいくつかまとめてなら「1,2,5」のように区切ってください。\n空欄のままOKを押すと、すべての区域に入れます。\n\n区域の数：' + ts.length,
    ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;
  const want = ask.getResponseText().trim();
  let ids = null;
  if (want) {
    const set = {};
    want.replace(/[、，]/g, ',').split(',').forEach(function (x) { const v = x.trim(); if (v) set[v] = true; });
    ts = ts.filter(function (t) { return set[t.no]; });
    if (!ts.length) { ui.alert('その番号の区域が見つかりませんでした。'); return; }
    ids = ts.map(function (t) { return t.id; });
  }
  // 小さい建物を入れない目安（国土地理院の取り込みと同じ）
  const ask2 = ui.prompt('小さい建物をよける',
    '何㎡より小さい建物を入れないかを決めます（物置・車庫をよけるため）。\n' +
    'ふつうは 30 くらいです。0 にすると、すべて入れます。',
    ui.ButtonSet.OK_CANCEL);
  if (ask2.getSelectedButton() !== ui.Button.OK) return;
  const minArea = Math.max(0, Number(ask2.getResponseText().trim() || 30) || 0);
  // 建物は、GitHub Actions「OSM の建物」が作った osm/buildings.json（公開ページ）から読む
  // Apps Script から地図サーバー（Overpass）に聞くと、混んでいて時間切れ（504）になるため
  const got = osmBuildings_();
  if (!got.list) { ui.alert('建物のデータが読めませんでした', got.note, ui.ButtonSet.OK); return; }
  saveImportState_({ src: 'file', off: 0, total: got.list.length, made: got.at, ids: ids, minArea: minArea, got: 0, skipped: 0, small: 0, failed: 0, note: '', at: new Date().toISOString(), done: false });
  ui.alert('取り込みを始めます',
    '建物のデータ：' + got.list.length + '件（OpenStreetMap・' + String(got.at || '').slice(0, 10) + ' 時点）\n' +
    '入れる区域：' + (want ? '区域 ' + ts.map(function (t) { return t.no; }).join('・') : 'すべて（' + ts.length + '区域）') + '\n' +
    '入れない大きさ：' + (minArea ? minArea + '㎡より小さい建物' : 'なし') + '\n\n' +
    'OKを押すと始まります。少し時間がかかるので、そのままお待ちください。', ui.ButtonSet.OK);

  importRun_(); // まず1回ぶん進める

  const st = importState_();
  if (!st) return;
  if (st.done) {
    ui.alert('取り込みが終わりました', importSummary_(st), ui.ButtonSet.OK);
  } else {
    ensureImportTrigger_();
    ui.alert('途中まで入りました',
      importSummary_(st) + '\n\n残りは5分ごとに自動で続きます。\nしばらくしてから、メニューの「取り込みの進み具合を見る」で確認してください。', ui.ButtonSet.OK);
  }
}

/** 進み具合を見る（メニュー） */
function importStatus() {
  const ui = SpreadsheetApp.getUi();
  const st = importState_();
  if (!st) { ui.alert('取り込みは行われていません。'); return; }
  if (st.done) { ui.alert('取り込みの進み具合', importSummary_(st), ui.ButtonSet.OK); return; }
  const r = ui.alert('取り込みの進み具合',
    importSummary_(st) + '\n\n5分ごとに自動で続いています。\n「はい」を押すと、ここで取り込みをやめます。', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) { stopImport_(); ui.alert('取り込みをやめました。すでに入った仮の家は残っています。'); }
}

function importSummary_(st) {
  const prog = st.src === 'file' ? st.off + '／' + st.total + '件の建物' : st.idx + '／' + st.tiles.length + 'か所';
  return '進み具合：' + prog + (st.done ? '（終わりました）' : '') +
    '\n入れた仮の家：' + st.got + '件' +
    '\n入れなかったもの（すでに家がある・車庫など）：' + st.skipped + '件' +
    (st.small ? '\n小さすぎて入れなかった建物：' + st.small + '件' : '') +
    (st.failed ? '\n取れなかった範囲：' + st.failed + 'か所（もう一度実行すると入ります）' : '') +
    (st.note ? '\n\nさいごのエラー：\n' + st.note : '') +
    '\n\n出典：© OpenStreetMap contributors（ODbL）';
}

/* ---------- 取り込み（続き。5分ごとの自動実行から呼ばれる） ---------- */
function importProvResume() {
  const st = importState_();
  if (!st || st.done) { removeImportTrigger_(); return; }
  importRun_();
  const after = importState_();
  if (!after || after.done) removeImportTrigger_();
}

function importRun_() {
  const st = importState_();
  if (!st || st.done) return;
  const ts = terrBounds_().filter(function (t) { return !st.ids || st.ids.indexOf(t.id) >= 0; });
  if (!ts.length) { st.done = true; saveImportState_(st); return; }

  // すでにある家の位置（重複を避けるため）
  const grid = {};
  readCol_('houses').forEach(function (x) {
    const d = x.data;
    if (!d || !isFinite(Number(d.lat))) return;
    const k = gridKey_(Number(d.lat), Number(d.lng));
    (grid[k] = grid[k] || []).push([Number(d.lat), Number(d.lng)]);
  });

  const t0 = Date.now(), now = new Date(), nowIso = now.toISOString();
  const rows = [];
  const add = function (b) {
    if (SKIP_BUILDING.indexOf(b.b) >= 0) { st.skipped++; return; }
    if (st.minArea && b.area != null && b.area < st.minArea) { st.small = (st.small || 0) + 1; return; }
    const tid = terrOfPoint_(ts, b.lat, b.lng);
    if (!tid) return; // 区域の外は数えない
    if (nearExisting_(grid, b.lat, b.lng)) { st.skipped++; return; }
    const k = gridKey_(b.lat, b.lng);
    (grid[k] = grid[k] || []).push([b.lat, b.lng]);
    const id = 'h' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const data = {
      id: id, terrId: tid, type: APT_BUILDING.indexOf(b.b) >= 0 ? 'apt' : 'house',
      lat: Math.round(b.lat * 1e6) / 1e6, lng: Math.round(b.lng * 1e6) / 1e6,
      label: b.name.slice(0, 30), units: [], prov: true,
      createdAt: nowIso, createdBy: 'import'
    };
    rows.push([id, JSON.stringify(data), now, 'import']);
    st.got++;
  };
  if (st.src === 'file') {
    const got = osmBuildings_();
    if (!got.list) { st.note = got.note; st.failed++; st.done = true; saveImportState_(st); return; }
    while (st.off < got.list.length && Date.now() - t0 < RUN_MS) { add(got.list[st.off]); st.off++; }
    if (rows.length) writeProvRows_(rows);
    if (st.off >= got.list.length) st.done = true;
    st.at = new Date().toISOString();
    saveImportState_(st);
    return;
  }
  while (st.idx < st.tiles.length && Date.now() - t0 < RUN_MS) {
    const t = st.tiles[st.idx];
    const list = fetchBuildings_(t[0], t[1], t[2], t[3]);
    if (list === null) {
      // 地図サーバーが混んでいる（504 など）ことが多いので、あとでもう一度試す
      const key = t.join(',');
      st.tries = st.tries || {};
      st.tries[key] = (st.tries[key] || 1) + 1;
      if (st.tries[key] <= IMPORT_TRIES) st.tiles.push(t); else st.failed++;
      st.note = LAST_FETCH_NOTE;
      st.idx++;
      continue;
    }
    list.forEach(function (b) {
      if (SKIP_BUILDING.indexOf(b.b) >= 0) { st.skipped++; return; }
      if (st.minArea && b.area != null && b.area < st.minArea) { st.small = (st.small || 0) + 1; return; }
      const tid = terrOfPoint_(ts, b.lat, b.lng);
      if (!tid) return; // 区域の外は数えない
      if (nearExisting_(grid, b.lat, b.lng)) { st.skipped++; return; }
      const k = gridKey_(b.lat, b.lng);
      (grid[k] = grid[k] || []).push([b.lat, b.lng]);
      const id = 'h' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
      const data = {
        id: id, terrId: tid, type: APT_BUILDING.indexOf(b.b) >= 0 ? 'apt' : 'house',
        lat: Math.round(b.lat * 1e6) / 1e6, lng: Math.round(b.lng * 1e6) / 1e6,
        label: b.name.slice(0, 30), units: [], prov: true,
        createdAt: nowIso, createdBy: 'import'
      };
      rows.push([id, JSON.stringify(data), now, 'import']);
      st.got++;
    });
    st.idx++;
  }
  if (rows.length) writeProvRows_(rows);
  if (st.idx >= st.tiles.length) st.done = true;
  st.at = new Date().toISOString();
  saveImportState_(st);
}

function writeProvRows_(rows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const sh = dataSheet_('houses');
    const start = sh.getLastRow() + 1;
    for (let i = 0; i < rows.length; i += 2000) {
      const part = rows.slice(i, i + 2000);
      sh.getRange(start + i, 1, part.length, 4).setValues(part);
    }
    resetJournal_(); // 各自の画面は、次に開いたときに一度だけ読み直す
  } finally { lock.releaseLock(); }
}

/* ---------- 途中経過と、自動で続きを行う仕かけ ---------- */
function importState_() {
  const v = props_().getProperty(IMPORT_STATE);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function saveImportState_(st) { props_().setProperty(IMPORT_STATE, JSON.stringify(st)); }
function stopImport_() { props_().deleteProperty(IMPORT_STATE); removeImportTrigger_(); }
function ensureImportTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'importProvResume'; });
  if (!has) ScriptApp.newTrigger('importProvResume').timeBased().everyMinutes(5).create();
}
function removeImportTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importProvResume') ScriptApp.deleteTrigger(t);
  });
}

/* ---------- 手で貼った緯度・経度（importシート）から取り込む ---------- */
function importFromSheet() {
  const ui = SpreadsheetApp.getUi();
  let sh = book_().getSheetByName(IMPORT_SHEET);
  if (!sh) {
    sh = book_().insertSheet(IMPORT_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['緯度', '経度', '名前（任意）']]);
    sh.setFrozenRows(1);
    ui.alert('「import」シートを作りました。緯度・経度を貼ってから、もう一度実行してください。');
    return;
  }
  const last = sh.getLastRow();
  if (last < 2) { ui.alert('「import」シートに、緯度・経度を貼ってください。'); return; }
  const vals = sh.getRange(2, 1, last - 1, 3).getValues();
  const ts = terrBounds_();
  const grid = {};
  readCol_('houses').forEach(function (x) {
    const d = x.data;
    if (!d || !isFinite(Number(d.lat))) return;
    const k = gridKey_(Number(d.lat), Number(d.lng));
    (grid[k] = grid[k] || []).push([Number(d.lat), Number(d.lng)]);
  });
  const rows = [], now = new Date(), nowIso = now.toISOString();
  let got = 0, skipped = 0;
  vals.forEach(function (r) {
    const lat = Number(r[0]), lng = Number(r[1]);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const tid = terrOfPoint_(ts, lat, lng);
    if (!tid) { skipped++; return; }
    if (nearExisting_(grid, lat, lng)) { skipped++; return; }
    const k = gridKey_(lat, lng);
    (grid[k] = grid[k] || []).push([lat, lng]);
    const id = 'h' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const data = { id: id, terrId: tid, type: 'house', lat: lat, lng: lng, label: String(r[2] || '').slice(0, 30), units: [], prov: true, createdAt: nowIso, createdBy: 'import' };
    rows.push([id, JSON.stringify(data), now, 'import']);
    got++;
  });
  if (!rows.length) { ui.alert('入れられる点がありませんでした（区域の外か、すでに家があります）。'); return; }
  writeProvRows_(rows);
  ui.alert('仮の家 ' + got + '件を入れました（入れなかったもの ' + skipped + '件）。');
}
