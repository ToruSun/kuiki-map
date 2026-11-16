/**
 * 区域マップ：年齢データの自動取り込み（BODIK オープンデータ）
 * Code.gs と同じ Apps Script のプロジェクトに、別のファイル「AgeAuto.gs」として足します。
 *
 * ・豊見城市が毎月公開している「地域・年齢別人口」（字・丁目ごと、5歳きざみ）を、
 *   毎月10日の朝に取りに行き、新しい月のデータがあれば年齢データとして保存します。
 * ・保存の形は、区域係の画面で「市のCSV」を読み込んだときと同じです（cur:47212）。
 * ・はじめに1回、スプレッドシートのメニュー「区域マップ」→「年齢データを取り込む」を押すと、
 *   すぐに取り込み、毎月の自動取り込みも設定します。
 * ・通信は月1回・数KBだけです。取れなかった月は、今までどおり手で読み込めます。
 *
 * 出典：豊見城市「地域・年齢別人口」（クリエイティブ・コモンズ 表示 2.1 日本）
 * ほかの市町村で使うときは、下の AGE_AUTO を書きかえます（使わないときは pkg を '' に）。
 */
const AGE_AUTO = {
  // 使わないときは pkg を空に（何もしない）。例：豊見城市で使うときは pkg: '472123_population'・code: '47212'・city: '豊見城市'
  pkg: '',                  // BODIK のデータセットの名前
  code: '',                 // 市町村コード（5けた）
  city: ''
};
const BODIK_API = 'https://data.bodik.jp/api/3/action/';

/** メニュー：今すぐ取り込み、毎月の自動取り込みを設定する */
function ageAutoMenu() {
  const ui = SpreadsheetApp.getUi();
  if (!AGE_AUTO.pkg) { ui.alert('年齢データの自動取り込み', 'この会衆では使っていません（BODIK に年齢データを出している市町村のための機能です）。\n年齢データは、区域係の画面の「設定」→「年齢データ」から、e-Stat（国勢調査）のファイルで入れます。', ui.ButtonSet.OK); return; }
  installAgeAuto_();
  let msg;
  try { msg = ageAutoImport().msg; } catch (e) { msg = '取り込めませんでした：' + (e && e.message ? e.message : e); }
  ui.alert('年齢データの自動取り込み', msg + '\n\n毎月10日の朝に、新しいデータがないか自動で確かめます。', ui.ButtonSet.OK);
}

function installAgeAuto_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ageAutoImport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ageAutoImport').timeBased().onMonthDay(10).atHour(5).create();
}

/** 毎月の自動取り込み（タイマーから呼ばれる） */
function ageAutoImport() {
  if (!AGE_AUTO.pkg) return { ok: false, msg: '設定がありません' };
  const pkg = bodikGet_('package_show?id=' + encodeURIComponent(AGE_AUTO.pkg));
  const list = (pkg.resources || [])
    .map(function (r) { return { r: r, d: bodikDate_(r) }; })
    .filter(function (x) { return x.d && !/割合/.test(String(x.r.name || '')); })
    .sort(function (a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; });
  if (!list.length) throw new Error('データが見つかりません');
  const newest = list[0], docId = 'cur:' + AGE_AUTO.code;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const map = readCol_('agedata'), cur = map.get(docId);
    if (cur && cur.data && cur.data.asOf && cur.data.asOf >= newest.d) {
      return { ok: true, msg: '新しいデータはありません（今のデータ：' + cur.data.asOf + '時点）' };
    }
    const doc = ageDocFrom_(bodikRecords_(newest.r), newest.d, String(newest.r.name || ''));
    if (doc.areas.length < 3) throw new Error('字のデータが少なすぎます');
    writeCol_('agedata', map, [[docId, doc]], [], 'auto');
    return { ok: true, msg: doc.asOf + '時点の年齢データ（' + doc.areas.length + '地域）を取り込みました' };
  } finally {
    lock.releaseLock();
  }
}

function bodikGet_(path) {
  const r = UrlFetchApp.fetch(BODIK_API + path, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('BODIK に接続できませんでした（' + r.getResponseCode() + '）');
  const j = JSON.parse(r.getContentText('UTF-8'));
  if (!j.success) throw new Error('BODIK からの返事が正しくありません');
  return j.result;
}

/** データの日付：ファイル名の「_20260930.csv」か、名前の「令和8年9月末」から */
function bodikDate_(r) {
  const u = String(r.url || '').match(/(20\d{2})(\d{2})(\d{2})\.csv/i);
  if (u) return u[1] + '-' + u[2] + '-' + u[3];
  const n = String(r.name || '').normalize('NFKC').match(/令和(\d+)年(\d+)月/);
  if (n) {
    const d = new Date(2018 + Number(n[1]), Number(n[2]), 0);
    return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return '';
}

/** 1か月分の行（{列名: 値}）：データストアがあればそこから、なければ CSV から */
function bodikRecords_(r) {
  if (r.datastore_active) {
    try {
      const res = bodikGet_('datastore_search?resource_id=' + encodeURIComponent(r.id) + '&limit=1000');
      if (res.records && res.records.length) return res.records;
    } catch (e) { /* CSV で読む */ }
  }
  const f = UrlFetchApp.fetch(r.url, { muteHttpExceptions: true });
  if (f.getResponseCode() !== 200) throw new Error('CSV を読めませんでした（' + f.getResponseCode() + '）');
  let text = f.getContentText('UTF-8');
  if (text.indexOf('�') >= 0) text = f.getContentText('Shift_JIS');
  const rows = Utilities.parseCsv(text.replace(/^﻿/, ''));
  const head = rows[0].map(function (c) { return String(c).trim(); });
  return rows.slice(1).map(function (row) {
    const o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/** 字の名前をそろえる（画面の azaKey と同じ決まり） */
function azaKeyS_(s) {
  const kan = function (k) {
    const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (k.indexOf('十') < 0) return String(d[k] || k);
    const p = k.split('十');
    return String((p[0] ? d[p[0]] : 1) * 10 + (p[1] ? d[p[1]] : 0));
  };
  let x = String(s || '').normalize('NFKC').replace(/\s+/g, '');
  x = x.replace(/^沖縄県/, '').replace(/^豊見城市/, '').replace(new RegExp('^' + AGE_AUTO.city), '').replace(/^大字/, '').replace(/^字/, '');
  return x.replace(/([一二三四五六七八九十]+)丁目/, function (m, k) { return kan(k) + '丁目'; });
}

/** 行から年齢データを作る（％は小数1けた。画面で市のCSVを読んだときと同じ計算） */
function ageDocFrom_(recs, asOf, srcName) {
  const num = function (v) { const x = Number(String(v == null ? '' : v).replace(/[,\s]/g, '')); return isFinite(x) ? x : 0; };
  const pc = function (v, tot) { return Math.round(v / tot * 1000) / 10; };
  const areas = [], seen = {};
  let all = null;
  recs.forEach(function (rec) {
    const name = String(rec['地域名'] || '').normalize('NFKC').trim();
    if (!name) return;
    const s = { tot: 0, c: 0, y: 0, m: 0, o: 0, o75: 0, t: 0, c0: 0, c1: 0, c2: 0 };
    Object.keys(rec).forEach(function (col) {
      const c = String(col).normalize('NFKC');
      if (!/[男女]/.test(c) || /再掲|人口/.test(c)) return;
      const m = c.match(/^(\d+)\s*-\s*(\d+)\s*歳/) || c.match(/^(\d+)\s*歳以上/);
      if (!m) return;
      const lo = Number(m[1]), v = num(rec[col]);
      s.tot += v;
      if (lo < 15) s.c += v; else if (lo >= 20 && lo < 40) s.y += v; else if (lo >= 40 && lo < 65) s.m += v; else if (lo >= 65) s.o += v;
      if (lo >= 75) s.o75 += v;
      if (lo >= 20 && lo < 50) s.t += v;
      if (lo === 0) s.c0 += v; else if (lo === 5) s.c1 += v; else if (lo === 10) s.c2 += v;
    });
    if (s.tot <= 0) return;
    const a = { k: AGE_AUTO.code + ':' + azaKeyS_(name), n: AGE_AUTO.city + ' ' + name, pop: s.tot };
    ['c', 'y', 'm', 'o', 'o75', 't', 'c0', 'c1', 'c2'].forEach(function (f) { a[f] = pc(s[f], s.tot); });
    a.hh = num(rec['世帯数']);
    if (/^(全体|合計|総数|計|市計|総計)$/.test(name) || /市$/.test(name)) { all = a; return; }
    if (seen[a.k]) return;
    seen[a.k] = true;
    areas.push(a);
  });
  // 1世帯あたりの人数（市の平均を1とした比）
  const popAll = areas.reduce(function (x, a) { return x + a.pop; }, 0);
  const hhAll = areas.reduce(function (x, a) { return x + (a.hh || 0); }, 0);
  areas.forEach(function (a) {
    if (a.hh && hhAll) a.hi = Math.round((a.pop / popAll) / (a.hh / hhAll) * 100) / 100;
    delete a.hh;
  });
  if (!all) {
    all = { pop: popAll };
    ['c', 'y', 'm', 'o', 'o75', 't', 'c0', 'c1', 'c2'].forEach(function (f) {
      all[f] = popAll ? Math.round(areas.reduce(function (x, a) { return x + a[f] * a.pop; }, 0) / popAll * 10) / 10 : 0;
    });
  }
  all.k = '__all'; all.n = AGE_AUTO.city; delete all.hh;
  return { id: 'cur:' + AGE_AUTO.code, src: 'city', asOf: asOf, city: AGE_AUTO.city, areas: areas, all: all,
    file: ('BODIK ' + srcName).slice(0, 80), savedAt: new Date().toISOString(), by: 'auto' };
}
