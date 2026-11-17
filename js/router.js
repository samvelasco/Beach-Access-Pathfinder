// Routing on the real OpenStreetMap walking network, with protected-area and nesting-season awareness,
// beach access point detection, and accessible-entrance gap analysis.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'), require('./closures.js'));
  else root.Router = factory(root.Geo, root.Closures);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo, Closures) {
  'use strict';

  // Season is a placeholder default; confirm with the county or state before relying on it.
  const NESTING = { start: '05-01', end: '10-31' };
  const MODES = {
    walk: { label: 'Walking', speed: 1.3, reserveMult: 1.4, beachMult: 1.5, wheelchair: false },
    wheelchair: { label: 'Wheelchair / stroller', speed: 0.9, reserveMult: 1.4, beachMult: 1.5, wheelchair: true },
    lowimpact: { label: 'Low-impact', speed: 1.3, reserveMult: 6, beachMult: 4, wheelchair: false },
  };
  const BASE = { footway: 1, pedestrian: 1, path: 1, cycleway: 1, living_street: 1.1, residential: 1.1, service: 1.15, unclassified: 1.2, track: 1.3, tertiary: 1.3, secondary: 1.7, primary: 2.5, trunk: 3, steps: 2 };
  const PAVED = new Set(['paved', 'asphalt', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'wood', 'metal', 'compacted']);
  const SOFT = new Set(['sand', 'dirt', 'ground', 'earth', 'mud', 'grass', 'unpaved', 'gravel', 'fine_gravel', 'pebblestone', 'woodchips']);
  const BEACH_WAYS = new Set(['footway', 'path', 'steps', 'pedestrian', 'track', 'service', 'cycleway']);

  function mmdd(s) { const [m, d] = s.split('-').map(Number); return m * 100 + d; }
  function inNesting(date) {
    const v = (date.getMonth() + 1) * 100 + date.getDate();
    return v >= mmdd(NESTING.start) && v <= mmdd(NESTING.end);
  }

  // ---- per-way rules --------------------------------------------------------------------
  function wayRules(tags, mode) {
    const m = MODES[mode];
    const hw = tags.highway;
    const out = { mult: BASE[hw] || 1.3, timeFactor: 1, blocked: false, surface: 'other' };
    const yes = (v) => v === 'yes' || v === 'designated' || v === 'permissive';
    if ((tags.foot === 'no' || tags.access === 'no' || tags.access === 'private') && !yes(tags.foot)) { out.blocked = true; return out; }
    const surface = tags.surface || '';
    const soft = SOFT.has(surface) || (tags.tracktype && tags.tracktype !== 'grade1');
    const paved = PAVED.has(surface);
    const ROADLIKE = ['residential', 'living_street', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'pedestrian', 'cycleway'];
    out.surface = hw === 'steps' ? 'steps' : surface === 'sand' ? 'sand' : paved ? 'paved' : soft ? 'soft' : (!surface && ROADLIKE.indexOf(hw) >= 0) ? 'paved' : 'unknown';
    if (hw === 'steps') { out.timeFactor = 1.6; if (m.wheelchair && tags.ramp !== 'yes') out.blocked = true; }
    if (m.wheelchair) {
      if (tags.wheelchair === 'no') out.blocked = true;
      const inc = parseFloat(String(tags.incline || '').replace('%', ''));
      if (!isNaN(inc) && Math.abs(inc) > 10) out.blocked = true;
      if (surface === 'sand') { out.mult *= 9; out.timeFactor = 2.2; }
      else if (soft) { out.mult *= 5; out.timeFactor = 1.8; }
    } else if (surface === 'sand') { out.mult *= 2.2; out.timeFactor = 1.5; }
    else if (soft) { out.mult *= 1.3; out.timeFactor = 1.15; }
    return out;
  }

  // ---- graph ---------------------------------------------------------------------------
  function buildGraph(parsed) {
    const idOf = new Map(); const lat = []; const lon = []; const adj = [];
    const E = { from: [], to: [], len: [], way: [], reserve: [], beach: [], closure: [] };
    const closures = parsed.closures || [];
    const node = (p) => {
      const k = Geo.key(p); let i = idOf.get(k);
      if (i === undefined) { i = lat.length; idOf.set(k, i); lat.push(p[0]); lon.push(p[1]); adj.push([]); }
      return i;
    };
    const walkable = parsed.ways.filter((w) => w.tags.highway && w.pts.length > 1);
    walkable.forEach((w, wi) => {
      for (let i = 1; i < w.pts.length; i++) {
        const a = node(w.pts[i - 1]), b = node(w.pts[i]);
        if (a === b) continue;
        const len = Geo.hav(w.pts[i - 1], w.pts[i]);
        const mid = [(w.pts[i - 1][0] + w.pts[i][0]) / 2, (w.pts[i - 1][1] + w.pts[i][1]) / 2];
        let res = -1;
        for (let r = 0; r < parsed.reserves.length; r++) if (Geo.pointInPoly(mid, parsed.reserves[r])) { res = r; break; }
        let beach = 0;
        for (const bp of parsed.beaches) if (Geo.pointInPoly(mid, bp)) { beach = 1; break; }
        let clo = -1;
        for (let c = 0; c < closures.length; c++) if (Geo.pointInPoly(mid, closures[c].poly)) { clo = c; break; }
        for (const [f, t] of [[a, b], [b, a]]) {
          const ei = E.from.length;
          E.from.push(f); E.to.push(t); E.len.push(len); E.way.push(wi); E.reserve.push(res); E.beach.push(beach); E.closure.push(clo);
          adj[f].push(ei);
        }
      }
    });
    // spatial buckets for snapping (about 110 m)
    const B = 0.001, buckets = new Map();
    for (let i = 0; i < lat.length; i++) {
      const k = Math.floor(lat[i] / B) + ',' + Math.floor(lon[i] / B);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(i);
    }
    return { lat, lon, adj, E, ways: walkable, idOf, buckets, B, parsed };
  }

  // Cost of every directed edge for one mode and date. Infinity = blocked.
  function edgeCosts(g, mode, date) {
    const m = MODES[mode], nest = inNesting(date), n = g.E.from.length;
    const cost = new Float64Array(n), rules = g.ways.map((w) => wayRules(w.tags, mode));
    for (let i = 0; i < n; i++) {
      const r = rules[g.E.way[i]];
      if (r.blocked) { cost[i] = Infinity; continue; }
      const ci = g.E.closure[i];
      if (ci >= 0 && Closures.isActive(g.parsed.closures[ci], date)) { cost[i] = Infinity; continue; }
      let mult = r.mult;
      if (g.E.reserve[i] >= 0) mult *= m.reserveMult;
      if (g.E.beach[i] && nest) mult *= m.beachMult;
      cost[i] = g.E.len[i] * mult;
    }
    return { cost, rules };
  }

  function snap(g, p, costs, maxM) {
    const k0 = Math.floor(p[0] / g.B), k1 = Math.floor(p[1] / g.B);
    let best = -1, bd = maxM || 250;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const list = g.buckets.get((k0 + dr) + ',' + (k1 + dc));
      if (!list) continue;
      for (const i of list) {
        if (costs && !g.adj[i].some((e) => costs.cost[e] < Infinity)) continue;
        const d = Geo.hav(p, [g.lat[i], g.lon[i]]);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best < 0 ? null : { node: best, meters: bd };
  }

  // Snap a point to the nearest usable street segment (not just the nearest node). Returns the
  // projected point and the two segment ends with the cost to reach each from the projection.
  function snapEdge(g, p, costs, maxM) {
    const k0 = Math.floor(p[0] / g.B), k1 = Math.floor(p[1] / g.B);
    let best = null;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      const list = g.buckets.get((k0 + dr) + ',' + (k1 + dc)); if (!list) continue;
      for (const i of list) for (const e of g.adj[i]) {
        if (costs.cost[e] === Infinity) continue;
        const a = [g.lat[i], g.lon[i]], j = g.E.to[e], b = [g.lat[j], g.lon[j]];
        const d = Geo.distPtSeg(p, a, b);
        if (d <= (maxM || 250) && (!best || d < best.d)) best = { d, e, i, j, a, b };
      }
    }
    if (!best) return null;
    const lat0 = p[0], kx = Math.cos((lat0 * Math.PI) / 180);
    const ax = best.a[1] * kx, ay = best.a[0], bx = best.b[1] * kx, by = best.b[0], px = p[1] * kx, py = p[0];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const proj = [best.a[0] + (best.b[0] - best.a[0]) * t, best.a[1] + (best.b[1] - best.a[1]) * t];
    const ec = costs.cost[best.e];
    return {
      meters: best.d, proj,
      sources: [{ node: best.i, cost: ec * t, lead: Geo.hav(proj, best.a) }, { node: best.j, cost: ec * (1 - t), lead: Geo.hav(proj, best.b) }],
    };
  }

  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let l = 2 * i + 1; if (l >= n) break;
          if (l + 1 < n && k[l + 1] < k[l]) l++;
          if (k[l] >= lk) break;
          k[i] = k[l]; v[i] = v[l]; i = l;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  // Least-cost distances from one node to every reachable node.
  function dijkstra(g, src, costs) {
    const n = g.lat.length, dist = new Float64Array(n).fill(Infinity), prevE = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n), h = new Heap();
    for (const s0 of (typeof src === 'number' ? [{ node: src, cost: 0 }] : src)) if (s0.cost < dist[s0.node]) { dist[s0.node] = s0.cost; h.push(s0.cost, s0.node); }
    while (h.size) {
      const u = h.pop();
      if (done[u]) continue; done[u] = 1;
      for (const e of g.adj[u]) {
        const c = costs.cost[e]; if (c === Infinity) continue;
        const v = g.E.to[e], nd = dist[u] + c;
        if (nd < dist[v]) { dist[v] = nd; prevE[v] = e; h.push(nd, v); }
      }
    }
    return { dist, prevE };
  }

  function pathTo(g, res, target) {
    if (res.dist[target] === Infinity) return null;
    const edges = [];
    for (let v = target; res.prevE[v] !== -1; v = g.E.from[res.prevE[v]]) edges.push(res.prevE[v]);
    edges.reverse();
    return edges;
  }

  function stats(g, edges, costs, mode) {
    const m = MODES[mode];
    const s = { meters: 0, minutes: 0, paved: 0, soft: 0, sand: 0, steps: 0, unknown: 0, beachMeters: 0, reserveMeters: 0, reserves: {}, latlngs: [], segs: [] };
    const reserveName = (i) => g.parsed.reserves[i].name || 'Unnamed protected area';
    edges.forEach((e, k) => {
      const len = g.E.len[e], r = costs.rules[g.E.way[e]];
      s.meters += len; s.minutes += (len / m.speed) * r.timeFactor / 60;
      s[r.surface === 'other' ? 'unknown' : r.surface] += len;
      if (g.E.beach[e]) s.beachMeters += len;
      if (g.E.reserve[e] >= 0) { s.reserveMeters += len; const nm = reserveName(g.E.reserve[e]); s.reserves[nm] = (s.reserves[nm] || 0) + len; }
      const wy = g.ways[g.E.way[e]];
      s.segs.push({ name: wy.tags.name || null, hw: wy.tags.highway, surface: r.surface, reserve: g.E.reserve[e] >= 0 ? reserveName(g.E.reserve[e]) : null, beach: !!g.E.beach[e] });
      if (k === 0) s.latlngs.push([g.lat[g.E.from[e]], g.lon[g.E.from[e]]]);
      s.latlngs.push([g.lat[g.E.to[e]], g.lon[g.E.to[e]]]);
    });
    return s;
  }

  // ---- beach access points ---------------------------------------------------------------
  function classifyAccess(tags) {
    const yes = (v) => v === 'yes' || v === 'designated';
    if (tags.highway === 'steps') return { ada: 'no', why: 'Mapped as steps' };
    if (tags.wheelchair === 'no') return { ada: 'no', why: 'Mapped as not wheelchair accessible' };
    if (yes(tags.wheelchair)) return { ada: 'yes', why: 'Mapped as wheelchair accessible' };
    const s = tags.surface || '';
    if (PAVED.has(s)) return { ada: 'likely', why: 'Paved or boardwalk surface, not confirmed' };
    if (SOFT.has(s)) return { ada: 'no', why: 'Soft surface (' + s + ')' };
    return { ada: 'unknown', why: 'Accessibility not mapped' };
  }

  function nearest(p, list, maxM) {
    let best = Infinity; for (const q of list) { const d = Geo.hav(p, q); if (d < best) best = d; }
    return best <= maxM ? Math.round(best) : null;
  }

  // Candidate = a node on a walkable way within `nearM` of a mapped beach; clustered so each entrance appears once.
  function findAccessPoints(g, nearM) {
    nearM = nearM || 40;
    const P = g.parsed; if (!P.beaches.length) return [];
    const cands = [];
    g.ways.forEach((w, wi) => {
      if (!BEACH_WAYS.has(w.tags.highway)) return;
      if (w.tags.access === 'private' || w.tags.foot === 'no') return;
      let best = null;
      for (const p of w.pts) {
        let d = Infinity;
        for (const b of P.beaches) { const dd = Geo.distToPoly(p, b); if (dd < d) d = dd; }
        if (d <= nearM && (!best || d < best.d)) best = { p, d };
      }
      if (best) cands.push({ wi, p: best.p, d: best.d });
    });
    cands.sort((a, b) => a.d - b.d);
    const picked = [];
    for (const c of cands) if (!picked.some((q) => Geo.hav(q.p, c.p) < 90)) picked.push(c);
    const streets = g.ways.filter((w) => w.tags.name && !BEACH_WAYS.has(w.tags.highway));
    const aps = picked.map((c) => {
      const w = g.ways[c.wi], cls = classifyAccess(w.tags);
      let name = w.tags.name;
      if (!name) {
        let bd = 160, street = null;
        for (const s of streets) for (const sp of s.pts) { const d = Geo.hav(c.p, sp); if (d < bd) { bd = d; street = s.tags.name; } }
        name = street ? 'Beach access near ' + street : 'Beach access';
      }
      let reserve = null;
      for (const r of P.reserves) { if (Geo.distToPoly(c.p, r) <= 100) { reserve = r.name || 'Unnamed protected area'; break; } }
      const node = g.idOf.get(Geo.key(c.p));
      return {
        id: 'ap' + (g.idOf.get(Geo.key(c.p)) || 0), name, lat: c.p[0], lon: c.p[1], node, ada: cls.ada, adaWhy: cls.why,
        parking: nearest(c.p, P.parking, 200), toilets: nearest(c.p, P.toilets, 250), transit: nearest(c.p, P.busStops, 300), reserve,
        surface: w.tags.surface || null,
      };
    });
    // number consistently from north to south
    aps.sort((a, b) => b.lat - a.lat);
    return aps.map((a, i) => Object.assign(a, { n: i + 1 }));
  }

  // Gaps between consecutive accessible (yes/likely) entrances along the shore.
  function accessGaps(aps, minGapM) {
    minGapM = minGapM || 1000;
    const acc = aps.filter((a) => a.ada === 'yes' || a.ada === 'likely');
    if (acc.length < 2) return { accessible: acc.length, total: aps.length, gaps: [] };
    const lat0 = acc[0].lat, k = Math.cos((lat0 * Math.PI) / 180);
    const xy = acc.map((a) => [a.lon * k, a.lat]);
    const mx = xy.reduce((s, p) => s + p[0], 0) / xy.length, my = xy.reduce((s, p) => s + p[1], 0) / xy.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of xy) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
    const order = acc.map((a, i) => ({ a, t: (xy[i][0] - mx) * ux + (xy[i][1] - my) * uy })).sort((p, q) => p.t - q.t).map((o) => o.a);
    const gaps = [];
    for (let i = 1; i < order.length; i++) {
      const m = Geo.hav([order[i - 1].lat, order[i - 1].lon], [order[i].lat, order[i].lon]);
      if (m >= minGapM) gaps.push({ from: order[i - 1], to: order[i], meters: m });
    }
    gaps.sort((a, b) => b.meters - a.meters);
    return { accessible: acc.length, total: aps.length, gaps };
  }

  // Active closure covering a point (an entrance, say) on a date, or null
  function closureAt(parsed, pt, date) { return Closures.at(parsed.closures || [], pt, date); }

  return { closureAt, NESTING, MODES, inNesting, wayRules, buildGraph, edgeCosts, snap, snapEdge, dijkstra, pathTo, stats, classifyAccess, findAccessPoints, accessGaps };
});
