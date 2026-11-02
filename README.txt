Reezr Heat – free heat safety guide for Nigeria (static PWA, no build step)
Live: https://reezrheat.com  (backup: https://reezrheat.reezrclimate.workers.dev)

Hosting: Cloudflare Worker "reezrheat" (static assets only, no server code),
connected to this GitHub repo through Workers Builds. Every push to main redeploys.
  Root directory: /   Build command: (none)   Deploy command: npx wrangler deploy
Config: wrangler.jsonc. Response headers: _headers. Server code: worker.js.
Files kept off the public site: .assetsignore.

Install: open the https link on a phone. Chrome shows "Add to Home screen" / Install.
Live temperature ("Use my location") only works over https.

Change the cache name in sw.js (reezr-heat-v53) whenever you ship a new version.
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

Heat map: nigeria-map.json holds simplified state outlines from Natural Earth (public domain) and each
state's capital from our place files. Rebuild with tools/build_map.py. /api/map in worker.js works out
feels-like at the capitals with the same blend as the app, at most once an hour, and saves it in D1.

Heat alerts: off by default. Turning them on stores the saved places and the phone's push address in the
D1 table subs; turning off deletes the row. A cron in wrangler.jsonc runs every five minutes from 6pm WAT
and checks 30 phones per run (about 360 a day), the most the free plan's 50 outside calls per run allow.
More than that needs more cron runs or the paid plan. The signing key is made on first use and kept in D1.

Photos in photos/ are licensed from Wikimedia Commons and credited in the footer. Keep the credits if a
photo stays, and check the licence page before adding any new one.

Hotter than usual: normals.json is 2020-2024 ERA5 feels-like on a half-degree grid over Nigeria, one value
in tenths of a degree per month and 3-hour block, plus the gap to our blend per block. tools/usual_grid.py
downloads it (about 2.5 hours at free-tier pace). Tested on 12,035 reports from the 14 stations with enough
NOAA ISD-Lite records from 2015-2024: says hotter 26% of the time, stations above normal 93% (90% or more in
each season), clearly cooler 2.7%. Nigeria only; other countries need their own table and test.
