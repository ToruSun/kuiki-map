/* =========================================================
   weather.gs  雨の日を自動で知らせる（2026-10-22）

   ・会衆の区域の真ん中の地点（区域の線から決める）の天気を、Open-Meteo（無料・登録不要）から調べる
   ・奉仕者の端末からは天気のサービスに通信しない（端末の場所・IPアドレスを外に出さない）。
     サーバーが30分に1回だけ調べ、読み込み（load・sync）の返事に wx として付ける
   ・調べるのは日本時間の6時〜21時だけ。夜は調べない（雨の扱いもしない）
   ・調べられないときは、2時間以内の前の結果を使う。それもなければ「雨ではない」（ふだんの並び）にする
   ・区域係の設定 wxOn（1＝使う）で止められる
   ・データ：Open-Meteo（CC BY 4.0）。画面に「天気：Open-Meteo」と出す

   返事に付ける形：wx = { r: 1 雨・0 雨ではない, at: 調べた時刻, p: これから2時間の降水確率の最大（%）,
                          t: 今の気温, tx: 今日の最高気温, tn: 今日の最低気温（℃・整数。取れないときは付けない） }
   ・気温（t・tx・tn）は、毎日はじめのひと言で「冷える・暑い」の気づかいに使う（2026-10-22）。
     気温を足した問い合わせが失敗したときは、前の問い合わせ（雨だけ）で調べ直す（雨の機能を止めないため）
   ========================================================= */
const WX_TTL_SEC = 1800;          // 調べ直す間隔（30分）
const WX_KEEP_MS = 2 * 3600000;   // 調べられないとき、前の結果を使ってよい時間
const WX_HOURS = [6, 21];         // 調べる時間（日本時間）
const WX_PROB = 70;               // これから2時間で、この確率（%）以上の雨なら「雨」
const WX_MM = 0.1;                // 今の降水量（mm）がこれ以上なら「雨」

function wxForResponse_() {
  try {
    if (Number(getSettings_().wxOn) === 0) return null;
    return wxNow_();
  } catch (e) {
    console.warn('天気を付けられませんでした：' + e);
    return null;
  }
}

function wxNow_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('wx_v2');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 読み直す */ } }
  const hour = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'H'));
  if (hour < WX_HOURS[0] || hour >= WX_HOURS[1]) return { r: 0, at: new Date().toISOString(), off: 1 };
  const props = PropertiesService.getScriptProperties();
  const last = (function () { try { return JSON.parse(props.getProperty('wx_last') || 'null'); } catch (e) { return null; } })();
  // ほかの人の読み込みが調べている最中なら、待たずに前の結果を返す（読み込みを遅くしない）
  if (cache.get('wx_busy')) return wxStale_(last);
  cache.put('wx_busy', '1', 60);
  try {
    const ll = wxPoint_();
    if (!ll) return null;
    const base = 'https://api.open-meteo.com/v1/forecast?latitude=' + ll[0].toFixed(3) + '&longitude=' + ll[1].toFixed(3) +
      '&hourly=precipitation_probability,precipitation&forecast_hours=3&timezone=Asia%2FTokyo';
    let res = UrlFetchApp.fetch(base + '&current=temperature_2m,precipitation,weather_code&daily=temperature_2m_max,temperature_2m_min',
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) res = UrlFetchApp.fetch(base + '&current=precipitation,weather_code', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('http ' + res.getResponseCode());
    const j = JSON.parse(res.getContentText());
    const cur = j.current || {}, hr = j.hourly || {};
    const probs = (hr.precipitation_probability || []).slice(0, 2).map(Number).filter(isFinite);
    const p = probs.length ? Math.max.apply(null, probs) : 0;
    const code = Number(cur.weather_code);
    const rainCode = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99);
    const rain = Number(cur.precipitation) >= WX_MM || rainCode || p >= WX_PROB;
    const out = { r: rain ? 1 : 0, at: new Date().toISOString(), p: Math.round(p) };
    const dy = j.daily || {}, num = function (v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Math.round(Number(v)); };
    const t = num(cur.temperature_2m), tx = num((dy.temperature_2m_max || [])[0]), tn = num((dy.temperature_2m_min || [])[0]);
    if (t !== null) out.t = t;
    if (tx !== null) out.tx = tx;
    if (tn !== null) out.tn = tn;
    cache.put('wx_v2', JSON.stringify(out), WX_TTL_SEC);
    props.setProperty('wx_last', JSON.stringify(out));
    return out;
  } catch (e) {
    console.warn('天気を調べられませんでした：' + e);
    const s = wxStale_(last);
    cache.put('wx_v2', JSON.stringify(s), 600); // 10分後に、もう一度調べる
    return s;
  } finally {
    cache.remove('wx_busy');
  }
}

function wxStale_(last) {
  if (last && Date.now() - Date.parse(last.at) < WX_KEEP_MS) return last;
  return { r: 0, at: new Date().toISOString(), err: 1 };
}

/* 天気を調べる地点：ふつうの区域の線の外枠の真ん中（1日に1回だけ計算し直す）。個人の場所は使わない */
function wxPoint_() {
  const props = PropertiesService.getScriptProperties();
  try {
    const c = JSON.parse(props.getProperty('wx_ll') || 'null');
    if (c && Date.now() - c.t < 86400000) return c.ll;
  } catch (e) { /* 計算し直す */ }
  let s = 90, n = -90, w = 180, e = -180, k = 0;
  readCol_('territories').forEach(function (x) {
    const t = x && x.data;
    if (!t || t.dummy || t.special || !Array.isArray(t.polygon)) return;
    t.polygon.forEach(function (v) {
      const la = Number(v[0]), ln = Number(v[1]);
      if (!isFinite(la) || !isFinite(ln)) return;
      s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); k++;
    });
  });
  if (!k) return null;
  const ll = [(s + n) / 2, (w + e) / 2];
  props.setProperty('wx_ll', JSON.stringify({ t: Date.now(), ll: ll }));
  return ll;
}
