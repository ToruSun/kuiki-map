/**
 * 区域マップ：スプレッドシートの大きさの点検と整理（kuiki-maintenance.gs）
 *
 * Googleスプレッドシートは、1つのファイルに入れられるセルが「1000万セル」までです。
 * セルの数は、中身の有無に関係なく「行の数 × 列の数」で数えられます。
 * 新しく作ったシートは26列（A〜Z）あるため、データのシート（4列しか使わない）でも、
 * 1行ふえるごとに26セルずつ使ってしまいます。
 * 訪問記録が2年分（20〜40万行）になると、それだけで520万〜1040万セルになり、
 * 上限に達すると、記録の保存がすべて失敗するようになります。
 *
 * ここでは、データのシートと journal から「使っていない列」と「末尾の空いた行」を消します。
 * 中身の入っている列・行は消しません。
 *
 * 使い方
 *   ・cellReport   … 今のセルの数と、上限までの残りを見る（変更はしない）
 *   ・shrinkSheets … 使っていない列・行を消す（区域係が1回実行。以後は毎月の整理で自動）
 *   ・毎月の整理（cleanupOld）の最後に shrinkSheets_() を1行足すと、自動で続けられます
 *
 * 【このファイルを入れるときの注意】
 *   メインのファイルにある次の3つの関数は、このファイルに新しい版が入っています。
 *   同じ名前の関数が2つあると、どちらが使われるか決まらないため、メインのファイルから消してください。
 *     ・deltaFor_   ・devicesAll_   ・cacheDrop_
 */
const CELL_LIMIT = 10000000;  // 1ファイルのセルの上限
const CELL_WARN = 0.7;        // この割合を超えたら注意を出す
const SHRINK_ROW_BUFFER = 1000; // 末尾に残しておく空いた行の数（追加のたびに行を増やさなくてよいように）

/** 整理してよいシート（このファイルのコードが4列・5列しか使わないことが分かっているシート） */
function shrinkTargets_() {
  return DATA_COLS.concat([SETTINGS, JOURNAL]);
}

/** シートごとのセルの数（大きい順） */
function cellStats_() {
  const list = book_().getSheets().map(function (sh) {
    const r = sh.getMaxRows(), c = sh.getMaxColumns();
    return { name: sh.getName(), rows: r, cols: c, cells: r * c, lastRow: sh.getLastRow(), lastCol: sh.getLastColumn() };
  }).sort(function (a, b) { return b.cells - a.cells; });
  const total = list.reduce(function (n, x) { return n + x.cells; }, 0);
  return { list: list, total: total };
}

function cellReportText_() {
  const st = cellStats_();
  const pct = Math.round(st.total / CELL_LIMIT * 1000) / 10;
  const lines = st.list.slice(0, 12).map(function (x) {
    return x.name + '：' + x.rows.toLocaleString() + '行 × ' + x.cols + '列 ＝ ' + x.cells.toLocaleString() + 'セル';
  });
  return 'セルの合計：' + st.total.toLocaleString() + ' / ' + CELL_LIMIT.toLocaleString() + '（' + pct + '%）\n' +
    (st.total > CELL_LIMIT * CELL_WARN ? '【注意】上限に近づいています。「shrinkSheets」を実行してください。\n' : '') +
    '\n' + lines.join('\n');
}

/** 点検だけ（何も変えない） */
function cellReport() {
  const text = cellReportText_();
  console.log(text);
  try { SpreadsheetApp.getUi().alert('スプレッドシートの大きさ', text, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* エディタから実行したときは、実行ログで見る */ }
}

/** 使っていない列・行を消す（区域係が手で実行するとき） */
function shrinkSheets() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // 保存の最中に行を消さないように
  let done;
  try { done = shrinkSheets_(); } finally { lock.releaseLock(); }
  const text = '整理しました。\n' + done.join('\n') + '\n\n' + cellReportText_();
  console.log(text);
  try { SpreadsheetApp.getUi().alert('使っていない列・行の整理', text, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* 実行ログで見る */ }
}

/** 本体（ロックは呼ぶ側で持つ。cleanupOld の中からも呼べる） */
function shrinkSheets_() {
  const done = [];
  shrinkTargets_().forEach(function (name) {
    const sh = book_().getSheetByName(name);
    if (!sh) return;
    const before = sh.getMaxRows() * sh.getMaxColumns();
    // 列：中身の入っている最後の列より右を消す（データのシートはD列まで、journal はE列まで）
    const maxC = sh.getMaxColumns(), lastC = Math.max(1, sh.getLastColumn());
    if (maxC > lastC) sh.deleteColumns(lastC + 1, maxC - lastC);
    // 行：中身の入っている最後の行より下は、空いた行を SHRINK_ROW_BUFFER 行だけ残して消す
    const maxR = sh.getMaxRows(), lastR = Math.max(sh.getFrozenRows() + 1, sh.getLastRow());
    const keepR = lastR + SHRINK_ROW_BUFFER;
    if (maxR > keepR) sh.deleteRows(keepR + 1, maxR - keepR);
    const after = sh.getMaxRows() * sh.getMaxColumns();
    if (after < before) done.push(name + '：' + before.toLocaleString() + ' → ' + after.toLocaleString() + 'セル');
  });
  if (!done.length) done.push('（消す列・行はありませんでした）');
  console.log('シートの整理：' + done.join('、'));
  return done;
}

/* =========================================================
   一時保存（キャッシュ）を、いくつかに分けて置く
   CacheService は1つの値が100KBまでなので、スマホの登録（devices）が増えて
   一覧が大きくなると、一時保存が使えず、問い合わせのたびにシートを読むようになるため
   ========================================================= */
const CHUNK_CHARS = 30000; // 日本語（1文字3バイト）でも100KBを超えない大きさ
function cacheGetChunks_(k) {
  try {
    const c = CacheService.getScriptCache();
    const head = c.get(k + '_n');
    if (!head) return null;
    const p = head.split('|'), stamp = p[0], n = Number(p[1]);
    if (!(n > 0) || n > 30) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(k + '_' + i);
    const all = c.getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) {
      const v = all[keys[i]];
      if (typeof v !== 'string' || v.indexOf(stamp + '|') !== 0) return null; // 別のときに置いたものがまざった
      s += v.slice(stamp.length + 1);
    }
    return JSON.parse(s);
  } catch (e) { return null; }
}
function cachePutChunks_(k, v, sec) {
  try {
    const t = JSON.stringify(v), stamp = Utilities.getUuid().slice(0, 8), o = {};
    let n = 0;
    for (let i = 0; i < t.length; i += CHUNK_CHARS) o[k + '_' + (n++)] = stamp + '|' + t.slice(i, i + CHUNK_CHARS);
    if (!n || n > 30) return;
    o[k + '_n'] = stamp + '|' + n;
    CacheService.getScriptCache().putAll(o, sec || 30);
  } catch (e) { /* ためられなくても動く */ }
}

/* =========================================================
   メインのファイルから移した関数（新しい版）
   ========================================================= */

/** 前回（since）から変わった分だけを返す。返せないときは null
    【直したところ】journal の古い半分を消した直後に、古い番号（一時保存）で読むと、行がずれて
    変更を取りこぼすことがあった。読んだ最初の行の番号を確かめ、ずれていたら正しい番号で読み直す */
function deltaFor_(user, since) {
  let info = seqInfo_();
  if (since > info.seq) info = seqInfoFresh_(); // 一時保存が古いときは、正しい番号で確かめる
  if (!isFinite(since) || since < info.base - 1 || since > info.seq) return null;
  const head = { users: usersFor_(user), settings: settingsFor_(user), currentUser: user.id }; // 係以外には langSkip を渡さない（監査 H1）
  // 再訪問のメモが、この人のほかの端末で変わった合図（中身は入れない。memo.gs）
  const mv = typeof memoVer_ === 'function' ? memoVer_(user.id) : '';
  if (mv) head.mv = mv;
  // 何も変わっていないときは、スプレッドシートを開かずにすぐ返す（ふだんの問い合わせのほとんど）
  if (since === info.seq) return Object.assign({ mode: 'delta', seq: since, changes: [] }, head);
  const sh = journalSheet_();
  const readRows = function (inf) {
    const first = Math.max(2, since - inf.base + 2);
    const last = sh.getLastRow();
    return last >= first ? sh.getRange(first, 1, last - first + 1, 4).getValues() : [];
  };
  // 最初の行は、ふつうは since か since+1 の番号。それより大きければ、行がずれている
  const inOrder = function (rows) { return !rows.length || Number(rows[0][0]) <= since + 1; };
  let rows = readRows(info);
  if (!inOrder(rows)) {
    info = seqInfoFresh_();
    if (since < info.base - 1 || since > info.seq) return null; // 古すぎる → 全部を読み直してもらう
    rows = readRows(info);
    if (!inOrder(rows)) return null;
  }
  const changes = [];
  let seq = since, pv = null;
  const view = function () { return pv || (pv = user.role === 'admin' ? null : permView_(user, null)); };
  rows.forEach(function (r) {
    const n = Number(r[0]);
    if (!(n > since)) return;
    seq = Math.max(seq, n);
    const c = String(r[1]);
    if (c === SETTINGS) return;
    const v = r[3] === '' ? null : parseJson_(r[3], undefined);
    if (v === undefined) return;
    const m = mask_(user, c, v, c === 'visits' && v !== null ? view() : null);
    if (m === undefined) return;
    changes.push([c, String(r[2]), m]);
  });
  return Object.assign({ mode: 'delta', seq: seq, changes: changes }, head);
}

function devicesAll_() {
  const hit = cacheGetChunks_('devices_v2'); // 登録が増えても一時保存を使えるように、分けて置く（このファイル）
  if (hit) return hit;
  const sh = devicesSheet_();
  const n = sh.getLastRow();
  if (n < 2) return [];
  const list = sh.getRange(2, 1, n - 1, DEVICE_HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, id: String(r[0]), hash: String(r[1]), uid: String(r[2]), status: String(r[3]),
      label: String(r[4]), reqAt: String(r[5]), decAt: String(r[6]), decBy: String(r[7]), seen: String(r[8]), hint: String(r[9] || '') };
  }).filter(function (d) { return d.id && d.hash; });
  cachePutChunks_('devices_v2', list, 30);
  return list;
}

/* users・devices のシートを書きかえたあとに呼ぶ。
   ・先にシートへの書きこみを確定させる（flush しないと、処理が終わるまでほかの受け付けが古い内容を読むことがある）
   ・書いた時刻を残す：書く前に読み始めた受け付けが、古い名簿を一時保存し直さないように（usersAll_ が見る） */
function cacheDrop_() {
  try { SpreadsheetApp.flush(); } catch (e) { /* 何もしない */ }
  try {
    const c = CacheService.getScriptCache();
    c.put('users_w', String(Date.now()), 120);
    c.removeAll(['users_v1', 'devices_v1', 'devices_v2_n']);
  } catch (e) { /* 何もしない */ }
}

/* =========================================================
   訪問の記録（会えた・留守）を消す（2026.10.22・フェーズ1の準備で追加）
   ・メニュー「区域マップ」→「訪問の記録（会えた・留守）を消す」で、区域係が実行する
   ・消すもの：訪問の記録のうち「会えた」「留守」と、終わった留守宅カード（留守の記録から作ったカード）
   ・残すもの：拒否（訪問で「拒否」にした記録と、拒否の印 dnc）・注意（！）・家・区域・S-13・返却の記録・
     再訪問の受け持ち・今使っている留守宅カード
   ・消す前に、スプレッドシートを丸ごとバックアップする（戻すときは「バックアップから戻す」）
   ・消したあと、みんなのスマホは次に開いたとき（開いていれば数十秒以内に）全部を読み直す。
     まだ送っていない記録は、送ってから読み直すので消えない
   ========================================================= */
function clearVisitHistoryCount_() {
  const visits = readCol_('visits');
  let met = 0, away = 0, keep = 0;
  visits.forEach(function (x) {
    const r = x && x.data ? x.data.result : '';
    if (r === 'met') met++; else if (r === 'away') away++; else keep++;
  });
  let cards = 0, live = 0;
  readCol_('awayCards').forEach(function (x) { if (x && x.data && x.data.endedAt) cards++; else live++; });
  let dnc = 0, skip = 0; // 訪問しない（dnc の q）は拒否と分けて数える（監査 HS-A9）
  readCol_('dnc').forEach(function (x) { if (isDncQ_(x && x.data)) skip++; else dnc++; });
  const caution = readCol_('caution').size;
  return { visits: visits, met: met, away: away, keep: keep, cards: cards, live: live, dnc: dnc, skip: skip, caution: caution };
}

function clearVisitHistoryMenu() {
  const ui = SpreadsheetApp.getUi();
  const c = clearVisitHistoryCount_();
  if (!c.met && !c.away && !c.cards) {
    ui.alert(T_('訪問の記録を消す', 'Borrar registros de visitas'),
      T_('消す記録はありません（会えた・留守の記録、終わった留守宅カードは0件です）。', 'No hay registros que borrar.'), ui.ButtonSet.OK);
    return;
  }
  const ok = ui.alert(T_('訪問の記録（会えた・留守）を消す', 'Borrar registros de visitas (encontrado / ausente)'),
    T_('次の記録を、すべて消します。\n' +
      '・会えた：' + c.met + '件\n・留守：' + c.away + '件\n・終わった留守宅カード：' + c.cards + '件\n\n' +
      '次のものは残します。\n' +
      '・訪問で「拒否」にした記録：' + c.keep + '件\n・拒否の印：' + c.dnc + '件\n' + (c.skip ? '・訪問しない（区域係が付けた印）：' + c.skip + '件\n' : '') + '・注意（！）：' + c.caution + '件\n' +
      '・家・区域・区域割り当ての記録（S-13）・返却の記録・再訪問の受け持ち' + (c.live ? '・今使っている留守宅カード（' + c.live + '件）' : '') + '\n\n' +
      '消す前に、このスプレッドシートを丸ごとバックアップします。\n消したあと、みんなのスマホは次に開いたときに全部を読み直します。\n\nよろしいですか？',
      'Se borrarán todos estos registros:\n・Encontrado: ' + c.met + '\n・Ausente: ' + c.away + '\n・Tarjetas de ausentes terminadas: ' + c.cards + '\n\n' +
      'Se conservan: registros de «rechazo» (' + c.keep + '), marcas de rechazo (' + c.dnc + '), ' + (c.skip ? 'casas omitidas (' + c.skip + '), ' : '') + 'avisos (' + c.caution + '), casas, territorios, S-13, devoluciones y revisitas.\n\n' +
      'Antes se hará una copia de seguridad de toda la hoja. Después, todos los teléfonos volverán a cargar los datos.\n\n¿Continuar?'),
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  let r;
  try {
    r = clearVisitHistory_();
  } catch (e) {
    ui.alert(T_('消せませんでした：', 'No se pudo borrar: ') + ((e && e.message) || e) +
      T_('\n\n記録は変わっていないか、途中までです。もう一度実行してください。', '\n\nVuelva a intentarlo.'));
    return;
  }
  ui.alert(T_('訪問の記録を消しました', 'Registros borrados'),
    T_('会えた ' + r.met + '件・留守 ' + r.away + '件・終わった留守宅カード ' + r.cards + '件を消しました。\n' +
      '拒否の記録 ' + r.keep + '件は残しています。\n\n消す前のバックアップ：' + r.backup,
      'Se borraron: encontrado ' + r.met + ', ausente ' + r.away + ', tarjetas ' + r.cards + '. Se conservan ' + r.keep + ' rechazos.\n\nCopia: ' + r.backup),
    ui.ButtonSet.OK);
}

/** 本体（画面なし）。消す前にバックアップを作る。消した件数を返す */
function clearVisitHistory_() {
  const backup = makeBackup_('訪問記録を消す前').getName(); // 失敗したら、ここで止まる（何も消さない）
  const lock = LockService.getScriptLock();
  lock.waitLock(60000); // 保存の最中に書きかえないように
  const res = { met: 0, away: 0, keep: 0, cards: 0, backup: backup };
  try {
    const visits = readCol_('visits');
    const gone = [];
    visits.forEach(function (x, id) {
      const r = x && x.data ? x.data.result : '';
      if (r === 'met' || r === 'away') { gone.push(id); if (r === 'met') res.met++; else res.away++; }
      else res.keep++;
    });
    gone.forEach(function (id) { visits.delete(id); });
    if (gone.length) rewriteCol_('visits', visits); // 先に残すものを書き、余った行を空にする（途中で止まっても、記録が全部消えることはない）
    const cards = readCol_('awayCards');
    cards.forEach(function (x, id) { if (x && x.data && x.data.endedAt) { cards.delete(id); res.cards++; } });
    if (res.cards) rewriteCol_('awayCards', cards);
    if (gone.length || res.cards) resetJournal_(); // みんなのスマホに、全部を読み直してもらう
    shrinkSheets_();
    props_().setProperty('VISITS_CLEARED', JSON.stringify({ at: nowIso_(), met: res.met, away: res.away, cards: res.cards }));
  } finally {
    lock.releaseLock();
  }
  // はじめて開くときに使う「記録の一覧」（ドライブのファイル）も作り直す（古い記録を残さないため）
  if (typeof visitSnapBuild_ === 'function') {
    try { if (!visitSnapBuild_()) visitSnapSoon_(); } catch (e) { console.warn(e); try { visitSnapSoon_(); } catch (e2) { /* 1時間ごとの見直しで作られる */ } }
  }
  console.log('訪問の記録を消しました：会えた ' + res.met + '・留守 ' + res.away + '・留守宅カード ' + res.cards + '（拒否 ' + res.keep + ' は残す）');
  return res;
}
