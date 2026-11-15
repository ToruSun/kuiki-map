/* =========================================================
   自動バックアップ（Apps Script に新しいファイル「backup.gs」を作って、これを貼り付けてください）

   ・毎週日曜の夜中（2時ごろ）に、このスプレッドシートを丸ごとコピーして、
     Googleドライブの「区域マップ_バックアップ」フォルダに入れます
   ・新しいほうから10個だけ残し、古いものはゴミ箱に入れます（ゴミ箱に入れたものは30日で消えます）
   ・失敗したときは、このスプレッドシートの持ち主にメールで知らせます
   ・使いはじめ：メニュー「区域マップ」→「自動バックアップを始める（毎週）」を1回押すだけ

   【バックアップから戻すとき】
   ・メニュー「区域マップ」→「バックアップから戻す」で、戻したいバックアップのURLを入れます
   ・戻すのは区域・家・訪問記録などのデータだけです。使う人（users）と登録したスマホ（devices）は、
     今のまま残します（戻したあとも、みんなのスマホはそのまま使えます）
   ・再訪問の受け持ち（follows・released）も、今のまま残します（戻した家に無いものだけ外します）。
     受け持ちを古くすると、各自の再訪問メモが、サーバーからもスマホからも10分後に消えてしまうためです
   ・拒否（dnc）は、バックアップと今の両方を残します（バックアップより後に受けた拒否を失わないため）
   ・戻す前に、念のため今の状態も自動でバックアップします
   ・戻したあと、みんなのスマホは次に開いたとき、一度だけ全部を読み直します
   ・記録が多くて時間内に終わらないときは、途中で安全に止まります。もう一度同じURLで戻すと、最後まで戻ります

   【注意】バックアップには、使う人の名前や招待コード、訪問の記録も入っています。
          バックアップのフォルダは、ほかの人と共有しないでください。
   ========================================================= */
const BACKUP_FOLDER_NAME = '区域マップ_バックアップ';
const BACKUP_PREFIX = '区域マップ_バックアップ_';
const BACKUP_KEEP = 10;   // 残すバックアップの数
// 戻すときに書き戻すシート（小さいものから。いちばん大きい訪問記録は最後）。
// 使う人・スマホの登録・変更の記録・再訪問の受け持ちとメモは戻さない。拒否（dnc）は、まぜて戻す
const RESTORE_SHEETS = ['settings', 'territories', 'requests', 'awayCards', 'returns', 'schedules', 's13', 'agedata',
  'houses', 'dnc', 'caution', 'visits'];
const RESTORE_TIME_MS = 5 * 60000; // メニューから動かす処理は6分で止められるので、その前に自分で止める
const RESTORE_BATCH = 5000;        // 1回に書く行の数

function backupFolder_() {
  const p = props_(), id = p.getProperty('BACKUP_FOLDER');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* 作り直す */ }
  }
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER_NAME);
  p.setProperty('BACKUP_FOLDER', f.getId());
  return f;
}
function stamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd_HHmm');
}

/** バックアップを1つ作る。note は名前の後ろにつける言葉（「復元の前」など） */
function makeBackup_(note) {
  const folder = backupFolder_();
  const name = BACKUP_PREFIX + stamp_() + (note ? '_' + note : '');
  // 保存が進んでいる最中にコピーしないよう、少しだけ待つ（夜中なので、ほとんど待たない）
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(60000);
  let file;
  try {
    file = DriveApp.getFileById(book_().getId()).makeCopy(name, folder);
  } finally { if (locked) lock.releaseLock(); }
  // 古いものをゴミ箱へ（新しいほうから BACKUP_KEEP 個を残す）
  const list = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(BACKUP_PREFIX) === 0) list.push(f);
  }
  list.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  list.slice(BACKUP_KEEP).forEach(function (f) { try { f.setTrashed(true); } catch (e) { console.warn(e); } });
  props_().setProperties({ BACKUP_LAST: new Date().toISOString(), BACKUP_LAST_NAME: name, BACKUP_ERR: '' });
  return file;
}

/** 自動で動く（毎週） */
function backupRun() {
  try {
    makeBackup_('');
  } catch (e) {
    const msg = (e && e.message) || String(e);
    props_().setProperty('BACKUP_ERR', new Date().toISOString() + ' ' + msg.slice(0, 300));
    try {
      const to = Session.getEffectiveUser().getEmail();
      if (to) MailApp.sendEmail(to, '【区域マップ】自動バックアップができませんでした',
        '区域マップのスプレッドシートの自動バックアップが、うまくいきませんでした。\n\n理由：' + msg +
        '\n\nスプレッドシートのメニュー「区域マップ」→「今すぐバックアップ」をためしてください。\n' + book_().getUrl());
    } catch (e2) { console.warn(e2); }
    throw e;
  }
}

/* ---------- メニュー ---------- */
function backupInstallMenu() {
  const ui = SpreadsheetApp.getUi();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'backupRun') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('backupRun').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  let first = '';
  try { makeBackup_('はじめ'); first = '\n\n今の状態も、1つ目のバックアップとして保存しました。'; }
  catch (e) { first = '\n\n（1つ目のバックアップは作れませんでした：' + ((e && e.message) || e) + '）'; }
  ui.alert('自動バックアップを始めました',
    '毎週日曜の夜中2時ごろに、このスプレッドシートを丸ごとコピーします。\n' +
    'ドライブの「' + BACKUP_FOLDER_NAME + '」フォルダに、新しいほうから' + BACKUP_KEEP + '個を残します。' + first +
    '\n\nこのフォルダは、ほかの人と共有しないでください（名前や招待コード、訪問の記録が入っています）。', ui.ButtonSet.OK);
}

function backupNowMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    const f = makeBackup_('手動');
    ui.alert('バックアップしました', f.getName() + '\n\nドライブの「' + BACKUP_FOLDER_NAME + '」フォルダに入れました。', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('バックアップできませんでした：' + ((e && e.message) || e));
  }
}

function backupStatusMenu() {
  const ui = SpreadsheetApp.getUi(), p = props_();
  const on = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'backupRun'; });
  const last = p.getProperty('BACKUP_LAST'), err = p.getProperty('BACKUP_ERR');
  let url = '';
  try { url = backupFolder_().getUrl(); } catch (e) { /* 何もしない */ }
  ui.alert('バックアップの状態',
    '自動バックアップ：' + (on ? '動いています（毎週日曜の夜中）' : '止まっています（「自動バックアップを始める」を押してください）') +
    '\nさいごのバックアップ：' + (last ? new Date(last).toLocaleString() + '\n　' + (p.getProperty('BACKUP_LAST_NAME') || '') : 'まだありません') +
    (err ? '\n\nさいごの失敗：' + err : '') +
    (url ? '\n\nフォルダ：' + url : ''), ui.ButtonSet.OK);
}

/* ---------- 戻すための部品 ---------- */
/** 時間切れで止めるときの印 */
function restoreTimeUp_(t0, where) {
  if (Date.now() - t0 > RESTORE_TIME_MS) throw Object.assign(new Error('timeup'), { timeup: true, where: where });
}
/** シートの中身（2行目から）を rows で置きかえる。rows：[[id, data, 更新日時, 更新した人], ...] */
function restoreWrite_(name, rows, t0) {
  const d = dataSheet_(name);
  const last = d.getLastRow();
  // 先に新しい内容を書き、最後に余った行だけを空にする（先に空にすると、途中で止まったとき記録が消えてしまう）
  for (let i = 0; i < rows.length; i += RESTORE_BATCH) {
    restoreTimeUp_(t0, name);
    const part = rows.slice(i, i + RESTORE_BATCH);
    if (d.getMaxRows() < 2 + i + part.length) d.insertRowsAfter(d.getMaxRows(), 2 + i + part.length - d.getMaxRows());
    d.getRange(2 + i, 1, part.length, 4).setValues(part);
  }
  if (last > rows.length + 1) d.getRange(rows.length + 2, 1, last - rows.length - 1, Math.max(4, d.getLastColumn())).clearContent();
}
/** 途中で止まった復元の続き：同じバックアップなら、戻し終えたシートを飛ばす */
function restoreProgress_(srcId) {
  try {
    const p = JSON.parse(props_().getProperty('RESTORE_PROGRESS') || 'null');
    if (p && p.src === srcId && Date.now() - p.at < 3 * DAY_MS && Array.isArray(p.done)) return p;
  } catch (e) { /* 読めなければ、はじめから */ }
  return { src: srcId, at: Date.now(), done: [] };
}
function restoreSaveProgress_(p) { p.at = Date.now(); props_().setProperty('RESTORE_PROGRESS', JSON.stringify(p)); }
/** バックアップのシートの行（見出しを除く・id のある行だけ） */
function restoreRows_(src, name) {
  const s = src.getSheetByName(name);
  if (!s || s.getLastRow() < 2) return s ? [] : null;
  return s.getRange(2, 1, s.getLastRow() - 1, 4).getValues()
    .filter(function (r) { return r[0] !== '' && r[1] !== ''; })
    .map(function (r) { return [r[0], r[1], r[2], r[3]]; });
}
/** 家のid（「家id|部屋」の、家idの部分） */
function restoreHid_(key) { return String(key).split('|')[0]; }

/** バックアップから戻す */
function restoreMenu() {
  const t0 = Date.now();
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('バックアップから戻す',
    '戻したいバックアップのスプレッドシートを開いて、そのURL（アドレス）をここに貼り付けてください。\n' +
    '区域・家・訪問記録・予定・設定などが、そのときの状態にもどります。\n' +
    '使う人とスマホの登録、再訪問の受け持ちは、今のまま残します。拒否は、今の分も残します。', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const m = r1.getResponseText().match(/[-\w]{25,}/);
  if (!m) { ui.alert('URLが読み取れませんでした。バックアップのスプレッドシートのURLを貼り付けてください。'); return; }
  let src;
  try { src = SpreadsheetApp.openById(m[0]); } catch (e) { ui.alert('そのスプレッドシートを開けませんでした。'); return; }
  if (src.getId() === book_().getId()) { ui.alert('今のスプレッドシートそのものです。バックアップのURLを入れてください。'); return; }
  if (!src.getSheetByName('territories') || !src.getSheetByName('houses')) { ui.alert('区域マップのバックアップではないようです。'); return; }
  const r2 = ui.prompt('本当に戻しますか',
    '「' + src.getName() + '」の状態に戻します。\nそれより後につけた訪問記録などは、なくなります。\n\n戻してよければ「復元」と入力してください。',
    ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK || r2.getResponseText().trim() !== '復元') return;

  const prog = restoreProgress_(src.getId());
  if (!prog.done.length) {
    try { makeBackup_('復元の前'); }
    catch (e) { ui.alert('念のためのバックアップが作れなかったので、戻すのをやめました：' + ((e && e.message) || e)); return; }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  const done = [];
  let started = false, stopped = null;
  try {
    let houseIds = null; // 戻した家のid（受け持ち・拒否が、戻した家にあるかを確かめる）
    RESTORE_SHEETS.forEach(function (name) {
      restoreTimeUp_(t0, name);
      let rows = restoreRows_(src, name);
      if (rows === null) return; // バックアップにそのシートが無い
      if (name === 'houses') {
        houseIds = {};
        rows.forEach(function (r) { houseIds[String(r[0])] = true; });
      }
      if (name === 'dnc') {
        // 拒否：バックアップの分に、今の分（戻した家にあるもの）を足す
        const have = {};
        rows.forEach(function (r) { have[String(r[0])] = true; });
        readCol_('dnc').forEach(function (x, id) {
          if (have[id] || (houseIds && String(id).indexOf('|') > 0 && !houseIds[restoreHid_(id)])) return; // 場所だけの拒否（pin:…）は家に関係なく残す
          rows.push([id, JSON.stringify(x.data), x.at || new Date(), x.by || '']);
        });
      }
      if (prog.done.indexOf(name) >= 0) { done.push(name + '（前回までに戻し済み）'); return; }
      started = true; // ここから先で止まったら、みんなのスマホに読み直してもらう
      restoreWrite_(name, rows, t0);
      prog.done.push(name); restoreSaveProgress_(prog);
      done.push(name + '（' + rows.length + '行）');
    });
    // 再訪問の受け持ちは今のまま。ただし、戻した家に無い家の分は外す
    if (houseIds) {
      ['follows', 'released'].forEach(function (name) {
        restoreTimeUp_(t0, name);
        const map = readCol_(name), drop = [];
        map.forEach(function (x, id) { if (!houseIds[restoreHid_(id)]) drop.push(id); });
        if (!drop.length) return;
        started = true;
        drop.forEach(function (id) { map.delete(id); });
        rewriteCol_(name, map);
        const sh = dataSheet_(name), last = sh.getLastRow(), keep = map.size + 1;
        if (last > keep) sh.getRange(keep + 1, 1, last - keep, 4).clearContent(); // 書き直して余った行を空にする
        done.push(name + '：戻した家に無い ' + drop.length + '件を外しました');
      });
    }
  } catch (e) {
    if (!e.timeup) throw e;
    stopped = e.where;
  } finally {
    if (!stopped) { try { props_().deleteProperty('RESTORE_PROGRESS'); } catch (e2) { /* 何もしない */ } }
    try { CacheService.getScriptCache().removeAll(['settings_v1', 'users_v1', 'devices_v1', 'devices_v2_n']); } catch (e) { /* 何もしない */ }
    // 書きかえを始めていたら、途中で止まったときも、みんなのスマホに今のサーバーの内容を読み直してもらう
    if (started) resetJournal_();
    lock.releaseLock();
  }
  if (stopped) {
    ui.alert('途中で止めました',
      '時間が足りなかったため、「' + stopped + '」のところで止めました。\n' +
      'ここまでに戻したシート：\n' + (done.join('\n') || '（なし）') +
      '\n\nもう一度「バックアップから戻す」で、同じバックアップのURLを入れてください。最後まで戻ります。', ui.ButtonSet.OK);
    return;
  }
  ui.alert('戻しました', '戻したシート：\n' + done.join('\n') +
    '\n\nみんなのスマホは、次に開いたとき（開いていれば数十秒以内に）新しい状態を読み直します。', ui.ButtonSet.OK);
}
