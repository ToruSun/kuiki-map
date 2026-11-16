/* =========================================================
 * 名簿（グループ表）から、人とグループをまとめて更新する（meibo.gs）
 *
 * ・区域係の画面で名簿のPDFを読み、係が内容を確かめてから、ここへまとめて送る（action: user_bulk）
 * ・今いる人は、id を変えずに名前・グループ・監督・司会者だけを書きかえる。
 *   再訪問のメモ（memos）・受け持ち（follows）・訪問の記録・端末の登録は、どれも id で結びついているので、そのまま使える
 * ・行は消さない。「使うのをやめる」は、今の「使うのをやめる」と同じ（有効を FALSE にして、その人のメモの控えを消す）。
 *   係が画面で2回確かめたものだけが届く
 * ・書く前に users シートの控え（シート「users_控え」、非表示・新しい3回分）を残す。書いたことは operations に1行残す
 * ・役割（伝道者・区域係）と招待コード・各自の設定（F列）には手をつけない
 * ========================================================= */
const MEIBO_MAX = 400;          // 1回に受け付ける数
const MEIBO_BAK = 'users_控え'; // 控えのシートの名前の先頭
const MEIBO_BAK_KEEP = 3;

function meiboKey_(s) { return String(s || '').normalize('NFKC').replace(/\s+/g, ''); }

/** items：[{ op:'upd', id, name?, group, overseer, leader, on? } | { op:'add', name, group, overseer, leader } | { op:'off', id }] */
function userBulk_(user, req) {
  const items = Array.isArray(req.items) ? req.items.slice(0, MEIBO_MAX) : [];
  if (!items.length) return { ok: false, error: 'empty' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'busy' };
  try {
    const sh = usersSheet_();
    const n = sh.getLastRow();
    const vals = n >= 2 ? sh.getRange(2, 1, n - 1, USER_HEAD.length).getValues() : [];
    const byId = {}, nameOwner = {};
    vals.forEach(function (r, i) {
      const id = String(r[0]).trim();
      if (!id) return;
      byId[id] = i;
      const k = meiboKey_(r[1]);
      if (k) (nameOwner[k] = nameOwner[k] || []).push(id);
    });

    meiboBackup_(sh);

    const skipped = [], offIds = [];
    let upd = 0, add = 0, off = 0, on = 0;
    const appends = [];
    const seen = {};
    items.forEach(function (it, idx) {
      const op = String(it && it.op || '');
      if (op === 'upd' || op === 'off') {
        const id = String(it.id || '');
        const i = byId[id];
        if (i == null) { skipped.push({ i: idx, why: 'not_found' }); return; }
        if (seen[id]) { skipped.push({ i: idx, why: 'twice' }); return; }
        seen[id] = true;
        const r = vals[i];
        if (op === 'off') {
          if (id === user.id) { skipped.push({ i: idx, why: 'self' }); return; }
          if (r[4] === true) { r[4] = false; offIds.push(id); off++; }
          return;
        }
        if (it.name != null) {
          const nm = sheetSafe_(it.name, 30);
          if (!nm) { skipped.push({ i: idx, why: 'name' }); return; }
          const k = meiboKey_(nm);
          const others = (nameOwner[k] || []).filter(function (x) { return x !== id; });
          if (others.length) { skipped.push({ i: idx, why: 'dup_name' }); return; } // 同じ名前の別の人がいる（同じ人を2つにしない）
          if (meiboKey_(r[1]) !== k) {
            const oldK = meiboKey_(r[1]);
            nameOwner[oldK] = (nameOwner[oldK] || []).filter(function (x) { return x !== id; });
            (nameOwner[k] = nameOwner[k] || []).push(id);
          }
          r[1] = nm;
        }
        r[7] = normGroup_(it.group);
        r[8] = !!it.overseer;
        r[9] = !!it.leader;
        if (it.on === true && r[4] !== true) { r[4] = true; on++; }
        upd++;
        return;
      }
      if (op === 'add') {
        const nm = sheetSafe_(it.name, 30);
        if (!nm) { skipped.push({ i: idx, why: 'name' }); return; }
        const k = meiboKey_(nm);
        if ((nameOwner[k] || []).length) { skipped.push({ i: idx, why: 'exists' }); return; } // もう登録されている人は足さない
        const id = 'u' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
        nameOwner[k] = [id];
        appends.push([id, nm, roleValue_(false), userTokenKey_(newToken_()), true, '{}', new Date(), normGroup_(it.group), !!it.overseer, !!it.leader, '', false]);
        add++;
        return;
      }
      skipped.push({ i: idx, why: 'op' });
    });

    // 書く：名前（B）・有効（E）・グループと監督・司会者（H〜J）だけ。役割・招待コード・各自の設定には手をつけない
    if (vals.length && (upd || off)) {
      sh.getRange(2, 2, vals.length, 1).setValues(vals.map(function (r) { return [r[1]]; }));
      sh.getRange(2, 5, vals.length, 1).setValues(vals.map(function (r) { return [r[4]]; }));
      sh.getRange(2, 8, vals.length, 3).setValues(vals.map(function (r) { return [r[7], r[8], r[9]]; }));
    }
    if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, USER_HEAD.length).setValues(appends);
    offIds.forEach(function (id) { if (typeof memoWipeUser_ === 'function') memoWipeUser_(id); });
    cacheDrop_();
    try {
      const os = opsSheet_(), row = Math.max(2, os.getLastRow() + 1);
      if (row > os.getMaxRows()) os.insertRowsAfter(os.getMaxRows(), 50);
      os.getRange(row, 1, 1, 5).setValues([[Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), user.name, '名簿の取り込み', '',
        '更新' + upd + '人・追加' + add + '人・やめる' + off + '人・再開' + on + '人' + (skipped.length ? '・見送り' + skipped.length + '件' : '')]]);
    } catch (e) { console.warn('名簿の取り込みの記録を残せませんでした：' + e); }
    return { ok: true, upd: upd, add: add, off: off, on: on, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

/** 書く前の users シートを、非表示のシートに控える（新しい3回分）。控えられなければ、書かずに止める */
function meiboBackup_(sh) {
  const book = book_();
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const copy = sh.copyTo(book).setName(MEIBO_BAK + '_' + stamp);
  try { copy.hideSheet(); } catch (e) { /* 隠せなくても控えは残す */ }
  const olds = book.getSheets().filter(function (s) { return s.getName().indexOf(MEIBO_BAK + '_') === 0; })
    .sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  olds.slice(MEIBO_BAK_KEEP).forEach(function (s) { try { book.deleteSheet(s); } catch (e) { /* 何もしない */ } });
}
