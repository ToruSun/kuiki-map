/**
 * 奉仕報告を S21（会衆の報告システム）に送る
 *
 * ・区域マップで「奉仕時間」を使う人が、月末の奉仕報告の画面から S21 に送る。
 * ・本人確認は、区域マップの端末の登録（findUser_）。端末からは、だれの報告かを指定できない。
 * ・S21 とは「連携キー」でサーバーどうしで話す。S21 の個人用URL・トークンは使わない。
 *   連携キーと S21 のURLは、スクリプトのプロパティ（S21_KEY・S21_URL）にだけ置き、端末には返さない。
 * ・区域マップの人と S21 の人は、名前で自動で対応づける（空白・全角半角を無視）。
 *   見つからない・同じ名前が2人以上のとき（S21 の名簿で・区域マップの使う人で。C1-1）だけ、区域係がえらぶ。
 *   区域係がえらんだ控えは、人ごとのプロパティ S21L_<区域マップの人のid> = S21の人のid（C3-11c）。
 *   前の形（S21_LINK：{ 区域マップの人のid: S21の人のid } の JSON・約100人まで）も読み、読んだら人ごとに移す。
 *   前の控えは消さずに残し、移し終えた印（S21_LINK_MOVED=1）のあとは読まない。
 * ・S21 の URL を変えたら、連携キーを消す（前のキーを新しい宛先に送らない。C3-11a）。
 * ・送れる・確かめられる月は「去年の1月〜来月」（日本時間。C3-11b）。
 * ・報告の中身は保存しない・ログに書かない（中継だけ）。
 * ・締切（S21 v37 から。v23〜v36 は翌月5日で、まだ報告のない月は締切後も受け付けていた）：
 *   締切は翌月10日（S21 の設定「締切日」）。締切を過ぎた月は、まだ報告がなくても S21 は code:"locked" で断る（書記が入力する）。
 *   端末には s21_locked で返す。s21_me は locked（その月の締切を過ぎた＝ここからは送れない）・deadline（締切日）と、
 *   report.locked（この報告は変更できない）・report.late（支部報告の期限の後に書記が入れ、翌月の会衆の報告に加えた）を通す。
 *
 * 受付（Code.gs の doPost から s21Api_ を呼ぶ）
 *   だれでも：s21_me（本人の情報とその月の報告）・s21_send（送る）
 *   区域係　：s21_cfg（設定のようす）・s21_set（URL・キー）・s21_test（つながるか）・s21_match（名前の対応）・s21_link（手で対応づけ）
 */
const S21_ROSTER_SEC = 21600;  // S21 の名簿（id・名前・active）を一時保存する秒数
const S21_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,200}\/exec$/;
const S21_SEND_MAX = 20;       // 1人が10分に送れる回数（連打・まちがいの止め）
const S21_ME_MAX = 60;         // 1人が10分に確かめられる回数（送信とは別の枠。C1-5）
const S21_LINK_PRE = 'S21L_';  // 区域係がえらんだ対応の控え（人ごと。C3-11c）

function s21Api_(user, req) {
  const a = String(req.action || '');
  const admin = user.role === 'admin';
  if (['s21_cfg', 's21_set', 's21_test', 's21_match', 's21_link'].indexOf(a) >= 0) {
    if (!admin) return { ok: false, error: 'admin' };
    if (a === 's21_cfg') return s21Cfg_();
    if (a === 's21_set') return s21Set_(user, req);
    if (a === 's21_test') return s21Test_();
    if (a === 's21_match') return s21Match_(!!req.fresh);
    return s21Link_(user, req);
  }
  if (a !== 's21_me' && a !== 's21_send') return { ok: false, error: 'unknown_action' };
  if (Number(getSettings_().s21On) === 0) return { ok: false, error: 's21_off' };
  if (!s21Ready_()) return { ok: false, error: 's21_nocfg' };
  if (!s21RateOk_(user.id, a)) return { ok: false, error: 'slow' };
  const pid = s21PidOf_(user);
  if (!pid) return { ok: false, error: 's21_noperson' };
  // 返すのは本人がつながっている S21 の人の名前だけ（画面の「S21 の ○○さんとして送ります」。C1-2）
  if (a === 's21_me') {
    const q = { action: 'map.me', pid: pid };
    if (req.ym !== undefined && req.ym !== null && req.ym !== '') {
      if (!s21YmOk_(req.ym)) return { ok: false, error: 's21_badym' };
      q.ym = String(req.ym);
    }
    const r = s21Call_(q);
    if (!r.ok) return s21Fail_(r);
    const p = r.person || {};
    let pname = str_(p.name, 40);
    if (!pname) { const ro = s21Roster_(false); pname = ((ro || []).filter(function (x) { return x.id === pid; })[0] || {}).name || ''; }
    return { ok: true, ym: String(r.ym || q.ym || ''), locked: !!r.locked, deadline: s21Deadline_(r.deadline),
      person: { name: pname, pioneer: !!p.pioneer, active: p.active !== false },
      report: s21Report_(r.report), recent: (Array.isArray(r.recent) ? r.recent : []).slice(0, 12).map(s21Report_).filter(Boolean) };
  }
  // s21_send
  const v = s21Clean_(req);
  if (!v) return { ok: false, error: 's21_invalid' };
  const r = s21Call_(Object.assign({ action: 'map.submit', pid: pid }, v));
  if (!r.ok) return s21Fail_(r);
  return { ok: true, report: s21Report_(r.report), late: !!r.late, dry: !!v.dryRun };
}

/* ---- 設定（スクリプトのプロパティ） ---- */
function s21Ready_() { const p = props_(); return !!(p.getProperty('S21_URL') && p.getProperty('S21_KEY')); }
function s21Cfg_() {
  const p = props_();
  return { ok: true, url: p.getProperty('S21_URL') || '', keySet: !!p.getProperty('S21_KEY') };
}
function s21Set_(user, req) {
  const p = props_();
  const out = {};
  let u = null, k = null;
  if (req.url !== undefined) {
    u = String(req.url || '').trim();
    if (u && !S21_URL_RE.test(u)) return { ok: false, error: 's21_badurl' };
  }
  if (req.key !== undefined) {
    k = String(req.key || '').trim();
    if (k && !/^[\x21-\x7e]{20,200}$/.test(k)) return { ok: false, error: 's21_badkey' };
  }
  // URL が変わったら、前の連携キーは消す（前のキーを新しい宛先に送らない。同じ送信で新しいキーを入れたときはそれを使う。C3-11a）
  let cleared = false;
  if (u !== null && u !== (p.getProperty('S21_URL') || '')) {
    if (!k && p.getProperty('S21_KEY')) { p.deleteProperty('S21_KEY'); cleared = true; }
    if (u) p.setProperty('S21_URL', u); else p.deleteProperty('S21_URL');
    out.url = 1;
  }
  if (k !== null) {
    if (k) p.setProperty('S21_KEY', k); else p.deleteProperty('S21_KEY');
    out.key = 1;
  }
  s21RosterDrop_();
  try { // 設定の変更履歴（キーの中身は書かない）
    if (typeof opsSheet_ === 'function') {
      const sh = opsSheet_(), at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
      const row = Math.max(2, sh.getLastRow() + 1);
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
      sh.getRange(row, 1, 1, 5).setValues([[at, user.name, '奉仕報告（S21）の連携', '', [out.url ? 'URLを変更' : '', out.key ? '連携キーを変更' : '', cleared ? '連携キーを消去（URLの変更のため）' : ''].filter(String).join('・')]]);
    }
  } catch (e) { /* 履歴が残せなくても保存は成功 */ }
  const res = s21Cfg_();
  if (cleared) res.keyCleared = true; // 画面に「連携キーを入れ直してください」
  return res;
}
function s21Test_() {
  if (!s21Ready_()) return { ok: false, error: 's21_nocfg' };
  const r = s21Call_({ action: 'map.ping' });
  if (!r.ok) return s21Fail_(r);
  return { ok: true, congregation: String(r.congregation || '') };
}

/* ---- 名前の対応 ---- */
function s21Norm_(s) { return String(s || '').normalize('NFKC').replace(/[\s　・･.]+/g, '').toLowerCase(); }
/** 区域係がえらんだ対応 { 区域マップの人のid: S21の人のid }。人ごとの控え（S21L_<id>）と、移す前の前の形（S21_LINK）を合わせる */
function s21Links_() {
  const all = props_().getProperties();
  const o = {};
  const moved = all.S21_LINK_MOVED === '1';
  if (!moved) { const old = s21LinkOld_(all); Object.keys(old).forEach(function (k) { o[k] = old[k]; }); }
  Object.keys(all).forEach(function (k) { if (k.indexOf(S21_LINK_PRE) === 0 && all[k]) o[k.slice(S21_LINK_PRE.length)] = String(all[k]); });
  if (!moved && all.S21_LINK) s21LinkMove_();
  return o;
}
function s21LinkOld_(all) {
  const o = parseJson_(all.S21_LINK, {}), out = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).forEach(function (k) { if (o[k]) out[k] = String(o[k]); });
  return out;
}
/** 前の形の控え（S21_LINK）を人ごとのプロパティに移す。前の控えは消さない。移し終えたら S21_LINK_MOVED=1。
    ロックの中で読み直す（同時に「えらばない」にした人を、前の控えから生き返らせない）。移せた・移す物がないときは true */
function s21LinkMove_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    const p = props_(), all = p.getProperties();
    if (all.S21_LINK_MOVED === '1' || !all.S21_LINK) return true;
    const old = s21LinkOld_(all), put = {};
    Object.keys(old).forEach(function (uid) { if (!all[S21_LINK_PRE + uid]) put[S21_LINK_PRE + uid] = old[uid]; });
    if (Object.keys(put).length) p.setProperties(put); // まとめて書く（一部だけ書けても、次に読んだときに残りを移す）
    p.setProperty('S21_LINK_MOVED', '1');
    return true;
  } catch (e) {
    console.warn('S21 の対応の控えを移せませんでした（前の控えはそのまま）');
    return false;
  } finally { lock.releaseLock(); }
}
function s21LinkMoved_() { const all = props_().getProperties(); return all.S21_LINK_MOVED === '1' || !all.S21_LINK; }
/** 区域マップの使う人（有効な人）で、同じ名前（s21Norm_）が2人以上いる名前 { 正規化した名前: 人数 }（C1-1） */
function s21LocalDup_() {
  const n = {};
  usersAll_().forEach(function (u) { if (!u.active) return; const k = s21Norm_(u.name); if (k) n[k] = (n[k] || 0) + 1; });
  const out = {};
  Object.keys(n).forEach(function (k) { if (n[k] > 1) out[k] = n[k]; });
  return out;
}
function s21RosterDrop_() { try { CacheService.getScriptCache().remove('s21_roster'); } catch (e) { /* 何もしない */ } }
/** S21 の名簿 [{id, name, group, active}]（group は同じ名前の人を見分けるため）。取れないときは null */
function s21Roster_(fresh) {
  if (!fresh) { const hit = cacheGet_('s21_roster'); if (hit && Array.isArray(hit.people)) return hit.people; }
  const r = s21Call_({ action: 'map.roster' });
  if (!r.ok || !Array.isArray(r.people)) return null;
  const people = r.people.map(function (x) { return { id: str_(x.id, 60), name: str_(x.name, 40), group: str_(x.group, 30), active: x.active !== false }; })
    .filter(function (x) { return x.id && x.name; });
  try { const t = JSON.stringify({ people: people }); if (t.length < 90000) CacheService.getScriptCache().put('s21_roster', t, S21_ROSTER_SEC); } catch (e) { /* 何もしない */ }
  return people;
}
/** 名前が1人だけ合うときの S21 の人のid（active の人を先に見る）。0人・2人以上は '' */
function s21AutoPid_(name, roster) {
  const n = s21Norm_(name);
  if (!n) return '';
  const hit = roster.filter(function (x) { return s21Norm_(x.name) === n; });
  const act = hit.filter(function (x) { return x.active; });
  if (act.length === 1) return act[0].id;
  if (!act.length && hit.length === 1) return hit[0].id;
  return '';
}
function s21PidOf_(user) {
  const links = s21Links_();
  if (links[user.id]) return String(links[user.id]);
  // 区域マップに同じ名前の人が2人以上いるときは、自動でつながない（ほかの人の報告を見られ・送れないように。区域係が手でえらぶ。C1-1）
  if (s21LocalDup_()[s21Norm_(user.name)]) return '';
  const roster = s21Roster_(false);
  const pid = roster ? s21AutoPid_(user.name, roster) : '';
  // 区域係が手でほかの人に対応づけた S21 の人には、名前で自動でつながない（2人が同じ S21 の人の報告を見られ・送れないように）
  return pid && s21Taken_(links, user.id)[pid] ? '' : pid;
}
/* 手で対応づけた S21 の人（その人以外の分）。値は S21 の人の id */
function s21Taken_(links, uid) {
  const out = {};
  Object.keys(links).forEach(function (k) { if (k !== String(uid) && links[k]) out[String(links[k])] = true; });
  return out;
}
function s21Match_(fresh) {
  if (!s21Ready_()) return { ok: false, error: 's21_nocfg' };
  const roster = s21Roster_(fresh);
  if (!roster) return { ok: false, error: 's21_net' };
  const links = s21Links_(), dup = s21LocalDup_();
  const people = usersAll_().filter(function (u) { return u.active; }).map(function (u) {
    if (links[u.id]) {
      const p = roster.filter(function (x) { return x.id === String(links[u.id]); })[0];
      return { uid: u.id, name: u.name, pid: String(links[u.id]), s21: p ? p.name : '', how: p ? 'manual' : 'gone' };
    }
    // same：同じ名前の人がどこにいるか（'map'＝区域マップの使う人に2人以上・'s21'＝S21 の名簿に2人以上）。古い画面は how だけを見る
    if (dup[s21Norm_(u.name)]) return { uid: u.id, name: u.name, pid: '', s21: '', how: 'ambig', same: 'map' };
    const pid = s21AutoPid_(u.name, roster);
    if (pid && s21Taken_(links, u.id)[pid]) return { uid: u.id, name: u.name, pid: '', s21: '', how: 'ambig', same: 'taken' }; // 手でほかの人に対応づけた S21 の人
    if (pid) return { uid: u.id, name: u.name, pid: pid, s21: (roster.filter(function (x) { return x.id === pid; })[0] || {}).name || '', how: 'auto' };
    const same = roster.filter(function (x) { return s21Norm_(x.name) === s21Norm_(u.name); }).length;
    return same > 1 ? { uid: u.id, name: u.name, pid: '', s21: '', how: 'ambig', same: 's21' } : { uid: u.id, name: u.name, pid: '', s21: '', how: 'none' };
  });
  return { ok: true, people: people, roster: roster.filter(function (x) { return x.active; }).map(function (x) { return { id: x.id, name: x.name, group: x.group || '' }; }) };
}
function s21Link_(user, req) {
  const uid = String(req.uid || '');
  if (!usersAll_().some(function (u) { return u.id === uid; })) return { ok: false, error: 'bad_request' };
  const pid = str_(req.pid, 60).trim();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    // 前の形の控えが残っているときは、先に人ごとに移す（移せないあいだは変えない：前の控えから生き返らせないため）
    if (!s21LinkMoved_()) { lock.releaseLock(); s21LinkMove_(); if (!lock.tryLock(10000)) return { ok: false, error: 'busy' }; }
    if (!s21LinkMoved_()) return { ok: false, error: 'busy' };
    if (pid) {
      const roster = s21Roster_(false);
      if (!roster || !roster.some(function (x) { return x.id === pid; })) return { ok: false, error: 's21_noperson' };
      props_().setProperty(S21_LINK_PRE + uid, pid);
    } else props_().deleteProperty(S21_LINK_PRE + uid);
  } finally { lock.releaseLock(); }
  return s21Match_(false);
}

/* ---- 送る内容の確かめ ---- */
/** 送れる・確かめられる月は「去年の1月〜来月」（日本時間。C3-11b） */
function s21YmOk_(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return false;
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM').split('-');
  const y = Number(now[0]), mo = Number(now[1]);
  const v = Number(m[1]) * 12 + Number(m[2]) - 1, lo = (y - 1) * 12, hi = y * 12 + mo; // hi＝来月（0 から数える月）
  return v >= lo && v <= hi;
}
function s21Int_(v, max) { const n = Number(v); return isFinite(n) && n >= 0 && n <= max && Math.floor(n) === n ? n : null; }
function s21Clean_(req) {
  if (!s21YmOk_(req.ym)) return null;
  const studies = s21Int_(req.studies || 0, 99), hours = s21Int_(req.hours || 0, 400), actHours = s21Int_(req.actHours || 0, 400);
  if (studies === null || hours === null || actHours === null) return null;
  const remarks = String(req.remarks == null ? '' : req.remarks).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, 200);
  const o = { ym: String(req.ym), preached: !!req.preached, studies: studies, aux: !!req.aux, hours: hours, actHours: actHours, remarks: remarks };
  if (req.dryRun) o.dryRun = true;
  return o;
}
/** S21 の報告を、画面に要るものだけにする（locked：変更できない・late：締切後に出して翌月に加えた） */
function s21Report_(x) {
  if (!x || typeof x !== 'object') return null;
  if (x.empty) return { ym: String(x.ym || ''), empty: true };
  return { ym: String(x.ym || ''), preached: !!x.preached, studies: Number(x.studies) || 0, aux: !!x.aux, hours: Number(x.hours) || 0,
    actHours: Number(x.actHours) || 0, remarks: str_(x.remarks, 200), source: str_(x.source, 20), submitted: str_(x.submitted, 40),
    locked: !!x.locked, late: !!x.late };
}
/** 締切日（S21 の設定。来なければ 10＝S21 v37 の既定） */
function s21Deadline_(v) { const n = Number(v); return isFinite(n) && n >= 1 && n <= 28 && Math.floor(n) === n ? n : 10; }

/* ---- S21 との通信 ----
   キーは本文に入れる（URL に入れない）。GAS のウェブアプリは転送されるので、転送を追う。
   返事：S21 の JSON。通信できない・JSON でないときは { ok:false, code:'net' } */
function s21Call_(body) {
  const p = props_();
  const url = p.getProperty('S21_URL'), key = p.getProperty('S21_KEY');
  if (!url || !key) return { ok: false, code: 'nocfg' };
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'text/plain;charset=utf-8', payload: JSON.stringify(Object.assign({ key: key }, body)),
      followRedirects: true, muteHttpExceptions: true
    });
  } catch (e) {
    console.warn('S21 につながりませんでした：' + body.action);
    return { ok: false, code: 'net' };
  }
  const code = res.getResponseCode();
  if (code !== 200) { console.warn('S21 の返事：' + body.action + ' HTTP ' + code); return { ok: false, code: 'net' }; }
  try {
    const j = JSON.parse(res.getContentText());
    if (!j || typeof j !== 'object') return { ok: false, code: 'net' };
    if (!j.ok) console.warn('S21 が断りました：' + body.action + ' ' + (j.code || '')); // 中身（数字・備考）は書かない
    return j;
  } catch (e) {
    console.warn('S21 の返事が読めませんでした：' + body.action);
    return { ok: false, code: 'net' };
  }
}
/** S21 の断りを、画面に返す形にする */
function s21Fail_(r) {
  // locked：締切を過ぎた月（まだ報告がなくても。ここからは送れない・直せない。書記が入力する）
  const known = ['key', 'noperson', 'inactive', 'badym', 'locked', 'invalid', 'busy', 'server', 'net', 'nocfg'];
  const c = known.indexOf(String(r.code || '')) >= 0 ? String(r.code) : (r.error ? 'server' : 'net');
  if (c === 'noperson') s21RosterDrop_();
  const out = { ok: false, error: 's21_' + c };
  if (r.error && (c === 'invalid' || c === 'badym' || c === 'inactive' || c === 'server')) out.msg = str_(r.error, 120);
  return out;
}
/** 1人あたりの回数の目安（10分ごと）。送信（s21_send）と確かめ（s21_me）は別の枠で数える
    （確かめで送信が止まらない・送信が上限でも受け付けられたかを確かめられる。C1-5） */
function s21RateOk_(uid, action) {
  try {
    const send = action === 's21_send';
    const c = CacheService.getScriptCache(), k = (send ? 's21rl_' : 's21rm_') + uid + '_' + Math.floor(Date.now() / 600000);
    const n = Number(c.get(k) || 0) + 1;
    c.put(k, String(n), 700);
    return n <= (send ? S21_SEND_MAX : S21_ME_MAX);
  } catch (e) { return true; }
}
