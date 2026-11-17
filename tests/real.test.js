// Fixture-based tests: hand-made data shaped exactly like Overpass `out geom` output.
// They check the logic. They are NOT real data; real data loads live in the browser.
const test = require('node:test');
const assert = require('node:assert');
const Geo = require('../js/geo.js');
const Osm = require('../js/osm.js');
const Router = require('../js/router.js');

const L = (lat, lon) => ({ lat, lon });
// Roughly 0.0009 deg lat ~ 100 m. Beach polygon is the strip east of lon -81.000.
const beach = { type: 'way', id: 1, tags: { natural: 'beach' }, geometry: [L(29.200, -81.0), L(29.204, -81.0), L(29.204, -80.998), L(29.200, -80.998), L(29.200, -81.0)] };
const reserve = { type: 'way', id: 2, tags: { leisure: 'nature_reserve', name: 'Dune Preserve' }, geometry: [L(29.2022, -81.004), L(29.2038, -81.004), L(29.2038, -81.0005), L(29.2022, -81.0005), L(29.2022, -81.004)] };
const road = { type: 'way', id: 3, tags: { highway: 'residential', name: 'Ocean Ave' }, geometry: [L(29.200, -81.006), L(29.202, -81.006), L(29.204, -81.006)] };
// Paved boardwalk at lat 29.2010 and a steps-only access at 29.2030; a paved path through the reserve at 29.2030 too.
const boardwalk = { type: 'way', id: 4, tags: { highway: 'footway', name: 'Harbor Boardwalk', surface: 'wood', wheelchair: 'yes' }, geometry: [L(29.2010, -81.006), L(29.2010, -81.003), L(29.2010, -81.0005)] };
const stairs = { type: 'way', id: 5, tags: { highway: 'steps', name: 'North Stairs' }, geometry: [L(29.2030, -81.006), L(29.2030, -81.003), L(29.2030, -81.0005)] };
const link1 = { type: 'way', id: 6, tags: { highway: 'residential' }, geometry: [L(29.2010, -81.006), L(29.2030, -81.006)] };
const parking = { type: 'node', id: 7, lat: 29.2011, lon: -81.0055, tags: { amenity: 'parking' } };
const relBeach = { type: 'relation', id: 8, tags: { natural: 'beach' }, members: [
  { type: 'way', role: 'outer', geometry: [L(0, 0), L(0, 1), L(1, 1)] }, { type: 'way', role: 'outer', geometry: [L(1, 1), L(1, 0), L(0, 0)] }] };

const parsed = Osm.parse([beach, reserve, road, boardwalk, stairs, link1, parking, relBeach]);

test('parse sorts elements into layers and assembles relation rings', () => {
  assert.strictEqual(parsed.beaches.length, 2);
  assert.strictEqual(parsed.reserves.length, 1);
  assert.strictEqual(parsed.ways.length, 4);
  assert.strictEqual(parsed.parking.length, 1);
});

test('query builder includes the key layers', () => {
  const q = Osm.buildQuery([29.2, -81.01, 29.21, -81.0]);
  for (const s of ['natural"="beach', 'nature_reserve', 'protected_area', 'out geom']) assert.ok(q.includes(s), s);
});

test('access detection finds entrances, classifies accessibility, flags reserve, adds amenities', () => {
  const g = Router.buildGraph(parsed);
  const aps = Router.findAccessPoints(g, 60);
  assert.strictEqual(aps.length, 2);
  const boardwalkAp = aps.find((a) => a.name === 'Harbor Boardwalk'), stairsAp = aps.find((a) => a.name === 'North Stairs');
  assert.ok(boardwalkAp && stairsAp);
  assert.strictEqual(boardwalkAp.ada, 'yes');
  assert.strictEqual(stairsAp.ada, 'no');
  assert.ok(stairsAp.reserve === 'Dune Preserve');
  assert.strictEqual(aps[0].n, 1);
});

test('wheelchair routing refuses stairs; walking allows them', () => {
  const g = Router.buildGraph(parsed), date = new Date(2026, 10, 17);
  const start = [29.2005, -81.006];
  const stairNode = g.idOf.get(Geo.key([29.2030, -81.0005]));
  for (const [mode, expectRoute] of [['walk', true], ['wheelchair', false]]) {
    const costs = Router.edgeCosts(g, mode, date), s = Router.snap(g, start, costs);
    const res = Router.dijkstra(g, s.node, costs);
    assert.strictEqual(res.dist[stairNode] < Infinity, expectRoute, mode);
  }
});

test('low-impact mode pays more to cross a protected area than walking does', () => {
  const g = Router.buildGraph(parsed), date = new Date(2026, 10, 17);
  const target = g.idOf.get(Geo.key([29.2030, -81.0005])), start = g.idOf.get(Geo.key([29.2030, -81.006]));
  const w = Router.dijkstra(g, start, Router.edgeCosts(g, 'walk', date)).dist[target];
  const l = Router.dijkstra(g, start, Router.edgeCosts(g, 'lowimpact', date)).dist[target];
  assert.ok(l > w * 1.5, 'low-impact ' + l + ' vs walk ' + w);
});

test('route stats report distance, time and protected-area meters by name', () => {
  const g = Router.buildGraph(parsed), date = new Date(2026, 10, 17);
  const costs = Router.edgeCosts(g, 'walk', date);
  const start = g.idOf.get(Geo.key([29.2030, -81.006])), target = g.idOf.get(Geo.key([29.2030, -81.0005]));
  const res = Router.dijkstra(g, start, costs), edges = Router.pathTo(g, res, target);
  const st = Router.stats(g, edges, costs, 'walk');
  assert.ok(st.meters > 300 && st.minutes > 3);
  assert.ok(st.reserves['Dune Preserve'] > 0);
  assert.ok(st.steps > 0);
  assert.strictEqual(st.segs.length, edges.length);
  assert.ok(st.segs.some((x) => x.hw === 'steps') && st.segs.some((x) => x.reserve === 'Dune Preserve'));
});

test('nesting season raises cost of ways on the beach itself', () => {
  const sandWay = { id: 'x', tags: { highway: 'path', surface: 'sand' }, pts: [[29.2015, -80.9995], [29.2015, -80.9990]] };
  const p = Osm.parse([beach]); p.ways = [sandWay];
  const g = Router.buildGraph(p);
  const summer = Router.edgeCosts(g, 'lowimpact', new Date(2026, 6, 4)).cost[0];
  const winter = Router.edgeCosts(g, 'lowimpact', new Date(2026, 10, 17)).cost[0];
  assert.ok(summer > winter * 3);
});

test('access gaps: finds long stretches without accessible entrances', () => {
  const mk = (lat, ada) => ({ lat, lon: -81, ada });
  const r = Router.accessGaps([mk(29.20, 'yes'), mk(29.21, 'no'), mk(29.23, 'likely'), mk(29.2301, 'yes')], 1000);
  assert.strictEqual(r.accessible, 3);
  assert.strictEqual(r.gaps.length, 1);
  assert.ok(r.gaps[0].meters > 3000);
});

test('Overpass fetch falls back to the next mirror', async () => {
  let calls = 0;
  const fake = async (url) => { calls++; if (calls === 1) return { ok: false, status: 406 }; return { ok: true, json: async () => ({ elements: [beach] }) }; };
  const res = await Osm.fetchArea([29.2, -81.01, 29.21, -81.0], { fetch: fake, endpoints: ['https://a.example/x', 'https://b.example/y'] });
  assert.strictEqual(calls, 2);
  assert.strictEqual(res.elements.length, 1);
});

test('snapEdge snaps to the street segment, not a far-away node, and routes from there', () => {
  const g = Router.buildGraph(parsed), date = new Date(2026, 10, 17), costs = Router.edgeCosts(g, 'walk', date);
  const p = [29.20104, -81.0045]; // beside the middle of the boardwalk, ~70 m from either end node
  const sn = Router.snapEdge(g, p, costs, 250);
  assert.ok(sn && sn.meters < 20, 'snapped ' + (sn && sn.meters));
  assert.ok(sn.sources.every((x) => x.lead > 20), 'projection lies mid-segment');
  const res = Router.dijkstra(g, sn.sources, costs);
  const target = g.idOf.get(Geo.key([29.2010, -81.0005]));
  assert.ok(res.dist[target] < Infinity);
});
test('plain residential streets count as paved', () => {
  assert.strictEqual(Router.wayRules({ highway: 'residential' }, 'walk').surface, 'paved');
  assert.strictEqual(Router.wayRules({ highway: 'footway' }, 'walk').surface, 'unknown');
});
