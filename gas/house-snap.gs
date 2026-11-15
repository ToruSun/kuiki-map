/**
 * 区域マップ：家と訪問の記録を「まとめた一覧」から返す（はじめて開くときの読み込みを短く・確実にするため）
 *
 * なぜ必要か：
 *   はじめて開くとき、これまでは毎回スプレッドシートから家（1万〜3万件）と記録（数万〜数十万件）を読み、
 *   1回の処理が長くかかっていた。処理が長いと、Google の受け渡し（script.googleusercontent.com）で
 *   返事がなくなる（http404）ことや、送った内容が GET に変わって届く（badreply・GETとして届いた）ことがある。
 *   そこで、あらかじめ「まとめた一覧」をドライブのファイルに作っておき、それを返す。1回の処理は数秒で終わる。
 *
 * しくみ：
 *   ・一覧には、作った時点の変更番号（seq）をつけて返す。画面は、その番号から後の変更を受け取るので、
 *     一覧が少し古くても（1時間前など）、今の内容になる
 *   ・1時間ごとに、変わっていれば作り直す（houseSnapTick）
 *   ・記録の一覧は、A・B の2組のファイルを交互に使う（作り直している最中に読んでいる人の内容がずれないように）
 *   ・記録は、役割に応じて見せる形にしてから返す（コード.gs の mask_ と同じ：ほかの人の記録は、記録した人を隠し、
 *     自分の区域・受け持ちの家でなければ、年代と「また訪ねたいか」も隠す）
 *   ・一覧が使えないとき（作ったあとの変更が多すぎる・変更の記録が作り直されたなど）は null を返し、
 *     これまでどおりスプレッドシートから返す
 *
 * ファイル（このスプレッドシートと同じフォルダ。消さないでください）：
 *   区域マップ_家の一覧（自動で作成・消さないでください）.json
 *   区域マップ_訪問の記録の一覧（自動で作成・消さないでください）_A1.json など
 *   ※ 訪問の記録（だれが・いつ・どの家を訪ねたか）が、見せる形にする前のまま入っています。
 *     このフォルダは、スプレッドシートの持ち主のほかには共有しないでください
 *
 * コード.gs の partFor_ の、いちばん上の行（if (part === 'tv') …）のすぐ下に、次の2行が必要です：
 *   if (part === 'houses' && !offset && req && req.snap && typeof houseSnapPart_ === 'function') { const s = houseSnapPart_(); if (s) return s; }
 *   if (part === 'visits' && req && req.vsnap && typeof visitSnapPart_ === 'function') { const v = visitSnapPart_(user, offset, req); if (v) return v; }
 *
 * はじめに一度、この画面の上の「実行」で houseSnapSetup を動かしてください（2つの一覧を作り、1時間ごとの見直しを設定します）。
 *
 * 返事には、毎回ちがう番号（rid）をつける。同じ中身の返事が続くと、Google の受け渡しで
 * 返事が失われる（http404・GETとして届く）ことがあるように見えるため（2026.9.27 の実行記録より）
 *
 * 【2026.11.06】記録の一覧に、おすすめから訪ねた印（src）も入れるようにした。
 *   画面に返すときは、本人の記録と区域係にだけ9番目に入れる（コード.gs の visitRow_ と同じ形）
 *
 * 【検証で直したところ】
 *   ・区域カードを持っていない人の記録の印（oc）が一覧に入っていなかった。
 *     一覧から読み込んだ端末では、担当外の人の「会えた」が青ではなく緑になっていた。
 *     一覧に11番目として入れ、画面には10番目として返す（コード.gs の visitRow_ と同じ形）
 *   ・記録の一覧を作っている最中に、だれかが記録を取り消す（行が消える）と、行がずれて、
 *     関係のない記録が1件、一覧から抜けることがあった。
 *     読み終えたあとに、その間に記録の削除がなかったかを確かめ、あったときは作り直しを次の機会にする
 *   ※ 入れかえたあとは、エディタで houseSnapSetup を一度実行して、一覧を作り直してください
 */

const HSNAP_PROP = 'HSNAP';
const VSNAP_PROP = 'VSNAP';
const HSNAP_NAME = '区域マップ_家の一覧（自動で作成・消さないでください）.json';
const VSNAP_NAME = '区域マップ_訪問の記録の一覧（自動で作成・消さないでください）';
const HSNAP_MAX = 9 * 1024 * 1024; // ドライブのファイルに文字で書ける大きさ（10MB）より少し小さく
const SNAP_GAP_MAX = 8000;         // 一覧を作ってからの変更がこれより多いときは使わない（あとで受け取る差分が大きくなるため）
const VSNAP_PER = 40000;           // 記録の一覧：1ファイルに入れる件数
const VSNAP_STEP = 5000;           // 記録の一覧：1回に返す件数（VSNAP_PER の約数にする）。返事を小さくして、Google の受け渡しで失われにくくする
const VSNAP_SETTLE_MS = 3000;      // 読み終えてから、削除の記録が journal に書かれるのを待つ時間

/* ---------- 共通 ---------- */
/** 一覧が使えるか：作ったときの番号から後の変更が、変更の記録（journal）に全部残っていて、多すぎないこと */
function snapUsable_(m, info) {
  const s = Number(m && m.seq);
  return !!m && isFinite(s) && s <= info.seq && info.base <= s + 1 && info.seq - s <= SNAP_GAP_MAX;
}
/** 番号 since より後に、kind（houses・visits）の変更があるか */
function journalHas_(since, info, kind) {
  if (since >= info.seq) return false;
  const sh = journalSheet_(), first = Math.max(2, since - info.base + 3), last = sh.getLastRow(); // 番号 since+1 の行から
  if (last < first) return false;
  return !!sh.getRange(first, 2, last - first + 1, 1).createTextFinder(kind).matchEntireCell(true).findNext();
}
/** 番号 since より後〜 info.seq までに、記録の削除（記録のシートの行がずれる操作）があったか。
    その間の変更の記録が残っていない（古い半分を消した・作り直した）ときも、確かめられないので true */
function visitRowsShifted_(since, info) {
  if (info.seq <= since) return false;
  const sh = journalSheet_();
  const first = since - info.base + 3;                                  // 番号 since+1 の行
  const last = Math.min(sh.getLastRow(), info.seq - info.base + 2);     // 番号 info.seq の行
  if (first < 2) return true;
  if (last < first) return false;
  return sh.getRange(first, 2, last - first + 1, 3).getValues().some(function (r) {
    return String(r[0]) === 'visits' && r[2] === ''; // 中身が空＝削除
  });
}
function snapDir_() {
  const parents = DriveApp.getFileById(book_().getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}
function snapFile_(id) {
  if (!id) return null;
  try { const f = DriveApp.getFileById(id); return f.isTrashed() ? null : f; } catch (e) { return null; }
}

/* ---------- 家の一覧 ---------- */
/** 家の一覧をまとめて返す。使えないときは null（これまでどおり5000件ずつ返す） */
function houseSnapPart_() {
  try {
    const info = seqInfoFresh_(); // 確かめる前に番号を読む
    const m = parseJson_(props_().getProperty(HSNAP_PROP), null);
    const f = m && snapUsable_(m, info) ? snapFile_(m.id) : null;
    if (f) {
      try {
        const rows = JSON.parse(f.getBlob().getDataAsString());
        if (Array.isArray(rows)) {
          // 作ってから家の変更がなければ、今の番号を返す（画面が受け取る差分が小さくなる）
          const seq = journalHas_(Number(m.seq), info, 'houses') ? Number(m.seq) : info.seq;
          return { mode: 'part', part: 'houses', rows: rows, next: null, snap: 1, seq: seq, rid: Utilities.getUuid() };
        }
      } catch (e) { console.warn('家の一覧を読めませんでした', e); }
    }
    const built = houseSnapBuild_(); // 家は1〜3万件なので、その場で作っても数秒
    if (!built) return null;
    return { mode: 'part', part: 'houses', rows: built.rows, next: null, snap: 1, seq: built.seq, rid: Utilities.getUuid() };
  } catch (err) {
    console.warn(err && err.stack ? err.stack : err);
    return null;
  }
}

/** 家の一覧を作り直す。ほかで作っている最中なら null */
function houseSnapBuild_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('hsnap_building')) return null;
  cache.put('hsnap_building', '1', 180);
  try {
    const seq = seqInfoFresh_().seq; // 家を読む前に番号を読む
    const sh = dataSheet_('houses'), n = sh.getLastRow();
    const rows = [];
    if (n >= 2) {
      // 家は1回で全部読む（途中で行がずれることがない）
      sh.getRange(2, 1, n - 1, 2).getValues().forEach(function (r) {
        if (r[0] === '' || r[1] === '') return;
        const d = parseJson_(r[1], undefined);
        if (d !== undefined) rows.push(houseRow_(d));
      });
    }
    const text = JSON.stringify(rows);
    if (text.length > HSNAP_MAX) { console.warn('家の一覧が大きすぎるため、まとめずに返します'); return { rows: rows, seq: seq }; }
    const m0 = parseJson_(props_().getProperty(HSNAP_PROP), null);
    let file = snapFile_(m0 && m0.id);
    if (file) file.setContent(text);
    else { file = snapDir_().createFile(HSNAP_NAME, text, 'application/json'); houseSnapTrigger_(); }
    props_().setProperty(HSNAP_PROP, JSON.stringify({ id: file.getId(), seq: seq, n: rows.length, at: nowIso_() }));
    return { rows: rows, seq: seq };
  } finally {
    cache.remove('hsnap_building');
  }
}

/* ---------- 訪問の記録の一覧 ---------- */
/** 記録の一覧から、offset 件目から VSNAP_STEP 件を返す。
    はじめ（offset 0）で使えないときは null（これまでどおりシートから返す）。
    途中（offset > 0）で一覧が変わっていたら gone をつけて返す（画面はシートから読み直す） */
function visitSnapPart_(user, offset, req) {
  const gone = { mode: 'part', part: 'visits', rows: [], next: null, snap: 1, gone: 1 };
  try {
    const info = seqInfoFresh_();
    const m = parseJson_(props_().getProperty(VSNAP_PROP), null);
    if (!m || !Array.isArray(m.files) || !snapUsable_(m, info)) {
      if (!offset) visitSnapSoon_(); // 近いうちに作っておく（今回は、これまでどおりシートから）
      return offset ? gone : null;
    }
    if (offset && String(req.ver || '') !== String(m.at)) return gone;
    const n = Number(m.n) || 0;
    let rows = [];
    if (offset < n) {
      const fi = Math.floor(offset / VSNAP_PER), f = snapFile_(m.files[fi]);
      if (!f) return offset ? gone : null;
      const all = JSON.parse(f.getBlob().getDataAsString());
      const s = offset - fi * VSNAP_PER;
      rows = all.slice(s, s + VSNAP_STEP);
    }
    // 役割に応じて見せる形にする（コード.gs の mask_ と visitRow_ と同じ形）
    //   一覧の中の形：[id, 家, 部屋, 結果, 日時, 記録した人, 年代, また訪ねたいか, 区域, おすすめの印, カードを持っていない人の記録]
    //   返す形　　　：[id, 家, 部屋, 結果, 日時, 記録した人, 年代, また訪ねたいか, おすすめの印（本人と区域係だけ）, カードを持っていない人の記録]
    //   ※ 最後の印（oc）は、だれの記録かを表さないので、全員に返す（コード.gs の mask_ と同じ）
    const me = user.id, admin = user.role === 'admin';
    const hold = {}, fk = {};
    if (!admin) {
      readCol_('territories').forEach(function (x, id) { if (x.data && x.data.holder === me) hold[id] = true; });
      readCol_('follows').forEach(function (x, id) { if (x.data && x.data.by === me) fk[id] = true; });
    }
    const out = rows.map(function (r) {
      const oc = r[10] ? 1 : '';
      if (admin || r[5] === me) return r.slice(0, 8).concat([r[9] || '', oc]);
      const ok = !!fk[r[1] + '|' + (r[2] || '')] || (!!r[8] && !!hold[r[8]]);
      return [r[0], r[1], r[2], r[3], r[4], '', ok ? r[6] : '', ok ? r[7] : '', '', oc];
    });
    return { mode: 'part', part: 'visits', rows: out, next: offset + VSNAP_STEP < n ? offset + VSNAP_STEP : null,
      snap: 1, seq: Number(m.seq), ver: m.at, total: n, rid: Utilities.getUuid() };
  } catch (err) {
    console.warn(err && err.stack ? err.stack : err);
    return offset ? gone : null;
  }
}

/** 記録の一覧を作り直す（1時間ごと、または使えなかったときに少しあとで）。
    ほかで作っている最中や、読んでいる間に行がずれたときは null（今の一覧をそのまま使い、次の機会に作る） */
function visitSnapBuild_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('vsnap_building')) return null;
  cache.put('vsnap_building', '1', 360);
  try {
    const info = seqInfoFresh_(); // 記録を読む前に番号を読む
    // 古い記録には区域が書かれていないことがあるので、家の一覧から区域を補う
    const terrOf = {};
    const hm = parseJson_(props_().getProperty(HSNAP_PROP), null), hf = snapFile_(hm && hm.id);
    let hrows = null;
    if (hf) { try { hrows = JSON.parse(hf.getBlob().getDataAsString()); } catch (e) { hrows = null; } }
    if (Array.isArray(hrows)) hrows.forEach(function (h) { terrOf[h[0]] = h[1] || ''; });
    else readCol_('houses').forEach(function (x, id) { terrOf[id] = (x.data && x.data.terrId) || ''; });
    // 記録を、2万行ずつ読む
    const sh = dataSheet_('visits'), last = sh.getLastRow(), rows = [];
    for (let r = 2; r <= last; r += 20000) {
      sh.getRange(r, 1, Math.min(20000, last - r + 1), 2).getValues().forEach(function (v) {
        if (v[0] === '' || v[1] === '') return;
        const d = parseJson_(v[1], undefined);
        if (!d || !d.houseId) return;
        rows.push([String(d.id), String(d.houseId), d.unit || '', RES_CODE[d.result] || 'a',
          Math.floor(Date.parse(d.at) / 1000) || 0, d.by || '', d.age || '', d.interest || '', d.t || terrOf[d.houseId] || '', d.src || '',
          d.oc ? 1 : '']);
      });
    }
    // 読んでいる間に記録が消されると、行がずれて、関係のない記録が1件抜けてしまう。
    // 削除が journal に書かれるのを少し待ってから確かめ、あったときは今回は作らない
    Utilities.sleep(VSNAP_SETTLE_MS);
    const after = seqInfoFresh_();
    if (after.base !== info.base || visitRowsShifted_(info.seq, after)) {
      console.warn('記録の一覧：読んでいる間に記録が消されたため、今回は作り直しません（次の機会に作ります）');
      return null;
    }
    // A・B の2組のファイルを交互に使う（今使っている組には書かない）
    const old = parseJson_(props_().getProperty(VSNAP_PROP), null);
    const slot = old && old.slot === 'A' ? 'B' : 'A';
    const key = 'VSNAP_FILES_' + slot;
    const mine = parseJson_(props_().getProperty(key), []) || [];
    const files = [], dir = snapDir_();
    for (let i = 0; i * VSNAP_PER < Math.max(1, rows.length); i++) {
      const text = JSON.stringify(rows.slice(i * VSNAP_PER, (i + 1) * VSNAP_PER));
      let f = snapFile_(mine[i]);
      if (f) f.setContent(text);
      else f = dir.createFile(VSNAP_NAME + '_' + slot + (i + 1) + '.json', text, 'application/json');
      files.push(f.getId());
    }
    mine.slice(files.length).forEach(function (id) { const f = snapFile_(id); if (f) f.setTrashed(true); });
    props_().setProperty(key, JSON.stringify(files));
    const m = { slot: slot, files: files, per: VSNAP_PER, n: rows.length, seq: info.seq, at: nowIso_() };
    props_().setProperty(VSNAP_PROP, JSON.stringify(m));
    houseSnapTrigger_();
    return m;
  } finally {
    cache.remove('vsnap_building');
  }
}

/** 使えなかったとき：30秒後に、一度だけ作り直す（10分に1回まで） */
function visitSnapSoon_() {
  const c = CacheService.getScriptCache();
  if (c.get('vsnap_soon')) return;
  c.put('vsnap_soon', '1', 600);
  try { ScriptApp.newTrigger('snapSoonRun').timeBased().after(30 * 1000).create(); } catch (e) { console.warn('作り直しを予約できませんでした', e); }
}
function snapSoonRun() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'snapSoonRun') ScriptApp.deleteTrigger(t); });
  visitSnapBuild_();
}

/* ---------- 見直し・準備 ---------- */
/** 1時間ごと：変わっていれば、家と記録の一覧を作り直しておく（次にはじめて開く人を待たせないため） */
function houseSnapTick() {
  const info = seqInfoFresh_();
  const hm = parseJson_(props_().getProperty(HSNAP_PROP), null);
  if (!hm || !snapUsable_(hm, info) || journalHas_(Number(hm.seq), info, 'houses')) houseSnapBuild_();
  const vm = parseJson_(props_().getProperty(VSNAP_PROP), null);
  if (!vm || !snapUsable_(vm, info) || journalHas_(Number(vm.seq), info, 'visits')) visitSnapBuild_();
}
function houseSnapTrigger_() {
  try {
    const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'houseSnapTick'; });
    if (!has) ScriptApp.newTrigger('houseSnapTick').timeBased().everyHours(1).create();
  } catch (e) { console.warn('1時間ごとの見直しを設定できませんでした', e); }
}

/** はじめに一度、エディタの「実行」で動かす：2つの一覧を作り、1時間ごとの見直しを設定する */
function houseSnapSetup() {
  const c = CacheService.getScriptCache();
  c.removeAll(['hsnap_building', 'vsnap_building']);
  houseSnapBuild_();
  const v = visitSnapBuild_();
  houseSnapTrigger_();
  const h = parseJson_(props_().getProperty(HSNAP_PROP), null);
  console.log(h ? '家の一覧を作りました：' + h.n + '件（変更番号 ' + h.seq + '）' : '家の一覧を作れませんでした');
  console.log(v ? '訪問の記録の一覧を作りました：' + v.n + '件・ファイル ' + v.files.length + '個（変更番号 ' + v.seq + '）'
    : '訪問の記録の一覧を作れませんでした（読んでいる間に記録が消された可能性があります。少しあとで、もう一度実行してください）');
}
