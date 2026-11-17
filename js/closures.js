// Closure zones: date windows ("January 1 - August 31", "Year-round"), active-on-date checks, and circle polygons.
// A closure = { id, name, kind, poly, win, range, hard, note, source, species }.
//   win   = { sm, sd, em, ed } repeating every year (may wrap past New Year), or null = always
//   range = { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } one-off (used for reports and curated notices)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'));
  else root.Closures = factory(root.Geo);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo) {
  'use strict';
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthNo = (s) => MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()) + 1;

  // Returns a window, null for "always", or undefined when the text can't be understood.
  function parseWindow(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s || /year[\s-]*round|all year|always|permanent/i.test(s)) return null;
    const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*(?:-|–|—|to|through|thru)\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})/i);
    if (!m) return undefined;
    const sm = monthNo(m[1]), em = monthNo(m[3]);
    if (!sm || !em) return undefined;
    return { sm, sd: Number(m[2]), em, ed: Number(m[4]) };
  }

  const md = (date) => (date.getMonth() + 1) * 100 + date.getDate();
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  function isActive(c, date) {
    if (c.range) { const k = iso(date); return (!c.range.from || k >= c.range.from) && (!c.range.to || k <= c.range.to); }
    if (c.win === undefined) return true; // unreadable dates: assume closed, the safe side
    if (c.win === null) return true;
    const v = md(date), a = c.win.sm * 100 + c.win.sd, b = c.win.em * 100 + c.win.ed;
    return a <= b ? v >= a && v <= b : v >= a || v <= b;
  }

  // Regular polygon approximating a circle (radius in metres), as a Geo poly.
  function circlePoly(lat, lon, radiusM, extra, n) {
    n = n || 16;
    const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
    const ring = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([lat + dLat * Math.sin(a), lon + dLon * Math.cos(a)]); }
    ring.push(ring[0]);
    return Geo.makePoly([ring], [], extra);
  }

  function windowLabel(c) {
    if (c.range) return (c.range.from || '') + ' → ' + (c.range.to || 'until further notice');
    if (c.win === null) return 'Year-round';
    if (c.win === undefined) return c.rawDates || 'dates not stated';
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[c.win.sm - 1] + ' ' + c.win.sd + ' – ' + M[c.win.em - 1] + ' ' + c.win.ed;
  }

  // Closure (if any) that covers a point on this date.
  function at(list, pt, date) {
    for (const c of list || []) if (isActive(c, date) && Geo.pointInPoly(pt, c.poly)) return c;
    return null;
  }

  return { parseWindow, isActive, circlePoly, windowLabel, at, iso };
});
