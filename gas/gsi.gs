/* =========================================================
   国土地理院「基盤地図情報（建築物）」から、仮の家を取り込む
   （Apps Script に新しいファイル（例：gsi.gs）として貼り付けてください）

   使い方のながれ
   ① 国土地理院のサイトから、建築物のデータ（zip）をダウンロード
   ② Googleドライブにフォルダを作り、その zip を入れる（何個でも可）
   ③ メニュー「区域マップ」→「国土地理院のデータから取り込む」
   ④ フォルダのURLを貼り、区域番号を入れる（空欄なら全区域）
   ⑤ 6分の実行制限に当たる前にいったん止まり、5分ごとに自動で続きます

   ・建物の中心を「仮の家」として入れます。アプリでは点線の印で出ます。
   ・「無壁舎」（車庫・物置など壁のない建物）は入れません。
   ・小さすぎる建物（初期値30㎡未満）も入れません。
   ・すでにある家の近く（8m以内）にも入れません。
   ・出典：国土地理院「基盤地図情報」
   ========================================================= */

const GSI_STATE = 'GSI_STATE';
const GSI_FOLDER = 'GSI_FOLDER';
const GSI_RUN_MS = 4.5 * 60000;     // 1回の実行で使う時間の上限
const GSI_SKIP_TYPE = ['普通無壁舎', '堅ろう無壁舎', '無壁舎']; // 車庫・物置・カーポートなど

/* ---------- メニュー（本体の onOpen に足してください） ----------
    .addItem('国土地理院のデータから取り込む', 'importGsi')
    .addItem('国土地理院の取り込みの進み具合', 'importGsiStatus')
   ---------------------------------------------------------------- */

/** 取り込みを始める */
function importGsi() {
  const ui = SpreadsheetApp.getUi();
  const st0 = gsiState_();
  if (st0 && !st0.done) {
    const go = ui.alert('取り込みは進行中です',
      '前の取り込みが、まだ途中です（' + st0.idx + '／' + st0.files.length + 'ファイル）。\n\n' +
      '「はい」＝やめて、新しく始める\n「いいえ」＝そのまま続ける（進み具合を見る）', ui.ButtonSet.YES_NO_CANCEL);
    if (go === ui.Button.CANCEL || go === ui.Button.CLOSE) return;
    if (go === ui.Button.NO) { importGsiStatus(); return; }
    gsiStop_();
  }

  // ① フォルダ
  const prev = props_().getProperty(GSI_FOLDER) || '';
  const ask1 = ui.prompt('データの置き場所',
    'ダウンロードした zip を入れた、Googleドライブのフォルダの URL を貼ってください。\n' +
    '（フォルダを開いたときの、アドレス欄のURLです）' + (prev ? '\n\n前回：' + prev : ''),
    ui.ButtonSet.OK_CANCEL);
  if (ask1.getSelectedButton() !== ui.Button.OK) return;
  const url = ask1.getResponseText().trim() || prev;
  const m = url.match(/[-\w]{25,}/);
  if (!m) { ui.alert('フォルダのURLが読み取れませんでした。フォルダを開いた状態のURLを貼ってください。'); return; }
  const folderId = m[0];
  let folder;
  try { folder = DriveApp.getFolderById(folderId); } catch (e) { ui.alert('そのフォルダを開けませんでした。共有の設定と、URLを確かめてください。'); return; }
  props_().setProperty(GSI_FOLDER, url);

  // ② 区域
  let ts = terrBounds_();
  if (!ts.length) { ui.alert('区域の線がありません。先に区域を作ってください。'); return; }
  const ask2 = ui.prompt('どの区域に入れますか',
    '区域番号を入れると、その区域だけに入れます（例：1）。\nいくつかまとめてなら「1,2,5」のように区切ってください。\n空欄のままOKを押すと、すべての区域に入れます。\n\n区域の数：' + ts.length,
    ui.ButtonSet.OK_CANCEL);
  if (ask2.getSelectedButton() !== ui.Button.OK) return;
  const want = ask2.getResponseText().trim();
  let ids = null;
  if (want) {
    const set = {};
    want.replace(/[、，]/g, ',').split(',').forEach(function (x) { const v = x.trim(); if (v) set[v] = true; });
    ts = ts.filter(function (t) { return set[t.no]; });
    if (!ts.length) { ui.alert('その番号の区域が見つかりませんでした。'); return; }
    ids = ts.map(function (t) { return t.id; });
  }

  // ③ 小さい建物を入れない目安
  const ask3 = ui.prompt('小さい建物をよける',
    '何㎡より小さい建物を入れないかを決めます（物置・車庫をよけるため）。\n' +
    'ふつうは 30 くらいです。0 にすると、すべて入れます。',
    ui.ButtonSet.OK_CANCEL);
  if (ask3.getSelectedButton() !== ui.Button.OK) return;
  const minArea = Math.max(0, Number(ask3.getResponseText().trim() || 30) || 0);

  // ④ ファイルの一覧
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next(), name = f.getName();
    if (/\.(zip|xml)$/i.test(name)) files.push({ id: f.getId(), name: name });
  }
  if (!files.length) { ui.alert('そのフォルダに zip（または xml）が見つかりませんでした。'); return; }

  gsiSave_({ files: files, idx: 0, off: 0, ids: ids, minArea: minArea, got: 0, skipped: 0, small: 0, note: '', done: false, at: new Date().toISOString() });
  ui.alert('取り込みを始めます',
    'ファイル：' + files.length + '個\n' +
    '入れる区域：' + (want ? '区域 ' + ts.map(function (t) { return t.no; }).join('・') : 'すべて（' + ts.length + '区域）') + '\n' +
    '入れない大きさ：' + (minArea ? minArea + '㎡より小さい建物' : 'なし') + '\n\n' +
    'OKを押すと始まります。数分かかるので、そのままお待ちください。', ui.ButtonSet.OK);

  gsiRun_();
  const st = gsiState_();
  if (!st) return;
  if (st.done) {
    ui.alert('取り込みが終わりました', gsiSummary_(st), ui.ButtonSet.OK);
  } else {
    gsiEnsureTrigger_();
    ui.alert('途中まで入りました',
      gsiSummary_(st) + '\n\n残りは5分ごとに自動で続きます。\nメニューの「国土地理院の取り込みの進み具合」で確認できます。', ui.ButtonSet.OK);
  }
}

/** 進み具合を見る／やめる */
function importGsiStatus() {
  const ui = SpreadsheetApp.getUi();
  const st = gsiState_();
  if (!st) { ui.alert('取り込みは行われていません。'); return; }
  if (st.done) { ui.alert('取り込みの進み具合', gsiSummary_(st), ui.ButtonSet.OK); return; }
  const r = ui.alert('取り込みの進み具合',
    gsiSummary_(st) + '\n\n5分ごとに自動で続いています。\n「はい」を押すと、ここでやめます。', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) { gsiStop_(); ui.alert('取り込みをやめました。すでに入った仮の家は残っています。'); }
}

function gsiSummary_(st) {
  const f = st.files[st.idx];
  return '進み具合：' + st.idx + '／' + st.files.length + 'ファイル' + (st.done ? '（終わりました）' : '') +
    (!st.done && f ? '\n今のファイル：' + f.name : '') +
    '\n入れた仮の家：' + st.got + '件' +
    '\n入れなかったもの（区域の外・すでに家がある・無壁舎）：' + st.skipped + '件' +
    '\n小さすぎて入れなかった建物：' + st.small + '件' +
    (st.note ? '\n\nお知らせ：' + st.note : '') +
    '\n\n出典：国土地理院「基盤地図情報」';
}

/** 5分ごとの自動実行から呼ばれる */
function importGsiResume() {
  const st = gsiState_();
  if (!st || st.done) { gsiRemoveTrigger_(); return; }
  gsiRun_();
  const after = gsiState_();
  if (!after || after.done) gsiRemoveTrigger_();
}

/* ---------- 本体 ---------- */
function gsiRun_() {
  const st = gsiState_();
  if (!st || st.done) return;
  const ts = terrBounds_().filter(function (t) { return !st.ids || st.ids.indexOf(t.id) >= 0; });
  if (!ts.length) { st.done = true; gsiSave_(st); return; }
  // 区域ぜんたいの四角（ここから大きく外れる建物は、すぐに捨てる）
  let S = 90, N = -90, W = 180, E = -180;
  ts.forEach(function (t) { S = Math.min(S, t.s); N = Math.max(N, t.n); W = Math.min(W, t.w); E = Math.max(E, t.e); });

  // すでにある家の位置
  const grid = {};
  readCol_('houses').forEach(function (x) {
    const d = x.data;
    if (!d || !isFinite(Number(d.lat))) return;
    const k = gridKey_(Number(d.lat), Number(d.lng));
    (grid[k] = grid[k] || []).push([Number(d.lat), Number(d.lng)]);
  });

  const t0 = Date.now(), now = new Date(), nowIso = now.toISOString();
  let rows = [];
  while (st.idx < st.files.length && Date.now() - t0 < GSI_RUN_MS) {
    const info = st.files[st.idx];
    // 大きい xml（ドライブの1回で読める大きさをこえるもの）は、少しずつ読む（2026-11-15）
    let big = 0;
    try { big = gsiBigSize_(info); } catch (e) { big = 0; }
    if (big < 0) { st.idx++; st.off = 0; st.boff = 0; continue; } // 建物でない大きいファイル（道路など）は読まない
    if (big > 0) {
      let fin = false;
      try {
        while (Date.now() - t0 < GSI_RUN_MS) {
          const r = gsiChunk_(info.id, st.boff || 0, big);
          if (r.text) {
            rows = rows.concat(gsiParse_(r.text, ts, S, N, W, E, grid, st, nowIso, now));
            if (rows.length > 4000) { writeProvRows_(rows); rows = []; }
          }
          st.boff = r.next;
          if (r.next >= big) { fin = true; break; }
        }
      } catch (e) {
        st.note = info.name + ' を読み切れませんでした：' + (e && e.message ? e.message : String(e)).slice(0, 100);
        fin = true;
      }
      if (fin) { st.idx++; st.off = 0; st.boff = 0; }
      continue;
    }
    let texts;
    try {
      texts = gsiTexts_(info);
    } catch (e) {
      st.note = info.name + ' を開けませんでした：' + (e && e.message ? e.message : String(e)).slice(0, 200);
      st.idx++; st.off = 0;
      continue;
    }
    let finished = true;
    for (let ti = st.off || 0; ti < texts.length; ti++) {
      if (Date.now() - t0 > GSI_RUN_MS) { st.off = ti; finished = false; break; }
      const found = gsiParse_(texts[ti], ts, S, N, W, E, grid, st, nowIso, now);
      rows = rows.concat(found);
      if (rows.length > 4000) { writeProvRows_(rows); rows = []; }
    }
    if (finished) { st.idx++; st.off = 0; }
  }
  if (rows.length) writeProvRows_(rows);
  if (st.idx >= st.files.length) st.done = true;
  st.at = new Date().toISOString();
  gsiSave_(st);
}

/* ---------- 大きい xml を少しずつ読む（2026-11-15） ----------
   ドライブのファイルは、1回で読めるのが約50MBまで。人の多い地域の建築物（BldA）の xml はそれをこえるので、
   ドライブの API から 8MB ずつ（Range）取り、建物の区切り（</BldA>）で切って読む。続きはバイトの位置（st.boff）から */
const GSI_BIG = 30 * 1024 * 1024;   // これより大きい xml は少しずつ読む
const GSI_CHUNK = 8 * 1024 * 1024;  // 1回に取る大きさ
/** 少しずつ読む xml なら、その大きさ（バイト）。建物でない大きいファイルは -1。ふつうに読めるものは 0 */
function gsiBigSize_(info) {
  if (!/\.xml$/i.test(info.name)) return 0;
  const size = DriveApp.getFileById(info.id).getSize();
  if (size <= GSI_BIG) return 0;
  if (/FG-GML-/i.test(info.name) && !/Bld/i.test(info.name)) return -1;
  return size;
}
/** off バイト目から1かたまり取り、終わりの建物までの文字と、次に読むバイトの位置を返す */
function gsiChunk_(id, off, size) {
  const end = Math.min(off + GSI_CHUNK, size) - 1;
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + off + '-' + end },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 206 && !(code === 200 && off === 0 && end + 1 >= size)) throw new Error('ドライブから読めませんでした（' + code + '）');
  const bytes = res.getContent();
  const eof = off + bytes.length >= size;
  // 日本語の文字の途中で切らないように、最後の「>」（1バイトの文字）までにする
  let cut = bytes.length;
  if (!eof) { while (cut > 0 && bytes[cut - 1] !== 62) cut--; if (!cut) cut = bytes.length; }
  let text = Utilities.newBlob(cut === bytes.length ? bytes : bytes.slice(0, cut)).getDataAsString('UTF-8');
  if (eof) return { text: text, next: size };
  // 最後の </BldA> までを読む（その先は次のかたまりで）
  const re = /<\/(?:\w+:)?BldA>/g;
  let last = -1, m;
  while ((m = re.exec(text)) !== null) last = m.index + m[0].length;
  if (last < 0) return { text: '', next: off + cut }; // 建物の区切りがない（ふつうはない）：先へ進む
  text = text.slice(0, last);
  return { text: text, next: off + Utilities.newBlob(text).getBytes().length };
}

/** zip（または xml）の中身を、文字の配列にする。zipの中のzipも開く */
function gsiTexts_(info) {
  const file = DriveApp.getFileById(info.id);
  const name = info.name;
  if (/\.xml$/i.test(name)) return [file.getBlob().getDataAsString('UTF-8')];
  return gsiUnzip_(file.getBlob().setContentType('application/zip'), 0).texts;
}
/** zipを開いて、建物のXMLだけを取り出す（何段でも開く） */
function gsiUnzip_(blob, depth) {
  const texts = [], names = [];
  let items;
  try { items = Utilities.unzip(blob); } catch (e) {
    // 人の多いメッシュの「全項目」の zip は、中のファイルが大きすぎて Apps Script では開けない（100MBの制限）。展開した xml なら読める（2026-11-15）
    if (depth === 0) throw new Error('zip を開けません。パソコンで展開し、中の「FG-GML-…-BldA-…xml」だけをフォルダに入れてください（' + (e && e.message ? e.message : e) + '）');
    return { texts: texts, names: names };
  }
  const xmls = [];
  items.forEach(function (b) {
    const n = b.getName() || '';
    names.push(n);
    if (/\.xml$/i.test(n)) { xmls.push(b); return; }
    if (/\.zip$/i.test(n) && depth < 4) {
      const r = gsiUnzip_(b.setContentType('application/zip'), depth + 1);
      r.texts.forEach(function (t) { texts.push(t); });
      r.names.forEach(function (x) { names.push(x); });
    }
  });
  // 建物のファイルだけを読む（名前で分かるときは、それだけ。分からなければ全部）
  const bld = xmls.filter(function (b) { return /bld/i.test(b.getName() || ''); });
  (bld.length ? bld : xmls).forEach(function (b) { texts.push(b.getDataAsString('UTF-8')); });
  return { texts: texts, names: names };
}

/** XMLの文字から建物をひろって、仮の家の行を作る */
function gsiParse_(text, ts, S, N, W, E, grid, st, nowIso, now) {
  const rows = [];
  if (text.indexOf('BldA') < 0) return rows; // 建築物（面）が入っていないファイル
  const parts = text.split(/<\/(?:\w+:)?BldA>/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const mo = p.match(/<(?:\w+:)?BldA[\s>]/);
    if (!mo) continue;
    const body = p.slice(p.indexOf(mo[0]));
    const mt = body.match(/<(?:\w+:)?type>([^<]*)<\/(?:\w+:)?type>/);
    const type = mt ? mt[1].trim() : '';
    if (GSI_SKIP_TYPE.indexOf(type) >= 0) { st.skipped++; continue; }
    const mp = body.match(/<(?:\w+:)?posList>([\s\S]*?)<\/(?:\w+:)?posList>/);
    if (!mp) continue;
    const nums = mp[1].trim().split(/\s+/);
    if (nums.length < 8) continue;
    // 「緯度 経度」の組が並んでいる
    const pts = [];
    let sy = 0, sx = 0;
    for (let k = 0; k + 1 < nums.length; k += 2) {
      const la = Number(nums[k]), ln = Number(nums[k + 1]);
      if (!isFinite(la) || !isFinite(ln)) continue;
      pts.push([la, ln]);
      sy += la; sx += ln;
    }
    const cnt = pts.length;
    if (cnt < 3) continue;
    // まん中（重心）と広さ。数の桁落ちを防ぐため、1点目を原点にしてから計算する
    const lat0 = pts[0][0], lng0 = pts[0][1];
    let a2 = 0, cx = 0, cy = 0;
    for (let k = 0; k < cnt; k++) {
      const p1 = pts[k], p2 = pts[(k + 1) % cnt];
      const x1 = p1[1] - lng0, y1 = p1[0] - lat0, x2 = p2[1] - lng0, y2 = p2[0] - lat0;
      const f = x1 * y2 - x2 * y1;
      a2 += f;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
    let lat, lng;
    if (Math.abs(a2) > 1e-16) { lat = lat0 + cy / (3 * a2); lng = lng0 + cx / (3 * a2); }
    else { lat = sy / cnt; lng = sx / cnt; }
    if (!isFinite(lat) || !isFinite(lng)) continue;
    if (lat < S - 0.01 || lat > N + 0.01 || lng < W - 0.01 || lng > E + 0.01) continue; // 区域から遠いものは捨てる
    if (st.minArea) {
      const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
      const area = Math.abs(a2) / 2 * mPerDegLat * mPerDegLng;
      if (area < st.minArea) { st.small++; continue; }
    }
    const tid = terrOfPoint_(ts, lat, lng);
    if (!tid) continue; // 区域の外
    if (nearExisting_(grid, lat, lng)) { st.skipped++; continue; }
    const gk = gridKey_(lat, lng);
    (grid[gk] = grid[gk] || []).push([lat, lng]);
    const id = 'h' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const data = {
      id: id, terrId: tid, type: 'house',
      lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
      label: '', units: [], prov: true, createdAt: nowIso, createdBy: 'import'
    };
    rows.push([id, JSON.stringify(data), now, 'import']);
    st.got++;
  }
  return rows;
}

/* ---------- 途中経過と、自動で続きを行う仕かけ ---------- */
function gsiState_() {
  const v = props_().getProperty(GSI_STATE);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function gsiSave_(st) { props_().setProperty(GSI_STATE, JSON.stringify(st)); }
function gsiStop_() { props_().deleteProperty(GSI_STATE); gsiRemoveTrigger_(); }
function gsiEnsureTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'importGsiResume'; });
  if (!has) ScriptApp.newTrigger('importGsiResume').timeBased().everyMinutes(5).create();
}
function gsiRemoveTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importGsiResume') ScriptApp.deleteTrigger(t);
  });
}

/** 緯度・経度から、基盤地図情報の2次メッシュ番号（例：392715）を求める */
function meshCode_(lat, lng) {
  const p = Math.floor(lat * 1.5);
  const u = Math.floor(lng) - 100;
  const q = Math.floor((lat * 1.5 - p) * 8);
  const v = Math.floor((lng - Math.floor(lng)) * 8);
  return String(p) + String(u) + String(q) + String(v);
}

/** 区域ごとに、必要なメッシュ番号を出す（ダウンロードもれを見つける用） */
function showTerrMesh() {
  const ui = SpreadsheetApp.getUi();
  let ts = terrBounds_();
  if (!ts.length) { ui.alert('区域の線がありません。'); return; }
  const ask = ui.prompt('必要なメッシュを調べる',
    '区域番号を入れると、その区域だけを調べます（例：15）。\n空欄のままOKを押すと、すべての区域を調べます。', ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;
  const want = ask.getResponseText().trim();
  if (want) {
    const set = {};
    want.replace(/[、，]/g, ',').split(',').forEach(function (x) { const v = x.trim(); if (v) set[v] = true; });
    ts = ts.filter(function (t) { return set[t.no]; });
    if (!ts.length) { ui.alert('その番号の区域が見つかりませんでした。'); return; }
  }
  const all = {};
  const lines = ts.slice(0, 40).map(function (t) {
    const ms = {};
    // 区域の四すみと、すこし内側の点から、かかるメッシュを調べる
    [[t.s, t.w], [t.s, t.e], [t.n, t.w], [t.n, t.e], [(t.s + t.n) / 2, (t.w + t.e) / 2]].forEach(function (pt) {
      const c = meshCode_(pt[0], pt[1]);
      ms[c] = true; all[c] = true;
    });
    return '区域' + t.no + '：' + Object.keys(ms).join('、');
  });
  ui.alert('必要なメッシュ番号',
    lines.join('\n') + (ts.length > 40 ? '\n…ほか' + (ts.length - 40) + '区域' : '') +
    '\n\n【全部でまとめると】\n' + Object.keys(all).sort().join('、') +
    '\n\nこの番号のファイル（FG-GML-●●●●●●-ALL-….zip）が、ドライブのフォルダにそろっているか確かめてください。', ui.ButtonSet.OK);
}

/** 区域ごとに、入っている家と「仮の家」の数を数える */
function countProvByTerr() {
  const ui = SpreadsheetApp.getUi();
  const nos = {};
  readCol_('territories').forEach(function (x, id) { nos[id] = String(x.data.no || '?'); });
  const cnt = {};
  readCol_('houses').forEach(function (x) {
    const d = x.data, no = nos[d.terrId] || '（区域なし）';
    if (!cnt[no]) cnt[no] = { all: 0, prov: 0 };
    cnt[no].all++;
    if (d.prov) cnt[no].prov++;
  });
  const keys = Object.keys(cnt).sort(function (a, b) { return (Number(a) || 9999) - (Number(b) || 9999); });
  if (!keys.length) { ui.alert('家が1件も入っていません。'); return; }
  const lines = keys.slice(0, 60).map(function (k) { return '区域' + k + '：' + cnt[k].all + '件（うち仮の家 ' + cnt[k].prov + '件）'; });
  ui.alert('区域ごとの家の数', lines.join('\n') + (keys.length > 60 ? '\n…ほか' + (keys.length - 60) + '区域' : ''), ui.ButtonSet.OK);
}

/** ファイルがちゃんと読めるか、1つだけ試す（原因さがし用） */
function testGsiFile() {
  const ui = SpreadsheetApp.getUi();
  const url = props_().getProperty(GSI_FOLDER) || '';
  const m = url.match(/[-\w]{25,}/);
  if (!m) { ui.alert('先に「国土地理院のデータから取り込む」で、フォルダのURLを入れてください。'); return; }
  const it = DriveApp.getFolderById(m[0]).getFiles();
  const lines = [];
  let n = 0;
  while (it.hasNext() && n < 3) {
    const f = it.next(), name = f.getName();
    if (!/\.(zip|xml)$/i.test(name)) continue;
    n++;
    try {
      let texts, inner = [];
      if (/\.xml$/i.test(name)) {
        texts = [f.getBlob().getDataAsString('UTF-8')];
      } else {
        const r = gsiUnzip_(f.getBlob().setContentType('application/zip'), 0);
        texts = r.texts; inner = r.names;
      }
      let bld = 0;
      texts.forEach(function (t) { bld += (t.split(/<\/(?:\w+:)?BldA>/).length - 1); });
      let first = '';
      for (let k = 0; k < texts.length && !first; k++) {
        const mm = texts[k].match(/<(?:\w+:)?posList>([\s\S]{0,60})/);
        if (mm) first = mm[1].trim().split(/\s+/).slice(0, 2).join(' , ');
      }
      lines.push(name + '\n　中のファイル：' + inner.length + '個（' + inner.slice(0, 4).join('、') + (inner.length > 4 ? ' ほか' : '') + '）' +
        '\n　読んだXML：' + texts.length + '個／建物：' + bld + '件' +
        '\n　最初の座標：' + (first || '見つかりません'));
    } catch (e) {
      lines.push(name + '\n　開けません：' + (e && e.message ? e.message : String(e)).slice(0, 120));
    }
  }
  ui.alert('ファイルの確認', lines.length ? lines.join('\n\n') : 'zip も xml も見つかりませんでした。', ui.ButtonSet.OK);
}
