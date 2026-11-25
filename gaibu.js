/* =========================================================
   gaibu.js  区域係の「外の一覧とつなぐ」  ※区域係だけ

   会衆が別に使っている一覧（アパート・オートロックの訪問の記録など）を、移行のあいだ、何度でもアプリに入れるための画面。
   一覧を読んで送るのは、区域係が別に用意するプログラム（取り込み用のスプレッドシートの Apps Script）。サーバーの受け口は gas/gaibu.gs
   ・入口：係の画面 ＞ 区域 ＞「区域の線・取り込み」＞「外の一覧とつなぐ」
   ・取り込みの鍵：作る（1回だけ表示）・止める。鍵は、外のプログラムのスクリプトのプロパティに入れる
   ・建物の結びつき：一覧の建物を、アプリのアパート（または家）に結ぶ。結んだ建物の記録だけが入る
       候補：場所の近い家（アパートを先に）と、名前が同じ家。「候補が1つの建物をまとめて結ぶ」もできる
       新しく置く：建物の場所に、新しいアパートを置いて結ぶ（サーバーで作る）
       取り込まない・外す：前に入れた記録も、次の取り込みで消える（記録は結んだ家にだけ入る）
       仮で結ぶ：残りを全部まとめて結ぶ（近くのアパート → 近くの仮の家 → なければ新しく置く）。あとで「仮」のタブで確かめる
   ・入れた記録は「取り込み」（記録した人）。一覧を直せば、次の取り込みでアプリの記録も直る

   ・家や「集」の画面（区域係だけ）：結んでいる一覧の建物を出し、これでよい・外す・ほかの一覧の建物を選んで結ぶ（window.gaibuNotice）
   ・Google マップで見る：建物名と住所で Google マップの検索を開くだけ（位置は保存しない。Google の位置を Google 以外の地図に使うのは規約で認められていないため）

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
  const pullNow = () => { try { return typeof window.refresh === 'function' ? window.refresh(true) : null; } catch (e) { return null; } }; // app.js の「最新の変更を取りに行く」
  const fmtM = m => !isFinite(m) ? '場所不明' : m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
  /* Google マップの検索を開く（建物名＋住所。住所に市町村がなければ、会衆の県・市をつける） */
  function gmapUrl(b) {
    const A = typeof CFG_AREA !== 'undefined' ? CFG_AREA : null;
    let addr = String(b.addr || '').trim();
    if (A && addr && !A.names.concat([A.muni]).some(n => n && addr.includes(n))) addr = A.prefOf(A.muni) + A.muni + addr;
    const q = [String(b.name || '').trim(), addr].filter(Boolean).join(' ');
    return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
  }
  const gmapBtn = (b, cls) => { const u = gmapUrl(b); return u ? `<a class="btn ${cls == null ? 'small' : cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Google マップ</a>` : ''; };
  const KARI_APT_M = 40, KARI_PROV_M = 25; // 仮で結ぶ：この距離までのアパート・仮の家に結ぶ（ふつうの家はアパートに変えない）

  /* 候補：場所の近い家（60m 以内。アパートを先に）と、名前が同じ家（場所が分からないとき・遠くても） */
  function candidates(b) {
    const out = [], seen = new Set(), nb = norm(b.name);
    D().houses.forEach(h => {
      if (!h || h.lat == null) return;
      const m = hasPos(b) ? dist(b.lat, b.lng, h.lat, h.lng) : Infinity;
      const same = nb && norm(h.label) === nb;
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

  /* 仮で結ぶ相手：近くのアパート（名前が同じものを先に）→ 近くの仮の家 → なければ新しく置く。場所が分からない建物は残す */
  function kariOf(b) {
    if (!hasPos(b)) return null;
    const nb = norm(b.name);
    let apt = null, prov = null;
    D().houses.forEach(h => {
      if (!h || h.lat == null) return;
      const m = dist(b.lat, b.lng, h.lat, h.lng);
      if (h.type === 'apt' && m <= KARI_APT_M) {
        const same = nb && norm(h.label) === nb;
        if (!apt || (same && !apt.same) || (same === apt.same && m < apt.m)) apt = { h, m, same };
      } else if (h.type !== 'apt' && h.prov && m <= KARI_PROV_M && (!prov || m < prov.m)) prov = { h, m };
    });
    if (apt) return { b, h: apt.h, how: 'apt', m: apt.m };
    if (prov) return { b, h: prov.h, how: 'prov', m: prov.m };
    return { b, h: null, how: 'make' };
  }

  async function load(quiet) {
    try { st.data = await api('gb_list', {}, { timeout: 45000 }); return true; }
    catch (e) {
      if (!quiet || !st.data) { st.data = null; toast(e && e.code === 'unknown_action' ? 'サーバーがまだ新しくなっていません' : '読み込めませんでした。あとでもう一度ためしてください'); }
      return false;
    }
  }
  /* うしろで読み直す。一覧の画面のままなら、変わったときだけ描き直す（見ていた所はそのまま） */
  async function refresh() {
    const before = JSON.stringify(st.data);
    if (!await load(true)) return;
    if (JSON.stringify(st.data) === before) return;
    if ($('#gbQ')) { st.restore = $('#sheet').scrollTop; sheetKeep = true; render(); }
  }

  /* 一覧の画面：前に読んだものをすぐ出し、うしろで読み直す */
  async function open() {
    if (!isAdmin()) { toast('区域係だけが使えます'); return; }
    mapOff();
    if (st.data) { render(); refresh(); return; }
    setSheet(headHtml(null, '外の一覧とつなぐ', '読み込み中…') + '<p class="hint">読み込んでいます…</p>');
    await load();
    render();
  }

  function render() {
    const d = st.data;
    if (!d) { setSheet(headHtml(null, '外の一覧とつなぐ', '') + '<p class="hint">読み込めませんでした。</p><button class="btn block" data-close>閉じる</button>'); return; }
    const blds = d.blds || [];
    const cnt = { wait: 0, ok: 0, tmp: 0, skip: 0, gone: 0, lost: 0 };
    blds.forEach(b => { cnt[stOf(b)]++; });
    const sure = blds.filter(b => stOf(b) === 'wait').map(b => ({ b, h: sureMatch(b) })).filter(x => x.h);
    const q = norm(st.q);
    const shown = blds.filter(b => (st.tab === 'all' || stOf(b) === st.tab || (st.tab === 'wait' && stOf(b) === 'lost')) && (!q || norm(b.name).includes(q) || norm(b.addr).includes(q)))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.name).localeCompare(String(b.name), 'ja'));
    const tab = (k, t) => `<button type="button" data-gbt="${k}" class="${st.tab === k ? 'on' : ''}">${t}</button>`;
    setSheet(headHtml(null, '外の一覧とつなぐ', `建物 ${blds.length}棟`) + `
      <p class="hint">ほかで使っている一覧（アパート・オートロックの訪問の記録など）を、取り込み用のプログラムが読んで送ります。
        一覧の建物をアプリのアパートに<b>結ぶ</b>と、次の取り込みからその建物の記録が入ります。一覧を直すと、次の取り込みでアプリの記録も直ります（アプリで入れた記録はそのまま）。</p>
      <h3 class="sub">取り込みの鍵</h3>
      <p class="gb-src">${d.key && d.key.has ? `あり（${esc(day(d.key.at))} に作成）` : 'まだありません'}</p>
      <div class="row"><button type="button" class="btn small" id="gbKey">${d.key && d.key.has ? '作り直す' : '鍵を作る'}</button>${d.key && d.key.has ? '<button type="button" class="btn small" id="gbKeyDel">止める</button>' : ''}</div>
      ${(d.srcs || []).length ? `<h3 class="sub">届いた一覧</h3>${d.srcs.sort((a, b) => String(a.label).localeCompare(String(b.label), 'ja')).map(s => `<p class="gb-src">${esc(s.label || s.src)}：${s.n}棟・${esc(day(s.at))}</p>`).join('')}` : '<p class="hint">まだ一覧が届いていません。取り込み用のプログラムで「今すぐ取り込む」をためしてください。</p>'}
      ${sure.length ? `<button type="button" class="btn primary block" id="gbSure">候補が1つの建物をまとめて結ぶ（${sure.length}棟）</button>` : ''}
      ${cnt.wait ? `<button type="button" class="btn block" id="gbKari">残り ${cnt.wait}棟を全部、仮で結ぶ</button>` : ''}
      <div class="gb-tabs">${tab('wait', `まだ ${cnt.wait + cnt.lost}`)}${cnt.tmp ? tab('tmp', `仮 ${cnt.tmp}`) : ''}${tab('ok', `結んだ ${cnt.ok}`)}${tab('skip', `取り込まない ${cnt.skip}`)}${cnt.gone ? tab('gone', `一覧にない ${cnt.gone}`) : ''}${tab('all', 'すべて')}</div>
      <input type="search" id="gbQ" value="${esc(st.q)}" placeholder="建物名・住所でさがす" aria-label="建物をさがす" style="width:100%;min-height:50px;border-radius:12px;border:2px solid var(--ink2);padding:0 12px;font-size:17px;margin:4px 0 8px">
      <div>${shown.map(b => {
        const s = stOf(b), h = b.hid ? houseById(b.hid) : null, r = b.res || {};
        const last = s === 'ok' && (r.add || r.upd || r.del || r.dup) ? `・前回 +${r.add || 0}${r.upd ? `・直し${r.upd}` : ''}${r.del ? `・−${r.del}` : ''}${r.dup ? `・重なり${r.dup}` : ''}` : '';
        return `<button type="button" class="gb-row" data-gb="${esc(b.id)}"><span class="tx"><b>${esc(b.name || '（名前なし）')}${b.lock ? '　🔒' : ''}</b>
          <small>${esc(b.label || b.src)}・${b.n}部屋・記録${b.nv}件${last}</small>
          <small>${h ? `→ ${esc(h.label || '名前のない家')}${h.terrId && terrById(h.terrId) ? `（区域${esc(terrById(h.terrId).no)}）` : ''}` : esc(b.addr || '')}</small></span>
          <span class="gb-st ${s === 'ok' ? 'ok' : s === 'wait' || s === 'lost' || s === 'tmp' ? 'wait' : ''}">${ST_LABEL[s]}</span></button>`;
      }).join('') || '<div class="empty">ありません</div>'}</div>
      <button type="button" class="btn block" data-close>閉じる</button>`);
    const S = $('#sheet');
    $$('[data-gbt]', S).forEach(x => x.onclick = () => { st.tab = x.dataset.gbt; sheetKeep = true; render(); });
    $$('[data-gb]', S).forEach(x => x.onclick = () => { st.back = S.scrollTop; openBld(x.dataset.gb); });
    if (st.restore != null) { S.scrollTop = st.restore; st.restore = null; }
    const qi = $('#gbQ');
    let tm = null;
    qi.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { st.q = qi.value; sheetKeep = true; render(); const n = $('#gbQ'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); };
    $('#gbKey').onclick = makeKey;
    if ($('#gbKeyDel')) $('#gbKeyDel').onclick = async () => {
      if (!await ask('取り込みの鍵を止めます。取り込み用のプログラムからは送れなくなります（入れた記録は残ります）。よろしいですか？', { ok: '止める' })) return;
      try { await api('gb_key_del', {}, { timeout: 30000 }); toast('鍵を止めました'); } catch (e) { toast('止められませんでした'); }
      await load(); sheetKeep = true; render();
    };
    if ($('#gbSure')) $('#gbSure').onclick = () => confirmSure(sure);
    if ($('#gbKari')) $('#gbKari').onclick = () => confirmKari(blds.filter(b => stOf(b) === 'wait'));
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

  function confirmKari(list) {
    const plan = list.map(kariOf), go = plan.filter(Boolean);
    const n = { apt: 0, prov: 0, make: 0 };
    go.forEach(x => { n[x.how]++; });
    const none = plan.length - go.length;
    setSheet(headHtml(null, '全部、仮で結ぶ', `${list.length}棟`) + `
      <p>まだ結んでいない建物を、まとめて仮で結びます。次の取り込みで、地図に記録が出ます。</p>
      <ul>
        <li>近く（${KARI_APT_M}m 以内）のアパートに結ぶ：<b>${n.apt}棟</b>（名前が同じものを先に）</li>
        <li>近く（${KARI_PROV_M}m 以内）の仮の家に結ぶ（アパートになります）：<b>${n.prov}棟</b></li>
        <li>建物の場所に新しいアパートを置いて結ぶ：<b>${n.make}棟</b></li>
        ${none ? `<li>場所が分からないので、まだ のまま：<b>${none}棟</b></li>` : ''}
      </ul>
      <p class="hint">あとで「仮」のタブで1棟ずつ確かめ、「これでよい」か、ほかの家に結び直してください。結び直すと、記録もそちらに移ります。ふつうの家（戸建て）は、アパートに変えません。</p>
      <button type="button" class="btn primary block" id="gbKariGo"${go.length ? '' : ' disabled'}>${go.length}棟を仮で結ぶ</button>
      <button type="button" class="btn block" id="gbKariBack">もどる</button>`);
    $('#gbKariBack').onclick = () => render();
    $('#gbKariGo').onclick = async () => {
      $('#gbKariGo').disabled = true;
      const items = go.map(x => x.h ? { id: x.b.id, hid: x.h.id, tmp: true }
        : { id: x.b.id, make: true, tmp: true, terrId: typeof terrOf === 'function' ? terrOf(x.b.lat, x.b.lng) : null });
      let ok = 0, bad = 0, made = 0;
      for (let i = 0; i < items.length; i += 100) {
        toast(`仮で結んでいます… ${i}／${items.length}`);
        try {
          const r = await api('gb_link', { items: items.slice(i, i + 100) }, { timeout: 120000 });
          ok += r.n || 0; bad += (r.bad || []).length; made += (r.made || []).length;
        } catch (e) { bad += Math.min(100, items.length - i); }
      }
      if (made) await pullNow(); // サーバーで作ったアパートを読みにいく
      toast(`${ok}棟を仮で結びました${bad ? `（${bad}棟は結べませんでした）` : ''}。次の取り込みで記録が入ります`);
      st.tab = 'tmp';
      await load(); sheetKeep = true; render();
    };
  }

  /* 結ぶ・外す。新しく置くとき以外は、手元の一覧をすぐ直して先へ進み、サーバーへはうしろで送る
     next：手元を直したあとにすること（なければ一覧の画面） */
  async function link(items, msg, next) {
    const go = next || (() => { st.restore = st.back; sheetKeep = true; render(); });
    if (items.some(it => it.make || it.apply)) { // 新しく置く・家を一覧に合わせる：サーバーの返事を待って、家を読み直す
      try {
        const r = await api('gb_link', { items }, { timeout: 60000 });
        toast(r.bad && r.bad.length ? `${r.n}棟を結びました（${r.bad.length}棟は結べませんでした）` : msg);
        if (r.applied) await pullNow();
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
    setSheet(headHtml(null, esc(b.name || '（名前なし）'), `${esc(b.label || b.src)}・${b.n}部屋・記録${b.nv}件`) + `
      <p class="gb-src">${esc(b.addr || '住所なし')}${b.lock ? '・オートロック' : ''}${hasPos(b) ? '' : '・場所が分かりません（一覧のリンクか住所を確かめてください）'}　${gmapBtn(b)}</p>
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
      ${s !== 'skip' ? '<button type="button" class="btn block" id="gbSkip">この建物は取り込まない</button>' : ''}
      ${b.hid || b.skip ? '<button type="button" class="btn block" id="gbUnlink">結びつきを外す（まだ にもどす・入れた記録は次の取り込みで消える）</button>' : ''}
      <button type="button" class="btn block" id="gbBack">もどる</button>`);
    const S = $('#sheet');
    $$('[data-gbl]', S).forEach(x => x.onclick = async () => {
      const h = houseById(x.dataset.gbl);
      if (h && h.type !== 'apt' && !await ask('この家はアパートではありません。結ぶと、次の取り込みでアパートになり、一覧の部屋が入ります。よろしいですか？', { ok: '結ぶ' })) return;
      await link([{ id: b.id, hid: x.dataset.gbl, apply: true }], '結んで確定しました。名前と部屋を一覧に合わせました（記録は次の取り込みで入ります）');
    });
    $$('[data-gbmap]', S).forEach(x => x.onclick = () => showOnMap(b, houseById(x.dataset.gbmap)));
    if ($('#gbOkTmp')) $('#gbOkTmp').onclick = async () => {
      const n = nextTmp(b.id); // 続けて次の仮へ
      await link([{ id: b.id, hid: b.hid }], n ? '仮を外しました。次の建物です' : '仮を外しました', n ? () => openBld(n.id) : null);
    };
    if ($('#gbMake')) $('#gbMake').onclick = async () => {
      if (!await ask(`「${b.name}」の場所に、新しいアパートを置いて結びます。近くに同じ建物があるときは、そちらを結んでください。よろしいですか？`, { ok: '置いて結ぶ' })) return;
      await link([{ id: b.id, make: true, terrId: typeof terrOf === 'function' ? terrOf(b.lat, b.lng) : null }], '新しいアパートを置いて結びました。次の取り込みで部屋と記録が入ります');
    };
    if ($('#gbSkip')) $('#gbSkip').onclick = async () => {
      if (b.hid && !await ask('この建物を取り込まないことにします。前に入れた記録は、次の取り込みで消えます（アプリで入れた記録は残ります）。よろしいですか？', { ok: '取り込まない' })) return;
      await link([{ id: b.id, skip: true }], '取り込まない建物にしました');
    };
    if ($('#gbUnlink')) $('#gbUnlink').onclick = async () => {
      await link([{ id: b.id, hid: '' }], '結びつきを外しました。入れた記録は、次の取り込みで消えます');
    };
    $('#gbBack').onclick = () => { st.restore = st.back; sheetKeep = true; render(); };
  }

  /* ---------- 家や「集」の画面（区域係だけ）：結んでいる一覧の建物 ---------- */
  let preloading = null;
  function preload() {
    if (preloading || st.data || typeof isAdmin !== 'function' || !isAdmin()) return;
    preloading = api('gb_list', {}, { timeout: 45000 }).then(d => { if (d && d.ok) st.data = d; }).catch(() => { /* 古いサーバー・練習モード */ }).finally(() => { preloading = null; });
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
    const nq = norm(q), nh = norm(h.label);
    const rows = (st.data.blds || []).filter(b => !b.gone)
      .map(b => ({ b, m: hasPos(b) && h.lat != null ? dist(b.lat, b.lng, h.lat, h.lng) : Infinity, same: !!nh && norm(b.name) === nh }))
      .filter(x => !nq || norm(x.b.name).includes(nq) || norm(x.b.addr).includes(nq) || norm(x.b.label).includes(nq))
      .sort((x, y) => (y.same - x.same) || (x.m - y.m)).slice(0, 40);
    const now = b => b.hid === h.id ? 'この家に結んでいます' : b.hid ? `→ ${esc((houseById(b.hid) || {}).label || 'ほかの家')}に結んでいます${stOf(b) === 'tmp' ? '（仮）' : ''}` : b.skip ? '取り込まない' : 'まだ結んでいません';
    setSheet(headHtml(terrById(h.terrId), cur.length ? '一覧の建物を切り替える' : '一覧の建物を選ぶ', esc(h.label || '名前のない家')) + `
      ${cur.length ? `<p class="gb-src">今：<b>${esc(cur.map(b => b.name || '（名前なし）').join('、'))}</b></p>` : ''}
      <p class="hint">この${h.type === 'apt' ? '集合住宅' : '家'}の、一覧の建物を選んでください。${nq ? '' : '近い順です。'}</p>
      ${cur.length ? `<label class="check"><input type="checkbox" id="gbKeep"${keep ? ' checked' : ''}>今の建物も残す（同じ建物が2つの一覧に載っているとき）</label>` : ''}
      <input type="search" id="gbPq" value="${esc(q)}" placeholder="建物名・住所・一覧の名前でさがす" aria-label="一覧の建物をさがす" style="width:100%;min-height:50px;border-radius:12px;border:2px solid var(--ink2);padding:0 12px;font-size:17px;margin:4px 0 8px">
      <div>${rows.map(x => `<div class="gb-row" style="cursor:default;flex-wrap:wrap"><span class="tx" style="flex:1 1 100%"><b>${esc(x.b.name || '（名前なし）')}${x.same ? '　（名前が同じ）' : ''}</b>
          <small>${esc(x.b.label || x.b.src)}・${x.b.n}部屋・${fmtM(x.m)}</small><small>${now(x.b)}</small></span>
          <span style="margin-left:auto;display:flex;gap:6px">${(hasPos(x.b) || (x.b.hid && x.b.hid !== h.id && houseById(x.b.hid))) ? `<button type="button" class="btn small" data-gbpm="${esc(x.b.id)}">地図</button>` : ''}${gmapBtn(x.b)}<button type="button" class="btn small primary" data-gbp="${esc(x.b.id)}"${x.b.hid === h.id ? ' disabled' : ''}>${x.b.hid === h.id ? '今の建物' : 'これにする'}</button></span></div>`).join('') || '<div class="empty">ありません</div>'}</div>
      <button type="button" class="btn block" id="gbPBack">もどる</button>`);
    const S = $('#sheet');
    $('#gbPBack').onclick = backTo(h);
    const qi = $('#gbPq');
    let tm = null;
    const keepOn = () => !!($('#gbKeep') && $('#gbKeep').checked);
    qi.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { pickFor(h, qi.value, keepOn()); const n = $('#gbPq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); };
    $$('[data-gbp]', S).forEach(x => x.onclick = () => chooseFor(h, (st.data.blds || []).find(y => y.id === x.dataset.gbp), keepOn()));
    $$('[data-gbpm]', S).forEach(x => x.onclick = () => showCompare(h, (st.data.blds || []).find(y => y.id === x.dataset.gbpm), qi.value, keepOn()));
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
})();
