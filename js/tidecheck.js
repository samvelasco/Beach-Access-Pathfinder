// "Will the tide cover the beach path?" Compares NOAA predicted water level (NAVD88) with ground elevation from the
// USGS 3DEP elevation service at the sand/beach points on a route. Predictions only: no waves, storm surge or erosion.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TideCheck = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
  const EPQS = 'https://epqs.nationalmap.gov/v1/json';
  const MARGIN_M = 0.3; // allowance for wave run-up and prediction error

  const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

  async function withTimeout(f, url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms || 12000) : null;
    try { return await f(url, ctl ? { signal: ctl.signal } : undefined); } finally { if (t) clearTimeout(t); }
  }

  // Predicted water level (metres, NAVD88) every 6 minutes for the day: [{ min: minutes since midnight, m }]
  async function waterLevels(station, date, f) {
    f = f || fetch;
    const url = API + '?product=predictions&application=beach-access-pathfinder&format=json&datum=NAVD&units=metric&time_zone=lst_ldt&station=' + encodeURIComponent(station) + '&begin_date=' + ymd(date) + '&end_date=' + ymd(date);
    const r = await withTimeout(f, url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.predictions) throw new Error((j.error && j.error.message) || 'NAVD88 predictions are not available at this station');
    return j.predictions.map((p) => ({ min: Number(p.t.slice(11, 13)) * 60 + Number(p.t.slice(14, 16)), m: Number(p.v) }));
  }

  // Ground elevation in metres (NAVD88) or null
  async function elevation(lat, lon, f) {
    f = f || fetch;
    const url = EPQS + '?x=' + lon.toFixed(6) + '&y=' + lat.toFixed(6) + '&units=Meters&wkid=4326&includeDate=false';
    try {
      const r = await withTimeout(f, url, 9000); if (!r.ok) return null;
      const j = await r.json(), v = Number(j.value);
      return isFinite(v) && v > -1000 ? v : null;
    } catch (e) { return null; }
  }

  // Minutes of the day when level + margin reaches the ground: merged into [{ from, to, peak }]
  function floodWindows(levels, groundM, margin) {
    margin = margin == null ? MARGIN_M : margin;
    const out = []; let cur = null;
    for (const p of levels) {
      if (p.m + margin >= groundM) { if (!cur) { cur = { from: p.min, to: p.min, peak: p.m }; out.push(cur); } cur.to = p.min; if (p.m > cur.peak) cur.peak = p.m; }
      else cur = null;
    }
    return out;
  }

  // Pick up to n points spread along a list, always keeping the first and last.
  function spread(pts, n) {
    if (pts.length <= n) return pts.slice();
    const out = []; for (let i = 0; i < n; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (n - 1))]);
    return out;
  }

  // points: [[lat, lon], ...] sand/beach points of the route (and the entrance). Returns a result object.
  async function check(opts) {
    const f = opts.fetch;
    const levels = await waterLevels(opts.station, opts.date, f);
    const pts = spread(opts.points, 6);
    const elev = (await Promise.all(pts.map((p) => elevation(p[0], p[1], f)))).map((e, i) => ({ pt: pts[i], m: e })).filter((x) => x.m != null);
    if (!elev.length) return { ok: false, reason: 'no-elevation', levels };
    const low = elev.reduce((a, b) => (b.m < a.m ? b : a));
    const windows = floodWindows(levels, low.m, opts.margin);
    const peak = levels.reduce((a, b) => (b.m > a.m ? b : a));
    return { ok: true, groundM: low.m, lowPoint: low.pt, windows, peakM: peak.m, peakMin: peak.min, marginM: opts.margin == null ? MARGIN_M : opts.margin, samples: elev.length, levels };
  }

  const fmtMin = (m) => { let h = Math.floor(m / 60), mm = m % 60; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + ':' + String(mm).padStart(2, '0') + ' ' + ap; };

  return { waterLevels, elevation, floodWindows, spread, check, fmtMin, MARGIN_M };
});
