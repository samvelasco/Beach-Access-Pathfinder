// NOAA CO-OPS tide predictions (public API). Finds the nearest prediction station and today's highs/lows.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo.js'));
  else root.Tides = factory(root.Geo);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo) {
  'use strict';
  const MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';
  const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
  let stationCache = null;

  async function nearestStation(lat, lon, f) {
    f = f || fetch;
    if (!stationCache) { const r = await f(MD); if (!r.ok) throw new Error('HTTP ' + r.status); stationCache = (await r.json()).stations || []; }
    let best = null, bd = Infinity;
    for (const s of stationCache) {
      const d = Geo.hav([lat, lon], [Number(s.lat), Number(s.lng)]);
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { id: best.id, name: best.name, km: bd / 1000 } : null;
  }

  const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

  async function highLow(station, date, f) {
    f = f || fetch;
    const url = API + '?product=predictions&application=beach-access-pathfinder&format=json&datum=MLLW&units=english&time_zone=lst_ldt&interval=hilo' +
      '&station=' + encodeURIComponent(station) + '&begin_date=' + ymd(date) + '&end_date=' + ymd(date);
    const r = await f(url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.predictions) throw new Error((j.error && j.error.message) || 'no predictions');
    return j.predictions.map((p) => ({ time: p.t.slice(11), ft: Number(p.v), type: p.type === 'H' ? 'High' : 'Low' }));
  }

  function fmtTime(hhmm) {
    let [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }

  return { nearestStation, highLow, fmtTime };
});
