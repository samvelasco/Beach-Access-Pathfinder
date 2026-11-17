// Real data from OpenStreetMap via the Overpass API: query, fetch (with mirrors), parse.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'));
  else root.Osm = factory(root.Geo);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo) {
  'use strict';

  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const WALK_HW = 'footway|path|steps|pedestrian|track|service|residential|living_street|cycleway|unclassified|tertiary|secondary|primary|trunk';

  // bbox = [south, west, north, east]
  function buildQuery(b) {
    const bb = b.map((v) => v.toFixed(6)).join(',');
    return '[out:json][timeout:45];(' +
      'way["natural"="beach"](' + bb + ');relation["natural"="beach"](' + bb + ');' +
      'way["leisure"="nature_reserve"](' + bb + ');relation["leisure"="nature_reserve"](' + bb + ');' +
      'way["boundary"="protected_area"](' + bb + ');relation["boundary"="protected_area"](' + bb + ');' +
      'way["highway"~"^(' + WALK_HW + ')$"](' + bb + ');' +
      'nwr["amenity"~"^(parking|toilets|shower)$"](' + bb + ');' +
      'node["highway"="bus_stop"](' + bb + ');' +
      ');out geom tags;';
  }

  async function fetchArea(bbox, opts) {
    opts = opts || {};
    const f = opts.fetch || fetch;
    const body = 'data=' + encodeURIComponent(buildQuery(bbox));
    const errors = [];
    for (const url of opts.endpoints || ENDPOINTS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 40000);
      try {
        const res = await f(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        clearTimeout(timer);
        return { elements: json.elements || [], source: url };
      } catch (e) {
        clearTimeout(timer);
        errors.push(new URL(url).host + ': ' + (e.name === 'AbortError' ? 'timed out' : e.message));
      }
    }
    throw new Error('Could not load OpenStreetMap data. ' + errors.join('; '));
  }

  const pts = (geom) => (geom || []).map((g) => [g.lat, g.lon]);
  const centroid = (ps) => [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];

  function polyFromElement(el) {
    const tags = el.tags || {};
    const extra = { id: el.type + '/' + el.id, name: tags.name || null, tags };
    if (el.type === 'way') {
      const ring = pts(el.geometry);
      if (ring.length >= 4 && Geo.key(ring[0]) === Geo.key(ring[ring.length - 1])) return Geo.makePoly([ring], [], extra);
      return null;
    }
    if (el.type === 'relation') {
      const outer = Geo.assembleRings((el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => pts(m.geometry)));
      const inner = Geo.assembleRings((el.members || []).filter((m) => m.type === 'way' && m.role === 'inner').map((m) => pts(m.geometry)));
      if (outer.length) return Geo.makePoly(outer, inner, extra);
    }
    return null;
  }

  function parse(elements) {
    const out = { beaches: [], reserves: [], ways: [], parking: [], toilets: [], busStops: [] };
    for (const el of elements) {
      const t = el.tags || {};
      if (t.natural === 'beach') { const p = polyFromElement(el); if (p) out.beaches.push(p); }
      else if (t.leisure === 'nature_reserve' || t.boundary === 'protected_area') { const p = polyFromElement(el); if (p) out.reserves.push(p); }
      else if (t.highway && el.type === 'way' && el.geometry) {
        if (t.highway === 'bus_stop') continue;
        out.ways.push({ id: 'way/' + el.id, tags: t, pts: pts(el.geometry) });
      } else if (t.highway === 'bus_stop' && el.type === 'node') out.busStops.push([el.lat, el.lon]);
      else if (t.amenity) {
        let pt = null;
        if (el.type === 'node') pt = [el.lat, el.lon];
        else if (el.geometry && el.geometry.length) pt = centroid(pts(el.geometry));
        else if (el.bounds) pt = [(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2];
        if (!pt) continue;
        if (t.amenity === 'parking') out.parking.push(pt); else out.toilets.push(pt);
      }
    }
    return out;
  }

  return { ENDPOINTS, buildQuery, fetchArea, parse };
});
