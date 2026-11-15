/**
 * 区域マップ：紙の予備（S-12・S-13 の PDF）をGoogleドライブに保存する
 *
 * ・GitHub の自動実行（ロボット）が、毎週、変わった区域の PDF だけを作って送ってきます。
 *   このファイルは、それを受け取ってドライブの「紙の予備」フォルダに上書き保存します。
 * ・送ってこられるのは、区域係の招待コードを持つロボットだけ（ほかの人は保存できません）
 * ・同じ名前の古いファイルはゴミ箱に移します（30日間はゴミ箱から戻せます）
 * ・S-12 は区域が増えたり減ったりしてファイル名が変わったら、使わなくなったファイルを片づけます。
 *   S-13 は奉仕年度ごとのファイルなので、前の年度のファイルは残します。
 *
 * コード.gs の doPost のいちばん上に、次の1行が必要です：
 *   if (e && e.parameter && e.parameter.pdf === '1') return json_(pdfBackupPost_(e));
 *
 * 【検証で足したところ】
 * ・ロボットの招待コードは GitHub に置いてあるため、もれたときの害を小さくする。
 *   スクリプトのプロパティ ROBOT_UID にロボットの id（users シートのA列）を入れると、
 *   ロボットは「区域・家の読み込み」と「PDF の保存」だけができ、訪問の記録の読み込みや、
 *   データの変更・係の操作はできなくなる（コード.gs の doPost に1行足す：robotBlocked_）
 * ・片づけ（pdf_prune）で、残すファイルが前回の半分より少ないときは、何も消さない
 *   （ロボットが区域の一部しか読めなかったときに、紙の予備を消してしまわないように）
 */

const PDF_DIR_PROP = 'PDF_DIR_ID';      // 保存先フォルダ
const PDF_MAN_PROP = 'PDF_MANIFEST';    // 保存したファイルと、その中身の印
const PDF_LAST_PROP = 'PDF_LAST';       // 最後に動いた日時と結果
const PDF_DIR_NAME = '紙の予備（S-12・S-13）';
const PDF_MAX_BYTES = 20 * 1024 * 1024;
const ROBOT_PROP = 'ROBOT_UID';         // 紙の予備のロボットの id（スクリプトのプロパティに手で入れる）

/* ---------- ロボットにできることを絞る ---------- */
/** ロボットの id（毎回プロパティを読まないよう、10分ためておく） */
function robotUid_() {
  const c = CacheService.getScriptCache();
  let v = null;
  try { v = c.get('robot_uid'); } catch (e) { v = null; }
  if (v === null) {
    v = props_().getProperty(ROBOT_PROP) || '-';
    try { c.put('robot_uid', v, 600); } catch (e) { /* 何もしない */ }
  }
  return v === '-' ? '' : v;
}
function isRobot_(user) {
  if (!user || user.role !== 'admin') return false; // ロボットは区域係の役割なので、ほかの人はプロパティを読まない
  const id = robotUid_();
  return !!id && user.id === id;
}
/** ロボットに許さない問い合わせなら true（コード.gs の doPost から呼ぶ）。
    許すのは、区域・設定など（meta）と家（houses）の読み込みだけ */
function robotBlocked_(user, req) {
  if (!isRobot_(user)) return false;
  return !(req.action === 'load' && (req.part === 'meta' || req.part === 'houses'));
}

/* ---------- ロボットからの受け付け ---------- */
function pdfBackupPost_(e) {
  try {
    const body = e && e.postData ? e.postData.contents : '';
    if (!body || body.length > 30000000) return { ok: false, error: 'bad_request' };
    // 大きな中身（PDF）を読む前に、合いことばを確かめる（点検①S8）。ロボットは先頭に action・token の順で送る
    const tm = /^\{\s*"action"\s*:\s*"[a-z_]{1,20}"\s*,\s*"token"\s*:\s*"([^"\\]{20,200})"/.exec(body.slice(0, 400));
    if (!tm) return { ok: false, error: 'bad_request' };
    const user = findUser_(tm[1]);
    if (!user) return { ok: false, error: 'auth' };
    let req;
    try { req = JSON.parse(body); } catch (err) { return { ok: false, error: 'bad_request' }; }
    if (String(req.token || '') !== tm[1]) return { ok: false, error: 'bad_request' };
    if (user.role !== 'admin') return { ok: false, error: 'admin' };
    if (req.action === 'pdf_list') return { ok: true, files: pdfManifest_(), dir: pdfDir_().getUrl() };
    if (req.action === 'pdf_put') return pdfPut_(req);
    if (req.action === 'pdf_prune') return pdfPrune_(req);
    if (req.action === 'pdf_done') return pdfDone_(req);
    return { ok: false, error: 'unknown_action' };
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, error: 'server' };
  }
}

/** 保存先フォルダ。まだ決めていなければ、スプレッドシートと同じフォルダに作る */
function pdfDir_() {
  const id = props_().getProperty(PDF_DIR_PROP);
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* 作り直す */ }
  }
  const parents = DriveApp.getFileById(book_().getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const f = parent.createFolder(PDF_DIR_NAME);
  props_().setProperty(PDF_DIR_PROP, f.getId());
  return f;
}

function pdfManifest_() { return parseJson_(props_().getProperty(PDF_MAN_PROP), {}) || {}; }
function pdfManifestSave_(m) { props_().setProperty(PDF_MAN_PROP, JSON.stringify(m)); }

/** 1つのPDFを保存する（同じ名前の古いファイルはゴミ箱へ） */
function pdfPut_(req) {
  const name = String(req.name || '');
  if (!/^S-1[23]_[^\/\\]{1,120}\.pdf$/.test(name)) return { ok: false, error: 'name' };
  let bytes;
  try { bytes = Utilities.base64Decode(String(req.data || '')); } catch (e) { return { ok: false, error: 'data' }; }
  if (bytes.length < 500 || bytes.length > PDF_MAX_BYTES) return { ok: false, error: 'size' };
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') return { ok: false, error: 'data' };
  const dir = pdfDir_();
  const olds = [];
  const it = dir.getFilesByName(name);
  while (it.hasNext()) olds.push(it.next());
  const file = dir.createFile(Utilities.newBlob(bytes, 'application/pdf', name));
  const when = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  file.setDescription('区域マップから自動で作成（' + when + '）' + (req.note ? '　' + str_(req.note, 100) : ''));
  olds.forEach(function (f) { try { f.setTrashed(true); } catch (e) { console.warn(e); } });
  const m = pdfManifest_();
  m[name] = { h: str_(req.hash, 64), at: nowIso_() };
  pdfManifestSave_(m);
  return { ok: true, url: file.getUrl() };
}

/** 使わなくなった S-12 のファイルを片づける（keep にあるものは残す。S-13 はさわらない） */
function pdfPrune_(req) {
  const keep = {};
  (Array.isArray(req.keep) ? req.keep : []).forEach(function (n) { keep[String(n)] = true; });
  const nKeep = Object.keys(keep).length;
  if (!nKeep) return { ok: true, trashed: 0 }; // 区域が1つもないときは、何も消さない
  const dir = pdfDir_(), m = pdfManifest_();
  // 残すファイルが、これまでの S-12 の半分より少ないときは、ロボットの読み込みがおかしいかもしれないので消さない
  // （区域の番号をつけ直したときは、新しいファイルも数に入るので、ふつうはここで止まらない）
  const known = Object.keys(m).filter(function (k) { return k.indexOf('S-12_') === 0; }).length;
  if (known >= 4 && nKeep * 2 < known) {
    console.warn('紙の予備：残すファイルが少なすぎるため、片づけをやめました（残す ' + nKeep + '・これまで ' + known + '）');
    return { ok: true, trashed: 0, guarded: 1 };
  }
  let n = 0;
  const it = dir.getFiles();
  while (it.hasNext()) {
    const f = it.next(), name = f.getName();
    if (name.indexOf('S-12_') === 0 && !keep[name]) { f.setTrashed(true); n++; }
  }
  Object.keys(m).forEach(function (k) { if (k.indexOf('S-12_') === 0 && !keep[k]) delete m[k]; });
  pdfManifestSave_(m);
  return { ok: true, trashed: n };
}

/** 最後に動いた結果を残す（メニューの「紙の予備の状態」で見る） */
function pdfDone_(req) {
  props_().setProperty(PDF_LAST_PROP, JSON.stringify({
    at: nowIso_(), made: Number(req.made) || 0, skipped: Number(req.skipped) || 0,
    pruned: Number(req.pruned) || 0, error: req.error ? str_(req.error, 300) : ''
  }));
  return { ok: true };
}

/* ---------- スプレッドシートのメニュー ---------- */
function pdfFolderMenu() {
  const ui = SpreadsheetApp.getUi();
  const cur = props_().getProperty(PDF_DIR_PROP);
  let curText = '未設定（はじめて保存するとき、このスプレッドシートと同じフォルダに「' + PDF_DIR_NAME + '」を作ります）';
  if (cur) { try { curText = DriveApp.getFolderById(cur).getName(); } catch (e) { curText = '見つかりません'; } }
  const r = ui.prompt('紙の予備（S-12・S-13）の保存先',
    '保存先にしたいドライブのフォルダを開き、そのURLを貼り付けてください。\n' +
    '区域係だけが開けるフォルダにしてください（拒否の家と、区域を受け取った人の名前が入っているため）。\n\n現在：' + curText,
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const m = /folders\/([A-Za-z0-9_-]{10,})/.exec(r.getResponseText()) || /^([A-Za-z0-9_-]{20,})$/.exec(r.getResponseText().trim());
  if (!m) { ui.alert('フォルダのURLを読み取れませんでした。ドライブでフォルダを開いたときのURLを貼り付けてください。'); return; }
  let f;
  try { f = DriveApp.getFolderById(m[1]); f.getName(); } catch (e) { ui.alert('そのフォルダを開けませんでした。'); return; }
  props_().setProperty(PDF_DIR_PROP, f.getId());
  props_().deleteProperty(PDF_MAN_PROP); // 新しいフォルダには、次の回にすべて作り直す
  ui.alert('保存先を「' + f.getName() + '」にしました。次の自動保存で、すべてのPDFを作ります。');
}

function pdfStatusMenu() {
  const ui = SpreadsheetApp.getUi();
  const last = parseJson_(props_().getProperty(PDF_LAST_PROP), null);
  const m = pdfManifest_();
  const fmt = function (iso) { const d = new Date(iso); return isNaN(d) ? '-' : Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'); };
  let dirText = '未設定';
  const id = props_().getProperty(PDF_DIR_PROP);
  if (id) { try { const f = DriveApp.getFolderById(id); dirText = f.getName() + '\n' + f.getUrl(); } catch (e) { dirText = '見つかりません'; } }
  let lastText = 'まだ動いていません';
  if (last) {
    lastText = fmt(last.at) + (last.error ? '　うまくいきませんでした：' + last.error
      : '　作ったファイル ' + last.made + '・変わりなし ' + last.skipped + (last.pruned ? '・片づけ ' + last.pruned : ''));
  }
  const rid = props_().getProperty(ROBOT_PROP) || '';
  const robot = rid ? usersAll_().filter(function (u) { return u.id === rid; })[0] : null;
  const robotText = !rid ? '未設定（ロボットは区域係と同じことができます）'
    : robot ? robot.name + '（区域・家の読み込みとPDFの保存だけ）' : '見つかりません（ROBOT_UID の id を確かめてください）';
  const names = Object.keys(m).sort();
  const days = last ? Math.floor((Date.now() - Date.parse(last.at)) / DAY_MS) : null;
  ui.alert('紙の予備（S-12・S-13）の状態',
    '保存先：' + dirText + '\n\nロボット：' + robotText + '\n\n最後に動いた日時：' + lastText +
    (days !== null && days > 8 ? '\n\n※ ' + days + '日動いていません。GitHub の「Actions」で、自動実行が止まっていないか確かめてください。' : '') +
    '\n\n保存しているファイル（' + names.length + '）：\n' +
    names.map(function (n) { return '・' + n + '（' + fmt(m[n].at) + (m[n].h === 'incomplete' ? '・地図が一部欠け' : '') + '）'; }).join('\n'),
    ui.ButtonSet.OK);
}
