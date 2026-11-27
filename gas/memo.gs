/**
 * 再訪問メモの同期（memo.gs）【2026.11.09】
 *
 * 同じ人のスマホとiPadなど、複数の端末で、再訪問のメモ・次の約束・📌を同じにするための処理です。
 *
 * ・メモは各自の端末の中で暗号化（AES-GCM）してから届きます。このサーバーでは中身を読みません（読むための処理もありません）。
 * ・鍵は利用者ごとに1つ。スクリプトのプロパティ（MKEY_利用者id）に置き、その人の承認済みの端末にだけ渡します。
 *   シート「memos」には、読めない文字列だけが入ります。
 *   ※スクリプトの編集権限がある人（オーナー）は、しくみの上では鍵にも触れられます。編集権限は最小限にしてください。
 * ・シート「memos」：利用者id / 家（家id|部屋） / 暗号文 / 版 / 更新（ミリ秒） / 削除
 * ・受け持ち（follows）が本人のものでなくなった家のメモは、10分の猶予のあとで消します。
 * ・端末で消したメモは「削除」の印を30日残し、ほかの端末にも消したことを伝えます。
 * ・利用者を「使えなくする」と、その人の鍵とメモを消します。鍵が消えると、どこかに残っていても読めません。
 * ・区域係の設定「再訪問のメモを、ほかの端末でも使う」を「使わない」にすると、全員の鍵とメモを消します。
 * ・毎月の整理（cleanupOld）で、使っていない人の鍵・受け持ちが終わった家のメモ・古い削除の印を消します。
 */
const MEMOS = 'memos';
const MEMO_HEAD = ['利用者id', '家', '暗号文', '版', '更新', '削除'];
const MEMO_GRACE_MS = 10 * 60000;   // 受け持ちが本人のものでなくなってから、メモを消すまでの猶予（受け持ちより先にメモが届くことがあるため）
const MEMO_TOMB_MS = 30 * DAY_MS;   // 「消した」印を残す期間
const MEMO_MAX_PER_USER = 1000;     // 1人が保管できる家の数
const MEMO_DATA_MAX = 20000;        // 1件の暗号文の長さの上限
const MEMO_DATA_RE = /^v1\.[A-Za-z0-9+\/=]{16}\.[A-Za-z0-9+\/=]{24,}$/; // 端末が作る暗号文の形（v1.iv.本文）
const MEMO_KEY_PREFIX = 'MKEY_';

function memoSheet_() {
  let sh = book_().getSheetByName(MEMOS);
  if (!sh) {
    sh = book_().insertSheet(MEMOS);
    sh.getRange(1, 1, 1, MEMO_HEAD.length).setValues([MEMO_HEAD]);
    sh.setFrozenRows(1);
    sh.getRange('A:C').setNumberFormat('@');
    sh.setColumnWidth(3, 240);
  }
  return sh;
}
function memoOn_() { return Number(getSettings_().memoSync) !== 0; }
/* 「この人のメモが変わった」合図（端末は、ふだんの問い合わせの返事でこれを見て、変わったときだけ取りに来る） */
function memoVer_(uid) { try { return CacheService.getScriptCache().get('mv_' + uid) || ''; } catch (e) { return ''; } }
function memoTouch_(uid, t) { try { CacheService.getScriptCache().put('mv_' + uid, String(t), 21600); } catch (e) { /* 合図がなくても、端末は30分ごとに確かめる */ } }
function memoKid_(key) { return hash_('mk:' + key).slice(0, 10); } // 鍵そのものは出さずに、鍵が同じかを見分ける印
function memoDelRows_(sh, rows) {
  try { deleteRowsFast_(sh, rows); return; } // まとめて消す（1行ずつだと、多いときに遅い）
  catch (e) { console.warn('まとめて消せませんでした（1行ずつ消します）：' + e); }
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (r) {
    if (r > sh.getLastRow()) return;
    try { sh.deleteRow(r); } catch (e) { sh.getRange(r, 1, 1, MEMO_HEAD.length).clearContent(); } // 行を消せないシートでは中身だけ消す
  });
}
function memoOwners_() {
  const owner = {};
  readCol_('follows').forEach(function (x, id) { owner[id] = x.data && x.data.by; });
  return owner;
}

/** 受け付け：memo_key（鍵をもらう）・memo_sync（送る・受け取る） */
function memoApi_(user, req) {
  if (!memoOn_()) return { ok: false, error: 'memo_off' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    if (req.action === 'memo_key') {
      let key = props_().getProperty(MEMO_KEY_PREFIX + user.id);
      if (!/^[0-9a-f]{64}$/.test(String(key || ''))) {
        key = newToken_(); // 64けたの16進（32バイト）
        props_().setProperty(MEMO_KEY_PREFIX + user.id, key);
      }
      return { ok: true, key: key, kid: memoKid_(key) };
    }
    return memoSync_(user, req);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 送られてきた変更（items）を受け付け、since より後に変わった本人のメモを返す。
 * items：[{ k: 家, base: 端末が知っている版, d: 暗号文 }] または [{ k, base, del: 1 }]
 * ・base がサーバーの版とちがうとき（ほかの端末が先に書いた）は受け付けず、conflicts で知らせて今の内容を返す（端末が合わせて送り直す）
 * ・ほかの人が受け持っている家は受け付けず、gone で知らせる
 */
function memoSync_(user, req) {
  const uid = user.id, now = Date.now();
  const key = props_().getProperty(MEMO_KEY_PREFIX + uid);
  if (!key) return { ok: true, rows: [], now: now, kid: '', conflicts: [], gone: [], mv: memoVer_(uid) };
  const sh = memoSheet_(), last = sh.getLastRow();
  const vals = last >= 2 ? sh.getRange(2, 1, last - 1, MEMO_HEAD.length).getValues() : [];
  const mine = new Map();
  vals.forEach(function (r, i) {
    if (String(r[0]) !== uid || r[1] === '') return;
    mine.set(String(r[1]), { row: i + 2, data: String(r[2] || ''), v: Number(r[3]) || 0, at: Number(r[4]) || 0, del: String(r[5]) === '1' });
  });
  const owner = memoOwners_();
  const conflicts = [], gone = [], wrote = {};
  let count = 0;
  mine.forEach(function (x) { if (!x.del) count++; });

  (Array.isArray(req.items) ? req.items : []).slice(0, 300).forEach(function (it) {
    const k = str_(it && it.k, 80);
    if (!k || k.indexOf('|') < 0 || wrote[k]) return;
    if (owner[k] && owner[k] !== uid) { gone.push(k); return; } // ほかの人が受け持っている家
    const cur = mine.get(k), base = Number(it.base) || 0;
    if (cur && cur.v !== base) { conflicts.push(k); return; }
    if (it.del) {
      if (!cur || cur.del) { gone.push(k); return; } // もう無い
      cur.data = ''; cur.v += 1; cur.at = now; cur.del = true; cur.dirty = true; count--;
    } else {
      const d = String(it.d || '');
      if (d.length > MEMO_DATA_MAX || !MEMO_DATA_RE.test(d)) return;
      if (cur) {
        if (cur.del) count++;
        cur.data = d; cur.v += 1; cur.at = now; cur.del = false; cur.dirty = true;
      } else {
        if (count >= MEMO_MAX_PER_USER) return;
        mine.set(k, { row: 0, data: d, v: 1, at: now, del: false, dirty: true });
        count++;
      }
    }
    wrote[k] = true;
  });

  // 受け持ちが終わった家のメモ（猶予のあと）と、古い「消した」印を消す
  const dels = [];
  mine.forEach(function (x, k) {
    if (x.dirty) return;
    const orphan = owner[k] !== uid && now - x.at > MEMO_GRACE_MS;
    const oldTomb = x.del && now - x.at > MEMO_TOMB_MS;
    if (orphan || oldTomb) { if (x.row) dels.push(x.row); mine.delete(k); }
  });

  // 書く（行の番号がずれないように、書きかえ → 足す → 消す の順）
  const appends = [], put = [];
  let changed = false;
  mine.forEach(function (x, k) {
    if (!x.dirty) return;
    changed = true;
    const row = [uid, k, x.data, x.v, x.at, x.del ? 1 : ''];
    if (x.row) put.push([x.row, row]);
    else appends.push(row);
  });
  writeRowsAt_(sh, put, MEMO_HEAD.length); // 多いときはまとめて1回で書く
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, MEMO_HEAD.length).setValues(appends);
  if (dels.length) memoDelRows_(sh, dels);
  if (changed) memoTouch_(uid, now);

  // 返す：今回書いたもの・ぶつかったもの・since より後に変わった本人の受け持ちのメモ
  const since = Number(req.since) || 0, cset = {};
  conflicts.forEach(function (k) { cset[k] = true; });
  const rows = [];
  mine.forEach(function (x, k) {
    if (!(wrote[k] || cset[k] || (x.at > since && owner[k] === uid))) return;
    rows.push([k, x.v, x.at, x.del ? 1 : 0, x.del ? '' : x.data]);
  });
  return { ok: true, rows: rows, now: now, kid: memoKid_(key), conflicts: conflicts, gone: gone, mv: memoVer_(uid) };
}

/** その人の鍵とメモを消す（使えなくしたとき） */
function memoWipeUser_(uid) {
  if (!uid) return;
  props_().deleteProperty(MEMO_KEY_PREFIX + uid);
  try { CacheService.getScriptCache().remove('mv_' + uid); } catch (e) { /* 何もしない */ }
  const sh = book_().getSheetByName(MEMOS);
  if (!sh || sh.getLastRow() < 2) return;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  const rows = [];
  ids.forEach(function (r, i) { if (String(r[0]) === uid) rows.push(i + 2); });
  if (rows.length) memoDelRows_(sh, rows);
}

/** 全員の鍵とメモを消す（区域係が「使わない」にしたとき） */
function memoWipeAll_() {
  const p = props_();
  p.getKeys().forEach(function (k) { if (k.indexOf(MEMO_KEY_PREFIX) === 0) p.deleteProperty(k); });
  const sh = book_().getSheetByName(MEMOS);
  if (!sh) return;
  const n = sh.getLastRow();
  if (n < 2) return;
  if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
  try { sh.deleteRows(2, n - 1); } catch (e) { sh.getRange(2, 1, n - 1, MEMO_HEAD.length).clearContent(); }
}

/** 毎月の整理（cleanupOld から呼ぶ。スクリプトのロックの中で動く） */
function memoCleanup_() {
  const active = {};
  usersAll_().forEach(function (u) { if (u.active) active[u.id] = true; });
  const p = props_();
  let keys = 0;
  p.getKeys().forEach(function (k) {
    if (k.indexOf(MEMO_KEY_PREFIX) === 0 && !active[k.slice(MEMO_KEY_PREFIX.length)]) { p.deleteProperty(k); keys++; }
  });
  if (!memoOn_()) { memoWipeAll_(); console.log('整理：再訪問メモ（使わない設定のため、すべて消しました）'); return; }
  const sh = book_().getSheetByName(MEMOS);
  if (!sh || sh.getLastRow() < 2) { if (keys) console.log('整理：再訪問メモの鍵 ' + keys + '件'); return; }
  const owner = memoOwners_(), now = Date.now();
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, MEMO_HEAD.length).getValues();
  const keep = vals.filter(function (r) {
    if (r[1] === '') return false;
    const uid = String(r[0]), at = Number(r[4]) || 0, del = String(r[5]) === '1';
    if (!active[uid]) return false;                                   // 使っていない人
    if (owner[String(r[1])] !== uid && now - at > MEMO_GRACE_MS) return false; // 受け持ちが終わった家
    if (del && now - at > MEMO_TOMB_MS) return false;                 // 古い「消した」印
    return true;
  });
  // 同じ人・同じ家のメモが2行あるとき（前回の整理が途中で止まったとき）は、新しいほうだけ残す
  const last = {};
  keep.forEach(function (r, i) { const k = String(r[0]) + '|' + String(r[1]); if (!(k in last) || (Number(r[4]) || 0) >= (Number(keep[last[k]][4]) || 0)) last[k] = i; });
  const uniq = keep.filter(function (r, i) { return last[String(r[0]) + '|' + String(r[1])] === i; });
  keep.length = 0; Array.prototype.push.apply(keep, uniq);
  if (keep.length !== vals.length) {
    // 先に残す行を上から書き、そのあとで余った行だけを空にする（途中で止まってもメモが消えない・監査D9）
    if (keep.length) sh.getRange(2, 1, keep.length, MEMO_HEAD.length).setValues(keep);
    if (vals.length > keep.length) sh.getRange(2 + keep.length, 1, vals.length - keep.length, MEMO_HEAD.length).clearContent();
  }
  console.log('整理：再訪問メモ ' + (vals.length - keep.length) + '件、鍵 ' + keys + '件');
}
