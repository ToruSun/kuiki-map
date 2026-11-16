/* =========================================================
   区域マップ：藤沢市の「固定資産（土地）地番参考図」の線を、ログインした人だけに渡す（2026-11-16）

   ・法務省の登記所備付地図（chiban/、公開ページ）に線が無い所（長後など）を、市の地番参考図でおぎなう。
     藤沢市の了解（電話・2026-11-16）：区域マップに線を重ねて、会衆の人だけが見る。地番は出さない
   ・データは公開ページ・GitHub には置かない。持ち主のドライブ（共有なし）の kuiki-sankouzu.json.gz
     （{ index: {asof, src, b, azas: {字: {f, b, n}}}, files: {f: {p: [...]}} }。線の形だけ・地番なし）
   ・はじめての問い合わせのときに、字ごとのファイルに分けて同じフォルダに置き、次からはそれを読む
   ・受付：action 'tks'。f なし → 字の一覧（index）、f あり → その字の線（{p}）
   ========================================================= */
const SAN_FILE = 'kuiki-sankouzu.json.gz';
const SAN_PROP = 'SAN_SPLIT';      // 分けたファイルの控え {src: 元のファイルID＋更新日時, idx: index, ids: {f: ファイルID}}

function sanApi_(user, req) {
  const st = sanReady_();
  if (!st) return { ok: false, error: 'none' };     // データがない会衆（配布パックなど）は、静かに何も出さない
  if (!req.f) return { ok: true, idx: st.idx };
  const f = String(req.f);
  if (!/^s\d{2,3}$/.test(f) || !st.ids[f]) return { ok: false, error: 'bad_request' };
  try {
    const text = DriveApp.getFileById(st.ids[f]).getBlob().getDataAsString('UTF-8');
    return { ok: true, j: JSON.parse(text) };
  } catch (e) {
    console.warn('地番参考図の字のファイルが読めません', f, e);
    props_().deleteProperty(SAN_PROP); // 次の問い合わせで分け直す
    return { ok: false, error: 'retry' };
  }
}

/** 元のファイル（.json.gz）を見つけ、字ごとに分けたファイルを用意する（済んでいれば控えを返す） */
function sanReady_() {
  const it = DriveApp.getFilesByName(SAN_FILE);
  let src = null;
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (!src || f.getLastUpdated() > src.getLastUpdated()) src = f;
  }
  if (!src) return null;
  const tag = src.getId() + '@' + src.getLastUpdated().getTime();
  const saved = parseJson_(props_().getProperty(SAN_PROP), null);
  if (saved && saved.src === tag && saved.idx && saved.ids) return saved;

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const again = parseJson_(props_().getProperty(SAN_PROP), null);
    if (again && again.src === tag && again.idx && again.ids) return again;
    const blob = src.getBlob().setContentType('application/x-gzip');
    const all = JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
    const folder = src.getParents().hasNext() ? src.getParents().next() : DriveApp.getRootFolder();
    // 前に分けたファイルは消す（ゴミ箱へ）
    if (again && again.ids) Object.keys(again.ids).forEach(function (f) { try { DriveApp.getFileById(again.ids[f]).setTrashed(true); } catch (e) { /* もう無い */ } });
    const ids = {};
    Object.keys(all.files || {}).forEach(function (f) {
      if (!/^s\d{2,3}$/.test(f)) return;
      const file = folder.createFile('kuiki-sankouzu-' + f + '.json', JSON.stringify(all.files[f]), 'application/json');
      ids[f] = file.getId();
    });
    const out = { src: tag, idx: all.index, ids: ids };
    props_().setProperty(SAN_PROP, JSON.stringify(out));
    return out;
  } finally { lock.releaseLock(); }
}

/* ---------- 毎年の入れかえ：市の zip を、Claude に渡せる大きさ（8MB）に分ける（メニュー） ----------
   ・区域係が、市のホームページからダウンロードした zip（r9_chibansankozu.zip など）を、
     このフォルダ（kuiki-sankouzu.json.gz と同じ所）に入れてから押す
   ・Claude はドライブから1回に約10MBまでしか受け取れないため、「<zip>.partNN」に分けて、同じフォルダの kuiki-sankouzu-parts に置く
   ・Claude がつなぎ直して変換し、新しい kuiki-sankouzu.json.gz を置く（サーバーは新しいほうを自動で使う） */
const SAN_PART = 8 * 1024 * 1024;
function sanSplitZipMenu() {
  const ui = SpreadsheetApp.getUi();
  const it = DriveApp.getFilesByName(SAN_FILE);
  const base = it.hasNext() ? it.next() : null;
  if (!base) { ui.alert('「区域マップ_地番参考図」のフォルダが見つかりません（' + SAN_FILE + ' があるフォルダに zip を入れます）。'); return; }
  const folder = base.getParents().next();
  let zip = null;
  const zs = folder.getFiles();
  while (zs.hasNext()) {
    const f = zs.next();
    if (f.isTrashed() || !/\.zip$/i.test(f.getName())) continue;
    if (!zip || f.getLastUpdated() > zip.getLastUpdated()) zip = f;
  }
  if (!zip) { ui.alert('フォルダ「' + folder.getName() + '」に zip がありません。市のホームページからダウンロードした zip を、展開せずに入れてください。'); return; }
  const size = zip.getSize(), n = Math.ceil(size / SAN_PART);
  if (ui.alert('zip を分けます', zip.getName() + '（' + Math.round(size / 1048576) + 'MB）を ' + n + ' つに分けます。よろしいですか？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  // 前に分けたものは、ゴミ箱へ
  const ps = folder.getFoldersByName('kuiki-sankouzu-parts');
  const parts = ps.hasNext() ? ps.next() : folder.createFolder('kuiki-sankouzu-parts');
  const old = parts.getFiles();
  while (old.hasNext()) old.next().setTrashed(true);
  for (let k = 0; k < n; k++) {
    const a = k * SAN_PART, b = Math.min(size, a + SAN_PART) - 1;
    const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(zip.getId()) + '?alt=media', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + a + '-' + b }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 206 && !(res.getResponseCode() === 200 && n === 1)) { ui.alert('読めませんでした（番号 ' + res.getResponseCode() + '）。もう一度押してください。'); return; }
    const nm = zip.getName() + '.part' + ('0' + (k + 1)).slice(-2) + '-of-' + ('0' + n).slice(-2);
    parts.createFile(Utilities.newBlob(res.getContent(), 'application/octet-stream', nm));
  }
  ui.alert('分けました', zip.getName() + ' を ' + n + ' つに分けて、「kuiki-sankouzu-parts」に置きました。\n\nClaude に「地番参考図の zip を入れた」と伝えてください。', ui.ButtonSet.OK);
}
