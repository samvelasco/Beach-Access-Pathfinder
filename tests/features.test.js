// Tests for closures, official data parsing, tide-vs-ground checks, photos, reports, routing around closures, and Spanish coverage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Geo = require('../js/geo.js');
const Closures = require('../js/closures.js');
const Official = require('../js/official.js');
const TideCheck = require('../js/tidecheck.js');
const Photos = require('../js/photos.js');
const Reports = require('../js/reports.js');
const Osm = require('../js/osm.js');
const Router = require('../js/router.js');
const I18n = require('../js/i18n.js');

const D = (y, m, d) => new Date(y, m - 1, d);

test('closure windows: yearly ranges, wrap-around, year-round, unreadable text', () => {
  const w = Closures.parseWindow('January 1 - August 31');
  assert.deepStrictEqual(w, { sm: 1, sd: 1, em: 8, ed: 31 });
  assert.ok(Closures.isActive({ win: w }, D(2026, 3, 15)));
  assert.ok(!Closures.isActive({ win: w }, D(2026, 11, 17)));
  const wrap = Closures.parseWindow('September 1 – March 31');
  assert.ok(Closures.isActive({ win: wrap }, D(2026, 12, 25)) && Closures.isActive({ win: wrap }, D(2026, 2, 1)) && !Closures.isActive({ win: wrap }, D(2026, 6, 1)));
  assert.strictEqual(Closures.parseWindow('Year-round'), null);
  assert.ok(Closures.isActive({ win: null }, D(2026, 6, 1)));
  assert.strictEqual(Closures.parseWindow('when posted'), undefined);
  assert.ok(Closures.isActive({ win: undefined }, D(2026, 6, 1)), 'unreadable dates are treated as closed');
  assert.ok(Closures.isActive({ range: { from: '2026-05-01', to: '2026-05-31' } }, D(2026, 5, 10)));
  assert.ok(!Closures.isActive({ range: { from: '2026-05-01', to: '2026-05-31' } }, D(2026, 6, 10)));
});

test('official parsers turn ArcGIS GeoJSON into polygons and closures', () => {
  const sq = [[-81, 29], [-81, 29.01], [-80.99, 29.01], [-80.99, 29], [-81, 29]];
  const pad = Official.parseProtected({ features: [{ properties: { Unit_Nm: 'Tomoka State Park', Mang_Name: 'SDC', Des_Tp: 'SP', Pub_Access: 'OA', GAP_Sts: '2' }, geometry: { type: 'Polygon', coordinates: [sq] } }] });
  assert.strictEqual(pad.length, 1); assert.strictEqual(pad[0].name, 'Tomoka State Park'); assert.strictEqual(pad[0].designation, 'State park'); assert.ok(pad[0].official);
  assert.ok(Geo.pointInPoly([29.005, -80.995], pad[0]));
  const cwa = Official.parseCritical({ features: [{ properties: { Name: 'Port Orange', CloseDates: 'January 1 - August 31', FocalSpp: 'nesting birds', CWA_NO: 'CWA 17-19' }, geometry: { type: 'MultiPolygon', coordinates: [[sq]] } }] });
  assert.strictEqual(cwa.length, 1); assert.ok(cwa[0].name.includes('Port Orange')); assert.ok(Closures.isActive(cwa[0], D(2026, 4, 1))); assert.ok(!Closures.isActive(cwa[0], D(2026, 11, 17)));
  const merged = Official.mergeProtected([{ name: 'tomoka state park', outer: [], inner: [] }], pad);
  assert.strictEqual(merged.length, 1, 'same-named OSM area is not duplicated');
});

test('official load: one failing service does not hide the other', async () => {
  const sq = [[-81, 29], [-81, 29.01], [-80.99, 29.01], [-80.99, 29], [-81, 29]];
  const f = async (url) => (url.includes('arcgis.com') ? { ok: false, status: 504 } : { ok: true, json: async () => ({ features: [{ properties: { Name: 'X', CloseDates: 'Year-round' }, geometry: { type: 'Polygon', coordinates: [sq] } }] }) });
  const r = await Official.load([29, -81, 29.01, -80.99], f);
  assert.strictEqual(r.protected.length, 0); assert.strictEqual(r.critical.length, 1); assert.strictEqual(r.errors.length, 1);
});

test('tide check: flood windows, lowest ground drives the warning, missing elevation handled', async () => {
  const levels = []; for (let m = 0; m < 1440; m += 6) levels.push({ min: m, m: 0.4 * Math.sin(((m - 360) / 1440) * 4 * Math.PI) });
  const w = TideCheck.floodWindows(levels, 0.5, 0.3);
  assert.ok(w.length >= 1 && w.every((x) => x.to >= x.from && x.peak + 0.3 >= 0.5));
  assert.strictEqual(TideCheck.floodWindows(levels, 2, 0.3).length, 0);
  const preds = levels.map((p) => ({ t: '2026-11-17 ' + String(Math.floor(p.min / 60)).padStart(2, '0') + ':' + String(p.min % 60).padStart(2, '0'), v: String(p.m) }));
  const f = async (url) => (url.includes('tidesandcurrents') ? { ok: true, json: async () => ({ predictions: preds }) } : { ok: true, json: async () => ({ value: String(url.includes('y=29.2') ? 0.4 : 3) }) });
  const res = await TideCheck.check({ station: '1', date: D(2026, 11, 17), points: [[29.2, -81], [29.3, -81]], fetch: f });
  assert.ok(res.ok); assert.strictEqual(res.groundM, 0.4); assert.ok(res.windows.length >= 1);
  const none = await TideCheck.check({ station: '1', date: D(2026, 11, 17), points: [[29.2, -81]], fetch: async (u) => (u.includes('tides') ? { ok: true, json: async () => ({ predictions: preds }) } : { ok: true, json: async () => ({ value: '-1000000' }) }) });
  assert.strictEqual(none.ok, false);
  await assert.rejects(TideCheck.waterLevels('1', D(2026, 11, 17), async () => ({ ok: true, json: async () => ({ error: { message: 'no datum' } }) })), /no datum/);
});

test('photos: Mapillary and Commons parsing, nearest and along-route selection', async () => {
  const pts = [[29.2, -81.0], [29.2005, -81.0], [29.201, -81.0]];
  const m = await Photos.mapillary('T', pts, async (u) => { assert.ok(u.includes('access_token=T')); return { ok: true, json: async () => ({ data: [{ id: '9', thumb_1024_url: 'http://x/1.jpg', computed_geometry: { coordinates: [-81.0, 29.2003] }, compass_angle: 90, captured_at: 1700000000000 }, { id: '10' }] }) }; });
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].src, 'mapillary'); assert.ok(m[0].credit.includes('Mapillary'));
  const c = await Photos.commons(pts, async () => ({ ok: true, json: async () => ({ query: { pages: { 1: { pageid: 1, title: 'File:Beach.jpg', coordinates: [{ lat: 29.2004, lon: -81.0 }], imageinfo: [{ thumburl: 'http://c/b.jpg', descriptionurl: 'http://c/p', extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, Artist: { value: '<a>Sam</a>' } } }] } } } }) }));
  assert.strictEqual(c.length, 1); assert.ok(c[0].credit.includes('CC BY 4.0') && !c[0].credit.includes('<'));
  assert.ok(Photos.nearest(m, [29.2003, -81.0], 40)); assert.strictEqual(Photos.nearest(m, [29.3, -81.0], 40), null);
  assert.ok(Photos.alongRoute(pts, m.concat(c), 30, 60).length >= 1);
});

test('reports: blocking types become closures, expire, and build a GitHub issue link', () => {
  const r = Reports.make({ type: 'blocked', lat: 29.2, lon: -81.0, note: 'rail broken' });
  assert.ok(r.local && r.id);
  const cl = Reports.toClosures([r, Reports.make({ type: 'hazard', lat: 29.2, lon: -81.0 })]);
  assert.strictEqual(cl.length, 1, 'hazards are notes only');
  assert.ok(Closures.isActive(cl[0], new Date()), 'active now');
  const later = new Date(); later.setDate(later.getDate() + 45);
  assert.ok(!Closures.isActive(cl[0], later), 'local reports expire after 30 days');
  assert.ok(Geo.pointInPoly([29.2, -81.0], cl[0].poly));
  const url = Reports.issueUrl('me/beach', r);
  assert.ok(url.startsWith('https://github.com/me/beach/issues/new?') && url.includes('rail%20broken'));
});

test('routing: an active closure blocks an entrance; it reopens when the closure is not in effect', () => {
  const L = (lat, lon) => ({ lat, lon });
  const els = [
    { type: 'way', id: 1, tags: { natural: 'beach' }, geometry: [L(29.2, -81.0), L(29.204, -81.0), L(29.204, -80.998), L(29.2, -80.998), L(29.2, -81.0)] },
    { type: 'way', id: 3, tags: { highway: 'residential', name: 'Ocean Ave' }, geometry: [L(29.2, -81.006), L(29.201, -81.006), L(29.203, -81.006), L(29.204, -81.006)] },
    { type: 'way', id: 4, tags: { highway: 'footway', name: 'A Walkover', surface: 'wood' }, geometry: [L(29.201, -81.006), L(29.201, -81.003), L(29.201, -81.0005)] },
    { type: 'way', id: 5, tags: { highway: 'footway', name: 'B Walkover', surface: 'wood' }, geometry: [L(29.203, -81.006), L(29.203, -81.003), L(29.203, -81.0005)] },
  ];
  const P = Osm.parse(els);
  P.closures = [{ id: 'c', name: 'Nesting area', kind: 'cwa', hard: true, poly: Closures.circlePoly(29.203, -81.0015, 120, {}), win: Closures.parseWindow('March 1 - August 31') }];
  const g = Router.buildGraph(P), aps = Router.findAccessPoints(g, 60);
  const b = aps.find((a) => a.name === 'B Walkover'), a = aps.find((x) => x.name === 'A Walkover');
  assert.ok(a && b);
  const inSeason = D(2026, 5, 1), off = D(2026, 11, 17);
  assert.ok(Router.closureAt(P, [b.lat, b.lon], inSeason), 'entrance B is inside the closure in season');
  assert.strictEqual(Router.closureAt(P, [a.lat, a.lon], inSeason), null);
  for (const [date, bOpen] of [[inSeason, false], [off, true]]) {
    const costs = Router.edgeCosts(g, 'walk', date), s = Router.snap(g, [29.2005, -81.006], costs), res = Router.dijkstra(g, s.node, costs);
    assert.strictEqual(res.dist[b.node] < Infinity, bOpen, String(date));
    assert.ok(res.dist[a.node] < Infinity, 'A stays reachable');
  }
});

test('Spanish: every t() string in app.js and every static data-i18n key has a translation', () => {
  const src = fs.readFileSync(__dirname + '/../js/app.js', 'utf8'), html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  const keys = new Set(); let m; const re = /\bt\('((?:[^'\\]|\\.)*)'/g;
  while ((m = re.exec(src))) keys.add(eval("'" + m[1] + "'"));
  const re2 = /data-i18n(?:-ph|-title|-aria)?="([^"]*)"/g;
  while ((m = re2.exec(html))) keys.add(m[1].replace('&#9678;', '◎').replace('&#9881;', '⚙'));
  Object.values(Reports.TYPES).forEach((x) => keys.add(x.label));
  const missing = [...keys].filter((k) => !(k in I18n.ES));
  assert.deepStrictEqual(missing, []);
  for (const k of keys) { const a = (k.match(/\{\d+\}/g) || []).sort().join(), b = (I18n.ES[k].match(/\{\d+\}/g) || []).sort().join(); assert.strictEqual(a, b, 'placeholders differ: ' + k); }
  I18n.setLang('es'); assert.strictEqual(I18n.t('Parking {0} m', 5), 'Estacionamiento 5 m'); I18n.setLang('en'); assert.strictEqual(I18n.t('Parking {0} m', 5), 'Parking 5 m');
});
