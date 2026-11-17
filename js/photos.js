// Street-level photos along a route. Mapillary (crowd-sourced, needs a free client token) when a token is set;
// otherwise nearby geotagged photos from Wikimedia Commons (no key). Google Street View can't be embedded.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'));
  else root.Photos = factory(root.Geo);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo) {
  'use strict';
  const GRAPH = 'https://graph.mapillary.com/images';
  const COMMONS = 'https://commons.wikimedia.org/w/api.php';

  async function getJson(f, url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms || 15000) : null;
    try { const r = await f(url, ctl ? { signal: ctl.signal } : undefined); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { if (t) clearTimeout(t); }
  }
  const padBox = (pts, padM) => {
    const b = Geo.bboxOf(pts), dl = padM / 111320, dn = padM / (111320 * Math.cos((pts[0][0] * Math.PI) / 180));
    return [b[0] - dl, b[1] - dn, b[2] + dl, b[3] + dn];
  };

  async function mapillary(token, pts, f) {
    f = f || fetch;
    const [s, w, n, e] = padBox(pts, 30);
    const url = GRAPH + '?access_token=' + encodeURIComponent(token) + '&fields=id,thumb_1024_url,computed_geometry,geometry,compass_angle,captured_at&bbox=' + [w, s, e, n].map((v) => v.toFixed(6)).join(',') + '&limit=300';
    const j = await getJson(f, url);
    return (j.data || []).map((d) => {
      const g = d.computed_geometry || d.geometry; if (!g || !d.thumb_1024_url) return null;
      return { id: 'm' + d.id, src: 'mapillary', url: d.thumb_1024_url, lat: g.coordinates[1], lon: g.coordinates[0], heading: d.compass_angle, when: d.captured_at ? new Date(d.captured_at).toISOString().slice(0, 10) : null, credit: '© Mapillary contributors, CC BY-SA 4.0', page: 'https://www.mapillary.com/app/?pKey=' + d.id };
    }).filter(Boolean);
  }

  async function commons(pts, f) {
    f = f || fetch;
    const mid = pts[Math.floor(pts.length / 2)], span = Math.max(150, Math.min(900, Geo.hav([Geo.bboxOf(pts)[0], Geo.bboxOf(pts)[1]], [Geo.bboxOf(pts)[2], Geo.bboxOf(pts)[3]]) / 2 + 100));
    const url = COMMONS + '?action=query&format=json&origin=*&generator=geosearch&ggsnamespace=6&ggslimit=30&ggsradius=' + Math.round(Math.min(span, 1000)) + '&ggscoord=' + mid[0].toFixed(6) + '%7C' + mid[1].toFixed(6) +
      '&prop=coordinates%7Cimageinfo&iiprop=url%7Cextmetadata&iiurlwidth=640';
    const j = await getJson(f, url);
    const pages = Object.values((j.query && j.query.pages) || {});
    return pages.map((p) => {
      const c = p.coordinates && p.coordinates[0], ii = p.imageinfo && p.imageinfo[0]; if (!c || !ii) return null;
      const meta = ii.extmetadata || {}, lic = meta.LicenseShortName && meta.LicenseShortName.value, art = meta.Artist && String(meta.Artist.value).replace(/<[^>]+>/g, '');
      return { id: 'c' + p.pageid, src: 'commons', url: ii.thumburl || ii.url, lat: c.lat, lon: c.lon, heading: null, when: null, title: String(p.title || '').replace(/^File:/, ''), credit: 'Wikimedia Commons' + (art ? ', ' + art : '') + (lic ? ' (' + lic + ')' : ''), page: ii.descriptionurl };
    }).filter(Boolean);
  }

  // Insert points so no gap on the route is longer than stepM (vertices can be far apart on straight paths)
  function densify(pts, stepM) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const d = Geo.hav(pts[i - 1], pts[i]), n = Math.ceil(d / stepM);
      for (let k = 1; k <= n; k++) { const f = k / n; out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]); }
    }
    return out;
  }

  // Closest photo to sample points about every spacingM along the route (each photo used once), within maxM
  function alongRoute(route, photos, spacingM, maxM) {
    spacingM = spacingM || 60; maxM = maxM || 45;
    const pts = densify(route, 10), seen = new Set(), out = []; let acc = spacingM;
    for (let i = 0; i < pts.length; i++) {
      if (i) acc += Geo.hav(pts[i - 1], pts[i]);
      if (acc < spacingM && i !== pts.length - 1) continue;
      acc = 0;
      let best = null, bd = maxM;
      for (const p of photos) { const d = Geo.hav(pts[i], [p.lat, p.lon]); if (d < bd && !seen.has(p.id)) { bd = d; best = p; } }
      if (best) { seen.add(best.id); out.push(Object.assign({ at: pts[i], dist: Math.round(bd) }, best)); }
    }
    return out;
  }

  function nearest(photos, pt, maxM) {
    let best = null, bd = maxM || 45;
    for (const p of photos) { const d = Geo.hav(pt, [p.lat, p.lon]); if (d < bd) { bd = d; best = Object.assign({ dist: Math.round(d) }, p); } }
    return best;
  }

  return { mapillary, commons, alongRoute, nearest };
});
