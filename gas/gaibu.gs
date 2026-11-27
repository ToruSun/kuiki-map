/* =========================================================
   gaibu.gs  外の一覧からの取り込みの口

   会衆が別に使っている一覧（アパート・オートロックの訪問の記録など）を、移行のあいだ、何度でもアプリに入れるための口。
   一覧の形は会衆ごとにちがうので、本体は形を知らない。会衆の外のプログラム（区域係が用意する Apps Script）が一覧を読み、
   決まった形（建物・部屋・訪問の日付）にして送る。

   ・送るときは「取り込みの鍵」を使う（区域係の画面で作る。サーバーには照合値だけを置く）。鍵でできるのは、この取り込みだけ
   ・送られた建物とアプリの家の結びつきは、区域係が画面で決める（gb_list・gb_link）。結びついた建物の記録だけを入れる
   ・入れる記録：記録した人は「取り込み」（by: 'imp'）、印 src: 'imp'。id は 元・建物・部屋・日 から決まる（何回送っても同じ id）
     送られるたびに、その建物の取り込みの記録を、送られた内容に合わせる（足す・直す・消す）。アプリで入れた記録には手をふれない
     結んでいない建物（外した・取り込まない）の、前に入れた記録は消す。結び直せば、また入る
     同じ家・同じ部屋・同じ日（日本時間）に、アプリで入れた記録があれば、取り込みの分は入れない（二重にしない）
   ・部屋：アパートにない部屋を足す（部屋は消さない）。「1階」などの階の枠しかないアパートは、記録のない枠を部屋番号に置きかえる
     結びつけた家がアパートでなければ、アパートにする（仮の家の印は外す）
   ・オートロック：送られた建物が lock なら、アパートに印をつける（外さない）
   ・家の名前：一覧の名前を付けるのは、確定した結びつき・新しく置いたとき・係が選んで結んだとき。そのとき家に gbn（一覧から付けた名前）を残す。
     画面は「名前が同じ」を比べるとき、一覧から付けた名前（gb_list の named）は数えない（自分で付けた名前で自分に合うのを防ぐ）
   ・データ：シート「gaibu」（id＝元~建物。同期の記録 journal には乗せない。係の画面だけが gb_list で読む）
       { src, k, label, name, addr, lat, lng, lock, n: 部屋数, rooms: 部屋番号, nv: 記録数, hid: 家id, tmp: 仮で結んだ, skip, gone, at: 最後に届いた日時, res: 最後の結果,
         laddr: 一覧のリンクに入っていた住所（位置が入っていないリンクのとき。画面が住所で位置を調べるのに使う）,
         fix: { lat, lng, from: 'chiban'（地番の地図）|'addr'（住所で番地まで合った）|'hand'（係が地図で置いた・数字で入れた） },
         ed: { name, addr }（係が直した名前・住所。取り込みでは変えない。gb_edit）,
         same: ほかの行の id（地図にまだ無い建物どうしを「同じ建物」とまとめた。画面は same の行を、相手と一緒に結ぶ。gb_same） }
       lat・lng は一覧から届いた位置（取り込みのたびに入れかわる）。fix は画面で直した位置で、取り込みでは変えない（gb_pos）

   送る形（action: 'gb_sync'。token の代わりに key）：
     { key, src: '元（英数字12字まで）', label: '一覧の名前', dry: true で確かめだけ,
       blds: [{ k: '建物（英数字・._- 40字まで）', name, addr, laddr: '一覧のリンクに入っていた住所', lat, lng, lock,
                rooms: [{ r: '101', v: [['2024-05-01', 'm' または 'a'], …] }] }] }
   返事：{ ok, n: { blds, linked, wait, skip, add, upd, del, same, dup, rej }, blds: [{ k, st, add, upd, del, dup }] }
     st：linked（入れた）・new（まだ結びついていない）・skip（取り込まない）・nohouse（結んだ家がもうない）
   ========================================================= */
const GB_SHEET = 'gaibu';
const GB_USER = 'imp';                 // 取り込みの記録の「記録した人」（名簿にはいない。画面は「取り込み」と出す）
const GB_SRC = 'imp';                  // 取り込みの記録の印
const GB_KEY_PROP = 'GB_KEY_HASH', GB_KEY_AT = 'GB_KEY_AT';
const GB_SRC_RE = /^[A-Za-z0-9_\-]{1,12}$/;
const GB_K_RE = /^[\w.\-]{1,40}$/;
const GB_MAX_BLD = 200, GB_MAX_ROOMS = 300, GB_MAX_VIS = 60;
const GB_FRAME_RE = /^(\d{1,2}階|\?|？)$/;   // 階の枠（apt-import.js が作る）
const GB_TE = 'te';                    // 区域係が手で登録した集合住宅の元（取り込みでは送れない。一覧にない にならない）

function gbH_(s, n) { return hash_(s).replace(/[^A-Za-z0-9]/g, '').slice(0, n); }
function gbPre_(src, k) { return 'imp.' + src + '.' + gbH_('k|' + k, 6) + '.'; }
function gbVid_(src, k, r, d) { return gbPre_(src, k) + gbH_(r + '|' + d, 10); }
function gbDay_(iso) { const t = Date.parse(iso); return isFinite(t) ? Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy-MM-dd') : ''; }

/* ---------- 鍵 ---------- */
function gbKeyOk_(key) {
  const h = props_().getProperty(GB_KEY_PROP);
  if (!h || typeof key !== 'string' || key.length < 20 || key.length > 100) return false;
  return hash_('gb|' + key) === h;
}

/* ---------- シート ---------- */
function gbRead_() { return readCol_(GB_SHEET); } // id / data / 更新日時 / 更新した人（journal には書かない）
function gbWrite_(map, ups, uid) {
  if (!ups.length) return;
  const sh = dataSheet_(GB_SHEET), now = new Date(), appends = [];
  ups.forEach(function (p) {
    const row = [p[0], JSON.stringify(p[1]), now, uid];
    const cur = map.get(p[0]);
    if (cur && cur.row > 0) sh.getRange(cur.row, 1, 1, 4).setValues([row]);
    else appends.push(row);
    map.set(p[0], { row: cur ? cur.row : -1, data: p[1], at: now, by: uid });
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, 4).setValues(appends);
}

/* ---------- 受け取った建物をそろえる ---------- */
function gbNum_(v) { const n = Number(v); return v !== null && v !== '' && isFinite(n) ? Math.round(n * 1e6) / 1e6 : null; }
function gbClean_(b) {
  if (!b || typeof b !== 'object' || !GB_K_RE.test(String(b.k || ''))) return null;
  const lat = gbNum_(b.lat), lng = gbNum_(b.lng);
  const pos = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const maxT = Date.now() + DAY_MS, seenR = {};
  const rooms = [];
  (Array.isArray(b.rooms) ? b.rooms : []).slice(0, GB_MAX_ROOMS).forEach(function (x) {
    const r = str_(x && x.r, 12).trim();
    if (!r || UNIT_BAD_RE.test(r) || seenR[r]) return;
    seenR[r] = true;
    const byDay = {};
    (Array.isArray(x.v) ? x.v : []).slice(0, GB_MAX_VIS).forEach(function (p) {
      if (!Array.isArray(p)) return;
      const d = String(p[0] || ''), res = p[1] === 'm' ? 'm' : p[1] === 'a' ? 'a' : '';
      if (!res || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      const t = Date.parse(d + 'T03:00:00Z');
      if (!isFinite(t) || t < Date.UTC(2000, 0, 1) || t > maxT || gbDay_(new Date(t).toISOString()) !== d) return;
      if (!byDay[d] || res === 'm') byDay[d] = res; // 同じ日は「会えた」を先に
    });
    rooms.push({ r: r, v: Object.keys(byDay).sort().map(function (d) { return [d, byDay[d]]; }) });
  });
  return {
    k: String(b.k), name: str_(b.name, 40).replace(/[<>"'&]/g, ''), addr: str_(b.addr, 80).replace(/[<>"'&]/g, ''),
    laddr: str_(b.laddr, 120).replace(/[<>"'&]/g, ''),
    lat: pos ? lat : null, lng: pos ? lng : null, lock: b.lock === true, rooms: rooms
  };
}

/* 部屋の並び：数字の部屋は数の順 */
function gbRoomCmp_(a, b) {
  const x = /^\d+$/.test(a) ? Number(a) : NaN, y = /^\d+$/.test(b) ? Number(b) : NaN;
  if (isFinite(x) && isFinite(y)) return x - y;
  if (isFinite(x)) return -1;
  if (isFinite(y)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
/* アパートの部屋に、送られた部屋を足す。階の枠だけのときは、記録のない枠を部屋番号に置きかえる */
function gbUnits_(cur, rooms, recUnits) {
  cur = (cur || []).map(String);
  const want = rooms.slice().sort(gbRoomCmp_);
  if (!want.length) return cur;
  const onlyFrames = cur.length > 0 && cur.every(function (u) { return GB_FRAME_RE.test(u); });
  const base = onlyFrames ? cur.filter(function (u) { return recUnits[u]; }) : cur;
  const have = {};
  base.forEach(function (u) { have[u] = true; });
  const out = base.concat(want.filter(function (u) { return !have[u]; }));
  const seen = {};
  return out.filter(function (u) { if (seen[u]) return false; seen[u] = true; return true; }).slice(0, 300);
}

/* ---------- 受け付け：外のプログラムから ---------- */
function gbSync_(req) {
  if (!gbKeyOk_(req.key)) return { ok: false, error: 'auth' };
  const src = String(req.src || '');
  if (!GB_SRC_RE.test(src) || src === GB_TE || !Array.isArray(req.blds)) return { ok: false, error: 'bad_request' };
  if (req.blds.length > GB_MAX_BLD) return { ok: false, error: 'too_many' };
  const label = str_(req.label, 40).replace(/[<>"'&]/g, '');
  const dry = req.dry === true;
  const blds = [], seenK = {};
  req.blds.forEach(function (b) { const c = gbClean_(b); if (c && !seenK[c.k]) { seenK[c.k] = true; blds.push(c); } });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
  try { return gbSyncCore_(src, label, blds, dry); } finally { lock.releaseLock(); }
}

function gbSyncCore_(src, label, blds, dry) {
  const gm = gbRead_();
  const nowIso = nowIso_();
  const ctx = { cols: {}, hcache: new Map() };
  // 結びついた家
  const linked = []; // { b, row, hid, hd }
  const out = [];
  blds.forEach(function (b) {
    const id = src + '~' + b.k, cur = gm.get(id), d = cur && cur.data ? cur.data : {};
    const o = { k: b.k, st: 'new', add: 0, upd: 0, del: 0, dup: 0 };
    if (d.skip) o.st = 'skip';
    else if (d.hid) {
      const hd = houseData_(ctx, d.hid);
      if (!hd) o.st = 'nohouse';
      else { o.st = 'linked'; linked.push({ b: b, hid: String(d.hid), hd: hd, o: o, ename: d.ed && d.ed.name ? d.ed.name : '', tmp: !!d.tmp }); }
    }
    out.push(o);
  });
  // 結んでいない（外した・取り込まない）建物の、前に入れた記録は消す（記録は、結んだ家にだけ入る）
  const skipKs = {};
  out.forEach(function (o) { if (o.st === 'skip' || o.st === 'new') skipKs[gbPre_(src, o.k)] = o; });

  // 訪問記録を1回だけ読む：この元の取り込みの記録と、結びついた家のアプリの記録（二重にしないため）
  const hids = {};
  linked.forEach(function (x) { hids[x.hid] = true; });
  const pre = 'imp.' + src + '.';
  const mine = {};       // id → { data }（この元の取り込みの記録）
  const appDay = {};     // 家|部屋|日 → true（アプリで入れた記録）
  const recUnits = {};   // 家 → { 部屋: true }（記録のある部屋）
  const vsh = dataSheet_('visits'), vn = vsh.getLastRow();
  if (vn >= 2) {
    vsh.getRange(2, 1, vn - 1, 2).getValues().forEach(function (r) {
      const id = String(r[0]), s = String(r[1]);
      const isMine = id.indexOf(pre) === 0;
      const m = s.match(/"houseId":"([^"]+)"/);
      const hid = m ? m[1] : '';
      if (!isMine && !hids[hid]) return;
      const v = parseJson_(s, null);
      if (!v) return;
      if (isMine) { mine[id] = v; return; }
      if (String(v.houseId) !== hid) return;
      const u = String(v.unit || '');
      (recUnits[hid] || (recUnits[hid] = {}))[u] = true;
      if (String(v.src || '') !== GB_SRC) appDay[hid + '|' + u + '|' + gbDay_(v.at)] = true;
    });
  }

  const vups = [], vdels = [], hups = [];
  let same = 0;
  linked.forEach(function (x) {
    const b = x.b, hid = x.hid, hd = x.hd, o = x.o, bp = gbPre_(src, b.k);
    const want = {};
    b.rooms.forEach(function (rm) {
      rm.v.forEach(function (p) {
        if (appDay[hid + '|' + rm.r + '|' + p[0]]) { o.dup++; return; }
        const id = gbVid_(src, b.k, rm.r, p[0]);
        want[id] = { id: id, houseId: hid, unit: rm.r, result: p[1] === 'm' ? 'met' : 'away', at: p[0] + 'T03:00:00.000Z', by: GB_USER, src: GB_SRC };
      });
    });
    Object.keys(want).forEach(function (id) {
      const w = want[id], c = mine[id];
      if (hd.terrId) w.t = String(hd.terrId);
      if (!c) { o.add++; vups.push(w); return; }
      if (String(c.houseId) === w.houseId && String(c.unit || '') === w.unit && c.result === w.result && c.at === w.at && String(c.t || '') === String(w.t || '') && !c.oc) { same++; return; }
      o.upd++; vups.push(w);
    });
    Object.keys(mine).forEach(function (id) { if (id.indexOf(bp) === 0 && !want[id]) { o.del++; vdels.push(id); } });
    // 家：部屋・オートロック・アパートにする
    const units = gbUnits_(hd.units, b.rooms.map(function (rm) { return rm.r; }), recUnits[hid] || {});
    const nh = Object.assign({}, hd, { type: 'apt', units: units });
    if (b.lock) nh.lock = true;
    delete nh.prov;
    const ename = x.ename || b.name;
    if (!hd.label && ename && !x.tmp) { nh.label = ename; nh.gbn = str_(ename, 40); } // 仮のあいだは、家に名前を付けない
    if (stable_(nh) !== stable_(hd)) hups.push(Object.assign({ id: hid }, nh));
  });
  Object.keys(mine).forEach(function (id) {
    Object.keys(skipKs).forEach(function (p) { if (id.indexOf(p) === 0) { skipKs[p].del++; vdels.push(id); } });
  });

  let rej = 0;
  if (!dry && (vups.length || vdels.length || hups.length)) {
    // 直す記録：サーバーは、少し前に書いた記録を「送り直し」として飛ばすので、その覚えを消してから送る
    const updIds = vups.filter(function (w) { return mine[w.id]; }).map(function (w) { return 'vi_' + w.id; });
    if (updIds.length) { try { CacheService.getScriptCache().removeAll(updIds); } catch (e) { /* 消せなければ次の取り込みで直る */ } }
    const user = { id: GB_USER, role: 'admin', name: '取り込み', active: true };
    const res = applyChanges_(user, { houses: hups.length ? { up: hups } : undefined, visits: { up: vups, del: vdels } }, { re: true, gb: true });
    rej = (res.rejected || []).length;
    if (rej) console.warn('外の一覧の取り込みで、入れられなかったもの：' + rej + '件');
  }

  // 建物の一覧を書く（結びつき・取り込まない は残す）
  if (!dry) {
    const ups = [], here = {};
    blds.forEach(function (b, i) {
      const id = src + '~' + b.k, cur = gm.get(id), d = cur && cur.data ? cur.data : {};
      here[id] = true;
      const nv = b.rooms.reduce(function (a, rm) { return a + rm.v.length; }, 0);
      const o = out[i];
      ups.push([id, {
        src: src, k: b.k, label: label, name: b.name, addr: b.addr, laddr: b.laddr, lat: b.lat, lng: b.lng, lock: b.lock,
        n: b.rooms.length, rooms: b.rooms.map(function (rm) { return rm.r; }), nv: nv, hid: d.hid || '', tmp: !!d.tmp, skip: !!d.skip, at: nowIso, fix: d.fix || null, ed: d.ed || null, same: d.same || '',
        res: { st: o.st, add: o.add, upd: o.upd, del: o.del, dup: o.dup }
      }]);
    });
    gm.forEach(function (x, id) { // 一覧からなくなった建物
      if (id.indexOf(src + '~') === 0 && !here[id] && x.data && !x.data.gone) ups.push([id, Object.assign({}, x.data, { gone: true })]);
    });
    gbWrite_(gm, ups, GB_USER);
    const sp = props_();
    sp.setProperty('GB_SRC_' + src, JSON.stringify({ label: label, at: nowIso, n: blds.length }));
  }

  const n = { blds: blds.length, linked: 0, wait: 0, skip: 0, add: 0, upd: 0, del: 0, same: same, dup: 0, rej: rej };
  out.forEach(function (o) {
    if (o.st === 'linked') n.linked++; else if (o.st === 'skip') n.skip++; else n.wait++;
    n.add += o.add; n.upd += o.upd; n.del += o.del; n.dup += o.dup;
  });
  return { ok: true, dry: dry, n: n, blds: out };
}

/* ---------- 区域係の画面から ---------- */
function gbApi_(user, req) {
  if (user.role !== 'admin') return { ok: false, error: 'admin' };
  const a = req.action;
  if (a === 'gb_list') return gbList_();
  if (a === 'gb_key') {
    const key = newToken_();
    props_().setProperty(GB_KEY_PROP, hash_('gb|' + key));
    props_().setProperty(GB_KEY_AT, nowIso_());
    gbOpsLog_(user, '鍵を作り直した');
    return { ok: true, key: key };
  }
  if (a === 'gb_key_del') {
    props_().deleteProperty(GB_KEY_PROP);
    props_().deleteProperty(GB_KEY_AT);
    gbOpsLog_(user, '鍵を止めた');
    return { ok: true };
  }
  if (a === 'gb_edit') {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
    try { return gbEdit_(user, req.items); } finally { lock.releaseLock(); }
  }
  if (a === 'gb_same') {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
    try { return gbSame_(user, req.items); } finally { lock.releaseLock(); }
  }
  if (a === 'gb_pos') {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
    try { return gbPos_(user, req.items); } finally { lock.releaseLock(); }
  }
  if (a === 'gb_add' || a === 'gb_del') {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
    try { return a === 'gb_add' ? gbAdd_(user, req.item) : gbDel_(user, req.id); } finally { lock.releaseLock(); }
  }
  if (a === 'gb_link') {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
    try { return gbLink_(user, req.items); } finally { lock.releaseLock(); }
  }
  return { ok: false, error: 'unknown_action' };
}

/* 鍵を作った・止めたことを、設定の変更履歴（operations）に1行残す（鍵そのものは残さない） */
function gbOpsLog_(user, what) {
  try {
    const sh = opsSheet_(), first = Math.max(2, sh.getLastRow() + 1);
    if (first > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    sh.getRange(first, 1, 1, 5).setValues([[Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), user.name || user.id, '外の一覧の取り込みの鍵', '', what]]);
  } catch (e) { /* 残せなくても止めない */ }
}

function gbList_() {
  const gm = gbRead_(), sp = props_().getProperties(), blds = [], srcs = [];
  gm.forEach(function (x, id) { if (x.data && typeof x.data === 'object') blds.push(Object.assign({ id: id }, x.data)); });
  return gbListOut_(sp, blds, srcs);
}
/* 一覧から付けた名前の家：gbn（一覧から付けた名前）と今の名前が同じ家。
   gbn を残す前に付いた名前は、外の一覧から作った家（id が hg）・最後に取り込み（imp）が直した家のうち、名前が一覧の建物名と同じもの */
function gbNamed_(blds) {
  const names = {}, out = [];
  const nz = function (t) { return String(t || '').normalize('NFKC').toLowerCase().replace(/[\s・･\-ー―‐－〜~()（）]/g, ''); };
  blds.forEach(function (b) { [b.name, b.ed && b.ed.name].forEach(function (n) { if (n) names[nz(n)] = true; }); });
  const sh = dataSheet_('houses'), n = sh.getLastRow();
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, 4).getValues().forEach(function (r) {
    const id = String(r[0] || ''), s = String(r[1] || '');
    const cand = s.indexOf('"gbn"') >= 0 || id.indexOf('hg') === 0 || String(r[3]) === GB_USER;
    if (!cand) return;
    const h = parseJson_(s, null);
    if (!h || !h.label) return;
    if ((h.gbn && nz(h.gbn) === nz(h.label)) || (!h.gbn && names[nz(h.label)])) out.push(id);
  });
  return out;
}
function gbListOut_(sp, blds, srcs) {
  Object.keys(sp).forEach(function (k) {
    if (k.indexOf('GB_SRC_') !== 0) return;
    const v = parseJson_(sp[k], null);
    if (v) srcs.push(Object.assign({ src: k.slice(7) }, v));
  });
  let named = [];
  try { named = gbNamed_(blds); } catch (e) { console.warn('一覧から付けた名前を確かめられませんでした：' + e); }
  return { ok: true, key: { has: !!sp[GB_KEY_PROP], at: sp[GB_KEY_AT] || '' }, srcs: srcs, blds: blds, named: named };
}

/* items: [{ id: '元~建物', hid: '家id' または '', skip: true|false, make: true（建物の場所に新しいアパートを置く）, terrId, tmp: true（仮で結ぶ。あとで係が確かめる）,
             apply: true（係が選んで結んだ：家の名前・部屋・オートロックを、すぐ一覧の建物に合わせる） }]（まとめて送れる）
   make：家はサーバーで作る（画面で作ると、サーバーに届くまで結べないため）。区域は画面が場所から決めて送る */
function gbLink_(user, items) {
  if (!Array.isArray(items) || !items.length || items.length > 300) return { ok: false, error: 'bad_request' };
  const gm = gbRead_(), ups = [], bad = [], made = [], mk = [], madeIds = {}, prev = {};
  const terrs = readCol_('territories');
  items.forEach(function (it) { const x = gm.get(String(it && it.id || '')); if (x && x.data) prev[String(it.id)] = x.data; });
  items.forEach(function (it) {
    const id = String(it && it.id || ''), cur = gm.get(id);
    if (!cur || !cur.data) { bad.push(id); return; }
    let hid = String(it.hid || '');
    if (it.make) {
      const b = Object.assign({}, cur.data, cur.data.fix && cur.data.fix.lat != null ? { lat: cur.data.fix.lat, lng: cur.data.fix.lng } : {}); // 直した位置があれば、そこに置く
      if (b.lat == null || b.lng == null || !isFinite(Number(b.lat)) || !isFinite(Number(b.lng))) { bad.push(id); return; }
      const tid = it.terrId && terrs.get(String(it.terrId)) ? String(it.terrId) : null;
      hid = 'hg' + gbH_(id + '|' + nowIso_(), 12);
      const h = { id: hid, terrId: tid, type: 'apt', lat: Number(b.lat), lng: Number(b.lng), label: str_(b.ed && b.ed.name ? b.ed.name : b.name, 40), units: [], createdAt: nowIso_(), createdBy: user.id };
      if (b.lock) h.lock = true;
      if (h.label) h.gbn = h.label; // 一覧から付けた名前
      if (b.src === GB_TE) gbTeHouse_(h, b); // 手で登録した集合住宅：登録した部屋・エレベーター・メモ・立ち入りも
      mk.push(h);
      made.push(hid);
      madeIds[id] = hid;
    } else if (hid && (!ID_RE.test(hid) || !findRow_('houses', hid))) { bad.push(id); return; }
    ups.push([id, Object.assign({}, cur.data, { hid: it.skip ? '' : hid, skip: !!it.skip, tmp: !!(it.tmp && hid && !it.skip) })]);
  });
  if (mk.length) {
    const res = applyChanges_(user, { houses: { up: mk } }, {});
    const no = {};
    (res.rejected || []).forEach(function (x) { if (x.c === 'houses') no[String(x.id)] = true; });
    if (Object.keys(no).length) {
      for (let i = ups.length - 1; i >= 0; i--) if (no[ups[i][1].hid]) { bad.push(ups[i][0]); ups.splice(i, 1); }
    }
  }
  gbWrite_(gm, ups, user.id);
  // apply：家の名前・部屋・オートロックを、すぐ一覧の建物に合わせる（取り込みを待たない）
  const hu = [], ctx = { cols: {}, hcache: new Map() };
  items.forEach(function (it) {
    // 手で登録した集合住宅は取り込みが無いので、仮から確定したときにも合わせる（取り込みの建物は、次の取り込みで合う）
    if (it && !it.apply && !it.skip && !it.make && !it.tmp && it.hid && prev[String(it.id)] && prev[String(it.id)].src === GB_TE &&
        prev[String(it.id)].tmp && prev[String(it.id)].hid === String(it.hid)) it = Object.assign({}, it, { apply: true });
    if (!it || !it.apply || it.skip || it.make || it.tmp || !it.hid) return;
    const x = gm.get(String(it.id)), b = x && x.data;
    if (!b || b.hid !== String(it.hid)) return;
    const hd = houseData_(ctx, b.hid);
    if (!hd) return;
    const nh = gbFit_(hd, b);
    if (stable_(nh) !== stable_(hd)) hu.push(nh);
  });
  let applied = 0;
  if (hu.length) {
    const res = applyChanges_(user, { houses: { up: hu } }, {});
    applied = hu.length - (res.rejected || []).filter(function (x) { return x.c === 'houses'; }).length;
  }
  return { ok: true, n: ups.length, bad: bad, made: made, madeIds: madeIds, applied: applied };
}

/* 一覧の建物の位置を直す。items: [{ id, lat, lng, from: 'chiban'|'addr'|'hand' }] または [{ id, clear: true }]（一覧の位置にもどす）
   取り込みでは変えない。新しく置くときは、この位置に置く */
function gbPos_(user, items) {
  if (!Array.isArray(items) || !items.length || items.length > 300) return { ok: false, error: 'bad_request' };
  const gm = gbRead_(), ups = [], bad = [];
  items.forEach(function (it) {
    const id = String(it && it.id || ''), cur = gm.get(id);
    if (!cur || !cur.data) { bad.push(id); return; }
    if (it.clear) { ups.push([id, Object.assign({}, cur.data, { fix: null })]); return; }
    const lat = gbNum_(it.lat), lng = gbNum_(it.lng), from = ['chiban', 'addr', 'hand'].indexOf(it.from) >= 0 ? it.from : '';
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !from) { bad.push(id); return; }
    ups.push([id, Object.assign({}, cur.data, { fix: { lat: lat, lng: lng, from: from, at: nowIso_() } })]);
  });
  gbWrite_(gm, ups, user.id);
  return { ok: true, n: ups.length, bad: bad };
}

/* 地図にまだ無い建物どうしを「同じ建物」とまとめる・分ける。items: [{ id, same: 相手の id（'' で分ける） }]
   相手が、さらにほかの行と同じなら、そのもとの行にまとめる（つながりを1段にする） */
function gbSame_(user, items) {
  if (!Array.isArray(items) || !items.length || items.length > 300) return { ok: false, error: 'bad_request' };
  const gm = gbRead_(), ups = [], bad = [];
  items.forEach(function (it) {
    const id = String(it && it.id || ''), cur = gm.get(id);
    let to = String(it && it.same || '');
    if (!cur || !cur.data) { bad.push(id); return; }
    if (to) {
      const t = gm.get(to);
      if (!t || !t.data) { bad.push(id); return; }
      if (t.data.same) to = String(t.data.same);
      if (to === id) { bad.push(id); return; }
    }
    ups.push([id, Object.assign({}, cur.data, { same: to })]);
    if (to) gm.forEach(function (x, oid) { if (x.data && x.data.same === id) ups.push([oid, Object.assign({}, x.data, { same: to })]); }); // この行にまとめていた行も、もとの行へ
  });
  gbWrite_(gm, ups, user.id);
  return { ok: true, n: ups.length, bad: bad };
}

/* 一覧の建物の名前・住所を直す（取り込みでは変えない）。items: [{ id, name, addr }]（'' は一覧のとおり）
   住所を変えたときは、住所から調べた位置（地番の地図・国土地理院）を消す（画面が新しい住所で調べ直す）。係が置いた位置は残す */
function gbEdit_(user, items) {
  if (!Array.isArray(items) || !items.length || items.length > 300) return { ok: false, error: 'bad_request' };
  const gm = gbRead_(), ups = [], bad = [];
  items.forEach(function (it) {
    const id = String(it && it.id || ''), cur = gm.get(id);
    if (!cur || !cur.data) { bad.push(id); return; }
    const name = str_(it.name, 40).replace(/[<>"'&]/g, '').trim(), addr = str_(it.addr, 80).replace(/[<>"'&]/g, '').trim();
    const old = cur.data.ed || {};
    const d = Object.assign({}, cur.data, { ed: name || addr ? { name: name, addr: addr } : null });
    if ((old.addr || '') !== addr && d.fix && d.fix.from !== 'hand') d.fix = null;
    ups.push([id, d]);
  });
  gbWrite_(gm, ups, user.id);
  return { ok: true, n: ups.length, bad: bad };
}

/* 家を一覧の建物に合わせる：名前・アパート・オートロック・部屋。
   部屋は一覧の部屋にそろえ、アプリで入れた記録のある部屋だけは残す（取り込みの記録だけの部屋は、ちがう建物の分かもしれないので残さない） */
function gbFit_(hd, b) {
  const nh = Object.assign({}, hd, { type: 'apt' });
  const name = b.ed && b.ed.name ? b.ed.name : b.name; // 係が直した名前を先に
  if (name) { nh.label = str_(name, 40); nh.gbn = nh.label; }
  if (b.lock) nh.lock = true;
  delete nh.prov;
  const rooms = Array.isArray(b.rooms) ? b.rooms.map(String).filter(function (r) { return r && !UNIT_BAD_RE.test(r); }) : [];
  if (b.src === GB_TE) { // 手で登録した集合住宅：家にまだ無いものだけ入れる。階の枠だけの登録は、部屋のある家の部屋を変えない
    if (b.ac && !nh.ac) nh.ac = b.ac;
    if (b.bn && !nh.bn) nh.bn = b.bn;
    if (b.ban && !nh.ban) nh.ban = b.ban;
    if (b.fl && (hd.units || []).some(function (u) { return !GB_FRAME_RE.test(String(u)); })) return nh;
  }
  if (rooms.length) {
    const app = gbAppUnits_(hd.id), have = {};
    const out = rooms.slice().sort(gbRoomCmp_);
    out.forEach(function (u) { have[u] = true; });
    (hd.units || []).forEach(function (u) { u = String(u); if (!have[u] && app[u]) { have[u] = true; out.push(u); } });
    nh.units = out.slice(0, 300);
  }
  return nh;
}
/* アプリで入れた記録（取り込みでないもの）のある部屋 */
function gbAppUnits_(hid) {
  const out = {};
  try {
    const sh = dataSheet_('visits'), n = sh.getLastRow();
    if (n < 2) return out;
    readFound_(sh, 2, sh.getRange(2, 2, n - 1, 1).createTextFinder('"houseId":"' + hid + '"').matchCase(true).findAll().slice(0, 3000)).forEach(function (val) {
      const v = parseJson_(val, null);
      if (v && String(v.houseId) === hid && String(v.src || '') !== GB_SRC) out[String(v.unit || '')] = true;
    });
  } catch (e) { console.warn('部屋の記録を確かめられませんでした：' + e); }
  return out;
}

/* ---------- 手で登録する集合住宅（区域係） ----------
   行：te~<id>。{ src: 'te', k, label: '手で登録', name, addr, rooms: 部屋（または「1階」などの階の枠）, fl: 階の枠だけ, n, nv: 0,
         lock, ac: エレベーター（ev・no・st）, bn: 建物のメモ, ban: 立ち入り（no・letter）, hid, tmp, skip, fix, same, at }
   地図に置く（gb_link の make）と、登録した内容で家ができる。今ある家に結ぶと、家の名前・部屋・オートロックを合わせる */
function gbTeClean_(it) {
  if (!it || typeof it !== 'object') return null;
  const name = str_(it.name, 40).replace(/[<>"'&]/g, '').trim(), addr = str_(it.addr, 80).replace(/[<>"'&]/g, '').trim();
  if (!addr) return null;
  const seen = {}, rooms = [];
  (Array.isArray(it.rooms) ? it.rooms : []).slice(0, 300).forEach(function (r) {
    r = str_(r, 12).trim();
    if (r && !UNIT_BAD_RE.test(r) && !seen[r]) { seen[r] = true; rooms.push(r); }
  });
  if (!rooms.length) return null;
  return {
    name: name, addr: addr, rooms: rooms, n: rooms.length, fl: rooms.every(function (r) { return GB_FRAME_RE.test(r); }),
    lock: it.lock === true, ac: ['ev', 'no', 'st'].indexOf(it.ac) >= 0 ? it.ac : '', bn: bldNote_(it.bn),
    ban: it.ban === 'no' || it.ban === 'letter' ? it.ban : ''
  };
}
/* item: { id: 直すときの行の id（無ければ新しく）, name, addr, rooms, lock, ac, bn, ban, lat, lng（無くてよい） } */
function gbAdd_(user, item) {
  const c = gbTeClean_(item);
  if (!c) return { ok: false, error: 'bad_request' };
  const gm = gbRead_();
  let id = String(item.id || ''), cur = id ? gm.get(id) : null;
  if (id && (!cur || !cur.data || cur.data.src !== GB_TE)) return { ok: false, error: 'bad_request' };
  const d = cur ? cur.data : {};
  if (!cur) {
    const k = gbH_('te|' + user.id + '|' + c.name + '|' + c.addr + '|' + nowIso_() + '|' + Math.random(), 10);
    id = GB_TE + '~' + k;
    d.k = k;
  }
  const lat = gbNum_(item.lat), lng = gbNum_(item.lng);
  let fix = d.fix || null;
  if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) fix = { lat: lat, lng: lng, from: 'hand', at: nowIso_() };
  else if (cur && (d.addr || '') !== c.addr && fix && fix.from !== 'hand') fix = null; // 住所を変えたら、住所から調べた位置は調べ直す
  const row = Object.assign({ src: GB_TE, k: d.k, label: '手で登録', lat: null, lng: null, nv: 0, hid: d.hid || '', tmp: !!d.tmp, skip: !!d.skip,
    same: d.same || '', by: d.by || user.id }, c, { fix: fix, ed: null, at: nowIso_() });
  gbWrite_(gm, [[id, row]], user.id);
  return { ok: true, id: id, bld: Object.assign({ id: id }, row) };
}
/* 手で登録した行を消す（地図の家は消さない）。この行に「同じ建物」とまとめていた行は分ける */
function gbDel_(user, id) {
  id = String(id || '');
  const gm = gbRead_(), cur = gm.get(id);
  if (!cur || !cur.data || cur.data.src !== GB_TE || !(cur.row > 0)) return { ok: false, error: 'bad_request' };
  const ups = [];
  gm.forEach(function (x, oid) { if (x.data && x.data.same === id) ups.push([oid, Object.assign({}, x.data, { same: '' })]); });
  gbWrite_(gm, ups, user.id);
  dataSheet_(GB_SHEET).deleteRow(cur.row);
  return { ok: true };
}
/* 新しく置く家に、手で登録した内容を入れる */
function gbTeHouse_(h, b) {
  h.units = (Array.isArray(b.rooms) ? b.rooms : []).map(String).filter(function (r) { return r && !UNIT_BAD_RE.test(r); }).slice(0, 300);
  if (['ev', 'no', 'st'].indexOf(b.ac) >= 0) h.ac = b.ac;
  const bn = bldNote_(b.bn); if (bn) h.bn = bn;
  if (b.ban === 'no' || b.ban === 'letter') h.ban = b.ban;
}

/* =========================================================
   集合住宅を空にもどす（メニュー「区域マップ」→「集合住宅を空にもどす」。区域係が実行する）
   外の一覧の取り込みを、はじめからやり直すためのもの
   ・地図の集合住宅（二世帯住宅・お店や会社の建物は除く）は、場所と区域だけを残し、名前も部屋も無い「集」にもどす
   ・外の一覧から地図に置いた家（id が hg）は、地図から消す
   ・その家の訪問の記録（取り込み・アプリとも。拒否も）と、部屋の印（拒否・注意・外国語・再訪問など）を消す
   ・外の一覧の建物（シート gaibu。手で登録したものも）と、届いた一覧の名前を消す。取り込みの鍵は残す
   ・消す前に、スプレッドシートを丸ごとバックアップする（戻すときは「バックアップから戻す」）
   ========================================================= */
const GB_RESET_KEEP = ['id', 'terrId', 'type', 'lat', 'lng', 'createdAt', 'createdBy', 'imp']; // 空の「集」に残す項目
const GB_RESET_WORD = '空にする';

/* 何をどうするかを数える（消す前の確かめと、消すときの両方で使う） */
function gbResetPlan_() {
  const p = { houses: readCol_('houses'), visits: readCol_('visits'), marks: {}, clear: {}, drop: {},
    n: { clear: 0, drop: 0, other: 0, vis: 0, imp: 0, mark: 0, gb: 0, te: 0 } };
  p.houses.forEach(function (x, id) {
    const h = x && x.data;
    if (!h || h.type !== 'apt') return;
    if (id.indexOf('hg') === 0) { p.drop[id] = true; p.n.drop++; }
    else if (!h.kind && !MU_UNITS[String(h.mu || '')]) { p.clear[id] = true; p.n.clear++; }
    else p.n.other++; // 二世帯住宅・お店や会社の建物は、そのまま
  });
  const hit = function (hid) { return !!(p.clear[hid] || p.drop[hid]); };
  p.visits.forEach(function (x) {
    const v = x && x.data;
    if (!v || !hit(String(v.houseId || ''))) return;
    p.n.vis++;
    if (v.by === GB_USER || v.src === GB_SRC) p.n.imp++;
  });
  MAP_COLS.forEach(function (c) {
    const m = readCol_(c);
    p.marks[c] = m;
    m.forEach(function (x, id) { if (hit(String(id).split('|')[0])) p.n.mark++; });
  });
  gbRead_().forEach(function (x) { p.n.gb++; if (x.data && x.data.src === GB_TE) p.n.te++; });
  return p;
}

function gbResetMenu() {
  const ui = SpreadsheetApp.getUi();
  const n = gbResetPlan_().n;
  if (!n.clear && !n.drop && !n.gb) { ui.alert(T_('集合住宅を空にもどす', 'Vaciar edificios'), T_('空にする集合住宅はありません。', 'No hay edificios que vaciar.'), ui.ButtonSet.OK); return; }
  const r = ui.prompt(T_('集合住宅を空にもどす', 'Vaciar edificios de apartamentos'),
    T_('次のとおりにします。元にもどすときは「バックアップから戻す」を使います。\n\n' +
      '・地図の集合住宅 ' + n.clear + '件：場所だけ残し、名前・部屋・オートロック・メモなどの無い「集」にもどす\n' +
      '・外の一覧から地図に置いた家 ' + n.drop + '件：地図から消す\n' +
      '・その家の訪問の記録 ' + n.vis + '件（うち取り込み ' + n.imp + '件。拒否も）を消す\n' +
      '・その家の部屋の印（拒否・注意・外国語・再訪問など）' + n.mark + '件を消す\n' +
      '・外の一覧の建物 ' + n.gb + '件（うち手で登録 ' + n.te + '件）を消す（取り込みの鍵は残す）\n' +
      (n.other ? '・二世帯住宅・お店や会社の建物 ' + n.other + '件は、そのまま残す\n' : '') +
      '\n消す前に、このスプレッドシートを丸ごとバックアップします。だれもアプリを使っていないときに行ってください。\n\nよければ「' + GB_RESET_WORD + '」と入れて OK を押してください。',
      'Se vaciarán ' + n.clear + ' edificios (solo queda la ubicación), se borrarán ' + n.drop + ' edificios colocados desde listas externas, ' + n.vis + ' visitas, ' + n.mark + ' marcas y ' + n.gb + ' edificios de listas externas.\nAntes se hará una copia de seguridad.\n\nEscriba «' + GB_RESET_WORD + '» y pulse OK.'),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || r.getResponseText().trim() !== GB_RESET_WORD) return;
  let res;
  try { res = gbReset_(); }
  catch (e) {
    ui.alert(T_('できませんでした：', 'No se pudo: ') + ((e && e.message) || e) +
      T_('\n\n変わっていないか、途中までです。もう一度実行してください。', '\n\nVuelva a intentarlo.'));
    return;
  }
  ui.alert(T_('集合住宅を空にもどしました', 'Edificios vaciados'),
    T_('空にした集合住宅 ' + res.clear + '件・消した家 ' + res.drop + '件・消した訪問の記録 ' + res.vis + '件・部屋の印 ' + res.mark + '件・外の一覧の建物 ' + res.gb + '件\n\n' +
      '消す前のバックアップ：' + res.backup + '\n\nみんなのスマホは、次に開いたときに全部を読み直します。\n取り込み用のスプレッドシートで「今すぐ取り込む」を押すと、外の一覧がまた届きます。',
      'Vaciados: ' + res.clear + ', borrados: ' + res.drop + ', visitas: ' + res.vis + ', marcas: ' + res.mark + ', lista externa: ' + res.gb + '\n\nCopia: ' + res.backup),
    ui.ButtonSet.OK);
}

/** 本体（画面なし）。消す前にバックアップを作る（作れなければ、何もしないで止まる） */
function gbReset_() {
  const backup = makeBackup_('集合住宅を空にする前').getName();
  const lock = LockService.getScriptLock();
  lock.waitLock(60000); // 保存・取り込みの最中に書きかえないように
  let res;
  try {
    const p = gbResetPlan_(); // ロックの中で数え直す（確かめのあとに変わった分も入れる）
    const hit = function (hid) { return !!(p.clear[hid] || p.drop[hid]); };
    res = { clear: p.n.clear, drop: p.n.drop, vis: p.n.vis, mark: p.n.mark, gb: p.n.gb, backup: backup };
    // 記録と印を先に消す（途中で止まっても、もう一度実行すれば残りが消える）
    if (p.n.vis) {
      const del = [];
      p.visits.forEach(function (x, id) { if (x && x.data && hit(String(x.data.houseId || ''))) del.push(id); });
      del.forEach(function (id) { p.visits.delete(id); });
      rewriteCol_('visits', p.visits);
    }
    MAP_COLS.forEach(function (c) {
      const m = p.marks[c], del = [];
      m.forEach(function (x, id) { if (hit(String(id).split('|')[0])) del.push(id); });
      if (!del.length) return;
      del.forEach(function (id) { m.delete(id); });
      rewriteCol_(c, m);
    });
    // 家：置いた家は消し、集合住宅は場所と区域だけの「集」にする
    if (p.n.clear || p.n.drop) {
      const now = new Date();
      Object.keys(p.drop).forEach(function (id) { p.houses.delete(id); });
      Object.keys(p.clear).forEach(function (id) {
        const x = p.houses.get(id), o = {};
        GB_RESET_KEEP.forEach(function (k) { if (x.data[k] !== undefined) o[k] = x.data[k]; });
        o.type = 'apt'; o.label = ''; o.units = [];
        x.data = o; x.at = now;
      });
      rewriteCol_('houses', p.houses);
    }
    // 外の一覧の建物と、届いた一覧の名前（鍵は残す）
    if (p.n.gb) rewriteCol_(GB_SHEET, new Map());
    const sp = props_();
    Object.keys(sp.getProperties()).forEach(function (k) { if (k.indexOf('GB_SRC_') === 0) sp.deleteProperty(k); });
    resetJournal_(); // みんなのスマホに、全部を読み直してもらう
    if (typeof shrinkSheets_ === 'function') { try { shrinkSheets_(); } catch (e) { console.warn(e); } }
    props_().setProperty('GB_RESET', JSON.stringify({ at: nowIso_(), clear: res.clear, drop: res.drop, vis: res.vis, mark: res.mark, gb: res.gb }));
  } finally {
    lock.releaseLock();
  }
  // はじめて開くときに使う、家と記録の一覧（ドライブのファイル）も作り直す
  try { if (typeof houseSnapBuild_ === 'function') houseSnapBuild_(); } catch (e) { console.warn(e); }
  if (typeof visitSnapBuild_ === 'function') {
    try { if (!visitSnapBuild_()) visitSnapSoon_(); } catch (e) { console.warn(e); try { visitSnapSoon_(); } catch (e2) { /* 1時間ごとの見直しで作られる */ } }
  }
  console.log('集合住宅を空にもどしました：' + JSON.stringify(res));
  return res;
}
