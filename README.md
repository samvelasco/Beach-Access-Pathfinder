# Beach Access Pathfinder

A Google-Maps-style app for finding the best way to a beach that respects conservation areas.
It loads **real data live** and routes on the real walking network:

- **Aerial or street basemap** (USGS National Map imagery, OpenStreetMap) with Leaflet.
- **Real beaches, protected areas and trails** from OpenStreetMap (Overpass API), for whatever area is on screen.
- **Beach entrances** inferred from mapped trails and boardwalks that reach mapped beach, with
  wheelchair accessibility (from OSM tags), parking, restrooms and bus stops nearby.
- **Conservation-aware routing.** Routes cost more through protected areas (6x in Low-impact mode), and the
  card lists which protected areas a route crosses and for how many metres. In sea turtle nesting season,
  Low-impact mode also avoids walking on the beach itself.
- **Modes:** Walk, Wheelchair/stroller (no steps, avoids sand and steep inclines), Low-impact.
- **Equity view:** orange dotted lines mark shoreline stretches with no mapped accessible entrance.
- **Tides** for the nearest NOAA station (live), plus the sea turtle season for your visit date.
- **Walk-through**: follow the route with turn-by-turn instructions, as a simulated walk (1x/4x/10x) or live GPS while actually walking (needs https or localhost).
- Copyable route summary and an "Export for GIS" button (GeoJSON of the route for ArcGIS Pro / QGIS users and planners).
- **Official protected areas** (USGS PAD-US) merged with OpenStreetMap ones; shown solid green, and routes treat them the same way.
- **Dune and shorebird closures:** FWC Critical Wildlife Areas with their yearly closure dates, plus your own curated notices in `data/closures.json`. An active closure blocks routes through it and marks any entrance inside it as closed.
- **Tide vs. beach path:** NOAA predicted water level (NAVD88) compared with USGS 3DEP ground height at the sand points on your route; warns of the hours the tide may cover it.
- **Street-level photos** along the route: Mapillary (free token in Settings) or nearby Wikimedia Commons photos; the walk-through shows the photo nearest to you.
- **Community reports:** tap the map, *Report an issue here*. Saved on the device; blocking reports reroute you; *Share with maintainers* opens a GitHub issue (set `reportsRepo` in `js/config.js`). Reviewed reports go in `data/community-reports.json`.
- **Spanish / English** (follows the browser language; switch with the Español button).
- **Installable phone app (PWA)** with an offline shell; map tiles you have viewed are cached.

## Run it

Needs an internet connection (it loads tiles and data live). No build step.

```
npm run serve      # then open http://localhost:8080 in Chrome (location needs localhost or https)
npm test           # fixture tests for parsing, routing, access detection (Node 18+)
```

**Demo mode (sample entrances over real satellite imagery):** open `http://localhost:8080/?demo=1` (or the standalone `demo.html`). The entrances, trails and preserve in demo mode are invented; the imagery is real and needs internet.

Search a place, tap the map and choose **Start here** (or use **My location**), then press **Best beach access**.
Pan to another stretch of coast and press **Search this area**.

## Publish it (GitHub Pages)

This repository deploys itself: every push to `main` runs the tests and publishes to GitHub Pages
(workflow in `.github/workflows/pages.yml`). One-time setup: **Settings, Pages, Source: GitHub Actions**.
Site: https://samvelasco.github.io/Beach-Access-Pathfinder/ . On a phone, use *Add to Home Screen* (iPhone) or *Install app* (Android).

## Honest limits

- **OpenStreetMap is volunteer-mapped.** Entrances are inferred, so some real ones may be missing or mislabeled,
  and "wheelchair accessible" means *mapped as* accessible, not verified. Always follow posted signs.
- **Protected areas** come from OSM plus USGS PAD-US (filtered to biodiversity-managed or conservation-designated lands). **Closures** come from FWC Critical Wildlife Areas (Florida only), your curated file, and reports. There is no statewide live feed for dune restoration, temporary turtle or shorebird posting, so those need curated entries or reports. Closures apply only where posted; follow signs on site.
  The default turtle nesting dates (May 1 to Oct 31) are a placeholder: confirm with your county.
- **Tide check** compares predictions with ground height; it ignores waves, storm surge and erosion, uses a 1 ft safety margin, and needs a NOAA station with NAVD88 predictions nearby.
- **Community reports** live on the device (a static site has no database) until a maintainer copies them into `data/community-reports.json`.
- **Street view:** Google Street View can't be embedded; Mapillary and Wikimedia Commons photos can be old or missing.
- Routes follow mapped paths and streets only; there is no free walking on open beach.
- Slope along the path is not computed yet; only OSM `incline` tags are used.

## Files

| File | Role |
| --- | --- |
| `js/osm.js` | Overpass query, mirror fallback, parsing beaches/reserves/ways/amenities |
| `js/router.js` | Walking graph, mode and conservation costs, Dijkstra, entrance detection, accessibility gaps |
| `js/geo.js` | Geometry helpers (distance, point-in-polygon, ring assembly) |
| `js/tides.js`, `js/tidecheck.js` | NOAA nearest station and high/low; water level vs. USGS ground height |
| `js/official.js`, `js/closures.js` | USGS PAD-US and FWC Critical Wildlife Areas; closure date windows |
| `js/photos.js`, `js/reports.js`, `js/i18n.js`, `js/config.js` | Street-level photos, community reports, English/Spanish, deployment settings |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable offline app (PWA) |
| `data/` | Curated closures and reviewed community reports |
| `.github/workflows/pages.yml` | Test and publish to GitHub Pages |
| `js/app.js`, `index.html`, `styles.css` | Map UI |
| `js/demo-data.js`, `demo.html` | Invented sample coastline for demo mode (offline) |
| `vendor/leaflet/` | Leaflet 1.9.4 (BSD-2), vendored |
| `tests/real.test.js`, `tests/features.test.js` | Tests on hand-made fixtures (not real data), including Spanish coverage |

## Roadmap

- LiDAR slope along paths; flood-extent overlay from remote sensing
- County-level turtle nesting dates and a live closure feed when one exists
- Census demand for a fuller equity score; a shared database for reports (Supabase or similar)

Inspired by Rugged SystEMS (terrain-aware least-cost routing) and the Beach Access Pathfinder plan.
Data &copy; OpenStreetMap contributors (ODbL); imagery: USGS National Map; tides and water levels NOAA CO-OPS; elevation USGS 3DEP; protected areas USGS PAD-US; critical wildlife areas FWC; photos Mapillary (CC BY-SA) and Wikimedia Commons.
