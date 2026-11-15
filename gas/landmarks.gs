/* =========================================================
   landmarks.gs  地図の目印（会館・学校・店など）のサーバー側
   Apps Script に新しいファイル「landmarks.gs」を作って、これを貼り付けてください。
   Code.gs には、doPost の中に3行（lm_pull / lm_save / lm_del の受け付け）と、設定の mapStd を足すだけです（CHANGES.md）。

   ・シート `landmarks`：id・name・kind・lat・lng・src・rev・del・by・at
   ・lm_pull：だれでも（登録ずみのスマホ）。「受け取った rev」より大きい目印だけを返す。by・at は返さない
   ・lm_save / lm_del：区域係だけ。サーバーの側でも、名前・種類・場所・出典を確かめる（スマホの検査は信用しない）
   ・書きこむたびに rev を1つずつ増やす。いちばん大きい rev は、スクリプトのプロパティ LM_REV にも覚える（速くするため）
   ・取りこみ（CSV）と消したことは、「operations」シート（設定の変更の記録）に1行ずつ残す
   ・名前・種類・場所が同じ目印がもうあるときは、新しく作らない（返事が届かずに押し直したとき・同じ一覧を取りこみ直したとき。返事の same に件数）
   ・会館の最初の1件：区域係のスマホが config.js の hall を送ってきて、会館が1件もないときだけ、1回入れる（LM_HALL_DONE）
   ・backup.gs は、スプレッドシートを丸ごとコピーするので、landmarks も入ります（変更なし）
   ========================================================= */
const LM_SHEET = 'landmarks';
const LM_HEAD = ['id', 'name', 'kind', 'lat', 'lng', 'src', 'rev', 'del', 'by', 'at'];
const LM_KIND_IDS = ['kaikan', 'school', 'kominkan', 'shop', 'park', 'yakusho', 'bus', 'other'];
const LM_SAVE_MAX = 300;

function lmSheet_() {
  let sh = book_().getSheetByName(LM_SHEET);
  if (!sh) {
    sh = book_().insertSheet(LM_SHEET);
    sh.getRange(1, 1, 1, LM_HEAD.length).setValues([LM_HEAD]);
    sh.setFrozenRows(1);
    sh.getRange('A:C').setNumberFormat('@');
    sh.getRange('F:F').setNumberFormat('@');
    sh.getRange('I:J').setNumberFormat('@');
    // 新しいシートは26列×1000行あるので、使う分だけに縮める（セルの上限に近づけないため）
    if (sh.getMaxColumns() > LM_HEAD.length) sh.deleteColumns(LM_HEAD.length + 1, sh.getMaxColumns() - LM_HEAD.length);
    if (sh.getMaxRows() > 1200) sh.deleteRows(1201, sh.getMaxRows() - 1200);
  }
  return sh;
}
/** 全部の行を読む（多くても1,000件ほど） */
function lmRows_() {
  const sh = lmSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, LM_HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, id: String(r[0]), name: String(r[1]), kind: String(r[2]), lat: Number(r[3]), lng: Number(r[4]),
      src: String(r[5] || ''), rev: Number(r[6]) || 0, del: Number(r[7]) === 1, by: String(r[8] || ''), at: String(r[9] || '') };
  }).filter(function (x) { return x.id; });
}
function lmRev_(rows) {
  let rev = Number(props_().getProperty('LM_REV') || 0);
  (rows || []).forEach(function (x) { if (x.rev > rev) rev = x.rev; });
  return rev;
}
function lmRowValues_(x) { return [x.id, x.name, x.kind, x.lat, x.lng, x.src, x.rev, x.del ? 1 : 0, x.by, x.at]; }

/* ---- 検査（スマホと同じ決まり） ---- */
function lmClean_(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim(); }
/** < > " ' を含む／先頭が = + - @ の文字は受けつけない（全角の形もそろえて確かめる） */
function lmTextBad_(t) {
  const n = t.normalize('NFKC');
  return /[<>"']/.test(t) || /[<>"']/.test(n) || /^[=+\-@]/.test(t) || /^[=+\-@]/.test(n);
}
/** 全区域を囲む四角＋2km：[南, 西, 北, 東]。区域がなければ null */
function lmBounds_() {
  let s = 90, n = -90, w = 180, e = -180, any = false;
  readCol_('territories').forEach(function (x) {
    (Array.isArray(x.data.polygon) ? x.data.polygon : []).forEach(function (v) {
      const la = Number(v[0]), ln = Number(v[1]);
      if (!isFinite(la) || !isFinite(ln)) return;
      any = true; s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln);
    });
  });
  if (!any) return null;
  const dLa = 2000 / 110540, dLn = 2000 / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return [s - dLa, w - dLn, n + dLa, e + dLn];
}
/** 1件を確かめる。ok のとき v に、きれいにした中身を入れて返す */
function lmValidate_(it, bounds) {
  if (!it || typeof it !== 'object') return { ok: false, why: '形がちがいます' };
  const name = lmClean_(it.name), nl = Array.from(name).length;
  if (nl < 1 || nl > 20) return { ok: false, why: '名前は1〜20文字です' };
  if (lmTextBad_(name)) return { ok: false, why: '名前に使えない文字があります' };
  const kind = String(it.kind || '');
  if (LM_KIND_IDS.indexOf(kind) < 0) return { ok: false, why: '種類が8つのどれでもありません' };
  const src = lmClean_(it.src);
  if (Array.from(src).length > 40 || (src && lmTextBad_(src))) return { ok: false, why: '出典に使えない文字があります' };
  const lat = Number(it.lat), lng = Number(it.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, why: '場所が読めません' };
  if (bounds && (lat < bounds[0] || lat > bounds[2] || lng < bounds[1] || lng > bounds[3])) return { ok: false, why: '場所が区域のまわりの外です' };
  return { ok: true, v: { name: name, kind: kind, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, src: src } };
}
const lmPublic_ = function (x) { return x.del ? { id: x.id, rev: x.rev, del: 1 } : { id: x.id, name: x.name, kind: x.kind, lat: x.lat, lng: x.lng, src: x.src, rev: x.rev }; };

/** 係の操作の記録（operations シート。by・at と同じく、伝道者には配らない） */
function lmOpsLog_(user, what, to) {
  try {
    const sh = opsSheet_(), first = Math.max(2, sh.getLastRow() + 1);
    if (first + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    sh.getRange(first, 1, 1, 5).setValues([[Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), user.name, what, '', to]]);
  } catch (e) { console.warn('目印の記録を残せませんでした：' + e); }
}

function lmApi_(user, req) {
  try {
    if (req.action === 'lm_pull') return lmPull_(user, req);
    if (user.role !== 'admin') return { ok: false, error: 'admin' };       // 伝道者が lm_save / lm_del を送っても受けつけない
    if (req.action === 'lm_save') return lmSave_(user, req);
    if (req.action === 'lm_del') return lmDel_(user, req);
    return { ok: false, error: 'unknown_action' };
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, error: 'server' };
  }
}

function lmPull_(user, req) {
  const p = props_(), since = Math.max(0, Math.floor(Number(req.since) || 0));
  // 会館の最初の1件（区域係のスマホが、config.js の hall を送ってきたときだけ。会館が1件もなく、まだ入れていないとき）
  const h = req.hall;
  if (user.role === 'admin' && Array.isArray(h) && h.length === 2 && !p.getProperty('LM_HALL_DONE')) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(15000)) {
      try {
        if (!p.getProperty('LM_HALL_DONE')) {
          const rows = lmRows_();
          if (!rows.some(function (x) { return x.kind === 'kaikan' && !x.del; })) {
            const chk = lmValidate_({ name: '会館', kind: 'kaikan', lat: h[0], lng: h[1], src: '' }, lmBounds_());
            if (chk.ok) {
              let rev = lmRev_(rows);
              const x = Object.assign({ id: 'l' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), rev: ++rev, del: false, by: user.id, at: new Date().toISOString() }, chk.v);
              const sh = lmSheet_(), at = sh.getLastRow() + 1;
              if (at > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
              sh.getRange(at, 1, 1, LM_HEAD.length).setValues([lmRowValues_(x)]);
              p.setProperty('LM_REV', String(rev));
              p.setProperty('LM_HALL_DONE', '1');
            }
          } else p.setProperty('LM_HALL_DONE', '1');
        }
      } finally { lock.releaseLock(); }
    }
  }
  const cur = Number(p.getProperty('LM_REV') || 0);
  if (since >= cur) return { ok: true, rev: cur, items: [] };               // 変わっていない（シートを読まない）。since が大きすぎるときは、スマホが作り直す
  const rows = lmRows_(), rev = lmRev_(rows);
  const items = rows.filter(function (x) { return x.rev > since && !(since === 0 && x.del); }).map(lmPublic_);   // by・at は入れない
  return { ok: true, rev: rev, items: items };
}

function lmSave_(user, req) {
  const list = Array.isArray(req.items) ? req.items.slice(0, LM_SAVE_MAX) : [];
  if (!list.length) return { ok: false, error: 'bad_request' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
  try {
    const rows = lmRows_(), byId = {}, bySame = {};
    // 同じ目印（名前・種類・場所が同じ）：返事が届かずに押し直したとき・同じ一覧をもう一度取りこんだときに、2つにしない（点検②V11）
    const sameKey = function (x) { return x.kind + '|' + x.name + '|' + Number(x.lat).toFixed(6) + '|' + Number(x.lng).toFixed(6); };
    rows.forEach(function (x) { byId[x.id] = x; if (!x.del) bySame[sameKey(x)] = x; });
    let rev = lmRev_(rows);
    const bounds = lmBounds_(), now = new Date().toISOString();
    const saved = [], rejected = [], adds = [];
    let same = 0;
    list.forEach(function (it, i) {
      const chk = lmValidate_(it, bounds);
      if (!chk.ok) { rejected.push({ i: i, why: chk.why }); return; }
      const id = lmClean_(it.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      const cur = id ? byId[id] : null;
      if (!cur) {
        const dup = bySame[sameKey(chk.v)];
        if (dup) { same++; saved.push(lmPublic_(dup)); return; } // もうある：新しく作らない（今の内容を返す）
      }
      const x = Object.assign({ id: cur ? cur.id : 'l' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), rev: ++rev, del: false, by: user.id, at: now }, chk.v);
      if (cur) { x.row = cur.row; byId[x.id] = x; sheetUpdate_(x); } else { adds.push(x); byId[x.id] = x; }
      bySame[sameKey(x)] = x;
      saved.push(lmPublic_(x));
    });
    if (adds.length) {
      const sh = lmSheet_(), at = sh.getLastRow() + 1;
      if (at + adds.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), adds.length + 100);
      sh.getRange(at, 1, adds.length, LM_HEAD.length).setValues(adds.map(lmRowValues_));
    }
    props_().setProperty('LM_REV', String(rev));
    if (req['import'] && saved.length > same) {
      const srcs = []; list.forEach(function (it) { const s = lmClean_(it && it.src); if (s && srcs.indexOf(s) < 0) srcs.push(s); });
      lmOpsLog_(user, '地図の目印', (saved.length - same) + '件を取りこみ（出典：' + srcs.slice(0, 3).join('・') + '）' + (same ? '・同じ目印がもうあった ' + same + '件は足さない' : ''));
    }
    return { ok: true, rev: rev, items: saved, rejected: rejected, same: same };
  } finally { lock.releaseLock(); }
}
function sheetUpdate_(x) { lmSheet_().getRange(x.row, 1, 1, LM_HEAD.length).setValues([lmRowValues_(x)]); }

function lmDel_(user, req) {
  const id = lmClean_(req.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!id) return { ok: false, error: 'bad_request' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
  try {
    const rows = lmRows_(), cur = rows.filter(function (x) { return x.id === id; })[0];
    if (!cur) return { ok: false, error: 'not_found' };
    const rev = lmRev_(rows) + 1;
    const x = Object.assign({}, cur, { rev: rev, del: true, by: user.id, at: new Date().toISOString() });
    sheetUpdate_(x);
    props_().setProperty('LM_REV', String(rev));
    lmOpsLog_(user, '地図の目印', '1件を消しました（' + cur.name + '）');
    return { ok: true, rev: rev };
  } finally { lock.releaseLock(); }
}
