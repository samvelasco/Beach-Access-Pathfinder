// Small geometry helpers on [lat, lon] points. No dependencies; browser (window.Geo) and Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const R = 6371008.8, RAD = Math.PI / 180;

  function hav(a, b) {
    const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const toXY = (p, lat0) => [p[1] * RAD * R * Math.cos(lat0 * RAD), p[0] * RAD * R];

  function distPtSeg(p, a, b) {
    const lat0 = p[0], P = toXY(p, lat0), A = toXY(a, lat0), B = toXY(b, lat0);
    const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
  }
  function distPtRing(p, ring) {
    let best = Infinity;
    for (let i = 1; i < ring.length; i++) best = Math.min(best, distPtSeg(p, ring[i - 1], ring[i]));
    return best;
  }
  function pointInRing(p, ring) { // ray casting; x = lon, y = lat
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function bboxOf(points) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of points) { if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1]; }
    return [s, w, n, e];
  }
  const inBox = (p, b, pad) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;

  // poly = { outer: [ring...], inner: [ring...], bbox }
  function makePoly(outer, inner, extra) {
    const all = [].concat(...outer);
    return Object.assign({ outer, inner: inner || [], bbox: bboxOf(all) }, extra || {});
  }
  function pointInPoly(p, poly) {
    if (!inBox(p, poly.bbox, 0)) return false;
    if (!poly.outer.some((r) => pointInRing(p, r))) return false;
    return !poly.inner.some((r) => pointInRing(p, r));
  }
  function distToPoly(p, poly) {
    if (pointInPoly(p, poly)) return 0;
    let best = Infinity;
    for (const r of poly.outer) best = Math.min(best, distPtRing(p, r));
    return best;
  }
  const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);

  // Join way segments (arrays of [lat,lon]) into closed rings by matching endpoints.
  function assembleRings(segments) {
    const segs = segments.filter((s) => s && s.length > 1).map((s) => s.slice());
    const rings = [];
    while (segs.length) {
      let cur = segs.pop();
      let guard = 0;
      while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 5000) {
        const end = key(cur[cur.length - 1]);
        let found = -1, rev = false;
        for (let i = 0; i < segs.length; i++) {
          if (key(segs[i][0]) === end) { found = i; break; }
          if (key(segs[i][segs[i].length - 1]) === end) { found = i; rev = true; break; }
        }
        if (found < 0) break;
        let nxt = segs.splice(found, 1)[0];
        if (rev) nxt = nxt.reverse();
        cur = cur.concat(nxt.slice(1));
      }
      if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
    }
    return rings;
  }

  return { hav, distPtSeg, distPtRing, pointInRing, pointInPoly, distToPoly, bboxOf, makePoly, assembleRings, key, inBox };
});
