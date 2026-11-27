/* =========================================================
   gaibu.js  区域係の「集合住宅の一覧」（もとは「外の一覧とつなぐ」）  ※区域係だけ

   集合住宅の一覧：地図の集合住宅（アパート）を全部と、地図にまだ無い建物（外の一覧から届いた建物）を1つの一覧にする。
     外の一覧の建物を地図のアパートに結ぶと、1行にまとまる。さがす・しぼる・同じらしい組をまとめる。一軒家は載せない

   会衆が別に使っている一覧（アパート・オートロックの訪問の記録など）を、移行のあいだ、何度でもアプリに入れるための画面。
   一覧を読んで送るのは、区域係が別に用意するプログラム（取り込み用のスプレッドシートの Apps Script）。サーバーの受け口は gas/gaibu.gs
   ・入口：係の画面 ＞ 区域 ＞「区域の線・取り込み」＞「集合住宅の一覧」
   ・取り込みの鍵：作る（1回だけ表示）・止める。鍵は、外のプログラムのスクリプトのプロパティに入れる
   ・建物の結びつき：一覧の建物を、アプリのアパート（または家）に結ぶ。結んだ建物の記録だけが入る
       候補：場所の近い家（アパートを先に）と、名前が同じ家。「候補が1つの建物をまとめて結ぶ」もできる
       新しく置く：建物の場所に、新しいアパートを置いて結ぶ（サーバーで作る）
       取り込まない・外す：前に入れた記録も、次の取り込みで消える（記録は結んだ家にだけ入る）
       仮で結ぶ：残りを全部まとめて結ぶ（近くのアパート → 近くの仮の家 → なければ新しく置く）。あとで「仮」のタブで確かめる
   ・入れた記録は「取り込み」（記録した人）。一覧を直せば、次の取り込みでアプリの記録も直る

   ・家や「集」の画面（区域係だけ）：結んでいる一覧の建物を出し、これでよい・外す・ほかの一覧の建物を選んで結ぶ（window.gaibuNotice）
   ・名前が同じ：家の名前が人の付けた名前のときだけ数える（一覧から付けた名前は数えない）
   ・一覧の位置：直した位置（fix：地番の地図・係が地図で置いた）＞ 一覧から届いた位置（リンク・住所）。
       一覧から届いた位置でも、名前のちがう建物がほぼ同じ所にあるとき（リンクの写しまちがい・住所が町の代表点になったもの）は使わない
       使える位置がない建物は、住所（一覧のリンクに入っていた住所 → 一覧の住所）で位置を調べて覚える（gb_pos）：
       地番の地図（kyohi.js の chibanFind。法務省の地図）→ 国土地理院（app.js の xlGeocode。番地まで合ったときだけ）
   ・名前・住所・位置を直す：直した名前・住所（ed）は取り込みで変わらない。住所を直すと、その住所で位置を調べ直す。
       位置は緯度・経度の数字でも入れられる（係が置いた位置として覚える）
   ・位置を地図で直す：十字に建物を合わせて「ここにする」（Google マップの位置は写さない。見て確かめるだけ）
   ・Google マップで見る（iPhone は Google マップのアプリを直接呼ぶ。無ければウェブ）：建物名と住所で Google マップの検索を開くだけ（位置は保存しない。Google の位置を Google 以外の地図に使うのは規約で認められていないため）

   index.html：torikomi.js の次に <script src="gaibu.js"></script>
   ========================================================= */
(function () {
  'use strict';
  if (typeof Store === 'undefined' || typeof D !== 'function' || typeof setSheet !== 'function') return;

  const css = document.createElement('style');
  css.textContent = `
.gb-row{display:flex;gap:10px;align-items:center;width:100%;min-height:58px;border:2px solid var(--line);border-radius:12px;background:#fff;padding:8px 12px;margin:6px 0;text-align:left;font:inherit;color:var(--ink);cursor:pointer}
.gb-row .tx{flex:1;min-width:0;line-height:1.35}
.gb-row .tx b{display:block;font-size:16px}
.gb-row .tx small{display:block;font-size:13px;color:var(--ink2)}
.gb-st{flex:none;font-size:13px;font-weight:700;border-radius:8px;padding:2px 8px;background:#EEF1F5;color:var(--ink2)}
.gb-st.ok{background:#E6F4EA;color:#1E7A3C}
.gb-st.wait{background:#FFF4E5;color:#9A5B12}
.gb-open{flex:1;min-width:0;background:none;border:0;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer;display:flex}
.gb-more{margin:8px 0;border:2px solid var(--line);border-radius:12px;padding:6px 12px;background:#fff}
.gb-more>summary{cursor:pointer;font-weight:700;min-height:40px;display:flex;align-items:center}
.gb-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.gb-tabs button{min-height:44px;border:2px solid var(--line);border-radius:22px;background:#fff;padding:0 14px;font:inherit;font-size:15px;cursor:pointer}
.gb-tabs button.on{border-color:var(--brand-ink);background:#E3ECF6;font-weight:700}
.gb-key{width:100%;font:15px/1.4 ui-monospace,monospace;padding:10px;border:2px solid var(--brand-ink);border-radius:10px;background:#F5F8FC;word-break:break-all}
.gb-src{font-size:14px;color:var(--ink2);margin:2px 0}
.gb-mapbar{position:absolute;left:10px;right:10px;bottom:22px;z-index:700;background:var(--paper);border:3px solid var(--brand-ink);border-radius:var(--r);padding:10px 12px;box-shadow:0 4px 14px #0005}
.gb-mapbar .t{font-size:15px;line-height:1.4;margin:0 36px 8px 0}
.gb-mapbar .t b{font-size:16px}
.gb-mapbar .acts{display:flex;flex-wrap:wrap;gap:6px}
.gb-mapbar .acts .btn{flex:1 1 auto;min-height:48px}
.gb-mapbar .x{position:absolute;top:6px;right:6px;width:40px;height:40px;border-radius:50%;border:2px solid var(--line);background:#fff;font-size:20px;line-height:1;cursor:pointer}
.gb-hn{margin:8px 0;padding:8px 12px}
.gb-hn>summary{cursor:pointer;font-weight:700;min-height:40px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.gb-hrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 0;border-top:1px solid var(--line)}
.gb-hrow .tx{flex:1 1 180px;min-width:0;line-height:1.35}
.gb-hrow .tx small{display:block;font-size:13px;color:var(--ink2)}
a.btn{text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.gb-pin-h{background:var(--brand-ink,#1d3a5a);color:#fff;font-weight:700;border:0;border-radius:8px;padding:2px 8px;font-size:14px}
.gb-cross{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;z-index:650;pointer-events:none}
.gb-cross::before,.gb-cross::after{content:'';position:absolute;background:#C0392B;box-shadow:0 0 0 2px #fff}
.gb-cross::before{left:20px;top:0;width:4px;height:44px}
.gb-cross::after{top:20px;left:0;height:4px;width:44px}
.gb-pin-o{background:#5b6776;color:#fff;font-weight:700;border:0;border-radius:8px;padding:2px 8px;font-size:14px}
.gb-pin-b{background:#9A5B12;color:#fff;font-weight:700;border:0;border-radius:8px;padding:2px 8px;font-size:14px}
`;
  document.head.appendChild(css);

  const st = { data: null, tab: 'wait', q: '' };
  const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・･\-ー―‐－〜~()（）]/g, '');
  const dist = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r; return Math.sqrt(x * x + y * y) * R; };
  const hasPos = b => b && b.lat != null && b.lng != null && isFinite(b.lat) && isFinite(b.lng);
  const day = iso => { const t = Date.parse(iso); if (!isFinite(t)) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const stOf = b => b.skip ? 'skip' : b.gone ? 'gone' : b.hid ? (houseById(b.hid) ? (b.tmp ? 'tmp' : 'ok') : 'lost') : 'wait';
  const ST_LABEL = { ok: '結んだ', tmp: '仮', wait: 'まだ', skip: '取り込まない', gone: '一覧にない', lost: '家がない' };
  /* 検索欄：日本語を変換しているあいだは検索しない（確定してから）。描き直すのは結果だけで、検索欄はそのまま残す
     （欄ごと描き直すと、iPhone の日本語入力で1字しか入らなくなる） */
  function bindSearch(input, onSearch) {
    let composing = false, tm = null;
    const go = () => { clearTimeout(tm); tm = setTimeout(() => onSearch(input.value), 250); };
    input.addEventListener('compositionstart', () => { composing = true; clearTimeout(tm); });
    input.addEventListener('compositionend', () => { composing = false; go(); });
    input.addEventListener('input', e => { if (composing || e.isComposing) return; go(); });
  }
  const pullNow = () => { try { return typeof window.refresh === 'function' ? window.refresh(true) : null; } catch (e) { return null; } }; // app.js の「最新の変更を取りに行く」
  /* 家の名前が一覧の建物名（norm したもの nb）と同じか。一覧から付けた名前の家（gb_list の named・家の gbn）は数えない
     （仮で結んだときなどに一覧の名前が付いた家が、次に「名前が同じ」で選ばれてしまうのを防ぐ） */
  function sameName(nb, h) {
    if (!nb || !h || norm(h.label) !== nb) return false;
    if (h.gbn && norm(h.gbn) === norm(h.label)) return false;
    return !(st.data && Array.isArray(st.data.named) && st.data.named.includes(h.id));
  }
  const fmtM = m => !isFinite(m) ? '場所不明' : m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
  /* Google マップの検索を開く（建物名＋住所。住所に市町村がなければ、会衆の県・市をつける） */
  function gmapUrl(b) {
    const A = typeof CFG_AREA !== 'undefined' ? CFG_AREA : null;
    let addr = String(b.addr || '').trim();
    if (A && addr && !A.names.concat([A.muni]).some(n => n && addr.includes(n))) addr = A.prefOf(A.muni) + A.muni + addr;
    const q = [String(b.name || '').trim(), addr].filter(Boolean).join(' ');
    return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
  }
  const gmapBtn = (b, cls) => { const u = gmapUrl(b); return u ? `<a class="btn ${cls == null ? 'small' : cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-gmap="1">Google マップ</a>` : ''; };
  /* iPhone・iPad：ホーム画面のアプリから開くと、リンクがアプリ内のブラウザで開き、そこの「アプリで開く」が App Store に
     飛んでしまうことがある。Google マップのアプリを直接呼び（comgooglemaps://）、開かなければ（入っていなければ）ウェブで開く */
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-gmap]') : null;
    if (!a || !isIOS) return;
    const web = a.href, q = (web.split('query=')[1] || '');
    if (!q) return;
    e.preventDefault();
    let left = false;
    const gone = () => { left = true; };
    document.addEventListener('visibilitychange', gone, { once: true });
    window.addEventListener('pagehide', gone, { once: true });
    location.href = 'comgooglemaps://?q=' + q;
    setTimeout(() => {
      document.removeEventListener('visibilitychange', gone);
      if (!left && document.visibilityState === 'visible') window.open(web, '_blank', 'noopener'); // アプリが無い：ウェブで開く
    }, 1500);
  }, true);
  const KARI_APT_M = 40, KARI_PROV_M = 25; // 仮で結ぶ：この距離までのアパート・仮の家に結ぶ（ふつうの家はアパートに変えない）

  /* 候補：場所の近い家（60m 以内。アパートを先に）と、名前が同じ家（場所が分からないとき・遠くても） */
  function candidates(b) {
    const out = [], seen = new Set(), nb = norm(b.name);
    D().houses.forEach(h => {
      if (!h || h.lat == null) return;
      const m = hasPos(b) ? dist(b.lat, b.lng, h.lat, h.lng) : Infinity;
      const same = sameName(nb, h);
      if (m <= 60 || (same && (m <= 1000 || !hasPos(b)))) { out.push({ h, m, same }); seen.add(h.id); }
    });
    out.sort((x, y) => (y.same - x.same) || ((y.h.type === 'apt') - (x.h.type === 'apt')) || (x.m - y.m));
    return out.slice(0, 8);
  }
  /* 迷わない候補：名前が同じ家が1つだけ（場所が分かるときは 150m 以内）、
     または 30m 以内にアパートが1つだけで、60m 以内にほかのアパートがない */
  function sureMatch(b) {
    const cs = candidates(b);
    const same = cs.filter(c => c.same && (!hasPos(b) || c.m <= 150));
    if (same.length === 1) return same[0].h;
    if (same.length > 1 || !hasPos(b)) return null;
    const apts = cs.filter(c => c.h.type === 'apt' && c.m <= 60);
    if (apts.length === 1 && apts[0].m <= 30) return apts[0].h;
    return null;
  }

  /* 仮で結ぶ相手を決める（まとめて）
     ・使える位置がない建物（分からない・あやしい）は、まだ のまま
     ・ほかの一覧の建物を結んでいる家には結ばない。1つの家には1棟だけ（名前が同じ組 → 近い組の順に決める）
     ・近くのアパート（40m）→ 近くの仮の家（25m）。どちらもなく、近くに相手がとられた家もなければ、新しく置く
     返す：[{ b, h, how: 'apt'|'prov'|'make'|'nopos'|'busy', m }] */
  function kariPlan(list) {
    const taken = new Set((st.data.blds || []).filter(x => x.hid && !x.skip && !x.gone).map(x => x.hid));
    const pairs = [], near = new Map();
    list.forEach(b => {
      if (!hasPos(b)) return;
      const nb = norm(b.name);
      D().houses.forEach(h => {
        if (!h || h.lat == null) return;
        const isApt = h.type === 'apt', ok = isApt || (h.type !== 'apt' && h.prov);
        if (!ok) return;
        const m = dist(b.lat, b.lng, h.lat, h.lng);
        if (m > (isApt ? KARI_APT_M : KARI_PROV_M)) return;
        near.set(b.id, true);
        if (taken.has(h.id)) return;
        pairs.push({ b, h, m, how: isApt ? 'apt' : 'prov', same: sameName(nb, h) });
      });
    });
    pairs.sort((x, y) => (y.same - x.same) || ((x.how === 'apt' ? 0 : 1) - (y.how === 'apt' ? 0 : 1)) || (x.m - y.m));
    const got = new Map(), used = new Set();
    pairs.forEach(p => { if (!got.has(p.b.id) && !used.has(p.h.id)) { got.set(p.b.id, p); used.add(p.h.id); } });
    return list.map(b => got.get(b.id) || (!hasPos(b) ? { b, how: 'nopos' } : near.get(b.id) ? { b, how: 'busy' } : { b, h: null, how: 'make' }));
  }

  /* 位置をそろえる：b.lat・b.lng を「使ってよい位置」にする（一覧から届いた位置は b.llat・b.llng に残す）
     b.pf：chiban（地番の地図）・hand（係が置いた）・list（一覧から）・dup（ほかの建物と同じ所であやしい）・''（分からない） */
  const DUP_M = 8;
  function prep() {
    const bl = (st.data && st.data.blds) || [];
    bl.forEach(b => {
      if (!('llat' in b)) { b.llat = b.lat; b.llng = b.lng; }
      if (!('oname' in b)) { b.oname = b.name || ''; b.oaddr = b.addr || ''; } // 一覧の値
      b.name = (b.ed && b.ed.name) || b.oname; b.addr = (b.ed && b.ed.addr) || b.oaddr; // 係が直した値を先に
      b.dupPos = false;
    });
    const pts = bl.filter(b => b.llat != null && b.llng != null && isFinite(b.llat) && isFinite(b.llng));
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], c = pts[j];
      if (Math.abs(a.llat - c.llat) > 0.0002 || Math.abs(a.llng - c.llng) > 0.0003) continue;
      if (dist(a.llat, a.llng, c.llat, c.llng) > DUP_M) continue;
      if ((norm(a.name) && norm(a.name) === norm(c.name)) || (norm(a.addr) && norm(a.addr) === norm(c.addr))) continue; // 同じ建物（2つの一覧に載っている）
      a.dupPos = c.dupPos = true;
    }
    bl.forEach(b => {
      if (b.fix && b.fix.lat != null) { b.lat = b.fix.lat; b.lng = b.fix.lng; b.pf = b.fix.from; }
      else if (b.llat != null && !b.dupPos) { b.lat = b.llat; b.lng = b.llng; b.pf = 'list'; }
      else { b.lat = null; b.lng = null; b.pf = b.llat != null ? 'dup' : ''; }
    });
  }
  const PF_LABEL = { chiban: '地番の地図で調べた位置', addr: '住所で調べた位置（番地まで合った）', hand: '手で直した位置', list: '一覧のリンクの位置', dup: 'あやしい（名前のちがう建物と同じ位置）', '': '分かりません' };

  /* 使える位置がない建物の位置を、住所で調べて覚える（この端末から。結果は gb_pos でサーバーに覚えさせる）
     住所：一覧のリンクに入っていた住所（laddr）→ 一覧の住所（addr）
     調べ方：地番の地図（法務省）→ 国土地理院（番地まで合ったときだけ。町や丁目の代表点は使わない）
     一覧のリンクの位置がある建物は、地番の地図と 80m 以上はなれていれば b.far に残す（画面で知らせるだけ） */
  let cbRunning = null;
  /* 進み具合：一覧の画面・仮で結ぶの画面の #gbProg に出す */
  function setProg(t) {
    st.prog = t;
    const el = document.getElementById('gbProg');
    if (el) { el.textContent = t; el.hidden = !t; }
  }
  function chibanPass() {
    if (cbRunning) return cbRunning;
    if (typeof window.chibanFind !== 'function' || typeof window.chibanAddr !== 'function' || !st.data) return Promise.resolve(0);
    cbRunning = (async () => {
      const todo = (st.data.blds || []).filter(b => !b.gone && !b.cbDone && (b.laddr || b.addr) && !(b.fix && b.fix.lat != null));
      if (!todo.length) return 0;
      const save = [], gsi = [];
      let found = 0;
      const flushSave = async () => { // 見つかった位置は、少しずつサーバーへ（途中で閉じても、そこまでは残る）
        const part = save.splice(0, save.length);
        if (!part.length) return;
        prep();
        try { await api('gb_pos', { items: part }, { timeout: 60000 }); } catch (e) { part.forEach(x => { const b = (st.data.blds || []).find(y => y.id === x.id); if (b) b.cbDone = false; }); }
      };
      const keep = (b, pos, from) => {
        b.fix = { lat: Math.round(pos.lat * 1e6) / 1e6, lng: Math.round(pos.lng * 1e6) / 1e6, from };
        save.push({ id: b.id, lat: b.fix.lat, lng: b.fix.lng, from });
        found++;
      };
      const tail = '（閉じてもかまいません。次に開いたとき、続きから調べます）';
      let i = 0;
      for (const b of todo) {
        setProg(`住所から位置を調べています… ${++i}／${todo.length}${found ? `・分かった ${found}棟` : ''}${tail}`);
        if (save.length >= 20) await flushSave();
        b.cbDone = true;
        const es = (b.ed && b.ed.addr ? [b.ed.addr] : [b.laddr, b.addr]).filter(Boolean).map(a => { try { return window.chibanAddr(a); } catch (e) { return null; } }).filter(Boolean);
        let r = null;
        for (const e of es) { try { r = await window.chibanFind(e); } catch (err) { r = null; } if (r && r.pos) break; }
        if (b.pf === 'list') { if (r && r.pos) { const m = dist(b.lat, b.lng, r.pos.lat, r.pos.lng); if (m >= 80) b.far = Math.round(m); } continue; }
        if (r && r.pos) { keep(b, r.pos, 'chiban'); continue; }
        if (es.length) gsi.push({ b, es });
      }
      // 国土地理院：まとめて聞き、番地まで合ったときだけ使う
      if (gsi.length && typeof xlGeocode === 'function' && typeof xlPick === 'function') {
        const qs = [...new Set(gsi.flatMap(x => x.es.map(e => e.q)).filter(Boolean))];
        let res = new Map();
        try { res = await xlGeocode(qs, d => setProg(`国土地理院に聞いています… ${d}／${qs.length}${found ? `・分かった ${found}棟` : ''}${tail}`)); } catch (e) { res = new Map(); }
        gsi.forEach(({ b, es }) => {
          for (const e of es) { const p = xlPick(e, res.get(e.q)); if (p && p.good) { keep(b, p, 'addr'); break; } }
        });
      }
      await flushSave();
      return found;
    })().finally(() => { cbRunning = null; setProg(''); });
    return cbRunning;
  }

  async function load(quiet) {
    try {
      const d = await api('gb_list', {}, { timeout: 45000 });
      const old = new Map(((st.data && st.data.blds) || []).map(b => [b.id, b]));
      (d.blds || []).forEach(b => { const o = old.get(b.id); if (o) { if (o.cbDone) b.cbDone = true; if (o.far) b.far = o.far; } });
      st.raw = JSON.stringify(d); st.data = d; prep(); return true;
    }
    catch (e) {
      if (!quiet || !st.data) { st.data = null; toast(e && e.code === 'unknown_action' ? 'サーバーがまだ新しくなっていません' : '読み込めませんでした。あとでもう一度ためしてください'); }
      return false;
    }
  }
  /* うしろで読み直す。一覧の画面のままなら、変わったときだけ描き直す（見ていた所はそのまま） */
  async function refresh() {
    const before = st.raw;
    if (!await load(true)) return;
    if (st.raw === before) return;
    if ($('#gbQ')) { st.restore = $('#sheet').scrollTop; sheetKeep = true; render(); }
  }

  /* 一覧の画面を開いたあと、地番の地図で位置を調べる。見つかったら知らせて描き直す */
  async function cbAfter() {
    const n = await chibanPass().catch(() => 0);
    if (n) { toast(`住所から、${n}棟の位置が分かりました`); if ($('#gbQ')) { st.restore = $('#sheet').scrollTop; sheetKeep = true; render(); } }
  }

  /* 一覧の画面：前に読んだものをすぐ出し、うしろで読み直す */
  async function open() {
    if (!isAdmin()) { toast('区域係だけが使えます'); return; }
    mapOff();
    if (st.data) { render(); refresh().then(cbAfter); return; }
    setSheet(headHtml(null, '集合住宅の一覧', '読み込み中…') + '<p class="hint">読み込んでいます…</p>');
    await load();
    render();
    cbAfter();
  }

  /* ---------- 集合住宅の一覧 ----------
     行：{ k: 'm'（地図の集合住宅）, h, links: 結んでいる外の一覧の建物 } ・ { k: 'r'（地図にまだ無い建物）, b, alias: 同じ建物とまとめた行 } */
  const LIST_MAX = 200;
  function uniRows() {
    const bl = (st.data && st.data.blds) || [];
    const byH = new Map();
    bl.forEach(b => { if (b.hid && !b.skip && houseById(b.hid)) { if (!byH.has(b.hid)) byH.set(b.hid, []); byH.get(b.hid).push(b); } });
    const rows = [];
    (D().houses || []).forEach(h => { if (h && (h.type === 'apt' || byH.has(h.id))) rows.push({ k: 'm', h, links: byH.get(h.id) || [] }); });
    bl.forEach(b => {
      if (b.hid && !b.skip && houseById(b.hid)) return; // 地図のアパートの行に入っている
      if (b.same && bl.some(x => x.id === b.same)) return; // まとめた相手の行に入っている
      rows.push({ k: 'r', b, alias: bl.filter(x => x.same === b.id) });
    });
    return rows;
  }
  const rowName = r => r.k === 'm' ? (r.h.label || '名前のない集合住宅') : (r.b.name || '（名前なし）');
  function rowSt(r) {
    if (r.k === 'm') return r.links.some(b => stOf(b) === 'tmp') ? 'tmp' : 'map';
    return stOf(r.b); // wait・skip・gone・lost
  }
  const U_LABEL = { map: '地図', tmp: '仮', wait: 'まだ', lost: '家がない', skip: '取り込まない', gone: '一覧にない' };
  const isTe = b => b && b.src === 'te'; // 区域係が手で登録した集合住宅（取り込みは無い）
  const roomsOf = b => b.fl ? `${b.n}階分` : `${b.n}部屋`;
  const subOf = b => isTe(b) ? `手で登録・${roomsOf(b)}` : `${b.label || b.src}・${b.n}部屋・記録${b.nv}件`;
  function rowIn(r, tab) {
    const s = rowSt(r);
    if (tab === 'all') return s !== 'skip';
    if (tab === 'map') return r.k === 'm';
    if (tab === 'reg') return r.k === 'r' && (s === 'wait' || s === 'lost');
    if (tab === 'tmp') return s === 'tmp';
    if (tab === 'ext') return r.k === 'r' ? !isTe(r.b) : r.links.some(b => !isTe(b));
    if (tab === 'te') return r.k === 'r' ? isTe(r.b) : r.links.some(isTe);
    if (tab === 'skip') return s === 'skip';
    if (tab === 'gone') return r.k === 'r' ? !!r.b.gone : r.links.some(b => b.gone);
    return true;
  }
  function rowHit(r, q) {
    if (!q) return true;
    const t = r.k === 'm'
      ? [r.h.label, r.h.terrId && terrById(r.h.terrId) ? terrById(r.h.terrId).no : '', ...r.links.map(b => b.name + ' ' + b.addr + ' ' + b.label)]
      : [r.b.name, r.b.addr, r.b.label, ...r.alias.map(x => x.name + ' ' + x.label)];
    return t.some(x => norm(x).includes(q));
  }

  /* 同じらしい組：地図にまだ無い建物と、地図のアパート（人が付けた名前が同じで 100m 以内。位置が分からなければ名前が同じものが1つだけ）、
     地図にまだ無い建物どうし（名前が同じで、100m 以内か住所が同じ） */
  function pairsOf() {
    const bl = (st.data && st.data.blds) || [];
    const regs = bl.filter(b => !b.skip && !b.gone && !b.same && !(b.hid && houseById(b.hid)));
    const apts = (D().houses || []).filter(h => h && h.type === 'apt' && h.lat != null);
    const out = [], usedB = new Set();
    regs.forEach(b => {
      const nb = norm(b.name); if (!nb) return;
      const ms = apts.filter(h => sameName(nb, h)).map(h => ({ h, m: hasPos(b) ? dist(b.lat, b.lng, h.lat, h.lng) : Infinity }));
      const near = ms.filter(x => x.m <= 100);
      if (near.length === 1) { out.push({ k: 'bm', b, h: near[0].h, m: near[0].m, sure: true }); usedB.add(b.id); }
      else if (!hasPos(b) && ms.length === 1) { out.push({ k: 'bm', b, h: ms[0].h, m: Infinity, sure: false }); usedB.add(b.id); }
    });
    for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) {
      const a = regs[i], c = regs[j];
      if (usedB.has(a.id) || usedB.has(c.id) || a.src === c.src && a.k === c.k) continue;
      if (!norm(a.name) || norm(a.name) !== norm(c.name)) continue;
      const near = hasPos(a) && hasPos(c) && dist(a.lat, a.lng, c.lat, c.lng) <= 100;
      const sameAddr = norm(a.addr) && norm(a.addr) === norm(c.addr);
      if (!near && !sameAddr) continue;
      const [p, q] = hasPos(c) && !hasPos(a) ? [c, a] : [a, c]; // 位置の分かるほうを、もとの行に
      out.push({ k: 'bb', b: p, b2: q, sure: true });
      usedB.add(a.id); usedB.add(c.id);
    }
    return out;
  }

  function render() {
    const d = st.data;
    if (!d) { setSheet(headHtml(null, '集合住宅の一覧', '') + '<p class="hint">読み込めませんでした。</p><button class="btn block" data-close>閉じる</button>'); return; }
    const blds = d.blds || [];
    const rows = uniRows();
    const cnt = { all: 0, map: 0, reg: 0, tmp: 0, ext: 0, te: 0, skip: 0, gone: 0 };
    rows.forEach(r => Object.keys(cnt).forEach(t => { if (rowIn(r, t)) cnt[t]++; }));
    const wait = blds.filter(b => stOf(b) === 'wait' && !b.same);
    const tmpB = blds.filter(b => stOf(b) === 'tmp');
    const sure = wait.map(b => ({ b, h: sureMatch(b) })).filter(x => x.h);
    const prs = pairsOf();
    if (!st.utab) st.utab = 'all';
    const tab = (k, t) => `<button type="button" data-gbt="${k}" class="${st.utab === k ? 'on' : ''}">${t}</button>`;
    setSheet(headHtml(null, '集合住宅の一覧', `${cnt.map}棟が地図に・${cnt.reg}棟がまだ`) + `
      <p class="notice" id="gbProg"${st.prog ? '' : ' hidden'}>${esc(st.prog || '')}</p>
      <p class="hint">地図の集合住宅と、外の一覧（スプレッドシート）から届いた建物の一覧です。外の一覧の建物を地図の集合住宅に<b>結ぶ</b>と1行にまとまり、次の取り込みから記録が入ります。一軒家は載せません。</p>
      <button type="button" class="btn block" id="gbAdd">＋ 集合住宅を登録（地図にまだ置かない）</button>
      ${prs.length ? `<button type="button" class="btn primary block" id="gbPairs">同じらしい組をまとめる（${prs.length}組）</button>` : ''}
      <details class="gb-more"><summary>まとめて結ぶ・外す</summary>
        ${sure.length ? `<button type="button" class="btn block" id="gbSure">候補が1つの建物をまとめて結ぶ（${sure.length}棟）</button>` : ''}
        ${wait.length ? `<button type="button" class="btn block" id="gbKari">まだの ${wait.length}棟を全部、仮で結ぶ</button>` : ''}
        ${tmpB.length ? `<button type="button" class="btn block" id="gbKariOff">仮 ${tmpB.length}棟をまとめて外す</button>` : ''}
        ${!sure.length && !wait.length && !tmpB.length ? '<p class="hint">ありません</p>' : ''}
      </details>
      <details class="gb-more"><summary>外の一覧の取り込み（鍵・届いた一覧）</summary>
        <p class="gb-src">取り込みの鍵：${d.key && d.key.has ? `あり（${esc(day(d.key.at))} に作成）` : 'まだありません'}</p>
        <div class="row"><button type="button" class="btn small" id="gbKey">${d.key && d.key.has ? '作り直す' : '鍵を作る'}</button>${d.key && d.key.has ? '<button type="button" class="btn small" id="gbKeyDel">止める</button>' : ''}</div>
        ${(d.srcs || []).length ? d.srcs.sort((a, b) => String(a.label).localeCompare(String(b.label), 'ja')).map(x => `<p class="gb-src">${esc(x.label || x.src)}：${x.n}棟・${esc(day(x.at))}</p>`).join('') : '<p class="hint">まだ一覧が届いていません。取り込み用のスプレッドシートで「今すぐ取り込む」をためしてください。</p>'}
      </details>
      <div class="gb-tabs">${tab('all', `全部 ${cnt.all}`)}${tab('map', `地図にある ${cnt.map}`)}${tab('reg', `地図にまだ無い ${cnt.reg}`)}${cnt.tmp ? tab('tmp', `仮 ${cnt.tmp}`) : ''}${tab('ext', `外の一覧から ${cnt.ext}`)}${cnt.te ? tab('te', `手で登録 ${cnt.te}`) : ''}${cnt.skip ? tab('skip', `取り込まない ${cnt.skip}`) : ''}${cnt.gone ? tab('gone', `一覧にない ${cnt.gone}`) : ''}</div>
      <input type="search" id="gbQ" value="${esc(st.q)}" placeholder="名前・住所・区域番号でさがす" aria-label="集合住宅をさがす" style="width:100%;min-height:50px;border-radius:12px;border:2px solid var(--ink2);padding:0 12px;font-size:17px;margin:4px 0 8px">
      <div id="gbRows">${listRows()}</div>
      <button type="button" class="btn block" data-close>閉じる</button>`);
    const S = $('#sheet');
    $$('[data-gbt]', S).forEach(x => x.onclick = () => { st.utab = x.dataset.gbt; sheetKeep = true; render(); });
    bindRows();
    if (st.restore != null) { S.scrollTop = st.restore; st.restore = null; }
    bindSearch($('#gbQ'), v => { st.q = v; const el = $('#gbRows'); if (el) { el.innerHTML = listRows(); bindRows(); } });
    $('#gbKey').onclick = makeKey;
    if ($('#gbKeyDel')) $('#gbKeyDel').onclick = async () => {
      if (!await ask('取り込みの鍵を止めます。取り込み用のプログラムからは送れなくなります（入れた記録は残ります）。よろしいですか？', { ok: '止める' })) return;
      try { await api('gb_key_del', {}, { timeout: 30000 }); toast('鍵を止めました'); } catch (e) { toast('止められませんでした'); }
      await load(); sheetKeep = true; render();
    };
    $('#gbAdd').onclick = () => { st.back = S.scrollTop; regForm(null); };
    if ($('#gbPairs')) $('#gbPairs').onclick = () => confirmPairs(prs);
    if ($('#gbSure')) $('#gbSure').onclick = () => confirmSure(sure);
    if ($('#gbKari')) $('#gbKari').onclick = () => confirmKari(wait);
    if ($('#gbKariOff')) $('#gbKariOff').onclick = () => kariOff(tmpB);
  }

  /* 一覧の行（タブと検索で しぼる。名前の順。多すぎるときは先頭だけ） */
  function listRows() {
    const q = norm(st.q);
    const shown = uniRows().filter(r => rowIn(r, st.utab || 'all') && rowHit(r, q))
      .sort((a, b) => rowName(a).localeCompare(rowName(b), 'ja'));
    const html = shown.slice(0, LIST_MAX).map(r => {
      const s = rowSt(r), cls = s === 'map' ? 'ok' : (s === 'wait' || s === 'lost' || s === 'tmp') ? 'wait' : '';
      if (r.k === 'm') {
        const h = r.h, t = h.terrId && terrById(h.terrId);
        const links = r.links.map(b => `${esc(b.name)}（${esc(b.label || b.src)}${stOf(b) === 'tmp' ? '・仮' : ''}）`).join('、');
        return `<div class="gb-row"><button type="button" class="gb-open" data-um="${esc(h.id)}"><span class="tx"><b>${esc(rowName(r))}${h.lock ? '　🔒' : ''}</b>
          <small>${t ? `区域${esc(t.no)}・` : ''}${h.type === 'apt' ? `${(h.units || []).length}部屋` : h.prov ? '仮の家' : '家'}</small>
          ${links ? `<small>外の一覧：${links}</small>` : ''}</span></button>
          <button type="button" class="btn small" data-uz="${esc(h.id)}">地図</button><span class="gb-st ${cls}">${U_LABEL[s]}</span></div>`;
      }
      const b = r.b;
      return `<div class="gb-row"><button type="button" class="gb-open" data-gb="${esc(b.id)}"><span class="tx"><b>${esc(rowName(r))}${b.lock ? '　🔒' : ''}</b>
        <small>${esc(subOf(b))}</small>
        <small>${esc(b.addr || '')}${r.alias.length ? `　＋同じ建物：${r.alias.map(x => esc(x.label || x.src)).join('、')}` : ''}</small></span></button>
        <span class="gb-st ${cls}">${U_LABEL[s] || ''}</span></div>`;
    }).join('');
    return (html || '<div class="empty">ありません</div>') + (shown.length > LIST_MAX ? `<p class="hint">ほかに ${shown.length - LIST_MAX}棟あります。さがして しぼってください。</p>` : '');
  }
  function bindRows() {
    const S = $('#sheet');
    $$('#gbRows [data-gb]', S).forEach(x => x.onclick = () => { st.back = S.scrollTop; openBld(x.dataset.gb); });
    $$('#gbRows [data-um]', S).forEach(x => x.onclick = () => {
      st.back = S.scrollTop;
      const h = houseById(x.dataset.um); if (!h) return;
      if (h.type === 'apt') openBuilding(h.id); else openTarget(h.id, '', false);
    });
    $$('#gbRows [data-uz]', S).forEach(x => x.onclick = () => { st.back = S.scrollTop; peekHouse(houseById(x.dataset.uz)); });
  }

  /* 地図で見る（地図の集合住宅）：その建物に印をつけて寄せ、下に「建物を開く」「一覧へ」 */
  function peekHouse(h) {
    if (!h || typeof L === 'undefined' || typeof map === 'undefined' || h.lat == null) return;
    mapOff(); closeSheet(); showView('map');
    mapLayer = L.layerGroup();
    L.circleMarker([h.lat, h.lng], { radius: 20, color: '#1d3a5a', weight: 5, fillColor: '#5B8DEF', fillOpacity: .18 })
      .bindTooltip(esc(h.label || '名前のない集合住宅'), { permanent: true, direction: 'top', offset: [0, -14], className: 'gb-pin-h', opacity: 1 }).addTo(mapLayer);
    mapLayer.addTo(map);
    const go = () => { try { map.invalidateSize(); } catch (e) { /* そのまま */ } map.setView([h.lat, h.lng], 19); };
    setTimeout(go, 200); setTimeout(go, 700);
    mapBar = document.createElement('div');
    mapBar.className = 'gb-mapbar';
    mapBar.innerHTML = `<button type="button" class="x" data-a="x" aria-label="閉じる">×</button>
      <p class="t"><b>${esc(h.label || '名前のない集合住宅')}</b></p>
      <div class="acts"><button type="button" class="btn primary" data-a="open">建物を開く</button><button type="button" class="btn" data-a="list">一覧へ</button></div>`;
    document.getElementById('map').parentElement.appendChild(mapBar);
    mapBar.onclick = e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'x') { mapOff(); return; }
      if (a.dataset.a === 'open') { mapOff(); if (h.type === 'apt') openBuilding(h.id); else openTarget(h.id, '', false); return; }
      if (a.dataset.a === 'list') { mapOff(); st.restore = st.back; open(); }
    };
  }

  /* 同じらしい組をまとめる：チェックした組を結ぶ（地図のアパート）・同じ建物にする（地図にまだ無いものどうし） */
  function confirmPairs(list) {
    setSheet(headHtml(null, '同じらしい組をまとめる', `${list.length}組`) + `
      <p class="hint">名前が同じで近い組です（地図の集合住宅の名前は、人が付けたものだけで比べます）。ちがう組はチェックを外してください。</p>
      <div class="gb-tabs" style="margin-bottom:4px">
        <label class="check"><input type="radio" name="gbFit" value="keep" checked>地図の建物の名前・部屋のまま</label>
        <label class="check"><input type="radio" name="gbFit" value="fit">一覧の名前・部屋に合わせる</label>
      </div>
      <div>${list.map((x, i) => `<label class="tk-del"><input type="checkbox" data-gbpr="${i}"${x.sure ? ' checked' : ''}><span class="tx">
        <b>${esc(x.b.name)}</b><small>${esc(x.b.label || x.b.src)}</small>
        <small>${x.k === 'bm' ? `＝ 地図の「${esc(x.h.label)}」${isFinite(x.m) ? `（${fmtM(x.m)}）` : '（位置が分からないので、名前だけで選びました）'}` : `＝ ${esc(x.b2.label || x.b2.src)} の「${esc(x.b2.name)}」（地図にまだ無いものどうし）`}</small></span></label>`).join('')}</div>
      <button type="button" class="btn primary block" id="gbPrGo">チェックした組をまとめる</button>
      <button type="button" class="btn block" id="gbPrBack">もどる</button>`);
    $('#gbPrBack').onclick = () => render();
    $('#gbPrGo').onclick = async () => {
      const on = [...$$('[data-gbpr]', $('#sheet'))].filter(c => c.checked).map(c => list[+c.dataset.gbpr]);
      if (!on.length) return;
      const fit = ($('input[name="gbFit"]:checked') || {}).value === 'fit';
      const bm = on.filter(x => x.k === 'bm'), bb = on.filter(x => x.k === 'bb');
      $('#gbPrGo').disabled = true;
      if (bb.length) {
        try {
          await api('gb_same', { items: bb.map(x => ({ id: x.b2.id, same: x.b.id })) }, { timeout: 60000 });
          bb.forEach(x => { x.b2.same = x.b.id; });
        } catch (e) { toast(e && e.code === 'unknown_action' ? 'サーバーがまだ新しくなっていません' : 'まとめられませんでした'); }
      }
      if (bm.length) await link(bm.map(x => fit ? { id: x.b.id, hid: x.h.id, apply: true } : { id: x.b.id, hid: x.h.id }), `${on.length}組をまとめました`);
      else { toast(`${on.length}組をまとめました`); await load(true); sheetKeep = true; render(); }
    };
  }

  async function makeKey() {
    const had = st.data && st.data.key && st.data.key.has;
    if (had && !await ask('鍵を作り直すと、今の鍵は使えなくなります。取り込み用のプログラムの鍵も入れ直してください。よろしいですか？', { ok: '作り直す' })) return;
    let key = '';
    try { key = (await api('gb_key', {}, { timeout: 30000 })).key; } catch (e) { toast('鍵を作れませんでした'); return; }
    setSheet(headHtml(null, '取り込みの鍵', '') + `
      <p>取り込み用のスプレッドシートの「拡張機能 → Apps Script → プロジェクトの設定 → スクリプト プロパティ」に、
        プロパティ <b>KUIKI_KEY</b>、値に下の鍵を入れてください。</p>
      <div class="gb-key" id="gbKeyTxt">${esc(key)}</div>
      <div class="row"><button type="button" class="btn small" id="gbCopy">コピー</button></div>
      <div class="notice warn">この鍵は、この画面を閉じると二度と表示されません。チャット・メール・ファイルには貼らないでください。なくしたときは作り直します。</div>
      <button type="button" class="btn block" id="gbBack">もどる</button>`);
    $('#gbCopy').onclick = async () => { try { await navigator.clipboard.writeText(key); toast('コピーしました'); } catch (e) { toast('コピーできませんでした。長押しで選んでください'); } };
    $('#gbBack').onclick = async () => { key = ''; await load(); render(); };
  }

  function confirmSure(list) {
    setSheet(headHtml(null, 'まとめて結ぶ', `${list.length}棟`) + `
      <p class="hint">名前が同じか、すぐ近くにアパートが1つだけある建物です。ちがうものはチェックを外してください。</p>
      <div>${list.map((x, i) => `<label class="tk-del"><input type="checkbox" data-gbs="${i}" checked><span class="tx"><b>${esc(x.b.name)}</b>
        <small>→ ${esc(x.h.label || '名前のない家')}${hasPos(x.b) ? `（${Math.round(dist(x.b.lat, x.b.lng, x.h.lat, x.h.lng))}m）` : ''}${x.h.type !== 'apt' ? '・家（アパートになります）' : ''}</small></span></label>`).join('')}</div>
      <button type="button" class="btn primary block" id="gbSureGo">チェックした建物を結ぶ</button>
      <button type="button" class="btn block" id="gbSureBack">もどる</button>`);
    $('#gbSureBack').onclick = () => render();
    $('#gbSureGo').onclick = async () => {
      const items = [...$$('[data-gbs]', $('#sheet'))].filter(c => c.checked).map(c => list[+c.dataset.gbs]).map(x => ({ id: x.b.id, hid: x.h.id }));
      if (!items.length) return;
      await link(items, `${items.length}棟を結びました。次の取り込みで記録が入ります`);
    };
  }

  async function confirmKari(list) {
    setSheet(headHtml(null, '全部、仮で結ぶ', `${list.length}棟`) + '<p class="notice" id="gbProg">住所から位置を調べています…</p><p class="hint">調べ終わると、結ぶ建物の数が出ます。</p>');
    await chibanPass().catch(() => 0);
    list = list.map(b => (st.data.blds || []).find(x => x.id === b.id) || b);
    const plan = kariPlan(list), go = plan.filter(x => x.how === 'apt' || x.how === 'prov' || x.how === 'make');
    const n = { apt: 0, prov: 0, make: 0, nopos: 0, busy: 0 };
    plan.forEach(x => { n[x.how]++; });
    setSheet(headHtml(null, '全部、仮で結ぶ', `${list.length}棟`) + `
      <p>まだ結んでいない建物を、まとめて仮で結びます。次の取り込みで、地図に記録が出ます。</p>
      <ul>
        <li>近く（${KARI_APT_M}m 以内）のアパートに結ぶ：<b>${n.apt}棟</b>（名前が同じものを先に）</li>
        <li>近く（${KARI_PROV_M}m 以内）の仮の家に結ぶ（アパートになります）：<b>${n.prov}棟</b></li>
        <li>建物の場所に新しいアパートを置いて結ぶ：<b>${n.make}棟</b></li>
        ${n.busy ? `<li>近くの家に、もうほかの一覧の建物が結ばれているので、まだ のまま：<b>${n.busy}棟</b></li>` : ''}
        ${n.nopos ? `<li>位置が分からない・あやしいので、まだ のまま：<b>${n.nopos}棟</b>（「位置を地図で直す」で置けます）</li>` : ''}
      </ul>
      <p class="hint">1つの家には1棟だけ結びます。あとで「仮」のタブで1棟ずつ確かめ、「これでよい」か、ほかの家に結び直してください。結び直すと、記録もそちらに移ります。ふつうの家（戸建て）は、アパートに変えません。</p>
      <button type="button" class="btn primary block" id="gbKariGo"${go.length ? '' : ' disabled'}>${go.length}棟を仮で結ぶ</button>
      <button type="button" class="btn block" id="gbKariBack">もどる</button>`);
    $('#gbKariBack').onclick = () => render();
    $('#gbKariGo').onclick = async () => {
      $('#gbKariGo').disabled = true;
      const items = go.map(x => x.h ? { id: x.b.id, hid: x.h.id, tmp: true }
        : { id: x.b.id, make: true, tmp: true, terrId: typeof terrOf === 'function' ? terrOf(x.b.lat, x.b.lng) : null });
      let ok = 0, bad = 0, made = 0;
      for (let i = 0; i < items.length; i += 100) {
        toast(`仮で結んでいます… ${i}／${items.length}（終わるまで、アプリを閉じずにお待ちください）`);
        try {
          const r = await api('gb_link', { items: items.slice(i, i + 100) }, { timeout: 120000 });
          ok += r.n || 0; bad += (r.bad || []).length; made += (r.made || []).length;
        } catch (e) { bad += Math.min(100, items.length - i); }
      }
      if (made) await pullNow(); // サーバーで作ったアパートを読みにいく
      toast(`${ok}棟を仮で結びました${bad ? `（${bad}棟は結べませんでした）` : ''}。次の取り込みで記録が入ります`);
      st.utab = 'tmp';
      await load(); await linkAliases(); sheetKeep = true; render();
    };
  }

  /* 仮で結んだ建物を、まとめて外す（まだ にもどす）。その建物から入れた記録は、次の取り込みで消える */
  async function kariOff(list) {
    if (!list.length) return;
    if (!await ask(`仮で結んだ ${list.length}棟を、まとめて外します（まだ にもどします）。その建物から入れた記録は、次の取り込みで消えます。「これでよい」を押した建物はそのままです。よろしいですか？`, { ok: '外す' })) return;
    list.forEach(b => Object.assign(b, { hid: '', tmp: false }));
    st.utab = 'reg'; sheetKeep = true; render();
    let bad = 0;
    for (let i = 0; i < list.length; i += 100) {
      toast(`外しています… ${i}／${list.length}（終わるまで、アプリを閉じずにお待ちください）`);
      try { const r = await api('gb_link', { items: list.slice(i, i + 100).map(b => ({ id: b.id, hid: '' })) }, { timeout: 120000 }); bad += (r.bad || []).length; }
      catch (e) { bad += Math.min(100, list.length - i); }
    }
    toast(bad ? `${list.length - bad}棟を外しました（${bad}棟は外せませんでした）` : `${list.length}棟を外しました。記録は次の取り込みで消えます`);
    refresh();
  }

  /* 同じ建物とまとめた行（same）を、相手が結んだ家に結ぶ（仮で結ぶのあとなど） */
  async function linkAliases() {
    const bl = (st.data && st.data.blds) || [];
    const items = bl.filter(x => x.same && !x.skip).map(x => ({ x, p: bl.find(y => y.id === x.same) }))
      .filter(o => o.p && o.p.hid && houseById(o.p.hid) && o.x.hid !== o.p.hid).map(o => ({ id: o.x.id, hid: o.p.hid, tmp: !!o.p.tmp }));
    if (!items.length) return;
    try { await api('gb_link', { items }, { timeout: 60000 }); await load(true); } catch (e) { /* 次にまた */ }
  }

  /* 結ぶ・外す。新しく置くとき以外は、手元の一覧をすぐ直して先へ進み、サーバーへはうしろで送る
     next：手元を直したあとにすること（なければ一覧の画面） */
  async function link(items, msg, next) {
    const go = next || (() => { st.restore = st.back; sheetKeep = true; render(); });
    // 同じ建物とまとめた行（same）も、一緒に結ぶ・外す。新しく置くときは、置いた家の id が分かってから
    const bl = (st.data && st.data.blds) || [], later = [];
    items = items.flatMap(it => {
      const al = bl.filter(x => x.same === it.id && x.id !== it.id);
      if (!al.length) return [it];
      if (it.make) { al.forEach(x => later.push({ from: it.id, id: x.id, tmp: !!it.tmp })); return [it]; }
      return [it].concat(al.map(x => Object.assign({}, it, { id: x.id, apply: false })));
    });
    if (items.some(it => it.make || it.apply)) { // 新しく置く・家を一覧に合わせる：サーバーの返事を待って、家を読み直す
      toast('結んでいます…（少し待ってください）');
      try {
        const r = await api('gb_link', { items }, { timeout: 60000 });
        toast(r.bad && r.bad.length ? `${r.n}棟を結びました（${r.bad.length}棟は結べませんでした）` : msg);
        if (r.applied) await pullNow();
        if (later.length && r.madeIds) {
          const more = later.filter(x => r.madeIds[x.from]).map(x => ({ id: x.id, hid: r.madeIds[x.from], tmp: x.tmp }));
          if (more.length) { try { await api('gb_link', { items: more }, { timeout: 60000 }); } catch (e) { /* 次に一覧を開いたとき、結び直せる */ } }
        }
        if (r.made && r.made.length) await pullNow(); // サーバーで作ったアパートを読みにいく
      } catch (e) { toast('結べませんでした。あとでもう一度ためしてください'); }
      await load(true); go(); return;
    }
    items.forEach(it => {
      const b = (st.data.blds || []).find(x => x.id === it.id);
      if (b) Object.assign(b, { hid: it.skip ? '' : (it.hid || ''), skip: !!it.skip, tmp: !!(it.tmp && it.hid && !it.skip) });
    });
    toast(msg);
    go();
    api('gb_link', { items }, { timeout: 60000 })
      .then(r => { if (r.bad && r.bad.length) { toast(`${r.bad.length}棟は結べませんでした`); refresh(); } })
      .catch(() => { toast('結べませんでした。あとでもう一度ためしてください'); refresh(); });
  }

  /* ---------- 地図で見る：結んだ家（または候補）と、一覧の位置に印をつけ、下に戻るボタンを出す ---------- */
  let mapLayer = null, mapBar = null;
  function mapOff() {
    if (mapLayer) { try { map.removeLayer(mapLayer); } catch (e) { /* もう無い */ } mapLayer = null; }
    if (mapBar) { mapBar.remove(); mapBar = null; }
    if (cross) { cross.remove(); cross = null; }
  }
  const nextTmp = after => (st.data.blds || []).find(x => x.id !== after && stOf(x) === 'tmp');
  function showOnMap(b, h) {
    if (typeof L === 'undefined' || typeof map === 'undefined' || !h || h.lat == null) return;
    mapOff();
    if (document.getElementById('sheet') && !$('#sheet').hidden) closeSheet();
    showView('map');
    const isCur = b.hid === h.id, tmp = isCur && stOf(b) === 'tmp';
    const hp = [h.lat, h.lng], bp = hasPos(b) ? [b.lat, b.lng] : null;
    const m = bp ? Math.round(dist(b.lat, b.lng, h.lat, h.lng)) : null;
    const tip = (cls, t) => ({ permanent: true, direction: 'top', offset: [0, -14], className: cls, opacity: 1 });
    mapLayer = L.layerGroup();
    if (bp && m > 3) {
      L.polyline([bp, hp], { color: '#9A5B12', weight: 3, dashArray: '6 6', interactive: false }).addTo(mapLayer);
      L.circleMarker(bp, { radius: 10, color: '#9A5B12', weight: 3, dashArray: '4 4', fillColor: '#FFF4E5', fillOpacity: .7 })
        .bindTooltip('一覧の位置', tip('gb-pin-b')).addTo(mapLayer);
    }
    L.circleMarker(hp, { radius: 20, color: '#1d3a5a', weight: 5, fillColor: '#5B8DEF', fillOpacity: .18 })
      .bindTooltip(esc(isCur ? '結んだ家' : '候補') + '：' + esc(h.label || '名前のない家'), tip('gb-pin-h')).addTo(mapLayer);
    mapLayer.addTo(map);
    // 地図の画面に切りかえた直後は大きさが決まっていないので、少し待って寄せ、もう一度寄せ直す（下の帯にかくれないよう余白をとる）
    const fit = () => {
      try { map.invalidateSize(); } catch (e) { /* そのまま */ }
      if (bp && m > 15) map.fitBounds(L.latLngBounds([bp, hp]), { paddingTopLeft: [50, 150], paddingBottomRight: [50, 230], maxZoom: 19 });
      else map.setView(hp, 19);
    };
    setTimeout(fit, 200);
    setTimeout(fit, 700);
    const host = document.getElementById('map').parentElement;
    mapBar = document.createElement('div');
    mapBar.className = 'gb-mapbar';
    mapBar.innerHTML = `<button type="button" class="x" data-a="x" aria-label="閉じる">×</button>
      <p class="t">一覧：<b>${esc(b.name || '（名前なし）')}</b><br>${isCur ? (tmp ? '仮で結んだ家' : '結んだ家') : '候補'}：<b>${esc(h.label || '名前のない家')}</b>${m != null ? `（一覧の位置から ${m}m）` : ''}</p>
      <div class="acts">
        ${tmp ? '<button type="button" class="btn primary" data-a="ok">これでよい</button>' : ''}
        ${!isCur ? '<button type="button" class="btn primary" data-a="link">ここに結ぶ</button>' : ''}
        ${h.type === 'apt' && typeof openBuilding === 'function' ? '<button type="button" class="btn" data-a="room">部屋</button>' : ''}
        ${gmapBtn(b, '')}
        <button type="button" class="btn" data-a="pos">位置を直す</button>
        <button type="button" class="btn" data-a="bld">ほかを選ぶ</button>
        <button type="button" class="btn" data-a="list">一覧へ</button>
      </div>`;
    host.appendChild(mapBar);
    mapBar.onclick = async e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      const act = a.dataset.a;
      if (act === 'x') { mapOff(); return; }
      if (act === 'room') { openBuilding(h.id); return; }
      if (act === 'bld') { mapOff(); openBld(b.id); return; }
      if (act === 'pos') { fixPos(b, () => showOnMap((st.data.blds || []).find(x => x.id === b.id) || b, h)); return; }
      if (act === 'list') { mapOff(); st.restore = st.back; open(); return; }
      if (act === 'ok') {
        const n = nextTmp(b.id);
        await link([{ id: b.id, hid: b.hid }], n ? '仮を外しました。次の建物です' : '仮を外しました。仮の建物はもうありません', () => {
          if (n && houseById(n.hid)) showOnMap(n, houseById(n.hid)); else { mapOff(); open(); }
        });
        return;
      }
      if (act === 'link') {
        if (h.type !== 'apt' && !await ask('この家はアパートではありません。結ぶと、次の取り込みでアパートになり、一覧の部屋が入ります。よろしいですか？', { ok: '結ぶ' })) return;
        await link([{ id: b.id, hid: h.id, apply: true }], '結んで確定しました。名前と部屋を一覧に合わせました（記録は次の取り込みで入ります）', () => showOnMap((st.data.blds || []).find(x => x.id === b.id) || b, h));
      }
    };
  }

  function openBld(id) {
    const b = (st.data.blds || []).find(x => x.id === id);
    if (!b) return;
    const s = stOf(b), cur = b.hid ? houseById(b.hid) : null;
    const cs = candidates(b).filter(c => !cur || c.h.id !== cur.id);
    const tOf = h => (h.terrId && terrById(h.terrId) ? `区域${terrById(h.terrId).no}・` : '');
    setSheet(headHtml(null, esc(b.name || '（名前なし）'), esc(subOf(b))) + `
      <p class="gb-src">${esc(b.addr || '住所なし')}${b.lock ? '・オートロック' : ''}　${gmapBtn(b)}</p>
      ${(() => {
        const bl = st.data.blds || [], p = b.same ? bl.find(x => x.id === b.same) : null, al = bl.filter(x => x.same === b.id);
        if (p) return `<div class="notice">「${esc(p.name)}」（${esc(p.label || p.src)}）と同じ建物としてまとめています。結ぶときは一緒に結ばれます。<button type="button" class="btn small" data-gbun="${esc(b.id)}">分ける</button></div>`;
        if (al.length) return `<div class="notice">同じ建物：${al.map(x => `${esc(x.name)}（${esc(x.label || x.src)}）<button type="button" class="btn small" data-gbun="${esc(x.id)}">分ける</button>`).join('　')}</div>`;
        return '';
      })()}
      ${b.ed ? `<p class="gb-src">直した値（一覧：${esc(b.oname || 'なし')}・${esc(b.oaddr || 'なし')}）</p>` : ''}
      ${b.laddr && norm(b.laddr) !== norm(b.addr) ? `<p class="gb-src">一覧のリンクの住所：${esc(b.laddr)}</p>` : ''}
      <p class="gb-src">位置：${esc(PF_LABEL[b.pf || ''])}${b.far ? `<br><b>一覧の位置が、地番の地図の位置と ${b.far}m はなれています。</b>` : ''}</p>
      <button type="button" class="btn${hasPos(b) && !b.far ? '' : ' primary'} block" id="gbFix">位置を地図で直す</button>
      ${isTe(b) ? `<p class="gb-src">部屋：${esc((b.rooms || []).slice(0, 12).join('・'))}${(b.rooms || []).length > 12 ? '…' : ''}${b.ac === 'ev' ? '・エレベーターあり' : ''}${b.ban === 'no' ? '・立入禁止' : b.ban === 'letter' ? '・手紙のみ' : ''}</p>
        <button type="button" class="btn block" id="gbReg">登録した内容（名前・住所・部屋など）を直す</button>` : ''}
      <button type="button" class="btn block" id="gbEdit">${isTe(b) ? '位置（緯度・経度）を直す' : '名前・住所・位置（緯度・経度）を直す'}</button>
      ${s === 'tmp' && cur ? `<div class="notice warn">仮で結んでいます：<b>${esc(cur.label || '名前のない家')}</b>（${esc(tOf(cur))}${cur.type === 'apt' ? 'アパート' : '家'}）。地図で確かめて、よければ「これでよい」を押してください。</div>
        <button type="button" class="btn primary block" id="gbOkTmp">これでよい（仮を外す）</button>
        <button type="button" class="btn block" data-gbmap="${esc(cur.id)}">結んだ家を地図で見る（一覧の位置と並べて）</button>` : ''}
      ${s === 'ok' && cur ? `<div class="notice">結んだ家：<b>${esc(cur.label || '名前のない家')}</b>（${esc(tOf(cur))}${cur.type === 'apt' ? 'アパート' : '家'}）</div>
        <button type="button" class="btn block" data-gbmap="${esc(cur.id)}">結んだ家を地図で見る</button>` : ''}
      ${s === 'lost' ? '<div class="notice warn">結んだ家が、もうアプリにありません。結び直してください。</div>' : ''}
      ${s === 'skip' ? '<div class="notice">取り込まない建物です。</div>' : ''}
      ${s === 'gone' ? '<div class="notice">今の一覧にはありません（前に入れた記録は残っています）。</div>' : ''}
      ${b.res && b.res.dup ? `<p class="hint">アプリで入れた記録と同じ部屋・同じ日のもの ${b.res.dup}件は、入れていません。</p>` : ''}
      <h3 class="sub">${cur ? 'ほかの候補' : '候補'}</h3>
      <div>${cs.map(c => `<div class="gb-row" style="cursor:default"><span class="tx"><b>${esc(c.h.label || '名前のない家')}${c.same ? '　（名前が同じ）' : ''}</b>
        <small>${esc(tOf(c.h))}${c.h.type === 'apt' ? `アパート・${(c.h.units || []).length}部屋` : c.h.prov ? '仮の家' : '家'}${isFinite(c.m) ? `・${Math.round(c.m)}m` : ''}</small></span>
        <button type="button" class="btn small" data-gbmap="${esc(c.h.id)}">地図</button><button type="button" class="btn small primary" data-gbl="${esc(c.h.id)}">結ぶ</button></div>`).join('') || '<p class="hint">近くに家がありません。</p>'}</div>
      ${hasPos(b) ? '<button type="button" class="btn block" id="gbMake">この場所に新しいアパートを置いて結ぶ</button>' : ''}
      ${s !== 'skip' && !isTe(b) ? '<button type="button" class="btn block" id="gbSkip">この建物は取り込まない</button>' : ''}
      ${b.hid || b.skip ? `<button type="button" class="btn block" id="gbUnlink">${isTe(b) ? '結びつきを外す（地図の家はそのまま）' : '結びつきを外す（まだ にもどす・入れた記録は次の取り込みで消える）'}</button>` : ''}
      ${isTe(b) ? '<button type="button" class="btn danger block" id="gbDel">この登録を消す（地図の家は消えません）</button>' : ''}
      <button type="button" class="btn block" id="gbBack">もどる</button>`);
    const S = $('#sheet');
    $$('[data-gbl]', S).forEach(x => x.onclick = async () => {
      const h = houseById(x.dataset.gbl);
      if (h && h.type !== 'apt' && !await ask('この家はアパートではありません。結ぶと、次の取り込みでアパートになり、一覧の部屋が入ります。よろしいですか？', { ok: '結ぶ' })) return;
      await link([{ id: b.id, hid: x.dataset.gbl, apply: true }], isTe(b) ? '結んで確定しました。名前と部屋を登録に合わせました' : '結んで確定しました。名前と部屋を一覧に合わせました（記録は次の取り込みで入ります）');
    });
    $$('[data-gbmap]', S).forEach(x => x.onclick = () => showOnMap(b, houseById(x.dataset.gbmap)));
    if ($('#gbOkTmp')) $('#gbOkTmp').onclick = async () => {
      const n = nextTmp(b.id); // 続けて次の仮へ
      await link([Object.assign({ id: b.id, hid: b.hid }, isTe(b) ? { apply: true } : {})], n ? '仮を外しました。次の建物です' : '仮を外しました', n ? () => openBld(n.id) : null); // 手で登録した建物は取り込みが無いので、ここで家を登録に合わせる
    };
    if ($('#gbMake')) $('#gbMake').onclick = async () => {
      if (!await ask(`「${b.name}」の場所に、新しいアパートを置いて結びます。近くに同じ建物があるときは、そちらを結んでください。よろしいですか？`, { ok: '置いて結ぶ' })) return;
      await link([{ id: b.id, make: true, terrId: typeof terrOf === 'function' ? terrOf(b.lat, b.lng) : null }], isTe(b) ? '新しいアパートを置いて結びました。登録した部屋が入っています' : '新しいアパートを置いて結びました。次の取り込みで部屋と記録が入ります');
    };
    if ($('#gbSkip')) $('#gbSkip').onclick = async () => {
      if (b.hid && !await ask('この建物を取り込まないことにします。前に入れた記録は、次の取り込みで消えます（アプリで入れた記録は残ります）。よろしいですか？', { ok: '取り込まない' })) return;
      await link([{ id: b.id, skip: true }], '取り込まない建物にしました');
    };
    if ($('#gbUnlink')) $('#gbUnlink').onclick = async () => {
      await link([{ id: b.id, hid: '' }], '結びつきを外しました。入れた記録は、次の取り込みで消えます');
    };
    $('#gbFix').onclick = () => fixPos(b, () => openBld(b.id));
    $$('[data-gbun]', S).forEach(x => x.onclick = async () => {
      const t = (st.data.blds || []).find(y => y.id === x.dataset.gbun); if (!t) return;
      try { await api('gb_same', { items: [{ id: t.id, same: '' }] }, { timeout: 30000 }); t.same = ''; toast('分けました'); }
      catch (e) { toast('分けられませんでした'); }
      openBld(b.id);
    });
    $('#gbEdit').onclick = () => editBld(b);
    if ($('#gbReg')) $('#gbReg').onclick = () => regForm(b);
    if ($('#gbDel')) $('#gbDel').onclick = async () => {
      if (!await ask(`「${b.name || '（名前なし）'}」の登録を、集合住宅の一覧から消します。${b.hid && houseById(b.hid) ? '結んでいる地図の家は、そのまま残ります。' : ''}よろしいですか？`, { ok: '消す' })) return;
      try { await api('gb_del', { id: b.id }, { timeout: 30000 }); toast('消しました'); }
      catch (e) { toast('消せませんでした。あとでもう一度ためしてください'); return; }
      await load(true); st.restore = st.back; sheetKeep = true; render();
    };
    lookupThen(b, () => { if ($('#gbEdit') && $('#sheet').dataset.gbBld === b.id) openBld(b.id); });
    $('#sheet').dataset.gbBld = b.id;
    $('#gbBack').onclick = () => { st.restore = st.back; sheetKeep = true; render(); };
  }

  /* ---------- 手で登録する（区域係）：アプリで集合住宅を作るときと同じ画面（apt-wizard.js）で、地図には置かずに一覧へ ----------
     b：直すときの行（無ければ新しく） */
  function regForm(b) {
    if (!window.openAptWizard) { toast('この画面では登録できません。アプリを読み込み直してください'); return; }
    const back = () => b ? openBld(b.id) : (st.restore = st.back, sheetKeep = true, render());
    const v = b ? { name: b.oname || b.name, addr: b.oaddr || b.addr, rooms: b.rooms || [], lock: !!b.lock, ac: b.ac || '', bn: b.bn || '', ban: b.ban || '' } : null;
    window.openAptWizard(null, { reg: {
      v,
      onClose: back,
      onSave: async item => {
        if (b) item.id = b.id;
        toast('登録しています…');
        let r;
        try { r = await api('gb_add', { item }, { timeout: 30000 }); } catch (e) { r = null; }
        if (!r || !r.ok) { toast('登録できませんでした。あとでもう一度ためしてください'); return; }
        await load(true);
        const nb = (st.data.blds || []).find(x => x.id === r.id);
        if (nb && b && (b.oaddr || b.addr) !== item.addr) nb.cbDone = false; // 新しい住所で位置を調べ直す
        toast(b ? '直しました' : '集合住宅の一覧に登録しました。地図に置くときは「位置」と「候補」を見てください');
        if (nb) openBld(nb.id); else back();
      }
    } });
  }

  /* 位置が無く、まだ住所から調べていない建物なら、調べてから then を呼ぶ */
  function lookupThen(b, then) {
    if (hasPos(b) || b.cbDone || !(b.laddr || b.addr)) return;
    chibanPass().then(n => { if (n && hasPos(b)) then(); }).catch(() => 0);
  }

  /* ---------- 名前・住所・位置（緯度・経度）を直す ---------- */
  /* 「35.123, 139.456」「35.123 139.456」などを読む。緯度・経度の欄に分けて入れてもよい */
  function readLatLng(a, b) {
    const t = (String(a || '') + ' ' + String(b || '')).normalize('NFKC').replace(/[、，]/g, ',');
    const ns = (t.match(/-?\d{1,3}(?:\.\d+)?/g) || []).map(Number);
    if (ns.length < 2) return null;
    let [lat, lng] = ns;
    if (lat > 90 && lng <= 90) [lat, lng] = [lng, lat]; // 経度・緯度の順で入れたとき
    if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) return null; // 日本の中だけ
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }
  function editBld(b) {
    const fx = b.fix && b.fix.from === 'hand' ? b.fix : null;
    const r6 = x => Math.round(x * 1e6) / 1e6, curPos = hasPos(b) ? `${r6(b.lat)}, ${r6(b.lng)}` : ''; // 今使っている位置（どこから来た位置でも）
    const te = isTe(b); // 手で登録した建物の名前・住所は、登録した内容を直す画面で直す
    setSheet(headHtml(null, te ? '位置を直す' : '名前・住所・位置を直す', esc(b.label || b.src)) + `
      ${te ? '' : `<p class="hint">仮で結ぶとき・候補をさがすときに使う値です。直した値は、取り込みのたびに一覧の値で上書きされません。空にすると一覧のとおりにもどります。訪問の記録には関係しません。</p>
      <label class="field"><span>名前</span><input type="text" id="gbEN" value="${esc(b.ed && b.ed.name || '')}" placeholder="${esc(b.oname || '（一覧に名前なし）')}" maxlength="40"></label>
      <p class="gb-src">一覧：${esc(b.oname || '（なし）')}</p>
      <label class="field"><span>住所</span><input type="text" id="gbEA" value="${esc(b.ed && b.ed.addr || '')}" placeholder="${esc(b.oaddr || '（一覧に住所なし）')}" maxlength="80"></label>
      <p class="gb-src">一覧：${esc(b.oaddr || '（なし）')}${b.laddr ? `　／　一覧のリンク：${esc(b.laddr)}` : ''}</p>`}
      <label class="field"><span>位置（緯度, 経度）</span><input type="text" id="gbEL" inputmode="decimal" value="${esc(curPos)}" placeholder="例：35.401234, 139.471234"></label>
      <p class="gb-src">今の位置：${esc(PF_LABEL[b.pf || ''])}。数字を変えて保存すると「手で直した位置」になります。${fx ? '空にして保存すると、手で直した位置を消し、自動の位置（リンクのピン・住所から調べた位置）にもどります。' : ''}</p>
      <p class="hint" id="gbEErr" hidden></p>
      <button type="button" class="btn primary block" id="gbESave">保存する</button>
      <button type="button" class="btn block" id="gbEMap">地図で位置を直す</button>
      ${(b.ed && !te) || fx ? `<button type="button" class="btn block" id="gbEReset">${te ? '手で入れた位置を消す' : '一覧のとおりにもどす'}</button>` : ''}
      <button type="button" class="btn block" id="gbEBack">もどる</button>`);
    const err = t => { const e = $('#gbEErr'); e.textContent = t; e.hidden = !t; };
    $('#sheet').dataset.gbBld = '';
    lookupThen(b, () => { // まだ調べていなければ、ここで住所から調べ、分かったら欄に入れる
      const el = $('#gbEL');
      if (el && !el.value && hasPos(b)) { el.value = `${Math.round(b.lat * 1e6) / 1e6}, ${Math.round(b.lng * 1e6) / 1e6}`; toast('住所から位置が分かりました'); }
    });
    $('#gbEBack').onclick = () => openBld(b.id);
    $('#gbEMap').onclick = () => fixPos(b, () => openBld(b.id));
    const save = async (name, addr, posText) => {
      let pos = null;
      if (posText && posText === curPos) posText = '__same__'; // 位置は変えていない
      if (posText && posText !== '__same__') { pos = readLatLng(posText); if (!pos) { err('緯度・経度が読めません。「35.401234, 139.471234」のように、緯度・経度の順に入れてください。'); return; } }
      const near = hasPos(b) ? b : b.llat != null ? { lat: b.llat, lng: b.llng } : null;
      if (pos && near && dist(pos.lat, pos.lng, near.lat, near.lng) > 3000
        && !await ask(`入れた位置は、今の位置から ${fmtM(dist(pos.lat, pos.lng, near.lat, near.lng))} はなれています。このままでよいですか？`, { ok: 'このまま保存' })) return;
      const addrChanged = (b.ed && b.ed.addr || '') !== addr;
      toast('保存しています…');
      try {
        const r = await api('gb_edit', { items: [{ id: b.id, name, addr }] }, { timeout: 30000 });
        if (r.bad && r.bad.length) throw new Error('bad');
        b.ed = name || addr ? { name, addr } : null;
        if (addrChanged && b.fix && b.fix.from !== 'hand') b.fix = null;
        if (pos) {
          await api('gb_pos', { items: [{ id: b.id, lat: pos.lat, lng: pos.lng, from: 'hand' }] }, { timeout: 30000 });
          b.fix = { lat: pos.lat, lng: pos.lng, from: 'hand' };
        } else if (fx && !posText) { // 欄を空にした：手で直した位置を消す
          await api('gb_pos', { items: [{ id: b.id, clear: true }] }, { timeout: 30000 });
          b.fix = null;
        }
      } catch (e) { toast(e && e.code === 'unknown_action' ? 'サーバーがまだ新しくなっていません' : '保存できませんでした。あとでもう一度ためしてください'); return; }
      b.cbDone = false; // 新しい住所で調べ直す
      prep();
      toast('保存しました');
      openBld(b.id);
      if (!hasPos(b)) chibanPass().then(n => { if (n && $('#gbFix')) openBld(b.id); });
    };
    const ed0 = b.ed || {}, val = (sel, d) => $(sel) ? $(sel).value.trim() : d;
    $('#gbESave').onclick = () => save(val('#gbEN', ed0.name || ''), val('#gbEA', ed0.addr || ''), $('#gbEL').value.trim());
    if ($('#gbEReset')) $('#gbEReset').onclick = async () => {
      if (!await ask(te ? '手で入れた位置を消し、住所から調べた位置にもどします。よろしいですか？' : '名前・住所・手で入れた位置を、一覧のとおりにもどします。よろしいですか？', { ok: 'もどす' })) return;
      save('', '', '');
    };
  }

  /* ---------- 位置を地図で直す：地図を動かして、建物を十字の真ん中に合わせ「ここにする」 ---------- */
  let cross = null, baseBefore = null;
  function fixPos(b, back) {
    if (typeof L === 'undefined' || typeof map === 'undefined') return;
    mapOff();
    closeSheet();
    showView('map');
    const hh = b.hid ? houseById(b.hid) : null;
    const start = hasPos(b) ? [b.lat, b.lng] : b.llat != null ? [b.llat, b.llng] : hh && hh.lat != null ? [hh.lat, hh.lng] : null;
    const go = () => { try { map.invalidateSize(); } catch (e) { /* そのまま */ } if (start) map.setView(start, 19); };
    setTimeout(go, 200);
    setTimeout(go, 700); // 地図に切りかえた直後は大きさが決まっていないので、寄せ直す
    const host = document.getElementById('map').parentElement;
    cross = document.createElement('div');
    cross.className = 'gb-cross';
    host.appendChild(cross);
    baseBefore = typeof baseName !== 'undefined' ? baseName : null;
    mapBar = document.createElement('div');
    mapBar.className = 'gb-mapbar';
    mapBar.innerHTML = `<button type="button" class="x" data-a="x" aria-label="やめる">×</button>
      <p class="t"><b>${esc(b.name || '（名前なし）')}</b> の位置<br>地図を動かして、建物を十字の真ん中に合わせてください。</p>
      <div class="acts">
        <button type="button" class="btn primary" data-a="set">ここにする</button>
        ${typeof setBase === 'function' ? '<button type="button" class="btn" data-a="photo">写真／地図</button>' : ''}
        ${gmapBtn(b, '')}
        ${b.fix && b.fix.from === 'hand' ? '<button type="button" class="btn" data-a="clear">手で直した位置を消す（自動の位置にもどす）</button>' : ''}
      </div>`;
    host.appendChild(mapBar);
    const done = () => { if (baseBefore && typeof setBase === 'function') setBase(baseBefore); mapOff(); back(); };
    mapBar.onclick = async e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      const act = a.dataset.a;
      if (act === 'x') { done(); return; }
      if (act === 'photo') { setBase(baseName === 'photo' ? 'pale' : 'photo'); return; }
      if (act === 'clear') { // 手で直した位置だけを消し、自動の位置（リンクのピン・住所から調べた位置）を調べ直す
        b.fix = null; b.cbDone = false; prep();
        try { await api('gb_pos', { items: [{ id: b.id, clear: true }] }, { timeout: 30000 }); }
        catch (err) { toast('消せませんでした。あとでもう一度ためしてください'); done(); return; }
        toast(hasPos(b) ? '手で直した位置を消し、一覧のリンクの位置にもどしました' : '手で直した位置を消しました。住所から位置を調べ直します');
        done();
        if (!hasPos(b)) chibanPass().then(n => {
          toast(n ? '住所から位置が分かりました' : '住所からは位置が分かりませんでした');
          if (n && $('#gbFix')) openBld(b.id);
        });
        return;
      }
      if (act === 'set') {
        const c = map.getCenter(), lat = Math.round(c.lat * 1e6) / 1e6, lng = Math.round(c.lng * 1e6) / 1e6;
        b.fix = { lat, lng, from: 'hand' }; prep();
        a.disabled = true;
        try { await api('gb_pos', { items: [{ id: b.id, lat, lng, from: 'hand' }] }, { timeout: 30000 }); toast('位置を直しました'); }
        catch (err) { toast('位置を送れませんでした。あとでもう一度ためしてください'); }
        done();
      }
    };
  }

  /* ---------- 家や「集」の画面（区域係だけ）：結んでいる一覧の建物 ---------- */
  let preloading = null;
  function preload() {
    if (preloading || st.data || typeof isAdmin !== 'function' || !isAdmin()) return;
    preloading = api('gb_list', {}, { timeout: 45000 }).then(d => { if (d && d.ok) { st.raw = JSON.stringify(d); st.data = d; prep(); chibanPass().catch(() => 0); } }) // 住所から位置を調べておく.catch(() => { /* 古いサーバー・練習モード */ }).finally(() => { preloading = null; });
  }
  setTimeout(() => { try { if (typeof LIVE !== 'undefined' && LIVE) preload(); } catch (e) { /* そのまま */ } }, 8000);
  const backTo = h => () => { if (!houseById(h.id)) { closeSheet(); return; } if (h.type === 'apt') openBuilding(h.id); else openTarget(h.id, '', false); };

  function houseNotice(h) {
    if (!h || typeof isAdmin !== 'function' || !isAdmin()) return '';
    if (!st.data) { preload(); return ''; }
    const linked = (st.data.blds || []).filter(b => b.hid === h.id && !b.skip);
    const tmp = linked.some(b => stOf(b) === 'tmp');
    const rows = linked.map(b => `<div class="gb-hrow"><span class="tx"><b>${esc(b.name || '（名前なし）')}</b>${stOf(b) === 'tmp' ? ' <span class="gb-st wait">仮</span>' : ' <span class="gb-st ok">確定</span>'}
        <small>${esc(b.label || b.src)}・${b.n}部屋・記録${b.nv}件${b.gone ? '・今の一覧にない' : ''}${hasPos(b) && h.lat != null ? `・一覧の位置から${fmtM(dist(b.lat, b.lng, h.lat, h.lng))}` : ''}</small></span>
        ${stOf(b) === 'tmp' ? `<button type="button" class="btn small primary" data-gbn="ok" data-b="${esc(b.id)}">これでよい</button>` : ''}${gmapBtn(b)}<button type="button" class="btn small" data-gbn="un" data-b="${esc(b.id)}">外す</button></div>`).join('');
    const sum = linked.length ? `外の一覧：${esc(linked.map(b => b.name || '（名前なし）').join('、'))}${tmp ? ' <span class="gb-st wait">仮</span>' : ' <span class="gb-st ok">確定</span>'}` : '外の一覧：結んでいません';
    // 1行目の「切り替える」は、閉じたままでも押せる（押しても開け閉めしない）
    return `<details class="notice gb-hn" data-gbn-h="${esc(h.id)}"${tmp ? ' open' : ''}><summary><span style="flex:1 1 auto">${sum}</span>
        <button type="button" class="btn small" data-gbn="pick">${linked.length ? '切り替える' : '一覧の建物を選ぶ'}</button></summary>
      ${rows}
      ${linked.length > 1 ? '<p class="hint">2つ以上の一覧の建物が結ばれています。同じ建物でなければ、ちがう方を外してください。</p>' : ''}
      <small class="hint" style="display:block">区域係だけに出ます。</small></details>`;
  }
  window.gaibuNotice = houseNotice;

  document.addEventListener('click', async e => {
    const a = e.target && e.target.closest ? e.target.closest('[data-gbn]') : null;
    if (!a) return;
    e.preventDefault(); // 1行目（summary）のボタンで、開け閉めしない
    const box = a.closest('[data-gbn-h]'), h = box && houseById(box.dataset.gbnH);
    if (!h || !st.data) return;
    const b = a.dataset.b ? (st.data.blds || []).find(x => x.id === a.dataset.b) : null;
    const repaint = () => {
      const el = document.querySelector(`[data-gbn-h="${CSS.escape(h.id)}"]`);
      if (el) { el.outerHTML = houseNotice(h); const n = document.querySelector(`[data-gbn-h="${CSS.escape(h.id)}"]`); if (n) n.open = true; }
    };
    const act = a.dataset.gbn;
    if (act === 'ok' && b) await link([{ id: b.id, hid: h.id }], '仮を外しました', repaint);
    else if (act === 'un' && b) {
      if (!await ask(`「${b.name}」との結びつきを外します。この建物から入れた記録は、次の取り込みで消えます（アプリで入れた記録は残ります）。よろしいですか？`, { ok: '外す' })) return;
      await link([{ id: b.id, hid: '' }], '外しました', repaint);
    } else if (act === 'pick') pickFor(h, '');
  });

  /* この家の一覧の建物を切り替える（近い順・名前でさがせる）。
     選ぶと、その建物をこの家に結び、前に結んでいた建物は「まだ」にもどす（「今の建物も残す」なら残す） */
  function pickFor(h, q, keep) {
    const cur = (st.data.blds || []).filter(b => b.hid === h.id && !b.skip);
    setSheet(headHtml(terrById(h.terrId), cur.length ? '一覧の建物を切り替える' : '一覧の建物を選ぶ', esc(h.label || '名前のない家')) + `
      ${cur.length ? `<p class="gb-src">今：<b>${esc(cur.map(b => b.name || '（名前なし）').join('、'))}</b></p>` : ''}
      <p class="hint">この${h.type === 'apt' ? '集合住宅' : '家'}の、一覧の建物を選んでください。近い順です（名前が同じものを先に）。</p>
      ${cur.length ? `<label class="check"><input type="checkbox" id="gbKeep"${keep ? ' checked' : ''}>今の建物も残す（同じ建物が2つの一覧に載っているとき）</label>` : ''}
      <input type="search" id="gbPq" value="${esc(q)}" placeholder="建物名・住所・一覧の名前でさがす" aria-label="一覧の建物をさがす" style="width:100%;min-height:50px;border-radius:12px;border:2px solid var(--ink2);padding:0 12px;font-size:17px;margin:4px 0 8px">
      <div id="gbPRows">${pickRows(h, q)}</div>
      <button type="button" class="btn block" id="gbPBack">もどる</button>`);
    const S = $('#sheet');
    $('#gbPBack').onclick = backTo(h);
    const qi = $('#gbPq');
    const keepOn = () => !!($('#gbKeep') && $('#gbKeep').checked);
    const bind = () => {
      $$('#gbPRows [data-gbp]', S).forEach(x => x.onclick = () => chooseFor(h, (st.data.blds || []).find(y => y.id === x.dataset.gbp), keepOn()));
      $$('#gbPRows [data-gbpm]', S).forEach(x => x.onclick = () => showCompare(h, (st.data.blds || []).find(y => y.id === x.dataset.gbpm), qi.value, keepOn()));
    };
    bind();
    bindSearch(qi, v => { const el = $('#gbPRows'); if (el) { el.innerHTML = pickRows(h, v); bind(); } });
  }
  /* 選ぶ画面の行：近い順（名前が同じものを先に）。名前・住所・一覧の名前でしぼる */
  function pickRows(h, q) {
    const nq = norm(q), nh = norm(h.label);
    const rows = (st.data.blds || []).filter(b => !b.gone)
      .map(b => ({ b, m: hasPos(b) && h.lat != null ? dist(b.lat, b.lng, h.lat, h.lng) : Infinity, same: sameName(norm(b.name), h) }))
      .filter(x => !nq || norm(x.b.name).includes(nq) || norm(x.b.addr).includes(nq) || norm(x.b.label).includes(nq))
      .sort((x, y) => (y.same - x.same) || (x.m - y.m)).slice(0, 40);
    const now = b => b.hid === h.id ? 'この家に結んでいます' : b.hid ? `→ ${esc((houseById(b.hid) || {}).label || 'ほかの家')}に結んでいます${stOf(b) === 'tmp' ? '（仮）' : ''}` : b.skip ? '取り込まない' : 'まだ結んでいません';
    return rows.map(x => `<div class="gb-row" style="cursor:default;flex-wrap:wrap"><span class="tx" style="flex:1 1 100%"><b>${esc(x.b.name || '（名前なし）')}${x.same ? '　（名前が同じ）' : ''}</b>
        <small>${esc(x.b.label || x.b.src)}・${x.b.n}部屋・${fmtM(x.m)}</small><small>${now(x.b)}</small></span>
        <span style="margin-left:auto;display:flex;gap:6px">${(hasPos(x.b) || (x.b.hid && x.b.hid !== h.id && houseById(x.b.hid))) ? `<button type="button" class="btn small" data-gbpm="${esc(x.b.id)}">地図</button>` : ''}${gmapBtn(x.b)}<button type="button" class="btn small primary" data-gbp="${esc(x.b.id)}"${x.b.hid === h.id ? ' disabled' : ''}>${x.b.hid === h.id ? '今の建物' : 'これにする'}</button></span></div>`).join('') || '<div class="empty">ありません</div>';
  }

  /* この家を、一覧の建物 b に切り替えて確定する。家の名前・部屋・オートロックは、すぐ一覧に合わせる（apply） */
  async function chooseFor(h, b, keep) {
    if (!b) return;
    const cur = (st.data.blds || []).filter(c => c.hid === h.id && !c.skip);
    if (b.hid && b.hid !== h.id && houseById(b.hid) && !await ask(`「${b.name}」は、いま「${houseById(b.hid).label || 'ほかの家'}」に結んでいます。この${h.type === 'apt' ? '集合住宅' : '家'}に結び直しますか？次の取り込みで、記録もこちらに移ります。`, { ok: '結び直す' })) return;
    if (h.type !== 'apt' && !await ask('この家はアパートではありません。結ぶと、アパートになり、一覧の部屋が入ります。よろしいですか？', { ok: '結ぶ' })) return;
    const drop = keep ? [] : cur.filter(c => c.id !== b.id);
    mapOff();
    await link([{ id: b.id, hid: h.id, apply: true }].concat(drop.map(c => ({ id: c.id, hid: '' }))),
      `「${b.name}」に${drop.length ? '切り替えて' : '結んで'}確定しました。名前と部屋を一覧に合わせました（記録は次の取り込みで入ります${drop.length ? '。前の建物の記録は消えます' : ''}）`, backTo(h));
  }

  /* 選ぶ画面から地図で見る：この家・一覧の位置・その建物を今結んでいる家を並べて出す */
  function showCompare(h, b, q, keep) {
    if (!b || typeof L === 'undefined' || typeof map === 'undefined' || h.lat == null) return;
    mapOff();
    closeSheet();
    showView('map');
    const o = b.hid && b.hid !== h.id ? houseById(b.hid) : null;
    const hp = [h.lat, h.lng], bp = hasPos(b) ? [b.lat, b.lng] : null, op = o && o.lat != null ? [o.lat, o.lng] : null;
    const tip = cls => ({ permanent: true, direction: 'top', offset: [0, -14], className: cls, opacity: 1 });
    mapLayer = L.layerGroup();
    if (bp) {
      L.polyline([bp, hp], { color: '#9A5B12', weight: 3, dashArray: '6 6', interactive: false }).addTo(mapLayer);
      L.circleMarker(bp, { radius: 10, color: '#9A5B12', weight: 3, dashArray: '4 4', fillColor: '#FFF4E5', fillOpacity: .7 }).bindTooltip('一覧の位置', tip('gb-pin-b')).addTo(mapLayer);
    }
    if (op) {
      if (bp) L.polyline([bp, op], { color: '#5b6776', weight: 3, dashArray: '2 6', interactive: false }).addTo(mapLayer);
      L.circleMarker(op, { radius: 16, color: '#5b6776', weight: 4, fillColor: '#EEF1F5', fillOpacity: .5 }).bindTooltip('今の結び先：' + esc(o.label || '名前のない家'), tip('gb-pin-o')).addTo(mapLayer);
    }
    L.circleMarker(hp, { radius: 20, color: '#1d3a5a', weight: 5, fillColor: '#5B8DEF', fillOpacity: .18 }).bindTooltip('この家：' + esc(h.label || '名前のない家'), tip('gb-pin-h')).addTo(mapLayer);
    mapLayer.addTo(map);
    const pts = [hp].concat(bp ? [bp] : [], op ? [op] : []);
    const fit = () => {
      try { map.invalidateSize(); } catch (e) { /* そのまま */ }
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [50, 150], paddingBottomRight: [50, 250], maxZoom: 19 });
      else map.setView(hp, 19);
    };
    setTimeout(fit, 200);
    setTimeout(fit, 700);
    const host = document.getElementById('map').parentElement;
    mapBar = document.createElement('div');
    mapBar.className = 'gb-mapbar';
    mapBar.innerHTML = `<button type="button" class="x" data-a="x" aria-label="閉じる">×</button>
      <p class="t">一覧：<b>${esc(b.name || '（名前なし）')}</b>（${esc(b.label || b.src)}・${b.n}部屋）${bp ? `<br>一覧の位置：この家から ${fmtM(dist(b.lat, b.lng, h.lat, h.lng))}` : '<br>一覧の位置：分かりません'}
        <br>今の結び先：${b.hid === h.id ? '<b>この家</b>' : o ? `<b>${esc(o.label || '名前のない家')}</b>（この家から ${fmtM(dist(o.lat, o.lng, h.lat, h.lng))}）${stOf(b) === 'tmp' ? '・仮' : ''}` : 'まだ結んでいません'}</p>
      <div class="acts">
        ${b.hid !== h.id ? '<button type="button" class="btn primary" data-a="go">この家に切り替える</button>' : ''}
        ${gmapBtn(b, '')}
        <button type="button" class="btn" data-a="back">選ぶ画面へ</button>
      </div>`;
    host.appendChild(mapBar);
    mapBar.onclick = async e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'x') { mapOff(); return; }
      if (a.dataset.a === 'back') { mapOff(); pickFor(h, q, keep); return; }
      if (a.dataset.a === 'go') chooseFor(h, b, keep);
    };
  }

  window.gaibu = { open };
  // 入口：係の画面の「区域」タブのボタン
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#adGaibu')) open(); });
})();
