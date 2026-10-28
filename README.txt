Reezr Heat – free heat safety guide for Nigeria (static PWA, no build step)
Live: https://reezrheat.com  (backup: https://reezrheat.reezrclimate.workers.dev)

Hosting: Cloudflare Worker "reezrheat" (static assets only, no server code),
connected to this GitHub repo through Workers Builds. Every push to main redeploys.
  Root directory: /   Build command: (none)   Deploy command: npx wrangler deploy
Config: wrangler.jsonc. Response headers: _headers. Server code: worker.js.
Files kept off the public site: .assetsignore.

Install: open the https link on a phone. Chrome shows "Add to Home screen" / Install.
Live temperature ("Use my location") only works over https.

Change the cache name in sw.js (reezr-heat-v13) whenever you ship a new version.
Local preview: python -m http.server 8765

Usage stats (anonymous; worker.js lists exactly what is stored):
  Events go to the Cloudflare D1 database "reezrheat-analytics" (binding DB).
  Read them at https://reezrheat.com/api/stats?key=<STATS_TOKEN>
    add &days=90 for a longer period, &format=csv for a daily spreadsheet.
  STATS_TOKEN is a secret set in the Cloudflare dashboard (Worker > Settings > Variables and Secrets).
  Open https://reezrheat.com/?notrack=1 once on a phone to stop counting it (?notrack=0 to undo).
Local test with a local database:
  echo STATS_TOKEN=localtest > .dev.vars
  npx wrangler dev --persist-to <short folder>   (Windows: long paths break the local database)
