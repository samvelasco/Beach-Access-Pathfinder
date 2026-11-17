// Community reports. Static hosting has no database, so there are two layers:
//   1. Reports saved on this device (localStorage). Blocking reports also reroute this user.
//   2. Reviewed reports in data/community-reports.json, shipped with the app, shown to everyone.
// "Share with maintainers" opens a pre-filled GitHub issue (if a repo is configured); a maintainer reviews it and
// copies the entry into the JSON file.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'), require('./closures.js'));
  else root.Reports = factory(root.Geo, root.Closures);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo, Closures) {
  'use strict';
  const KEY = 'bap.reports.v1';
  const TYPES = {
    blocked: { icon: '⛔', blocks: true, label: 'Path or walkover blocked or damaged' },
    closure: { icon: '🚧', blocks: true, label: 'Posted closure (dune, shorebirds, turtles, construction)' },
    hazard: { icon: '⚠️', blocks: false, label: 'Hazard (rip current, erosion, debris)' },
    access: { icon: '♿', blocks: false, label: 'Accessibility feature (mat, ramp, beach wheelchair)' },
    other: { icon: '💬', blocks: false, label: 'Something else' },
  };
  const RADIUS_M = 25;

  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function loadLocal() { const s = store(); if (!s) return []; try { return JSON.parse(s.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function saveLocal(list) { const s = store(); if (s) try { s.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage full or blocked */ } }

  function make(o) {
    const now = new Date();
    return { id: 'r' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 5), type: TYPES[o.type] ? o.type : 'other', lat: o.lat, lon: o.lon, note: String(o.note || '').slice(0, 500), created: Closures.iso(now), until: o.until || null, local: true };
  }
  function add(o) { const l = loadLocal(), r = make(o); l.push(r); saveLocal(l); return r; }
  function remove(id) { saveLocal(loadLocal().filter((r) => r.id !== id)); }

  async function loadApproved(f, url) {
    f = f || fetch;
    try { const r = await f(url || 'data/community-reports.json', { cache: 'no-cache' }); if (!r.ok) return []; const j = await r.json(); return (j.reports || []).map((x) => Object.assign({ local: false }, x)); } catch (e) { return []; }
  }

  // Blocking reports become small closure zones. Local reports expire after 30 days unless an end date is given.
  function toClosures(list) {
    const out = [];
    for (const r of list) {
      const t = TYPES[r.type]; if (!t || !t.blocks) continue;
      let to = r.until; if (!to && r.local) { const d = new Date(r.created + 'T00:00:00'); d.setDate(d.getDate() + 30); to = Closures.iso(d); }
      out.push({ id: 'rep/' + r.id, name: t.label, kind: 'report', hard: true, poly: Closures.circlePoly(r.lat, r.lon, RADIUS_M, { name: t.label }), win: null, range: { from: r.created || null, to: to || null }, note: r.note, source: r.local ? 'Your report (this device)' : 'Community report (reviewed)' });
    }
    return out; // activity is checked per date when routing
  }

  function issueUrl(repo, r) {
    const body = 'Please review this report for data/community-reports.json.\n\n```json\n' + JSON.stringify({ type: r.type, lat: +r.lat.toFixed(6), lon: +r.lon.toFixed(6), note: r.note, created: r.created, until: r.until }, null, 2) + '\n```\n';
    return 'https://github.com/' + repo + '/issues/new?title=' + encodeURIComponent('Beach report: ' + TYPES[r.type].label) + '&labels=report&body=' + encodeURIComponent(body);
  }

  return { TYPES, RADIUS_M, loadLocal, add, remove, loadApproved, toClosures, issueUrl, make };
});
