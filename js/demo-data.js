// SAMPLE overlay for demo mode (?demo=1): invented entrances, preserve and streets, positioned by eye
// on the real Daytona Beach Shores shoreline so they sit on the satellite imagery. Positions are approximate. Not real data.
(function () {
  // Pixel reading from a z16 imagery tile grid -> lon/lat (49 px per 0.001 deg lon, 78.5 px per 0.0014 deg lat)
  const lonOf = (x) => -80.9962 + ((x - 293) / 49) * 0.001;
  const latOf = (y) => 29.2108 - ((y - 476) / 78.5) * 0.0014;
  const wl = (y) => 120 + (y - 240) * 0.33; // waterline x at screen row y
  const P = (x, y) => ({ lat: latOf(y), lon: lonOf(x) });
  const ys = [240, 319, 398, 476, 554, 633];
  const names = [
    ['North Boardwalk', { surface: 'wood', wheelchair: 'yes' }, 'footway'],
    ['Palm Walkover', { surface: 'sand' }, 'footway'],
    ['Preserve Stairs', {}, 'steps'],
    ['Dune Trail Access', { surface: 'sand' }, 'path'],
    ['Central Beach Ramp', { surface: 'concrete', wheelchair: 'yes' }, 'footway'],
    ['South Walkover', { surface: 'sand' }, 'footway'],
  ];
  const crossYs = ys.concat([279, 358, 437, 515, 594, 190, 680]).sort((a, b) => a - b);
  const roadX = (y) => wl(y) - 100, westX = (y) => wl(y) - 175;
  const els = []; let id = 100;
  // beach strip (sand), preserve around entrance 3
  const bTop = 150, bBot = 700;
  els.push({ type: 'way', id: 1, tags: { natural: 'beach' }, geometry: [P(wl(bTop) - 85, bTop), P(wl(bBot) - 85, bBot), P(wl(bBot) + 4, bBot), P(wl(bTop) + 4, bTop), P(wl(bTop) - 85, bTop)] });
  els.push({ type: 'way', id: 2, tags: { leisure: 'nature_reserve', name: 'Dune Preserve (sample)' }, geometry: [P(wl(368) - 128, 368), P(wl(428) - 128, 428), P(wl(428) - 58, 428), P(wl(368) - 58, 368), P(wl(368) - 128, 368)] });
  els.push({ type: 'way', id: 3, tags: { highway: 'residential', name: 'Ocean Avenue' }, geometry: crossYs.map((y) => P(roadX(y), y)) });
  els.push({ type: 'way', id: 4, tags: { highway: 'residential', name: 'West Avenue' }, geometry: crossYs.map((y) => P(westX(y), y)) });
  crossYs.forEach((y, i) => els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: 'Sample St ' + (i + 1) }, geometry: [P(westX(y), y), P(roadX(y), y)] }));
  ys.forEach((y, i) => {
    const [name, extra, hw] = names[i], r = roadX(y), mid = wl(y) - 92, end = wl(y) - 68;
    if (hw === 'steps') {
      els.push({ type: 'way', id: id++, tags: { highway: 'footway', name: name + ' path', surface: 'paved' }, geometry: [P(r, y), P(mid, y)] });
      els.push({ type: 'way', id: id++, tags: { highway: 'steps', name }, geometry: [P(mid, y), P((mid + end) / 2, y), P(end, y)] });
    } else els.push({ type: 'way', id: id++, tags: Object.assign({ highway: hw, name }, extra), geometry: [P(r, y), P(mid, y), P(end, y)] });
  });
  const node = (x, y, tags) => Object.assign({ type: 'node', id: id++ }, P(x, y), { tags });
  els.push(node(roadX(240) - 25, 232, { amenity: 'parking' }));
  els.push(node(roadX(554) - 22, 548, { amenity: 'parking' }));
  els.push(node(roadX(554) - 12, 560, { amenity: 'toilets' }));
  els.push(node(roadX(554) - 30, 570, { highway: 'bus_stop' }));
  window.DEMO_ELEMENTS = els;
  // Sample "official" overlays so the demo can show protected-area and closure layers (invented, not real boundaries).
  const sq = (x0, y0, x1, y1) => [P(x0, y0), P(x0, y1), P(x1, y1), P(x1, y0), P(x0, y0)].map((q) => [q.lat, q.lon]);
  window.DEMO_OFFICIAL = {
    protected: () => [Geo.makePoly([sq(wl(160) - 165, 160, wl(215) - 60, 215)], [], { id: 'demo/sp', name: 'Sample State Park (official data sample)', official: true, source: 'Sample data', agency: 'State parks', designation: 'State park', access: 'OA' })],
    critical: () => [{ id: 'demo/cwa', name: 'Sample Shorebird Critical Wildlife Area', kind: 'cwa', hard: true, poly: Geo.makePoly([sq(wl(610) - 112, 610, wl(665) + 4, 665)], [], {}), win: Closures.parseWindow('March 1 - December 31'), rawDates: 'March 1 - December 31', species: 'nesting shorebirds (sample)', note: 'Sample closure to show how closed areas appear and reroute you.', source: 'Sample data' }],
  };
  window.DEMO_START = Object.assign(P(westX(437) + 6, 437), { label: 'Hotel (sample start)' });
  window.DEMO_VIEW = { lat: 29.2108, lon: -80.9990, zoom: 16 };
})();
