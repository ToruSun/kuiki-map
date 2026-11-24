/* =========================================================
   gaibu.js  区域係の「外の一覧とつなぐ」  ※区域係だけ

   会衆が別に使っている一覧（アパート・オートロックの訪問の記録など）を、移行のあいだ、何度でもアプリに入れるための画面。
   一覧を読んで送るのは、区域係が別に用意するプログラム（取り込み用のスプレッドシートの Apps Script）。サーバーの受け口は gas/gaibu.gs
   ・入口：係の画面 ＞ 区域 ＞「区域の線・取り込み」＞「外の一覧とつなぐ」
   ・取り込みの鍵：作る（1回だけ表示）・止める。鍵は、外のプログラムのスクリプトのプロパティに入れる
   ・建物の結びつき：一覧の建物を、アプリのアパート（または家）に結ぶ。結んだ建物の記録だけが入る
       候補：場所の近い家（アパートを先に）と、名前が同じ家。「候補が1つの建物をまとめて結ぶ」もできる
       新しく置く：建物の場所に、新しいアパートを置いて結ぶ（サーバーで作る）
       取り込まない：前に入れた記録も、次の取り込みで消える
   ・入れた記録は「取り込み」（記録した人）。一覧を直せば、次の取り込みでアプリの記録も直る

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
`;
  document.head.appendChild(css);

  const st = { data: null, tab: 'wait', q: '' };
  const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・･\-ー―‐－〜~()（）]/g, '');
  const dist = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r; return Math.sqrt(x * x + y * y) * R; };
  const hasPos = b => b && b.lat != null && b.lng != null && isFinite(b.lat) && isFinite(b.lng);
  const day = iso => { const t = Date.parse(iso); if (!isFinite(t)) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const stOf = b => b.skip ? 'skip' : b.gone ? 'gone' : b.hid ? (houseById(b.hid) ? 'ok' : 'lost') : 'wait';
  const ST_LABEL = { ok: '結んだ', wait: 'まだ', skip: '取り込まない', gone: '一覧にない', lost: '家がない' };

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

  async function load() {
    try { st.data = await api('gb_list', {}, { timeout: 45000 }); }
    catch (e) { st.data = null; toast(e && e.code === 'unknown_action' ? 'サーバーがまだ新しくなっていません' : '読み込めませんでした。あとでもう一度ためしてください'); }
  }

  async function open() {
    if (!isAdmin()) { toast('区域係だけが使えます'); return; }
    setSheet(headHtml(null, '外の一覧とつなぐ', '読み込み中…') + '<p class="hint">読み込んでいます…</p>');
    await load();
    render();
  }

  function render() {
    const d = st.data;
    if (!d) { setSheet(headHtml(null, '外の一覧とつなぐ', '') + '<p class="hint">読み込めませんでした。</p><button class="btn block" data-close>閉じる</button>'); return; }
    const blds = d.blds || [];
    const cnt = { wait: 0, ok: 0, skip: 0, gone: 0, lost: 0 };
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
      <div class="gb-tabs">${tab('wait', `まだ ${cnt.wait + cnt.lost}`)}${tab('ok', `結んだ ${cnt.ok}`)}${tab('skip', `取り込まない ${cnt.skip}`)}${cnt.gone ? tab('gone', `一覧にない ${cnt.gone}`) : ''}${tab('all', 'すべて')}</div>
      <input type="search" id="gbQ" value="${esc(st.q)}" placeholder="建物名・住所でさがす" aria-label="建物をさがす" style="width:100%;min-height:50px;border-radius:12px;border:2px solid var(--ink2);padding:0 12px;font-size:17px;margin:4px 0 8px">
      <div>${shown.map(b => {
        const s = stOf(b), h = b.hid ? houseById(b.hid) : null, r = b.res || {};
        const last = s === 'ok' && (r.add || r.upd || r.del || r.dup) ? `・前回 +${r.add || 0}${r.upd ? `・直し${r.upd}` : ''}${r.del ? `・−${r.del}` : ''}${r.dup ? `・重なり${r.dup}` : ''}` : '';
        return `<button type="button" class="gb-row" data-gb="${esc(b.id)}"><span class="tx"><b>${esc(b.name || '（名前なし）')}${b.lock ? '　🔒' : ''}</b>
          <small>${esc(b.label || b.src)}・${b.n}部屋・記録${b.nv}件${last}</small>
          <small>${h ? `→ ${esc(h.label || '名前のない家')}${h.terrId && terrById(h.terrId) ? `（区域${esc(terrById(h.terrId).no)}）` : ''}` : esc(b.addr || '')}</small></span>
          <span class="gb-st ${s === 'ok' ? 'ok' : s === 'wait' || s === 'lost' ? 'wait' : ''}">${ST_LABEL[s]}</span></button>`;
      }).join('') || '<div class="empty">ありません</div>'}</div>
      <button type="button" class="btn block" data-close>閉じる</button>`);
    const S = $('#sheet');
    $$('[data-gbt]', S).forEach(x => x.onclick = () => { st.tab = x.dataset.gbt; sheetKeep = true; render(); });
    $$('[data-gb]', S).forEach(x => x.onclick = () => openBld(x.dataset.gb));
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

  async function link(items, msg) {
    try {
      const r = await api('gb_link', { items }, { timeout: 60000 });
      toast(r.bad && r.bad.length ? `${r.n}棟を結びました（${r.bad.length}棟は結べませんでした）` : msg);
      if (r.made && r.made.length && typeof flush === 'function') flush(true); // サーバーで作ったアパートを読みにいく
    } catch (e) { toast('結べませんでした。あとでもう一度ためしてください'); }
    await load(); sheetKeep = true; render();
  }

  function openBld(id) {
    const b = (st.data.blds || []).find(x => x.id === id);
    if (!b) return;
    const s = stOf(b), cur = b.hid ? houseById(b.hid) : null;
    const cs = candidates(b).filter(c => !cur || c.h.id !== cur.id);
    const tOf = h => (h.terrId && terrById(h.terrId) ? `区域${terrById(h.terrId).no}・` : '');
    setSheet(headHtml(null, esc(b.name || '（名前なし）'), `${esc(b.label || b.src)}・${b.n}部屋・記録${b.nv}件`) + `
      <p class="gb-src">${esc(b.addr || '住所なし')}${b.lock ? '・オートロック' : ''}${hasPos(b) ? '' : '・場所が分かりません（一覧のリンクか住所を確かめてください）'}</p>
      ${s === 'ok' && cur ? `<div class="notice">結んだ家：<b>${esc(cur.label || '名前のない家')}</b>（${esc(tOf(cur))}${cur.type === 'apt' ? 'アパート' : '家'}）</div>` : ''}
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
      ${b.hid || b.skip ? '<button type="button" class="btn block" id="gbUnlink">結びつきを外す（まだ にもどす）</button>' : ''}
      <button type="button" class="btn block" id="gbBack">もどる</button>`);
    const S = $('#sheet');
    $$('[data-gbl]', S).forEach(x => x.onclick = async () => {
      const h = houseById(x.dataset.gbl);
      if (h && h.type !== 'apt' && !await ask('この家はアパートではありません。結ぶと、次の取り込みでアパートになり、一覧の部屋が入ります。よろしいですか？', { ok: '結ぶ' })) return;
      await link([{ id: b.id, hid: x.dataset.gbl }], '結びました。次の取り込みで記録が入ります');
    });
    $$('[data-gbmap]', S).forEach(x => x.onclick = () => {
      const h = houseById(x.dataset.gbmap); if (!h) return;
      closeSheet(); showView('map');
      setTimeout(() => { map.setView([h.lat, h.lng], 18); if (h.type === 'apt' && typeof openBuilding === 'function') openBuilding(h.id); }, 150);
    });
    if ($('#gbMake')) $('#gbMake').onclick = async () => {
      if (!await ask(`「${b.name}」の場所に、新しいアパートを置いて結びます。近くに同じ建物があるときは、そちらを結んでください。よろしいですか？`, { ok: '置いて結ぶ' })) return;
      await link([{ id: b.id, make: true, terrId: typeof terrOf === 'function' ? terrOf(b.lat, b.lng) : null }], '新しいアパートを置いて結びました。次の取り込みで部屋と記録が入ります');
    };
    if ($('#gbSkip')) $('#gbSkip').onclick = async () => {
      if (b.hid && !await ask('この建物を取り込まないことにします。前に入れた記録は、次の取り込みで消えます（アプリで入れた記録は残ります）。よろしいですか？', { ok: '取り込まない' })) return;
      await link([{ id: b.id, skip: true }], '取り込まない建物にしました');
    };
    if ($('#gbUnlink')) $('#gbUnlink').onclick = async () => {
      await link([{ id: b.id, hid: '' }], '結びつきを外しました（入れた記録は残っています）');
    };
    $('#gbBack').onclick = () => render();
  }

  window.gaibu = { open };
})();
