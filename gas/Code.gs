/**
 * 区域マップ サーバー（Google Apps Script）／ Mapa de Territorios – servidor
 * 配布パック版（新しい会衆用）
 *
 * このファイルは、データを保存するスプレッドシートに紐づけて使います。
 * （スプレッドシートの「拡張機能」→「Apps Script」に貼り付け）
 * Este archivo va dentro de la hoja de cálculo (Extensiones → Apps Script).
 *
 * ・画面（index.html）からの読み込み・保存を受け付けます。
 * ・招待コードで本人を確認し、役割（伝道者／区域係）に応じて見せるデータと、変更できる内容を決めます。
 * ・変更はすべて「journal」シートに番号つきで記録し、画面には前回から変わった分だけを返します。
 * ・使い始めは2通り：①共通リンク（?j=）＋区域係の承認　②個別の招待リンク（?t=）
 *
 * 同じプロジェクトに入れるファイル：
 *   Code.gs（これ）・kuiki-maintenance.gs・house-snap.gs・memo.gs・backup.gs・pdf-backup.gs・aza.gs・meibo.gs
 *   （deltaFor_・devicesAll_・cacheDrop_・shrinkSheets_ は kuiki-maintenance.gs にあります）
 * 配布パックでは、仮の家の取り込みのうち OpenStreetMap（import.gs）はメニューに出していません。国土地理院（gsi.gs）はメニューにあります。
 * 区域の字（aza.gs）は、年齢データ（e-Stat 国勢調査の小地域集計）と組み合わせて使います。
 *
 * スプレッドシートのメニューと案内は、日本語とスペイン語を切りかえられます（メニュー「言語 / Idioma」）。
 */

const DATA_COLS = ['territories', 'houses', 'visits', 'requests', 'awayCards', 'returns', 'schedules', 'dnc', 'follows', 'released', 's13', 'agedata', 'caution', 'holds', 'langs']; // langs＝外国語の家（2026-11-08）。holds＝おすすめの家の押さえ（今行く・予定に入れる。2026-10-26）
const MAP_COLS = ['dnc', 'follows', 'released', 'caution', 'langs']; // caution＝注意（！）の印（2026-10-18）。langs＝外国語の家の言語（2026-11-08）
const PARTIAL_COLS = ['houses', 'visits']; // 件数が多いので、保存のときにシート全体を読まない
const USERS = 'users';
const JOURNAL = 'journal';
const JOURNAL_MAX = 40000;
const PART_LIMIT = { houses: 5000, visits: 20000 };
const VISIT_FRESH_MS = 5 * 3600000;
const VISIT_SEEN_SEC = 6 * 3600;
const SEQ_CACHE_SEC = 600;
const SEQ_READ_SEC = 30;
const SETTINGS = 'settings';
const ROLE_ADMIN = '区域係', ROLE_ADMIN_ES = 'Encargado';
const ROLE_PUB = '伝道者', ROLE_PUB_ES = 'Publicador';
const DEFAULT_SETTINGS = {
  mapStd: 0,          // 伝道者の地図のはじめの種類（0＝見やすい地図、1＝地名の多い標準地図）
  kgGoal: 1, remindDays: 21, escalateDays: 42, selfTakeMax: 2,
  awayDays: 7, awayMax: 2, donePct: 90,
  lowOn: 1,           // 記録の少ない正式返却を、待ってから自動で確かめる（1＝使う）
  wxOn: 1,            // 雨の日は、区域をもらう一覧とおすすめで集合住宅のカードを先に出す（weather.gs。1＝使う）
  lowWait: 7,         // 上の確かめまで待つ日数
  keepMonths: 12, cacheDays: 30, recAge: 1, recInterest: 1,
  skipDays: 30, skipDone: 1, lockOthers: 1, groupOn: 1, groupMax: 4,
  memoShare: 1, memoSync: 1,
  awayRecentDays: 3, awayCardMax: 15, awayAllTerr: 0,
  syncGroupSec: 7, syncNormalSec: 20,
  reqMaxPersonal: 1, reqMaxGroup: 1, holdMaxPersonal: 2, holdMaxGroup: 2,
  freeAfterDays: 0, followSkipDays: 60,
  autoFree: 0,        // 自動受け取り（1＝まだ回っていない区域と、正式に返却されてから freeAfterDays 日たった区域を、自分で受け取れる）
  lendDays: 120,      // 返却の目安（受け取ってからの日数）
  awayRetPct: 70,     // 留守宅を回り終えたとみなす割合（1回目に会えなかった家のうち、訪ね直した家）
  awayExp: 0,         // 留守宅カードが自動で終わるとき（0＝awayDays 日、1＝区域の返却の目安まで）
  ageShow: 0,         // 配布パックでは年齢データを使わないので、出さない
  ageShowMode: 0,
  recoOn: 1, recoKinds: 15, recoCount: 3, recoDist: 500, recoLongDays: 180, recoSkipDays: 14,
  recoOthers: 1, recoCardOut: 1, recoCardBtn: 1,
  youngW: 25,         // おすすめ順で、若い世代の多さに付ける点数（弱10・中25・強40）
  awayTries: 3,       // 違う時間帯でこの回数留守だった家は、留守宅カードに入れない（手紙の候補）
  awayCap: 3,         // 留守宅として訪ねる上限回数（今回の巡回での留守の回数。同じ日は1回と数える）。届いた家は、次の巡回まで留守宅カードに入れない
  awayNoRepeat: 1,    // 同じ家に、同じ時間帯を重ねない（1＝重ねない）
  awayScope: 0,       // 試した時間帯の数え方（0＝今回の巡回だけ、1＝前回の巡回も含める）
  nightOn: 0,         // 夜（19時〜）も、留守宅を訪ねる時間帯として提案するか
  offDays: [],        // 訪問を控える日（'2026-11-03' の形。おすすめと留守宅カードの提案を止める）
  contDays: 60,       // 途中で返された区域を、次の人が「続きから」回れる期間（日。0＝使わない）
  extOn: 1,           // 返却後の留守宅カード（1＝正式に返却された区域の、まだ会えていない家を、だれでも受け取れる）
  extRest: 7,         // 返却後のカードを寝かせる日数（正式返却から・前のカードが終わってから、この日数は出さない。7日未満にはできない）
  extCap: 2,          // 返却後に同じ家を訪ねる上限回数（同じ日は1回と数える）
  extDays: 60,        // 返却後のカードを出す期間（正式に返却されてからの日数）
  extStopBefore: 14,  // 自動受け取りの区域では、自由に受け取れる日のこの日数前で止める
  awayDayOnly: 3,     // 家がこの軒数以下の留守宅カードは「その日限り」（受け取った日の終わりに自動で終わる。0＝使わない）
  awayAgainSlot: 1,   // 留守宅を「訪ね直した」と数える条件（0＝別の日、1＝別の日で、別の時間帯。会えた・拒否は時間帯にかかわらず数える）（2026-10-26）
  recoLock: 0,        // オートロックの建物を、おすすめ（完了のあとの留守宅）に出すか（1＝出す）
  osaeMax: 2,         // おすすめの「予定に入れる」で、1人が同時に押さえられる予定の数
  osaeDays: 7,        // おすすめの「予定に入れる」で、何日先まで予定に入れられるか（その日の終わりまで家を押さえる）
  recoLeft: 1,        // 完了した区域で、巡回の中で一度も訪ねていない家（回り残し）も、おすすめに留守宅より先に出す（1＝出す）
  ikenOn: 0,         // ホームの「こまったこと・提案を送る」（送った人は係の画面で分かる。iken.gs）を出す（1＝出す）（2026-11-05）
  ikenWho: 1,        // 送れる人：0＝全員、1＝グループ監督・司会者・区域係だけ（フェーズ1）
  s21On: 0,          // 奉仕報告を S21（会衆の報告システム）に送る（1＝使う。URL・連携キーは s21.gs・スクリプトのプロパティ）（2026-10-27）
  langSkip: 0,        // 外国語の家で、区域カードでは訪問しない言語（LANGS の順のビット。0＝どの言語も訪問する）（2026-11-08）
  groupPts: {},       // グループの中心（係が地図に置く「このグループの人はだいたいこのあたり」。{ グループ名: [[緯度, 経度], …] }、1グループ2点まで。人の住所や名前は入れない）
};
const GROUP_PTS_MAX = 2;      // 1グループに置ける中心の数
const GROUP_PTS_GROUPS = 20;  // 中心を置けるグループの数（多すぎる送信を止めるため）
const SLOT_NAMES = (function () {
  const a = [];
  ['平日', '土日'].forEach(function (d) { ['朝', '昼', '午後', '夕方', '夜'].forEach(function (b) { a.push(d + '・' + b); }); });
  return a;
})();
const DAY_MS = 86400000;
const DEVICES = 'devices';
const DEV_PENDING = '申請中', DEV_ACTIVE = '使用中', DEV_DENIED = '見送り', DEV_REVOKED = '無効';
const PENDING_DAYS = 7;
const PENDING_MAX = 30;
const AZA_FIELDS = ['aza', 'azaSig', 'azaAt', 'azaN', 'azaErr'];
const RECO_SRC_RE = /^reco(:[a-z]{1,12})?$/;
// 訪問記録の src に付けるカードの印（2026-10-31）：card＝留守宅カードで回った／area＝区域カードで回った（状況のグラフ用）。印はこの2つだけ（カードの番号は付けない）。
// おすすめから開いた記録は、おすすめの印を先頭に残し、半角のスペースを1つ置いて、そのあとにカードの印を付ける（例：reco:after card）。印のない記録・おすすめだけの記録は今までどおり
const CARD_SRC_RE = /^(card|area)$/;
const RECO_CARD_SRC_RE = /^reco(:[a-z]{1,12})? (card|area)$/;
// id と鍵の形（監査①S2・2026-10-24）。id は画面の属性や検索にそのまま入るので、係以外の人が新しく作るものは、
// 英数字・_・.・- だけにする（アプリが作る id はすべてこの形。今あるデータと係の操作は変えない）
const ID_RE = /^[\w.\-]{1,40}$/;
// 家につながった印（拒否・注意・受け持ち・引き継ぎ）の鍵「家id|部屋」。部屋の名前に、画面で問題になる文字（< > " ' & |）と制御文字を使わない
const KEY_RE = /^[\w.\-]{1,40}\|[^<>"'&|\u0000-\u001f\u007f]{0,12}$/;
const UNIT_BAD_RE = /[<>"'&|\u0000-\u001f\u007f]/;

/* =========================================================
   言語（スプレッドシートのメニュー・案内）／ Idioma de los menús
   ========================================================= */
function uiLang_() {
  try {
    const c = CacheService.getScriptCache().get('ui_lang');
    if (c) return c;
    const pv = props_().getProperty('UI_LANG');
    const v = pv === 'es' ? 'es' : pv === 'ja' ? 'ja' : 'both'; // まだ決めていないときは、両方の言葉で出す
    CacheService.getScriptCache().put('ui_lang', v, 600);
    return v;
  } catch (e) { return 'ja'; }
}
/** 日本語とスペイン語のどちらかを返す */
function T_(ja, es) { const l = uiLang_(); return l === 'es' ? es : l === 'both' ? ja + ' / ' + es : ja; }
function setLangJa() { setLang_('ja'); }
function setLangEs() { setLang_('es'); }
function setLang_(l) {
  props_().setProperty('UI_LANG', l);
  try { CacheService.getScriptCache().remove('ui_lang'); } catch (e) { /* 何もしない */ }
  onOpen();
  SpreadsheetApp.getUi().alert(l === 'es' ? 'Los menús ahora están en español.' : 'メニューを日本語にしました。');
}

/* =========================================================
   受け付け
   ========================================================= */
function doGet(e) {
  console.log('受付 GET' + (e && e.parameter && Object.keys(e.parameter).length ? '（' + Object.keys(e.parameter).join(',') + '）' : ''));
  return json_({ ok: true, app: 'kuiki-map', via: 'GET', time: new Date().toISOString() });
}

function doPost(e) {
  ensureTokenHash_(); // users の招待コードを照合値にする（はじめの1回だけ動く）
  // 紙の予備（S-12・S-13 のPDF）は大きいので、ほかの受け付けとは分けて受け取る（pdf-backup.gs）
  if (e && e.parameter && e.parameter.pdf === '1') {
    if (typeof pdfBackupPost_ !== 'function') return json_({ ok: false, error: 'unknown_action' });
    return json_(pdfBackupPost_(e));
  }
  const body = e && e.postData ? e.postData.contents : '';
  if (!body || body.length > 800000) return json_({ ok: false, error: 'bad_request' });
  let req;
  try { req = JSON.parse(body); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  console.log('受付 ' + req.action + (req.part ? '：' + req.part + (req.offset ? '@' + req.offset : '') : ''));

  // 名前の一覧をえらぶ以前の方式（join_list・join_request）は廃止。共通リンクが外に出ても名簿が見えないように（監査S16）
  if (req.action === 'join_list' || req.action === 'join_request') return json_({ ok: false, error: 'unknown_action' });
  // ログインなしで使える受付は、1分あたりの回数を数え、多すぎるときは断る（監査P2）
  if (['join_status', 'join_scan', 'join_hint', 'home_claim'].indexOf(req.action) >= 0) {
    if (!rateOk_(req.action)) return json_({ ok: false, error: 'slow' });
    return json_(req.action === 'home_claim' ? homeClaim_(req) : joinApi_(req));
  }

  const user = findUser_(req.token);
  if (!user) return json_({ ok: false, error: 'auth' });
  if (typeof robotBlocked_ === 'function' && robotBlocked_(user, req)) return json_({ ok: false, error: 'robot' });

  try {
    if (req.action === 'home_code') {
      const code = newToken_().slice(0, 32);
      // carry：Safari に保存している本人の記録（奉仕時間・予定など）。ホーム画面のアプリに持っていくため、15分だけ預かる（M13・2026-10-30）
      // キャッシュの1件の上限（100KB）をこえて預けられないときは、記録を持っていかずにコードだけ作る（ホーム画面への追加は止めない）
      // 預かるのは、画面で暗号にした形（v1.…）だけ。鍵はリンクにだけ入り、サーバーには来ないので、サーバーは中身を読めない（組C 監査 H3）
      const carry = typeof req.carry === 'string' && req.carry.length <= 30000 && /^v1\.[\w-]+\.[\w-]+$/.test(req.carry) ? req.carry : '';
      try { CacheService.getScriptCache().put('home_' + code, JSON.stringify({ uid: user.id, carry: carry }), 900); }
      catch (eC) { CacheService.getScriptCache().put('home_' + code, JSON.stringify({ uid: user.id }), 900); }
      return json_({ ok: true, code: code });
    }
    if (req.action === 'memo_key' || req.action === 'memo_sync') {
      if (typeof memoApi_ !== 'function') return json_({ ok: false, error: 'unknown_action' });
      return json_(memoApi_(user, req));
    }
    if (req.action === 'lm_pull' || req.action === 'lm_save' || req.action === 'lm_del') { // 地図の目印（landmarks.gs）
      if (typeof lmApi_ !== 'function') return json_({ ok: false, error: 'unknown_action' });
      return json_(lmApi_(user, req));
    }
    if (req.action === 'user_set' || req.action === 'user_add' || req.action === 'user_link' || req.action === 'user_bulk' || req.action === 'user_yomi') {
      if (user.role !== 'admin') return json_({ ok: false, error: 'admin' });
      return json_(userAdminApi_(user, req));
    }
    // 区域係：点検リスト・設定の変更履歴・整理とバックアップの状態（同期の仕組みには乗せない）
    if (req.action === 'ops' || req.action === 'ops_check' || req.action === 'ops_ck' || req.action === 'ops_log') {
      if (user.role !== 'admin') return json_({ ok: false, error: 'admin' });
      return json_(opsApi_(user, req));
    }
    // 区域係：エクセルの取り込みで、住所から位置を調べる（ブラウザから国土地理院に直接聞けないときだけ使う）
    if (req.action === 'geocode') {
      if (user.role !== 'admin') return json_({ ok: false, error: 'admin' });
      return json_(geocodeApi_(req));
    }
    // 区域係：区域の線をまとめて新しくしたあと、家の区域をサーバーで決め直す（3万件の家を画面から送らないため）
    if (req.action === 'reassign') {
      if (user.role !== 'admin') return json_({ ok: false, error: 'admin' });
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
      try { return json_(Object.assign({ ok: true }, reassignCore_(false))); } finally { lock.releaseLock(); }
    }
    if (req.action === 'devices' || req.action === 'device_decide' || req.action === 'join_reset') {
      if (user.role !== 'admin') return json_({ ok: false, error: 'admin' });
      return json_(deviceAdminApi_(user, req));
    }
    // こまったこと・提案（iken.gs。一覧・状態の変更は区域係だけ）
    if (String(req.action || '').indexOf('iken_') === 0) {
      if (typeof ikenApi_ !== 'function') return json_({ ok: false, error: 'unknown_action' });
      return json_(ikenApi_(user, req));
    }
    // 奉仕報告を S21 に送る（s21.gs。本人の分だけ。係は連携の設定）
    if (String(req.action || '').indexOf('s21_') === 0) {
      if (typeof s21Api_ !== 'function') return json_({ ok: false, error: 'unknown_action' });
      return json_(s21Api_(user, req));
    }
    const since = req.since === undefined || req.since === null || req.since === '' ? null : Number(req.since);
    if (req.action === 'load') {
      if (req.part) {
        const pr = Object.assign({ ok: true }, partFor_(user, String(req.part), Number(req.offset) || 0, req));
        if (String(req.part) === 'meta') { const wx = wxForResponse_(); if (wx) pr.wx = wx; } // 雨の日（weather.gs）
        return json_(pr);
      }
      const ld = Object.assign({ ok: true }, (since !== null && deltaFor_(user, since)) || { mode: 'stale', seq: seqInfo_().seq });
      { const wx = wxForResponse_(); if (wx) ld.wx = wx; }
      return json_(ld);
    }
    if (req.action === 'sync') {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
      let res;
      try {
        res = applyChanges_(user, req.changes || {}, { re: !!req.re, ct: req.ct });
      } finally {
        lock.releaseLock();
      }
      const back = (since !== null && deltaFor_(user, since)) || { mode: 'stale', seq: seqInfo_().seq };
      const out = Object.assign({ ok: true, rejected: res.rejected, fix: res.fix, fixAll: res.fixAll }, back);
      if (res.skew) out.skew = res.skew; // 端末の時計のずれ（分）。画面が「スマホの時刻を確かめてください」と出す
      return json_(out);
    }
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'server' });
  }
}

function json_(o) {
  if (o && typeof o === 'object') o.rid = Utilities.getUuid();
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
   シートの読み書き（id / data(JSON) / 更新日時 / 更新した人）
   ========================================================= */
function book_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function dataSheet_(name) {
  let sh = book_().getSheetByName(name);
  if (!sh) {
    sh = book_().insertSheet(name);
    sh.getRange(1, 1, 1, 4).setValues([['id', 'data', '更新日時', '更新した人']]);
    sh.setFrozenRows(1);
    sh.getRange('A:B').setNumberFormat('@');
  }
  return sh;
}

function parseJson_(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

function readCol_(name) {
  const sh = dataSheet_(name);
  const n = sh.getLastRow();
  const m = new Map();
  if (n < 2) return m;
  sh.getRange(2, 1, n - 1, 4).getValues().forEach(function (r, i) {
    if (r[0] === '' || r[1] === '') return;
    const data = parseJson_(r[1], undefined);
    if (data === undefined) { console.warn('読めない行', name, i + 2); return; }
    m.set(String(r[0]), { row: i + 2, data: data, at: r[2], by: String(r[3]) });
  });
  return m;
}

/** ups: [[id, data], ...]  dels: [id, ...] */
function writeCol_(name, map, ups, dels, uid, extraRows) {
  if (!ups.length && !dels.length) return;
  const sh = dataSheet_(name);
  const now = new Date();
  const appends = [];
  const start = sh.getLastRow() + 1;
  ups.forEach(function (p) {
    const id = p[0], data = p[1];
    const row = [id, JSON.stringify(data), now, uid];
    const cur = map.get(id);
    if (cur && cur.row > 0) {
      sh.getRange(cur.row, 1, 1, 4).setValues([row]);
      cur.data = data; cur.at = now; cur.by = uid;
    } else if (cur) {
      appends[cur.appendIndex] = row;
      cur.data = data;
    } else {
      map.set(id, { row: -1, appendIndex: appends.length, data: data, at: now, by: uid });
      appends.push(row);
    }
  });
  if (appends.length) {
    sh.getRange(start, 1, appends.length, 4).setValues(appends);
    map.forEach(function (x) { if (x.row === -1) { x.row = start + x.appendIndex; delete x.appendIndex; } });
  }
  const rows = dels
    .map(function (id) { return map.get(id); })
    .filter(function (x) { return x && x.row > 0; })
    .map(function (x) { return x.row; })
    .concat(extraRows || [])
    .filter(function (r, i, a) { return a.indexOf(r) === i; })
    .sort(function (a, b) { return b - a; });
  dels.forEach(function (id) { map.delete(id); });
  if (rows.length > 50 && !map.partial) {
    rewriteCol_(name, map);
  } else {
    if (rows.length) deleteRowsFast_(sh, rows);
    if (rows.length) { if (map.partial) map.clear(); else reindex_(map, name); }
  }
  journal_(ups.map(function (p) { return [name, p[0], JSON.stringify(p[1])]; })
    .concat(dels.map(function (id) { return [name, id, '']; })));
}

/** 同じ番号の行がほかにもあれば、その行番号を返す（消す行と同じ番号の、2行め以降） */
function dupRows_(name, ids, map) {
  const sh = dataSheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  const col = sh.getRange(2, 1, n - 1, 1), out = [];
  ids.forEach(function (id) {
    const keep = map.get(id) ? map.get(id).row : 0;
    col.createTextFinder(String(id)).matchEntireCell(true).findAll().forEach(function (c) {
      const r = c.getRow();
      if (r !== keep) out.push(r);
    });
  });
  return out;
}

/** 1件だけ探す（件数の多い訪問記録・家で、シート全体を読まないため） */
function findRow_(name, id) {
  const sh = dataSheet_(name);
  const n = sh.getLastRow();
  if (n < 2) return null;
  const cell = sh.getRange(2, 1, n - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!cell) return null;
  const r = cell.getRow();
  const v = sh.getRange(r, 1, 1, 4).getValues()[0];
  const data = parseJson_(v[1], undefined);
  return data === undefined ? null : { row: r, data: data, at: v[2], by: String(v[3]) };
}

function houseData_(ctx, id) {
  id = String(id || '');
  if (!id) return null;
  if (ctx.hcache && ctx.hcache.has(id)) return ctx.hcache.get(id);
  const m = ctx.cols.houses;
  if (m && !m.partial && m.get(id)) return m.get(id).data;
  const f = findRow_('houses', id);
  const d = f ? f.data : null;
  (ctx.hcache || (ctx.hcache = new Map())).set(id, d);
  return d;
}
function prefetchHouses_(ctx, ids) {
  ctx.hcache = ctx.hcache || new Map();
  const want = {};
  let n = 0;
  ids.forEach(function (id) { if (id && !ctx.hcache.has(id) && !want[id]) { want[id] = true; n++; } });
  if (n <= 3) return;
  const sh = dataSheet_('houses'), last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      const id = String(r[0]);
      if (want[id]) ctx.hcache.set(id, parseJson_(r[1], null));
    });
  }
  Object.keys(want).forEach(function (id) { if (!ctx.hcache.has(id)) ctx.hcache.set(id, null); });
}

/* ---- 変更の記録（journal）：番号 / 種類 / id / data（空＝削除） / 日時 ---- */
function props_() { return PropertiesService.getScriptProperties(); }
function seqInfoFresh_() {
  const all = props_().getProperties();
  const info = { seq: Number(all.SEQ || 0), base: Number(all.JBASE || 1) };
  try { CacheService.getScriptCache().put('seqinfo_v1', JSON.stringify(info), SEQ_READ_SEC); } catch (e) { /* 何もしない */ }
  return info;
}
function seqInfo_() {
  const hit = cacheGet_('seqinfo_v1');
  return hit && isFinite(hit.seq) ? hit : seqInfoFresh_();
}
function seqSave_(info) {
  props_().setProperties({ SEQ: String(info.seq), JBASE: String(info.base) });
  try { CacheService.getScriptCache().put('seqinfo_v1', JSON.stringify(info), SEQ_CACHE_SEC); }
  catch (e) { try { CacheService.getScriptCache().remove('seqinfo_v1'); } catch (e2) { /* 何もしない */ } }
}
function journalSheet_() {
  let sh = book_().getSheetByName(JOURNAL);
  if (!sh) {
    sh = book_().insertSheet(JOURNAL);
    sh.getRange(1, 1, 1, 5).setValues([['seq', '種類', 'id', 'data', '日時']]);
    sh.setFrozenRows(1);
    sh.getRange('C:D').setNumberFormat('@');
  }
  return sh;
}
function journal_(entries) {
  if (!entries.length) return;
  const sh = journalSheet_();
  const info = seqInfoFresh_();
  if (sh.getLastRow() !== Math.max(1, info.seq - info.base + 2)) {
    resetJournal_();
    return journal_(entries);
  }
  const now = new Date();
  const rows = entries.map(function (e, i) { return [info.seq + 1 + i, e[0], e[1], e[2], now]; });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  info.seq += rows.length;
  if (sh.getLastRow() - 1 > JOURNAL_MAX) {
    const drop = Math.floor(JOURNAL_MAX / 2);
    if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
    sh.deleteRows(2, drop);
    info.base += drop;
  }
  seqSave_(info);
}
function resetJournal_() {
  const sh = journalSheet_();
  if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
  const n = sh.getLastRow();
  if (n >= 2) {
    try {
      sh.deleteRows(2, n - 1);
    } catch (e) {
      console.warn(e);
      sh.getRange(2, 1, n - 1, 5).clearContent();
    }
  }
  const info = seqInfoFresh_();
  info.seq += 1;
  info.base = info.seq + 1;
  seqSave_(info);
}

function reindex_(map, name) {
  const fresh = readCol_(name);
  map.clear();
  fresh.forEach(function (v, k) { map.set(k, v); });
}

/**
 * シートの中身を map で置きかえる。
 * 【安全のため】先に新しい内容を上から書き、そのあとで余った行だけを空にする。
 * （先に全部を空にすると、途中で時間切れになったときに記録が全部消えるため）
 * 途中で止まっても、古い内容が残るだけで、空にはならない。
 */
function rewriteCol_(name, map) {
  const sh = dataSheet_(name);
  const n = sh.getLastRow();
  const rows = [];
  map.forEach(function (x, id) { x.row = rows.length + 2; rows.push([id, JSON.stringify(x.data), x.at || new Date(), x.by || '']); });
  if (rows.length) {
    if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
  }
  if (n > rows.length + 1) sh.getRange(rows.length + 2, 1, n - rows.length - 1, 4).clearContent();
}

/** 行番号の一覧を、つながった行ごとにまとめて消す（1行ずつ消すと遅く、時間切れになる） */
function deleteRowsFast_(sh, rows) {
  const r = rows.slice().sort(function (a, b) { return b - a; });
  let i = 0;
  while (i < r.length) {
    let j = i;
    while (j + 1 < r.length && r[j + 1] === r[j] - 1) j++;
    sh.deleteRows(r[j], j - i + 1);
    i = j + 1;
  }
}

/* =========================================================
   使う人
   ========================================================= */
const USER_HEAD = ['id', '名前 / Nombre', '役割 / Rol', '招待コード / Código', '有効 / Activo', '設定', '登録日 / Alta', 'グループ / Grupo', '監督 / Superint.', '司会者 / Conductor', 'よみ / Lectura', '家と拒否の管理 / Gestión'];
const YOMI_COL = 11; // よみ（ひらがな）。区域係が入れる。名前の一覧をあいうえお順にし、ひらがなでも探せるようにする（2026-11-05）
const MGR_COL = 12; // 家と拒否の管理（mgr）。区域係以外に、家の削除・拒否の削除・家の編集を任せる（2026-10-31 指示書・よみの列の右）

function usersSheet_() {
  let sh = book_().getSheetByName(USERS);
  if (!sh) {
    sh = book_().insertSheet(USERS, 0);
    sh.getRange(1, 1, 1, USER_HEAD.length).setValues([USER_HEAD]);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('D:D').setNumberFormat('@');
    sh.getRange('C2:C').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList([ROLE_PUB, ROLE_ADMIN, ROLE_PUB_ES, ROLE_ADMIN_ES], true).build());
    sh.setColumnWidth(4, 120);
  }
  // 前からある users シートの列が足りないとき（よみの11列目）：右に列を足す。足りないまま読むと、全員が開けなくなる（監査 よみ M-1）
  if (sh.getMaxColumns() < USER_HEAD.length) sh.insertColumnsAfter(sh.getMaxColumns(), USER_HEAD.length - sh.getMaxColumns());
  ensureMgrCol_(sh);
  return sh;
}
/* users シートの L 列（12列目）「家と拒否の管理」（mgr）。前からあるシートには、末尾に足すだけ（既存の列・行は動かさない。H1）。
   見出しがなければ1回だけ書き、人の行にチェックボックスを付ける（はじめは全員チェックなし）。確かめは6時間に1回 */
function ensureMgrCol_(sh) {
  try {
    if (CacheService.getScriptCache().get('users_mgrcol')) return;
    const c = MGR_COL;
    if (sh.getMaxColumns() < c) sh.insertColumnsAfter(sh.getMaxColumns(), c - sh.getMaxColumns());
    if (String(sh.getRange(1, c).getValue() || '').trim() === '') {
      const n = sh.getLastRow();
      // 見出しが空でも、下に何か書いてある列は使わない（insertCheckboxes は値を false にするため、ほかの使い方の値を消さない。監査 M-3）
      if (n >= 2 && sh.getRange(2, c, n - 1, 1).getValues().some(function (r) { return r[0] !== '' && r[0] !== null; })) {
        console.warn('users の12列目に見出しのない値があるため、家と拒否の管理の列を作りませんでした');
      } else {
        sh.getRange(1, c).setValue(USER_HEAD[c - 1]);
        if (n >= 2) sh.getRange(2, c, n - 1, 1).insertCheckboxes();
      }
    }
    CacheService.getScriptCache().put('users_mgrcol', '1', 21600);
  } catch (e) { console.warn('家と拒否の管理の列を確かめられませんでした：' + e); }
}
function isAdminRole_(v) { const s = String(v).trim(); return s === ROLE_ADMIN || s === ROLE_ADMIN_ES; }
/* 家の削除・拒否の削除・家の編集ができる人：区域係、または「家と拒否の管理」が付いた有効な人（H4・H7）。
   貸し出し・設定・点検・S-12／S-13・目印・名簿・バックアップなどの判定には使わない（H5）。ここの判定だけを広げる */
function isMgr_(user) { return !!user && (user.role === 'admin' || (user.mgr === true && user.active === true)); }
function roleValue_(isAdmin) { return uiLang_() === 'es' ? (isAdmin ? ROLE_ADMIN_ES : ROLE_PUB_ES) : (isAdmin ? ROLE_ADMIN : ROLE_PUB); }

/* ---- 速さのための一時保存（キャッシュ） ---- */
function cacheGet_(k) { try { const v = CacheService.getScriptCache().get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cachePut_(k, v) { try { const t = JSON.stringify(v); if (t.length < 90000) CacheService.getScriptCache().put(k, t, 30); } catch (e) { /* ためられなくても動く */ } }
function usersAll_() {
  const hit = cacheGet_('users_v1');
  if (hit) return hit;
  const t0 = Date.now();
  const sh = usersSheet_();
  const n = sh.getLastRow();
  if (n < 2) return [];
  const all = sh.getRange(1, 1, n, USER_HEAD.length).getValues();
  const yomiOk = String(all[0][YOMI_COL - 1]).trim() === USER_HEAD[YOMI_COL - 1]; // 11列目の見出しが「よみ」のときだけ、よみとして読む（ほかの使い方をしていた列を配らない・監査 よみ M-2）
  const mgrOk = String(all[0][MGR_COL - 1]).trim() === USER_HEAD[MGR_COL - 1]; // 12列目の見出しが「家と拒否の管理」のときだけ読む（ほかの使い方をしていた列で権限を広げない）
  const list = all.slice(1).map(function (r, i) {
    return {
      row: i + 2,
      id: String(r[0]).trim(),
      name: String(r[1]).trim(),
      role: isAdminRole_(r[2]) ? 'admin' : 'pub',
      token: String(r[3]).trim(),
      active: r[4] === true,
      prefs: parseJson_(r[5], {}) || {},
      group: normGroup_(r[7]),
      overseer: r[8] === true,
      leader: r[9] === true,
      yomi: yomiOk ? normYomi_(r[YOMI_COL - 1]) : '',
      mgr: mgrOk && r[MGR_COL - 1] === true, // 家と拒否の管理（区域係以外に任せる。区域係本人には意味がない）
    };
  }).filter(function (u) { return u.id && u.name; });
  // 読んでいるあいだに名簿が書きかえられたときは、一時保存しない（古い名簿が30秒残り、画面の変更が元にもどって見えるのを防ぐ）
  let w = 0;
  try { w = Number(CacheService.getScriptCache().get('users_w')) || 0; } catch (e) { w = 0; }
  if (!(w >= t0 - 2000)) cachePut_('users_v1', list);
  return list;
}

/* ---- 招待コードの持ち方 ----
   users シートには、招待コードそのものではなく「照合値」（h: ＋ ハッシュ）だけを置く。
   シートを見られても、その値ではログインできない（照合値を送っても、もう一度ハッシュにするので合わない）。
   今までの招待リンクは、照合値が同じになるので、そのまま使える。 */
const TOKEN_HASH_PREFIX = 'h:';
function userTokenKey_(token) { return TOKEN_HASH_PREFIX + hash_(token); }
function isHashedToken_(v) { return String(v || '').indexOf(TOKEN_HASH_PREFIX) === 0; }
/** シートの値（照合値、または移行前の古い形）と、送られてきた招待コードが合うか */
function userTokenMatch_(stored, token, key) {
  const s = String(stored || '');
  if (!s || !token) return false;
  if (isHashedToken_(s)) return s === (key || userTokenKey_(token));
  return s.length >= 20 && s === String(token); // 移行前の古い形（ensureTokenHash_ で、すぐに照合値に置きかわる）
}
/** users の招待コードを照合値に置きかえる（1回だけ。doPost のはじめに呼ぶ）。ロックが取れなければ、次の問い合わせで行う */
function ensureTokenHash_() {
  try {
    if (CacheService.getScriptCache().get('tokhash_ok')) return;
    if (props_().getProperty('USER_TOKENS_HASHED') === '2') { CacheService.getScriptCache().put('tokhash_ok', '1', 21600); return; }
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try { hashUserTokens_(); } finally { lock.releaseLock(); }
    CacheService.getScriptCache().put('tokhash_ok', '1', 21600);
  } catch (e) { console.warn('招待コードの置きかえ：' + e); }
}
/** 本体（ロックは呼ぶ側で持つ）。置きかえた数を返す */
function hashUserTokens_() {
  const sh = usersSheet_();
  sh.getRange('D:D').setNumberFormat('@');
  try { devicesSheet_().getRange('J:J').setNumberFormat('@'); } catch (e) { /* 何もしない */ }
  const n = sh.getLastRow();
  let changed = 0;
  if (n >= 2) {
    const vals = sh.getRange(2, 4, n - 1, 1).getValues();
    vals.forEach(function (r) {
      const s = String(r[0] || '').trim();
      if (s && !isHashedToken_(s) && s.length >= 20) { r[0] = userTokenKey_(s); changed++; }
    });
    if (changed) sh.getRange(2, 4, n - 1, 1).setValues(vals);
  }
  props_().setProperty('USER_TOKENS_HASHED', '2');
  cacheDrop_();
  if (changed) console.log('招待コードを照合値に置きかえました：' + changed + '人');
  return changed;
}
/** シートに書く文字：先頭の = + - @ を外す（スプレッドシートが式として動かさないように） */
function sheetSafe_(s, max) {
  return str_(s, max || 200).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^[=+\-@\s]+/, '').trim();
}

function findUser_(token) {
  if (!token || String(token).length < 20) return null;
  const t = String(token);
  const users = usersAll_();
  const key = userTokenKey_(t);
  const legacy = users.filter(function (u) { return u.active && userTokenMatch_(u.token, t, key); })[0];
  if (legacy) return legacy;
  const h = hash_(t);
  const d = devicesAll_().filter(function (x) { return x.hash === h && x.status === DEV_ACTIVE; })[0];
  if (!d) return null;
  const u = users.filter(function (x) { return x.active && x.id === d.uid; })[0];
  if (!u) return null;
  touchDevice_(d);
  return u;
}

/* よみ：カタカナ・半角カナはひらがなに直し、ひらがなと「ー」だけを残す（空白やほかの文字は捨てる）。30文字まで */
function normYomi_(v) {
  return String(v == null ? '' : v).normalize('NFKC')
    .replace(/[\u30a1-\u30f6]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); })
    .replace(/[^\u3041-\u3096\u30fc]/g, '').slice(0, 30);
}
/** よみの列を使えるようにする（前からある users シートは見出しが10列だけ）。
    見出しが空で、2行目から下も空なら見出しを書く。ほかの見出し・値があるときは、係がほかに使っている列なので書かない（false・監査 よみ M-2） */
function yomiHead_(sh) {
  const c = sh.getRange(1, YOMI_COL), h = String(c.getValue()).trim();
  if (h === USER_HEAD[YOMI_COL - 1]) return true;
  if (h !== '') return false;
  const n = sh.getLastRow();
  if (n >= 2 && sh.getRange(2, YOMI_COL, n - 1, 1).getValues().some(function (r) { return String(r[0]).trim() !== ''; })) return false;
  c.setValue(USER_HEAD[YOMI_COL - 1]);
  return true;
}
function normGroup_(g) { return String(g || '').normalize('NFKC').replace(/\s+/g, '').slice(0, 30); }
function canGroupTerr_(u) { return !!u.group && (!!u.overseer || !!u.leader); }

/* ---- 区域係：人の追加・役割・グループ・招待リンク ---- */
function userAdminApi_(user, req) {
  if (req.action === 'user_add') return userAdd_(req);
  if (req.action === 'user_link') return userLink_(req);
  if (req.action === 'user_yomi') return userYomi_(user, req);
  if (req.action === 'user_bulk') return typeof userBulk_ === 'function' ? userBulk_(user, req) : { ok: false, error: 'unknown_action' }; // 名簿の取り込み（meibo.gs）
  return userSet_(user, req);
}
function inviteUrl_(token) {
  const base = props_().getProperty('PAGES_URL');
  if (!base) return '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token);
}
function userAdd_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const name = sheetSafe_(req.name, 30);
    if (!name) return { ok: false, error: 'name' };
    // 送り直し（返事が届かず、係がもう一度押した）：同じ送信の番号(rid)なら、前に作った人をそのまま返す（同じ人を2人にしない・点検②V11）
    const rid = String(req.rid || '').replace(/[^\w\-]/g, '').slice(0, 40);
    const ck = rid ? 'uadd_' + rid : '';
    if (ck) { const hit = cacheGet_(ck); if (hit && hit.ok) return hit; }
    const u = addUserRow_(name, String(req.role || '') === 'admin');
    const row = usersAll_().filter(function (x) { return x.id === u.id; })[0];
    if (row) usersSheet_().getRange(row.row, 8, 1, 3).setValues([[normGroup_(req.group), !!req.overseer, !!req.leader]]);
    cacheDrop_();
    const res = { ok: true, id: u.id, url: inviteUrl_(u.token) }; // u.token は作ったばかりの招待コード（シートには照合値だけ）
    if (ck) { try { CacheService.getScriptCache().put(ck, JSON.stringify(res), 900); } catch (e) { /* 覚えられなくても動く */ } }
    return res;
  } finally { lock.releaseLock(); }
}
function userLink_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const u = usersAll_().filter(function (x) { return x.id === String(req.id || ''); })[0];
    if (!u) return { ok: false, error: 'not_found' };
    // 招待コードはシートに置いていない（照合値だけ）ので、今のリンクは見せられない。作り直したときだけ、新しいリンクを返す
    if (!req.reissue) return { ok: true, url: '', need: 'reissue' };
    const token = newToken_();
    usersSheet_().getRange(u.row, 4).setValue(userTokenKey_(token));
    cacheDrop_();
    return { ok: true, url: inviteUrl_(token) };
  } finally { lock.releaseLock(); }
}
function userSet_(user, req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const u = usersAll_().filter(function (x) { return x.id === String(req.id || ''); })[0];
    if (!u) return { ok: false, error: 'not_found' };
    if (u.id === user.id && (req.role === 'pub' || req.active === false)) return { ok: false, error: 'self' };
    const sh = usersSheet_();
    sh.getRange(u.row, 8, 1, 3).setValues([[normGroup_(req.group), !!req.overseer, !!req.leader]]);
    if (req.role === 'admin' || req.role === 'pub') sh.getRange(u.row, 3).setValue(roleValue_(req.role === 'admin'));
    // よみは、送られてきたときだけ書く（古い版の画面は yomi を送らないので、消さない）。
    // 書いたら yomi: 1 を返す（画面は、これがなければ「よみは保存できなかった」と知らせる・監査 よみ M-3）
    let yomiDone = 0;
    if (Object.prototype.hasOwnProperty.call(req, 'yomi')) {
      // 列がほかに使われているときは、よみだけ書かない（ほかの項目は保存する）
      if (yomiHead_(sh)) { sh.getRange(u.row, YOMI_COL).setValue(normYomi_(req.yomi)); yomiDone = 1; }
    }
    // 家と拒否の管理（mgr）：区域係だけが変えられる（user_set は係だけが呼べる。H2）。区域係には付けない（H3）。送らない古い画面では、今のまま（H10）
    // 12列目の見出しが「家と拒否の管理」のときだけ書く（ほかの使い方をしている列をこわさない）。書いたら mgr: 1 を返す（画面は、なければ「保存できなかった」と知らせる）
    let mgrDone = 0;
    const mgrHd = String(sh.getRange(1, MGR_COL).getValue() || '').trim() === USER_HEAD[MGR_COL - 1];
    if (mgrHd && typeof req.mgr === 'boolean') { sh.getRange(u.row, MGR_COL).setValue((req.role || u.role) === 'admin' ? false : req.mgr); mgrDone = 1; } // 新しい役割で決める（係を伝道者にもどすときに付けられる。監査 L-1）
    else if (mgrHd && req.role === 'admin') sh.getRange(u.row, MGR_COL).setValue(false);
    if (req.active === false) {
      sh.getRange(u.row, 5).setValue(false);
      if (typeof memoWipeUser_ === 'function') memoWipeUser_(u.id);
    }
    cacheDrop_();
    const out = { ok: true };
    if (mgrDone) out.mgr = 1;
    if (yomiDone) out.yomi = 1;
    else if (Object.prototype.hasOwnProperty.call(req, 'yomi')) out.yomi_col = 1; // よみを送ったのに書けなかった：11列目がほかに使われている（再監査 Low-1）
    return out;
  } finally { lock.releaseLock(); }
}

/** よみをまとめて入れる（区域係）。items：[{ id, yomi }]。変わった人の行だけを書き、operations に1行残す */
function userYomi_(user, req) {
  const items = Array.isArray(req.items) ? req.items.slice(0, 400) : [];
  if (!items.length) return { ok: false, error: 'empty' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'busy' };
  try {
    const sh = usersSheet_();
    if (!yomiHead_(sh)) return { ok: false, error: 'yomi_col' }; // 11列目がほかに使われている
    cacheDrop_(); // 見出しを書いたばかりなら、よみとして読み直す
    const byId = {};
    usersAll_().forEach(function (u) { byId[u.id] = u; });
    let n = 0;
    const skipped = [];
    items.forEach(function (it, i) {
      const u = byId[String(it && it.id || '')];
      if (!u) { skipped.push({ i: i, why: 'not_found' }); return; }
      const y = normYomi_(it.yomi);
      if (y === u.yomi) return; // 同じなら書かない（2回送っても同じ）
      sh.getRange(u.row, YOMI_COL).setValue(y);
      u.yomi = y;
      n++;
    });
    cacheDrop_();
    if (n) {
      try {
        const os = opsSheet_(), row = Math.max(2, os.getLastRow() + 1);
        if (row > os.getMaxRows()) os.insertRowsAfter(os.getMaxRows(), 50);
        os.getRange(row, 1, 1, 5).setValues([[Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), user.name, 'よみの入力', '', n + '人']]);
      } catch (e) { console.warn('よみの入力の記録を残せませんでした：' + e); }
    }
    return { ok: true, n: n, skipped: skipped };
  } finally { lock.releaseLock(); }
}

function cleanPrefs_(o) {
  const p = {};
  if (o && Array.isArray(o.slots)) p.slots = o.slots.filter(function (s) { return SLOT_NAMES.indexOf(s) >= 0; });
  if (o && (o.roundMode === 'reco' || o.roundMode === 'progress')) p.roundMode = o.roundMode;
  return p;
}

function savePrefs_(user, prefs) {
  usersSheet_().getRange(user.row, 6).setValue(JSON.stringify(Object.assign({}, user.prefs, prefs)));
  cacheDrop_();
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function addUserRow_(name, isAdmin) {
  const sh = usersSheet_();
  const id = 'u' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  const token = newToken_();
  const row = sh.getLastRow() + 1;
  name = sheetSafe_(name, 30) || '（名前なし）';
  // シートには照合値だけを書く。招待コードそのものは、呼んだ側が1回だけリンクにして見せる
  sh.getRange(row, 1, 1, USER_HEAD.length).setValues([[id, name, roleValue_(isAdmin), userTokenKey_(token), true, '{}', new Date(), '', false, false, '', false]]);
  sh.getRange(row, 5).insertCheckboxes().check();
  sh.getRange(row, 9, 1, 2).insertCheckboxes();
  sh.getRange(row, MGR_COL).insertCheckboxes();
  cacheDrop_();
  return { id: id, name: name, token: token };
}

/* =========================================================
   スマホの登録（共通リンク＋区域係の承認）
   ========================================================= */
const DEVICE_HEAD = ['id', '照合値', '使う人id', '状態', '端末', '申請日時', '決めた日時', '決めた人', '最後に使った日時', '名乗った名前'];

function devicesSheet_() {
  let sh = book_().getSheetByName(DEVICES);
  if (!sh) {
    sh = book_().insertSheet(DEVICES);
    sh.getRange(1, 1, 1, DEVICE_HEAD.length).setValues([DEVICE_HEAD]);
    sh.setFrozenRows(1);
    sh.getRange('A:I').setNumberFormat('@');
    sh.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([DEV_PENDING, DEV_ACTIVE, DEV_DENIED, DEV_REVOKED], true).build());
    sh.hideColumns(2);
  }
  return sh;
}
function checkCode_(hash) {
  let n = 7;
  const s = String(hash || '');
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 10000;
  return ('000' + n).slice(-4);
}
function hash_(token) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8));
}
function touchDevice_(d) {
  const last = Date.parse(d.seen);
  if (isFinite(last) && Date.now() - last < 12 * 3600000) return;
  devicesSheet_().getRange(d.row, 9).setValue(nowIso_());
  cacheDrop_();
}
const pendingAlive_ = function (d) { return d.status === DEV_PENDING && Date.now() - Date.parse(d.reqAt) < PENDING_DAYS * DAY_MS; };

function joinCode_(create) {
  let c = props_().getProperty('JOIN_CODE') || '';
  if (!c && create) { c = newToken_().slice(0, 32); props_().setProperty('JOIN_CODE', c); }
  return c;
}
function joinUrl_() {
  const base = props_().getProperty('PAGES_URL'), c = joinCode_(false);
  if (!base || !c) return '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'j=' + encodeURIComponent(c);
}
function deviceLabel_(v) {
  const s = String(v || '');
  return ['iPhone', 'iPad', 'Android', 'パソコン'].indexOf(s) >= 0 ? s : 'その他';
}

/* ログインなしの受付の回数制限（監査P2）
   GAS ではだれが送ったか（IPなど）が分からないので、受付の種類ごとに「会衆全体で1分あたり何回まで」と決める。
   ふつうの使い方では届かない数にしてある（承認待ちの画面は3秒ごとに確かめる：30台×20回＝600回/分）。
   数えるのは一時保存（CacheService）。ロックを使わないので、同時に来たときは少しずれるが、連打を止めるには十分。
   join_scan（共通リンクの申し込み）は、説明会で十数人が一斉に QR を読んでも断らないよう30回（2026-10-24・点検③P7）。
   申し込み中の端末の数は、別に PENDING_MAX（30台）で止めている */
const RATE_PER_MIN = { join_scan: 30, join_hint: 30, join_status: 900, home_claim: 20 };
function rateOk_(action) {
  const max = RATE_PER_MIN[action];
  if (!max) return true;
  try {
    const c = CacheService.getScriptCache(), key = 'rl_' + action + '_' + Math.floor(Date.now() / 60000);
    const n = Number(c.get(key) || 0) + 1;
    c.put(key, String(n), 120);
    if (n > max) {
      if (n === max + 1) console.warn('回数制限：' + action + ' が1分に ' + max + ' 回をこえました');
      return false;
    }
    return true;
  } catch (e) { return true; } // 一時保存が使えないときは、止めずに受け付ける
}

function joinApi_(req) {
  try {
    if (req.action === 'join_status') {
      if (!req.token || String(req.token).length < 20) return { ok: false, error: 'auth' };
      const h = hash_(req.token);
      const d = devicesAll_().filter(function (x) { return x.hash === h; })[0];
      if (!d) return { ok: true, status: 'none' };
      const u = usersAll_().filter(function (x) { return x.id === d.uid; })[0];
      let st = 'denied';
      if (d.status === DEV_ACTIVE && u && u.active) st = 'approved';
      else if (pendingAlive_(d)) st = 'pending';
      return { ok: true, status: st };
    }
    if (req.action === 'join_hint') {
      if (!req.token || String(req.token).length < 20) return { ok: false, error: 'auth' };
      const h2 = hash_(req.token);
      const d2 = devicesAll_().filter(function (x) { return x.hash === h2 && x.status === DEV_PENDING; })[0];
      if (!d2) return { ok: false, error: 'state' };
      devicesSheet_().getRange(d2.row, 10).setValue(sheetSafe_(req.name, 30)); // 先頭の = などを外す（シートで式として動かないように）
      cacheDrop_();
      return { ok: true };
    }
    const code = joinCode_(false);
    if (!code || String(req.join || '') !== code) return { ok: false, error: 'join' };
    if (req.action === 'join_scan') {
      const lk = LockService.getScriptLock();
      if (!lk.tryLock(20000)) return { ok: false, error: 'busy' };
      try {
        if (devicesAll_().filter(pendingAlive_).length >= PENDING_MAX) return { ok: false, error: 'busy' };
        const tk = newToken_(), hh = hash_(tk);
        const did = 'd' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
        const dsh = devicesSheet_(), drow = dsh.getLastRow() + 1;
        dsh.getRange(drow, 1, 1, DEVICE_HEAD.length).setValues([[did, hh, '', DEV_PENDING, deviceLabel_(req.device), nowIso_(), '', '', '', '']]);
        cacheDrop_();
        return { ok: true, token: tk, code: checkCode_(hh) };
      } finally { lk.releaseLock(); }
    }
    return { ok: false, error: 'unknown_action' };
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, error: 'server' };
  }
}

function homeClaim_(req) {
  try {
    const key = 'home_' + String(req.code || '').replace(/[^0-9a-f]/gi, '').slice(0, 40);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
    try {
      const hit = cacheGet_(key);
      if (!hit) return { ok: false, error: 'expired' };
      CacheService.getScriptCache().remove(key);
      const u = usersAll_().filter(function (x) { return x.active && x.id === hit.uid; })[0];
      if (!u) return { ok: false, error: 'expired' };
      // 招待コードはシートに置かない（照合値だけ）ので、ホーム画面のアプリには、いつも新しい端末の合いことばを渡す
      const token = newToken_();
      const id = 'd' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
      const sh = devicesSheet_(), row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, DEVICE_HEAD.length).setValues([[id, hash_(token), u.id, DEV_ACTIVE,
        deviceLabel_(req.device) + '（ホーム画面）', nowIso_(), nowIso_(), 'ホーム画面に追加', '', '']]);
      cacheDrop_();
      return { ok: true, token: token, carry: hit.carry || '' };
    } finally { lock.releaseLock(); }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, error: 'server' };
  }
}

function devicesFor_() {
  const names = {};
  usersAll_().forEach(function (u) { names[u.id] = u.name; });
  const list = devicesAll_().filter(function (d) { return d.status === DEV_ACTIVE || pendingAlive_(d); }).map(function (d) {
    return { id: d.id, uid: d.uid, name: d.uid ? (names[d.uid] || '（削除された人）') : '', status: d.status === DEV_ACTIVE ? 'active' : 'pending',
      label: d.label, reqAt: d.reqAt, decAt: d.decAt, seen: d.seen, code: checkCode_(d.hash), hint: d.hint };
  });
  return { ok: true, devices: list, joinUrl: joinUrl_() };
}

function deviceAdminApi_(user, req) {
  if (req.action === 'devices') return devicesFor_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (req.action === 'join_reset') {
      props_().setProperty('JOIN_CODE', newToken_().slice(0, 32));
      return devicesFor_();
    }
    const d = devicesAll_().filter(function (x) { return x.id === String(req.id || ''); })[0];
    if (!d) return { ok: false, error: 'not_found' };
    const dec = String(req.decision || '');
    let st = null;
    if (dec === 'approve' && pendingAlive_(d)) st = DEV_ACTIVE;
    else if (dec === 'deny' && d.status === DEV_PENDING) st = DEV_DENIED;
    else if (dec === 'revoke' && d.status === DEV_ACTIVE) st = DEV_REVOKED;
    if (!st) return { ok: false, error: 'state' };
    let uid = d.uid;
    if (st === DEV_ACTIVE) {
      if (req.uid) {
        const u = usersAll_().filter(function (x) { return x.active && x.id === String(req.uid); })[0];
        if (!u) return { ok: false, error: 'user' };
        uid = u.id;
      } else if (req.newUser && str_(req.newUser.name, 30).trim()) {
        const nu = req.newUser;
        const made = addUserRow_(str_(nu.name, 30).trim(), String(nu.role || '') === 'admin');
        const row = usersAll_().filter(function (x) { return x.id === made.id; })[0];
        if (row) usersSheet_().getRange(row.row, 8, 1, 3).setValues([[normGroup_(nu.group), !!nu.overseer, !!nu.leader]]);
        uid = made.id;
      }
      if (!uid) return { ok: false, error: 'user' };
    }
    devicesSheet_().getRange(d.row, 3, 1, 6).setValues([[uid, st, d.label, d.reqAt, nowIso_(), user.id]]);
    cacheDrop_();
    return devicesFor_();
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================
   住所 → 位置（国土地理院の住所検索）
   ・送るのは住所の文字だけ。名前などは受け取らない
   ・同じ住所は6時間覚えておき、何度も問い合わせない
   ========================================================= */
const GSI_SEARCH = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
function geocodeApi_(req) {
  const qs = (Array.isArray(req.qs) ? req.qs : []).slice(0, 40).map(function (q) { return str_(q, 120).trim(); }).filter(String);
  const cache = CacheService.getScriptCache(), out = {}, need = [];
  const key = function (q) { return 'geo_' + hash_(q).slice(0, 40); };
  qs.forEach(function (q) {
    let hit = null;
    try { hit = cache.get(key(q)); } catch (e) { hit = null; }
    if (hit) out[q] = parseJson_(hit, []); else if (need.indexOf(q) < 0) need.push(q);
  });
  for (let i = 0; i < need.length; i += 10) {
    const part = need.slice(i, i + 10);
    let res = [];
    try { res = UrlFetchApp.fetchAll(part.map(function (q) { return { url: GSI_SEARCH + encodeURIComponent(q), muteHttpExceptions: true }; })); }
    catch (e) { console.warn('住所検索につながりません', e); }
    part.forEach(function (q, k) {
      const r = res[k];
      let v = [];
      if (r && r.getResponseCode() === 200) {
        v = (parseJson_(r.getContentText(), []) || []).slice(0, 5).map(function (f) {
          return { t: f && f.properties ? String(f.properties.title || '') : '', c: f && f.geometry ? f.geometry.coordinates : null };
        });
      }
      out[q] = v;
      try { cache.put(key(q), JSON.stringify(v), 21600); } catch (e) { /* 覚えられなくても動く */ }
    });
    if (i + 10 < need.length) Utilities.sleep(300); // 国土地理院に負担をかけないように
  }
  return { ok: true, results: out };
}

/* =========================================================
   設定
   ========================================================= */
function getSettings_() {
  const hit = cacheGet_('settings_v1');
  if (hit) return Object.assign({}, DEFAULT_SETTINGS, hit, SERVER_CAPS);
  const s = readCol_(SETTINGS).get('settings');
  const v = s ? s.data : {};
  cachePut_('settings_v1', v);
  return Object.assign({}, DEFAULT_SETTINGS, v, SERVER_CAPS);
}

/* このサーバーができること（画面が古いサーバーかどうかを見分ける。保存しない・変えられない）
   capDncQ：訪問しない印（dnc の q。2026-11-05） */
const SERVER_CAPS = { capDncQ: 1, capLang: 1 }; // capLang：外国語の家の言語（langs。2026-11-08）
const SETTING_LIMITS = {
  keepMonths: [6, 36], cacheDays: [5, 60], skipDays: [0, 180], groupMax: [1, 10],
  awayRecentDays: [0, 30], awayCardMax: [0, 50], syncGroupSec: [5, 30], syncNormalSec: [10, 120],
  reqMaxPersonal: [1, 5], reqMaxGroup: [1, 5], holdMaxPersonal: [1, 10], holdMaxGroup: [1, 40], // グループ奉仕の区域：フェーズ1の過渡期は枝番ごとに数えるので40まで
  freeAfterDays: [0, 365], followSkipDays: [0, 365], ageShow: [0, 31], lendDays: [14, 365], awayRetPct: [0, 100],
  recoKinds: [0, 63], recoCount: [1, 5], recoDist: [100, 3000], recoLongDays: [30, 730], recoSkipDays: [0, 60],
  youngW: [0, 40], awayTries: [2, 10], contDays: [0, 365], awayCap: [1, 15],
  extRest: [7, 30], extCap: [1, 5], extDays: [14, 180], extStopBefore: [0, 60], awayDayOnly: [0, 10],
  lowWait: [3, 30], osaeMax: [1, 5], osaeDays: [1, 14], ikenWho: [0, 1], langSkip: [0, 127]
};
const SETTING_FLAGS = { mapStd: true, recAge: true, recInterest: true, skipDone: true, lockOthers: true, groupOn: true, memoShare: true, memoSync: true, awayAllTerr: true, ageShowMode: true,
  kgGoal: true, recoOn: true, recoOthers: true, recoCardOut: true, recoCardBtn: true, autoFree: true, awayExp: true, nightOn: true,
  awayNoRepeat: true, awayScope: true, extOn: true, lowOn: true, wxOn: true, awayAgainSlot: true, recoLock: true, recoLeft: true, s21On: true, ikenOn: true };
function saveSettings_(s, uid) {
  const cur = getSettings_();
  const memoWasOn = Number(cur.memoSync) !== 0;
  const before = JSON.parse(JSON.stringify(cur)); // 変更履歴のために、保存の前の値を控える
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (k === 'offDays') { // 日付の一覧：今日より前の日は消し、30日まで
      if (!Array.isArray(s.offDays)) return;
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      const seen = {};
      cur.offDays = s.offDays.map(function (x) { return String(x || ''); })
        .filter(function (x) { if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || x < today || seen[x]) return false; seen[x] = true; return true; })
        .sort().slice(0, 30);
      return;
    }
    if (k === 'groupPts') { // グループの中心：送られてこなければ（古い版のアプリ）今のまま
      if (!s.groupPts || typeof s.groupPts !== 'object' || Array.isArray(s.groupPts)) return;
      cur.groupPts = cleanGroupPts_(s.groupPts);
      return;
    }
    let v = Number(s[k]);
    if (!isFinite(v)) return;
    if (SETTING_FLAGS[k]) { cur[k] = v ? 1 : 0; return; }
    if (v <= 0 && !(SETTING_LIMITS[k] && SETTING_LIMITS[k][0] === 0)) return;
    if (SETTING_LIMITS[k]) v = Math.min(SETTING_LIMITS[k][1], Math.max(SETTING_LIMITS[k][0], v));
    cur[k] = v;
  });
  const map = readCol_(SETTINGS);
  writeCol_(SETTINGS, map, [['settings', cur]], [], uid);
  try { CacheService.getScriptCache().remove('settings_v1'); } catch (e) { /* 何もしない */ }
  LANG_SKIP_MEMO_ = null;
  try { opsLogSettings_(uid, before, cur); } catch (e) { console.warn('設定の変更履歴を残せませんでした：' + e); } // 履歴が残せなくても、設定の保存は成功させる
  if (memoWasOn && Number(cur.memoSync) === 0 && typeof memoWipeAll_ === 'function') memoWipeAll_();
  if ((Number(before.langSkip) || 0) !== (Number(cur.langSkip) || 0)) {
    try { langRejournal_(); } catch (e) { console.warn('外国語の家の印を配り直せませんでした：' + e); }
  }
}

/** グループの中心を確かめる：名前は30文字まで（空白なし）、1グループ GROUP_PTS_MAX 点まで、日本のまわりの緯度経度だけ（小数5けた＝約1m） */
function cleanGroupPts_(src) {
  const out = {};
  let n = 0;
  Object.keys(src).forEach(function (g) {
    if (n >= GROUP_PTS_GROUPS) return;
    const name = String(g || '').normalize('NFKC').replace(/\s+/g, '').slice(0, 30);
    if (!name || out[name]) return;
    const pts = (Array.isArray(src[g]) ? src[g] : []).map(function (p) {
      if (!Array.isArray(p) || p.length < 2) return null;
      const la = Number(p[0]), ln = Number(p[1]);
      if (!isFinite(la) || !isFinite(ln) || la < 20 || la > 46 || ln < 122 || ln > 154) return null;
      return [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5];
    }).filter(Boolean).slice(0, GROUP_PTS_MAX);
    if (!pts.length) return;
    out[name] = pts; n++;
  });
  return out;
}

/* =========================================================
   係の画面の「点検」：設定の変更履歴／整理とバックアップの状態／月の点検リスト
   ・データのシートや journal には入れない（スマホに配られない）。区域係の問い合わせ ops でだけ返す
   ・変更履歴は、シート「operations」（直近 OPS_KEEP 行まで）。記録するのは設定の値だけ
   ========================================================= */
const OPS_SHEET = 'operations';
const OPS_KEEP = 200;
const OPS_MANUAL = ['devices', 'people']; // 係が自分でチェックを付ける項目の名前
const SETTING_LABELS = {
  mapStd: '伝道者の地図のはじめの種類',
  s21On: '奉仕報告を会衆の報告システム（S21）に送る',
  langSkip: '区域カードで訪問しない言語（外国語の家）',
  ikenOn: 'こまったこと・提案を送れるようにする', ikenWho: 'こまったこと・提案を送れる人（0＝全員・1＝監督・司会者・係）',
  lowOn: '記録の少ない正式返却を自動で確かめる', wxOn: '雨の日は集合住宅を先に出す', lowWait: '記録の少ない正式返却を確かめるまでの日数',
  keepMonths: '訪問記録を残す期間（か月）', cacheDays: '通信がない端末にデータを残す期間（日）', lendDays: '返却の目安（日）',
  awayRetPct: '留守宅を回り終えたとみなす割合（%）', donePct: '回り終えたとみなす割合（%）', skipDays: '最近会えた家をとばす日数',
  skipDone: '「最近会えた家」を完了の数に入れる', autoFree: '自動受け取り', freeAfterDays: '正式に返却されてから受け取れるまでの日数',
  groupOn: 'グループ機能', groupMax: 'グループの人数', lockOthers: '他人の記録を隠す', memoShare: '再訪問メモの共有', memoSync: '再訪問メモをほかの端末でも使う',
  awayDays: '留守宅カードの日数', awayExp: '留守宅カードが終わるとき', awayAllTerr: '留守宅カードを全区域で使う',
  reqMaxPersonal: '個人の申し込みの上限', reqMaxGroup: 'グループの申し込みの上限', holdMaxPersonal: '個人が持てる区域の数', holdMaxGroup: 'グループが持てる区域の数',
  syncGroupSec: '一緒に回っているときの取りに行く間隔（秒）', syncNormalSec: 'ふだんの取りに行く間隔（秒）',
  youngW: '若い世代の優先度', awayTries: '留守宅を終える回数', nightOn: '夜を提案に入れる', offDays: '訪問を控える日', groupPts: 'グループの中心', contDays: '途中返却を続きから回る期間（日）',
  awayRecentDays: '留守宅：同じ家を次に訪ねるまでの最短間隔（日）', awayCap: '留守宅：訪ねる上限回数', awayNoRepeat: '留守宅：同じ時間帯を重ねない', awayScope: '留守宅：試した時間帯の数え方',
  extOn: '完了のあとの留守宅（おすすめ）', extRest: '完了のあと：寝かせる日数', extCap: '完了のあと：1軒あたりの回数', extDays: '完了のあと：おすすめに出す期間（日）',
  extStopBefore: '完了のあと：次の新規の前に止める日数', awayDayOnly: '留守宅：その日限りにする軒数',
  awayAgainSlot: '留守宅：訪ね直したと数える条件', recoLock: 'おすすめ：オートロックの建物', osaeMax: 'おすすめ：押さえられる予定の数', osaeDays: 'おすすめ：何日先まで予定に入れられるか',
  recoCount: 'おすすめ：1つのおすすめの家の数', recoLeft: 'おすすめ：回り残しの家',
  recAge: '年代の記録', recInterest: '関心の記録', ageShow: '年齢データの表示', ageShowMode: '年齢データの表示方法', recoOn: 'おすすめ機能'
};
function opsSheet_() {
  let sh = book_().getSheetByName(OPS_SHEET);
  if (!sh) {
    sh = book_().insertSheet(OPS_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['日時', '係', '設定', '変更前', '変更後']]);
    sh.setFrozenRows(1);
    sh.getRange('A:E').setNumberFormat('@');
    // 新しいシートは26列×1000行あるので、使う分だけに縮める（セルの上限に近づけないため）
    if (sh.getMaxColumns() > 5) sh.deleteColumns(6, sh.getMaxColumns() - 5);
    if (sh.getMaxRows() > 300) sh.deleteRows(301, sh.getMaxRows() - 300);
  }
  return sh;
}
function opsShow_(k, v) {
  if (k === 'offDays') return (Array.isArray(v) ? v.length : 0) + '日';
  if (k === 'groupPts') { // どのグループに何点（緯度経度は残さない）
    if (!v || typeof v !== 'object') return '';
    return Object.keys(v).sort().map(function (g) { return g + '：' + (Array.isArray(v[g]) ? v[g].length : 0) + '点'; }).join('、');
  }
  if (v === undefined || v === null) return '';
  return String(v);
}
/** 保存の前後を比べて、変わった設定だけを1行ずつ残す */
function opsLogSettings_(uid, before, after) {
  const rows = [];
  const who = (usersAll_().filter(function (u) { return u.id === String(uid); })[0] || {}).name || String(uid || '');
  const at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) return;
    rows.push([at, who, SETTING_LABELS[k] || k, opsShow_(k, before[k]), opsShow_(k, after[k])]);
  });
  if (!rows.length) return;
  const sh = opsSheet_();
  const first = Math.max(2, sh.getLastRow() + 1);
  if (first + rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 50);
  sh.getRange(first, 1, rows.length, 5).setValues(rows);
  if (sh.getLastRow() > OPS_KEEP + 100) opsTrim_();
}
/** 古い履歴を消して、直近 OPS_KEEP 行にする */
function opsTrim_() {
  const sh = book_().getSheetByName(OPS_SHEET);
  if (!sh) return;
  const n = sh.getLastRow() - 1;
  if (n > OPS_KEEP) sh.deleteRows(2, n - OPS_KEEP);
}
function opsMonth_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM'); }
function opsChecks_() {
  const o = parseJson_(props_().getProperty('OPS_CHECKS'), null);
  const ym = opsMonth_();
  return o && o.ym === ym && o.items ? o : { ym: ym, items: {} }; // 月が変わったら、チェックは空に戻る
}
function opsHasTrigger_(fn) {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; }); } catch (e) { return null; }
}
function opsCells_() {
  if (typeof cellStats_ !== 'function') return null;
  const c = cacheGetLong_('ops_cells');
  if (c) return c;
  const st = cellStats_(), v = { total: st.total, limit: typeof CELL_LIMIT === 'number' ? CELL_LIMIT : 10000000 };
  v.pct = Math.round(v.total / v.limit * 1000) / 10;
  try { CacheService.getScriptCache().put('ops_cells', JSON.stringify(v), 3600); } catch (e) { /* 何もしない */ }
  return v;
}
function cacheGetLong_(k) { try { const v = CacheService.getScriptCache().get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
/** 「人が住んでいた」と確かめた家の印（家の番号|部屋 → 確かめた日の番号）。半年たったら消す。上限200件
    家のデータには入れず、言葉も残さない。区域係の問い合わせ ops でだけ返す */
function opsCk_() {
  const o = parseJson_(props_().getProperty('CK_KEEP'), {}) || {};
  const today = Math.floor(Date.now() / DAY_MS);
  Object.keys(o).forEach(function (k) { if (!(today - Number(o[k]) < 180)) delete o[k]; });
  const ks = Object.keys(o);
  if (ks.length > 200) ks.sort(function (a, b) { return o[a] - o[b]; }).slice(0, ks.length - 200).forEach(function (k) { delete o[k]; });
  return o;
}
/** 書き出し・印刷の記録（S-12・S-13 の印刷、CSV）。だれが・いつ・何を、だけを残す（中身は残さない）
    係の端末がまとめて送る（通信できなかった分も、次の書き出しのときに一緒に届く）。1回に20件まで */
function opsLogExport_(user, items) {
  const clean = function (v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/^[=+\-@\s]+/, '').slice(0, max); };
  const rows = [];
  (Array.isArray(items) ? items : []).slice(0, 20).forEach(function (it) {
    if (!it) return;
    let kind = clean(it.kind, 30);
    if (!kind) return;
    if (kind.indexOf('書き出し：') !== 0) kind = '書き出し：' + kind;
    let t = Date.parse(String(it.at || ''));
    if (!isFinite(t) || t > Date.now() + 60000 || t < Date.now() - 30 * DAY_MS) t = Date.now();
    rows.push([Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), clean(user.name, 30), kind, '', clean(it.detail, 60)]);
  });
  if (!rows.length) return 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = opsSheet_();
    const first = Math.max(2, sh.getLastRow() + 1);
    if (first + rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 50);
    sh.getRange(first, 1, rows.length, 5).setValues(rows);
    if (sh.getLastRow() > OPS_KEEP + 100) opsTrim_();
  } finally { lock.releaseLock(); }
  return rows.length;
}
function opsApi_(user, req) {
  if (req.action === 'ops_log') return { ok: true, n: opsLogExport_(user, req.items) };
  if (req.action === 'ops_ck') {
    const k = String(req.k || '').slice(0, 80);
    if (!k) return { ok: false, error: 'bad_request' };
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const o = opsCk_();
      if (req.on) o[k] = Math.floor(Date.now() / DAY_MS); else delete o[k];
      props_().setProperty('CK_KEEP', JSON.stringify(o));
      return { ok: true, ck: o };
    } finally { lock.releaseLock(); }
  }
  if (req.action === 'ops_check') {
    const id = String(req.id || '');
    if (OPS_MANUAL.indexOf(id) < 0) return { ok: false, error: 'bad_request' };
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const o = opsChecks_();
      if (req.on) o.items[id] = { by: user.name, at: new Date().toISOString() }; else delete o.items[id];
      props_().setProperty('OPS_CHECKS', JSON.stringify(o));
      return { ok: true, checks: o };
    } finally { lock.releaseLock(); }
  }
  const p = props_(), out = { ok: true, now: new Date().toISOString() };
  const sh = book_().getSheetByName(OPS_SHEET);
  out.history = [];
  if (sh && sh.getLastRow() > 1) {
    const n = Math.min(60, sh.getLastRow() - 1);
    out.history = sh.getRange(sh.getLastRow() - n + 1, 1, n, 5).getValues().reverse().map(function (r) {
      return { at: String(r[0]), who: String(r[1]), name: String(r[2]), from: String(r[3]), to: String(r[4]) };
    });
  }
  out.clean = parseJson_(p.getProperty('CLEAN_LAST'), null);
  out.cleanOn = opsHasTrigger_('cleanupOld');
  out.backup = { on: opsHasTrigger_('backupRun'), last: p.getProperty('BACKUP_LAST') || '', name: p.getProperty('BACKUP_LAST_NAME') || '', err: p.getProperty('BACKUP_ERR') || '' };
  try { out.cells = opsCells_(); } catch (e) { out.cells = null; }
  out.checks = opsChecks_();
  out.ck = opsCk_();
  return out;
}

/* =========================================================
   読み込み（役割に応じて見せる内容を変える）
   ========================================================= */
function permView_(user, housesMap) {
  const hold = {}, fk = {}, terrOf = {};
  let allLoaded = false;
  readCol_('territories').forEach(function (x, id) { if (x.data.holder === user.id) hold[id] = true; });
  readCol_('follows').forEach(function (x, id) { if (x.data.by === user.id) fk[id] = true; });
  if (housesMap) {
    housesMap.forEach(function (x, id) { terrOf[id] = x.data.terrId || null; });
    allLoaded = true;
  }
  return {
    allows: function (v) {
      if (fk[v.houseId + '|' + (v.unit || '')]) return true;
      let t = terrOf[v.houseId];
      if (t === undefined) {
        if (v.t) {
          t = v.t;
        } else if (!allLoaded) {
          readCol_('houses').forEach(function (x, id) { if (terrOf[id] === undefined) terrOf[id] = x.data.terrId || null; });
          allLoaded = true;
          t = terrOf[v.houseId];
          if (t === undefined) t = null;
        } else {
          t = null;
        }
        terrOf[v.houseId] = t;
      }
      return !!t && !!hold[t];
    }
  };
}

function mask_(user, c, v, pv) {
  if (user.role === 'admin' || v === null || typeof v !== 'object') return v;
  const me = user.id;
  if (c === 'visits') {
    if (v.by === me) return v;
    const o = Object.assign({}, v, { by: '' });
    if (!pv || !pv.allows(o)) { delete o.age; delete o.interest; }
    delete o.t;
    delete o.src;
    return o;
  }
  if (c === 'follows' || c === 'awayCards') return v.by === me ? v : Object.assign({}, v, { by: 'x' });
  if (c === 'holds') return v.by === me ? v : holdMask_(v); // ほかの人の押さえは、家と期限だけ（だれが・いつの予定かは見せない）
  if (c === 'requests' || c === 'returns') return v.by === me ? v : undefined;
  if (c === 's13') return undefined;
  if (c === 'schedules') return !v.group || v.group === user.group ? v : undefined;
  if (c === 'dnc') return dncMask_(v);
  if (c === 'caution') return cautionMask_(v);
  if (c === 'langs') return langMask_(v);
  return v;
}

/* =========================================================
   外国語の家（2026-11-08）
   ・キーは「家id|部屋」、値は { l: 言語（LANGS のどれか）, at }
   ・言語は区域係だけが見る（手話は障害を示すことがあり、言語は国籍の推測につながるため）。
     係以外には { g: 1 }（外国語の家）と、係の設定で訪問しない言語なら x: 1 だけを配る
   ・付けるのは、家の編集ができる人ならだれでも。係以外が送れるのは、言語をえらんだ値（l）だけ
   ・訪問しない言語の設定（langSkip）を変えたら、全部の印を変更の記録に入れ直す（係以外の x を新しくするため）
   ========================================================= */
const LANGS = ['en', 'zh', 'ne', 'es', 'ko', 'tl', 'sgn']; // 英語・中国語・ネパール語・スペイン語・韓国語・タガログ語・手話（この順がビットの順）
function langBit_(l) { const i = LANGS.indexOf(String(l || '')); return i < 0 ? 0 : (1 << i); }
let LANG_SKIP_MEMO_ = null; // 係以外への配信で1件ごとに設定を読まないように（監査 M3）。設定を保存したら空にする
function langSkipOf_(v, settings) {
  const bits = settings ? (Number(settings.langSkip) || 0) : (LANG_SKIP_MEMO_ != null ? LANG_SKIP_MEMO_ : (LANG_SKIP_MEMO_ = Number(getSettings_().langSkip) || 0));
  return !!(v && typeof v === 'object' && bits & langBit_(v.l));
}
/* 係以外に渡す設定：訪問しない言語（langSkip）は渡さない。x の付いた家の言語が分かってしまうため（監査 H1） */
function settingsFor_(user) {
  const s = getSettings_();
  if (user && user.role === 'admin') return s;
  const o = Object.assign({}, s); delete o.langSkip;
  return o;
}
/* 係以外が言語を外した・えらび直したときの控え（15分）。同じ人の「取り消す」（{ g:1, r:1 }）で、もとの言語にもどす（監査 H2） */
const LANG_UNDO_SEC = 900;
function langUndoDrop_(id) { try { CacheService.getScriptCache().remove('langud_' + id); } catch (e) { /* 何もしない */ } }
function langUndoPut_(ctx, id, old) {
  if (ctx.admin || !old || typeof old !== 'object' || !old.l) return;
  try { CacheService.getScriptCache().put('langud_' + id, JSON.stringify({ u: ctx.me, l: old.l }), LANG_UNDO_SEC); } catch (e) { /* 控えられなくても、取り消しで言語がもどらないだけ */ }
}
function langMask_(v) {
  if (!v || typeof v !== 'object' || LANGS.indexOf(String(v.l || '')) < 0) return undefined;
  return langSkipOf_(v) ? { g: 1, x: 1 } : { g: 1 };
}
function ruleLang_(ctx, old, v) {
  const key = String(ctx.curId || ''), i = key.indexOf('|');
  if (!v || typeof v !== 'object' || LANGS.indexOf(String(v.l || '')) < 0) {
    // 言語のない印（係以外の端末の { g:1 }）は受けない。ただし同じ人の「取り消す」（r）は、控えた言語にもどす
    if (!ctx.admin && v && typeof v === 'object' && v.r) {
      const g = parseJson_(provUndoGet_('langud_' + key), null);
      if (g && g.u === ctx.me && LANGS.indexOf(String(g.l)) >= 0) { v = { l: String(g.l), back: 1 }; langUndoDrop_(key); } // 使った控えは消す（再監査 Low）
      else return null;
    } else return null;
  }
  if (i <= 0) return null;
  const h = houseData_(ctx, key.slice(0, i)), u = key.slice(i + 1);
  if (!h) return null; // ない家には付けない
  if (u ? !(h.type === 'apt' && Array.isArray(h.units) && h.units.map(String).indexOf(u) >= 0) : h.type === 'apt') return null; // ない部屋・建物ぜんたいには付けない
  if (old && typeof old === 'object' && old.l === v.l) return old; // 送り直し（同じ言語）
  if (ctx.admin) langUndoDrop_(key); // 係が変えたあとは、前の控えで上書きさせない（再監査 Low）
  if (!v.back) langUndoPut_(ctx, key, old); // 係以外がえらび直したとき：もとの言語を控える（取り消しでもどしたときは控えない）
  return { l: String(v.l), at: nowIso_() };
}
/** 訪問しない言語の設定が変わったとき：全部の言語の印を、変更の記録に入れ直す（中身は変えない。係以外には新しい x で届く） */
function langRejournal_() {
  const out = [];
  readCol_('langs').forEach(function (x, id) { if (x && x.data) out.push(['langs', String(id), JSON.stringify(x.data)]); });
  for (let i = 0; i < out.length; i += 500) journal_(out.slice(i, i + 500));
}

/* =========================================================
   拒否（dnc）の値
   ・キーは「家id|部屋」（家につながった拒否）か「pin:…」（家とつながっていない、場所だけの拒否）
   ・値は true（訪問で記録した拒否・以前の形）か、区域係が取り込み・追加したときの形
     { a: 住所, s: 登録元（xl＝エクセル・kml＝マイマップ・adm＝係）, at: 登録した日, lat/lng: 場所,
       p: 1（場所だけの拒否）, appx: 1（場所はだいたい）, auto: 1（自動で家につないだ・まだ確かめていない）,
       t: 区域id, no: 区域番号（場所が分からないときの区域）,
       room: アパートの部屋（例：603）・h: その建物の家id・cid: その建物の候補の番号（アパートの部屋ごとの拒否。部屋が階ごとの枠なので、場所だけの拒否として持つ），
       m: マイマップのピンに書かれていたメモ（例：「夕方は訪問しない」。区域係だけが見る・2026.13.26），
       o: マイマップのピンの元の文（名前／説明をそのまま。区域係だけが見る） }
   ・伝道者に渡すのは、場所だけの拒否の「住所と場所」だけ。家につながった拒否は true にする（住所や登録元は渡さない）
   ========================================================= */
function dncMask_(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.q && !v.p) return { q: 1 }; // 訪問しない（区域係が付けた・理由は持たない）：印だけを配る
  if (!v.p) return true;
  const o = { p: 1 };
  ['a', 'lat', 'lng', 'appx', 't', 'no', 'room', 'h', 'cid'].forEach(function (k) { if (v[k] !== undefined && v[k] !== '') o[k] = v[k]; });
  return o;
}
function cleanDnc_(v) {
  if (!v || typeof v !== 'object') return true;
  if (v.q && !v.p) return cleanDncQ_(v);
  const o = {};
  if (v.a) o.a = str_(v.a, 120);
  if (['xl', 'kml', 'adm', 'del'].indexOf(v.s) >= 0) o.s = v.s; // del＝家を消したときに残した拒否（H8）
  if (v.at) o.at = str_(v.at, 40);
  const la = Number(v.lat), ln = Number(v.lng);
  if (v.lat != null && v.lng != null && isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
    o.lat = Math.round(la * 1e6) / 1e6; o.lng = Math.round(ln * 1e6) / 1e6;
  }
  if (v.p) o.p = 1;
  if (v.appx) o.appx = 1;
  if (v.auto) o.auto = 1;
  if (v.t) o.t = str_(v.t, 40);
  if (v.no) o.no = str_(v.no, 12);
  if (v.room) o.room = str_(v.room, 20);
  if (v.h) o.h = str_(v.h, 40);
  if (v.cid) o.cid = str_(v.cid, 40);
  if (v.dk) o.dk = str_(v.dk, 60); // 家を消したときに残した拒否の、もとのキー（家id|部屋。H8）
  if (v.m) o.m = str_(v.m, 200); // マイマップのメモ（伝道者には渡さない：dncMask_ に入れない）
  if (v.o) o.o = str_(v.o, 300); // マイマップのピンの元の文（名前／説明。部屋番号を確かめるため。区域係だけ）
  return Object.keys(o).length ? o : true;
}
/* 訪問しない（2026-11-05・HS-2）：区域係が付ける、理由を記録しない印。拒否と同じように訪問・数の対象から外す。
   値は { q: 1, s: 'adm', at, lat, lng, t } だけ。理由になりうるメモ（m）・元の文（o）・住所（a）は持たない。
   家につながったキー（家id|部屋）だけ（場所だけの印には付けない：ruleDnc_） */
function cleanDncQ_(v) {
  const o = { q: 1, s: 'adm' };
  o.at = v.at ? str_(v.at, 40) : nowIso_();
  const la = Number(v.lat), ln = Number(v.lng);
  if (v.lat != null && v.lng != null && isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
    o.lat = Math.round(la * 1e6) / 1e6; o.lng = Math.round(ln * 1e6) / 1e6;
  }
  if (v.t) o.t = str_(v.t, 40);
  return o;
}
const isDncQ_ = function (v) { return !!(v && typeof v === 'object' && v.q && !v.p); };
/** 区域係が家を消す前に（H8・2026-10-29）：その家の拒否を「場所だけの拒否」（pin:…）として先に残す。
 *  ・住所のある拒否（取り込み・係が追加）も、住所のない拒否（伝道者が付けた true）も残す。もとのキーを dk に残す
 *  ・場所は、拒否にある位置、なければ家の位置。どちらもないときは、その家を消さない（拒否が消えないように）
 *  ・印の id は、もとのキーから決める（同じ送信をくり返しても、印が増えない）
 *  ・ここでは印を足すだけ。もとのキーは、家を消したあとの cascadeHouses_ が消す（家の削除が失敗しても、拒否はなくならない）
 *  ・画面がもう場所だけの印に移した拒否（ctx.dncMoved）は、画面の印をここで先に書く（書けなければ家を消さない。画面の印は、あとで書かない）
 *  返り値：消すのをやめる家の id（印を残せなかった家） */
function dncPinBeforeHouseDel_(ctx, hids) {
  const stop = [];
  let m;
  try { m = ctx.col('dnc'); } catch (e) { return hids.slice(); }
  const byHouse = {};
  hids.forEach(function (h) { byHouse[String(h)] = []; });
  m.forEach(function (x, id) {
    const i = String(id).indexOf('|');
    if (i <= 0) return;
    const h = String(id).slice(0, i);
    if (byHouse[h]) byHouse[h].push(String(id));
  });
  const ups = [], upHouse = [], screenPins = {};
  Object.keys(byHouse).forEach(function (h) {
    const keys = byHouse[h];
    if (!keys.length) return;
    const hd = houseData_(ctx, h);
    if (!hd) return; // ない家は消されないので、何もしない
    const hl = Number(hd.lat), hg = Number(hd.lng), hOk = hd.lat != null && hd.lng != null && isFinite(hl) && isFinite(hg);
    let ok = true;
    const mine = [];
    keys.forEach(function (k) {
      // 画面がもう場所だけの印にしたもの：その印を、家を消す前に書く（書けなければ家を消さない。点検M-1・D5）
      if (isDncQ_(m.get(k) ? m.get(k).data : null)) return; // 訪問しない印は、家と一緒に消す（場所だけの拒否にしない。古い画面が移した印も書かない・監査 HS-A1）
      const mv = ctx.dncMoved && ctx.dncMoved[k];
      if (mv) { mine.push([mv.id, cleanDnc_(mv.v)]); (screenPins[h] || (screenPins[h] = [])).push(mv.id); return; }
      const v = m.get(k) ? m.get(k).data : null;
      const o = v && typeof v === 'object' ? Object.assign({}, v) : {};
      const vl = Number(o.lat), vg = Number(o.lng), vOk = o.lat != null && o.lng != null && isFinite(vl) && isFinite(vg);
      if (!vOk && !hOk) { ok = false; return; }
      if (!vOk) { o.lat = Math.round(hl * 1e6) / 1e6; o.lng = Math.round(hg * 1e6) / 1e6; }
      delete o.auto;
      o.p = 1; o.dk = k;
      if (!o.s) o.s = 'del';
      if (!o.at) o.at = nowIso_();
      if (!o.t && hd.terrId) o.t = String(hd.terrId);
      const unit = k.slice(k.indexOf('|') + 1);
      if (unit && !o.room) o.room = str_(unit, 20);
      mine.push(['pin:d' + hash_('dk|' + k).replace(/[^\w]/g, '').slice(0, 14), o]);
    });
    if (!ok) { stop.push(h); return; }
    mine.forEach(function (p) { ups.push(p); });
    upHouse.push(h);
  });
  if (ups.length) {
    const had = {};
    ups.forEach(function (p) { if (m.has(p[0])) had[p[0]] = true; }); // 前からあった印（送り直し）
    try { writeCol_('dnc', m, ups, [], ctx.me); }
    catch (e) {
      console.warn('拒否を場所だけの印にできませんでした。家は消しません', e);
      upHouse.forEach(function (h) { stop.push(h); });
      dncPinUndo_(ctx, m, ups.map(function (p) { return p[0]; }).filter(function (id) { return !had[id]; }));
    }
  }
  // 消さない家の、画面が移した印は、あとで書かない（もとの拒否が残るので、二重にしない）
  stop.forEach(function (h) { (screenPins[h] || []).forEach(function (id) { (ctx.pinStop || (ctx.pinStop = {}))[id] = true; }); });
  return stop;
}
/** 係以外が消そうとしている家に、記録・拒否・注意・受け持ち・引き継ぎがあるか（H8）。ctx.houseHasRec に入れる。
 *  訪問の記録が数えられないときは、消させない（記録がないと確かめられないため） */
function houseRecScan_(ctx, ids) {
  const set = {}, hit = ctx.houseHasRec = {};
  ids.forEach(function (h) { set[String(h)] = true; });
  (ctx.pendVisits || []).forEach(function (v) { const h = String((v && v.houseId) || ''); if (set[h]) hit[h] = true; }); // 同じ送信で届いた記録
  MAP_COLS.forEach(function (c) {
    if (c === 'langs') return; // 外国語の印は記録ではない（画面の houseHasRec と同じ。家と一緒に消える）
    ctx.col(c).forEach(function (x, id) {
      const i = String(id).indexOf('|');
      if (i > 0 && set[String(id).slice(0, i)]) hit[String(id).slice(0, i)] = true;
    });
  });
  const rest = Object.keys(set).filter(function (h) { return !hit[h]; });
  if (!rest.length) return;
  let sh, colB;
  try {
    sh = dataSheet_('visits');
    const n = sh.getLastRow();
    if (n < 2) return;
    colB = sh.getRange(2, 2, n - 1, 1);
  } catch (e) {
    console.warn('記録を確かめられませんでした。家は消しません', e);
    rest.forEach(function (h) { hit[h] = true; });
    return;
  }
  const take = function (cells) {
    readFound_(sh, 2, cells).forEach(function (val) {
      const d = parseJson_(val, null);
      const h = d && String(d.houseId || '');
      if (h && set[h]) hit[h] = true;
    });
  };
  const reEsc = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  for (let i = 0; i < rest.length; i += 40) {
    const part = rest.slice(i, i + 40);
    try {
      take(colB.createTextFinder('"houseId":"(' + part.map(reEsc).join('|') + ')"').useRegularExpression(true).matchCase(true).findAll());
    } catch (e) {
      // まとめて探せないときは1軒ずつ（cascadeHouses_ と同じ。点検L-5）。それでも探せない家は、記録があるものとして消さない
      part.forEach(function (h) {
        try { take(colB.createTextFinder('"houseId":"' + h + '"').matchCase(true).findAll()); }
        catch (e2) { console.warn('記録を確かめられませんでした。家は消しません', h, e2); hit[h] = true; }
      });
    }
  }
}
/* 区域係の画面が、同じ送信で場所だけの印に移した拒否：{ もとのキー: { id: 印のid, v: 印の中身 } }
   「移した」と見るのは、同じ送信に位置のある場所だけの印があり、もとのキー（dk）が合うとき。
   dk を付けない古い画面（13.98 まで）は、住所・登録元のある拒否の中身をそのまま写して移すので、住所・登録元・日が合うとき */
function dncMovedByScreen_(ctx, ch) {
  const out = {};
  if (!ch || !Array.isArray(ch.del) || !ch.del.length) return out;
  const byKey = {}, bySig = {};
  const sig = function (v) { return String(v.a || '') + '|' + String(v.s || '') + '|' + String(v.at || ''); };
  (ch.up || []).forEach(function (x) {
    const v = x && x.value && typeof x.value === 'object' ? x.value : null;
    if (!v || !v.p || String(x.id).indexOf('pin:') !== 0) return;
    const la = Number(v.lat), ln = Number(v.lng);
    if (v.lat == null || v.lng == null || !isFinite(la) || !isFinite(ln)) return;
    const pin = { id: String(x.id), v: v };
    if (v.dk) byKey[String(v.dk)] = pin;
    else if (v.a || v.s) (bySig[sig(v)] || (bySig[sig(v)] = [])).push(pin);
  });
  let m;
  try { m = ctx.col('dnc'); } catch (e) { return out; }
  const near = function (a, b) { return Math.abs(Number(a) - Number(b)) < 1e-6; };
  ch.del.forEach(function (id) {
    id = String(id);
    const cur = m.get(id), cv = cur ? cur.data : null;
    if (byKey[id]) { out[id] = byKey[id]; return; }
    if (!(cv && typeof cv === 'object' && (cv.a || cv.s))) return;
    // 古い画面の印は、家の位置を写している。中身が同じ拒否がほかの家にあっても取りちがえないように、位置も合うものだけ（点検②L1）
    const hd = houseData_(ctx, id.split('|')[0]);
    const list = bySig[sig(cv)] || [];
    const i = hd ? list.findIndex(function (p) { return near(p.v.lat, hd.lat) && near(p.v.lng, hd.lng); }) : -1;
    if (i >= 0) out[id] = list.splice(i, 1)[0];
  });
  return out;
}
/* 印の保存に失敗したとき（点検②M1）：書けたかどうか分からないので、シートを読み直して表を本当の中身にもどし、
   書けてしまった新しい印は取り消す（もとの拒否が残るので、二重にしない）。取り消せなくても、拒否は消えない。
   読み直せないときは、表が信用できないので、この送信全体を止める（まだ家は消していない。画面はあとで送り直す） */
function dncPinUndo_(ctx, m, newIds) {
  reindex_(m, 'dnc'); // 失敗したら、そのまま送信全体の失敗にする
  const left = newIds.filter(function (id) { return m.has(id); });
  if (!left.length) return;
  try { writeCol_('dnc', m, [], left, ctx.me); }
  catch (e) { console.warn('書けてしまった印を取り消せませんでした（拒否は残っています）', e); reindex_(m, 'dnc'); }
}
/* 「家id|部屋」のキーが、この送信で消すのをやめた家のものか（点検M-1） */
function houseStopKey_(ctx, key) {
  if (!ctx.houseStop) return false;
  const s = String(key || ''), i = s.indexOf('|');
  return i > 0 && !!ctx.houseStop[s.slice(0, i)];
}
/* 仮の家の「取り消す」（点検M-2・2026-10-29）
   係以外は仮の印を新しく付けられない（D4）。ただし本人が、仮の家を消した・仮の印を外した（記録を付けた・家だと確かめた）
   すぐあとに「取り消す」を押したときは、もとの仮の家にもどせるように、だれが・どの家をの控えを15分だけ一時保存に残す。
   控えが消えていたら（一時保存は消えることがある）、今までどおり仮でない家になるだけ（記録は消えない） */
const PROV_UNDO_SEC = 900;
function provUndoNote_(ctx, deleted) {
  if (ctx.admin) return;
  const o = {};
  (deleted || []).forEach(function (id) {
    const d = ctx.provGone && ctx.provGone[String(id)];
    if (d) o['provdel_' + id] = JSON.stringify({ by: ctx.me, lat: d.lat, lng: d.lng, terrId: d.terrId || null, type: d.type || '', createdBy: d.createdBy || '', createdAt: d.createdAt || '', imp: d.imp ? 1 : 0 });
  });
  Object.keys(ctx.provOff || {}).forEach(function (id) { o['provoff_' + id] = ctx.me; });
  if (!Object.keys(o).length) return;
  try { CacheService.getScriptCache().putAll(o, PROV_UNDO_SEC); } catch (e) { /* 控えられなくても、取り消すと仮でない家になるだけ */ }
}
function provUndoGet_(key) {
  try { return CacheService.getScriptCache().get(key); } catch (e) { return null; }
}
function provUndoCreate_(ctx, created) {
  const g = parseJson_(provUndoGet_('provdel_' + created.id), null);
  if (!g || g.by !== ctx.me) return;
  // 同じ家（同じ場所・同じ区域）のときだけ。ほかの場所に仮の家を作ることには使えない
  if (Number(g.lat) !== Number(created.lat) || Number(g.lng) !== Number(created.lng) || String(g.terrId || '') !== String(created.terrId || '') || (g.type && g.type !== created.type)) return;
  created.prov = true;
  if (g.createdBy) created.createdBy = String(g.createdBy);
  if (g.createdAt) created.createdAt = String(g.createdAt);
  if (g.imp) created.imp = true;
}
/* =========================================================
   注意（！）の印（caution・2026-10-18）
   ・「犬がいる」「午前中は訪問を控える」など、拒否ではない注意の情報
   ・キーは拒否と同じ形：「家id|部屋」（家につながった注意）か「pin:…」（場所だけ。区域係だけが作れる）
   ・値 { n: 注意の文（80字まで）, s: 登録元（kml＝マイマップ・adm＝係・pub＝奉仕者）, at: 登録した日,
          lat/lng: 場所, p: 1（場所だけ）, t: 区域id,
          room: アパートの部屋（例：1-905）・h: その建物の家id（部屋は階ごとの枠なので、拒否と同じく場所だけの印として持つ） }
   ・注意の文は、その家を訪ねる人みんなが見る（記録の画面に出す）。名前や病気など、個人のことは書かない約束（画面にも書いてある）
   ・消せるのは、区域係と、その注意を書いた本人
   ========================================================= */
function cleanCaution_(v) {
  const o = {};
  if (!v || typeof v !== 'object') return null;
  const n = str_(v.n, 80).replace(/[\r\n]+/g, ' ').trim();
  if (n) o.n = n;
  if (['kml', 'adm', 'pub'].indexOf(v.s) >= 0) o.s = v.s;
  o.at = str_(v.at, 40) || nowIso_();
  const la = Number(v.lat), ln = Number(v.lng);
  if (v.lat != null && v.lng != null && isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
    o.lat = Math.round(la * 1e6) / 1e6; o.lng = Math.round(ln * 1e6) / 1e6;
  }
  if (v.p) o.p = 1;
  if (v.t) o.t = str_(v.t, 40);
  if (v.room) o.room = str_(v.room, 20);
  if (v.h) o.h = str_(v.h, 40);
  return o;
}
function cautionMask_(v) {
  if (!v || typeof v !== 'object') return undefined;
  const o = {};
  ['n', 'at', 'lat', 'lng', 'p', 't', 'room', 'h'].forEach(function (k) { if (v[k] !== undefined && v[k] !== '') o[k] = v[k]; });
  return o;
}
/** 区域係はなんでも保存できる。奉仕者は家につながった注意の文だけ（場所・登録元は前のまま） */
function ruleCaution_(ctx, old, v) {
  const c = cleanCaution_(v);
  if (!c) return null;
  const oldU = old && typeof old === 'object' && old.u ? String(old.u) : '';
  if (ctx.admin) { if (oldU) c.u = oldU; return c; } // 書いた人（u）は、係が直しても変えない
  const o = Object.assign({}, old && typeof old === 'object' ? old : {});
  if (c.n) o.n = c.n; else delete o.n;
  // 書いた人を u に残す（監査①S7）。消せるのは区域係と書いた本人。ほかの人が文を直しても、書いた人は変わらない
  // （u がない前からの注意で、奉仕者が書いたもの：今の行の記録者を書いた人とする）
  if (!old) { o.s = 'pub'; o.u = ctx.me; }
  else if (!oldU && o.s === 'pub' && ctx.curRow && ctx.curRow.by) o.u = String(ctx.curRow.by);
  o.at = c.at;
  return o;
}

/** 伝道者は、家に拒否の印を付けるだけ（係が入れた住所などは、そのまま残す）。区域係は住所・場所も保存できる */
function ruleDnc_(ctx, old, v) {
  if (!ctx.admin) {
    if (old != null && old !== false) return old;
    // 新しい拒否の印は、ある家だけ（電波のない所でつけた印が、家が消されたあとに届いたときに残らないように・点検②V6）
    const hid = String(ctx.curId || '').split('|')[0];
    return hid && houseData_(ctx, hid) ? true : null;
  }
  if (v && typeof v === 'object' && v.q) {
    // 場所だけの印（pin:）に「訪問しない」は置かない。古い区域係の画面（13.121 まで）は、家・部屋を消すとき訪問しない印も
    // 場所だけの拒否にして送ってくるので、受け付けない（家と一緒に消す。赤い「拒」の場所の印を残さない・監査 HS-A1）
    if (String(ctx.curId || '').indexOf('|') < 0) return null;
    // ない家には付けない（監査 HS-A11）
    if (!houseData_(ctx, String(ctx.curId).split('|')[0])) return null;
  }
  return cleanDnc_(v);
}

function usersFor_(user) {
  return usersAll_().map(function (u) {
    const o = { id: u.id, name: u.name, role: u.role };
    if (u.group) o.group = u.group;
    if (u.overseer) o.overseer = true;
    if (u.leader) o.leader = true;
    if (u.yomi) o.yomi = u.yomi;
    if (u.mgr && u.role !== 'admin' && (user.role === 'admin' || u.id === user.id)) o.mgr = true; // ほかの人の mgr は、係の画面にだけ返す
    if (!u.active) o.inactive = true;
    if (u.id === user.id) Object.assign(o, cleanPrefs_(u.prefs));
    return o;
  });
}

const RES_CODE = { met: 'm', away: 'a', refused: 'r' };
const visitRow_ = function (v) {
  return [v.id, v.houseId, v.unit || '', RES_CODE[v.result] || 'a',
    Math.floor(Date.parse(v.at) / 1000), v.by || '', v.age || '', v.interest || '', v.src || '', v.oc ? 1 : ''];
};

function houseRow_(d) {
  return [d.id, d.terrId || '', d.type === 'apt' ? 'a' : 'h', d.lat, d.lng, d.label || '',
    (d.units || []).join('|'), d.createdBy || '', Math.floor(Date.parse(d.createdAt) / 1000) || 0,
    d.kind || '', d.lock ? 1 : '', d.uk ? JSON.stringify(d.uk) : '', d.prov ? 1 : '', d.ul ? JSON.stringify(d.ul) : '',
    d.ban === 'no' ? 'n' : d.ban === 'letter' ? 'l' : '', d.imp ? 1 : '', d.cid || '', d.mu || '', d.bn || '', d.ac || ''];
}

function fullFor_(user) {
  const seq = seqInfo_().seq;
  const st = { version: 6, live: true, currentUser: user.id, users: usersFor_(user), settings: settingsFor_(user), dnc: {}, follows: {}, released: {}, caution: {}, langs: {} };
  const housesMap = readCol_('houses');
  const pv = user.role === 'admin' ? null : permView_(user, housesMap);
  ['territories', 'houses', 'requests', 'awayCards', 'returns', 'schedules', 's13', 'agedata', 'holds'].forEach(function (c) {
    st[c] = [];
    (c === 'houses' ? housesMap : readCol_(c)).forEach(function (x) { const m = mask_(user, c, x.data); if (m !== undefined) st[c].push(m); });
  });
  MAP_COLS.forEach(function (c) {
    readCol_(c).forEach(function (x, id) { const m = mask_(user, c, x.data); if (m !== undefined) st[c][id] = m; });
  });
  st.visitsC = [];
  readCol_('visits').forEach(function (x) {
    st.visitsC.push(visitRow_(mask_(user, 'visits', x.data, pv)));
  });
  return { mode: 'full', seq: seq, state: st };
}

function partFor_(user, part, offset, req) {
  if (part === 'tv') return tvFor_(user, req || {});
  if (part === 'houses' && !offset && req && req.snap && typeof houseSnapPart_ === 'function') { const s = houseSnapPart_(); if (s) return s; }
  if (part === 'visits' && req && req.vsnap && typeof visitSnapPart_ === 'function') { const v = visitSnapPart_(user, offset, req); if (v) return v; }
  if (part === 'meta') {
    const seq = seqInfo_().seq;
    const st = { version: 6, live: true, currentUser: user.id, users: usersFor_(user), settings: settingsFor_(user), dnc: {}, follows: {}, released: {}, caution: {}, langs: {} };
    ['territories', 'requests', 'awayCards', 'returns', 'schedules', 's13', 'agedata', 'holds'].forEach(function (c) {
      st[c] = [];
      readCol_(c).forEach(function (x) { const m = mask_(user, c, x.data); if (m !== undefined) st[c].push(m); });
    });
    MAP_COLS.forEach(function (c) {
      readCol_(c).forEach(function (x, id) { const m = mask_(user, c, x.data); if (m !== undefined) st[c][id] = m; });
    });
    return { mode: 'meta', seq: seq, state: st, counts: { houses: rowCount_('houses'), visits: rowCount_('visits') } };
  }
  if (part !== 'houses' && part !== 'visits') return { mode: 'error' };
  const sh = dataSheet_(part), last = sh.getLastRow(), limit = PART_LIMIT[part];
  const start = 2 + Math.max(0, offset);
  if (last < start) return { mode: 'part', part: part, rows: [], next: null };
  const n = Math.min(limit, last - start + 1);
  const vals = sh.getRange(start, 1, n, 2).getValues();
  const pv = part === 'visits' && user.role !== 'admin' ? permView_(user, null) : null;
  const rows = [];
  vals.forEach(function (r) {
    if (r[0] === '' || r[1] === '') return;
    const d = parseJson_(r[1], undefined);
    if (d === undefined) return;
    if (part === 'houses') {
      rows.push(houseRow_(d));
    } else {
      const v = mask_(user, 'visits', d, pv);
      if (v === undefined) return;
      rows.push(visitRow_(v));
    }
  });
  return { mode: 'part', part: part, rows: rows, next: (start + n) <= last ? offset + n : null };
}
function rowCount_(name) { return Math.max(0, dataSheet_(name).getLastRow() - 1); }

function tvFor_(user, req) {
  const tset = {}, kset = {};
  let nt = 0;
  (Array.isArray(req.terrs) ? req.terrs : []).slice(0, 50).forEach(function (t) { tset[String(t)] = true; nt++; });
  (Array.isArray(req.keys) ? req.keys : []).slice(0, 500).forEach(function (k) { kset[String(k)] = true; });
  const rows = [];
  const sh = dataSheet_('visits'), n = sh.getLastRow();
  if (n < 2) return { mode: 'tv', rows: rows };
  const pv = user.role === 'admin' ? null : permView_(user, null);
  let terrOf = null;
  const onlyTerr = nt && !Object.keys(kset).length;
  sh.getRange(2, 1, n - 1, 2).getValues().forEach(function (r) {
    if (r[0] === '' || r[1] === '') return;
    if (onlyTerr) {
      const m = /"t":"([^"]+)"/.exec(r[1]);
      if (m && !tset[m[1]]) return;
    }
    const d = parseJson_(r[1], undefined);
    if (!d || !d.houseId) return;
    let hit = !!kset[d.houseId + '|' + (d.unit || '')];
    if (!hit && nt) {
      let t = d.t;
      if (!t) {
        if (!terrOf) { terrOf = {}; readCol_('houses').forEach(function (x, id) { terrOf[id] = x.data.terrId || null; }); }
        t = terrOf[d.houseId];
      }
      hit = !!t && !!tset[t];
    }
    if (!hit) return;
    const v = mask_(user, 'visits', d, pv);
    if (v === undefined) return;
    rows.push(visitRow_(v));
  });
  return { mode: 'tv', rows: rows };
}

function buildState_(user) { return fullFor_(user).state; }

/* =========================================================
   保存（変更の確認）
   ========================================================= */
function same_(a, b, keys) {
  return keys.every(function (k) { return JSON.stringify(a[k]) === JSON.stringify(b[k]); });
}
function str_(v, max) { return String(v == null ? '' : v).slice(0, max); }
function nowIso_() { return new Date().toISOString(); }
/** 端末の時計が大きくずれていても日付が狂わないよう、7日前〜5分先の範囲だけ端末の時刻を使い、外れたらサーバーの時刻にする */
function clampTime_(v) {
  const ms = Date.parse(String(v || ''));
  const now = Date.now();
  if (isFinite(ms) && ms <= now + 5 * 60000 && ms >= now - 7 * DAY_MS) return new Date(ms).toISOString();
  return nowIso_();
}

function applyChanges_(user, ch, opt) {
  const admin = user.role === 'admin';
  const mgr = isMgr_(user); // 区域係、または「家と拒否の管理」が付いた有効な人。家の削除・拒否の削除・家の編集の判定だけに使う（H4・H5）
  const me = user.id;
  const settings = getSettings_();
  const rejected = [];
  const reject = function (c, id, why) { rejected.push({ c: c, id: id, why: why }); };

  if (ch.settings) {
    if (admin) saveSettings_(ch.settings, me); else reject('settings', '', 'admin');
  }
  if (ch.users) {
    (ch.users.up || []).forEach(function (u) {
      if (u.id !== me) return reject('users', u.id, 'other');
      savePrefs_(user, cleanPrefs_(u));
    });
  }

  const ctx = { user: user, admin: admin, mgr: mgr, mgrOnly: mgr && !admin, me: me, settings: settings, cols: {}, re: !!(opt && opt.re) };
  // 端末の時計のずれ（点検②V19）：送信に付いた端末の今の時刻（ct）と、サーバーの時刻が10分以上ちがえば、
  // 新しい訪問記録の日時をそのずれの分だけ直す（ct を送らない古い画面は、今までどおり）
  const ct = Number(opt && opt.ct);
  ctx.skew = isFinite(ct) && ct > 1.6e12 && Math.abs(Date.now() - ct) > 10 * 60000 ? Date.now() - ct : 0;
  ctx.pendVisits = ch.visits && Array.isArray(ch.visits.up) ? ch.visits.up : []; // 同じ送信で届いた訪問記録（返却の割合を数えるときに入れる）
  const col = function (name) { return ctx.cols[name] || (ctx.cols[name] = readCol_(name)); };
  ctx.col = col;

  applySet_(ctx, 'territories', ch.territories, ruleTerritory_, function (c) { return ctx.admin; }, reject);
  // 留守宅カードで回り終えた区域：その区域の返却の記録を「回り終えた」にする（伝道者は返却の記録を書きかえられないので、ここで行う）
  if (ctx.poolDone && ctx.poolDone.length) {
    const rm = col('returns'), rups = [];
    ctx.poolDone.forEach(function (p) {
      const x = p.rid ? rm.get(String(p.rid)) : null;
      if (x) rups.push([String(p.rid), Object.assign({}, x.data, { completed: true, at: p.at, pct: p.pct })]);
    });
    if (rups.length) writeCol_('returns', rm, rups, [], me);
  }
  applySet_(ctx, 'agedata', ch.agedata, ruleAgeData_, function () { return ctx.admin; }, reject);
  if ((ch.territories || ch.agedata) && typeof azaCheck_ === 'function') azaCheck_(ctx);
  // おすすめの押さえ（古い画面からは来ない）。家より先に入れる（同じ送信で「今行く」と仮の家を消すが来たとき、消せるように）
  applySet_(ctx, 'holds', ch.holds, ruleHold_, function (c) { return ctx.admin || (c.data && c.data.by === me); }, reject);
  // 家の削除の前に（H8・2026-10-29）
  //  ・係以外：記録・拒否・注意・受け持ち・引き継ぎのある家は消せない（記録のある家は区域係だけが消せる）。先に調べておく
  //  ・係：拒否を「場所だけの印」として先に残す。残せなかった家は消さない（拒否が消えないように）
  const hdel = ch.houses && Array.isArray(ch.houses.del) ? ch.houses.del.map(String) : [];
  if (hdel.length && !mgr) houseRecScan_(ctx, hdel);
  if (hdel.length && mgr) {
    // 同じ送信で、画面がもう拒否を移している（区域係の画面は、家を消すときに自分で場所だけの拒否にする）ものは、ここでは動かさない。
    // 「移した」と見るのは、同じ送信に、位置のある場所だけの印があり、もとのキー（dk）か住所（a）が合うときだけ。
    // 印のないまま消そうとしている拒否（古い画面・位置のない家）は、ここで印にする（できなければ家を消さない。点検L-3・L-4）
    // 区域係以外の画面には拒否の住所が届かない（伏せてある）ので、画面が作った場所だけの印は使わない。サーバーが、シートにある拒否から印を作る（住所を失わないため）
    ctx.dncMoved = ctx.mgrOnly ? {} : dncMovedByScreen_(ctx, ch.dnc);
    const stop = dncPinBeforeHouseDel_(ctx, hdel);
    if (stop.length) {
      ch.houses.del = ch.houses.del.filter(function (id) { return stop.indexOf(String(id)) < 0; });
      stop.forEach(function (id) { reject('houses', id, 'keep_failed'); });
    }
  }
  const houseCanDel = function (c, id) {
    if (!ctx.mgr && ctx.houseHasRec && ctx.houseHasRec[String(id)]) return false; // 記録・印のある家は、区域係だけが消せる（H8）
    if (ctx.mgrOnly && houseAdminMark_(ctx, id)) return false; // 訪問しない印のある家は、区域係だけが消せる（家を消して印を外す回り道をさせない・監査 M-2）
    if (c && c.data.prov && holdsTerr_(ctx, c.data.terrId)) return true;
    if (c && c.data.prov && heldHouse_(ctx, id, c.data)) return true; // おすすめで押さえた仮の家（家かどうか確かめて、家でなければ消す。2026-10-26）
    return ctx.mgr || (c && c.data.createdBy === me);
  };
  const deletedHouses = applySet_(ctx, 'houses', ch.houses, ruleHouse_, function (c, id) {
    const ok = houseCanDel(c, id);
    if (ok && !ctx.mgr && c && c.data && c.data.prov) (ctx.provGone || (ctx.provGone = {}))[String(id)] = c.data; // 取り消しで仮にもどせるように（点検M-2）
    return ok;
  }, reject);
  if (deletedHouses.length && ctx.mgrOnly) mgrLog_(ctx, '家の削除', deletedHouses.length); // 区域係以外が消したものは、だれが・いつ・何を・件数だけ残す（H6）
  if (deletedHouses.length) cascadeHouses_(ctx, deletedHouses); // 拒否は上で場所だけの印にしてあるので、ここで家のキーごと消してよい
  provUndoNote_(ctx, deletedHouses);
  // 区域係が消そうとして、消さなかった家（拒否を場所だけの印にできなかった）は、同じ送信で届いた
  // その家の記録・拒否・注意・受け持ち・引き継ぎの削除と、その家の拒否を移した印も断る（家だけ残って記録が消えないように。点検M-1・2026-10-29）
  // 係以外は、自分の記録など、もともと消してよいものしか消せないので、今までどおりそれぞれの決まりで決める
  // （電波のない所で「記録の取り消し」と「家を消す」が1つの送信になったときに、取り消しまで断らないように。点検②M2）
  if (hdel.length && mgr) {
    const gone = {};
    deletedHouses.forEach(function (id) { gone[String(id)] = true; });
    hdel.forEach(function (id) { if (!gone[id] && houseData_(ctx, id)) (ctx.houseStop || (ctx.houseStop = {}))[id] = true; });
  }
  if (ch.visits && (ch.visits.up || []).length > 3) {
    prefetchHouses_(ctx, (ch.visits.up || []).map(function (v) { return String((v && v.houseId) || ''); }));
  }
  applySet_(ctx, 'visits', ch.visits, ruleVisit_, function (c) {
    if (ctx.houseStop && c.data && ctx.houseStop[String(c.data.houseId || '')]) return false; // 消さなかった家の記録（点検M-1）
    return visitCanDelete_(ctx, c);
  }, reject);
  if (ctx.fixLog && ctx.fixLog.length) fixLogWrite_(ctx);
  if (ch.dnc && !mgr && Array.isArray(ch.dnc.up)) { // 場所だけの拒否（pin:…）は区域係だけが作れる
    ch.dnc.up = ch.dnc.up.filter(function (x) {
      if (x && String(x.id).indexOf('|') > 0) return true;
      reject('dnc', x ? String(x.id) : '', 'not_allowed');
      return false;
    });
  }
  if (ch.dnc && ctx.mgrOnly && Array.isArray(ch.dnc.up)) { // 場所だけの印は、サーバーが作ったものだけ（家と拒否の管理の人は、場所だけの拒否を作れない・書きかえられない。H5）
    ch.dnc.up = ch.dnc.up.filter(function (x) { return !(x && String(x.id).indexOf('pin:') === 0); });
  }
  if (ch.dnc && mgr && Array.isArray(ch.dnc.up) && ch.dnc.up.length) {
    // 区域係の場所だけの印：位置のない印は入れない（地図に出せない。点検②L2）。
    // 同じもとの拒否（dk）の印が、ちがう id ですでにあれば入れない（2人の係が同じ家を消したとき・大きな送信が分かれたとき。点検②L3）
    const dm = ctx.col('dnc'), dkHas = {};
    dm.forEach(function (x, id) { const d = x && x.data; if (d && typeof d === 'object' && d.p && d.dk) dkHas[String(d.dk)] = String(id); });
    ch.dnc.up = ch.dnc.up.filter(function (x) {
      const id = x ? String(x.id) : '';
      const v = x && x.value && typeof x.value === 'object' ? x.value : null;
      if (id.indexOf('pin:') !== 0 || !v || !v.p) return true;
      const la = Number(v.lat), ln = Number(v.lng);
      const posOk = v.lat != null && v.lng != null && isFinite(la) && isFinite(ln);
      const dup = v.dk && dkHas[String(v.dk)] && dkHas[String(v.dk)] !== id;
      if (posOk && !dup) return true;
      reject('dnc', id, posOk ? 'dup' : 'not_allowed');
      return false;
    });
  }
  if ((ctx.houseStop || ctx.pinStop) && ch.dnc && Array.isArray(ch.dnc.up)) { // 消さなかった家の拒否を、画面が場所だけの印に移したもの（点検M-1）
    ch.dnc.up = ch.dnc.up.filter(function (x) {
      const v = x && x.value && typeof x.value === 'object' ? x.value : null;
      if (!(ctx.pinStop && x && ctx.pinStop[String(x.id)]) && !(v && v.dk && houseStopKey_(ctx, v.dk))) return true;
      reject('dnc', String(x.id), 'not_allowed');
      return false;
    });
  }
  if (ctx.mgrGone && ch.dnc && Array.isArray(ch.dnc.del) && ch.dnc.del.length) mgrUnitPins_(ctx, ch.dnc);
  const deletedDnc = applySet_(ctx, 'dnc', ch.dnc, ruleDnc_, function (c, id) {
    if (houseStopKey_(ctx, id)) return false; // 消さなかった家の拒否（点検M-1）
    if (!ctx.admin && isDncQ_(c.data)) return false; // 訪問しない印を外せるのは区域係だけ（HS-9）
    return ctx.mgr || (c.by === me && Date.now() - new Date(c.at).getTime() < DAY_MS) || dncLeaderDel_(ctx, c, id);
  }, reject);
  if (ch.caution && !admin && Array.isArray(ch.caution.up)) { // 場所だけの注意（pin:…）は区域係だけが作れる
    ch.caution.up = ch.caution.up.filter(function (x) {
      if (x && String(x.id).indexOf('|') > 0) return true;
      reject('caution', x ? String(x.id) : '', 'not_allowed');
      return false;
    });
  }
  applySet_(ctx, 'caution', ch.caution, ruleCaution_, function (c, id) {
    if (houseStopKey_(ctx, id)) return false; // 消さなかった家の注意（点検M-1）
    if (ctx.admin) return true;
    const d = c.data && typeof c.data === 'object' ? c.data : {};
    return d.u ? String(d.u) === me : (d.s === 'pub' && c.by === me); // 消せるのは区域係と、その注意を書いた本人（監査①S7）
  }, reject);
  // 引き継ぎの印（released）：係以外が作れるのは、この送信を始めたときに本人が受け持っていた家だけ（監査①S6）。
  // 受け持ちを外す（follows を消す）のと同じ送信で届くので、先に控えておく。消すのは今までどおり（ほかの人が受け持ちを引き継ぐとき）
  const myFol = {};
  if (!admin && ch.released && (ch.released.up || []).length) col('follows').forEach(function (x, id) { if (x.data && x.data.by === me) myFol[id] = true; });
  if (!admin && ch.follows && Array.isArray(ch.follows.up) && ch.follows.up.length) ctx.folUps = ch.follows.up; // 前に訪ねた家は、要るときに1回だけまとめて探す（監査6 M1・N2）
  applySet_(ctx, 'follows', ch.follows, ruleFollow_, function (c, id) { return !houseStopKey_(ctx, id) && (ctx.admin || c.data.by === me); }, reject);
  applySet_(ctx, 'released', ch.released, function (ctx2, old, v) {
    const reason = v && v.reason === 'closed' ? 'closed' : 'handoff';
    if (old && typeof old === 'object' && String(old.at) === String(v && v.at) && old.reason === reason) return old; // 送り直し（同じ内容）
    if (!ctx2.admin && !myFol[String(ctx2.curId)]) return null;
    return { at: str_(v && v.at, 40) || nowIso_(), reason: reason };
  }, function (c, id) { return !houseStopKey_(ctx, id); }, reject);
  // 外国語の家（2026-11-08）：付ける・外すのは、家の編集ができる人ならだれでも（消さなかった家の印はのぞく）
  applySet_(ctx, 'langs', ch.langs, ruleLang_, function (c, id) {
    if (houseStopKey_(ctx, id)) return false;
    if (ctx.admin) langUndoDrop_(id); else langUndoPut_(ctx, id, c.data); // 係以外が外したとき：もとの言語を控える（取り消しでもどす）
    return true;
  }, reject);
  applySet_(ctx, 'requests', ch.requests, ruleRequest_, function (c) {
    return ctx.admin || (c.data.by === me && c.data.status === 'pending');
  }, reject);
  applySet_(ctx, 'awayCards', ch.awayCards, ruleAwayCard_, function (c) { return ctx.admin; }, reject);
  applySet_(ctx, 'schedules', ch.schedules, ruleSchedule_, function (c) {
    return schedCan_(ctx, c.data.group, c.data.by);
  }, reject);
  applySet_(ctx, 's13', ch.s13, ruleS13_, function () { return ctx.admin; }, reject);
  // 同じ送信で区域が断られた（古い版など）ときは、その区域の返却の記録も入れない（記録だけが「完了」になり S-13 の日付がずれた・L11・2026-10-30）。
  // ただし、区域がすでにその返却のとおりになっているとき（返事が届かずに送り直した・区域は前の送信で入っている）は、今までどおり入れる。
  // 入れないのは、区域が「まだその人が持っている」か「留守宅カードのまま」で、返却の記録とくいちがうときだけ
  if (ch.returns && Array.isArray(ch.returns.up) && ch.returns.up.length) {
    const terrRej = {};
    rejected.forEach(function (x) { if (x.c === 'territories') terrRej[String(x.id)] = true; });
    if (Object.keys(terrRej).length) ch.returns.up = ch.returns.up.filter(function (r) {
      if (!r || !terrRej[String(r.terrId)]) return true;
      const cur0 = ctx.col('territories').get(String(r.terrId)), cur = cur0 && cur0.data ? cur0.data : null;
      // 入れるのは、区域がもうその返却のとおりになっているとき（返事が届かずに送り直した）だけ：
      // 返した時の受け取りの日（lastLentAt）が記録と同じで、今その受け取りのまま持たれておらず、留守宅カードの完了の記録なら区域ももう完了していて、
      // 完了の記録なら区域の完了日が記録の日時と同じ（10分以内）。
      // 以前は「まだ同じ人が持っている／留守宅カードのまま」のときだけ止めていたので、担当者が別の人に変わっていたときに記録だけ入った（総合監査 L11・2026-10-31）
      const MIN10 = 10 * 60000, lentSame = !!cur && String(cur.lastLentAt || '') === String(r.lentAt || '');
      const stillLent = !!(cur && cur.holder && String(cur.lentAt || '') === String(r.lentAt || ''));
      const stillPool = !!(cur && r.completed === true && cur.awayPoolAt && String(cur.poolRetId || '') === String(r.id));
      const doneOk = r.completed !== true || (!!cur && near_(cur.completedAt, r.at, MIN10));
      const poolRec = !!cur && String(cur.poolRetId || '') === String(r.id); // 留守宅カードにして返した記録（区域は lastLentAt を持つ）
      if ((lentSame || poolRec) && !stillLent && !stillPool && doneOk) return true;
      reject('returns', String(r.id), 'not_allowed');
      return false;
    });
  }
  // 区域が断られた送信では、その区域の返却の記録を消すことも通さない（S-13 の「消す」は、区域の作り直しと記録の削除を1回で送る。
  // 区域だけ断られると、完了日に合う記録のない区域が残り、係の端末の自動の確かめが巻き戻していた・総合監査 B-S13-1・2026-10-31）。
  // 留守宅カードの段階の記録（区域の poolRetId）も消させない（画面は止めているが、サーバーにも守りを置く・B-S13-3）
  if (ch.returns && Array.isArray(ch.returns.del) && ch.returns.del.length) {
    const terrRej2 = {}, poolIds = {};
    rejected.forEach(function (x) { if (x.c === 'territories') terrRej2[String(x.id)] = true; });
    ctx.col('territories').forEach(function (x) { const d = x && x.data; if (d && d.awayPoolAt && d.poolRetId) poolIds[String(d.poolRetId)] = true; });
    ch.returns.del = ch.returns.del.filter(function (id) {
      const x = ctx.col('returns').get(String(id)), d = x && x.data;
      if (!d) return true;
      if (!terrRej2[String(d.terrId)] && !poolIds[String(id)]) return true;
      reject('returns', String(id), 'not_allowed');
      return false;
    });
  }
  // 返却の記録を消せるのは区域係だけ（A-1・H3・2026-10-29）。本人の「取り消す」で記録だけが消え、記録のない途中返却になっていた
  applySet_(ctx, 'returns', ch.returns, ruleReturn_, function (c) { return ctx.admin; }, reject);

  const fix = [];
  let fixAll = rejected.length > 50;
  if (!fixAll) {
    let pv = null;
    rejected.forEach(function (r) {
      if (!r.id || DATA_COLS.indexOf(r.c) < 0) { fixAll = true; return; }
      let cur = null;
      const m = ctx.cols[r.c];
      if (m && !m.partial) { const x = m.get(r.id); cur = x ? x.data : null; }
      else { const f = findRow_(r.c, r.id); cur = f ? f.data : null; }
      let v = null;
      if (cur !== null) {
        if (r.c === 'visits' && !admin && !pv) pv = permView_(user, null);
        const mm = mask_(user, r.c, cur, r.c === 'visits' ? pv : null);
        v = mm === undefined ? null : mm;
      }
      fix.push([r.c, r.id, v]);
    });
  }
  if (ctx.mgrOnly && deletedDnc && deletedDnc.length) mgrLog_(ctx, '拒否の削除', deletedDnc.length);
  mgrLogWrite_(ctx);
  return { rejected: rejected, fix: fixAll ? null : fix, fixAll: fixAll, skew: ctx.skew ? Math.round(ctx.skew / 60000) : 0 };
}

function holdsTerr_(ctx, tid) {
  if (!tid) return false;
  const t = ctx.col('territories').get(String(tid));
  if (!t) return false;
  const d = t.data;
  if (d.holder === ctx.me) return true;
  if (isLeadOf_(ctx, d)) return true; // 今日の司会
  return (d.helpers || []).some(function (h) { return h.uid === ctx.me && Date.parse(h.until) > Date.now(); });
}

/* =========================================================
   今日の司会（2026-10-24）
   集まりで使う区域（group あり）の担当者（監督・司会者）が司会できない日に、ほかの監督・司会者が
   「今日だけ司会」をする。区域には lead を持たせる：
     lead: { uid: 司会する人, h: そのときの担当者, until: 今日の終わり（日本時間）, by, at }
   ・担当者（holder）・S-13・持てる枚数は変わらない。1枚につき1人（ほかの人が今日の司会なら受け付けない）
   ・今日の司会は、担当者と同じように「今日回る人」「回る範囲」を決め、その日の記録を直せる。
     返却・担当交代・使い道の変更はできない
   ・年代など、くわしい記録が見えるのは今までどおり担当者だけ（permView_ は変えない）
   ・担当者が変わる（返却・担当交代）と h が合わなくなるので、自動で効かなくなる
   ========================================================= */
function jstDayEnd_(now) {
  const j = now + 9 * 3600000;
  return new Date(Math.floor(j / DAY_MS) * DAY_MS + DAY_MS - 9 * 3600000 - 1).toISOString();
}
function leadActive_(ctx, d) {
  if (!d || !d.lead || typeof d.lead !== 'object' || !d.holder || !d.group || !Number(ctx.settings.groupOn)) return null;
  const l = d.lead;
  if (!l.uid || l.uid === d.holder || l.h !== d.holder) return null;
  return Date.parse(l.until) > Date.now() ? l : null;
}
function isLeadOf_(ctx, d) { const l = leadActive_(ctx, d); return !!l && l.uid === ctx.me; }
function newLead_(ctx, old) {
  const now = Date.now();
  return { uid: ctx.me, h: old.holder, until: jstDayEnd_(now), by: ctx.me, at: new Date(now).toISOString() };
}
/* 今日の司会を引き受ける送信として受け付けてよいか
   ・前の日の古い lead を送り直して、今日の司会にならないように（until が今日のうち）
   ・担当者（係）が外したあとに、古い画面から同じ lead が届いても戻らないように（leadOff＝外した時刻より後に引き受けたもの） */
function leadFresh_(t, old) {
  const l = t && t.lead, now = Date.now();
  const u = Date.parse(l && l.until), a = Date.parse(l && l.at);
  if (!isFinite(u) || u <= now || u > now + 26 * 3600000 || !isFinite(a)) return false;
  const off = Date.parse(old && old.leadOff);
  return !isFinite(off) || a > off;
}
/* 引き受けてよい区域か：集まりで使う区域で、担当者がほかの監督・司会者 */
function leadOk_(ctx, old) {
  if (!old || !old.holder || old.holder === ctx.me || !old.group || !Number(ctx.settings.groupOn)) return false;
  return canGroupTerr_(ctx.user);
}

/* 係以外の人が新しく作るものの id・鍵の形（監査①S2）。家につながった印は「家id|部屋」、ほかは ID_RE */
function idOk_(name, id) {
  return MAP_COLS.indexOf(name) >= 0 ? KEY_RE.test(String(id)) : ID_RE.test(String(id));
}
/* 2つの日時が、ms 以内か（どちらかが日時でなければ false） */
function near_(a, b, ms) {
  const x = Date.parse(String(a || '')), y = Date.parse(String(b || ''));
  return isFinite(x) && isFinite(y) && Math.abs(x - y) <= ms;
}

function idTime_(id) {
  const s = String(id || '');
  if (s.length < 9) return 0;
  const t = parseInt(s.slice(0, s.length - 5), 36);
  return isFinite(t) && t > 1.6e12 && t < Date.now() + DAY_MS ? t : 0;
}

function applySet_(ctx, name, ch, rule, canDelete, reject) {
  if (!ch) return [];
  const isMap = MAP_COLS.indexOf(name) >= 0;
  const partial = PARTIAL_COLS.indexOf(name) >= 0;
  const map = partial ? (function () { const m = new Map(); m.partial = true; return m; })() : ctx.col(name);
  let seen = null, fresh = null;
  if (name === 'visits' && (ch.up || []).length) {
    const now = Date.now();
    try { seen = CacheService.getScriptCache().getAll(ch.up.map(function (x) { return 'vi_' + String(x && x.id); })); } catch (e) { seen = {}; }
    fresh = {};
    // 送り直し（前の送信の返事が届かなかった）のときは、「新しい記録」と決めつけずに、シートにすでにあるか確かめる。
    // 決めつけると、一時保存（seen）が消えていた場合に同じ記録が2行になる（監査D3）
    if (!ctx.re) ch.up.forEach(function (x) { const id = String(x && x.id); const t = idTime_(id); if (t && now - t < VISIT_FRESH_MS) fresh[id] = true; });
  }
  let idRows = null;
  const needLook = (ch.del || []).length + (ch.up || []).filter(function (x) {
    const id = String(x && x.id); return !(seen && seen['vi_' + id]) && !(fresh && fresh[id]);
  }).length;
  if (partial && needLook > 3) {
    const sh = dataSheet_(name), n = sh.getLastRow();
    idRows = new Map();
    if (n >= 2) sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (r, i) {
      if (r[0] !== '') idRows.set(String(r[0]), i + 2);
    });
  }
  const get = function (id) {
    if (map.has(id)) return map.get(id);
    if (!partial) return undefined;
    let f = null;
    if (idRows) {
      const r = idRows.get(id);
      if (r) {
        const v = dataSheet_(name).getRange(r, 1, 1, 4).getValues()[0];
        const data = parseJson_(v[1], undefined);
        if (data !== undefined) f = { row: r, data: data, at: v[2], by: String(v[3]) };
      }
    } else {
      f = findRow_(name, id);
    }
    if (f) map.set(id, f);
    return f || undefined;
  };
  const ups = [], dels = [];
  (ch.up || []).forEach(function (item) {
    if (!item || item.id == null) return;
    const id = String(item.id);
    if (seen && seen['vi_' + id]) return;
    const data = isMap ? item.value : item;
    const cur = fresh && fresh[id] ? undefined : get(id);
    if (!ctx.admin && !cur && !idOk_(name, id)) return reject(name, id, 'not_allowed'); // 新しく作るものの id の形（監査①S2）
    ctx.curId = id; ctx.curRow = cur || null; // 決まりの中で鍵（家id|部屋）と、今の行（だれが書いたか）を使うため
    const ok = rule(ctx, cur ? cur.data : null, data);
    if (ok === null || ok === undefined || ok === false) return reject(name, id, 'not_allowed');
    // 内容が変わらないもの（送り直し・係以外が書きかえられない印を同じ内容で送ってきた等）は、行を書き直さない（A-2・H9b・2026-10-29）。
    // 書き直すと「更新した人・時刻」が送った人の今になり、係が入れた拒否を伝道者が 24時間は消せる穴になっていた。変更の記録（差分）にも残らない
    if (cur && (ok === cur.data || stable_(ok) === stable_(cur.data))) return;
    ups.push([id, ok]);
  });
  (ch.del || []).forEach(function (id) {
    id = String(id);
    const cur = get(id);
    if (!cur) return;
    if (!canDelete(cur, id)) return reject(name, id, 'not_allowed');
    dels.push(id);
  });
  // 訪問記録を消すときは、同じ番号の行をすべて消す（以前の送り直しで2行になっていた記録が、1行だけ残らないように）
  const extra = name === 'visits' && partial && dels.length ? dupRows_(name, dels, map) : [];
  writeCol_(name, map, ups, dels, ctx.me, extra);
  if (name === 'visits' && ups.length) {
    try {
      const o = {}; ups.forEach(function (p) { o['vi_' + p[0]] = '1'; });
      CacheService.getScriptCache().putAll(o, VISIT_SEEN_SEC);
    } catch (e) { /* 覚えられなくても、次はシートを探すだけ */ }
  }
  if (name === 'houses' && ctx.hcache) {
    ups.forEach(function (p) { ctx.hcache.set(p[0], p[1]); });
    dels.forEach(function (id) { ctx.hcache.set(id, null); });
  }
  return dels;
}

function cascadeHouses_(ctx, hids) {
  const set = {};
  hids.forEach(function (h) { set[h] = true; });
  const sh = dataSheet_('visits'), n = sh.getLastRow();
  if (n >= 2) {
    const rowSet = {};
    const colB = sh.getRange(2, 2, n - 1, 1);
    const one = function (h) {
      colB.createTextFinder('"houseId":"' + h + '"').matchCase(true).findAll()
        .forEach(function (c) { rowSet[c.getRow()] = true; });
    };
    // 家を40軒ずつまとめて1回で探す（1軒ずつだと、仮の家をまとめて消すときに何分もかかる・点検③P10）。うまくいかないときは1軒ずつ
    const reEsc = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    for (let i = 0; i < hids.length; i += 40) {
      const part = hids.slice(i, i + 40);
      try {
        colB.createTextFinder('"houseId":"(' + part.map(reEsc).join('|') + ')"').useRegularExpression(true).matchCase(true).findAll()
          .forEach(function (c) { rowSet[c.getRow()] = true; });
      } catch (e) {
        console.warn('まとめて探せませんでした（1軒ずつ探します）：' + e);
        part.forEach(one);
      }
    }
    const rows = Object.keys(rowSet).map(Number);
    if (rows.length) {
      const ids = sh.getRange(2, 1, n - 1, 1).getValues();
      const map = new Map(); map.partial = true;
      const vdel = [];
      rows.forEach(function (r) {
        const id = String(ids[r - 2][0] || '');
        if (id) { map.set(id, { row: r, data: null }); vdel.push(id); }
      });
      writeCol_('visits', map, [], vdel, ctx.me);
    }
  }
  MAP_COLS.forEach(function (c) {
    const m = ctx.col(c);
    const d = [];
    m.forEach(function (x, id) { if (set[id.split('|')[0]]) d.push(id); });
    writeCol_(c, m, [], d, ctx.me);
  });
}

function stable_(o) {
  if (Array.isArray(o)) return '[' + o.map(stable_).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + stable_(o[k]); }).join(',') + '}';
  return JSON.stringify(o === undefined ? null : o);
}

function cleanHelpers_(ctx, t, holder) {
  if (!Number(ctx.settings.groupOn) || !Array.isArray(t.helpers)) return [];
  if (!ctx.activeIds) { ctx.activeIds = {}; usersAll_().forEach(function (u) { if (u.active) ctx.activeIds[u.id] = true; }); }
  const now = Date.now(), maxUntil = now + 26 * 3600000, seen = {}, out = [];
  t.helpers.forEach(function (h) {
    if (!h || !ctx.activeIds[h.uid] || h.uid === holder || seen[h.uid]) return;
    const until = Date.parse(h.until);
    if (!isFinite(until) || until <= now) return;
    seen[h.uid] = true;
    out.push({ uid: str_(h.uid, 40), until: new Date(Math.min(until, maxUntil)).toISOString(),
      by: str_(h.by, 40) || ctx.me, at: str_(h.at, 40) || nowIso_() });
  });
  return out.slice(0, t.group ? 40 : (Number(ctx.settings.groupMax) || 4));
}

function cleanParts_(ctx, t) {
  if (!Array.isArray(t.parts)) return [];
  if (!ctx.activeIds) { ctx.activeIds = {}; usersAll_().forEach(function (u) { if (u.active) ctx.activeIds[u.id] = true; }); }
  const now = Date.now(), maxUntil = now + 26 * 3600000, out = [];
  const roomBudget = { n: 1500 }; // 部屋ごとの範囲は、区域（カード）ぜんたいで1,500部屋まで
  t.parts.forEach(function (p) {
    if (!p || !Array.isArray(p.poly)) return;
    const until = Date.parse(p.until);
    if (!isFinite(until) || until <= now) return;
    const poly = p.poly.slice(0, 60)
      .map(function (v) { return [Number(v[0]), Number(v[1])]; })
      .filter(function (v) { return isFinite(v[0]) && isFinite(v[1]); });
    if (poly.length < 3) return;
    const seen = {}, uids = [];
    (Array.isArray(p.uids) ? p.uids : []).forEach(function (u) {
      const id = str_(u, 40);
      if (ctx.activeIds[id] && !seen[id]) { seen[id] = true; uids.push(id); }
    });
    if (!uids.length) return;
    if (!ID_RE.test(str_(p.id, 40))) return; // 範囲の id は画面の属性に入るので、形を限る（監査①S2）
    const o = { id: str_(p.id, 40), poly: poly, uids: uids.slice(0, 8),
      until: new Date(Math.min(until, maxUntil)).toISOString(),
      by: str_(p.by, 40) || ctx.me, at: str_(p.at, 40) || nowIso_() };
    // 集合住宅の部屋ごとの範囲（2026-11-08・画面 heya-wake.js）：rooms＝{ 建物のid: [部屋…] }、ro＝部屋だけの範囲
    const rooms = cleanPartRooms_(p.rooms, roomBudget, !p.ro);
    const hasRoom = !!rooms && Object.keys(rooms).some(function (k) { return rooms[k].length; });
    if (p.ro) { if (!hasRoom) return; o.ro = 1; } // 部屋だけの範囲で、部屋が残らなければ範囲ごと捨てる（囲みの範囲にならないように）
    if (rooms) o.rooms = rooms;
    out.push(o);
  });
  return out.slice(0, 30);
}

/* 範囲の rooms の形を確かめる：建物の id は ID_RE、部屋は20文字までの文字。建物20棟・1棟400部屋まで。
   budget：区域ぜんたいで残してよい部屋の数（1つのセルに収めるため）。囲みのある範囲だけ空の一覧（その建物は部屋なし）を残す。
   何も残らなければ null */
function cleanPartRooms_(r, budget, keepEmpty) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  Object.keys(r).slice(0, 20).forEach(function (hid) {
    if (!ID_RE.test(hid) || hid === '__proto__' || !Array.isArray(r[hid])) return;
    const seen = Object.create(null), us = [];
    r[hid].slice(0, 400).forEach(function (u) {
      if (typeof u !== 'string' && typeof u !== 'number') return;
      const s = str_(u, 20);
      if (s && !seen[s] && budget.n > 0) { seen[s] = true; us.push(s); budget.n--; }
    });
    if (us.length || keepEmpty) out[hid] = us;
  });
  return Object.keys(out).length ? out : null;
}

/* 紙の区域カード（S-13）から引き継いだ区域か：区域係が S-13 で「グループ奉仕（名前）」を入れてアプリに渡したもの。
   paperHand＝紙で割り当てた日。担当が変わる（受け取った日が変わる）と自然に外れる */
function paperHand_(t) {
  if (!t || !t.paperHand || !t.holder || !t.lentAt) return false;
  const ms = Date.parse(String(t.lentAt));
  return isFinite(ms) && Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd') === String(t.paperHand);
}
function holdMax_(s, forGroup) { return Number(forGroup ? s.holdMaxGroup : s.holdMaxPersonal) || 2; }
function heldCount_(ctx, forGroup) {
  let n = 0;
  ctx.col('territories').forEach(function (x) { if (x.data.holder === ctx.me && !!x.data.group === forGroup) n++; });
  return n;
}
function pendingCount_(ctx, forGroup, exceptTerr) {
  let n = 0;
  ctx.col('requests').forEach(function (x) {
    const d = x.data;
    if (!d.type && d.by === ctx.me && d.status === 'pending' && !!d.forGroup === forGroup &&
      Date.now() - Date.parse(d.at) < 30 * DAY_MS && !(exceptTerr && d.terrId === exceptTerr)) n++;
  });
  return n;
}
/* 区域ごとの貸し出し：auto＝きまりのとおり、open＝貸出可能、stop＝貸出中止（以前の free:true は open） */
function lendMode_(t) { return t && (t.lend === 'open' || t.lend === 'stop' || t.lend === 'auto') ? t.lend : (t && t.free ? 'open' : 'auto'); }
/* 自動受け取り：まだ一度も返却されていない区域と、正式に返却されてから決めた日数がたった区域 */
function autoFree_(s, t) {
  if (Number(s.autoFree) !== 1 || t.awayPoolAt) return false; // 留守宅カードで回っている最中は、自動では出さない
  if (t.paperLentAt) return false; // 紙の記録（S-13）で貸出中（係のスマホが書く）
  // 紙の記録で回り終えた日（paperDone・係のスマホが S-13 から書く）も、正式な返却として数える
  const done = [t.completedAt, t.paperDone].filter(function (x) { return !!x; }).map(String).sort().pop() || '';
  const base = [done, t.returnedAt].filter(function (x) { return !!x; }).map(String).sort().pop();
  if (!base) return true;
  // 最後まで回りきらずに返された区域（途中返却・ほとんど回らず返却）は、日数を待たずに受け取れる
  if (t.returnedAt && (!done || String(t.returnedAt) > done)) return true;
  const at = Date.parse(base);
  return isFinite(at) && Date.now() - at >= (Number(s.freeAfterDays) || 0) * DAY_MS;
}

/* 集まりの予定を入れる・直す・消せるか（2026-11-11）
   ・区域係：どれでも
   ・監督：自分のグループの予定（今までどおり）
   ・監督・司会者（グループのある人）：全体の予定のうち、自分が入れたもの（by が本人）だけ */
function schedCan_(ctx, group, by) {
  const u = ctx.user, g = normGroup_(group);
  if (ctx.admin) return true;
  if (g) return !!(u.overseer && u.group && g === u.group);
  return canGroupTerr_(u) && String(by || '') === String(ctx.me);
}
function ruleSchedule_(ctx, old, v) {
  if (!v) return null;
  const g = normGroup_(v.group);
  const by = old ? old.by : ctx.me; // 入れた人は変えない（新しい予定は送った本人）
  if (!schedCan_(ctx, g, by) || (old && !schedCan_(ctx, old.group, old.by))) return null;
  // 司会者の名前：全体の予定だけ・30文字まで。送られてこない（古い画面）ときは今の名前を残す
  const host = g ? '' : (v.host === undefined || v.host === null ? (old && !normGroup_(old.group) ? str_(old.host, 30) : '') : String(v.host).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 30)); // 改行・制御文字・文字の向きを変える文字は取りのぞく（印刷がくずれないように）
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.date))) return null;
  const tm = function (x) { return /^\d{1,2}:\d{2}$/.test(String(x || '')) ? String(x) : ''; };
  // 場所：GoogleマップのピンのURL（Googleマップのアドレスだけ）と、地図でえらんだ位置
  const mu = str_(v.mapUrl, 300).trim();
  const mapUrl = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\//i.test(mu) ? mu : '';
  const la = Array.isArray(v.loc) ? Number(v.loc[0]) : NaN, ln = Array.isArray(v.loc) ? Number(v.loc[1]) : NaN;
  const loc = isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 ? [Math.round(la * 1e6) / 1e6, Math.round(ln * 1e6) / 1e6] : null;
  return { id: str_(v.id, 40), group: g, date: String(v.date), time: tm(v.time), end: tm(v.end),
    place: str_(v.place, 60), note: str_(v.note, 160), host: host, mapUrl: mapUrl, loc: loc, by: by, at: str_(v.at, 40) || nowIso_() };
}

/* 特別区域（コンビニ・オートロックなど）で回る家・部屋か（画面の coveredBySpecial と同じ決まり）
   ・ふつうの区域カードから外す（excl が false でない）・貸出中止でない特別区域だけ
   ・「一度も会えていない家」の条件がある特別区域は、ふつうの区域から外さない（会えると対象が変わるため）
   ・家を名指しした特別区域（special.ids：件数で分けたカード）は、その家だけ。そうでなければ線の中の家 */
function spCover_(ctx) {
  if (ctx.spCover) return ctx.spCover;
  const list = [];
  ctx.col('territories').forEach(function (x) {
    const t = x && x.data, sp = t && t.special;
    if (!sp || typeof sp !== 'object' || sp.excl === false || sp.unmet || lendMode_(t) === 'stop') return;
    const kinds = Array.isArray(sp.kinds) ? sp.kinds.map(String) : [];
    const ev = sp.ev === 'y' || sp.ev === 'n' ? sp.ev : '';
    if (!kinds.length && !sp.lock && !sp.apt && !ev) return;
    const apt = !!sp.apt || (!!ev && !sp.lock && !kinds.length); // エレベーターだけの古い形は、集合住宅とみなす
    const o = { kinds: kinds, lock: !!sp.lock, apt: apt, ev: ev, ids: null, poly: null };
    if (Array.isArray(sp.ids) && sp.ids.length) { o.ids = {}; sp.ids.forEach(function (id) { o.ids[String(id)] = true; }); }
    else if (Array.isArray(t.polygon) && t.polygon.length >= 3) {
      const poly = t.polygon.map(function (v) { return [Number(v[0]), Number(v[1])]; }).filter(function (v) { return isFinite(v[0]) && isFinite(v[1]); });
      if (poly.length >= 3) {
        let s = 90, n = -90, w = 180, e = -180;
        poly.forEach(function (v) { s = Math.min(s, v[0]); n = Math.max(n, v[0]); w = Math.min(w, v[1]); e = Math.max(e, v[1]); });
        o.poly = [{ id: 1, poly: poly, s: s, n: n, w: w, e: e }];
      }
    }
    list.push(o);
  });
  const kindOfU = function (h, u) {
    if (h.type === 'apt') { const m = h.uk && typeof h.uk === 'object' ? h.uk : null; return m && m[u] ? String(m[u]) : 'home'; }
    return h.kind ? String(h.kind) : 'home';
  };
  ctx.spCover = function (h, u) {
    if (!list.length || !h) return false;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.ids ? !o.ids[String(h.id)] : (o.poly && !reassignFind_(o.poly, Number(h.lat), Number(h.lng)))) continue;
      // 種別（コンビニなど・集合住宅・オートロック）は「どれかに当たる」家（2026-10-22。画面の spMatch と同じ）
      const k = kindOfU(h, String(u || '')), isA = h.type === 'apt' && h.ban !== 'no';
      if (!(o.kinds.indexOf(k) >= 0 || (o.apt && isA && k === 'home') || (o.lock && isA && h.lock))) continue;
      // エレベーターは集合住宅の建物だけにかける
      if (o.ev && h.type === 'apt' && (o.ev === 'y' ? h.ac !== 'ev' : h.ac === 'ev')) continue;
      return true;
    }
    return false;
  };
  return ctx.spCover;
}

/* 見つけたセル（同じ列・TextFinder の findAll の結果）の中身を、近い行をまとめて読む（点検③P8・2026-10-24）。
   1つずつ getValue すると、件数が多いとき（記録が数千件）に時間がかかるため。gap 行までのすき間は、まとめて1回で読む */
function readFound_(sh, col, cells, gap) {
  gap = gap || 30;
  const rows = cells.map(function (c) { return c.getRow(); }).sort(function (a, b) { return a - b; });
  const out = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] - rows[j] <= gap && rows[j + 1] - rows[i] < 5000) j++;
    const from = rows[i], vals = sh.getRange(from, col, rows[j] - from + 1, 1).getValues();
    for (let k = i; k <= j; k++) out.push(vals[rows[k] - from][0]);
    i = j + 1;
  }
  return out;
}

/* 区域の「回った割合」をサーバーで数える（返却で「回り終えた」と送られたときだけ使う）
   ・家：その区域の家（集合住宅は部屋ごと）。拒否の家・部屋は数に入れない
   ・回った：回りはじめた日から後の記録がある家。係の設定で「最近会えた家」も回った数に入れる
   ・同じ送信で届いた記録も入れる（記録と返却を一緒に送ることがあるため）
   ・数えられないとき（家の行が読めない等）は null（画面の割合を使う） */
function terrDonePct_(ctx, t, since) {
  try {
    const tid = String(t.id || '');
    if (!tid) return null;
    // 特別区域は家の terrId で探せない（家はふつうの区域に属する）。名指しの家（ids）がなければ数えない＝画面の割合を使う（以前は家0軒で 100% になっていた・L12）
    // 特別区域は、サーバーでは数えない（null＝画面の割合を使う）。家の種別・エレベーター・最近会えた家など、画面の数え方（spMatch）とそろえられないため。
    // 以前は家0軒で 100% を返していた（結果は同じく止めない）。組C 監査 H2・2026-10-30
    if (isSpecialTerr_(t)) return null;
    const hsh = dataSheet_('houses'), hn = hsh.getLastRow();
    if (hn < 2) return null;
    const keys = {}, dnc = ctx.col('dnc'), cov = spCover_(ctx), hids = [], lm = ctx.col('langs');
    const langNo = function (k) { const x = lm.get(k); return !!(x && langSkipOf_(x.data, ctx.settings)); }; // 訪問しない言語の家（2026-11-08）
    readFound_(hsh, 2, hsh.getRange(2, 2, hn - 1, 1).createTextFinder('"terrId":"' + tid + '"').findAll().slice(0, 1500)).forEach(function (val) {
      const h = parseJson_(val, null);
      if (!h || String(h.terrId) !== tid) return;
      if (h.type === 'apt' && h.ban === 'no') return; // 立入禁止の建物は回らないので、部屋を分母に入れない（A-6・M4。手紙のみ（letter）は今までどおり数える）
      hids.push(String(h.id));
      const us = h.type === 'apt' ? (Array.isArray(h.units) ? h.units : []) : [''];
      us.forEach(function (u) {
        const k = String(h.id) + '|' + String(u || '');
        if (dnc.get(k) || cov(h, u) || langNo(k)) return; // 拒否の家・特別区域（コンビニなど）で回る家・訪問しない言語の家は数えない（画面の coveredBySpecial・noVisit と同じ）
        keys[k] = false;
      });
    });
    const total = Object.keys(keys).length;
    if (!total) return 100;
    const from = Date.parse(String(since || '')) || 0;
    const skip = Number(ctx.settings.skipDone) === 1 ? (Number(ctx.settings.skipDays) || 0) * DAY_MS : 0;
    const mark = function (v) {
      if (!v) return;
      const k = String(v.houseId) + '|' + String(v.unit || ''), at = Date.parse(String(v.at || ''));
      if (!(k in keys) || !isFinite(at)) return;
      if (at >= from || (skip && v.result === 'met' && Date.now() - at <= skip)) keys[k] = true;
    };
    const vsh = dataSheet_('visits'), vn = vsh.getLastRow();
    if (vn >= 2) readFound_(vsh, 2, vsh.getRange(2, 2, vn - 1, 1).createTextFinder('"t":"' + tid + '"').findAll()).forEach(function (val) { mark(parseJson_(val, null)); });
    (ctx.pendVisits || []).forEach(mark);
    // 区域の線を直して入った家の記録は、記録の t が前の区域のまま（A-6・M5）。まだ「回った」になっていない家だけ、家の番号で探し直す
    // （回り終えた区域ではその家は少ないので、ふつうは 1回の検索。多すぎるとき（200軒超）は、今までどおり t の分だけで数える）
    if (vn >= 2) {
      const left = {};
      Object.keys(keys).forEach(function (k) { if (!keys[k]) left[k.split('|')[0]] = true; });
      const ids = Object.keys(left).filter(function (id) { return hids.indexOf(id) >= 0; });
      if (ids.length && ids.length <= 200) {
        for (let i = 0; i < ids.length; i += 40) {
          const rx = '"houseId":"(' + ids.slice(i, i + 40).map(function (id) { return String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')"';
          try { readFound_(vsh, 2, vsh.getRange(2, 2, vn - 1, 1).createTextFinder(rx).useRegularExpression(true).matchCase(true).findAll()).forEach(function (val) { mark(parseJson_(val, null)); }); }
          catch (e) { console.warn('家の番号での記録の探し直しができませんでした：' + e); } // 探し直せなくても、t で数えた分で確かめる（監査 L-2）
        }
      }
    }
    let n = 0;
    Object.keys(keys).forEach(function (k) { if (keys[k]) n++; });
    return Math.round(n / total * 100);
  } catch (e) {
    console.warn('回った割合を数えられませんでした：' + e);
    return null;
  }
}

/* 留守宅カードの段階の区域で、「訪ね直した」家の割合をサーバーで数える（留守宅カードの完了の確かめ・総合監査 H9c・2026-10-31）。
   画面の poolInfo（訪ね直した家÷1回目に会えなかった家）は、時間帯・別の日などの設定で数え方が変わり、そのままは写せない。
   そこで「画面が完了と数えるなら必ず満たすこと」だけを確かめる（正しい完了を断らない）：
   ・対象（n）：1回目（since〜first）に訪ねた家で、最初に訪ねた日（日本時間）に会えていない家（画面の n はこの中にふくまれる）
   ・訪ね直した（done）：その家に since から後の記録が2件以上ある（画面が訪ね直したと数える家は、かならず2件以上）
   1回目のあとで会えた家（画面では訪ね直したに数える）も、ここでは n と done の両方に入るので、割合は画面より低くならない。
   以前は「巡回の記録のある家の割合」だけを確かめていたため、1回目の記録だけで（訪ね直し0軒でも）完了を受け付けていた。
   数えられないとき・特別区域は null（今までどおり確かめない） */
function poolRevisitPct_(ctx, t, since, first) {
  try {
    const tid = String(t.id || '');
    if (!tid || isSpecialTerr_(t)) return null;
    const hsh = dataSheet_('houses'), hn = hsh.getLastRow();
    if (hn < 2) return null;
    const keys = {}, dnc = ctx.col('dnc'), cov = spCover_(ctx), hids = [], lm = ctx.col('langs');
    const langNo = function (k) { const x = lm.get(k); return !!(x && langSkipOf_(x.data, ctx.settings)); }; // 訪問しない言語の家（2026-11-08）
    readFound_(hsh, 2, hsh.getRange(2, 2, hn - 1, 1).createTextFinder('"terrId":"' + tid + '"').findAll().slice(0, 1500)).forEach(function (val) {
      const h = parseJson_(val, null);
      if (!h || String(h.terrId) !== tid) return;
      if (h.type === 'apt' && h.ban === 'no') return; // 立入禁止の建物（terrDonePct_・画面の banNo と同じ）
      hids.push(String(h.id));
      const us = h.type === 'apt' ? (Array.isArray(h.units) ? h.units : []) : [''];
      us.forEach(function (u) {
        const k = String(h.id) + '|' + String(u || '');
        if (dnc.get(k) || cov(h, u) || langNo(k)) return;
        keys[k] = [];
      });
    });
    if (!Object.keys(keys).length) return null;
    const s0 = String(since || ''), f0 = String(first || '');
    const seen = {};
    const add = function (v) {
      if (!v) return;
      const k = String(v.houseId) + '|' + String(v.unit || ''), at = String(v.at || '');
      if (!(k in keys) || !isFinite(Date.parse(at)) || at < s0) return;
      const sig = k + '@' + at + '@' + String(v.id || '');
      if (seen[sig]) return; // 同じ記録を2回数えない（t で探した分と家の番号で探した分の重なり）
      seen[sig] = true;
      keys[k].push({ at: at, met: v.result === 'met' });
    };
    const vsh = dataSheet_('visits'), vn = vsh.getLastRow();
    if (vn >= 2) readFound_(vsh, 2, vsh.getRange(2, 2, vn - 1, 1).createTextFinder('"t":"' + tid + '"').findAll()).forEach(function (val) { add(parseJson_(val, null)); });
    (ctx.pendVisits || []).forEach(add);
    // 線を直して入った家（記録の t が前の区域）：記録が1件も見つからない家だけ、家の番号で探し直す（terrDonePct_ と同じ・200軒まで）
    if (vn >= 2) {
      const left = {};
      Object.keys(keys).forEach(function (k) { if (!keys[k].length) left[k.split('|')[0]] = true; });
      const ids = Object.keys(left).filter(function (id) { return hids.indexOf(id) >= 0; });
      if (ids.length && ids.length <= 200) {
        for (let i = 0; i < ids.length; i += 40) {
          const rx = '"houseId":"(' + ids.slice(i, i + 40).map(function (id) { return String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')"';
          try { readFound_(vsh, 2, vsh.getRange(2, 2, vn - 1, 1).createTextFinder(rx).useRegularExpression(true).matchCase(true).findAll()).forEach(function (val) { add(parseJson_(val, null)); }); }
          catch (e) { console.warn('家の番号での記録の探し直しができませんでした：' + e); }
        }
      }
    }
    let n = 0, done = 0, vis1 = 0;
    const tot = Object.keys(keys).length;
    Object.keys(keys).forEach(function (k) {
      const vs = keys[k].slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
      if (!vs.length || vs[0].at > f0) return; // 1回目に訪ねていない家は、ここでは数えない
      vis1++;
      const d0 = jstDay_(Date.parse(vs[0].at));
      if (vs.some(function (v) { return v.met && jstDay_(Date.parse(v.at)) === d0; })) return; // 最初に訪ねた日に会えた家は、留守宅ではない
      n++;
      if (vs.length >= 2) done++;
    });
    // r1＝1回目の割合（画面 poolInfo の vis/tot と同じ：1回目に訪ねた家÷家）
    return { n: n, done: done, pct: n ? Math.round(done / n * 100) : 100, r1: tot ? vis1 / tot * 100 : 100 }; // r1 は丸めない（画面の vis/tot と同じ比べ方）
  } catch (e) {
    console.warn('訪ね直した割合を数えられませんでした：' + e);
    return null;
  }
}

/* 特別区域か（画面の isSpecial と同じ：種別・オートロック・会えていない家・集合住宅・エレベーターのどれかがある） */
function isSpecialTerr_(t) {
  const sp = t && t.special;
  return !!(sp && typeof sp === 'object' && ((Array.isArray(sp.kinds) && sp.kinds.length) || sp.lock || sp.unmet || sp.apt || sp.ev === 'y' || sp.ev === 'n'));
}

/* 途中で返された区域（schedule.js の isPartial と同じ）が、いま「続きから」受け取れるか */
/* 「続きから受け取れる区域」（画面の tsuzuki.js canCont・app.js contAvail と同じ）。留守宅カードを作らせない判定に使う（M11）。
   contOk_ に、紙で貸出中でないこと・紙で回り終えた日（paperDone）より後に返却したことを足す */
function contAvail_(s, t) {
  if (!contOk_(s, t) || t.paperLentAt) return false;
  return !t.paperDone || String(t.returnedAt) > String(t.paperDone);
}
function contOk_(s, old) {
  if (!old || old.holder || old.awayPoolAt || !old.returnedAt || !old.lastRoundFrom) return false;
  if (old.completedAt && !(String(old.returnedAt) > String(old.completedAt))) return false;
  const d = Number(s.contDays);
  if (!isFinite(d) || d <= 0) return false;
  const at = Date.parse(old.returnedAt);
  return isFinite(at) && Date.now() - at <= d * DAY_MS;
}

/**
 * 区域には版(rev)をつける。係の端末が古い内容のまま保存して、ほかの人の変更（借りた・返した 等）を
 * 上書きしてしまうのを防ぐ。版が合わない係の保存は受け付けず、今の内容を返す（端末が読み直す）。
 * 版を送ってこない古い端末は、これまでどおり受け付ける。
 */
function ruleTerritory_(ctx, old, t) {
  const oldRev = old ? (Number(old.rev) || 0) : 0;
  const o0 = old ? Object.assign({}, old) : old;
  if (o0) { delete o0.rev; delete o0.revBy; }
  const t0 = Object.assign({}, t);
  const trev = t0.rev;
  delete t0.rev; delete t0.revBy;
  // 版が合わなくても、直前に書いたのが本人(同じ係)なら、続けて保存した自分の変更なので受け付ける
  if (ctx.admin && old && trev !== undefined && trev !== null && (Number(trev) || 0) !== oldRev && old.revBy !== ctx.me) {
    // 版が古くても、送られた内容が今の内容と同じなら受け付ける（2人の区域係が同時に同じ印を付けたときなど。上書きは起きない・H2）
    const same = ruleTerritory0_(ctx, o0, t0);
    return same && (same === o0 || stable_(same) === stable_(o0)) ? old : null;
  }
  // 版が合わないが、直前に書いたのが同じ係のとき（続けて保存した自分の変更）：貸し出し・返却の状態（担当者・受け取った日・返した日・完了日・留守宅カード）が
  // 今の内容とちがう送信は受け付けない。続けて保存した変更なら、端末は前の保存の結果（その状態）をもう持っているので同じになる。
  // ちがうのは、前の保存より前に作られた古い変更（「送れない変更」を次に開いたときに送り直した等）で、通すと間の貸し出しが古い内容で消えた（総合監査 B-RE-1・2026-10-31）
  if (ctx.admin && old && trev !== undefined && trev !== null && (Number(trev) || 0) !== oldRev && old.revBy === ctx.me) {
    const LEND_KEYS = ['holder', 'lentAt', 'returnedAt', 'completedAt', 'awayPoolAt'];
    if (LEND_KEYS.some(function (k) { return String(t0[k] == null ? '' : t0[k]) !== String(o0[k] == null ? '' : o0[k]); })) return null;
  }
  const r = ruleTerritory0_(ctx, o0, t0);
  if (!r) return null;
  if (r === o0 || (o0 && stable_(r) === stable_(o0))) return old; // 変わらないときは版を進めない
  r.rev = oldRev + 1; r.revBy = ctx.me;
  return r;
}

function ruleTerritory0_(ctx, old, t) {
  if (ctx.admin) {
    const o = Object.assign({}, t, {
      helpers: t.holder ? cleanHelpers_(ctx, t, t.holder) : [],
      parts: t.holder ? cleanParts_(ctx, t) : []
    });
    // 今日の司会：係の画面の保存では、今の値を残す（担当者が変わったら消す）。係自身が監督・司会者で、今日の司会を引き受けるときだけ新しく作る
    delete o.lead; delete o.leadOff;
    const curL = old && old.holder === t.holder ? leadActive_(ctx, old) : null;
    if (old && old.holder === t.holder && old.leadOff) o.leadOff = old.leadOff;
    if (curL && t.lead && t.lead.uid === curL.uid) o.lead = curL;
    else if (curL) o.leadOff = nowIso_(); // 係が外した
    else if (old && old.holder === t.holder && t.lead && t.lead.uid === ctx.me && leadFresh_(t, old) && leadOk_(ctx, old)) o.lead = newLead_(ctx, old);
    AZA_FIELDS.forEach(function (k) { if (old && old[k] !== undefined) o[k] = old[k]; else delete o[k]; });
    if (Array.isArray(t.azaManual) && t.azaManual.length) {
      o.azaManual = t.azaManual.slice(0, 20).map(function (a) {
        return { k: str_(a && a.k, 40), n: str_(a && a.n, 40), r: Math.max(0, Math.min(1, Number(a && a.r) || 0)) };
      }).filter(function (a) { return a.k; });
      if (!o.azaManual.length) delete o.azaManual;
    } else delete o.azaManual;
    const cs = cleanCands_(t.cands);
    if (cs.length) o.cands = cs; else delete o.cands;
    if (t.azaRedo && (!old || t.azaRedo !== old.azaRedo)) { o.azaRedo = str_(t.azaRedo, 40); delete o.azaSig; }
    else if (old && old.azaRedo) o.azaRedo = old.azaRedo;
    else delete o.azaRedo;
    // recLess＝この巡回は紙や口頭で回り終えた（回り残しを出さない。H2）。
    // 巡回ごと：担当者が新しく決まったら消す（古い画面が前の値を送ってきても）
    if (o.recLess !== 1) delete o.recLess;
    if (t.holder && (!old || old.holder !== t.holder)) delete o.recLess;
    // 紙の区域カード（S-13 で渡した区域）を、係が留守宅カードにして返したとき（古い画面の係・監査P3・M2）：返却の記録の印を ruleReturn_ で外すため控える
    if (old && paperHand_(old) && !old.awayPoolAt && o.awayPoolAt) (ctx.phPool || (ctx.phPool = {}))[String(old.id)] = String(old.lentAt || '');
    // 係の端末の時計が先に進んでいるとき（10分より先の日時）：返した日・完了日・留守宅カードにした日は、サーバーの時刻にする（総合監査 M6・2026-10-31）。
    // 過去の日付（紙の記録の転記など）はそのまま。同じ送信の返却の記録の日時も、同じ値にそろえる（ruleReturn_ の ctx.admTime）
    ['completedAt', 'returnedAt', 'awayPoolAt', 'firstDoneAt'].forEach(function (k) {
      const v = o[k];
      if (!v || (old && String(old[k] || '') === String(v))) return;
      const ms = Date.parse(String(v));
      if (!isFinite(ms) || ms <= Date.now() + 10 * 60000) return;
      const fx = ctx.admTime || (ctx.admTime = {});
      if (!fx[String(v)]) fx[String(v)] = nowIso_();
      o[k] = fx[String(v)];
    });
    return o;
  }
  if (!old) return null;
  if (!same_(old, t, ['no', 'name', 'polygon', 'free', 'lend', 'special'])) return null;
  const me = ctx.me;
  if (!old.holder && t.holder === me) {
    const lm = lendMode_(old);
    if (lm === 'stop' || old.paperLentAt) return null; // 貸出中止・紙の記録で貸出中は、自分では受け取れない
    if (lm !== 'open' && !autoFree_(ctx.settings, old)) return null;
    const u = ctx.user;
    const asGroup = !!(t.group && canGroupTerr_(u) && u.group === t.group);
    const held = heldCount_(ctx, asGroup);
    if (held + pendingCount_(ctx, asGroup, old.id) >= holdMax_(ctx.settings, asGroup)) return null;
    if (!asGroup && held >= ctx.settings.selfTakeMax) return null;
    const lent = clampTime_(t.lentAt);
    // 回りはじめた日：続きから受け取れる区域だけ、前の人の日を引き継ぐ（勝手に昔の日にはできない）
    const rf = contOk_(ctx.settings, old) && String(t.roundFrom || '') === String(old.lastRoundFrom) ? String(old.lastRoundFrom) : lent;
    const taken = Object.assign({}, old, {
      holder: me, lentAt: lent, roundFrom: rf,
      selfTakenAt: clampTime_(t.selfTakenAt), selfSeen: false, helpers: [], parts: [], firstDoneAt: null, firstDonePct: null, awayPoolAt: null, poolRetId: null,
      group: asGroup ? u.group : null,
    });
    // 集まりで使う区域の使い道：use='all' は全体の集まり（金曜の晩・日曜の昼など）。なければグループ奉仕
    if (asGroup && t.use === 'all') taken.use = 'all'; else delete taken.use;
    delete taken.lead; delete taken.leadOff; // 今日の司会は、持っている人ごと
    delete taken.lastRoundFrom; delete taken.firstLow; delete taken.paperHand; // firstLow＝係が目安未満で1回目を終えた印。次の巡回には持ち越さない
    delete taken.recLess; // 前の巡回の印（H2）
    return taken;
  }
  if (old.holder === me && !t.holder) {
    const o = Object.assign({}, old, { holder: null, lentAt: null, returnedAt: clampTime_(t.returnedAt), helpers: [], parts: [], group: null,
      lastLentAt: old.lentAt || null, lastFirstAt: old.firstDoneAt || null, firstDoneAt: null, firstDonePct: null });
    delete o.use; // 使い道（全体の集まり）は、持っている間だけ
    delete o.lead; delete o.leadOff; // 今日の司会も、返却で終わる
    // 1回目のあと、会えなかった家を「留守宅カード」にして返したとき
    let poolPct; // 留守宅カードにして返すときに数えた1回目の割合（下の rpct でも使う）
    let toPool = !!(t.awayPoolAt && !old.awayPoolAt);
    if (toPool) {
      // 1回目が目安（donePct−10）に届いていない区域は、本人は留守宅カードにして返せない（画面の返却ボタンも、届いたときだけ留守宅カードにする）。
      // 確かめないと、1回目をほとんど回らずに留守宅カードにし、そのまま訪ね直さずに完了にできた（総合監査 H9c・2026-10-31）。紙の区域カードは画面が止める
      // 係が「1回目を終えたことにする」で、目安未満のまま受け付けた区域（firstLow）は、今までどおり確かめない（M1 の流れ）
      if (!paperHand_(old) && !old.firstLow) {
        poolPct = terrDonePct_(ctx, old, old.roundFrom || old.lentAt);
        // 届いていなければ、断らずに「途中の返却」として受け付ける（返却ボタンの決まり：目安以下は途中返却）。
        // 断ると、画面の「返す」が留守宅カードしか出さない場面（1回目を終えたあとに家が足された・画面とサーバーの数え方のちがい）で、
        // 本人が区域を返せなくなっていた（独立監査 A-1・2026-11-04）。返却の記録の pool の印も外す（ruleReturn_ の ctx.notPool）
        if (poolPct !== null && poolPct < Math.max(0, (Number(ctx.settings.donePct) || 90) - 10)) { toPool = false; (ctx.notPool || (ctx.notPool = {}))[String(old.id)] = true; }
      }
    }
    if (toPool) {
      // 日時は返した日時（サーバーで直した値）にそろえる。端末の時計が大きくずれていると、ここだけ端末の時刻になっていた（総合監査 M6）
      o.awayPoolAt = near_(t.awayPoolAt, t.returnedAt, 10 * 60000) ? o.returnedAt : clampTime_(t.awayPoolAt); o.poolRetId = str_(t.poolRetId, 40);
      if (!old.firstDoneAt) o.lastFirstAt = !t.lastFirstAt || near_(t.lastFirstAt, t.returnedAt, 10 * 60000) ? o.returnedAt : clampTime_(t.lastFirstAt);
    }
    let done = !!(t.completedAt && t.completedAt !== old.completedAt);
    delete o.paperHand;
    if (done && paperHand_(old)) {
      // 紙の区域カード（S-13）から引き継いだ区域：紙で回った家はアプリの記録にないので、割合では確かめない（本人の「回り終えた」を正とする）
      o.completedAt = String(t.completedAt) === String(t.returnedAt) ? o.returnedAt : clampTime_(t.completedAt); // 端末の時計がずれていればサーバーの時刻。画面は返した日時と同じ値を送るので、そろえる（A-5・M6・監査 M-1）
      o.completedPct = null;
      o.recLess = 1; // 紙で回った家はアプリにないので、おすすめに回り残しを出さない（H2。古い画面から返しても付く）
    } else if (done) {
      // 「回り終えた」は、サーバーで数えた実際の割合で確かめる（監査D5：1軒も回らずに完了にできた）。
      // 画面の数え方と少しちがっても止めないよう、決めた割合から10ポイントまでは受け付ける
      const claimed = Math.max(0, Math.min(100, Number(t.completedPct) || 0));
      const actual = terrDonePct_(ctx, old, old.roundFrom || old.lentAt);
      const need = Math.max(0, (Number(ctx.settings.donePct) || 90) - 10);
      if (actual !== null && actual < need) { done = false; (ctx.notDone || (ctx.notDone = {}))[String(old.id)] = actual; } // 途中の返却として扱う（S-13 に完了を残さない）
      else {
        o.completedAt = String(t.completedAt) === String(t.returnedAt) ? o.returnedAt : clampTime_(t.completedAt); // 端末の時計がずれていればサーバーの時刻。画面は返した日時と同じ値を送るので、そろえる（A-5・M6・監査 M-1）
        o.completedPct = actual === null ? claimed : Math.min(claimed, actual);
      }
    }
    // 続きの引き継ぎ：途中で返したときだけ、回りはじめた日を残す（回り終えた・留守宅カードにしたときは消す）
    delete o.roundFrom; delete o.lastRoundFrom; delete o.firstLow;
    if (!o.awayPoolAt && !done) o.lastRoundFrom = old.roundFrom || old.lentAt || null;
    if (!o.lastRoundFrom) delete o.lastRoundFrom;
    // この送信で本人が返した区域（返却の記録を確かめるときに使う・監査①S3）
    // rf＝回りはじめた日：「続きから」受け取っていた（前の人が回りはじめた日から回った）ときだけ。返却の記録の from になり、
    // 係の端末の自動の確かめ（記録の少ない返却）が、上の terrDonePct_ と同じ起点から数えられるようにする（第3回監査 K-1・2026-10-29）
    const rf = old.roundFrom && old.lentAt && String(old.roundFrom) < String(old.lentAt) ? String(old.roundFrom) : null;
    // 返却の記録の印と割合は、区域の状態とサーバーで数えた値から決める（L17・2026-10-29）。
    // 割合：回り終えた＝上で確かめた値／途中にもどした＝数えた値（notDone）／途中で返した＝ここで数える。紙の区域カードは数えない
    let rpct = null;
    if (!paperHand_(old)) {
      if (done) rpct = o.completedPct == null ? null : Number(o.completedPct);
      else if (ctx.notDone && String(old.id) in ctx.notDone) rpct = ctx.notDone[String(old.id)];
      else rpct = poolPct !== undefined ? poolPct : terrDonePct_(ctx, old, old.roundFrom || old.lentAt);
    }
    (ctx.retNow || (ctx.retNow = {}))[String(old.id)] = { lentAt: old.lentAt || null, at: o.returnedAt, done: done, ph: !!(done && paperHand_(old)), rf: rf,
      g: !!old.group, ga: !!old.group && old.use === 'all', pct: rpct };
    return o;
  }
  if (old.holder === me && t.holder === me) {
    const a = Object.assign({}, old), b = Object.assign({}, t);
    ['helpers', 'parts', 'lead', 'leadOff', 'azaManual', 'azaRedo', 'firstDoneAt', 'firstDonePct', 'firstLow', 'paperDone', 'paperLentAt', 'recLess'].concat(AZA_FIELDS).forEach(function (k) { delete a[k]; delete b[k]; });
    if (stable_(a) === stable_(b)) {
      const o2 = Object.assign({}, old, { helpers: cleanHelpers_(ctx, t, me), parts: cleanParts_(ctx, t) });
      // 今日の司会：担当者は「司会を外す」（lead: null）だけができる。送ってこない古い端末では今の値を残す
      const curL = leadActive_(ctx, old);
      if (curL && t.lead !== null) o2.lead = curL;
      else { delete o2.lead; if (curL) o2.leadOff = nowIso_(); } // 担当者が外した
      // 1回目を回り終えた（留守宅を回る段階になる）。1回だけ
      if (!old.firstDoneAt && t.firstDoneAt) {
        o2.firstDoneAt = clampTime_(t.firstDoneAt); // 端末の時計が大きくずれていればサーバーの時刻（総合監査 M6）
        o2.firstDonePct = Math.max(0, Math.min(100, Number(t.firstDonePct) || 0));
      }
      return o2;
    }
    // 受け取りの送り直し（監査D2）：前の送信で受け取りはすんでいるのに、返事が届かず同じ受け取りを送ってきたとき。
    // 受け取りで決まる項目だけがちがうなら、今の内容のまま受け付ける（「受け付けられませんでした」を出さない）
    const TAKE_KEYS = ['lentAt', 'roundFrom', 'selfTakenAt', 'selfSeen', 'group', 'use', 'lastRoundFrom', 'awayPoolAt', 'poolRetId'];
    TAKE_KEYS.forEach(function (k) { delete a[k]; delete b[k]; });
    const lentSent = Date.parse(String(t.lentAt || '')), lentNow = Date.parse(String(old.lentAt || ''));
    if (stable_(a) === stable_(b) && isFinite(lentSent) && isFinite(lentNow) && Math.abs(lentSent - lentNow) < DAY_MS) return old;
  }
  // 今日の司会（担当者ではない監督・司会者）。送ってきた区域のほかの項目は使わない（受け付けるのは lead・今日回る人・範囲だけ）
  if (old.holder && old.holder !== me && t.holder === old.holder && leadOk_(ctx, old)) {
    const curL = leadActive_(ctx, old);
    const mine = !!curL && curL.uid === me;
    const wants = !!(t.lead && typeof t.lead === 'object' && t.lead.uid === me);
    if (!mine && wants) {
      // 引き受ける：ほかの人が今日の司会のときは受け付けない（1枚につき1人）
      if (curL || !leadFresh_(t, old)) return null;
      return Object.assign({}, old, { lead: newLead_(ctx, old) });
    }
    if (mine) {
      const o3 = Object.assign({}, old);
      if (!wants) { delete o3.lead; return o3; } // 司会をやめる（今日回る人・範囲は、そのまま残す）
      o3.helpers = cleanHelpers_(ctx, t, old.holder);
      o3.parts = cleanParts_(ctx, t);
      return o3;
    }
  }
  // 留守宅カードで回っていた区域：自分の留守宅カードを返却して、決めた割合に届いたとき（今日が正式な返却日）
  if (!old.holder && !t.holder && old.awayPoolAt && !t.awayPoolAt && t.completedAt && t.completedAt !== old.completedAt) {
    let mine = false;
    ctx.col('awayCards').forEach(function (x) { if (x.data.by === me && x.data.terrId === old.id) mine = true; });
    if (!mine) return null;
    // 「回り終えた」はサーバーで数えた割合でも確かめる（A-3・H9c・2026-10-29。本人の返却と同じ守り方）。
    // 数える起点は、この巡回の始まり（留守宅カードにして返した記録の from（続きから）→ なければ最後に受け取った日）。
    // 留守宅カードの割合（訪ね直した家の割合）とは数え方がちがうので、決めた割合（awayRetPct）から 10ポイントまでは受け付ける。
    // 確かめるのは、1回目をアプリの記録で回り終えていた区域だけ（返した記録の1回目の割合（p1・pct）が donePct−10 以上）。
    // 紙で回った（ph）・記録の少ない1回目を係が受け付けた（low・lowOk・割合が低い）区域は、記録がそろっていないので今までどおり確かめない（M1 の流れ）。
    // 届いていなければ受け付けない（区域は留守宅カードのまま。カードを返すことは受け付ける）。回り終えた日はサーバーの時刻
    const pr = old.poolRetId ? ctx.col('returns').get(String(old.poolRetId)) : null;
    const pd = pr && pr.data ? pr.data : null;
    const since = (pd && pd.from) || old.lastLentAt || old.awayPoolAt;
    const claimed = Math.max(0, (Math.min(100, Number(t.completedPct) || 0)));
    // 1回目の割合は、サーバーで数えた値（sp。本人が留守宅カードにして返した送信で付く）を先に使う。
    // 画面の値（pct）だけで決めると、小さい値を送れば確かめを外せた（総合監査 H9c・2026-10-31）。p1 は係の印（lowMark）のときだけ
    const sp1 = pd && pd.sp != null && pd.sp !== '' ? Number(pd.sp) : NaN;
    const p1 = pd ? (pd.p1 != null ? Number(pd.p1) : isFinite(sp1) ? sp1 : Number(pd.pct)) : NaN;
    const need1 = Math.max(0, (Number(ctx.settings.donePct) || 90) - 10);
    const verify = !!pd && !pd.ph && !pd.low && !pd.lowOk && isFinite(p1) && p1 >= need1;
    const actual = verify ? terrDonePct_(ctx, old, since) : null;
    const need = Math.max(0, (ctx.settings.awayRetPct == null ? 70 : Number(ctx.settings.awayRetPct)) - 10);
    if (actual !== null && actual < need) return null;
    // 訪ね直した家の割合も確かめる（総合監査 H9c）。上の割合は「巡回で記録のある家」なので、1回目の記録だけでも届いてしまう。
    // 起点は画面の poolInfo と同じ（受け取った日〜1回目を終えた日）。画面が完了と数えるなら必ず届く数え方なので、正しい完了は断らない。
    // 確かめるかどうかは、返却の記録の値ではなく、サーバーで数えた1回目の割合（r1）で決める（記録がない・値を小さく送った、でも外れない）。
    // 1回目が目安（donePct−10）に届いていない区域は、画面が「1回目に訪ねていない家」も数えるので、ここでは確かめない（今までどおり）
    const flagged = !!pd && !!(pd.ph || pd.low || pd.lowOk);
    const rv = flagged ? null : poolRevisitPct_(ctx, old, old.lastLentAt || since, old.lastFirstAt || old.awayPoolAt);
    const rvOn = !!(rv && rv.n && rv.r1 >= need1);
    if (rvOn && rv.pct < need) return null;
    const at = nowIso_();
    let pct = actual === null ? claimed : Math.min(claimed, actual);
    if (rvOn) pct = Math.min(pct, rv.pct);
    (ctx.poolDone || (ctx.poolDone = [])).push({ rid: old.poolRetId, at: at, pct: pct });
    const fin = Object.assign({}, old, { completedAt: at, completedPct: pct, awayPoolAt: null, poolRetId: null });
    delete fin.roundFrom; delete fin.lastRoundFrom;
    return fin;
  }
  if (old.holder === t.holder && stable_(old) === stable_(t)) return old;
  // 返却の送り直し（監査②V2・V9）：前の送信で返却（留守宅カードにして返す・留守宅カードの完了もふくむ）はすんでいるのに、
  // 返事が届かず同じ内容を送ってきたとき。返した時の受け取りの日と、返した時刻が同じなら、今の内容のまま受け付ける
  // （区域は何も変えない。「受け付けられませんでした」を出さず、ほかの端末にも今の内容がもう一度届く）
  if (!old.holder && !t.holder && old.lastLentAt && String(t.lastLentAt || '') === String(old.lastLentAt) && near_(t.returnedAt, old.returnedAt, 10 * 60000)) return old;
  return null;
}

// 区域ごとの「アパートの候補」（エクセルの建物。現場で選ぶと家になり、その家に cid がつく）。係だけが書ける
function cleanCands_(arr) {
  const out = [], seen = {};
  (Array.isArray(arr) ? arr : []).slice(0, 600).forEach(function (c) {
    if (!c || typeof c !== 'object') return;
    const id = str_(c.i, 40).replace(/[^\w.\-]/g, '');
    const la = Number(c.la), ln = Number(c.ln);
    if (!id || seen[id] || !isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return;
    seen[id] = 1;
    const o = { i: id, n: str_(c.n, 40), la: Math.round(la * 1e6) / 1e6, ln: Math.round(ln * 1e6) / 1e6 };
    const f = Math.floor(Number(c.f));
    if (f >= 1 && f <= 60) o.f = f;
    if (c.g === 0 || c.g === false) o.g = 0; // 1階に部屋がない
    if (c.k) o.k = 1;
    if (c.b === 'no' || c.b === 'letter') o.b = c.b;
    if (c.m) { const m = bldNote_(c.m); if (m) o.m = m; } // 一覧の備考（建物のメモになる）
    if (c.ac === 'ev' || c.ac === 'st' || c.ac === 'no') o.ac = c.ac; // エレベーターあり／縦階段／エレベーターなし
    if (c.p) o.p = 1;                                     // 場所はだいたい（番地まで分からなかった）
    if (c.a === 1 || c.a === 2) o.a = c.a;                // 取り込みで家の印に自動で入れた・まだ確かめていない
    out.push(o);
  });
  return out;
}

// 選んだ候補（cid）を区域の候補から探す。見つからなければ null
function candInfo_(ctx, cid) {
  if (!cid) return null;
  if (!ctx.candMap) {
    ctx.candMap = {};
    ctx.col('territories').forEach(function (x) { (x.data && Array.isArray(x.data.cands) ? x.data.cands : []).forEach(function (c) { if (c && c.i) ctx.candMap[c.i] = c; }); });
  }
  return ctx.candMap[cid] || null;
}
// 係以外の人が候補を選んだとき：候補にある立入禁止の印を、候補の内容のとおりにつける（係以外は自由に変えられない）
function candFix_(ctx, res) {
  if (!res.cid) return;
  const c = candInfo_(ctx, res.cid);
  if (!c) { delete res.cid; return; }
  if (res.type === 'apt' && (c.b === 'no' || c.b === 'letter')) res.ban = c.b;
}

const HOUSE_KINDS = ['office', 'shop', 'biz', 'factory', 'school', 'gov', 'police', 'fire', 'hall', 'hospital', 'conv', 'food', 'care', 'other']; // other：その他（2026-10-22）
function houseExtra_(h, units, o) {
  const kind = HOUSE_KINDS.indexOf(String(h.kind || '')) >= 0 ? String(h.kind) : null;
  if (kind) o.kind = kind;
  if (h.type === 'apt' && h.lock) o.lock = true;
  if (h.type === 'apt' && (h.ban === 'no' || h.ban === 'letter')) o.ban = h.ban; // 立入禁止／手紙のみ（係だけが変えられる。ruleHouse_ で確かめる）
  if (h.cid) { const cid = str_(h.cid, 40).replace(/[^\w.\-]/g, ''); if (cid) o.cid = cid; } // 選んだ候補の番号（使った候補は、次から候補に出ない）
  if (h.imp) o.imp = true; // アパートの取り込みで新しく置いた家（やり直しのとき、家ごと消すための目印。係だけがつけられる）
  if (h.prov) o.prov = true;
  // 建物のメモ（備考）と、階段・エレベーター（2026-10-19）。くわしい表示の人ならだれでも書きかえられる
  if (h.type === 'apt') {
    const bn = bldNote_(h.bn); if (bn) o.bn = bn;
    if (h.ac === 'ev' || h.ac === 'st' || h.ac === 'no') o.ac = h.ac; // なし（空）は「まだ確かめていない」
  }
  const uk = {};
  if (h.uk && typeof h.uk === 'object') {
    Object.keys(h.uk).slice(0, 300).forEach(function (u) {
      const v = String(h.uk[u] || '');
      if (HOUSE_KINDS.indexOf(v) >= 0 && units.indexOf(String(u)) >= 0) uk[str_(u, 12)] = v;
    });
  }
  if (Object.keys(uk).length) o.uk = uk;
  const ul = {};
  if (h.ul && typeof h.ul === 'object') {
    Object.keys(h.ul).slice(0, 300).forEach(function (u) {
      const v = str_(h.ul[u], 20).replace(/[|\s]/g, '');
      if (v && v !== String(u) && units.indexOf(String(u)) >= 0) ul[str_(u, 12)] = v;
    });
  }
  if (Object.keys(ul).length) o.ul = ul;
  // 二世帯住宅：分かれ方（上下 ud・左右 lr・前後 fb）。世帯（部屋）の名前は決まった組み合わせだけ（名前を自由に入れさせない）
  if (h.type === 'apt' && MU_UNITS[String(h.mu || '')] && MU_UNITS[String(h.mu)].some(function (a) { return a.join('|') === units.join('|'); })) o.mu = String(h.mu);
  return o;
}
/* 係以外が家の場所を直すとき（2026-11-04）：動かしてよいかを確かめ、よければ新しい { lat, lng, terrId } を返す
   ・新しい場所は数で、今の場所から HOUSE_MOVE_MAX_M まで（まちがえて遠くに動かさないように。画面の MOVE_MAX_M と同じ数）
   ・区域は、今のままか、動かした先がその線の中にあるふつうの区域だけ（画面は、動かした先の区域の線の中ならその区域、線の外なら今の区域のままにする）
   ・今の場所がない家は、係以外は動かせない */
const HOUSE_MOVE_MAX_M = 500;
const tidOf_ = v => (v == null || v === '' ? null : String(v));
function samePos_(a, b) {
  const la = Number(a.lat), ga = Number(a.lng), lb = Number(b.lat), gb = Number(b.lng);
  if (!isFinite(la) || !isFinite(ga) || !isFinite(lb) || !isFinite(gb)) return a.lat == b.lat && a.lng == b.lng; // eslint-disable-line eqeqeq
  return Math.abs(la - lb) < 5e-7 && Math.abs(ga - gb) < 5e-7;
}
function houseLb_(h) {
  const a = h && h.lb;
  if (!Array.isArray(a) || a.length < 2) return null;
  return { lat: a[0], lng: a[1], terrId: tidOf_(a[2]) };
}
function houseMoveOk_(ctx, old, h) {
  const ol = Number(old.lat), og = Number(old.lng);
  if (old.lat == null || old.lng == null || !isFinite(ol) || !isFinite(og)) return null;
  if (typeof h.lat !== 'number' || typeof h.lng !== 'number' || !isFinite(h.lat) || !isFinite(h.lng) || Math.abs(h.lat) > 90 || Math.abs(h.lng) > 180) return null;
  const rad = Math.PI / 180, dLat = (h.lat - ol) * rad, dLng = (h.lng - og) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(ol * rad) * Math.cos(h.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  if (2 * 6371008 * Math.asin(Math.min(1, Math.sqrt(a))) > HOUSE_MOVE_MAX_M) return null;
  let tid = old.terrId == null || old.terrId === '' ? null : old.terrId;
  const nt = tidOf_(h.terrId);
  if (nt !== tidOf_(tid)) {
    // 区域を変えるのは、動かした先がその区域の線の中のときだけ（ふつうの区域。特別区域は家の区域にしない）。
    // 区域なしにするのは、動かした先がどの区域の線の中でもないときだけ（取り消しで、もとの「区域なし」にもどすとき）
    const ts = reassignTerrBoxes_(ctx.col('territories'));
    if (nt) { const t = ts.filter(function (x) { return String(x.id) === nt; }); if (!t.length || reassignFind_(t, h.lat, h.lng) == null) return null; }
    else if (reassignFind_(ts, h.lat, h.lng) != null) return null;
    tid = nt ? str_(nt, 40) : null;
  }
  return { lat: Math.round(h.lat * 1e6) / 1e6, lng: Math.round(h.lng * 1e6) / 1e6, terrId: tid };
}
function bldNote_(v) { return String(v == null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 200); }
const MU_UNITS = { ud: [['2階', '1階'], ['3階', '2階', '1階']], lr: [['左', '右']], fb: [['奥', '表']] };
function ruleHouse_(ctx, old, h) {
  const units = Array.isArray(h.units) ? h.units.slice(0, 300).map(function (u) { return str_(u, 12); }) : [];
  if (!ctx.admin) {
    // 係以外が新しく付ける部屋の名前に、画面で問題になる文字を使わない（監査①S2。今ある部屋はそのまま）
    const had = {};
    (old && Array.isArray(old.units) ? old.units : []).forEach(function (u) { had[String(u)] = true; });
    if (units.some(function (u) { return !had[u] && UNIT_BAD_RE.test(u); })) return null;
  }
  if (!old) {
    if (h.type !== 'house' && h.type !== 'apt') return null;
    if (!isFinite(Number(h.lat)) || !isFinite(Number(h.lng))) return null;
    if (!ctx.admin && h.terrId && !ctx.col('territories').get(String(h.terrId))) return null; // ない区域の家は作らない（監査①S2）
    const created = houseExtra_(h, units, {
      id: str_(h.id, 40), terrId: h.terrId ? str_(h.terrId, 40) : null, type: h.type,
      lat: Number(h.lat), lng: Number(h.lng), label: str_(h.label, 40), units: units,
      createdAt: str_(h.createdAt, 40) || nowIso_(), createdBy: ctx.me,
    });
    if (!ctx.admin) { // 立入禁止の印・取り込みの目印・仮の家の印（H8・D4）は、区域係だけがつけられる（候補を選んだときは、候補のとおり）
      delete created.ban; delete created.imp; delete created.prov; candFix_(ctx, created);
      if (h.prov) provUndoCreate_(ctx, created); // 本人が消した仮の家の「取り消す」だけは、仮の家にもどす（点検M-2）
    }
    return created;
  }
  // 家の場所と区域（2026-11-04・家の場所を直す）
  //  lb：この端末が送る前に知っていた [緯度, 経度, 区域id]（新しい画面だけが送る）。
  //  端末が変えていない場所・区域は、サーバーの今のままにする（古い送信で、ほかの人が動かした家がもどらないように）
  const lb = houseLb_(h);
  const posMine = lb ? !samePos_(h, lb) : !samePos_(old, h); // この端末が場所を変えたか
  const terrMine = lb ? tidOf_(h.terrId) !== lb.terrId : tidOf_(h.terrId) !== tidOf_(old.terrId);
  let keep = lb ? { lat: posMine ? h.lat : old.lat, lng: posMine ? h.lng : old.lng, terrId: terrMine ? h.terrId : old.terrId } : null;
  if (!ctx.admin) {
    const posSame = samePos_(old, h), terrSame = tidOf_(h.terrId) === tidOf_(old.terrId);
    keep = { lat: old.lat, lng: old.lng, terrId: old.terrId }; // ふだんは、場所と区域はサーバーの今のまま
    if (posSame && terrSame) { /* 変わっていない（送り直しで、もう入っているときも） */ }
    else if (lb && posMine) {
      // 家の場所を直す（家の編集ができる人ならだれでも）
      if (posSame) { /* 同じ場所に、もう動いている（送り直し） */ }
      else if (!samePos_(old, lb)) return null; // ほかの人が先に動かした家（あとから動かした人の場所を消さない）
      else { keep = houseMoveOk_(ctx, old, h); if (!keep) return null; }
    } else if (!terrSame && (lb ? terrMine : posSame)) return null; // 場所を変えずに区域だけ変えるのは、区域係だけ
    // ほかは、この端末が知らないうちに変わった場所・区域（古い送信・古い画面）：サーバーの今のまま
    if (old.type !== h.type && !(old.type === 'house' && h.type === 'apt')) return null;
  }
  const base = ctx.admin ? Object.assign({}, h, keep || {}) : Object.assign({}, old, { type: h.type }, keep);
  delete base.lb;
  const mu = mergeUnits_(ctx, old, h, units); // ほかの人が同時に足した・消した部屋を、消さない・戻さない（監査②V4・V5）
  base.label = str_(h.label, 40);
  base.units = mu;
  delete base.kind; delete base.lock; delete base.uk; delete base.prov; delete base.ul; delete base.ban; delete base.imp; delete base.cid; delete base.mu; delete base.bn; delete base.ac; delete base.ub;
  const res = houseExtra_(h, mu, base);
  // この送信の一覧にない部屋（ほかの人が足した・記録があるので残した部屋）の種別と表示名は、今の内容を引き継ぐ
  mu.forEach(function (u) {
    if (units.indexOf(u) >= 0) return;
    if (old.uk && old.uk[u]) (res.uk || (res.uk = {}))[u] = old.uk[u];
    if (old.ul && old.ul[u]) (res.ul || (res.ul = {}))[u] = old.ul[u];
  });
  if (!ctx.admin) { // 係以外は、今ある印をそのまま残す
    if (old.ban && old.type === 'apt' && res.type === 'apt') res.ban = old.ban; else delete res.ban;
    if (old.imp) res.imp = true; else delete res.imp;
    // 仮の家の印は、係以外は外すことだけできる（新しく付けられない。H8・D4）。
    // ただし、本人が外したすぐあと（15分）の「取り消す」では、もとの仮の家にもどす（記録の取り消しなど。点検M-2）
    const hid = String(old.id || ctx.curId || '');
    if (!old.prov && res.prov && provUndoGet_('provoff_' + hid) !== ctx.me) delete res.prov;
    if (old.prov && !res.prov) (ctx.provOff || (ctx.provOff = {}))[hid] = true;
    if (old.cid) res.cid = old.cid; else candFix_(ctx, res);
    if (!old.ban && res.cid && res.type === 'apt') candFix_(ctx, res);
  }
  if (ctx.mgrOnly && stable_(res) !== stable_(old)) mgrLog_(ctx, '家の編集', 1); // 変わったときだけ（送り直しは数えない）
  return res;
}

/* 部屋の一覧を当てはめる（監査②V4・V5・2026-10-24）
   ・画面が「もとの一覧」（ub：その人の端末が知っていた一覧）を送ってきたとき：その人が足した部屋・消した部屋だけを、
     今の一覧に当てはめる。ほかの人がほぼ同時に足した部屋は消さず、消した部屋は戻さない
     （ub を送らない古い端末は、今までどおり送られた一覧のとおり）
   ・係以外が、記録のある部屋を消そうとしたときは、その部屋を残す（画面では区域係だけの操作） */
function mergeUnits_(ctx, old, h, units) {
  const cur = Array.isArray(old.units) ? old.units.map(String) : [];
  let out = units.slice();
  if (Array.isArray(h.ub)) {
    const ub = {}, inCur = {}, inNew = {};
    h.ub.slice(0, 300).forEach(function (u) { ub[str_(u, 12)] = true; });
    cur.forEach(function (u) { inCur[u] = true; });
    units.forEach(function (u) { inNew[u] = true; });
    out = units.filter(function (u) { return inCur[u] || !ub[u]; });       // ほかの人が消した部屋は戻さない
    cur.forEach(function (u) { if (!ub[u] && !inNew[u]) out.push(u); });   // ほかの人が足した部屋は残す
  }
  if (!ctx.mgr) {
    const inOut = {};
    out.forEach(function (u) { inOut[u] = true; });
    const gone = cur.filter(function (u) { return !inOut[u]; });
    if (gone.length) {
      const rec = unitsWithVisits_(String(old.id));
      gone.forEach(function (u) { if (rec[u]) out.push(u); });
    }
  }
  if (ctx.mgrOnly) {
    // 家と拒否の管理の人が消す部屋：訪問しない印のある部屋は消さない（区域係だけが外せる印のため）。
    // 消す部屋は覚えておき、その部屋の住所つきの拒否を、あとで場所だけの印にして残す（区域係の画面と同じ。監査 H-1）
    const inOut = {};
    out.forEach(function (u) { inOut[u] = true; });
    cur.filter(function (u) { return !inOut[u]; }).forEach(function (u) {
      const k = String(old.id) + '|' + u;
      if (adminMarkKey_(ctx, k)) { out.push(u); return; }
      (ctx.mgrGone || (ctx.mgrGone = {}))[k] = { lat: old.lat, lng: old.lng, terrId: old.terrId };
    });
  }
  const seen = {};
  return out.filter(function (u) { if (seen[u]) return false; seen[u] = true; return true; }).slice(0, 300);
}
/* 家と拒否の管理の人が部屋を消したとき、その部屋の住所つきの拒否を、シートの値から場所だけの印にして残す（監査 H-1）。
   その人の画面には住所が届かないので、画面では作れない。区域係の画面が部屋を消すときに作る印と同じ形 */
function mgrUnitPins_(ctx, dch) {
  const m = ctx.col('dnc'), dkHas = {}, ups = [];
  m.forEach(function (x, id) { const d = x && x.data; if (d && typeof d === 'object' && d.p && d.dk) dkHas[String(d.dk)] = true; });
  dch.del.forEach(function (k) {
    k = String(k);
    const g = ctx.mgrGone[k], c = m.get(k), v = c && c.data;
    if (!g || !v || typeof v !== 'object' || isDncQ_(v) || !(v.a || v.s) || dkHas[k]) return;
    const o = Object.assign({}, v);
    const gl = Number(g.lat), gg = Number(g.lng), gOk = g.lat != null && g.lng != null && isFinite(gl) && isFinite(gg);
    if (gOk) { o.lat = Math.round(gl * 1e6) / 1e6; o.lng = Math.round(gg * 1e6) / 1e6; }
    if (o.lat == null || o.lng == null) { (ctx.mgrPinNo || (ctx.mgrPinNo = {}))[k] = true; return; } // 位置がなく印を作れない拒否は、消さない（再監査 L-B）
    delete o.auto;
    o.p = 1; o.dk = k;
    if (!o.at) o.at = nowIso_();
    if (!o.t && g.terrId) o.t = String(g.terrId);
    const unit = k.slice(k.indexOf('|') + 1);
    if (unit && !o.room) o.room = str_(unit, 20);
    ups.push(['pin:d' + hash_('dk|' + k).replace(/[^\w]/g, '').slice(0, 14), o]);
  });
  if (ctx.mgrPinNo) dch.del = dch.del.filter(function (k) { return !ctx.mgrPinNo[String(k)]; });
  if (!ups.length) return;
  try { writeCol_('dnc', m, ups, [], ctx.me); }
  catch (e) { // 印を書けなければ、その拒否は消さない（住所を失わない）
    console.warn('部屋の拒否を場所だけの印にできませんでした', e);
    const keep = {}; ups.forEach(function (p) { keep[p[1].dk] = true; });
    dch.del = dch.del.filter(function (k) { return !keep[String(k)]; });
  }
}
/* 区域係だけが外せる印（訪問しない q:1）がそのキーにあるか（家と拒否の管理の人の削除を止めるため・監査 M-2）。
   外国語の印は伝道者でも外せるので、ここでは止めない（再監査 M-A） */
function adminMarkKey_(ctx, k) {
  try { const d = ctx.col('dnc').get(k); return !!(d && isDncQ_(d.data)); } catch (e) { return true; }
}
function houseAdminMark_(ctx, hid) {
  const pre = String(hid) + '|';
  let hit = false, m;
  try { m = ctx.col('dnc'); } catch (e) { return true; }
  m.forEach(function (x, id) { if (!hit && String(id).indexOf(pre) === 0 && isDncQ_(x && x.data)) hit = true; });
  return hit;
}
/* その家の、記録のある部屋（{ 部屋: true }）。数えられないときは空 */
function unitsWithVisits_(hid) {
  const out = {};
  try {
    const sh = dataSheet_('visits'), n = sh.getLastRow();
    if (n < 2) return out;
    readFound_(sh, 2, sh.getRange(2, 2, n - 1, 1).createTextFinder('"houseId":"' + hid + '"').matchCase(true).findAll().slice(0, 3000)).forEach(function (val) {
      const v = parseJson_(val, null);
      if (v && String(v.houseId) === hid) out[String(v.unit || '')] = true;
    });
  } catch (e) { console.warn('部屋の記録を確かめられませんでした：' + e); }
  return out;
}

function ruleVisit_(ctx, old, v) {
  if (old) return ctx.admin ? v : (old.by === ctx.me ? old : null);
  if (v.by !== ctx.me) return null;
  if (['met', 'away', 'refused'].indexOf(v.result) < 0 || !v.houseId) return null;
  if (!ID_RE.test(String(v.houseId)) || UNIT_BAD_RE.test(String(v.unit || ''))) return null; // 家の id・部屋の名前の形（監査①S2）
  let sent = Date.parse(v.at);
  if (!isFinite(sent)) return null;
  const now = Date.now();
  let at = str_(v.at, 40);
  if (ctx.skew) { sent += ctx.skew; at = new Date(sent).toISOString(); } // 端末の時計のずれを直す（点検②V19）
  // 電波のない端末は30日で中の情報を消す（送れなかった記録の控えは、さらに7日）ので、それより古い記録は届かないはず。
  // 時計が大きく遅れた端末の記録は受け付けない
  if (!ctx.admin && sent < now - 40 * DAY_MS) return null;
  if (sent > now + 10 * 60000) {
    if (sent > now + 2 * DAY_MS) return null;
    at = new Date(now).toISOString();
  }
  const o = { id: str_(v.id, 40), houseId: str_(v.houseId, 40), unit: str_(v.unit, 12), result: v.result, at: at, by: ctx.me };
  if (v.age) o.age = str_(v.age, 20).replace(/[<>"'&]/g, '');
  if (v.result === 'met' && v.interest) o.interest = str_(v.interest, 20).replace(/[<>"'&]/g, '');
  if (v.src && (RECO_SRC_RE.test(String(v.src)) || CARD_SRC_RE.test(String(v.src)) || RECO_CARD_SRC_RE.test(String(v.src)))) o.src = String(v.src);
  const hd = houseData_(ctx, o.houseId);
  if (!hd && !ctx.admin) return null; // 消された家への記録は受け付けない（電波のない所でつけた記録が、あとで届いたとき・点検②V6）
  if (hd && hd.terrId) {
    o.t = str_(hd.terrId, 40);
    if (typeof outOfCard_ === 'function' && outOfCard_(ctx, o.t, o.houseId + '|' + o.unit)) o.oc = 1;
  }
  return o;
}

/* =========================================================
   まちがえた記録の直し方（2026-10-15）
   ・本人：自分の記録を、その日のうち（日本時間）。ただし、その区域が記録のあとに返されていたら区域係
   ・司会者・グループ監督：自分が持つグループの区域（グループの留守宅カード）の、その日の記録
   ・区域係：いつでも
   ・本人以外が取り消したときは、operations に「だれが・いつ・どの区域の何時の記録か」だけを残す
   ========================================================= */
function jstDay_(t) { return Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyyMMdd'); }
function sameJstDay_(iso) { const t = Date.parse(iso); return isFinite(t) && jstDay_(t) === jstDay_(Date.now()); }
function groupHoldsKey_(ctx, tid, key) {
  if (!canGroupTerr_(ctx.user)) return false;
  if (tid) {
    const t = ctx.col('territories').get(String(tid));
    if (t && t.data && t.data.holder === ctx.me && t.data.group) return true;
    if (t && t.data && isLeadOf_(ctx, t.data)) return true; // 今日の司会
  }
  if (!key) return false;
  let ok = false;
  ctx.col('awayCards').forEach(function (x) {
    const d = x.data;
    if (!ok && d && d.by === ctx.me && d.group && !d.endedAt && Array.isArray(d.keys) && d.keys.indexOf(key) >= 0) ok = true;
  });
  return ok;
}
function returnedSince_(ctx, tid, at) {
  if (!tid) return false;
  const a = Date.parse(at);
  let r = false;
  ctx.col('returns').forEach(function (x) {
    const d = x.data;
    if (!r && d && String(d.terrId) === String(tid) && Date.parse(d.at) > a) r = true;
  });
  return r;
}
function visitCanDelete_(ctx, c) {
  if (ctx.admin) { if (c.data && c.data.by !== ctx.me) fixLogAdd_(ctx, c.data); return true; }
  const v = c.data || {};
  if (!sameJstDay_(v.at)) return false;
  const tid = v.t || ((houseData_(ctx, v.houseId) || {}).terrId) || '';
  if (v.by === ctx.me) return !returnedSince_(ctx, tid, v.at);
  if (groupHoldsKey_(ctx, tid, String(v.houseId || '') + '|' + String(v.unit || ''))) { fixLogAdd_(ctx, v); return true; }
  return false;
}
function dncLeaderDel_(ctx, c, id) {
  if (!id || !c || Date.now() - new Date(c.at).getTime() >= DAY_MS) return false;
  const hd = houseData_(ctx, String(id).split('|')[0]);
  return groupHoldsKey_(ctx, hd && hd.terrId, String(id));
}
/* 家と拒否の管理の人（区域係以外）が行った削除・編集を、operations に「だれが・いつ・何を・件数」だけ残す（H6）。
   家の名前・住所・拒否の中身は残さない。1回の送信につき、種類ごとに1行 */
function mgrLog_(ctx, what, n) {
  const o = ctx.mgrOps || (ctx.mgrOps = {});
  o[what] = (o[what] || 0) + (Number(n) || 0);
}
function mgrLogWrite_(ctx) {
  if (!ctx.mgrOps) return;
  const ops = ctx.mgrOps; ctx.mgrOps = null;
  try {
    const kinds = Object.keys(ops).filter(function (k) { return ops[k] > 0; });
    if (!kinds.length) return;
    const sh = opsSheet_(), at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
    const rows = kinds.map(function (k) { return [at, String(ctx.user.name || '').slice(0, 30), k + '（家と拒否の管理）', '', ops[k] + '件']; });
    const first = Math.max(2, sh.getLastRow() + 1);
    if (first + rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 50);
    sh.getRange(first, 1, rows.length, 5).setValues(rows);
    if (sh.getLastRow() > OPS_KEEP + 100) opsTrim_();
  } catch (e) { console.warn('家と拒否の管理の記録を残せませんでした：' + e); }
}
function fixLogAdd_(ctx, v) {
  const t = v.t ? ctx.col('territories').get(String(v.t)) : null;
  const no = t && t.data ? String(t.data.no || '') : '';
  const when = isFinite(Date.parse(v.at)) ? Utilities.formatDate(new Date(v.at), 'Asia/Tokyo', 'M/d HH:mm') : '';
  (ctx.fixLog || (ctx.fixLog = [])).push((no ? '区域' + no + '・' : '') + when + '・' + ({ met: '会えた', away: '留守', refused: '拒否' }[v.result] || ''));
}
function fixLogWrite_(ctx) {
  try {
    const sh = opsSheet_(), rows = ctx.fixLog.slice(0, 50).map(function (d) {
      return [Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), String(ctx.user.name || '').slice(0, 30), '記録の取り消し（本人以外）', '', d.slice(0, 60)];
    });
    const first = Math.max(2, sh.getLastRow() + 1);
    if (first + rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 50);
    sh.getRange(first, 1, rows.length, 5).setValues(rows);
    if (sh.getLastRow() > OPS_KEEP + 100) opsTrim_();
  } catch (e) { console.warn('取り消しの記録を残せませんでした：' + e); }
  ctx.fixLog = [];
}

/* 留守宅カードを受け取った時点のルールの控え（係が設定を変えても、出ているカードは変わらない）。数字の範囲はサーバーで決める */
function cleanCardRl_(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const n = function (v, lo, hi, d) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
  return { cap: n(rl.cap, 1, 15, 3), gap: n(rl.gap, 0, 30, 3), nr: Number(rl.nr) ? 1 : 0, sc: Number(rl.sc) ? 1 : 0 };
}
/* グループの留守宅カードの「分ける／シェア」「地図の表示（まだの時間帯だけ／すべて）」「分けた範囲」。決まった形だけを残す */
function cleanCardGroup_(ctx, c, old) {
  const o = {};
  const mode = c.mode === 'split' || c.mode === 'share' ? c.mode : (old && old.mode) || null;
  const view = c.view === 'all' || c.view === 'new' ? c.view : (old && old.view) || null;
  if (mode) o.mode = mode;
  if (view) o.view = view;
  o.parts = c.endedAt ? [] : cleanParts_(ctx, { parts: c.parts });
  return o;
}

function ruleAwayCard_(ctx, old, c) {
  if (ctx.admin) {
    if (!c || !c.group) return c;
    return Object.assign({}, c, { helpers: c.endedAt ? [] : cleanHelpers_(ctx, { helpers: c.helpers, group: c.group }, c.by) }, cleanCardGroup_(ctx, c, null));
  }
  if (!c || c.by !== ctx.me) return null;
  const u = ctx.user;
  if (!old) {
    const asGroup = !!c.group;
    if (asGroup && !(canGroupTerr_(u) && normGroup_(c.group) === u.group)) return null;
    let active = 0;
    ctx.col('awayCards').forEach(function (x) {
      const d = x.data;
      if (d.by === ctx.me && !!d.group === asGroup && !d.endedAt && Date.parse(d.expiresAt) > Date.now()) {
        // 返却後のカードは、その区域が区域カードとして受け取られたら終わったものと同じ扱い（枚数に数えない）
        if (d.ext) { const tt = ctx.col('territories').get(d.terrId); if (tt && tt.data && tt.data.holder && Date.parse(tt.data.lentAt) > Date.parse(d.at)) return; }
        active++;
      }
    });
    if (active >= ctx.settings.awayMax) return null;
    // 中身はサーバーで決めた形だけを残す（時間帯は決まった10通り・期限は400日まで・家は区域の家の鍵だけ）。
    // 時間帯などの文字は画面にそのまま出るため、ここで形を決めておく
    const slot = String(c.slot || '');
    if (SLOT_NAMES.indexOf(slot) < 0) return null;
    const tid = str_(c.terrId, 40);
    const tx = tid ? ctx.col('territories').get(tid) : null;
    if (!tx || !tx.data) return null;
    const td = tx.data;
    // ほかの人が持っている区域の留守宅カードは作れない（A-4・H9d・2026-10-29。画面の awayEligibleBase と同じ：持っている本人か、空いている区域だけ）。
    // 返却後のカード（ext）は、受け取られたら終わったものとして扱う決まりがもうあるので、今までどおり
    if (td.holder && td.holder !== ctx.me && !c.ext) return null;
    // 返却後のカード（ext）は、完了した区域（担当者がいない・留守宅カードの段階でない・完了日がある）だけ。
    // ext を付けるだけで、ほかの人が持っている区域や続きから受け取れる区域のカードを作れていた（総合監査 H9d・2026-10-31。
    // 今の画面は ext のカードを作らない。画面の extState と同じ条件）
    if (c.ext && (td.holder || td.awayPoolAt || !td.completedAt || td.extStop)) return null;
    // 途中で返され、続きから受け取れる区域は、留守宅カードにしない（続きから受け取った人と同じ家を訪ねないように・M11・2026-10-30）
    if (!td.holder && contAvail_(ctx.settings, td)) return null;
    const exp = Date.parse(String(c.expiresAt || ''));
    if (!isFinite(exp) || exp <= Date.now()) return null;
    if (!Array.isArray(c.keys)) return null;
    const seenK = {}, keys0 = [];
    c.keys.slice(0, 1000).forEach(function (k) {
      const s = str_(k, 60);
      if (!/^[\w.\-]{1,40}\|[^<>"'&]{0,12}$/.test(s) || seenK[s]) return;
      seenK[s] = true; keys0.push(s);
    });
    if (!keys0.length) return null;
    // その区域の家の鍵だけ（A-4・H9d）：ない家・ほかの区域の家は外す（特別区域は、名指しの家か線の中の家。holdHouseIn_ と同じ）
    prefetchHouses_(ctx, keys0.map(function (k) { return k.split('|')[0]; }));
    // 特別区域のカードは、ほかの人が持っているふつうの区域の家を入れない（線のない特別区域は場所で分けないので、どの家でも通っていた・総合監査 H9d）
    // （特別区域で回る家（コンビニなど・spCover_）は、ふつうの区域カードに載らないので、今までどおり入れられる）
    const tcol = ctx.col('territories'), cov = td.special ? spCover_(ctx) : null;
    const heldByOther = function (hd, u) {
      if (!cov || !hd || !hd.terrId || cov(hd, u)) return false;
      const h0 = tcol.get(String(hd.terrId)), hdT = h0 && h0.data;
      return !!(hdT && hdT.holder && hdT.holder !== ctx.me);
    };
    const keys = keys0.filter(function (k) { const hid = k.split('|')[0], hd = houseData_(ctx, hid); return holdHouseIn_(td, tid, hid, hd) && !heldByOther(hd, k.slice(hid.length + 1)); });
    if (!keys.length) return null;
    // ほかの留守宅カード（終わっていない・期限内）に入っている家は、重ねない（監査②V3）。
    // 画面はほかのカードの家を外してから作るが、2人がほぼ同時に受け取ると、どちらの端末もまだ相手のカードを知らない。
    // 重なったら受け付けない（画面は元にもどり、最新の状態で作り直せる）。数え方は画面の activeCards と同じ
    const busy = {};
    ctx.col('awayCards').forEach(function (x) {
      const d = x.data;
      if (!d || d.endedAt || !(Date.parse(d.expiresAt) > Date.now()) || !Array.isArray(d.keys)) return;
      if (d.ext) { const tt = ctx.col('territories').get(d.terrId); if (tt && tt.data && tt.data.holder && Date.parse(tt.data.lentAt) > Date.parse(d.at)) return; }
      d.keys.forEach(function (k) { busy[k] = true; });
    });
    // おすすめで押さえている家も、重ねない（2026-10-26。古い画面が完了した区域のカードを作るときのため）
    const nowMs = Date.now();
    ctx.col('holds').forEach(function (x) { if (holdLive_(ctx, x.data, nowMs)) (x.data.keys || []).forEach(function (k) { busy[k] = true; }); });
    if (keys.some(function (k) { return busy[k]; })) return null;
    const cid = str_(c.id, 40);
    if (!/^[\w.\-]{1,40}$/.test(cid)) return null; // id は画面の属性にそのまま入るので、英数字などだけ
    // 期限の上限（A-4・H9d）：設定の日数（awayDays。返却後のカードは extDays）。「返却の目安まで使える」設定（awayExp）のときは、
    // 受け取り日＋lendDays（画面の awayExpiry と同じ）まで。端末の時計のずれの分として 1日の余裕。長すぎる期限は縮める
    const s = ctx.settings;
    let cap = nowMs + ((c.ext ? Number(s.extDays) || 60 : Number(s.awayDays) || 7)) * DAY_MS;
    if (Number(s.awayExp) === 1) {
      const base = td.holder ? td.lentAt : (td.awayPoolAt ? td.lastLentAt : null);
      const due = Date.parse(String(base || '')) + (Number(s.lendDays) || 120) * DAY_MS;
      if (isFinite(due) && due > cap) cap = due;
    }
    cap = Math.min(cap + DAY_MS, nowMs + 400 * DAY_MS);
    const o = { id: cid, terrId: tid, slot: slot, by: ctx.me, at: clampTime_(c.at),
      expiresAt: new Date(Math.min(exp, cap)).toISOString(), keys: keys };
    if (c.endedAt) o.endedAt = str_(c.endedAt, 40);
    const rl = cleanCardRl_(c.rl);
    if (rl) o.rl = rl;
    if (c.ext) o.ext = 1; // 返却後の留守宅カード
    if (c.day) o.day = 1; // その日限りのカード
    if (asGroup) { o.group = u.group; o.helpers = cleanHelpers_(ctx, { helpers: c.helpers, group: u.group }, ctx.me); Object.assign(o, cleanCardGroup_(ctx, c, null)); }
    if (asGroup && c.use === 'all') o.use = 'all'; // 全体の集まりで回る留守宅カード（2026-10-24）。枚数はグループで回るカードと合わせて数える。古い端末からは来ないので、今までどおりグループ
    return o;
  }
  if (old.by !== ctx.me) return null;
  if (!same_(old, c, ['terrId', 'slot', 'by', 'at', 'expiresAt', 'keys', 'rl', 'ext', 'day'])) return null;
  // 返した日時：送り直し（同じ値）はそのまま。新しく返したときは、端末の時計が大きくずれていればサーバーの時刻（総合監査 M6）
  // 一度返したカードの日時は、送り直しで動かさない（端末が先の日時を持ったまま送り直すと、そのたびに「今」に変わっていた・独立監査 B-2・2026-11-04）
  const o = Object.assign({}, old, { endedAt: !c.endedAt ? null : old.endedAt ? old.endedAt : clampTime_(c.endedAt) });
  if (old.group) {
    o.helpers = o.endedAt ? [] : cleanHelpers_(ctx, { helpers: c.helpers, group: old.group }, ctx.me);
    Object.assign(o, cleanCardGroup_(ctx, Object.assign({}, c, { endedAt: o.endedAt }), old));
  }
  return o;
}

/* =========================================================
   おすすめの押さえ（holds・2026-10-26）
   完了した区域（S-13 に完了として記録したあと、次に区域カードとして受け取られるまで）に残った留守宅を、
   おすすめタブから「今行く」（今日の終わりまで）・「予定に入れる」（予定の日の終わりまで）で押さえる。
   押さえた家は、ほかの人のおすすめに出ない。使っても使わなくても期限で外れる。
     { id, by, at, until, kind: 'now'|'plan', terrId, comp（押さえたときの区域の完了日）, keys: [家id|部屋…], date（予定の日）, slot（予定の時間帯）, endedAt }
   ・その区域が区域カードとして受け取られた（担当者がいる・完了日が変わった・留守宅カードで回っている）ら、押さえは効かない
   ・ほかの人には、家と期限だけを見せる（mask_）
   ========================================================= */
function holdMask_(v) {
  return { id: v.id, by: 'x', at: v.at, until: v.until, terrId: v.terrId, comp: v.comp, keys: v.keys, endedAt: v.endedAt || null };
}
/** 押さえが今も効いているか（期限内・終えていない・区域がまだ完了したまま） */
/** 本人が、おすすめで今押さえている家か（今行く・予定に入れる） */
function heldHouse_(ctx, hid, hd) {
  const now = Date.now(), pre = String(hid) + '|';
  let hit = false;
  ctx.col('holds').forEach(function (x) {
    const d = x.data;
    if (hit || !d || d.by !== ctx.me || !holdLive_(ctx, d, now)) return;
    if (!(d.keys || []).some(function (k) { return String(k).indexOf(pre) === 0; })) return;
    const t = ctx.col('territories').get(String(d.terrId || ''));
    if (holdHouseIn_(t && t.data, d.terrId, hid, hd)) hit = true; // その区域の家だけ（ほかの区域の仮の家は消せない）
  });
  return hit;
}
/* 押さえに入れてよい家か：その区域の家（特別区域は、名指しの家か、線の中の家）。hd は家のデータ */
function holdHouseIn_(td, tid, hid, hd) {
  if (!td || !hd) return false;
  const sp = td.special;
  if (!sp || typeof sp !== 'object') return String(hd.terrId || '') === String(tid);
  if (Array.isArray(sp.ids) && sp.ids.length) return sp.ids.map(String).indexOf(String(hid)) >= 0;
  const poly = (Array.isArray(td.polygon) ? td.polygon : []).map(function (v) { return [Number(v[0]), Number(v[1])]; })
    .filter(function (v) { return isFinite(v[0]) && isFinite(v[1]); });
  if (poly.length < 3) return true; // 線のない特別区域（種別だけで決める区域）は、場所では分けない
  let s = 90, n = -90, w = 180, e = -180;
  poly.forEach(function (v) { s = Math.min(s, v[0]); n = Math.max(n, v[0]); w = Math.min(w, v[1]); e = Math.max(e, v[1]); });
  return reassignFind_([{ id: 1, poly: poly, s: s, n: n, w: w, e: e }], Number(hd.lat), Number(hd.lng)) != null;
}
function holdLive_(ctx, d, now) {
  if (!d || d.endedAt || !(Date.parse(d.until) > now)) return false;
  const t = ctx.col('territories').get(String(d.terrId || ''));
  const td = t && t.data;
  return !!td && !td.holder && !td.awayPoolAt && String(td.completedAt || '') === String(d.comp || '');
}
function ruleHold_(ctx, old, v) {
  if (!v || typeof v !== 'object') return null;
  if (old) {
    // 変えられるのは「終える」だけ（区域係もふくめて。中身を書きかえると、ほかの人の押さえと重なることがあるため）
    if (!ctx.admin && old.by !== ctx.me) return null;
    if (!same_(old, v, ['by', 'at', 'until', 'kind', 'terrId', 'comp', 'keys', 'date', 'slot'])) return null;
    return Object.assign({}, old, { endedAt: str_(v.endedAt, 40) || null });
  }
  if (v.by !== ctx.me) return null;
  const now = Date.now(), s = ctx.settings;
  const kind = v.kind === 'plan' ? 'plan' : 'now';
  const days = Math.max(1, Math.min(14, Number(s.osaeDays) || 7));
  const maxPlan = Math.max(1, Math.min(5, Number(s.osaeMax) || 2));
  const tid = str_(v.terrId, 40);
  const t = tid ? ctx.col('territories').get(tid) : null;
  const td = t && t.data;
  if (!td || td.holder || td.awayPoolAt || !td.completedAt) return null; // 完了した区域（担当者なし）だけ
  if (String(v.comp || '') !== String(td.completedAt)) return null;
  const until = Date.parse(String(v.until || ''));
  if (!isFinite(until) || until <= now || until > now + (days + 1.5) * DAY_MS) return null;
  if (!Array.isArray(v.keys)) return null;
  const seenK = {}, keys = [];
  v.keys.slice(0, 20).forEach(function (k) {
    const x = str_(k, 60);
    if (!KEY_RE.test(x) || seenK[x]) return;
    seenK[x] = true; keys.push(x);
  });
  if (!keys.length) return null;
  // 家は、その区域の家だけ（ほかの区域の家を押さえて、留守宅カードやおすすめから外せないように）
  const hids = {};
  keys.forEach(function (k) { hids[k.split('|')[0]] = true; });
  const hl = Object.keys(hids);
  if (hl.length > 6) prefetchHouses_(ctx, hl);
  if (hl.some(function (hid) { return !holdHouseIn_(td, tid, hid, houseData_(ctx, hid)); })) return null;
  // 数：予定は osaeMax まで。今行くは2つまで（新しい「今行く」と、終える前の古い「今行く」が同じ送信で来るため）
  let plans = 0, nows = 0;
  const busy = {};
  ctx.col('holds').forEach(function (x) {
    const d = x.data;
    if (!holdLive_(ctx, d, now)) return;
    if (d.by === ctx.me) { if (d.kind === 'plan') plans++; else nows++; }
    (d.keys || []).forEach(function (k) { busy[k] = true; });
  });
  if (kind === 'plan' && plans >= maxPlan) return null;
  if (kind === 'now' && nows >= 2) return null;
  // ほかの押さえ・留守宅カードに入っている家は、重ねない（2人がほぼ同時に押さえたとき）
  ctx.col('awayCards').forEach(function (x) {
    const d = x.data;
    if (!d || d.endedAt || !(Date.parse(d.expiresAt) > now) || !Array.isArray(d.keys)) return;
    d.keys.forEach(function (k) { busy[k] = true; });
  });
  if (keys.some(function (k) { return busy[k]; })) return null;
  const id = str_(v.id, 40);
  if (!ID_RE.test(id)) return null;
  const o = { id: id, by: ctx.me, at: clampTime_(v.at), until: new Date(until).toISOString(), kind: kind, terrId: tid, comp: String(td.completedAt), keys: keys };
  if (kind === 'plan') {
    const day = String(v.date || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) o.date = day;
    if (SLOT_NAMES.indexOf(String(v.slot || '')) >= 0) o.slot = String(v.slot);
  }
  if (v.endedAt) o.endedAt = str_(v.endedAt, 40);
  return o;
}

function ruleS13_(ctx, old, v) {
  if (!ctx.admin || !v) return null;
  const day = function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : ''; };
  const kind = v.kind === 'p' ? 'p' : 'a';
  const o = { id: str_(v.id, 40), kind: kind, terrId: str_(v.terrId, 40), at: str_(v.at, 40) || nowIso_(), by: ctx.me };
  if (!o.terrId) return null;
  if (kind === 'a') {
    o.name = str_(v.name, 30).trim(); o.a = day(v.a); o.c = day(v.c);
    if (!o.name || !o.a) return null;
  } else {
    o.year = Math.floor(Number(v.year)) || 0; o.c = day(v.c);
    if (!o.year || !o.c) return null;
  }
  return o;
}

function ruleAgeData_(ctx, old, v) {
  // current・prev：1つの市のデータ（以前のしくみ）。cur:市町村コード（5けた）：e-Stat 国勢調査の小地域集計を、市町村ごとに分けて持つ
  if (!ctx.admin || !v || !(v.id === 'current' || v.id === 'prev' || /^cur:\d{5}$/.test(String(v.id))) || !Array.isArray(v.areas)) return null;
  const num = function (x) { x = Number(x); return isFinite(x) ? Math.round(x * 1000) / 1000 : 0; };
  const area = function (a) {
    const o = { k: str_(a.k, 40), n: str_(a.n, 40), pop: num(a.pop), c: num(a.c), y: num(a.y), m: num(a.m), o: num(a.o), o75: num(a.o75) };
    if (a.hi) o.hi = num(a.hi);
    // 20〜49歳（t）と子どもの内訳（c0：0〜4歳・c1：5〜9歳・c2：10〜14歳）。市のデータにあるときだけ
    ['t', 'c0', 'c1', 'c2'].forEach(function (f) { if (a[f] != null && a[f] !== '' && isFinite(Number(a[f]))) o[f] = num(a[f]); });
    return o;
  };
  const areas = v.areas.slice(0, 700).filter(function (a) { return a && a.k; }).map(area);
  if (!areas.length) return null;
  return { id: String(v.id), src: v.src === 'city' ? 'city' : (v.src === 'estat' ? 'estat' : ''), asOf: str_(v.asOf, 10), city: str_(v.city, 20), areas: areas, all: v.all ? area(v.all) : null, file: str_(v.file, 80),
    savedAt: str_(v.savedAt, 40) || nowIso_(), by: str_(v.by, 40) || ctx.me };
}

function ruleFollow_(ctx, old, f) {
  if (ctx.admin) return f;
  if (!f || f.by !== ctx.me) return null;
  if (old && old.by !== ctx.me) return null;
  if (!old) {
    ctx.folNew = (ctx.folNew || 0) + 1;
    if (ctx.folNew > 200) return null; // 1回の送信で新しく受け持てるのは 200件まで（監査6 M1）
    if (!followOk_(ctx, String(ctx.curId || ''))) return null; // 新しい受け持ちは、受け持ってよい家だけ（L16・2026-10-29）
  }
  return { by: ctx.me, since: str_(f.since, 40) || nowIso_(), touchedAt: str_(f.touchedAt, 40) || nowIso_() };
}

/* 係以外が新しく受け持ってよい家か（L16）：ある家で、
   その区域を持っている（今日一緒に回る・今日の司会もふくむ）／同じ送信でその家を記録した／引き継ぎを待っている家／前にその家を訪ねた */
function followOk_(ctx, k) {
  const i = k.indexOf('|'), hid = i > 0 ? k.slice(0, i) : '', unit = str_(i > 0 ? k.slice(i + 1) : '', 12); // 部屋の名前は記録と同じく12字（監査6 L3）
  if (!hid) return false;
  const hd = houseData_(ctx, hid);
  if (!hd) return false;
  if (holdsTerr_(ctx, hd.terrId)) return true;
  if ((ctx.pendVisits || []).some(function (v) { return v && String(v.houseId) === hid && str_(v.unit || '', 12) === unit && (!v.by || v.by === ctx.me); })) return true;
  const rel = ctx.col('released').get(k);
  if (rel && rel.data && rel.data.reason !== 'closed') return true; // 引き継ぎを待っている家（「もう訪ねない」で外した家はのぞく・監査6 L3）
  if (!ctx.myVisited) followPrefetch_(ctx, ctx.folUps || [{ id: k }]); // 区域・同じ送信の記録・引き継ぎで決まらなかったときだけ探す（ふだんの記録では探さない・監査7 N2）
  return !!(ctx.myVisited && ctx.myVisited[hid + '|' + unit]);
}
/* 新しい受け持ちの家のうち、本人が前に訪ねた家を、40軒ずつ1回の検索でまとめて探す（監査6 M1。cascadeHouses_ と同じやり方） */
function followPrefetch_(ctx, ups) {
  ctx.myVisited = {};
  const fm = ctx.col('follows'), hids = {};
  ups.forEach(function (x) { const id = String(x && x.id || ''); const j = id.indexOf('|'); if (j > 0 && !fm.get(id)) hids[id.slice(0, j)] = true; });
  const list = Object.keys(hids).slice(0, 200);
  if (!list.length) return;
  try {
    const sh = dataSheet_('visits'), n = sh.getLastRow();
    if (n < 2) return;
    const reEsc = function (x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    const col = sh.getRange(2, 2, n - 1, 1);
    for (let a = 0; a < list.length; a += 40) {
      readFound_(sh, 2, col.createTextFinder('"houseId":"(' + list.slice(a, a + 40).map(reEsc).join('|') + ')"').useRegularExpression(true).matchCase(true).findAll()).forEach(function (val) {
        const v = parseJson_(val, null);
        if (v && v.by === ctx.me) ctx.myVisited[String(v.houseId) + '|' + str_(v.unit || '', 12)] = true;
      });
    }
  } catch (e) { console.warn('受け持ちの確かめ：' + e); }
}

function ruleRequest_(ctx, old, r) {
  if (ctx.admin) {
    // 区域係どうしで、同じ申し込みを二重に決めない（ほかの係が先に決めた申し込みを、別の結果・別の区域で上書きしない）
    // 自分が決めたものを「取り消す」（申し込み中に戻す）のは受け付ける
    if (old && r && old.status !== 'pending' && old.decidedBy && old.decidedBy !== ctx.me) {
      if (r.status !== old.status || String(r.terrId || '') !== String(old.terrId || '')) return null;
    }
    return r;
  }
  if (!r || r.by !== ctx.me) return null;
  if (!old) {
    if (r.status !== 'pending') return null;
    if (r.type === 'delHouse') {
      const hd = houseData_(ctx, String(r.houseId || ''));
      if (!hd) return null;
      let dup = false;
      ctx.col('requests').forEach(function (x) { if (x.data.type === 'delHouse' && x.data.houseId === r.houseId && x.data.status === 'pending') dup = true; });
      if (dup) return null;
      return { id: str_(r.id, 40), by: ctx.me, type: 'delHouse', houseId: str_(r.houseId, 60), terrId: hd.terrId || null,
        label: str_(hd.label, 40), reason: str_(r.reason, 40), at: str_(r.at, 40) || nowIso_(), status: 'pending' };
    }
    const forGroup = !!(r.forGroup && canGroupTerr_(ctx.user) && ctx.user.group === r.forGroup);
    const pending = pendingCount_(ctx, forGroup, null);
    const limit = Number(forGroup ? ctx.settings.reqMaxGroup : ctx.settings.reqMaxPersonal) || 1;
    if (pending >= limit) return null;
    if (heldCount_(ctx, forGroup) + pending >= holdMax_(ctx.settings, forGroup)) return null;
    const o = { id: str_(r.id, 40), by: ctx.me, terrId: r.terrId ? str_(r.terrId, 40) : null, at: str_(r.at, 40) || nowIso_(), status: 'pending' };
    if (forGroup) o.forGroup = ctx.user.group;
    if (forGroup && r.use === 'all') o.use = 'all'; // 全体の集まりで使う区域として申し込む
    return o;
  }
  if (old.by !== ctx.me) return null;
  if (!same_(old, r, ['by', 'terrId', 'at', 'status', 'decidedAt'])) return null;
  return Object.assign({}, old, { seen: !!r.seen });
}

/* 返却の記録（S-13 のもと）
   ・区域係：今までどおり、送られた内容を保存する
   ・係以外が新しく作るとき（監査①S3）：本人が返した区域だけ。決めた項目だけを残し、日時・割合の形もここで決める
       本人が返した区域＝この送信で本人が返した区域（ctx.retNow）、または送り直しで、区域に残った
       「返した時の受け取りの日」と返した時刻が合う区域。同じ受け取りの返却の記録がすでにあれば作らない
   ・係以外の送り直し（監査②V2・V9）：同じ id・同じ本人の記録なら、今の内容のまま受け付ける */
function ruleReturn_(ctx, old, r) {
  if (ctx.admin) {
    // 紙の区域カードを留守宅カードにして返した記録（古い画面の係）：紙で回った家はアプリにないので、
    // 「アプリの記録で確かめる」の印（low）は付けない（あとで自動で途中の返却にしない。紙の区域カードは記録で確かめない決まり・監査P3・M2）
    // あわせて「紙の区域カードで回った」印（ph）を付ける：係の端末の自動の確かめ（印のない正式返却の拾い上げ）の対象にせず、
    // カードが完了したあと recLess が付いて、おすすめに回り残しを出さない（第2回監査 R2・2026-10-29）
    const pp = r && r.pool && r.low && ctx.phPool && Object.prototype.hasOwnProperty.call(ctx.phPool, String(r.terrId)) ? ctx.phPool[String(r.terrId)] : null;
    if (pp !== null && String(r.lentAt || '') === pp) { const o = Object.assign({}, r); delete o.low; o.ph = 1; return o; }
    // 上で ph を付けた記録（紙の区域カードの留守宅カード）を、古い画面の係が送り直したとき（返事が届かず同じ送信を re:1 で送り直す・
    // 返却の記録だけの送り直し）：区域はもう留守宅カードなので上の判定が立たないが、画面が持つ low:1 で上書きさせず、ph も残す（第2回監査 R2）
    if (old && old.ph === 1 && old.pool === 1 && r && r.pool && !r.ph) { const o = Object.assign({}, r); delete o.low; o.ph = 1; return o; }
    // 係の端末の時計が先に進んでいたとき：区域の日時をサーバーの時刻に直した分（ruleTerritory0_ の admTime）に、記録の日時もそろえる。
    // 区域と関係なく先の日時の記録も、サーバーの時刻にする（総合監査 M6）
    if (r && (r.at || r.firstAt)) {
      const fx = ctx.admTime || {}, lim = Date.now() + 10 * 60000, o2 = Object.assign({}, r);
      let ch2 = false;
      ['at', 'firstAt'].forEach(function (k) {
        const v = o2[k]; if (!v || (old && String(old[k] || '') === String(v))) return;
        const ms = Date.parse(String(v));
        if (fx[String(v)]) { o2[k] = fx[String(v)]; ch2 = true; }
        else if (isFinite(ms) && ms > lim) { o2[k] = nowIso_(); ch2 = true; }
      });
      if (ch2) return o2;
    }
    return r;
  }
  if (!r || r.by !== ctx.me) return null;
  if (old) return old.by === ctx.me && String(old.terrId) === String(r.terrId) ? old : null;
  const tid = str_(r.terrId, 40);
  const tx = tid ? ctx.col('territories').get(tid) : null;
  if (!tx || !tx.data) return null;
  const t = tx.data, cur = ctx.retNow && ctx.retNow[tid];
  const MIN10 = 10 * 60000;
  let lentAt, retAt, done, ph;
  if (cur) { lentAt = cur.lentAt; retAt = cur.at; done = cur.done; ph = cur.ph; }
  else if (!t.holder && t.lastLentAt && String(r.lentAt || '') === String(t.lastLentAt) && near_(t.returnedAt, r.at, MIN10)) {
    lentAt = String(t.lastLentAt); retAt = String(t.returnedAt);
    done = !!(t.completedAt && near_(t.completedAt, r.at, MIN10));
    ph = !!r.ph && done && t.completedPct == null; // 紙の区域カードで回った区域は、完了の割合を持たない
  } else return null;
  if (lentAt) {
    let dup = false;
    ctx.col('returns').forEach(function (x) { const d = x.data; if (!dup && d && String(d.terrId) === tid && String(d.lentAt || '') === String(lentAt)) dup = true; });
    if (dup) return null;
  }
  const p = r.pct == null || r.pct === '' ? NaN : Number(r.pct);
  let pct = isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null;
  let completed = !!r.completed && !!done;
  // 区域の「回り終えた」を途中の返却に直したときは、返却の記録も同じにする（監査D5）
  if (ctx.notDone && tid in ctx.notDone) { completed = false; pct = ctx.notDone[tid]; }
  // 日時：同じ送信で区域を返したとき（cur）は、区域の返した日時（サーバーで時計のずれを直した値）にそろえる。
  // 端末の時刻を使うと、時計が 5〜10分ずれているとき、画面の照合（記録の at と区域の completedAt）が外れる（監査 M-1）
  // firstAt（1回目を終えた日）も、端末の時計が先に進んでいればサーバーの時刻（総合監査 M6。過去の日付はそのまま）
  const fa = r.firstAt ? str_(r.firstAt, 40) : null, faMs = Date.parse(String(fa || ''));
  const o = { id: str_(r.id, 40), terrId: tid, by: ctx.me, lentAt: lentAt || null, firstAt: fa && isFinite(faMs) && faMs > Date.now() + 10 * 60000 ? nowIso_() : fa,
    at: cur ? retAt : (near_(r.at, retAt, MIN10) ? str_(r.at, 40) : retAt), completed: completed, pct: pct };
  if (cur) { // 同じ送信で返した区域：印は区域の状態から・割合はサーバーで数えた値を超えない（L17）
    if (cur.g) o.g = 1;
    if (cur.ga) o.ga = 1;
    if (cur.pct != null && isFinite(cur.pct)) o.sp = Math.round(cur.pct); // サーバーで数えた割合は別の項目に（pct は画面の数え方のまま。意味が段階でちがうため・監査6 L2）
  } else {
    if (r.g) o.g = 1;          // グループ奉仕の区域（記録だけがあとから届いたとき：区域にはもう残っていないので、送られた印を使う）
    if (r.ga) o.ga = 1;        // 全体の集まりの区域
  }
  if (r.pool && !(ctx.notPool && tid in ctx.notPool)) o.pool = 1; // 留守宅カードにして返した（1回目が目安に届かず途中の返却にした区域は付けない・A-1）
  if (ph) o.ph = 1;          // 紙の区域カードで回った
  if (cur && cur.rf) o.from = cur.rf; // 続きから回った：回りはじめた日（前の人が受け取った日）。画面の値は使わず、区域に残っていた日を使う（K-1）
  // 記録だけがあとから届いたとき（A-7）：途中で返した区域には lastRoundFrom（この巡回の始まり）が残っているので、それが受け取った日より前なら from に
  else if (!cur && !completed && t.lastRoundFrom && lentAt && String(t.lastRoundFrom) < String(lentAt)) o.from = String(t.lastRoundFrom);
  // 本人の返却の確かめは、今までどおり区域の保存（ruleTerritory0_）がその場で記録の割合で行う。
  // 係が「1回目を終えたことにする」のあとに本人が返したときに、あとから記録で確かめる印は付けない（監査P5・2026-10-29。指示書8章の範囲にもどす）
  return o;
}

/** 区域カードを持っていない人の記録か（担当者の画面で青いチェックにするための印） */
function outOfCard_(ctx, tid, key) {
  if (holdsTerr_(ctx, tid)) return false;
  // 特別区域（コンビニ・集合住宅など）を持っている人が、その特別区域の家を記録したときも、カードの中の記録（L12・2026-10-30）
  const hid = String(key || '').split('|')[0], hd = houseData_(ctx, hid);
  let inSp = false;
  if (hd) ctx.col('territories').forEach(function (x, id) {
    if (inSp || !x.data || !isSpecialTerr_(x.data) || !holdsTerr_(ctx, id)) return;
    // 名指しの家（ids）か、線のある特別区域だけ。線のない（種別だけで決める）特別区域は、サーバーでは家の種別を確かめられないので数えない（今までどおり oc を付ける。画面は自分の記録を「ほかの人」にしない）
    const sp = x.data.special || {};
    if (!(Array.isArray(sp.ids) && sp.ids.length) && !(Array.isArray(x.data.polygon) && x.data.polygon.length >= 3)) return;
    if (holdHouseIn_(x.data, id, hid, hd)) inSp = true;
  });
  return !inSp;
}

/* =========================================================
   古い記録の整理（毎月）
   ========================================================= */
function cleanupOld() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const s = getSettings_();
    if (typeof ikenPrune_ === 'function') { try { ikenPrune_(); } catch (eI) { console.warn('こまったこと・提案の整理ができませんでした：' + eI); } } // 1年より古いものを消す（iken.gs・監査 M-2）
    const now = Date.now();
    const cutoff = now - s.keepMonths * 30.5 * DAY_MS;

    const visits = readCol_('visits');
    const latest = {};
    visits.forEach(function (x, id) {
      const k = x.data.houseId + '|' + (x.data.unit || '');
      if (!latest[k] || x.data.at > latest[k].at) latest[k] = { id: id, at: x.data.at };
    });
    const keep = {};
    Object.keys(latest).forEach(function (k) { keep[latest[k].id] = true; });
    let removed = 0;
    const gone = [];
    visits.forEach(function (x, id) {
      if (Date.parse(x.data.at) < cutoff && !keep[id]) { visits.delete(id); removed++; gone.push(['visits', id, '']); }
    });
    if (removed) {
      rewriteCol_('visits', visits); // 先に書いて、余りを空にする（途中で止まっても記録は消えない）
    }

    const cards = readCol_('awayCards');
    let rc = 0;
    cards.forEach(function (x, id) {
      const end = x.data.endedAt ? Date.parse(x.data.endedAt) : Date.parse(x.data.expiresAt);
      if (end < now - 90 * DAY_MS) { cards.delete(id); rc++; gone.push(['awayCards', id, '']); }
    });
    if (rc) rewriteCol_('awayCards', cards);

    // おすすめの押さえ：終わってから30日たったものを消す（2026-10-26）
    const holds = readCol_('holds');
    let rh = 0;
    holds.forEach(function (x, id) {
      const end = x.data && x.data.endedAt ? Date.parse(x.data.endedAt) : Date.parse(x.data && x.data.until);
      if (!isFinite(end) || end < now - 30 * DAY_MS) { holds.delete(id); rh++; gone.push(['holds', id, '']); }
    });
    if (rh) rewriteCol_('holds', holds);

    const reqs = readCol_('requests');
    let rr = 0;
    reqs.forEach(function (x, id) {
      if (x.data.status !== 'pending' && Date.parse(x.data.decidedAt || x.data.at) < now - 180 * DAY_MS) { reqs.delete(id); rr++; gone.push(['requests', id, '']); }
    });
    if (rr) rewriteCol_('requests', reqs);

    // 消したものは変更の記録に入れる（端末は差分で追いつける）。全部を読み直させるのは、とても多いときだけ（M15・2026-10-30。
    // 以前は留守宅カード・申し込み・押さえを1件でも消すとリセットし、毎月1日の朝に全員が全部読み直していた）
    if (gone.length > 5000) resetJournal_();
    else if (gone.length) { for (let i = 0; i < gone.length; i += 1500) journal_(gone.slice(i, i + 1500)); }
    console.log('整理：訪問記録 ' + removed + '件、留守宅カード ' + rc + '件、申し込み ' + rr + '件、おすすめの押さえ ' + rh + '件');

    if (typeof memoCleanup_ === 'function') {
      try { memoCleanup_(); } catch (e) { console.error(e && e.stack ? e.stack : e); }
    }
    shrinkSheets_();
    try { opsTrim_(); } catch (e) { console.warn(e); }
    // 係の画面で見えるように、最後に動いた日時と件数を残す（途中で失敗したときは、ここまで来ないので残らない）
    props_().setProperty('CLEAN_LAST', JSON.stringify({ at: new Date().toISOString(), visits: removed, cards: rc, reqs: rr }));
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================
   スプレッドシートのメニュー（区域係用）／ Menú (encargado)
   ========================================================= */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu(T_('区域マップ', 'Mapa de Territorios'))
    .addItem(T_('① 最初の準備（はじめに1回）', '① Preparación inicial (una vez)'), 'setupSheets')
    .addItem(T_('② 公開ページのURLを設定', '② Guardar la URL de la página'), 'setPagesUrl')
    .addSeparator()
    .addItem(T_('共通リンクを表示', 'Ver el enlace común'), 'showJoinLink')
    .addItem(T_('共通リンクを作り直す', 'Renovar el enlace común'), 'resetJoinLink')
    .addSeparator()
    .addItem(T_('使う人を追加', 'Agregar usuario'), 'addUser')
    .addItem(T_('選んだ人の招待リンクを表示', 'Ver enlace de invitación del usuario elegido'), 'showInvite')
    .addItem(T_('選んだ人の招待リンクを作り直す', 'Renovar enlace de invitación del usuario elegido'), 'reissueInvite')
    .addSeparator()
    .addItem(T_('家の区域を振り直す（今の区域の線で）', 'Reasignar casas según las líneas actuales'), 'reassignHouses')
    .addItem(T_('国土地理院のデータから「仮の家」を取り込む', 'Importar casas provisionales (datos del GSI)'), 'importGsi')
    .addItem(T_('国土地理院の取り込みの進み具合', 'Progreso de la importación del GSI'), 'importGsiStatus')
    .addItem(T_('OpenStreetMap から「仮の家」を取り込む', 'Importar casas provisionales (OpenStreetMap)'), 'importProvHouses')
    .addItem(T_('OpenStreetMap の取り込みの進み具合', 'Progreso de la importación de OpenStreetMap'), 'importStatus')
    .addItem(T_('確かめていない仮の家を消す', 'Borrar casas provisionales sin confirmar'), 'wipeProvHouses')
    .addSeparator()
    .addItem(T_('区域の字を調べる（年齢データ用）', 'Buscar barrios de los territorios (datos de edad)'), 'azaLookupMenu')
    .addItem(T_('すべての区域の字を調べ直す', 'Volver a buscar todos los barrios'), 'azaRedoAllMenu')
    .addItem(T_('年齢データを取り込む（毎月の自動取り込みも設定）', 'Importar datos de edad (y cada mes)'), 'ageAutoMenu')
    .addItem(T_('全員のスマホに、データを読み直してもらう', 'Pedir a todos los teléfonos que recarguen los datos'), 'refreshAllDevices')
    .addItem(T_('訪問の記録（会えた・留守）を消す（拒否・注意は残す）', 'Borrar registros de visitas (se conservan rechazos y avisos)'), 'clearVisitHistoryMenu')
    .addSeparator()
    .addItem(T_('自動バックアップを始める（毎週）', 'Iniciar copia automática (semanal)'), 'backupInstallMenu')
    .addItem(T_('毎月の自動整理を始める（毎月1日）', 'Iniciar limpieza mensual automática'), 'cleanupInstallMenu')
    .addItem(T_('今すぐバックアップ', 'Copia de seguridad ahora'), 'backupNowMenu')
    .addItem(T_('バックアップの状態', 'Estado de las copias'), 'backupStatusMenu')
    .addItem(T_('バックアップから戻す', 'Restaurar desde una copia'), 'restoreMenu')
    .addSeparator()
    .addItem(T_('紙の予備（S-12・S-13）の保存先を設定', 'Carpeta para respaldo en papel (S-12/S-13)'), 'pdfFolderMenu')
    .addItem(T_('紙の予備の状態', 'Estado del respaldo en papel'), 'pdfStatusMenu')
    .addSeparator()
    .addSubMenu(ui.createMenu('言語 / Idioma')
      .addItem('日本語', 'setLangJa')
      .addItem('Español', 'setLangEs'))
    .addToUi();
}

/** ① 最初の準備：シートを作り、最初の区域係を登録し、自動の仕事（整理・バックアップ・一覧）をすべて設定する */
function setupSheets() {
  const ui = SpreadsheetApp.getUi();
  // 言語をえらぶ（はじめの1回だけ）
  if (!props_().getProperty('UI_LANG')) {
    const r0 = ui.alert('言語 / Idioma',
      'メニューと案内を日本語にしますか？\n「はい」＝日本語　「いいえ」＝スペイン語\n\n¿Usar los menús en japonés?\n«Sí» = japonés　«No» = español',
      ui.ButtonSet.YES_NO);
    props_().setProperty('UI_LANG', r0 === ui.Button.NO ? 'es' : 'ja');
    try { CacheService.getScriptCache().remove('ui_lang'); } catch (e) { /* 何もしない */ }
  }
  usersSheet_();
  dataSheet_(SETTINGS);
  DATA_COLS.forEach(dataSheet_);
  journalSheet_();
  devicesSheet_();
  if (typeof memoSheet_ === 'function') memoSheet_();
  joinCode_(true);
  if (!readCol_(SETTINGS).get('settings')) {
    writeCol_(SETTINGS, readCol_(SETTINGS), [['settings', DEFAULT_SETTINGS]], [], 'setup');
  }
  ['シート1', 'Sheet1', 'Hoja 1', 'Hoja1'].forEach(function (n) {
    const s = book_().getSheetByName(n);
    if (s && s.getLastRow() === 0 && book_().getSheets().length > 1) book_().deleteSheet(s);
  });

  // 自動の仕事：毎月の整理・毎週のバックアップ・1時間ごとの一覧づくり
  const notes = [];
  try { installCleanup_(); notes.push(T_('・古い記録の整理（毎月1日）', '・Limpieza de registros antiguos (día 1 de cada mes)')); } catch (e) { notes.push('× cleanup: ' + e.message); }
  if (typeof backupInstall_ === 'function') {
    try { backupInstall_(); notes.push(T_('・自動バックアップ（毎週日曜の夜中）', '・Copia de seguridad automática (domingos de madrugada)')); } catch (e) { notes.push('× backup: ' + e.message); }
  }
  if (typeof houseSnapSetup === 'function') {
    try { houseSnapSetup(); notes.push(T_('・はじめて開く人のための一覧（1時間ごと）', '・Listas para la primera carga (cada hora)')); } catch (e) { notes.push('× snap: ' + e.message); }
  }
  cacheDrop_();
  try { shrinkSheets_(); } catch (e) { console.warn(e); } // 新しいシートの余分な行・列を減らす（セルの上限対策）

  if (!usersAll_().length) {
    const r = ui.prompt(T_('最初の区域係', 'Primer encargado'),
      T_('あなた（区域係）の名前を入力してください。', 'Escriba su nombre (encargado de territorios).'), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK || !r.getResponseText().trim()) {
      ui.alert(T_('準備はできました。あとで「使う人を追加」から区域係を登録してください。\n\n設定した自動の仕事：\n',
        'Listo. Después registre al encargado con «Agregar usuario».\n\nTareas automáticas:\n') + notes.join('\n'));
      return;
    }
    const u = addUserRow_(r.getResponseText().trim(), true);
    ui.alert(T_('準備ができました', 'Preparación terminada'),
      T_('設定した自動の仕事：\n', 'Tareas automáticas configuradas:\n') + notes.join('\n') +
      T_('\n\n次は、説明書の手順にそって GitHub で公開ページを作り、「② 公開ページのURLを設定」をしてください。そのあと、users シートで自分の行を選び、メニューの「選んだ人の招待リンクを作り直す」で、あなたの招待リンクが出ます。',
        '\n\nAhora siga el manual: publique la página en GitHub y use «② Guardar la URL de la página». Después, elija su fila en «users» y use «Renovar enlace de invitación del usuario elegido» para obtener su enlace.'),
      ui.ButtonSet.OK);
    if (props_().getProperty('PAGES_URL')) showInviteDialog_(u.name, u.token);
  } else {
    ui.alert(T_('準備ができました。\n\n', 'Preparación terminada.\n\n') + notes.join('\n'));
  }
}

function setPagesUrl() {
  const ui = SpreadsheetApp.getUi();
  const cur = props_().getProperty('PAGES_URL') || '';
  const r = ui.prompt(T_('公開ページのURL', 'URL de la página'),
    T_('GitHub Pages のURLを入力してください。\n例：https://ユーザー名.github.io/kuiki-map/\n現在：', 'Escriba la URL de GitHub Pages.\nEjemplo: https://usuario.github.io/kuiki-map/\nActual: ') + (cur || T_('未設定', 'sin configurar')),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  let url = r.getResponseText().trim();
  if (!/^https:\/\//.test(url)) { ui.alert(T_('https:// から始まるURLを入力してください。', 'La URL debe empezar con https://')); return; }
  url = url.replace(/[?#].*$/, '');
  if (!/\/$/.test(url) && !/\.html$/.test(url)) url += '/';
  props_().setProperty('PAGES_URL', url);
  ui.alert(T_('保存しました：', 'Guardado: ') + url);
}

function addUser() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt(T_('使う人を追加', 'Agregar usuario'), T_('名前を入力してください（例：山田 花子）。', 'Escriba el nombre (ej.: María López).'), ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const name = r1.getResponseText().trim();
  if (!name) return;
  const r2 = ui.alert(T_('役割', 'Rol'), T_(name + 'さんは区域係ですか？\n「はい」＝区域係　「いいえ」＝伝道者', '¿' + name + ' es encargado de territorios?\n«Sí» = encargado　«No» = publicador'), ui.ButtonSet.YES_NO_CANCEL);
  if (r2 === ui.Button.CANCEL || r2 === ui.Button.CLOSE) return;
  const u = addUserRow_(name, r2 === ui.Button.YES);
  showInviteDialog_(u.name, u.token);
}

function selectedUser_() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== USERS) return null;
  const row = sh.getActiveRange().getRow();
  return usersAll_().filter(function (u) { return u.row === row; })[0] || null;
}

function showInvite() {
  const ui = SpreadsheetApp.getUi();
  const u = selectedUser_();
  if (!u) { ui.alert(T_('「users」シートで、招待リンクを表示したい人の行を選んでください。', 'En la hoja «users», seleccione la fila de la persona.')); return; }
  // 招待コードはシートに置いていない（安全のため、照合値だけ）。今のリンクは出せないので、作り直す
  ui.alert(T_('招待リンク', 'Enlace de invitación'),
    T_('安全のため、招待リンクはシートに保存していません。\n' + u.name + 'さんに新しいリンクを渡すときは、「選んだ人の招待リンクを作り直す」を使ってください。\n（作り直すと、今のリンクと、そのリンクで開いた端末は使えなくなります。新しいリンクを開き直してもらいます。共通リンクやホーム画面のアイコンから登録した端末は、そのまま使えます）',
      'Por seguridad, los enlaces no se guardan en la hoja.\nPara dar un enlace nuevo a ' + u.name + ', use «Renovar enlace de invitación del usuario elegido».\n(El enlace actual y los dispositivos que lo usaron dejarán de funcionar; deben abrir el enlace nuevo. Los dispositivos registrados con el enlace común o el icono de inicio siguen funcionando.)'),
    ui.ButtonSet.OK);
}

function reissueInvite() {
  const ui = SpreadsheetApp.getUi();
  const u = selectedUser_();
  if (!u) { ui.alert(T_('「users」シートで、作り直したい人の行を選んでください。', 'En la hoja «users», seleccione la fila de la persona.')); return; }
  const ok = ui.alert(T_('招待リンクを作り直す', 'Renovar enlace'), T_(u.name + 'さんの今の招待リンクは使えなくなります。よろしいですか？', 'El enlace actual de ' + u.name + ' dejará de funcionar. ¿Continuar?'), ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const token = newToken_();
  usersSheet_().getRange(u.row, 4).setValue(userTokenKey_(token)); // シートには照合値だけ
  cacheDrop_();
  showInviteDialog_(u.name, token);
}

function esc_(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

function showInviteDialog_(name, token) {
  const base = props_().getProperty('PAGES_URL');
  const ui = SpreadsheetApp.getUi();
  if (!base) {
    ui.alert(T_('先に「② 公開ページのURLを設定」を行ってください。\nそのあと「選んだ人の招待リンクを作り直す」で、' + name + 'さんの招待リンクが出ます。',
      'Primero use «② Guardar la URL de la página».\nDespués, «Renovar enlace de invitación del usuario elegido» mostrará el enlace de ' + name + '.'));
    return;
  }
  const url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token);
  showLinkDialog_(T_('招待リンク', 'Enlace de invitación'),
    '<p>' + T_('<b>' + esc_(name) + 'さん</b>の招待リンクです。', 'Enlace de invitación de <b>' + esc_(name) + '</b>.') + '</p>', url,
    '<p style="color:#8a1c1c">' + T_('このリンクは本人だけに渡してください。<br>リンクを知っている人は、その人として使えてしまいます。なくした・人に知られたときは「招待リンクを作り直す」を行ってください。',
      'Entregue este enlace solo a esa persona.<br>Quien lo tenga puede usar la aplicación en su nombre. Si se pierde o se comparte, use «Renovar enlace».') + '</p>' +
    '<p style="color:#555">' + T_('使うのをやめる人は、users シートの「有効」のチェックを外してください。', 'Para dar de baja a alguien, quite la casilla «Activo» en la hoja «users».') + '</p>');
}

function onEdit(e) {
  try {
    const n = e && e.range && e.range.getSheet().getName();
    if (n === USERS || n === DEVICES) cacheDrop_();
  } catch (err) { /* 何もしない */ }
}

function showJoinLink() {
  const ui = SpreadsheetApp.getUi();
  joinCode_(true);
  const url = joinUrl_();
  if (!url) { ui.alert(T_('先に「② 公開ページのURLを設定」を行ってください。', 'Primero use «② Guardar la URL de la página».')); return; }
  showLinkDialog_(T_('共通リンク', 'Enlace común'), '<p>' + T_('会衆の全員に同じリンクを配れます。', 'Puede dar este mismo enlace a toda la congregación.') + '</p>', url,
    '<p style="color:#555">' + T_('このリンクを開いた人は、申し込みをします。<b>区域係が承認したスマホだけ</b>が使えます。<br>申し込みは、アプリの「係の画面」で承認できます。<br>リンクが外に広まったときは「共通リンクを作り直す」を行ってください（登録済みのスマホは、そのまま使えます）。',
      'Quien abra este enlace enviará una solicitud. <b>Solo funcionan los teléfonos aprobados por el encargado.</b><br>Las solicitudes se aprueban en la pantalla del encargado dentro de la aplicación.<br>Si el enlace se difunde fuera de la congregación, use «Renovar el enlace común» (los teléfonos ya registrados siguen funcionando).') + '</p>');
}
function resetJoinLink() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(T_('共通リンクを作り直す', 'Renovar el enlace común'), T_('今の共通リンクでは、新しい申し込みができなくなります。登録済みのスマホは、そのまま使えます。よろしいですか？', 'Con el enlace actual ya no se podrán enviar solicitudes nuevas. Los teléfonos registrados siguen funcionando. ¿Continuar?'), ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  props_().setProperty('JOIN_CODE', newToken_().slice(0, 32));
  showJoinLink();
}
function showLinkDialog_(title, head, url, foot) {
  const copy = T_('コピーする', 'Copiar'), copied = T_('コピーしました', 'Copiado');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:15px;line-height:1.7">' + head +
    '<textarea id="u" readonly style="width:100%;height:90px;font-size:13px">' + esc_(url) + '</textarea>' +
    '<p><button onclick="var t=document.getElementById(\'u\');t.select();document.execCommand(\'copy\');this.textContent=\'' + copied + '\'" style="font-size:15px;padding:6px 14px">' + copy + '</button></p>' +
    foot + '</div>').setWidth(460).setHeight(400);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

/** メニュー：毎月1日の朝3時ごろに、古い記録を整理する仕組み（cleanupOld）を設定する。何回押しても、仕掛けは1つだけ */
function cleanupInstallMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    installCleanup_();
    ui.alert(T_('毎月の自動整理を始めました', 'Limpieza mensual iniciada'),
      T_('毎月1日の朝3時ごろに、古い訪問記録などを自動で整理します。\n（保存期間は、アプリの「設定・データ」で決めた期間です）', 'Cada día 1 a las 3:00 se limpian los registros antiguos.'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert(T_('設定できませんでした：', 'No se pudo configurar: ') + ((e && e.message) || e));
  }
}

function installCleanup_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cleanupOld') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cleanupOld').timeBased().onMonthDay(1).atHour(3).create();
}

/* =========================================================
   家の区域を振り直す（区域の線を引き直したあとに）
   ========================================================= */
function reassignTerrBoxes_(m) {
  const ts = [];
  (m || readCol_('territories')).forEach(function (x, id) {
    const p = x.data && x.data.polygon;
    if (!Array.isArray(p) || p.length < 3 || x.data.special) return; // 特別区域は、家の区域を決めるのに使わない
    const poly = p.map(function (v) { return [Number(v[0]), Number(v[1])]; }).filter(function (v) { return isFinite(v[0]) && isFinite(v[1]); });
    if (poly.length < 3) return;
    let s = 90, n = -90, w = 180, e = -180;
    poly.forEach(function (v) { s = Math.min(s, v[0]); n = Math.max(n, v[0]); w = Math.min(w, v[1]); e = Math.max(e, v[1]); });
    ts.push({ id: id, no: String(x.data.no || ''), poly: poly, s: s, n: n, w: w, e: e, rest: !!x.data.rest });
  });
  return ts.sort(function (a, b) { return (a.rest ? 1 : 0) - (b.rest ? 1 : 0); }); // 親の残りの部分（rest）は、枝番のあとで見る
}
/** 家の区域を、今の区域の線で決め直す（画面なし）。dry＝数えるだけ */
function reassignCore_(dry) {
  const ts = reassignTerrBoxes_();
  const houses = readCol_('houses');
  const nos = {};
  ts.forEach(function (t) { nos[t.id] = t.no; });
  const changed = [];
  const r = { toTerr: 0, moved: 0, outside: 0, keptOut: 0, changed: 0 };
  houses.forEach(function (x, id) {
    const d = x.data;
    if (!d || !isFinite(Number(d.lat)) || !isFinite(Number(d.lng))) return;
    const tid = ts.length ? reassignFind_(ts, Number(d.lat), Number(d.lng)) : null;
    const cur = d.terrId && nos[d.terrId] !== undefined ? d.terrId : null;
    if ((d.terrId || null) === tid) return;
    if (!tid && cur) { r.keptOut++; return; }
    if (!tid) r.outside++; else if (!cur) r.toTerr++; else r.moved++;
    changed.push([id, tid]);
  });
  r.changed = changed.length;
  if (dry || !changed.length) return r;
  changed.forEach(function (c) { houses.get(c[0]).data.terrId = c[1]; });
  rewriteCol_('houses', houses);
  if (changed.length <= 5000) {
    for (let i = 0; i < changed.length; i += 1500) {
      journal_(changed.slice(i, i + 1500).map(function (c) { return ['houses', c[0], JSON.stringify(houses.get(c[0]).data)]; }));
    }
  } else {
    resetJournal_(); // 多すぎるときは、みんなに全部を読み直してもらう
  }
  return r;
}
function reassignFind_(ts, lat, lng) {
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (lat < t.s || lat > t.n || lng < t.w || lng > t.e) continue;
    let c = false;
    const p = t.poly;
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      if (((p[a][0] > lat) !== (p[b][0] > lat)) && (lng < (p[b][1] - p[a][1]) * (lat - p[a][0]) / (p[b][0] - p[a][0]) + p[a][1])) c = !c;
    }
    if (c) return t.id;
  }
  return null;
}
function reassignHouses() {
  const ui = SpreadsheetApp.getUi();
  const ts = reassignTerrBoxes_();
  if (!ts.length) { ui.alert(T_('区域の線がありません。', 'No hay líneas de territorio.')); return; }
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const houses = readCol_('houses');
    const nos = {};
    ts.forEach(function (t) { nos[t.id] = t.no; });
    const changed = [];
    let toTerr = 0, moved = 0, outside = 0, keptOut = 0;
    houses.forEach(function (x, id) {
      const d = x.data;
      if (!d || !isFinite(Number(d.lat)) || !isFinite(Number(d.lng))) return;
      const tid = reassignFind_(ts, Number(d.lat), Number(d.lng));
      const cur = d.terrId && nos[d.terrId] !== undefined ? d.terrId : null;
      if ((d.terrId || null) === tid) return;
      if (!tid && cur) { keptOut++; return; }
      if (!tid) outside++; else if (!cur) toTerr++; else moved++;
      changed.push([id, tid]);
    });
    if (!changed.length) { ui.alert(T_('家の区域は、今の区域の線と合っています。直すところはありません。', 'Las casas ya coinciden con las líneas actuales. No hay nada que corregir.')); return; }
    const ok = ui.alert(T_('家の区域を振り直す', 'Reasignar casas'),
      T_('今の区域の線で、家の区域を決め直します。\n\n・区域に入る家：' + toTerr + '件\n・別の区域に移る家：' + moved + '件\n・区域なしになる家：' + outside + '件\n\nよろしいですか？',
        'Se reasignarán las casas según las líneas actuales.\n\n・Casas que entran en un territorio: ' + toTerr + '\n・Casas que cambian de territorio: ' + moved + '\n・Casas que quedan sin territorio: ' + outside + '\n\n¿Continuar?'), ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    changed.forEach(function (c) { houses.get(c[0]).data.terrId = c[1]; });
    rewriteCol_('houses', houses);
    if (changed.length <= 5000) {
      for (let i = 0; i < changed.length; i += 1500) {
        journal_(changed.slice(i, i + 1500).map(function (c) { return ['houses', c[0], JSON.stringify(houses.get(c[0]).data)]; }));
      }
    } else {
      resetJournal_();
    }
    ui.alert(T_('家 ' + changed.length + '件の区域を振り直しました。', 'Se reasignaron ' + changed.length + ' casas.'));
  } finally {
    lock.releaseLock();
  }
}

function refreshAllDevices() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(T_('全員のスマホに、データを読み直してもらう', 'Recargar datos en todos los teléfonos'),
    T_('全員のスマホが、次に開いたとき（開いていれば数十秒以内に）区域・家・記録を全部読み直します。\nまだ送っていない記録は、送ってから読み直すので消えません。\n\nよろしいですか？',
      'Todos los teléfonos volverán a cargar territorios, casas y registros la próxima vez que se abran (o en unos segundos si están abiertos).\nLos registros no enviados se envían primero, así que no se pierden.\n\n¿Continuar?'), ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { resetJournal_(); } finally { lock.releaseLock(); }
  ui.alert(T_('読み直しの合図を出しました。', 'Aviso de recarga enviado.'));
}
