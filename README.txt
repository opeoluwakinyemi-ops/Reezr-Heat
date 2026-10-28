Reezr Heat – free heat safety guide for Nigeria (static PWA, no build step)
Live: https://reezrheat.com  (backup: https://reezrheat.reezrclimate.workers.dev)

Hosting: Cloudflare Worker "reezrheat" (static assets only, no server code),
connected to this GitHub repo through Workers Builds. Every push to main redeploys.
  Root directory: /   Build command: (none)   Deploy command: npx wrangler deploy
Config: wrangler.jsonc. Response headers: _headers.
Files kept off the public site: .assetsignore.

Install: open the https link on a phone. Chrome shows "Add to Home screen" / Install.
Live temperature ("Use my location") only works over https.

Change the cache name in sw.js (reezr-heat-v4) whenever you ship a new version.
Local preview: python -m http.server 8765
