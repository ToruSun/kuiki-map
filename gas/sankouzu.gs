/* =========================================================
   区域マップ：市町村の「固定資産（土地）地番参考図」の線を、ログインした人だけに渡す

   ・法務省の登記所備付地図（chiban/、公開ページ）に線が無い所を、市町村の地番参考図でおぎなう。
     使う前に、市町村の利用規約を確かめ、必要なら了解を取る。会衆の人だけが見る。
   ・地番：線を渡すとき（action 'tks'）は抜く。区域係が住所の位置を引くとき（action 'tks_find'）だけ、サーバーの中で使い、
     返すのは位置（土地の真ん中の点）だけ（地番の一覧や土地の形は返さない）
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
    const j = JSON.parse(text);
    (j.p || []).forEach(function (e) { if (Array.isArray(e)) e[0] = ''; }); // 地番は渡さない
    return { ok: true, j: j };
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

/* =========================================================
   住所 → 位置（区域係だけ・集合住宅の一覧から）。法務省の地図（chiban/）に無い土地を、地番参考図で引く
   req.qs: [{ town: 字, nums: ['779','1'], city: 市町村 }]（200件まで）→ r: [{ lat, lng, exact } | null]（同じ順）
   ・地番がそのままある → exact。無ければ本番（779）→ その土地の位置（exact: false）。「779番地」だけなら 779-○ の1つ
   ・地番の一覧や土地の形は返さない
   ========================================================= */
const SAN_FIND_MAX = 200;
function sanFind_(user, req) {
  if (!user || user.role !== 'admin') return { ok: false, error: 'admin' };
  const qs = Array.isArray(req.qs) ? req.qs.slice(0, SAN_FIND_MAX) : [];
  const st = sanReady_();
  if (!st || !st.idx || !st.idx.azas) return { ok: true, r: qs.map(function () { return null; }), none: true };
  const maps = {};
  const mapOf = function (f) {
    if (maps[f] !== undefined) return maps[f];
    let m = null;
    try {
      const j = JSON.parse(DriveApp.getFileById(st.ids[f]).getBlob().getDataAsString('UTF-8'));
      m = {};
      (j.p || []).forEach(function (e) { if (Array.isArray(e) && e[0]) (m[e[0]] || (m[e[0]] = [])).push([e[1] / 1e6, e[2] / 1e6]); });
    } catch (e) { console.warn('地番参考図の字のファイルが読めません', f, e); m = null; }
    return (maps[f] = m);
  };
  const r = qs.map(function (q) {
    if (!q) return null;
    const town = sbNorm_(q.town), nums = (Array.isArray(q.nums) ? q.nums : []).map(function (x) { return String(x).replace(/^0+(\d)/, '$1'); }).filter(function (x) { return /^\d{1,5}$/.test(x); }).slice(0, 2);
    if (!town || !nums.length) return null;
    const a = st.idx.azas[town] || st.idx.azas[String(q.city || '') + ' ' + town];
    if (!a || !st.ids[a.f]) return null;
    const m = mapOf(a.f);
    if (!m) return null;
    let ps = m[nums.join('-')], exact = true;
    if (!ps && nums.length >= 2) { ps = m[nums[0]]; exact = false; } // 地図のあとに分かれた土地：もとの地番
    if (!ps && nums.length === 1) { // 「779番地」だけ：779-○ の1つ
      const k = Object.keys(m).filter(function (x) { return x.indexOf(nums[0] + '-') === 0; }).sort()[0];
      if (k) { ps = m[k]; exact = false; }
    }
    if (!ps || !ps.length) return null;
    return { lat: Math.round(ps[0][0] * 1e6) / 1e6, lng: Math.round(ps[0][1] * 1e6) / 1e6, exact: exact };
  });
  return { ok: true, r: r };
}
