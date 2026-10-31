Reezr Heat – free heat safety guide for Nigeria (static PWA, no build step)
Live: https://reezrheat.com  (backup: https://reezrheat.reezrclimate.workers.dev)

Hosting: Cloudflare Worker "reezrheat" (static assets only, no server code),
connected to this GitHub repo through Workers Builds. Every push to main redeploys.
  Root directory: /   Build command: (none)   Deploy command: npx wrangler deploy
Config: wrangler.jsonc. Response headers: _headers. Server code: worker.js.
Files kept off the public site: .assetsignore.

Install: open the https link on a phone. Chrome shows "Add to Home screen" / Install.
Live temperature ("Use my location") only works over https.

Change the cache name in sw.js (reezr-heat-v24) whenever you ship a new version.
Local preview: python -m http.server 8765

Accuracy (constants at the top of the feels-like code in index.html):
  Readings and forecasts average ICON, ARPEGE and AIFS from Open-Meteo, then apply a correction
  by time of day (OFF_T, OFF_H) and a 0.7°C lean towards warning (LEAN).
  Measured 30 Oct 2026 on 23,856 reports from 23 Nigerian stations: Mar-May and Dec 2025,
  Jan, Aug and Oct 2026. Station reports from Ogimet; past forecasts from Open-Meteo's
  previous-runs API. These numbers are for Nigeria; other countries need their own check.

Place search (places/ holds names from OpenStreetMap, ODbL, and GeoNames, CC BY 4.0):
  Rebuild from a Geofabrik extract and GeoNames' NG.txt: tools/osm_extract.py, then tools/build_places.py.
  Needs pip packages osmium and shapely. Extracting Nigeria took about 9 hours on a laptop.
  Real areas missing from those sources go in tools/known_areas.txt. Reports from users belong there too.
  Locations nobody has confirmed end in |? there, and the app labels them approximate.

Usage stats (anonymous; worker.js lists exactly what is stored):
  Events go to the Cloudflare D1 database "reezrheat-analytics" (binding DB).
  Read them at https://reezrheat.com/api/stats?key=<STATS_TOKEN>
    add &days=90 for a longer period, &format=csv for a daily spreadsheet.
  STATS_TOKEN is a secret set in the Cloudflare dashboard (Worker > Settings > Variables and Secrets).
  Open https://reezrheat.com/?notrack=1 once on a phone to stop counting it (?notrack=0 to undo).
Local test with a local database:
  echo STATS_TOKEN=localtest > .dev.vars
  npx wrangler dev --persist-to <short folder>   (Windows: long paths break the local database)
