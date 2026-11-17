// UI: Leaflet map with aerial imagery, live OpenStreetMap + official data, directions to beach access points.
(function () {
  'use strict';
  const { MODES, NESTING } = Router;
  const t = I18n.t;
  const CFG = window.CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
  const fmtMin = (m) => (m < 1 ? t('<1 min') : Math.round(m) + ' min');
  const ft = (m) => (m * 3.281).toFixed(1) + ' ft';
  const dstr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const PLACES = [
    ['Daytona Beach', 29.2108, -81.0228, 15], ['Daytona Beach Shores', 29.1655, -81.0125, 15],
    ['Ponce Inlet', 29.0950, -80.9400, 15], ['New Smyrna Beach', 29.0258, -80.9270, 15], ['Flagler Beach', 29.4750, -81.1270, 15],
  ];
  const MAX_SPAN = { lat: 0.07, lon: 0.09 }; // about 7 km x 8 km per load

  const DEMO = !!window.FORCE_DEMO || /[?&]demo/.test(location.search);
  const ls = { get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* blocked */ } } };
  const SET = Object.assign({ official: true, closures: true, reports: true, token: '' }, (() => { try { return JSON.parse(ls.get('bap.settings') || '{}'); } catch (e) { return {}; } })());
  const saveSet = () => ls.set('bap.settings', JSON.stringify(SET));
  const S = {
    mode: 'walk', date: new Date(), start: null, data: null, loading: false, selected: null, route: null, rank: null, tide: null, gaps: null, view: 'home', error: '',
    official: { protected: [], critical: [], status: 'idle' }, curated: [], approved: [], reports: Reports.loadLocal(), tc: null, photos: null, report: null,
  };

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, maxZoom: 19 }).setView([PLACES[0][1], PLACES[0][2]], PLACES[0][3]);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const BASES = [
    { name: 'Aerial (USGS)', layer: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16, attribution: 'Imagery: USGS National Map' }) },
    { name: 'Street map', layer: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }) },
  ];
  let baseI = 0; BASES[0].layer.addTo(map);
  const nextName = () => t(BASES[(baseI + 1) % BASES.length].name);
  const setLayerBtn = () => { $('layerBtn').textContent = t('Switch to: {0}', nextName()); };
  setLayerBtn();
  $('layerBtn').onclick = () => { map.removeLayer(BASES[baseI].layer); baseI = (baseI + 1) % BASES.length; BASES[baseI].layer.addTo(map); setLayerBtn(); };
  function demoTag() {
    let tag = document.querySelector('.demotag');
    if (!tag) { tag = document.createElement('div'); tag.className = 'demotag'; document.body.appendChild(tag); }
    tag.textContent = t('DEMO: invented sample entrances over real imagery (positions approximate)');
  }
  if (DEMO) { demoTag(); $('locBtn').hidden = true; }

  const gReserves = L.layerGroup().addTo(map), gBeach = L.layerGroup().addTo(map), gGaps = L.layerGroup().addTo(map), gClosures = L.layerGroup().addTo(map),
    gAps = L.layerGroup().addTo(map), gRoute = L.layerGroup().addTo(map), gStart = L.layerGroup().addTo(map), gReports = L.layerGroup().addTo(map), gPhotos = L.layerGroup().addTo(map);
  const markers = new Map();

  function toast(msg, ms) {
    const el = $('toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms || 4500);
  }

  // ---------- data loading ----------
  let loadedBox = null;
  async function loadArea() {
    leaveRoute();
    const b = map.getBounds(), box = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    if (box[2] - box[0] > MAX_SPAN.lat || box[3] - box[1] > MAX_SPAN.lon) { toast(t('Zoom in a little to load beach data (about 7 km across at most).')); return; }
    S.loading = true; S.error = ''; S.view = 'home'; S.route = null; S.rank = null; S.selected = null; $('areaBtn').hidden = true; render();
    try {
      const { elements, source } = DEMO ? { elements: window.DEMO_ELEMENTS, source: 'https://demo.local/' } : await Osm.fetchArea(box);
      const parsed = Osm.parse(elements);
      S.data = { parsed, osmReserves: parsed.reserves.slice(), source, box, g: null, aps: [] }; loadedBox = box;
      S.official = { protected: [], critical: [], status: DEMO ? 'done' : 'loading' };
      if (DEMO && window.DEMO_OFFICIAL) { S.official.protected = window.DEMO_OFFICIAL.protected(); S.official.critical = window.DEMO_OFFICIAL.critical(); S.curated = []; }
      rebuild();
      loadTides();
      if (!DEMO) loadOfficial(box);
    } catch (e) { S.error = e.message; S.data = null; }
    S.loading = false; render();
  }

  async function loadOfficial(box) {
    const r = await Official.load(box);
    if (!S.data || S.data.box !== box) return; // user moved on
    S.official = { protected: r.protected, critical: r.critical, status: r.errors.length ? 'partial' : 'done', errors: r.errors };
    const hadRank = !!S.rank; rebuild(); refreshRoute(hadRank);
    if (r.errors.length && !r.protected.length && !r.critical.length) toast(t('Official protected-area and closure data could not be loaded right now. OpenStreetMap data is still shown.'), 6000);
  }

  // Recompute everything that depends on the protected-area / closure lists.
  function rebuild() {
    const d = S.data, P = d.parsed;
    P.reserves = Official.mergeProtected(d.osmReserves, SET.official ? S.official.protected : []);
    P.closures = S.official.critical.concat(S.curated, Reports.toClosures(S.reports.concat(S.approved)));
    d.g = Router.buildGraph(P); d.aps = Router.findAccessPoints(d.g);
    S.gaps = Router.accessGaps(d.aps, DEMO ? 400 : 1000);
    cache.k = null; cache.search = null;
    drawData();
  }
  function refreshRoute(hadRank) {
    if (S.data && S.start && S.view === 'route') { if (hadRank) findBest(); else if (S.selected) directions(S.selected); else render(); } else render();
  }

  const cName = (c) => (c.kind === 'report' ? t(c.name) : c.name);
  const closureOf = (a) => (S.data ? Router.closureAt(S.data.parsed, [a.lat, a.lon], S.date) : null);
  const LAYERS = { reserves: () => SET.official, closures: () => SET.closures, reports: () => SET.reports };

  function drawData() {
    gReserves.clearLayers(); gBeach.clearLayers(); gAps.clearLayers(); gGaps.clearLayers(); gRoute.clearLayers(); markers.clear();
    const { parsed, aps } = S.data;
    for (const r of parsed.reserves) for (const ring of r.outer) {
      const poly = L.polygon([ring].concat(r.inner), r.official ? { color: '#0b6b2f', weight: 2, fillColor: '#34a853', fillOpacity: 0.16 } : { color: '#188038', weight: 2, dashArray: '6 5', fillColor: '#34a853', fillOpacity: 0.22 });
      poly.bindTooltip(esc(r.name || t('Protected area')) + ' (' + t('protected area') + ')', { sticky: true }).on('click', (e) => { L.DomEvent.stopPropagation(e); L.popup().setLatLng(e.latlng).setContent(reservePopup(r)).openOn(map); });
      if (!SET.official && r.official) continue;
      poly.addTo(gReserves);
    }
    for (const b of parsed.beaches) for (const ring of b.outer) L.polygon([ring].concat(b.inner), { color: '#f6d365', weight: 1, fillColor: '#f6d365', fillOpacity: 0.12, interactive: false }).addTo(gBeach);
    for (const a of aps) {
      const m = L.marker([a.lat, a.lon], { icon: pinIcon(a, false), keyboard: true, title: apName(a) }).addTo(gAps);
      m.bindPopup(() => apPopup(a));
      m.on('click', () => { select(a, false); });
      markers.set(a.id, m);
    }
    if (S.gaps && S.gaps.gaps.length) for (const gp of S.gaps.gaps) {
      L.polyline([[gp.from.lat, gp.from.lon], [gp.to.lat, gp.to.lon]], { color: '#e8710a', weight: 5, dashArray: '2 10', lineCap: 'round', opacity: 0.95 })
        .bindTooltip(t('No mapped accessible entrance for {0}', fmtDist(gp.meters)), { sticky: true }).addTo(gGaps);
    }
    drawClosures(); drawReports();
  }
  function drawClosures() {
    gClosures.clearLayers();
    if (!S.data || !SET.closures) return;
    for (const c of S.data.parsed.closures || []) {
      const on = Closures.isActive(c, S.date);
      for (const ring of c.poly.outer) {
        L.polygon([ring].concat(c.poly.inner), on ? { color: '#c5221f', weight: 2, fillColor: '#d93025', fillOpacity: 0.28 } : { color: '#9aa0a6', weight: 1.5, dashArray: '4 5', fillColor: '#9aa0a6', fillOpacity: 0.12 })
          .bindTooltip(esc(cName(c)) + ' (' + (on ? t('closed on this date') : t('not in effect on this date')) + ')', { sticky: true })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); L.popup().setLatLng(e.latlng).setContent(closurePopup(c, on)).openOn(map); }).addTo(gClosures);
      }
    }
  }
  function drawReports() {
    gReports.clearLayers();
    if (!SET.reports) return;
    for (const r of S.reports.concat(S.approved)) {
      const ty = Reports.TYPES[r.type] || Reports.TYPES.other;
      L.marker([r.lat, r.lon], { icon: L.divIcon({ className: '', html: '<div class="rep">' + ty.icon + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] }), title: t(ty.label) })
        .bindPopup(() => reportPopup(r)).addTo(gReports);
    }
  }
  const pinIcon = (a, sel) => L.divIcon({ className: '', html: '<div class="pin ' + (closureOf(a) ? 'closed' : a.ada) + (sel ? ' sel' : '') + '">' + a.n + '</div>', iconSize: [28, 28], iconAnchor: [14, 14] });

  async function loadTides() {
    S.tide = null;
    if (DEMO) { S.tide = { station: { id: 'demo', name: 'Sample station' }, hl: [{ type: 'High', time: '14:20', ft: 0.3 }, { type: 'Low', time: '08:18', ft: -1.4 }] }; render(); return; }
    try {
      const c = map.getCenter(), st = await Tides.nearestStation(c.lat, c.lng);
      if (!st || st.km > 120) return;
      const hl = await Tides.highLow(st.id, S.date);
      S.tide = { station: st, hl }; render();
      if (S.route && !S.tc) startTideCheck();
    } catch (e) { /* tides are optional */ }
  }

  // ---------- routing ----------
  const cache = {};
  function costs() {
    const k = S.mode + dstr(S.date);
    if (!cache.k || cache.k !== k || cache.g !== S.data.g) { cache.k = k; cache.g = S.data.g; cache.v = Router.edgeCosts(S.data.g, S.mode, S.date); cache.search = null; }
    return cache.v;
  }
  function searchFromStart() {
    const c = costs(), g = S.data.g;
    if (!cache.search || cache.search.key !== S.start.lat + ',' + S.start.lon) {
      const sn = Router.snapEdge(g, [S.start.lat, S.start.lon], c, 250);
      if (!sn) return null;
      cache.search = { key: S.start.lat + ',' + S.start.lon, snap: sn, snapM: sn.meters, res: Router.dijkstra(g, sn.sources, c) };
    }
    return cache.search;
  }
  function routeTo(a) {
    const g = S.data.g, c = costs(), sr = searchFromStart();
    if (!sr) return null;
    const clo = closureOf(a);
    if (clo) return { ap: a, none: true, why: 'closed', closure: clo };
    if (S.mode === 'wheelchair' && a.ada === 'no') return { ap: a, none: true, why: 'access' };
    const edges = Router.pathTo(g, sr.res, a.node);
    if (!edges) return { ap: a, none: true, why: 'path' };
    const st = Router.stats(g, edges, c, S.mode);
    const origin = edges.length ? g.E.from[edges[0]] : a.node;
    const src = sr.snap.sources.find((x) => x.node === origin) || sr.snap.sources[0];
    const lead = sr.snapM + src.lead; // metres from the start to the street, then along it to the first node
    st.meters += lead; st.minutes += lead / MODES[S.mode].speed / 60;
    st.leadPts = [sr.snap.proj];
    return { ap: a, st, snapM: sr.snapM, cost: sr.res.dist[a.node] };
  }
  function drawRoute(r) {
    gRoute.clearLayers();
    if (!r || !r.st) return;
    const pts = [[S.start.lat, S.start.lon]].concat(r.st.leadPts || [], r.st.latlngs, [[r.ap.lat, r.ap.lon]]);
    L.polyline(pts, { color: '#fff', weight: 9, opacity: 0.95 }).addTo(gRoute);
    L.polyline(pts, { color: '#1a73e8', weight: 5 }).addTo(gRoute);
    map.fitBounds(L.polyline(pts).getBounds().pad(0.25), { maxZoom: 18 });
  }
  function leaveRoute() { stopWalk(); S.tc = null; S.photos = null; gPhotos.clearLayers(); }
  function select(a, fly) {
    leaveRoute();
    if (S.selected) { const m = markers.get(S.selected.id); if (m) m.setIcon(pinIcon(S.selected, false)); }
    S.selected = a; const m = markers.get(a.id); if (m) m.setIcon(pinIcon(a, true));
    if (fly) { map.flyTo([a.lat, a.lon], Math.max(map.getZoom(), 17)); if (m) m.openPopup(); }
    S.route = null; gRoute.clearLayers(); S.view = 'home'; render();
  }
  function directions(a) {
    leaveRoute();
    if (!S.start) { toast(t('Set a start first: tap the map and choose "Start here", search a place, or use My location.')); return; }
    S.selected = a; const r = routeTo(a);
    if (!r) { toast(t('No walkable path found within 250 m of your start. Move the start closer to a street or path.')); return; }
    if (r.none) {
      const why = r.why === 'closed' ? t('closed: {0}', cName(r.closure)) : r.why === 'access' ? adaWhyText(a).toLowerCase() : t('no open path leads there');
      toast(t('{0} is not reachable in {1} mode ({2}).', apName(a), t(MODES[S.mode].label).toLowerCase(), why), 6000); S.route = null; S.view = 'home'; gRoute.clearLayers(); render(); return;
    }
    S.route = r; S.view = 'route'; drawRoute(r); render(); startTideCheck();
  }
  function findBest() {
    leaveRoute();
    if (!S.start) { toast(t('Set a start first: tap the map and choose "Start here", search a place, or use My location.')); return; }
    const sr = searchFromStart();
    if (!sr) { toast(t('No walkable path found within 250 m of your start.')); return; }
    const list = S.data.aps.map((a) => routeTo(a));
    const ok = list.filter((r) => r && r.st).sort((x, y) => x.cost - y.cost);
    S.rank = { ok, none: list.filter((r) => r && r.none).map((r) => r.ap) };
    if (ok.length) { S.route = ok[0]; S.selected = ok[0].ap; S.view = 'route'; drawRoute(ok[0]); startTideCheck(); }
    else toast(t('No beach entrance is reachable from here with these settings.'));
    render();
  }
  function setStart(lat, lon, label) {
    leaveRoute();
    S.start = { lat, lon, label: label || t('Dropped pin') }; cache.search = null; S.rank = null; S.route = null; gRoute.clearLayers();
    gStart.clearLayers();
    L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="flag" style="background:#188038"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(gStart).bindTooltip(t('Start: {0}', esc(S.start.label)));
    S.view = 'home'; render();
  }

  // ---------- tide vs. beach path ----------
  function beachPoints(r) {
    const st = r.st, pts = [];
    (st.segs || []).forEach((sg, i) => { if (sg.beach || sg.surface === 'sand') { pts.push(st.latlngs[i]); pts.push(st.latlngs[i + 1]); } });
    pts.push([r.ap.lat, r.ap.lon]);
    return pts.filter(Boolean);
  }
  async function startTideCheck() {
    const r = S.route; if (!r || !r.st) return;
    const key = r.ap.id + '|' + S.mode + '|' + dstr(S.date); S.tc = { key, state: 'loading' };
    try {
      let res;
      if (DEMO) res = { ok: true, sample: true, groundM: 0.45, peakM: 0.2, peakMin: 14 * 60 + 20, marginM: 0.3, windows: [{ from: 13 * 60 + 10, to: 15 * 60 + 40, peak: 0.2 }] };
      else {
        if (!S.tide || !S.tide.station || !S.tide.station.id) { S.tc = null; return; }
        res = await TideCheck.check({ station: S.tide.station.id, date: S.date, points: beachPoints(r) });
      }
      if (!S.tc || S.tc.key !== key) return;
      S.tc = { key, state: res.ok ? 'done' : 'na', res };
    } catch (e) { if (!S.tc || S.tc.key !== key) return; S.tc = { key, state: 'na', err: e.message }; }
    if (S.view === 'route') render();
  }
  function tideCheckHTML() {
    const c = S.tc; if (!c) return '';
    if (c.state === 'loading') return '<p class="sub"><span class="spin"></span>' + t('Checking tide against the sand on this route…') + '</p>';
    if (c.state === 'na') return '<div class="note info">' + t('Couldn\'t compare the tide with ground height here (no matching tide station or elevation data). Wet sand gets narrow near high tide.') + '</div>';
    const r = c.res, TC = TideCheck, sample = r.sample ? ' ' + t('(sample numbers)') : '';
    const fine = t('Prediction only: waves, storm surge and beach erosion are not included.');
    if (r.windows.length) {
      const span = r.windows.map((w) => TC.fmtMin(w.from) + '–' + TC.fmtMin(w.to)).join(', ');
      return '<div class="note warn"><b>' + t('Tide may cover the beach part of this route') + '</b> ' + t('about {0}', span) + sample + '. ' +
        t('Predicted water reaches {0} (NAVD88) and the lowest sand on the route is about {1}, with a {2} safety margin.', ft(r.peakM), ft(r.groundM), ft(r.marginM)) + ' ' + t('Go outside that window or choose another entrance.') + ' <span class="fine">' + fine + '</span></div>';
    }
    return '<div class="note good">' + t('Predicted tide stays below the sand on this route all day (high of {0} at {1}; lowest sand about {2}).', ft(r.peakM), TC.fmtMin(r.peakMin), ft(r.groundM)) + sample + ' <span class="fine">' + fine + '</span></div>';
  }

  // ---------- street-level photos ----------
  function routePts(r) { return [[S.start.lat, S.start.lon]].concat(r.st.leadPts || [], r.st.latlngs, [[r.ap.lat, r.ap.lon]]); }
  async function loadPhotos() {
    const r = S.route; if (!r || !r.st) return;
    if (DEMO) { S.photos = { status: 'done', src: 'demo', all: [], along: [] }; render(); return; }
    const key = r.ap.id + '|' + S.mode; S.photos = { status: 'loading', key }; render();
    try {
      const pts = routePts(r); let all, src;
      if (SET.token) { all = await Photos.mapillary(SET.token, pts); src = 'mapillary'; } else { all = await Photos.commons(pts); src = 'commons'; }
      if (!S.photos || S.photos.key !== key) return;
      S.photos = { status: 'done', key, src, all, along: Photos.alongRoute(pts, all, 60, 45).slice(0, 10) };
    } catch (e) { if (!S.photos || S.photos.key !== key) return; S.photos = { status: 'error', key, err: e.message }; }
    render();
  }
  function photosHTML(inWalk) {
    const P = S.photos;
    if (!P) return '<div class="row"><button class="btn" id="phBtn">' + t('Show street-level photos') + '</button></div>' + (SET.token ? '' : '<p class="fine">' + t('Without a Mapillary token this shows nearby photos from Wikimedia Commons. Add a free token in Settings for street-level coverage.') + '</p>');
    if (P.status === 'loading') return '<p class="sub"><span class="spin"></span>' + t('Looking for photos along the route…') + '</p>';
    if (P.status === 'error') return '<div class="note bad">' + t('Couldn\'t load photos: {0}', esc(P.err)) + '</div><div class="row"><button class="btn" id="phBtn">' + t('Try again') + '</button></div>';
    if (P.src === 'demo') return '<div class="note info">' + t('Photos are off in demo mode.') + '</div>';
    if (!P.all.length) return '<div class="note info">' + t('No photos found along this route. Mapillary coverage grows as people upload; you can add some at mapillary.com.') + '</div>';
    if (inWalk) return '';
    const credit = P.src === 'mapillary' ? '© Mapillary contributors (CC BY-SA 4.0)' : 'Wikimedia Commons';
    return '<div class="film">' + P.along.map((p, i) => '<button class="thumb" data-ph="' + i + '" title="' + esc(t('{0} m from the route', p.dist)) + '"><img loading="lazy" alt="' + esc(t('Photo near the route')) + '" src="' + esc(p.url) + '"></button>').join('') + '</div>' +
      '<div id="phBig"></div><p class="fine">' + t('Photos from {0}. They may be old or taken from a nearby road, so check conditions on site.', credit) + '</p>';
  }
  function showPhoto(p) {
    gPhotos.clearLayers();
    L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#a142f4', fillOpacity: 1 }).addTo(gPhotos);
    const big = $('phBig');
    if (big) big.innerHTML = '<a href="' + esc(p.page || p.url) + '" target="_blank" rel="noopener"><img class="bigph" alt="" src="' + esc(p.url) + '"></a><p class="fine">' + esc(p.credit) + (p.when ? ' · ' + esc(p.when) : '') + (p.title ? ' · ' + esc(p.title) : '') + '</p>';
  }

  // ---------- rendering ----------
  const adaWhyText = (a) => (a.adaWhy.indexOf('Soft surface (') === 0 ? t('Soft surface ({0})', a.adaWhy.slice(14, -1)) : t(a.adaWhy));
  const apName = (a) => (a.name.indexOf('Beach access near ') === 0 ? t('Beach access near {0}', a.name.slice(18)) : a.name === 'Beach access' ? t('Beach access') : a.name);
  const adaChip = (a) => {
    const c = closureOf(a);
    if (c) return '<span class="chip red">' + t('Closed: {0}', esc(cName(c))) + '</span>';
    return a.ada === 'yes' ? '<span class="chip blue">' + t('Wheelchair accessible (mapped)') + '</span>' : a.ada === 'likely' ? '<span class="chip green">' + t('Likely accessible (paved)') + '</span>' :
      a.ada === 'no' ? '<span class="chip red">' + (a.adaWhy.indexOf('steps') >= 0 ? t('Steps') : t('Not accessible')) + '</span>' : '<span class="chip">' + t('Accessibility not mapped') + '</span>';
  };
  function amenityChips(a) {
    return (a.parking != null ? '<span class="chip">' + t('Parking {0} m', a.parking) + '</span>' : '') + (a.toilets != null ? '<span class="chip">' + t('Restrooms {0} m', a.toilets) + '</span>' : '') +
      (a.transit != null ? '<span class="chip">' + t('Bus stop {0} m', a.transit) + '</span>' : '') + (a.reserve ? '<span class="chip amber">' + t('In or next to {0}', esc(a.reserve)) + '</span>' : '');
  }
  function apPopup(a) {
    const d = document.createElement('div');
    d.innerHTML = '<b>' + a.n + '. ' + esc(apName(a)) + '</b><br>' + adaChip(a) + '<br>' + amenityChips(a) + '<br><button class="btn primary" data-d>' + t('Directions') + '</button>';
    d.querySelector('[data-d]').onclick = () => directions(a);
    return d;
  }
  function reservePopup(r) {
    const d = document.createElement('div');
    const acc = { OA: t('Open to the public'), RA: t('Restricted access'), XA: t('Closed to the public'), UK: '' }[r.access || 'UK'];
    d.innerHTML = '<b>' + esc(r.name || t('Protected area')) + '</b><br>' + (r.designation ? '<span class="chip green">' + esc(r.designation) + '</span>' : '') + (acc ? '<span class="chip">' + esc(acc) + '</span>' : '') +
      (r.agency ? '<br>' + t('Managed by {0}', esc(r.agency)) : '') + '<br><span class="fine">' + (r.official ? t('Source: {0}', esc(r.source)) : t('Source: OpenStreetMap')) + '</span>';
    return d;
  }
  function closurePopup(c, on) {
    const d = document.createElement('div');
    d.innerHTML = '<b>' + esc(cName(c)) + '</b><br><span class="chip ' + (on ? 'red' : '') + '">' + (on ? t('Closed on this date') : t('Not in effect on this date')) + '</span><span class="chip">' + esc(Closures.windowLabel(c)) + '</span>' +
      (c.species ? '<br>' + t('Protects: {0}', esc(c.species)) : '') + (c.note ? '<br>' + esc(c.note) : '') + '<br><span class="fine">' + t('Source: {0}', esc(c.source || '')) + '. ' + t('Closures apply only where posted; follow signs on site.') + '</span>';
    return d;
  }
  function reportPopup(r) {
    const ty = Reports.TYPES[r.type] || Reports.TYPES.other, d = document.createElement('div');
    d.innerHTML = '<b>' + ty.icon + ' ' + esc(t(ty.label)) + '</b>' + (r.note ? '<br>' + esc(r.note) : '') + '<br><span class="fine">' + (r.local ? t('Your report (this device only)') : t('Community report (reviewed)')) + (r.created ? ' · ' + esc(r.created) : '') + (r.until ? ' · ' + t('until {0}', esc(r.until)) : '') + '</span>' +
      (r.local ? '<br><button class="btn" data-rm>' + t('Remove my report') + '</button>' : '');
    const rm = d.querySelector('[data-rm]');
    if (rm) rm.onclick = () => { Reports.remove(r.id); S.reports = Reports.loadLocal(); map.closePopup(); const h = !!S.rank; rebuild(); refreshRoute(h); toast(t('Report removed.')); };
    return d;
  }

  function seasonNote() {
    const on = Router.inNesting(S.date), w = NESTING.start.replace('-', '/') + ' – ' + NESTING.end.replace('-', '/');
    return on ? '<div class="note warn"><b>' + t('Sea turtle nesting season') + '</b> ' + t('(default {0}; confirm with your county).', w) + ' ' + t('Keep lights off at night, skip flash photography, fill holes, flatten sandcastles and take beach gear home. Low-impact mode avoids walking on the beach itself.') + '</div>'
      : '<div class="note info">' + t('Outside the default sea turtle nesting season ({0}). Confirm local dates before you go.', w) + '</div>';
  }
  function tideNote() {
    if (!S.tide) return '';
    const tt = S.tide;
    return '<div class="note info"><b>' + t('Tides today') + '</b> ' + t('at {0}', esc(tt.station.name)) + ': ' + tt.hl.map((x) => t(x.type) + ' ' + Tides.fmtTime(x.time) + ' (' + x.ft.toFixed(1) + ' ft)').join(' &middot; ') + '. ' + t('Wet sand gets narrow near high tide.') + '</div>';
  }
  function closuresNote() {
    const list = (S.data.parsed.closures || []).filter((c) => Closures.isActive(c, S.date));
    if (!list.length) return '';
    return '<div class="note bad"><b>' + t('Closed on this date') + ':</b> ' + list.slice(0, 4).map((c) => esc(cName(c))).join(', ') + (list.length > 4 ? '…' : '') + '. ' + t('Routes avoid these areas. Closures apply only where posted; follow signs on site.') + '</div>';
  }
  function officialStatus() {
    if (DEMO) return '<p class="fine">' + t('Demo: sample protected area and closure shown.') + '</p>';
    const o = S.official;
    if (o.status === 'loading') return '<p class="fine"><span class="spin"></span>' + t('Loading official protected-area and closure data…') + '</p>';
    if (o.status === 'partial') return '<p class="fine">' + t('Some official data could not be loaded (it is slow at times). Try Search this area again later.') + '</p>';
    return '<p class="fine">' + t('Official data: USGS PAD-US protected areas ({0} here) and FWC Critical Wildlife Areas ({1} here).', o.protected.length, o.critical.length) + '</p>';
  }

  function render() {
    const el = $('sheet'); let h = '';
    if (S.loading) { el.innerHTML = '<h2><span class="spin"></span>' + t('Loading real map data…') + '</h2><p class="sub">' + t('Fetching trails, protected areas and beaches from OpenStreetMap for this view.') + '</p>'; return; }
    if (S.error) { el.innerHTML = '<h2>' + t('Couldn\'t load map data') + '</h2><div class="note bad">' + esc(S.error) + '</div><div class="row"><button class="btn primary" id="retry">' + t('Try again') + '</button></div><p class="fine">' + t('Public OpenStreetMap servers can be busy. This app tries several in turn.') + '</p>'; $('retry').onclick = loadArea; return; }
    if (S.view === 'report' && S.report) { el.innerHTML = reportHTML(); bindReport(); return; }
    if (!S.data) { el.innerHTML = '<h2>' + t('Find your way to the beach') + '</h2><p class="sub">' + t('Search a place or tap the map, then load beach data for this view.') + '</p><div class="row"><button class="btn primary" id="load">' + t('Load this area') + '</button></div>'; $('load').onclick = loadArea; return; }

    if (S.view === 'walk' && W) { el.innerHTML = walkHTML(); bindWalk(); updateWalk(); return; }
    const aps = S.data.aps, nRes = S.data.parsed.reserves.length;
    if (S.view === 'route' && S.route) {
      const r = S.route, st = r.st, a = r.ap;
      h += '<button class="back" id="back">&larr; ' + t('All entrances') + '</button>';
      h += '<h2>' + a.n + '. ' + esc(apName(a)) + '</h2><p class="sub">' + t('From {0}', esc(S.start.label)) + ' &middot; ' + t(MODES[S.mode].label) + '</p>';
      h += '<div class="big"><b>' + fmtMin(st.minutes) + '</b><span>' + fmtDist(st.meters) + '</span></div>';
      const pct = (m) => (st.meters ? (m / st.meters) * 100 : 0);
      h += '<div class="bar" title="' + esc(t('paved, soft surface, steps')) + '"><i style="width:' + pct(st.paved) + '%;background:#80868b"></i><i style="width:' + pct(st.sand + st.soft) + '%;background:#e6c55c"></i><i style="width:' + pct(st.steps) + '%;background:#d93025"></i></div>';
      h += '<p class="sub">' + t('{0}% paved', Math.round(pct(st.paved))) + ' &middot; ' + t('{0}% sand or soft ground', Math.round(pct(st.sand + st.soft))) + (st.steps ? ' &middot; ' + t('{0} m of steps', Math.round(st.steps)) : '') + (pct(st.unknown) > 40 ? ' &middot; ' + t('surface not mapped for {0}%', Math.round(pct(st.unknown))) : '') + '</p>';
      h += adaChip(a) + amenityChips(a);
      const names = Object.entries(st.reserves);
      if (names.length) h += '<div class="note warn"><b>' + t('Passes through protected land:') + '</b> ' + names.map(([n, m]) => esc(n) + ' (' + fmtDist(m) + ')').join(', ') + '. ' + t('Stay on the marked path.') + (S.mode !== 'lowimpact' ? ' ' + t('Try Low-impact to avoid it where another route exists.') : '') + '</div>';
      else h += '<div class="note good">' + t('This route stays out of mapped protected areas.') + '</div>';
      if (r.snapM > 60) h += '<div class="note info">' + t('Your start is about {0} m from the nearest mapped path; the route begins there.', Math.round(r.snapM)) + '</div>';
      if (a.ada === 'no' && S.mode === 'wheelchair') h += '<div class="note bad">' + t('This entrance is not wheelchair accessible. Pick another one.') + '</div>';
      h += tideCheckHTML() + closuresNote() + seasonNote() + tideNote();
      h += '<div class="row"><button class="btn primary" id="walk">' + t('Start walk-through') + '</button></div>';
      h += '<h3>' + t('Street-level photos') + '</h3>' + photosHTML(false);
      h += '<div class="row"><button class="btn" id="cp">' + t('Copy summary') + '</button><button class="btn" id="gj" title="' + esc(t('For GIS software such as ArcGIS Pro or QGIS')) + '">' + t('Export for GIS') + '</button></div>';
    } else {
      h += '<h2>' + (aps.length === 1 ? t('1 beach entrance in view') : t('{0} beach entrances in view', aps.length)) + '</h2>';
      h += '<p class="sub">' + (S.gaps ? t('{0} mapped as wheelchair accessible or likely', S.gaps.accessible) : '') + (nRes ? ' &middot; ' + (nRes === 1 ? t('1 protected area') : t('{0} protected areas', nRes)) : '') + '</p>';
      if (!aps.length) h += '<div class="note warn">' + t('No beach entrances found here. Try Daytona Beach, or pan to a stretch of mapped beach and press <b>Search this area</b>.') + (!S.data.parsed.beaches.length ? ' ' + t('(No beach polygon is mapped in this view.)') : '') + '</div>';
      h += '<div class="row"><button class="btn primary" id="best">' + (S.start ? t('Best beach access from {0}', esc(S.start.label)) : t('Find best beach access')) + '</button></div>';
      if (!S.start) h += '<p class="sub">' + t('Set a start first: tap the map &rarr; <i>Start here</i>, search a place, or use <i>My location</i>.') + '</p>';
      if (S.rank && S.rank.ok.length) {
        h += '<h3>' + t('Ranked from your start') + '</h3>' + S.rank.ok.map((r) => apRow(r.ap, r)).join('');
        if (S.rank.none.length) h += '<p class="sub">' + t('Not reachable in {0} mode:', t(MODES[S.mode].label).toLowerCase()) + ' ' + S.rank.none.map((a) => a.n + ' ' + esc(apName(a))).join(', ') + '</p>';
      } else if (aps.length) h += '<h3>' + t('Entrances (north to south)') + '</h3>' + aps.map((a) => apRow(a, null)).join('');
      if (S.gaps && S.gaps.gaps.length) {
        h += '<h3>' + t('Accessibility gaps') + '</h3><p class="sub">' + t('Orange dotted lines on the map show shoreline stretches with no mapped accessible entrance.') + '</p>' +
          S.gaps.gaps.slice(0, 3).map((g) => '<div class="note warn">' + t('{0} between #{1} {2} and #{3} {4}', fmtDist(g.meters), g.from.n, esc(apName(g.from)), g.to.n, esc(apName(g.to))) + '</div>').join('');
      } else if (S.gaps && S.gaps.accessible < 2 && aps.length) h += '<div class="note warn">' + t('Fewer than two accessible entrances are mapped here, so gaps can\'t be measured. Mapping may be incomplete.') + '</div>';
      h += closuresNote() + seasonNote() + tideNote() + officialStatus();
      h += '<div class="legend">' + t('Pins:') + '<i style="background:#1a73e8"></i>' + t('accessible') + '<i style="background:#188038"></i>' + t('likely') + '<i style="background:#a1887f"></i>' + t('unmapped') + '<i style="background:#80868b"></i>' + t('steps/soft') + '<i style="background:#d93025"></i>' + t('closed') + ' &middot; ' + t('green = protected area, red = closure') + '</div>';
    }
    h += '<div class="row"><button class="btn" id="repHere">' + t('Report an issue') + '</button></div>';
    h += '<p class="fine">' + t('Entrances are inferred from OpenStreetMap trails that reach mapped beach, so some may be missing or mislabeled. Always follow posted signs.') + ' ' + t('Data &copy; OpenStreetMap contributors') + (S.data.source && !DEMO ? ' ' + t('via {0}', esc(new URL(S.data.source).host)) : '') + '; ' + t('imagery: USGS National Map; tides and water levels NOAA; elevation USGS 3DEP; protected areas USGS PAD-US; critical wildlife areas FWC.') + '</p>';
    el.innerHTML = h;

    const q = (id) => $(id);
    if (q('back')) q('back').onclick = () => { leaveRoute(); S.view = 'home'; S.route = null; gRoute.clearLayers(); render(); };
    if (q('best')) q('best').onclick = findBest;
    if (q('gj')) q('gj').onclick = downloadGeoJSON;
    if (q('walk')) q('walk').onclick = startWalk;
    if (q('cp')) q('cp').onclick = copySummary;
    if (q('phBtn')) q('phBtn').onclick = loadPhotos;
    if (q('repHere')) q('repHere').onclick = () => openReport(S.selected ? { lat: S.selected.lat, lng: S.selected.lon } : map.getCenter());
    el.querySelectorAll('[data-ph]').forEach((n) => { n.onclick = () => showPhoto(S.photos.along[Number(n.dataset.ph)]); });
    el.querySelectorAll('[data-ap]').forEach((n) => { n.onclick = () => { const a = aps.find((x) => x.id === n.dataset.ap); S.rank ? directions(a) : select(a, true); }; });
  }
  function apRow(a, r) {
    return '<div class="ap" data-ap="' + esc(a.id) + '"><span class="num ' + (closureOf(a) ? 'closed' : a.ada) + '">' + a.n + '</span><div class="t"><b>' + esc(apName(a)) + '</b>' + adaChip(a) + amenityChips(a) + '</div>' +
      (r ? '<div class="eta"><b>' + fmtMin(r.st.minutes) + '</b>' + fmtDist(r.st.meters) + '</div>' : '') + '</div>';
  }

  function summaryText() {
    const r = S.route, st = r.st;
    return 'Beach Access Pathfinder\n' + t('To: {0}', apName(r.ap)) + '\n' + t('From: {0}', S.start.label) + '\n' + t('Date: {0}', dstr(S.date)) + ' | ' + t('Mode: {0}', t(MODES[S.mode].label)) +
      '\n' + t('Distance: {0}', fmtDist(st.meters)) + ' | ' + t('Time: {0}', fmtMin(st.minutes)) + '\n' + t('Protected land crossed: {0}', Object.keys(st.reserves).join(', ') || t('none')) + '\n' + t('Map data: OpenStreetMap contributors');
  }
  function copySummary() {
    const tx = summaryText();
    if (navigator.clipboard) navigator.clipboard.writeText(tx).then(() => toast(t('Copied')), () => window.prompt(t('Copy:'), tx)); else window.prompt(t('Copy:'), tx);
  }
  function downloadGeoJSON() {
    const r = S.route, st = r.st;
    const coords = [[S.start.lon, S.start.lat]].concat(st.latlngs.map((p) => [p[1], p[0]]), [[r.ap.lon, r.ap.lat]]);
    const gj = { type: 'Feature', properties: { to: r.ap.name, mode: S.mode, date: dstr(S.date), meters: Math.round(st.meters), minutes: Math.round(st.minutes), source: 'OpenStreetMap contributors' }, geometry: { type: 'LineString', coordinates: coords } };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(gj, null, 2)], { type: 'application/geo+json' })); a.download = 'beach-route.geojson'; a.click(); URL.revokeObjectURL(a.href);
  }

  // ---------- community reports ----------
  function openReport(ll) {
    leaveRoute(); map.closePopup();
    S.report = { lat: ll.lat, lon: ll.lng, type: 'blocked', note: '', until: '' }; S.view = 'report'; render();
  }
  function reportHTML() {
    const R = S.report;
    return '<button class="back" id="rpBack">&larr; ' + t('Cancel') + '</button><h2>' + t('Report an issue') + '</h2><p class="sub">' + t('Location: {0}, {1}', R.lat.toFixed(5), R.lon.toFixed(5)) + '</p>' +
      '<label class="fld">' + t('What did you find?') + '<select id="rpType">' + Object.keys(Reports.TYPES).map((k) => '<option value="' + k + '"' + (R.type === k ? ' selected' : '') + '>' + Reports.TYPES[k].icon + ' ' + esc(t(Reports.TYPES[k].label)) + '</option>').join('') + '</select></label>' +
      '<label class="fld">' + t('Details (optional)') + '<textarea id="rpNote" rows="3" maxlength="500" placeholder="' + esc(t('For example: boardwalk rail broken at the dune crossover')) + '">' + esc(R.note) + '</textarea></label>' +
      '<label class="fld">' + t('Still true until (optional)') + '<input type="date" id="rpUntil" value="' + esc(R.until) + '"></label>' +
      '<div class="note info" id="rpHint"></div>' +
      '<div class="row"><button class="btn primary" id="rpSave">' + t('Save on this device') + '</button>' + (CFG.reportsRepo ? '<button class="btn" id="rpShare">' + t('Share with maintainers') + '</button>' : '') + '</div>' +
      '<p class="fine">' + t('Reports are stored only on this device. Blocking reports reroute you for 30 days (or until the date you set). Sharing opens a GitHub issue that maintainers review before it appears for everyone.') + '</p>';
  }
  function bindReport() {
    const R = S.report, sync = () => { R.type = $('rpType').value; R.note = $('rpNote').value; R.until = $('rpUntil').value; $('rpHint').textContent = Reports.TYPES[R.type].blocks ? t('This will be treated as closed within about 25 m, and routes will avoid it.') : t('This is shown on the map as a note and does not change routes.'); };
    ['rpType', 'rpNote', 'rpUntil'].forEach((id) => { $(id).oninput = sync; $(id).onchange = sync; }); sync();
    $('rpBack').onclick = () => { S.report = null; S.view = 'home'; render(); };
    $('rpSave').onclick = () => {
      sync(); Reports.add({ type: R.type, lat: R.lat, lon: R.lon, note: R.note, until: R.until || null });
      S.reports = Reports.loadLocal(); S.report = null; S.view = 'home'; const h = !!S.rank; if (S.data) { rebuild(); refreshRoute(h); } else render(); toast(t('Report saved on this device.'));
    };
    if ($('rpShare')) $('rpShare').onclick = () => { sync(); window.open(Reports.issueUrl(CFG.reportsRepo, Reports.make({ type: R.type, lat: R.lat, lon: R.lon, note: R.note, until: R.until || null })), '_blank', 'noopener'); };
  }

  // ---------- guided walk-through (simulated or live GPS) ----------
  const gWalk = L.layerGroup().addTo(map);
  let W = null;
  const toRad = Math.PI / 180;
  const bearing = (a, b) => {
    const y = Math.sin((b[1] - a[1]) * toRad) * Math.cos(b[0] * toRad);
    const x = Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad) - Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos((b[1] - a[1]) * toRad);
    return (Math.atan2(y, x) / toRad + 360) % 360;
  };
  const walkerIcon = (deg) => L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17],
    html: '<div class="walker" style="transform:rotate(' + deg + 'deg)"><svg viewBox="0 0 24 24" width="34" height="34"><circle cx="12" cy="12" r="10.5" fill="#1a73e8" stroke="#fff" stroke-width="2"/><path d="M12 4.5 L17.5 16 L12 13 L6.5 16 Z" fill="#fff"/></svg></div>' });

  function buildWalk(r) {
    const st = r.st, lead = st.leadPts || [];
    const pts = [[S.start.lat, S.start.lon]].concat(lead, st.latlngs, [[r.ap.lat, r.ap.lon]]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Geo.hav(pts[i - 1], pts[i]));
    const groups = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = cum[i + 1] - cum[i];
      const a = i < 1 + lead.length ? { kind: 'lead' } : (i - 1 - lead.length) < st.segs.length ? st.segs[i - 1 - lead.length] : { kind: 'final' };
      const key = a.kind || [a.name || '', a.surface, a.reserve || '', a.hw].join('|');
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.end += len; else groups.push({ key, a, start: cum[i], end: cum[i + 1] });
    }
    const total = cum[cum.length - 1];
    const real = groups.filter((g, i) => !(g.key === 'final' && g.end - g.start < 1) || i === groups.length - 1);
    real.push({ key: 'arrive', a: { kind: 'arrive' }, start: total, end: total });
    return { pts, cum, total, groups: real, dist: 0, playing: true, speed: 4, gps: false, watch: null, timer: null, marker: null, off: 0, photoId: null };
  }
  function instr(gr) {
    const a = gr.a, m = Math.round(gr.end - gr.start);
    if (a.kind === 'arrive') return { icon: '&#9873;', text: t('Arrive at {0}', apName(S.route.ap)), sub: S.route.ap.ada === 'no' ? t('Not mapped as wheelchair accessible') : t('You are at the beach entrance') };
    if (a.kind === 'lead') return { icon: '&#10132;', text: t('Head to the nearest mapped path'), sub: m + ' m' };
    if (a.kind === 'final') return { icon: '&#10132;', text: t('Continue to the beach entrance'), sub: m + ' m' };
    if (a.hw === 'steps') return { icon: '&#9888;', text: a.name ? t('Take the steps ({0})', a.name) : t('Take the steps'), sub: m + ' m' };
    if (a.reserve) return { icon: '&#127807;', text: t('Entering {0}: stay on the marked path', a.reserve), sub: m + ' m' };
    if (a.surface === 'sand') return { icon: '&#127958;', text: a.name ? t('Continue on sand ({0})', a.name) : t('Continue on sand'), sub: m + ' m' };
    return { icon: '&#10132;', text: t('Continue on {0}', a.name || t('the path')), sub: m + ' m' };
  }
  function posAt(d) {
    const { pts, cum } = W; let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1], f = seg ? Math.max(0, Math.min(1, (d - cum[i - 1]) / seg)) : 0, a = pts[i - 1], b = pts[i];
    return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], hdg: bearing(a, b) };
  }
  function startWalk() {
    if (!S.route || !S.route.st) return;
    const keepTc = S.tc, keepPh = S.photos;
    stopWalk(); map.closePopup(); W = buildWalk(S.route); gWalk.clearLayers(); S.tc = keepTc; S.photos = keepPh;
    W.marker = L.marker(W.pts[0], { icon: walkerIcon(0), interactive: false, zIndexOffset: 1000 }).addTo(gWalk);
    W.timer = setInterval(tick, 100);
    S.view = 'walk'; map.setView(W.pts[0], Math.max(map.getZoom(), 18), { animate: false }); render();
    if (SET.token && !S.photos) loadPhotos();
  }
  function stopWalk() {
    if (!W) return;
    clearInterval(W.timer); if (W.watch != null) navigator.geolocation.clearWatch(W.watch);
    gWalk.clearLayers(); W = null;
  }
  function endWalk() { stopWalk(); S.view = 'route'; render(); if (S.route) drawRoute(S.route); }
  function tick() {
    if (!W) return;
    if (W.playing && !W.gps) { W.dist = Math.min(W.total, W.dist + MODES[S.mode].speed * W.speed * 0.1); if (W.dist >= W.total) W.playing = false; }
    updateWalk();
  }
  function updateWalk() {
    if (!W || S.view !== 'walk') return;
    const p = posAt(W.dist), at = W.gps && W.gpsPos ? W.gpsPos : p.pos;
    W.marker.setLatLng(at); W.marker.setIcon(walkerIcon(W.gps && W.gpsHdg != null ? W.gpsHdg : p.hdg));
    map.setView(at, map.getZoom(), { animate: false });
    let gi = W.groups.findIndex((g) => W.dist < g.end); if (gi < 0) gi = W.groups.length - 1;
    const gr = W.groups[gi], ins = instr(gr), toNext = Math.max(0, Math.round(gr.end - W.dist));
    const set = (id, v, html) => { const e = $(id); if (e) { if (html) e.innerHTML = v; else e.textContent = v; } };
    set('wIcon', ins.icon, true); set('wText', ins.text);
    set('wSub', gr.a.kind === 'arrive' ? ins.sub : t('{0} m, then {1}', toNext, W.groups[gi + 1] ? instr(W.groups[gi + 1]).text.toLowerCase() : t('arrive')));
    const bar = $('wBar'); if (bar) bar.style.width = (W.total ? (W.dist / W.total) * 100 : 100) + '%';
    const rem = Math.max(0, W.total - W.dist);
    set('wRem', t('{0} left · about {1} at walking pace', fmtDist(rem), fmtMin(rem / MODES[S.mode].speed / 60)));
    const nx = $('wNext'); if (nx) nx.innerHTML = W.groups.slice(gi + 1, gi + 4).map((g) => { const i2 = instr(g); return '<div class="ap" style="cursor:default"><span class="wicon sm">' + i2.icon + '</span><div class="t"><b>' + esc(i2.text) + '</b><span class="sub">' + esc(i2.sub || '') + '</span></div></div>'; }).join('');
    const off = W.gps && W.off > 40;
    set('wWarn', off ? t('You are about {0} m off the route. Head back toward the blue line.', Math.round(W.off)) : '');
    const wb = $('wWarn'); if (wb) wb.className = off ? 'note warn' : '';
    const pl = $('wPlay'); if (pl) { pl.textContent = W.gps ? t('GPS active') : W.dist >= W.total ? t('Replay') : W.playing ? t('Pause') : t('Play'); pl.disabled = W.gps; }
    const gb = $('wGps'); if (gb) gb.textContent = W.gps ? t('Stop GPS') : t('Use my GPS');
    document.querySelectorAll('#wSpeed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === W.speed));
    updateWalkPhoto(at);
  }
  function updateWalkPhoto(at) {
    const box = $('wPhoto'); if (!box) return;
    const P = S.photos;
    if (!P || P.status !== 'done' || !P.all.length) {
      const sig = P ? P.status : 'none'; if (W.photoSig === sig) return; W.photoSig = sig;
      box.innerHTML = P && P.status === 'loading' ? '<p class="sub"><span class="spin"></span>' + t('Looking for photos along the route…') + '</p>' : P ? photosHTML(true) : '<div class="row"><button class="btn" id="phBtn2">' + t('Show street-level photos') + '</button></div>';
      if ($('phBtn2')) $('phBtn2').onclick = loadPhotos; if ($('phBtn')) $('phBtn').onclick = loadPhotos;
      return;
    }
    const near = Photos.nearest(P.all, at, 40), id = near ? near.id : 'none';
    if (W.photoSig === id) return; W.photoSig = id;
    box.innerHTML = near ? '<a href="' + esc(near.page || near.url) + '" target="_blank" rel="noopener"><img class="bigph" alt="" src="' + esc(near.url) + '"></a><p class="fine">' + t('Photo {0} m from you', near.dist) + ' · ' + esc(near.credit) + (near.when ? ' · ' + esc(near.when) : '') + '</p>' : '<p class="fine">' + t('No photo within 40 m of here.') + '</p>';
  }
  function walkHTML() {
    return '<button class="back" id="wexit">&larr; ' + t('End walk') + '</button><div class="walkbanner"><span id="wIcon" class="wicon"></span><div><b id="wText"></b><div id="wSub" class="sub"></div></div></div>' +
      '<div class="bar"><i id="wBar" style="width:0%;background:#1a73e8"></i></div><p class="sub" id="wRem"></p><div id="wWarn"></div>' +
      '<div class="row"><button class="btn" id="wPlay">' + t('Pause') + '</button><span class="seg spd" id="wSpeed"><button data-s="1">1&times;</button><button data-s="4">4&times;</button><button data-s="10">10&times;</button></span></div>' +
      '<div class="row"><button class="btn primary" id="wGps">' + t('Use my GPS') + '</button></div><p class="fine">' + t('Simulated walk for previews. &ldquo;Use my GPS&rdquo; follows you while you actually walk (needs https or localhost and location permission).') + '</p>' +
      '<h3>' + t('Street view') + '</h3><div id="wPhoto"></div><h3>' + t('Coming up') + '</h3><div id="wNext"></div>';
  }
  function bindWalk() {
    $('wexit').onclick = endWalk;
    $('wPlay').onclick = () => { if (!W) return; if (W.dist >= W.total) { W.dist = 0; W.playing = true; } else W.playing = !W.playing; updateWalk(); };
    $('wSpeed').onclick = (e) => { const b = e.target.closest('button[data-s]'); if (b && W) { W.speed = Number(b.dataset.s); updateWalk(); } };
    $('wGps').onclick = toggleGps;
  }
  function toggleGps() {
    if (!W) return;
    if (W.gps) { navigator.geolocation.clearWatch(W.watch); W.watch = null; W.gps = false; W.gpsPos = null; W.off = 0; updateWalk(); return; }
    if (!navigator.geolocation) { toast(t('GPS is not available in this browser.')); return; }
    W.watch = navigator.geolocation.watchPosition((p) => {
      if (!W) return;
      const q = [p.coords.latitude, p.coords.longitude]; let best = Infinity, along = 0;
      for (let i = 1; i < W.pts.length; i++) {
        const d = Geo.distPtSeg(q, W.pts[i - 1], W.pts[i]);
        if (d < best) {
          best = d; const kx = Math.cos(q[0] * toRad), a = W.pts[i - 1], b = W.pts[i];
          const dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], l2 = dx * dx + dy * dy;
          const f = l2 ? Math.max(0, Math.min(1, (((q[1] - a[1]) * kx) * dx + (q[0] - a[0]) * dy) / l2)) : 0;
          along = W.cum[i - 1] + f * (W.cum[i] - W.cum[i - 1]);
        }
      }
      W.gpsPos = q; W.gpsHdg = p.coords.heading != null && !isNaN(p.coords.heading) ? p.coords.heading : null; W.dist = along; W.off = best; updateWalk();
    }, () => { toast(t('Couldn\'t get GPS. Allow location access and use https or localhost.')); if (W) { W.gps = false; updateWalk(); } }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
    W.gps = true; W.playing = false; updateWalk();
  }

  // ---------- settings, language, install ----------
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
  function openSettings() {
    let m = $('settings'); if (!m) { m = document.createElement('div'); m.id = 'settings'; m.className = 'modal'; document.body.appendChild(m); }
    const lang = I18n.lang(), cb = (id, on, label) => '<label class="chk"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + label + '</label>';
    m.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-label="' + esc(t('Settings')) + '"><h2>' + t('Settings') + '</h2>' +
      '<label class="fld">' + t('Language') + '<select id="stLang"><option value="en"' + (lang === 'en' ? ' selected' : '') + '>English</option><option value="es"' + (lang === 'es' ? ' selected' : '') + '>Español</option></select></label>' +
      '<h3>' + t('Map layers') + '</h3>' + cb('stOff', SET.official, t('Official protected areas (USGS PAD-US)')) + cb('stClo', SET.closures, t('Closures (wildlife areas, reports)')) + cb('stRep', SET.reports, t('Community reports')) +
      '<h3>' + t('Street-level photos') + '</h3><label class="fld">' + t('Mapillary access token (optional)') + '<input id="stTok" type="password" autocomplete="off" value="' + esc(SET.token) + '" placeholder="MLY|..."></label>' +
      '<p class="fine">' + t('A free client token from mapillary.com/developer gives real street-level coverage. It is stored only in this browser. Without it, nearby Wikimedia Commons photos are used.') + '</p>' +
      '<h3>' + t('Install on your phone') + '</h3><div id="stInst"></div>' +
      '<div class="row"><button class="btn primary" id="stClose">' + t('Done') + '</button></div></div>';
    const inst = $('stInst');
    if (standalone()) inst.innerHTML = '<p class="sub">' + t('Installed. You are using the app version.') + '</p>';
    else if (deferredInstall) { inst.innerHTML = '<div class="row"><button class="btn" id="stInstall">' + t('Install app') + '</button></div>'; $('stInstall').onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; openSettings(); }; }
    else inst.innerHTML = '<p class="sub">' + t('Open this page over https, then: iPhone Safari: Share, then Add to Home Screen. Android Chrome: menu, then Install app.') + '</p>';
    const close = () => { m.remove(); };
    $('stClose').onclick = close; m.onclick = (e) => { if (e.target === m) close(); };
    $('stLang').onchange = (e) => { I18n.setLang(e.target.value); applyLang(); openSettings(); };
    const upd = () => {
      SET.official = $('stOff').checked; SET.closures = $('stClo').checked; SET.reports = $('stRep').checked; SET.token = $('stTok').value.trim(); saveSet();
      if (S.data) { const h = !!S.rank; rebuild(); refreshRoute(h); }
    };
    ['stOff', 'stClo', 'stRep'].forEach((id) => { $(id).onchange = upd; }); $('stTok').onchange = () => { upd(); S.photos = null; };
  }
  function applyLang() {
    I18n.applyStatic(document); setLayerBtn(); $('langBtn').textContent = I18n.lang() === 'es' ? 'English' : 'Español';
    if (DEMO) demoTag();
    if (S.data) drawData();
    if (W) W.photoSig = null;
    render();
  }
  $('langBtn').onclick = () => { I18n.setLang(I18n.lang() === 'es' ? 'en' : 'es'); applyLang(); };
  $('setBtn').onclick = openSettings;

  // ---------- interactions ----------
  map.on('click', (e) => {
    const d = document.createElement('div');
    d.innerHTML = '<button class="btn primary" data-s>' + t('Start here') + '</button><button class="btn" data-r>' + t('Report an issue here') + '</button>';
    d.querySelector('[data-s]').onclick = () => { map.closePopup(); setStart(e.latlng.lat, e.latlng.lng, t('Dropped pin')); };
    d.querySelector('[data-r]').onclick = () => { map.closePopup(); openReport(e.latlng); };
    L.popup().setLatLng(e.latlng).setContent(d).openOn(map);
  });
  map.on('moveend', () => {
    if (!loadedBox || S.loading) return;
    const c = map.getCenter();
    const out = c.lat < loadedBox[0] || c.lat > loadedBox[2] || c.lng < loadedBox[1] || c.lng > loadedBox[3];
    $('areaBtn').hidden = !out;
  });
  $('areaBtn').onclick = loadArea;

  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    S.mode = b.dataset.mode; cache.k = null; const hadRank = !!S.rank; S.rank = null;
    document.querySelectorAll('#modeSeg button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
    refreshRoute(hadRank);
  });
  $('date').value = dstr(S.date);
  $('date').addEventListener('change', (e) => {
    const [y, m, d] = e.target.value.split('-').map(Number); if (!y) return;
    S.date = new Date(y, m - 1, d); cache.k = null; const hadRank = !!S.rank; S.rank = null;
    if (S.data) { loadTides(); drawClosures(); refreshRoute(hadRank); } else render();
  });
  $('locBtn').onclick = () => {
    if (!navigator.geolocation) { toast(t('Location is not available in this browser.')); return; }
    navigator.geolocation.getCurrentPosition((p) => { map.flyTo([p.coords.latitude, p.coords.longitude], 16); setStart(p.coords.latitude, p.coords.longitude, t('My location')); setTimeout(loadArea, 800); },
      () => toast(t('Couldn\'t get your location. Allow location access, or tap the map to set a start.')), { enableHighAccuracy: true, timeout: 10000 });
  };

  // search (Nominatim) and quick places
  const sug = $('suggest'); let sTimer;
  function showSuggest(items, quick) {
    sug.innerHTML = (quick ? '<li class="hdr">' + t('Nearby beaches') + '</li>' : '') + items.map((it, i) => '<li tabindex="0" data-i="' + i + '">' + esc(it.title) + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</li>').join('');
    sug.hidden = !items.length;
    sug.querySelectorAll('li[data-i]').forEach((li) => { const go = () => { const it = items[li.dataset.i]; sug.hidden = true; $('q').value = it.title; goTo(it); }; li.onclick = go; li.onkeydown = (e) => { if (e.key === 'Enter') go(); }; });
  }
  function goTo(it) {
    map.setView([it.lat, it.lon], it.zoom || 16); setStart(it.lat, it.lon, it.title.split(',')[0]);
    map.once('moveend', () => setTimeout(loadArea, 150));
  }
  const quick = () => PLACES.map((p) => ({ title: p[0], sub: t('Volusia/Flagler coast, Florida'), lat: p[1], lon: p[2], zoom: p[3] }));
  $('q').addEventListener('focus', () => { if (!$('q').value) showSuggest(quick(), true); });
  $('q').addEventListener('input', () => {
    clearTimeout(sTimer); const v = $('q').value.trim();
    if (!v) { showSuggest(quick(), true); return; }
    if (v.length < 3) return;
    sTimer = setTimeout(async () => {
      if (DEMO) { toast(t('Search is off in demo mode. Try the quick places.')); return; }
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us&q=' + encodeURIComponent(v));
        const j = await r.json();
        showSuggest(j.map((x) => ({ title: x.display_name, lat: Number(x.lat), lon: Number(x.lon), zoom: 16 })));
      } catch (e) { toast(t('Search is unavailable right now.')); }
    }, 350);
  });
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); const first = sug.querySelector('li[data-i]'); if (first) first.click(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search') && !e.target.closest('.suggest')) sug.hidden = true; });

  // ---------- startup ----------
  async function loadStatic() {
    if (DEMO) return;
    try {
      const r = await fetch('data/closures.json', { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        S.curated = (j.closures || []).map((c) => ({
          id: 'cur/' + (c.id || c.name), name: c.name, kind: 'curated', hard: true, source: c.source || 'Local notice', note: c.note || null, species: c.species || null,
          poly: c.polygon ? Geo.makePoly([c.polygon.concat([c.polygon[0]])], [], { name: c.name }) : Closures.circlePoly(c.lat, c.lon, c.radius_m || 50, { name: c.name }),
          win: c.dates ? Closures.parseWindow(c.dates) : null, rawDates: c.dates || null, range: c.from || c.to ? { from: c.from || null, to: c.to || null } : null,
        }));
      }
    } catch (e) { /* optional file */ }
    S.approved = await Reports.loadApproved();
  }

  I18n.init(CFG.defaultLang);
  I18n.applyStatic(document); $('langBtn').textContent = I18n.lang() === 'es' ? 'English' : 'Español'; setLayerBtn(); if (DEMO) demoTag();
  if (DEMO) { const d = window.DEMO_START; map.setView([window.DEMO_VIEW.lat, window.DEMO_VIEW.lon], window.DEMO_VIEW.zoom); setStart(d.lat, d.lon, d.label); }
  render();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !DEMO && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  loadStatic().then(() => { map.whenReady(() => setTimeout(loadArea, 200)); });
})();
