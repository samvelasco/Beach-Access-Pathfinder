// Official boundaries: USGS PAD-US protected areas and FWC Critical Wildlife Areas (shorebird and wading-bird
// closures), fetched live for the map view. Both are public ArcGIS REST services; failures are non-fatal.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'), require('./closures.js'));
  else root.Official = factory(root.Geo, root.Closures);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo, Closures) {
  'use strict';

  const PADUS = 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Protection_Mechanism_Category/FeatureServer/0/query';
  const CWA = 'https://gis.myfwc.com/hosting/rest/services/Open_Data/Critical_Wildlife_Areas_in_Florida/MapServer/7/query';

  const DESIGNATIONS = { NP: 'National Park', NM: 'National Monument', NWR: 'National Wildlife Refuge', NLS: 'National Seashore', WA: 'Wilderness Area', MPA: 'Marine protected area', SP: 'State park', SCA: 'State conservation area', LCA: 'Local conservation area', PCON: 'Private conservation land', CONE: 'Conservation easement', RNA: 'Research natural area', ACEC: 'Area of critical environmental concern', SW: 'State wilderness', LP: 'Local park', SOTH: 'State land', NCA: 'Conservation area' };
  const AGENCIES = { FWS: 'U.S. Fish and Wildlife Service', NPS: 'National Park Service', SPR: 'State parks', SDC: 'State conservation agency', SFW: 'State fish and wildlife', CITY: 'City', CNTY: 'County', NGO: 'Non-profit', DESG: 'Designation', NOAA: 'NOAA', SDNR: 'State natural resources', DOD: 'Dept. of Defense', REG: 'Regional agency', RWD: 'Water district' };

  const q = (o) => Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

  async function getJson(url, f, ms) {
    f = f || fetch;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms || 25000) : null;
    try {
      const r = await f(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'service error');
      return j;
    } finally { if (t) clearTimeout(t); }
  }

  // GeoJSON Polygon / MultiPolygon -> Geo poly (rings as [lat, lon])
  function polyFromGeoJSON(geom, extra) {
    if (!geom) return null;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    const outer = [], inner = [];
    for (const rings of polys) rings.forEach((ring, i) => (i === 0 ? outer : inner).push(ring.map((c) => [c[1], c[0]])));
    return outer.length ? Geo.makePoly(outer, inner, extra) : null;
  }

  // PAD-US: keep areas managed for biodiversity (GAP status 1 or 2) or with a clear conservation designation
  // (parks, refuges, preserves, conservation areas).
  async function fetchProtected(bbox, f) {
    const [s, w, n, e] = bbox;
    const url = PADUS + '?' + q({
      where: "GAP_Sts IN ('1','2') OR Des_Tp IN ('NP','NM','NWR','NLS','WA','SP','SCA','LCA','NCA','RNA','SW','PCON')", geometry: [w, s, e, n].join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
      outFields: 'Unit_Nm,Own_Name,Mang_Name,Des_Tp,GAP_Sts,Pub_Access', outSR: 4326, returnGeometry: 'true', maxAllowableOffset: 0.00006, geometryPrecision: 6, resultRecordCount: 200, f: 'geojson',
    });
    const j = await getJson(url, f);
    return parseProtected(j);
  }
  function parseProtected(j) {
    const out = [];
    for (const ft of (j && j.features) || []) {
      const p = ft.properties || {};
      const poly = polyFromGeoJSON(ft.geometry, {
        id: 'padus/' + (p.OBJECTID || p.Unit_Nm), name: p.Unit_Nm || 'Protected area', official: true, source: 'USGS PAD-US',
        agency: AGENCIES[p.Mang_Name] || p.Mang_Name || null, designation: DESIGNATIONS[p.Des_Tp] || p.Des_Tp || null, access: p.Pub_Access || 'UK', gap: p.GAP_Sts,
      });
      if (poly) out.push(poly);
    }
    return out;
  }

  // FWC Critical Wildlife Areas: posted closures for nesting birds, with yearly date windows.
  async function fetchCritical(bbox, f) {
    const [s, w, n, e] = bbox;
    const url = CWA + '?' + q({ where: '1=1', geometry: [w, s, e, n].join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: '*', outSR: 4326, returnGeometry: 'true', f: 'geojson' });
    const j = await getJson(url, f);
    return parseCritical(j);
  }
  function parseCritical(j) {
    const out = [];
    for (const ft of (j && j.features) || []) {
      const p = ft.properties || {};
      const poly = polyFromGeoJSON(ft.geometry, { name: p.Name });
      if (!poly) continue;
      out.push({
        id: 'cwa/' + (p.CWA_NO || p.Name), name: (p.Name || 'Critical Wildlife Area') + ' Critical Wildlife Area', kind: 'cwa', poly, hard: true,
        win: Closures.parseWindow(p.CloseDates), rawDates: p.CloseDates || null, species: p.FocalSpp || null, note: p.CWA_desc || null, source: 'FWC Critical Wildlife Areas',
      });
    }
    return out;
  }

  // Load both; each can fail independently.
  async function load(bbox, f) {
    const [pa, cw] = await Promise.allSettled([fetchProtected(bbox, f), fetchCritical(bbox, f)]);
    return { protected: pa.status === 'fulfilled' ? pa.value : [], critical: cw.status === 'fulfilled' ? cw.value : [], errors: [pa, cw].filter((x) => x.status === 'rejected').map((x) => String(x.reason && x.reason.message || x.reason)) };
  }

  // Add official protected areas to OSM-derived ones, skipping ones OSM already has under the same name.
  function mergeProtected(osmReserves, official) {
    const have = new Set(osmReserves.map((r) => String(r.name || '').toLowerCase()).filter(Boolean));
    const extra = official.filter((p) => !have.has(String(p.name || '').toLowerCase()));
    return osmReserves.concat(extra);
  }

  return { fetchProtected, fetchCritical, parseProtected, parseCritical, polyFromGeoJSON, load, mergeProtected };
});
