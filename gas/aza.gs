/* =========================================================
   区域と字（あざ）の対応を、自動で調べる（aza.gs）
   年齢データ（e-Stat 国勢調査 小地域集計）と組み合わせて、区域ごとの年代の割合を出すために使います。

   ・区域の中の家から最大12件をえらび、その位置を国土地理院の住所検索
     （緯度・経度 → 市町村コード・字・丁目の名前）に問い合わせて、区域に入っている字と割合を決める
   ・字の印は「市町村コード:字の名前」（例 47205:大謝名1丁目）。市町村をまたぐ区域や、
     同じ名前の字がほかの市町村にあっても区別できる（e-Stat の地域コードの先頭5けたと同じ）
   ・送るのは建物の位置（緯度・経度）だけ。住んでいる人の情報や訪問記録は送らない
   ・調べるのは「まだ調べていない区域」と「線を引き直した区域」だけ。特別区域は調べない
   ・年齢データの保存や区域の線の変更があると、Code.gs がこの処理を約1分後に自動で動かす
   ・うまくいかないときは、Apps Script のエディタで「azaDiag」をえらんで「実行」すると、原因が「実行ログ」に出る
   ========================================================= */
const AZA_API = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const AZA_SAMPLE = 12;
const AZA_RUN_MS = 4 * 60000;
const AZA_SAVE_EVERY = 3;
const AZA_MIN_SHARE = 0.1;

function azaKanjiNum_(k) {
  const d = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (k.indexOf('十') < 0) return String(d[k] || k);
  const p = k.split('十');
  return String((p[0] ? d[p[0]] : 1) * 10 + (p[1] ? d[p[1]] : 0));
}
/* 字の名前をそろえる（画面の azaKey と同じ決まり） */
function azaKeyGs_(s) {
  let x = String(s || '').normalize('NFKC').replace(/\s+/g, '');
  x = x.replace(/^(北海道|東京都|京都府|大阪府|[^\s\d]{2,3}県)/, '').replace(/^大字/, '').replace(/^字/, ''); // 県の頭はどの県でも取る（配布パック）
  return x.replace(/([一二三四五六七八九十]+)丁目/, function (m, k) { return azaKanjiNum_(k) + '丁目'; });
}
function azaSig_(poly) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
    JSON.stringify(poly || []), Utilities.Charset.UTF_8)).slice(0, 22);
}
function azaNeeds_(d) {
  return !!d && !d.dummy && !d.special && Array.isArray(d.polygon) && d.polygon.length >= 3 && d.azaSig !== azaSig_(d.polygon);
}
function azaNote_(msg) {
  try { props_().setProperty('AZA_LAST', new Date().toISOString() + ' ' + String(msg).slice(0, 400)); } catch (e) { /* 何もしない */ }
}

/** Code.gs から呼ばれる：調べる区域があれば、約1分後に自動で動かす */
function azaCheck_(ctx) {
  try {
    let need = false;
    ctx.col('territories').forEach(function (x) { if (azaNeeds_(x.data)) need = true; });
    if (need) azaSchedule_();
  } catch (e) { console.warn(e); azaNote_('予約できませんでした：' + (e && e.message)); }
}
function azaSchedule_() {
  const p = props_(), at = Number(p.getProperty('AZA_AT') || 0);
  const ts = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'azaLookupRun'; });
  if (ts.length && Date.now() - at < 10 * 60000) return;
  ts.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('azaLookupRun').timeBased().after(60 * 1000).create();
  p.setProperty('AZA_AT', String(Date.now()));
}

function azaLookupRun() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'azaLookupRun') ScriptApp.deleteTrigger(t); });
  props_().deleteProperty('AZA_AT');
  let r = { left: 0 };
  try { r = azaLookup_(AZA_RUN_MS); }
  catch (e) { azaNote_('とちゅうで止まりました：' + (e && e.message)); r.left = 1; }
  if (r.left && !r.netStop) azaSchedule_();
  return r;
}

/** メニューから手で動かす */
function azaLookupMenu() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(T_('区域の字を調べる', 'Buscar barrios de los territorios'),
    T_('まだ字が決まっていない区域と、線を直した区域について、国土地理院の住所検索で字を調べます。\n送るのは建物の位置（緯度・経度）だけです。数分かかります。よろしいですか？',
      'Se buscarán los barrios (aza) de los territorios nuevos o con líneas corregidas, usando el buscador del GSI.\nSolo se envía la ubicación de los edificios. Tarda unos minutos. ¿Continuar?'), ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  let r;
  try { r = azaLookup_(AZA_RUN_MS); }
  catch (e) { azaNote_('とちゅうで止まりました：' + (e && e.message)); ui.alert(String(e && e.message)); return; }
  if (r.left && !r.netStop) azaSchedule_();
  ui.alert(T_('区域の字を調べました', 'Búsqueda terminada'),
    T_('調べ終わった区域：', 'Territorios revisados: ') + r.done + T_('（決まらなかった区域：', ' (sin resultado: ') + r.fail + T_('）', ')') +
    (r.left ? T_('\n残り ' + r.left + '件は、数分後に自動で続きを調べます。', '\nLos ' + r.left + ' restantes se revisarán solos en unos minutos.') : '') +
    (r.none ? T_('\n（調べる区域はありませんでした）', '\n(No había territorios para revisar)') : ''), ui.ButtonSet.OK);
}

/** すべての区域を、もう一度調べ直す */
function azaRedoAllMenu() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(T_('すべての区域の字を調べ直す', 'Volver a buscar todos los barrios'),
    T_('すべての区域の字を、もう一度自動で調べます（手で決めた字はそのまま残ります）。よろしいですか？', 'Se volverán a buscar los barrios de todos los territorios (los elegidos a mano se conservan). ¿Continuar?'), ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const map = readCol_('territories'), ups = [];
    map.forEach(function (x, id) { if (x.data && x.data.azaSig) { const o = Object.assign({}, x.data); delete o.azaSig; ups.push([id, o]); } });
    writeCol_('territories', map, ups, [], 'aza');
  } finally { lock.releaseLock(); }
  azaSchedule_();
  ui.alert(T_('約1分後から、自動で調べ直します。', 'Se volverán a buscar en aproximadamente 1 minuto.'));
}

/** 原因をしらべる（エディタで「azaDiag」を実行。結果は実行ログ） */
function azaDiag() {
  const need = [], all = [];
  readCol_('territories').forEach(function (x) { if (x.data && !x.data.dummy && !x.data.special) { all.push(x.data); if (azaNeeds_(x.data)) need.push(x.data); } });
  console.log('区域の数：' + all.length + '　まだ調べていない区域：' + need.length);
  console.log('字が決まっている区域：' + all.filter(function (t) { return (t.aza || []).length; }).length +
    '　調べたが決まらなかった区域：' + all.filter(function (t) { return t.azaErr; }).length);
  console.log('さいごに残ったメッセージ：' + (props_().getProperty('AZA_LAST') || 'なし'));
  const t = need[0] || all[0];
  if (!t) { console.log('区域がありません'); return; }
  let la = 0, ln = 0;
  t.polygon.forEach(function (v) { la += Number(v[0]); ln += Number(v[1]); });
  la /= t.polygon.length; ln /= t.polygon.length;
  try {
    const r = UrlFetchApp.fetch(AZA_API + '?lat=' + la.toFixed(6) + '&lon=' + ln.toFixed(6), { muteHttpExceptions: true });
    console.log('区域' + t.no + 'のまん中で問い合わせた結果：番号 ' + r.getResponseCode() + '　' + r.getContentText().slice(0, 200));
  } catch (e) {
    console.log('国土地理院につながりません：' + (e && e.message));
  }
}

function azaInPoly_(lat, lng, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = Number(poly[i][0]), xi = Number(poly[i][1]), yj = Number(poly[j][0]), xj = Number(poly[j][1]);
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function azaSample_(houses, poly) {
  let pts = houses.slice().sort(function (a, b) { return a[2] < b[2] ? -1 : 1; });
  if (pts.length > AZA_SAMPLE) {
    const step = pts.length / AZA_SAMPLE, out = [];
    for (let i = 0; i < AZA_SAMPLE; i++) out.push(pts[Math.floor(i * step)]);
    pts = out;
  }
  if (pts.length < 6) {
    let s = 90, n = -90, w = 180, e = -180;
    poly.forEach(function (v) { s = Math.min(s, Number(v[0])); n = Math.max(n, Number(v[0])); w = Math.min(w, Number(v[1])); e = Math.max(e, Number(v[1])); });
    for (let a = 1; a <= 5 && pts.length < AZA_SAMPLE; a++) {
      for (let b = 1; b <= 5 && pts.length < AZA_SAMPLE; b++) {
        const la = s + (n - s) * a / 6, ln = w + (e - w) * b / 6;
        if (azaInPoly_(la, ln, poly)) pts.push([la, ln, '']);
      }
    }
  }
  return pts;
}

/** 1区域ぶんを調べる。字の印は「市町村コード:字」 */
function azaOne_(t, houses) {
  const pts = azaSample_(houses, t.polygon);
  const counts = {}, names = {};
  let valid = 0, lastErr = '';
  let res = [];
  try {
    res = UrlFetchApp.fetchAll(pts.map(function (p) {
      return { url: AZA_API + '?lat=' + p[0].toFixed(6) + '&lon=' + p[1].toFixed(6), muteHttpExceptions: true };
    }));
  } catch (e) { lastErr = 'つながりません：' + (e && e.message); }
  res.forEach(function (r) {
    const code = r.getResponseCode();
    if (code !== 200) { lastErr = '番号 ' + code + '：' + r.getContentText().slice(0, 100); return; }
    const j2 = parseJson_(r.getContentText(), null);
    const nm = j2 && j2.results && j2.results.lv01Nm;
    const muni = j2 && j2.results && j2.results.muniCd ? ('00000' + String(j2.results.muniCd).replace(/\D/g, '')).slice(-5) : '';
    if (!nm || /^[-－ー]$/.test(String(nm))) { lastErr = '字の名前が返ってきませんでした：' + r.getContentText().slice(0, 100); return; }
    const k = (muni ? muni + ':' : '') + azaKeyGs_(nm);
    counts[k] = (counts[k] || 0) + 1;
    if (!names[k]) names[k] = String(nm);
    valid++;
  });
  let list = Object.keys(counts).map(function (k) { return { k: k, n: names[k], r: counts[k] / valid }; })
    .filter(function (a) { return a.r >= AZA_MIN_SHARE; })
    .sort(function (a, b) { return b.r - a.r; });
  const sum = list.reduce(function (a, x) { return a + x.r; }, 0);
  list = list.map(function (a) { return { k: a.k, n: a.n, r: Math.round(a.r / sum * 1000) / 1000 }; });
  if (!list.length) azaNote_('区域' + t.no + '：' + (lastErr || '調べる点がありませんでした'));
  return { aza: list, azaSig: azaSig_(t.polygon), azaAt: nowIso_(), azaN: valid, azaErr: !list.length, _net: !valid && !!lastErr };
}

function azaSave_(results) {
  const ids = Object.keys(results);
  if (!ids.length) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const map = readCol_('territories'), ups = [];
    ids.forEach(function (id) {
      const cur = map.get(id), r = results[id];
      if (!cur || azaSig_(cur.data.polygon) !== r.azaSig) return;
      const o = Object.assign({}, cur.data, r);
      delete o._net;
      if (!o.azaErr) delete o.azaErr;
      ups.push([id, o]);
    });
    writeCol_('territories', map, ups, [], 'aza');
  } finally { lock.releaseLock(); }
}

function azaLookup_(limitMs) {
  const t0 = Date.now(), need = [];
  readCol_('territories').forEach(function (x) { if (azaNeeds_(x.data)) need.push(x.data); });
  if (!need.length) return { done: 0, left: 0, fail: 0, none: true };
  const want = {};
  need.forEach(function (t) { want[t.id] = []; });
  const sh = dataSheet_('houses'), last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 2, last - 1, 1).getValues().forEach(function (r) {
      const s = String(r[0] || '');
      const m = s.match(/"terrId":"([^"]+)"/);
      if (!m || !want[m[1]]) return;
      const d = parseJson_(s, null);
      if (d && isFinite(Number(d.lat)) && isFinite(Number(d.lng))) want[m[1]].push([Number(d.lat), Number(d.lng), String(d.id || '')]);
    });
  }
  let pending = {}, done = 0, fail = 0, netFail = 0;
  for (let i = 0; i < need.length; i++) {
    if (Date.now() - t0 > limitMs) break;
    const t = need[i];
    const r = azaOne_(t, want[t.id] || []);
    if (r._net) {
      netFail++;
      if (netFail >= 3) { azaSave_(pending); return { done: done, fail: fail, left: need.length - done, netStop: true }; }
      continue;
    }
    netFail = 0;
    pending[t.id] = r;
    done++;
    if (r.azaErr) fail++;
    if (Object.keys(pending).length >= AZA_SAVE_EVERY) { azaSave_(pending); pending = {}; }
    Utilities.sleep(300);
  }
  azaSave_(pending);
  if (done && !fail) azaNote_('区域 ' + done + '件の字を調べました');
  return { done: done, fail: fail, left: need.length - done };
}
