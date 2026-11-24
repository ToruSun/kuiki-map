/* =========================================================
   gaibu.gs  外の一覧からの取り込みの口

   会衆が別に使っている一覧（アパート・オートロックの訪問の記録など）を、移行のあいだ、何度でもアプリに入れるための口。
   一覧の形は会衆ごとにちがうので、本体は形を知らない。会衆の外のプログラム（区域係が用意する Apps Script）が一覧を読み、
   決まった形（建物・部屋・訪問の日付）にして送る。

   ・送るときは「取り込みの鍵」を使う（区域係の画面で作る。サーバーには照合値だけを置く）。鍵でできるのは、この取り込みだけ
   ・送られた建物とアプリの家の結びつきは、区域係が画面で決める（gb_list・gb_link）。結びついた建物の記録だけを入れる
   ・入れる記録：記録した人は「取り込み」（by: 'imp'）、印 src: 'imp'。id は 元・建物・部屋・日 から決まる（何回送っても同じ id）
     送られるたびに、その建物の取り込みの記録を、送られた内容に合わせる（足す・直す・消す）。アプリで入れた記録には手をふれない
     同じ家・同じ部屋・同じ日（日本時間）に、アプリで入れた記録があれば、取り込みの分は入れない（二重にしない）
   ・部屋：アパートにない部屋を足す（部屋は消さない）。「1階」などの階の枠しかないアパートは、記録のない枠を部屋番号に置きかえる
     結びつけた家がアパートでなければ、アパートにする（仮の家の印は外す）
   ・オートロック：送られた建物が lock なら、アパートに印をつける（外さない）
   ・データ：シート「gaibu」（id＝元~建物。同期の記録 journal には乗せない。係の画面だけが gb_list で読む）
       { src, k, label, name, addr, lat, lng, lock, n: 部屋数, nv: 記録数, hid: 家id, skip, gone, at: 最後に届いた日時, res: 最後の結果 }

   送る形（action: 'gb_sync'。token の代わりに key）：
     { key, src: '元（英数字12字まで）', label: '一覧の名前', dry: true で確かめだけ,
       blds: [{ k: '建物（英数字・._- 40字まで）', name, addr, lat, lng, lock,
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
  if (!GB_SRC_RE.test(src) || !Array.isArray(req.blds)) return { ok: false, error: 'bad_request' };
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
      else { o.st = 'linked'; linked.push({ b: b, hid: String(d.hid), hd: hd, o: o }); }
    }
    out.push(o);
  });
  const skipKs = {};
  out.forEach(function (o) { if (o.st === 'skip') skipKs[gbPre_(src, o.k)] = o; });

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
    if (!hd.label && b.name) nh.label = b.name;
    if (stable_(nh) !== stable_(hd)) hups.push(Object.assign({ id: hid }, nh));
  });
  // 取り込まないことにした建物の、前に入れた記録は消す
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
        src: src, k: b.k, label: label, name: b.name, addr: b.addr, lat: b.lat, lng: b.lng, lock: b.lock,
        n: b.rooms.length, nv: nv, hid: d.hid || '', skip: !!d.skip, at: nowIso,
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
  Object.keys(sp).forEach(function (k) {
    if (k.indexOf('GB_SRC_') !== 0) return;
    const v = parseJson_(sp[k], null);
    if (v) srcs.push(Object.assign({ src: k.slice(7) }, v));
  });
  return { ok: true, key: { has: !!sp[GB_KEY_PROP], at: sp[GB_KEY_AT] || '' }, srcs: srcs, blds: blds };
}

/* items: [{ id: '元~建物', hid: '家id' または '', skip: true|false, make: true（建物の場所に新しいアパートを置く）, terrId }]（まとめて送れる）
   make：家はサーバーで作る（画面で作ると、サーバーに届くまで結べないため）。区域は画面が場所から決めて送る */
function gbLink_(user, items) {
  if (!Array.isArray(items) || !items.length || items.length > 300) return { ok: false, error: 'bad_request' };
  const gm = gbRead_(), ups = [], bad = [], made = [], mk = [];
  const terrs = readCol_('territories');
  items.forEach(function (it) {
    const id = String(it && it.id || ''), cur = gm.get(id);
    if (!cur || !cur.data) { bad.push(id); return; }
    let hid = String(it.hid || '');
    if (it.make) {
      const b = cur.data;
      if (b.lat == null || b.lng == null || !isFinite(Number(b.lat)) || !isFinite(Number(b.lng))) { bad.push(id); return; }
      const tid = it.terrId && terrs.get(String(it.terrId)) ? String(it.terrId) : null;
      hid = 'hg' + gbH_(id + '|' + nowIso_(), 12);
      const h = { id: hid, terrId: tid, type: 'apt', lat: Number(b.lat), lng: Number(b.lng), label: str_(b.name, 40), units: [], createdAt: nowIso_(), createdBy: user.id };
      if (b.lock) h.lock = true;
      mk.push(h);
      made.push(hid);
    } else if (hid && (!ID_RE.test(hid) || !findRow_('houses', hid))) { bad.push(id); return; }
    ups.push([id, Object.assign({}, cur.data, { hid: it.skip ? '' : hid, skip: !!it.skip })]);
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
  return { ok: true, n: ups.length, bad: bad, made: made };
}
