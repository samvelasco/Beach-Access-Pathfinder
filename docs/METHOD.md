# Method

## Data (all live, no keys)
- **OpenStreetMap via Overpass:** `natural=beach`, `leisure=nature_reserve`, `boundary=protected_area`,
  walkable `highway=*`, `amenity=parking|toilets|shower`, bus stops. Requested as `out geom` for the visible map area.
  Several public Overpass mirrors are tried in turn.
- **Nominatim** for place search. **NOAA CO-OPS** for the nearest tide prediction station and today's highs and lows.

## Graph and costs
Nodes are shared coordinates of OSM ways. Edge cost = length x multiplier (all multipliers >= 1):

| Way | Multiplier |
| --- | --- |
| footway / path / pedestrian / cycleway | 1 |
| residential, living street, service, unclassified | 1.1 to 1.2 |
| track | 1.3 |
| tertiary / secondary / primary / trunk | 1.3 / 1.7 / 2.5 / 3 |
| steps | 2 (blocked in wheelchair mode unless `ramp=yes`) |
| surface sand | x2.2 walking, x9 wheelchair; other soft surfaces x1.3 / x5 |

Blocked: `access=no|private` or `foot=no` (unless `foot=yes`), `wheelchair=no` (wheelchair mode), incline over 10%.
Conservation: edge midpoint inside a protected area x1.4 (x6 Low-impact); on mapped beach during the nesting
season x1.5 (x4 Low-impact). Least-cost paths use Dijkstra from the start to every entrance at once.

## Entrances
A node on a walkable way within 40 m of a mapped beach polygon, clustered at 90 m. Accessibility: steps or
`wheelchair=no` -> no; `wheelchair=yes|designated` -> yes; paved/wood surface -> likely; soft surface -> no; else unknown.
Amenity distances: parking 200 m, restrooms 250 m, bus stop 300 m.

## Equity gaps
Accessible (yes or likely) entrances are ordered along the shoreline by their principal axis; consecutive gaps over 1 km are drawn and listed.

## Verification
`tests/real.test.js` checks the logic on hand-made fixtures. Live OSM data could not be fetched from the build
environment, so check results against the real map when you first run it.
