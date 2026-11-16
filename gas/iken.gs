/* =========================================================
   iken.gs  こまったこと・提案のサーバー側
   Apps Script に新しいファイル「iken.gs」を作って、これを貼り付けてください（gas フォルダは自動で反映）。
   Code.gs には、doPost の中の受け付け（iken_ で始まるもの）と、設定の ikenOn・ikenWho を足しています。

   ・シート `iken`：id・at・kind・text・role・uid・who・scr・ver・mode・dev・net・err・lang・status・doneAt
   ・送った人（uid・送った時点の名前 who・役割）を残す。係の画面で、だれが何を送ったかが分かる（変更。はじめは名前なしの予定だった）
     招待コード・端末の情報は残さない。一覧（iken_list）は区域係だけ
   ・iken_send：設定 ikenOn が 1 のときだけ。ikenWho が 1 なら、グループ監督・司会者・区域係だけ
     - 同じ cid（画面が作る送信の番号）は1回だけ入れる（返事が届かずに送り直したとき）
     - 1人が送れるのは6時間に IKEN_MAX 件まで（数えるのは一時保存の中だけ。シートには残さない）
     - 本文は1〜500文字。画面の情報は、決まった形のものだけ受け取る（ほかは捨てる）
     - 先頭が = + - @ の文字は、シートで式として動かないよう、先頭に ' を付けて文字として入れる
   ・iken_list / iken_mark：区域係だけ。一覧は新しい順に最大 500件。状態は new・doing・done・skip
   ・写真（iken_photo）：送った本人だけが、自分の声に1枚ずつ足せる（最大 IKEN_PHOTO_MAX 枚・JPEG・1枚 450KB まで）。
     持ち主のマイドライブの直下の「区域マップ_こまったこと・提案の写真」に置く（共有しない）。一覧には枚数だけ返し、
     見るのは区域係だけ（iken_photo_get）。声を消すときに写真もゴミ箱へ入れる
   ・IKEN_KEEP_DAYS より古いもの・IKEN_ROWS_MAX をこえた古い分は、毎月の整理（cleanupOld）と、一覧を開いたときに消す
   ========================================================= */
const IKEN_SHEET = 'iken';
const IKEN_HEAD = ['id', 'at', 'kind', 'text', 'role', 'uid', 'who', 'scr', 'ver', 'mode', 'dev', 'net', 'err', 'lang', 'status', 'doneAt', 'pn', 'photos'];
const IKEN_KINDS = ['komatta', 'wakaran', 'teian', 'sonota'];
const IKEN_STATUS = ['new', 'doing', 'done', 'skip'];
const IKEN_MAX = 5;            // 1人が送れる件数（6時間ごとの区切りの中で）
const IKEN_TEXT_MAX = 500;
const IKEN_KEEP_DAYS = 365;
const IKEN_ROWS_MAX = 3000;    // シートが大きくなりすぎないように（古いものから消す）
const IKEN_PHOTO_MAX = 10;     // 1件に付けられる写真の数
const IKEN_PHOTO_BYTES = 450000; // 写真1枚の大きさの上限（base64 で約60万文字。受け付けの上限 80万文字に収まるように。画面で 1,280px・JPEG に縮め、400KB をこえれば画質を下げる）
const IKEN_DIR_PROP = 'IKEN_PHOTO_DIR', IKEN_DIR_NAME = '区域マップ_こまったこと・提案の写真';

function ikenSheet_() {
  let sh = book_().getSheetByName(IKEN_SHEET);
  if (!sh) {
    sh = book_().insertSheet(IKEN_SHEET);
    sh.getRange(1, 1, 1, IKEN_HEAD.length).setValues([IKEN_HEAD]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), IKEN_HEAD.length).setNumberFormat('@');
    if (sh.getMaxColumns() > IKEN_HEAD.length) sh.deleteColumns(IKEN_HEAD.length + 1, sh.getMaxColumns() - IKEN_HEAD.length);
  } else if (sh.getMaxColumns() < IKEN_HEAD.length) {
    // 前の版（16列・写真なし）で作ったシート：右に列を足し、見出しを今の形にする（監査 写真 H-1）
    const n0 = sh.getMaxColumns();
    sh.insertColumnsAfter(n0, IKEN_HEAD.length - n0);
    sh.getRange(1, 1, sh.getMaxRows(), IKEN_HEAD.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, IKEN_HEAD.length).setValues([IKEN_HEAD]);
  }
  return sh;
}
function ikenRows_() {
  const sh = ikenSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, IKEN_HEAD.length).getValues().map(function (r, i) {
    const o = { row: i + 2 };
    IKEN_HEAD.forEach(function (h, j) { o[h] = String(r[j] == null ? '' : r[j]); });
    return o;
  }).filter(function (x) { return x.id; });
}

/* ---- 検査 ---- */
/** 改行とタブ以外の制御文字を外し、前後の空白を取る */
function ikenText_(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
}
/** シートで式として動かないように */
function ikenCell_(t) { return /^[=+\-@]/.test(String(t).normalize('NFKC')) ? "'" + t : t; }
function ikenPick_(v, re, max) { const s = String(v == null ? '' : v).slice(0, max); return re.test(s) ? s : ''; }
function ikenRole_(user) {
  if (user.role === 'admin') return '係';
  if (user.overseer) return '監督';
  if (user.leader) return '司会者';
  return '伝道者';
}
function ikenAllowed_(user, s) {
  if (Number(s.ikenOn) !== 1) return false;
  if (Number(s.ikenWho) === 0) return true;
  return user.role === 'admin' || !!user.overseer || !!user.leader;
}

function ikenApi_(user, req) {
  const a = String(req.action || '');
  if (a === 'iken_send') return ikenSend_(user, req);
  if (a === 'iken_photo') return ikenPhoto_(user, req);
  if (a === 'iken_list' || a === 'iken_mark' || a === 'iken_photo_get') {
    if (user.role !== 'admin') return { ok: false, error: 'admin' };
    return a === 'iken_list' ? ikenList_() : a === 'iken_mark' ? ikenMark_(req) : ikenPhotoGet_(req);
  }
  return { ok: false, error: 'unknown_action' };
}

function ikenSend_(user, req) {
  if (!ikenAllowed_(user, getSettings_())) return { ok: false, error: 'off' };
  const cid = ikenPick_(req.cid, /^[A-Za-z0-9_-]{8,40}$/, 40);
  const kind = IKEN_KINDS.indexOf(String(req.kind)) >= 0 ? String(req.kind) : '';
  const text = ikenText_(req.text, IKEN_TEXT_MAX);
  if (!cid || !kind || !text) return { ok: false, error: 'bad_request' };
  const c = req.ctx && typeof req.ctx === 'object' ? req.ctx : {};
  const row = {
    id: cid, at: nowIso_(), kind: kind, text: ikenCell_(text), role: ikenRole_(user),
    uid: String(user.id), who: ikenCell_(String(user.name || '').slice(0, 40)),
    scr: ikenPick_(c.scr, /^[a-z0-9_-]{0,30}$/, 30),
    ver: ikenPick_(c.ver, /^[0-9.]{0,20}$/, 20),
    mode: ['kantan', 'kuwashii'].indexOf(String(c.mode)) >= 0 ? String(c.mode) : '',
    dev: ['iphone', 'ipad', 'android', 'pc', 'other'].indexOf(String(c.dev)) >= 0 ? String(c.dev) : '',
    net: ['on', 'off'].indexOf(String(c.net)) >= 0 ? String(c.net) : '',
    err: ikenCell_(ikenText_(c.err, 200).replace(/\n/g, ' ')),
    lang: ['ja', 'es'].indexOf(String(c.lang)) >= 0 ? String(c.lang) : '',
    status: 'new', doneAt: '',
    pn: String(Math.max(0, Math.min(IKEN_PHOTO_MAX, Math.floor(Number(req.pn) || 0)))), photos: ''
  };
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'busy' };
  try {
    // 同じ送信の送り直し：もう入っていれば、入れたことにする
    if (cache.get('ikc_' + cid) || ikenRows_().some(function (x) { return x.id === cid; })) return { ok: true, same: 1 };
    const rk = 'ikr_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(user.id))).slice(0, 16)
      + '_' + Math.floor(Date.now() / 21600000);
    const n = Number(cache.get(rk) || 0);
    if (n >= IKEN_MAX) return { ok: false, error: 'many' };
    const sh = ikenSheet_();
    const at = sh.getLastRow() + 1;
    if (at > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100); // 新しいシートは1,000行なので、足りなくなったら足す（監査 H-1）
    sh.getRange(at, 1, 1, IKEN_HEAD.length).setNumberFormat('@')
      .setValues([IKEN_HEAD.map(function (h) { return row[h]; })]);
    cache.put(rk, String(n + 1), 21600);
    cache.put('ikc_' + cid, '1', 21600);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/** 1年より古いもの・3,000件をこえた古い分を消す（ロックは呼ぶ側が持つ）。連続する行はまとめて消す。消した件数を返す */
function ikenPrune_() {
  if (!book_().getSheetByName(IKEN_SHEET)) return 0; // 使っていないときは、シートを作らない（再監査 N-1）
  const rows = ikenRows_();
  if (!rows.length) return 0;
  const lim = new Date(Date.now() - IKEN_KEEP_DAYS * 86400000).toISOString();
  const keep = rows.filter(function (x) { return x.at >= lim; }).sort(function (p, q) { return p.at < q.at ? -1 : 1; });
  const over = Math.max(0, keep.length - IKEN_ROWS_MAX);
  const drop = {};
  rows.forEach(function (x) { if (x.at < lim) drop[x.row] = 1; });
  keep.slice(0, over).forEach(function (x) { drop[x.row] = 1; });
  const rs = Object.keys(drop).map(Number).sort(function (p, q) { return q - p; });
  if (!rs.length) return 0;
  const gone = rows.filter(function (x) { return drop[x.row]; }); // 写真は、行を消し終えてからゴミ箱へ（監査 写真 L-4）
  const sh = ikenSheet_();
  // 全部消すときは、行を消さずに中身だけ消す（固定していない行を全部消すと、シートの例外になるため・再監査 N-2）
  if (rs.length === rows.length) { sh.getRange(2, 1, sh.getLastRow() - 1, IKEN_HEAD.length).clearContent(); gone.forEach(ikenTrashPhotos_); return rs.length; }
  // 下から、つながった行のかたまりごとに消す（上の行番号がずれない）
  let i = 0;
  while (i < rs.length) {
    let j = i;
    while (j + 1 < rs.length && rs[j + 1] === rs[j] - 1) j++;
    sh.deleteRows(rs[j], i === j ? 1 : rs[i] - rs[j] + 1);
    i = j + 1;
  }
  gone.forEach(ikenTrashPhotos_);
  return rs.length;
}

function ikenList_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'busy' };
  let rows;
  try {
    ikenPrune_(); // ふだんは毎月の整理（cleanupOld）で消す。係が開いたときにも念のため
    rows = ikenRows_();
  } finally { lock.releaseLock(); }
  rows.sort(function (p, q) { return p.at < q.at ? 1 : -1; });
  return { ok: true, items: rows.slice(0, 500).map(function (x) {
    const o = Object.assign({}, x); delete o.row;
    o.pc = ikenPhotoIds_(x).filter(Boolean).length; delete o.photos; // 写真は数だけ返す（ドライブの id は画面に出さない）
    return o;
  }), total: rows.length };
}

function ikenMark_(req) {
  const st = IKEN_STATUS.indexOf(String(req.status)) >= 0 ? String(req.status) : '';
  const ids = (Array.isArray(req.ids) ? req.ids : []).slice(0, 100).map(function (x) { return String(x); });
  if (!st || !ids.length) return { ok: false, error: 'bad_request' };
  const want = {};
  ids.forEach(function (x) { want[x] = 1; });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'busy' };
  try {
    const sh = ikenSheet_();
    const col = IKEN_HEAD.indexOf('status') + 1;
    let n = 0;
    ikenRows_().forEach(function (x) {
      if (!want[x.id] || x.status === st) return;
      sh.getRange(x.row, col, 1, 2).setValues([[st, st === 'done' || st === 'skip' ? nowIso_() : '']]);
      n++;
    });
    return { ok: true, n: n };
  } finally { lock.releaseLock(); }
}

/* ---- 写真（1枚ずつ送る。iken_send のあとに、同じ cid で） ---- */
function ikenPhotoIds_(x) { return String(x && x.photos || '').split(',').map(function (v) { return v.trim(); }); }
function ikenDir_() {
  const id = props_().getProperty(IKEN_DIR_PROP);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* 作り直す */ } }
  // スプレッドシートのフォルダの中に作ると、そのフォルダの共有を受け継ぐので、持ち主のマイドライブの直下に作る（監査 写真 M-3）
  const f = DriveApp.getRootFolder().createFolder(IKEN_DIR_NAME);
  props_().setProperty(IKEN_DIR_PROP, f.getId());
  return f;
}
function ikenTrashPhotos_(x) {
  ikenPhotoIds_(x).forEach(function (id) { if (!id) return; try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* もうない */ } });
}
/** 送った本人だけが、その声に写真を足せる。i は 0〜pn-1。同じ i の送り直しは入れ直さない。
    ドライブへの保存は時間がかかるので、ロックの外でする。ロックの中では id を書くだけ（監査 写真 M-1） */
function ikenPhoto_(user, req) {
  const cid = ikenPick_(req.cid, /^[A-Za-z0-9_-]{8,40}$/, 40);
  const i = Math.floor(Number(req.i));
  const data = String(req.data || '');
  if (!cid || !(i >= 0 && i < IKEN_PHOTO_MAX) || !/^\/9j\/[A-Za-z0-9+/=]+$/.test(data)) return { ok: false, error: 'bad_request' }; // JPEG（/9j/ ではじまる base64）だけ
  if (data.length > Math.ceil(IKEN_PHOTO_BYTES * 4 / 3) + 4) return { ok: false, error: 'big' };
  const check = function () {
    const x = ikenRows_().filter(function (r) { return r.id === cid; })[0];
    if (!x || x.uid !== String(user.id)) return { err: 'not_allowed' };
    if (i >= (Number(x.pn) || 0)) return { err: 'bad_request' };
    return { x: x, ids: ikenPhotoIds_(x) };
  };
  const c0 = check();
  if (c0.err) return { ok: false, error: c0.err };
  if (c0.ids[i]) return { ok: true, same: 1 };
  let bytes;
  try { bytes = Utilities.base64Decode(data); } catch (e) { return { ok: false, error: 'bad_request' }; } // 監査 写真 L-2
  if (bytes.length > IKEN_PHOTO_BYTES) return { ok: false, error: 'big' };
  const f = ikenDir_().createFile(Utilities.newBlob(bytes, 'image/jpeg', cid + '_' + (i + 1) + '.jpg'));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { try { f.setTrashed(true); } catch (e) { /* */ } return { ok: false, error: 'busy' }; }
  try {
    const c1 = check(); // ロックの中でもう一度（同じ写真を同時に送ったとき・行が動いたとき）
    if (c1.err || c1.ids[i]) { try { f.setTrashed(true); } catch (e) { /* */ } return c1.err ? { ok: false, error: c1.err } : { ok: true, same: 1 }; }
    const pn = Number(c1.x.pn) || 0, ids = c1.ids;
    while (ids.length < pn) ids.push('');
    ids[i] = f.getId();
    try { ikenSheet_().getRange(c1.x.row, IKEN_HEAD.indexOf('photos') + 1).setValue(ids.slice(0, pn).join(',')); }
    catch (e) { try { f.setTrashed(true); } catch (e2) { /* */ } throw e; } // 書けなかったら、つながらない写真を残さない（再監査 P-2）
    return { ok: true };
  } finally { lock.releaseLock(); }
}
/** 区域係：写真を1枚ずつ見る（base64） */
function ikenPhotoGet_(req) {
  const id = String(req.id || ''), i = Math.floor(Number(req.i));
  const x = ikenRows_().filter(function (r) { return r.id === id; })[0];
  if (!x) return { ok: false, error: 'not_found' };
  const fid = ikenPhotoIds_(x)[i];
  if (!fid) return { ok: false, error: 'not_found' };
  try { return { ok: true, data: Utilities.base64Encode(DriveApp.getFileById(fid).getBlob().getBytes()) }; }
  catch (e) { return { ok: false, error: 'not_found' }; }
}
