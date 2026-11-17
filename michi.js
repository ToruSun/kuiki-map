/* =========================================================
   michi.js  道で囲む（区域の線を引くとき）

   使い方：「区域の線を引く・形を直す」で「道で囲む」を押す → ブロックを指でぐるっと大まかになぞる
     → まわりの道の真ん中を通る線が、自動で引かれる（あとは今までどおり、点を動かして直せる）
   ・いくつかのブロックをまとめて囲んでもよい（半分以上が囲みの中に入ったブロックを1つにする）
   ・小さく囲んだときは、囲んだ所をふくむブロック1つになる
   ・境にするのは、ふつうの道・大きい道・線路・川。「細い道・小川も境にする」で、通路や水路も境にできる
   ・道がない広い所（1ha 以上のブロックに、囲みが一部だけかかる所）は、土地の区切り（tochi-kugiri.js の線）で分けて、囲みに半分以上入る土地をとる
   ・隣の区域の点が近くにあれば（約3m）、その点にそろえる（すき間ができないように）

   データ：osm/roads.json（OpenStreetMap の道の真ん中の線。Actions「OSM の道」が作る。© OpenStreetMap contributors／ODbL）
   計算：道を交わる所で区切ってつなぎ、道で囲まれた1つ1つのブロック（面）を出す。えらんだブロックの外まわりを線にする

   index.html：<script src="kyoukai.js"></script> などのあとに <script src="michi.js"></script>
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 計算（地図や画面を使わない部分。手元の試しでも使う） ---------- */
  const core = (function () {
    const R_LAT = 110540, R_LNG = 111320;
    // roads.json の線をほどく：{ c, lat:[], lng:[], s, w, n, e }
    function decode(j) {
      const out = [];
      (j && j.w || []).forEach(r => {
        const c = r[0], lat = [], lng = [];
        let a = r[1], b = r[2];
        lat.push(a / 1e6); lng.push(b / 1e6);
        for (let k = 3; k + 1 < r.length; k += 2) { a += r[k]; b += r[k + 1]; lat.push(a / 1e6); lng.push(b / 1e6); }
        if (lat.length < 2) return;
        out.push({ c, lat, lng, s: Math.min(...lat), n: Math.max(...lat), w: Math.min(...lng), e: Math.max(...lng) });
      });
      return out;
    }
    const area2 = r => { let s = 0; for (let i = 0, n = r.length; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
    function inside(x, y, r) {
      let c = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const a = r[i], b = r[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    }
    const bboxOf = r => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; r.forEach(p => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }); return [x0, y0, x1, y1]; };

    /* 囲み（[緯度, 経度] の並び）から、道で囲まれたブロックの外まわりを出す
       opt：{ kinds: Set(使う種類), snap: [[緯度, 経度], …]（そろえる点）, land: [[[緯度, 経度], …], …]（土地の区切りの線。無くてもよい）}
       ・道で囲まれたブロックが大きく（1ha 以上）、囲みが一部だけにかかっているときは、そのブロックの中を土地の区切りで分け、
         囲みに半分以上入る土地だけをとる（道がない畑・林などで、土地の境で線を引くため）
       返り値：{ ring: [[緯度, 経度], …], blocks: ブロックの数, lands: 土地の区切りで分けた所の数, parts: 離れた固まりの数 } か { err: '…' } */
    function build(ways, loopLL, opt) {
      // 大きいブロックが集めた四角からはみ出して見つからないときは、四角を広げてもう一度
      let r;
      for (const mgMin of [150, 600, 1500]) { r = build1(ways, loopLL, opt, mgMin); if (!r.miss) break; }
      delete r.miss;
      return r;
    }
    const BIG = 10000;        // これより広い（㎡）ブロックに囲みが一部だけかかるときは、土地の区切りで分ける
    const NEAR_ROAD = 7;      // 道の真ん中からこれより近い（m）土地の線は、道の端の線とみなして使わない
    /* 線分の一覧 → つながり（点・まわりの順）と面。land の線は、少しのずれ（30cm）をそろえ、行き止まりを7mまでつなぐ */
    function graph(segs) {
      const CELL = 50, grid = new Map(), TOL = 0.3;
      const cellsOf = (a, b, f) => {
        const cx0 = Math.floor(Math.min(a[0], b[0]) / CELL), cx1 = Math.floor(Math.max(a[0], b[0]) / CELL);
        const cy0 = Math.floor(Math.min(a[1], b[1]) / CELL), cy1 = Math.floor(Math.max(a[1], b[1]) / CELL);
        for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) f(x + ',' + y);
      };
      segs.forEach((s, i) => cellsOf([s.a[0] - TOL, s.a[1] - TOL], [s.b[0] + TOL, s.b[1] + TOL], k => { let g = grid.get(k); if (!g) grid.set(k, g = []); g.push(i); }));
      const done = new Set(), EPS = 1e-9;
      // 点 P が線分 s の途中（端でない所）に TOL 以内で乗っていれば、そこで区切る
      const onSeg = (s, P) => {
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L2 = dx * dx + dy * dy;
        if (!L2) return;
        const u = ((P[0] - s.a[0]) * dx + (P[1] - s.a[1]) * dy) / L2;
        if (u <= 0 || u >= 1) return;
        if (Math.hypot(s.a[0] + u * dx - P[0], s.a[1] + u * dy - P[1]) > TOL) return;
        if (Math.hypot(P[0] - s.a[0], P[1] - s.a[1]) <= TOL || Math.hypot(P[0] - s.b[0], P[1] - s.b[1]) <= TOL) return;
        s.cut.push([u, P]);
      };
      grid.forEach(list => {
        for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
          const i = list[p], j = list[q], key = i < j ? i * 1e6 + j : j * 1e6 + i;
          if (done.has(key)) continue; done.add(key);
          const s = segs[i], t = segs[j];
          if (s.land || t.land) { onSeg(s, t.a); onSeg(s, t.b); onSeg(t, s.a); onSeg(t, s.b); } // 土地の線：となりの土地と線が重なる所・T字の所
          const rx = s.b[0] - s.a[0], ry = s.b[1] - s.a[1], sx = t.b[0] - t.a[0], sy = t.b[1] - t.a[1];
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-12) continue; // 平行
          const qx = t.a[0] - s.a[0], qy = t.a[1] - s.a[1];
          const u = (qx * sy - qy * sx) / den, v = (qx * ry - qy * rx) / den;
          if (u < -EPS || u > 1 + EPS || v < -EPS || v > 1 + EPS) continue;
          let P;
          if (u <= EPS) P = s.a; else if (u >= 1 - EPS) P = s.b; else if (v <= EPS) P = t.a; else if (v >= 1 - EPS) P = t.b;
          else P = [s.a[0] + u * rx, s.a[1] + u * ry];
          if (u > EPS && u < 1 - EPS) s.cut.push([u, P]);
          if (v > EPS && v < 1 - EPS) t.cut.push([v, P]);
        }
      });

      // 点（30cm 以内はまとめる）と、点どうしのつながり
      const vg = new Map(), V = [], adj = [], road = [];
      const idOf = (p, isRoad) => {
        const gx = Math.floor(p[0] / 0.5), gy = Math.floor(p[1] / 0.5);
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
          for (const id of vg.get(x + ',' + y) || []) if (Math.hypot(V[id][0] - p[0], V[id][1] - p[1]) <= TOL) { if (isRoad) road[id] = true; return id; }
        }
        const id = V.length, k = gx + ',' + gy;
        V.push(p); adj.push(new Set()); road.push(!!isRoad);
        if (!vg.has(k)) vg.set(k, []); vg.get(k).push(id);
        return id;
      };
      const link = (a, b) => { if (a !== b) { adj[a].add(b); adj[b].add(a); } };
      segs.forEach(s => {
        const pts = [s.a, ...s.cut.sort((m, n) => m[0] - n[0]).map(c => c[1]), s.b];
        let prev = idOf(pts[0], !s.land);
        for (let k = 1; k < pts.length; k++) { const id = idOf(pts[k], !s.land); link(prev, id); prev = id; }
      });
      // 行き止まりの先が、ほかの線の少し手前で切れているときは、つなぐ（道は3m・土地の線は7m まで）
      const eGrid = new Map();
      adj.forEach((ns, a) => ns.forEach(b => { if (a < b) cellsOf(V[a], V[b], k => { let g = eGrid.get(k); if (!g) eGrid.set(k, g = []); g.push([a, b]); }); }));
      for (let a = 0; a < V.length; a++) {
        if (adj[a].size !== 1) continue;
        const p = V[a], only = [...adj[a]][0], far = road[a] ? 3 : NEAR_ROAD;
        let best = null, bd = far;
        cellsOf([p[0] - far, p[1] - far], [p[0] + far, p[1] + far], k => (eGrid.get(k) || []).forEach(([u, w]) => {
          if (u === a || w === a || !adj[u].has(w)) return;
          const A = V[u], B = V[w], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
          let t = L2 ? ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const Q = [A[0] + t * dx, A[1] + t * dy], d = Math.hypot(Q[0] - p[0], Q[1] - p[1]);
          if (d < bd && u !== only && w !== only) { bd = d; best = { u, w, t, Q }; }
        }));
        if (!best) continue;
        let m;
        if (best.t < 0.05 || Math.hypot(V[best.u][0] - best.Q[0], V[best.u][1] - best.Q[1]) < 0.5) m = best.u;
        else if (best.t > 0.95 || Math.hypot(V[best.w][0] - best.Q[0], V[best.w][1] - best.Q[1]) < 0.5) m = best.w;
        else {
          m = idOf(best.Q, road[best.u] && road[best.w]); adj[best.u].delete(best.w); adj[best.w].delete(best.u); link(best.u, m); link(m, best.w);
          [[best.u, m], [m, best.w]].forEach(e => cellsOf(V[e[0]], V[e[1]], k => { let g = eGrid.get(k); if (!g) eGrid.set(k, g = []); g.push(e); })); // 分けた線にも、ほかの行き止まりがつなげるように
        }
        link(a, m);
      }

      // 面を出す：どの線も、向きごとに1回ずつたどる
      const ord = adj.map((ns, v) => [...ns].sort((m, n) => Math.atan2(V[m][1] - V[v][1], V[m][0] - V[v][0]) - Math.atan2(V[n][1] - V[v][1], V[n][0] - V[v][0])));
      const nextOf = (u, v) => { const l = ord[v], i = l.indexOf(u); return l[(i - 1 + l.length) % l.length]; }; // 右に曲がる（左まわりの面をたどる）
      const seen = new Set(), N = V.length, faces = [];
      for (let u = 0; u < N; u++) for (const v of ord[u]) {
        if (seen.has(u * N + v)) continue;
        const cyc = []; let a = u, b = v, guard = 0;
        while (!seen.has(a * N + b) && guard++ < 400000) { seen.add(a * N + b); cyc.push(a); const c = nextOf(a, b); a = b; b = c; }
        const ring = cleanSpikes(cyc);
        if (ring.length < 3) continue;
        const xy = ring.map(i => V[i]), A = area2(xy);
        if (A > 20) faces.push({ ids: ring, xy, A, bb: bboxOf(xy) }); // 左まわり（正）が囲まれた面。外側（負）は使わない
      }
      return { V, ord, N, faces };
    }
    /* 面のうち、囲み（loop）に入っている割合（面の中に点を並べて数える）。pt：面の中の点を1つ返す（どのブロックの中かを調べる用） */
    function fracIn(f, loop) {
      if (f.fr !== undefined) return f.fr;
      const st = Math.max(0.5, Math.sqrt(f.A) / 9);
      let tot = 0, inn = 0;
      for (let x = f.bb[0] + st / 2; x < f.bb[2]; x += st) for (let y = f.bb[1] + st / 2; y < f.bb[3]; y += st) {
        if (!inside(x, y, f.xy)) continue;
        if (!f.pt) f.pt = [x, y];
        tot++; if (inside(x, y, loop)) inn++;
      }
      if (!f.pt) f.pt = f.xy[0];
      return (f.fr = tot ? inn / tot : 0);
    }
    function build1(ways, loopLL, opt, mgMin) {
      opt = opt || {};
      const kinds = opt.kinds || new Set([1, 2, 4, 5]);
      if (!loopLL || loopLL.length < 3) return { err: 'もう少し大きく、ぐるっと囲んでください' };
      const lat0 = loopLL.reduce((s, p) => s + p[0], 0) / loopLL.length, lng0 = loopLL.reduce((s, p) => s + p[1], 0) / loopLL.length;
      const cos = Math.cos(lat0 * Math.PI / 180);
      const toXY = (la, ln) => [(ln - lng0) * R_LNG * cos, (la - lat0) * R_LAT];
      const toLL = p => [lat0 + p[1] / R_LAT, lng0 + p[0] / (R_LNG * cos)];
      const loop = loopLL.map(p => toXY(p[0], p[1]));
      const lb = bboxOf(loop), size = Math.max(lb[2] - lb[0], lb[3] - lb[1]);
      const mg = Math.max(mgMin, size * 0.6); // 囲みのまわりのブロックが切れないよう、少し広めに道を集める
      const box = [lb[0] - mg, lb[1] - mg, lb[2] + mg, lb[3] + mg];
      const llBox = [toLL([box[0], box[1]]), toLL([box[2], box[3]])]; // [[s, w], [n, e]]
      const hitBox = (x0, y0, x1, y1) => !(x1 < box[0] || x0 > box[2] || y1 < box[1] || y0 > box[3]);
      const hitLoop = f => !(f.bb[2] < lb[0] || f.bb[0] > lb[2] || f.bb[3] < lb[1] || f.bb[1] > lb[3]);

      // 1. 道の線を集める（四角にかかるものだけ）
      const roads = [];
      ways.forEach(wy => {
        if (!kinds.has(wy.c)) return;
        if (wy.n < llBox[0][0] || wy.s > llBox[1][0] || wy.e < llBox[0][1] || wy.w > llBox[1][1]) return;
        let prev = toXY(wy.lat[0], wy.lng[0]);
        for (let k = 1; k < wy.lat.length; k++) {
          const q = toXY(wy.lat[k], wy.lng[k]);
          if (hitBox(Math.min(prev[0], q[0]), Math.min(prev[1], q[1]), Math.max(prev[0], q[0]), Math.max(prev[1], q[1])) && (prev[0] !== q[0] || prev[1] !== q[1])) roads.push({ a: prev, b: q });
          prev = q;
        }
      });
      if (roads.length > 60000) return { err: '囲みが大きすぎます。もう少し小さく囲んでください' };
      const fresh = list => list.map(s => ({ a: s.a, b: s.b, land: !!s.land, cut: [] }));

      // 2. 道だけでブロックを出す
      let G = roads.length >= 3 ? graph(fresh(roads)) : { faces: [] };
      const blocks = G.faces;
      const pickedRoad = new Set(), bigs = [];
      blocks.forEach(f => {
        if (!hitLoop(f)) return;
        const fr = fracIn(f, loop);
        if (opt.land && f.A > BIG && fr > 0.15 && fr < 0.85) bigs.push(f);
        else if (fr >= 0.5) pickedRoad.add(f);
      });
      // 道がまったくない所：土地の区切りだけで分ける（四角全体を1つの大きいブロックとみなす）
      const noRoad = !blocks.length && opt.land && opt.land.length;
      let picked = [], lands = 0;

      // 3. 大きいブロックに囲みが一部だけかかる：そのブロックの中を、土地の区切りで分ける
      if (bigs.length || noRoad) {
        const rGrid = new Map(), RC = 20;
        roads.forEach(s => {
          for (let x = Math.floor((Math.min(s.a[0], s.b[0]) - NEAR_ROAD) / RC); x <= Math.floor((Math.max(s.a[0], s.b[0]) + NEAR_ROAD) / RC); x++)
            for (let y = Math.floor((Math.min(s.a[1], s.b[1]) - NEAR_ROAD) / RC); y <= Math.floor((Math.max(s.a[1], s.b[1]) + NEAR_ROAD) / RC); y++) {
              const k = x + ',' + y; if (!rGrid.has(k)) rGrid.set(k, []); rGrid.get(k).push(s);
            }
        });
        const nearRoad = p => (rGrid.get(Math.floor(p[0] / RC) + ',' + Math.floor(p[1] / RC)) || []).some(s => {
          const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L2 = dx * dx + dy * dy;
          let t = L2 ? ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          return Math.hypot(s.a[0] + t * dx - p[0], s.a[1] + t * dy - p[1]) < NEAR_ROAD;
        });
        const inBig = p => noRoad ? (p[0] >= lb[0] - 200 && p[0] <= lb[2] + 200 && p[1] >= lb[1] - 200 && p[1] <= lb[3] + 200)
          : bigs.some(f => p[0] >= f.bb[0] && p[0] <= f.bb[2] && p[1] >= f.bb[1] && p[1] <= f.bb[3] && inside(p[0], p[1], f.xy));
        const landSegs = [];
        opt.land.forEach(r => {
          if (!r || r.length < 3) return;
          let prev = toXY(r[0][0], r[0][1]);
          for (let k = 1; k <= r.length; k++) {
            const q = k < r.length ? toXY(r[k][0], r[k][1]) : toXY(r[0][0], r[0][1]);
            if (prev[0] !== q[0] || prev[1] !== q[1]) {
              const m = [(prev[0] + q[0]) / 2, (prev[1] + q[1]) / 2];
              if (inBig(m) && !nearRoad(m)) landSegs.push({ a: prev, b: q, land: true });
            }
            prev = q;
          }
        });
        if (landSegs.length > 80000) return { err: '囲みが大きすぎます。もう少し小さく囲んでください' };
        if (landSegs.length) {
          G = graph(fresh(roads.concat(landSegs)));
          const bigSet = new Set(bigs);
          G.faces.forEach(f => {
            if (!hitLoop(f)) return;
            const fr = fracIn(f, loop), p = f.pt;
            // どの道のブロックの中か（いちばん小さいもの）
            let par = null;
            blocks.forEach(b => { if ((!par || b.A < par.A) && p[0] >= b.bb[0] && p[0] <= b.bb[2] && p[1] >= b.bb[1] && p[1] <= b.bb[3] && inside(p[0], p[1], b.xy)) par = b; });
            if (noRoad || (par && bigSet.has(par))) { if (fr >= 0.5) { picked.push(f); lands++; } }
            else if (par ? pickedRoad.has(par) : fr >= 0.5) picked.push(f);
          });
        } else {
          picked = [...pickedRoad]; // 土地の区切りが無い所：道のブロックだけで決める
          bigs.forEach(f => { if (fracIn(f, loop) >= 0.5) picked.push(f); });
        }
      } else picked = [...pickedRoad];

      if (!G.faces.length) return { err: roads.length < 3 ? 'このあたりの道のデータがありません' : 'このあたりは、道で囲まれたブロックが見つかりません', miss: roads.length >= 3 ? 1 : 0 };
      const V = G.V, ord = G.ord, N = G.N, faces = G.faces;
      if (!picked.length) {
        // 小さく囲んだ：囲みの真ん中をふくむ、いちばん小さい面
        const c = loop.reduce((s, p) => [s[0] + p[0] / loop.length, s[1] + p[1] / loop.length], [0, 0]);
        const hit = faces.filter(f => inside(c[0], c[1], f.xy)).sort((m, n) => m.A - n.A)[0];
        if (!hit) return { err: '囲んだ所のまわりに、道で囲まれたブロックが見つかりません', miss: 1 };
        picked.push(hit);
      }
      // 6. えらんだブロックをまとめる：となりどうしで共有している線を消し、外まわりだけをたどる
      const es = new Set();
      picked.forEach(f => f.ids.forEach((a, i) => { const b = f.ids[(i + 1) % f.ids.length]; es.add(a * N + b); }));
      const rest = new Map(); // 点 → 出ていく線の先
      es.forEach(k => {
        const a = Math.floor(k / N), b = k - a * N;
        if (es.has(b * N + a)) return;
        if (!rest.has(a)) rest.set(a, []); rest.get(a).push(b);
      });
      const cycles = [], used = new Set();
      rest.forEach((outs, a0) => outs.forEach(b0 => {
        if (used.has(a0 * N + b0)) return;
        const cyc = []; let a = a0, b = b0, guard = 0;
        while (!used.has(a * N + b) && guard++ < 200000) {
          used.add(a * N + b); cyc.push(a);
          const cand = rest.get(b) || [];
          let c;
          if (cand.length <= 1) c = cand[0];
          else { // 1点でふれている所：右に曲がる方をとる（面のたどり方と同じ）
            const l = ord[b], i = l.indexOf(a);
            for (let k = 1; k <= l.length; k++) { const w = l[(i - k + l.length) % l.length]; if (cand.includes(w) && !used.has(b * N + w)) { c = w; break; } }
            if (c === undefined) c = cand[0];
          }
          if (c === undefined) break;
          a = b; b = c;
        }
        if (cyc.length >= 3) cycles.push(cyc);
      }));
      const outer = cycles.map(c => ({ c, A: area2(c.map(i => V[i])) })).filter(o => o.A > 0).sort((m, n) => n.A - m.A);
      if (!outer.length) return { err: '線をうまく作れませんでした。囲み直してください' };
      let ring = outer[0].c.map(i => V[i]);

      // 7. まっすぐな所の点を減らす（形は0.7mまで）
      ring = simplifyClosed(ring, 0.7);
      let ll = ring.map(toLL);
      // 8. 隣の区域の点が近く（3m）にあれば、その点にそろえる
      if (opt.snap && opt.snap.length) {
        const sx = opt.snap.map(p => ({ p, q: toXY(p[0], p[1]) }));
        ll = ring.map((q, i) => {
          let best = null, bd = 3;
          sx.forEach(s => { const d = Math.hypot(s.q[0] - q[0], s.q[1] - q[1]); if (d < bd) { bd = d; best = s.p; } });
          return best ? [best[0], best[1]] : ll[i];
        });
        ll = ll.filter((p, i) => { const n = ll[(i + 1) % ll.length]; return !(p[0] === n[0] && p[1] === n[1]); });
      }
      ll = ll.map(p => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7]);
      return { ring: ll, blocks: picked.length - lands, lands, parts: outer.length };
    }
    // 行き止まりの道（行って戻る所）を、面の線から外す
    function cleanSpikes(cyc) {
      let s = cyc.slice(), changed = true;
      while (changed && s.length >= 3) {
        changed = false;
        for (let i = 0; i < s.length && s.length >= 3; i++) {
          const n = s.length, p = s[(i - 1 + n) % n], q = s[(i + 1) % n];
          if (s[i] === p) { s.splice(i, 1); changed = true; i--; continue; }
          if (p === q) { // p → s[i] → p：s[i] は行き止まり
            const j = (i + 1) % n;
            if (j > i) { s.splice(j, 1); s.splice(i, 1); } else { s.splice(i, 1); s.splice(j, 1); }
            changed = true; i = Math.max(-1, i - 2);
          }
        }
      }
      return s.length >= 3 ? s : [];
    }
    // 閉じた線の点を減らす（ダグラス・ポイカー。tol はメートル）
    function simplifyClosed(r, tol) {
      if (r.length <= 4) return r;
      const dist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
      let far = 0, fd = -1;
      r.forEach((p, i) => { const d = Math.hypot(p[0] - r[0][0], p[1] - r[0][1]); if (d > fd) { fd = d; far = i; } });
      const pts = r.concat([r[0]]), keep = new Uint8Array(pts.length), last = pts.length - 1;
      keep[0] = keep[far] = keep[last] = 1;
      const st = [[0, far], [far, last]];
      while (st.length) {
        const [a, b] = st.pop();
        let mi = -1, md = tol;
        for (let i = a + 1; i < b; i++) { const d = dist(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
        if (mi >= 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
      }
      const out = pts.slice(0, last).filter((_, i) => keep[i]);
      return out.length >= 3 ? out : r;
    }
    return { decode, build };
  })();
  if (typeof module !== 'undefined' && module.exports) module.exports = core; // 手元の試し（node）

  /* ---------- 画面 ---------- */
  if (typeof window === 'undefined' || typeof L === 'undefined' || typeof startDraw !== 'function') return;

  const LS_NARROW = 'kuiki_michi_narrow', LS_LAND = 'kuiki_michi_land';
  const landOn = () => lsG(LS_LAND) !== '0' && !!window.tochiKugiri && typeof window.tochiKugiri.ringsIn === 'function'; // はじめは入
  let ways = null, loading = null, on = false, bound = false, stroke = null, line = null, touches = 0, quiet = 0; // quiet：なぞり終わりのすぐあとの「タップ」で点が増えないように
  const lsG = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsS = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 何もしない */ } };

  function load() {
    if (ways) return Promise.resolve(ways);
    if (!loading) {
      loading = fetch('osm/roads.json', { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(j => { ways = core.decode(j); return ways; })
        .catch(e => { loading = null; throw e; });
    }
    return loading;
  }
  const active = () => on && mode === 'draw' && draw && drawTap === 'line';
  const btn = () => document.getElementById('drawRoad');
  function paintBtn() {
    const b = btn(); if (!b) return;
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '道で囲む（なぞってください）' : '道で囲む';
    b.hidden = !draw || drawTap !== 'line';
    ['drawNarrow', 'drawLand'].forEach(id => { const n = document.getElementById(id); if (n) n.parentNode.hidden = !draw || drawTap !== 'line'; });
    const h = document.getElementById('drawHelp');
    if (h && on) h.textContent = 'ブロックを指でぐるっと大まかになぞって囲むと、まわりの道の真ん中に線を引きます。いくつかのブロックをまとめて囲むこともできます。道がない広い所（畑など）は、土地の区切りの線で囲みます（地図は2本指で動かします）。道：© OpenStreetMap contributors';
  }
  function setOn(v) {
    on = !!v && !!draw;
    const el = map && map.getContainer();
    if (el) {
      if (on) { map.dragging.disable(); el.style.touchAction = 'none'; el.classList.add('penmode'); }
      else { cancel(); map.dragging.enable(); el.style.touchAction = ''; el.classList.remove('penmode'); }
    }
    if (on) { bind(); load().catch(() => {}); }
    paintBtn();
    if (!on && draw && typeof redrawDraw === 'function') redrawDraw(); // 案内の文をもどす
    if (typeof window.renderTochiKugiri === 'function') { try { window.renderTochiKugiri(); } catch (e) { /* 何もしない */ } } // 土地の区切りを出す・隠す
  }
  function cancel() { stroke = null; if (line && map) { map.removeLayer(line); line = null; } }
  function bind() {
    if (bound || !map) return;
    bound = true;
    const el = map.getContainer();
    el.addEventListener('pointerdown', e => {
      touches++;
      if (!active()) return;
      if (touches > 1 || !e.isPrimary) { cancel(); map.dragging.enable(); return; } // 2本指：地図を動かす
      stroke = [map.mouseEventToLatLng(e)]; stroke.px = [[e.clientX, e.clientY]];
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* 何もしない */ }
    });
    el.addEventListener('pointermove', e => {
      if (!stroke || !active()) return;
      const last = stroke.px[stroke.px.length - 1];
      if (Math.hypot(e.clientX - last[0], e.clientY - last[1]) < 4) return;
      stroke.push(map.mouseEventToLatLng(e)); stroke.px.push([e.clientX, e.clientY]);
      if (!line) line = L.polyline([], { color: '#1D4ED8', weight: 4, dashArray: '2 8', interactive: false }).addTo(map);
      line.setLatLngs(stroke);
    });
    const up = () => {
      touches = Math.max(0, touches - 1);
      if (!active()) return;
      if (touches === 0) map.dragging.disable();
      if (!stroke) return;
      const st = stroke; stroke = null;
      quiet = Date.now() + 600;
      if (st.length < 8) { if (line) { map.removeLayer(line); line = null; } toast('もう少し大きく、ブロックをぐるっと囲んでください'); return; }
      run(st.map(ll => [ll.lat, ll.lng]));
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  async function run(loopLL) {
    let ws;
    try { ws = await load(); } catch (e) {
      if (line) { map.removeLayer(line); line = null; }
      toast('道のデータがまだありません（GitHub の Actions「OSM の道」で作ります）。電波の良い所でもう一度ためしてください'); return;
    }
    if (!draw) return;
    const kinds = new Set([1, 2, 4, 5]);
    if (lsG(LS_NARROW) === '1') { kinds.add(3); kinds.add(6); }
    const snap = [];
    if (drawSnapOn) polyTerrs().forEach(t => { if (t.id !== draw.targetId) t.polygon.forEach(v => snap.push(v)); });
    let land = null;
    if (landOn()) {
      // 囲みのまわり（約150m）の土地の線。読むのに時間がかかるときは、道だけで引く
      const la = loopLL.map(p => p[0]), ln = loopLL.map(p => p[1]), pd = 0.0015;
      const box = [Math.min(...la) - pd, Math.min(...ln) - pd * 1.25, Math.max(...la) + pd, Math.max(...ln) + pd * 1.25];
      const slow = setTimeout(() => toast('土地の区切りを読んでいます…'), 1200);
      try { land = await Promise.race([window.tochiKugiri.ringsIn(box), new Promise(res => setTimeout(() => res(null), 15000))]); } catch (e) { land = null; }
      clearTimeout(slow);
      if (!draw) return;
    }
    const r = core.build(ws, loopLL, { kinds, snap, land: land && land.length ? land : null });
    if (line) { map.removeLayer(line); line = null; }
    if (r.err) { toast(r.err); return; }
    pushHist();
    draw.points = r.ring.map(p => p.slice());
    draw.snaps = r.ring.map(v => sharedSnap(v, draw.targetId));
    draw.origs = r.ring.map(() => null);
    draw.edit = true; draw.sel = -1;
    quiet = Date.now() + 600;
    setOn(false);
    redrawDraw();
    const ns = draw.snaps.filter(Boolean).length;
    const what = r.lands ? (r.blocks ? `道の真ん中と土地の区切りで線を引きました（${r.blocks}ブロック・土地${r.lands}か所` : `土地の区切りで線を引きました（土地${r.lands}か所`) : `道の真ん中に線を引きました（${r.blocks}ブロック`;
    toast(`${what}・角${r.ring.length}か所${ns ? `・隣の区域とそろえた点${ns}` : ''}）。点を動かして直せます`
      + (r.parts > 1 ? '。離れた所は入れていません' : ''), null, { label: '元に戻す', fn: drawUndo });
  }

  /* ---------- ボタン ---------- */
  function setup() {
    const row = document.querySelector('#drawBar .row');
    if (!row || btn()) return;
    const b = document.createElement('button');
    b.className = 'btn small'; b.id = 'drawRoad'; b.hidden = true;
    b.onclick = () => setOn(!on);
    row.insertBefore(b, row.firstChild);
    const fold = document.querySelector('#drawBar .fold .row');
    if (fold) {
      const lb = document.createElement('label');
      lb.className = 'check'; lb.hidden = true;
      lb.innerHTML = '<input type="checkbox" id="drawNarrow">「道で囲む」で、細い道・通路・小川も境にする';
      fold.appendChild(lb);
      const cb = lb.querySelector('input');
      cb.checked = lsG(LS_NARROW) === '1';
      cb.onchange = () => lsS(LS_NARROW, cb.checked ? '1' : '0');
      const lb2 = document.createElement('label');
      lb2.className = 'check'; lb2.hidden = true;
      lb2.innerHTML = '<input type="checkbox" id="drawLand">「道で囲む」で、道がない広い所は、土地の区切りの線で囲む';
      fold.appendChild(lb2);
      const cb2 = lb2.querySelector('input');
      cb2.checked = lsG(LS_LAND) !== '0';
      cb2.onchange = () => { lsS(LS_LAND, cb2.checked ? '1' : '0'); if (typeof window.renderTochiKugiri === 'function') window.renderTochiKugiri(); };
    }
    paintBtn();
  }
  window.michi = {
    busy: () => active() || Date.now() < quiet,               // なぞっている間は、地図のタップで点を足さない（app.js の map の click）
    sync: () => { if (on && !active()) setOn(false); else paintBtn(); }, // 線引きの始め・終わり・タップの切りかえのとき
    off: () => setOn(false),
    showLand: () => active() && landOn(), // 「道で囲む」でなぞるときは、土地の区切りを地図に出す（tochi-kugiri.js）
    core
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();
})();
