// Reezr Heat server: serves the static app and a small anonymous usage counter.
//
// What is stored: a random ID per phone (made on the phone, not linked to any person),
// the event name and a few fixed values (see FIELDS), the time, and the country and
// state Cloudflare infers from the network. No IP addresses, names, phone numbers or
// coordinates are ever stored.
//
//   POST /api/e      events from the app (always answers 204, even on bad input)
//   GET  /api/stats  totals for reports; needs ?key=<STATS_TOKEN>, add &format=csv for a
//                    daily spreadsheet and &days=N (default 30) for the period
//   GET  /api/map    feels-like at every state capital, for the heat map. Worked out once an
//                    hour for everyone, so each phone downloads about 2 KB instead of the forecast.
//   /api/push/*      heat alerts for people who turn them on. Only then, their saved places are
//                    kept here with their phone's notification address, never with a name.

const EVENTS = new Set(["open", "hide", "reading", "location", "share_link", "share_picture", "tab", "install", "plan", "who", "save", "alert"]);
// Allowed values for each optional field; anything else is dropped.
const FIELDS = {
  src: ["link", "saved", "none", "gps", "search", "map"],
  lv: ["Comfortable", "Warm", "Hot", "Dangerous", "Extreme danger"],
  m: ["native", "copy", "download", "cancel", "fail", "whatsapp", "all", "worker", "parent", "elder", "trader", "add", "remove", "on", "off"],
  ok: ["granted", "denied", "outside", "unsupported"],
  tab: ["home", "today", "map", "safe", "words", "about"],
};
const ID = /^[a-z0-9-]{8,40}$/i;
const DAY_MS = 86400000;
// Report days in Nigerian time (WAT, UTC+1).
const watDay = ms => new Date(ms + 3600000).toISOString().slice(0, 10);

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS saved (k TEXT PRIMARY KEY, at INTEGER NOT NULL, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, places TEXT NOT NULL, day TEXT, warned TEXT NOT NULL DEFAULT '{}', msg TEXT, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, day TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, name TEXT NOT NULL, country TEXT, region TEXT, src TEXT, lv TEXT, m TEXT, ok TEXT, tab TEXT, secs INTEGER, is_new INTEGER, installed INTEGER, mobile INTEGER)",
  "CREATE INDEX IF NOT EXISTS events_day ON events(day)",
  "CREATE INDEX IF NOT EXISTS events_device ON events(device)",
];
// Creates the table on first use, so the database needs no separate setup step.
let ready = null;
const ensureSchema = env => (ready ??= env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).catch(e => { ready = null; throw e; }));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/map") return heatMap(url, env, ctx);
    if (url.pathname.startsWith("/api/push/")) return push(req, url, env);
    if (url.pathname === "/api/e") return req.method === "POST" ? collect(req, env) : new Response(null, { status: 405 });
    if (url.pathname === "/api/stats") return stats(env, url);
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(req);
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(runAlerts(env).catch(e => console.error("alerts failed", e)));
  },
};

async function collect(req, env) {
  const ok = new Response(null, { status: 204 });
  try {
    if (!env.DB) return ok;
    const ua = req.headers.get("user-agent") || "";
    if (/bot|crawl|spider|preview|headless/i.test(ua)) return ok;
    const text = await req.text();
    if (text.length > 16000) return ok;
    const body = JSON.parse(text);
    if (!ID.test(body.d) || !ID.test(body.s) || !Array.isArray(body.ev)) return ok;
    const now = Date.now(), cf = req.cf || {}, mobile = /Mobi|Android/i.test(ua) ? 1 : 0;
    const country = String(cf.country || "").slice(0, 2) || null;
    const region = String(cf.region || "").slice(0, 60) || null;
    await ensureSchema(env);
    const stmt = env.DB.prepare(
      "INSERT INTO events (ts,day,device,session,name,country,region,src,lv,m,ok,tab,secs,is_new,installed,mobile) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const rows = [];
    for (const e of body.ev.slice(0, 30)) {
      if (!e || !EVENTS.has(e.n)) continue;
      const p = e.p && typeof e.p === "object" ? e.p : {};
      const pick = k => (FIELDS[k].includes(p[k]) ? p[k] : null);
      // Events queued while offline keep their own time, if it's within the last week.
      const ts = Number.isFinite(e.t) && e.t <= now && e.t > now - 7 * DAY_MS ? Math.floor(e.t) : now;
      const secs = Number.isFinite(p.secs) ? Math.max(0, Math.min(43200, Math.round(p.secs))) : null;
      // Events saved offline keep the visit they happened in.
      const session = typeof e.s === "string" && ID.test(e.s) ? e.s : body.s;
      rows.push(stmt.bind(ts, watDay(ts), body.d, session, e.n, country, region, pick("src"), pick("lv"), pick("m"), pick("ok"), pick("tab"),
        secs, p.new === true ? 1 : p.new === false ? 0 : null, p.inst === true ? 1 : p.inst === false ? 0 : null, mobile));
    }
    if (rows.length) await env.DB.batch(rows);
  } catch (e) {
    console.error("collect failed", e);
  }
  return ok;
}

// The same blend and corrections as the app (index.html), so the map and a reading agree.
const MODELS = ["icon_global", "meteofrance_arpege_world", "ecmwf_aifs025_single"];
const OFF_T = [-.2, -.3, -.4, .1, .1, .7, 0, -.2], OFF_H = [2, 2, 3, 2, 1, -1, 2, 3], LEAN = .7;
const HOUR_MS = 3600000, MAP_FRESH_MS = 55 * 60000;
const hourOf = at => new Date(at + HOUR_MS).getUTCHours();
function hiC(tc, rh) {
  const T = tc * 9 / 5 + 32;
  let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
    if (rh < 13 && T >= 80 && T <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    if (rh > 85 && T >= 80 && T <= 87) hi += ((rh - 85) / 10) * ((87 - T) / 5);
  }
  return Math.max((hi - 32) * 5 / 9, tc);
}
// One place's hours as [time, feels-like].
function feelsHours(hy) {
  const out = [];
  hy.time.forEach((t, i) => {
    let a = 0, b = 0, n = 0;
    for (const m of MODELS) {
      const x = (hy["temperature_2m_" + m] || [])[i], y = (hy["relative_humidity_2m_" + m] || [])[i];
      if (typeof x === "number" && typeof y === "number") { a += x; b += y; n++; }
    }
    if (!n) return;
    const at = Date.parse(t + "Z"), p = ((hourOf(at) + 23) % 24) / 3, c = Math.floor(p), d = (c + 1) % 8, w = p - c;
    const tc = a / n + OFF_T[c] * (1 - w) + OFF_T[d] * w, rh = Math.max(1, Math.min(100, b / n + OFF_H[c] * (1 - w) + OFF_H[d] * w));
    out.push([at, hiC(tc, rh) + LEAN]);
  });
  return out;
}
async function buildMap(origin, env) {
  const places = (await (await env.ASSETS.fetch(new Request(origin + "/nigeria-map.json"))).json()).states;
  const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + places.map(x => x.lat).join(",") + "&longitude=" + places.map(x => x.lon).join(",") +
    "&hourly=temperature_2m,relative_humidity_2m&past_days=1&forecast_days=3&models=" + MODELS.join(",") + "&timezone=GMT");
  if (!r.ok) throw new Error("forecast " + r.status);
  const all = await r.json(), now = Date.now(), today = watDay(now), tomorrow = watDay(now + DAY_MS), v = {};
  places.forEach((pl, i) => {
    const h = feelsHours(all[i].hourly), next = h.findIndex(x => x[0] > now);
    if (next < 1) return;
    const [a, b] = [h[next - 1], h[next]], peak = day => Math.max(...h.filter(x => watDay(x[0]) === day).map(x => x[1]));
    const round = x => Math.round(x * 10) / 10;
    v[pl.s] = [round(a[1] + (b[1] - a[1]) * (now - a[0]) / (b[0] - a[0])), round(peak(today)), round(peak(tomorrow))];
  });
  if (Object.keys(v).length < places.length) throw new Error("missing places");
  return { at: now, v };
}
async function refreshMap(origin, env) {
  const m = await buildMap(origin, env), v = JSON.stringify(m);
  await env.DB.prepare("INSERT OR REPLACE INTO saved (k,at,v) VALUES ('map',?,?)").bind(m.at, v).run();
  return v;
}
// Answers from the saved map and refreshes it in the background once it is an hour old, so
// nobody waits. If the weather service is down, the last map is sent with its own time on it.
async function heatMap(url, env, ctx) {
  const send = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT at,v FROM saved WHERE k='map'").first();
    if (!row) return send(await refreshMap(url.origin, env));
    if (Date.now() - row.at > MAP_FRESH_MS) ctx.waitUntil(refreshMap(url.origin, env).catch(e => console.error("map refresh failed", e)));
    return send(row.v);
  } catch (e) {
    console.error("map failed", e);
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}

// Heat alerts. A push carries no words: the phone wakes up and asks /api/push/msg what to show.
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const PUSH_HOST = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/;
const NOTICE = { title: "Reezr Heat alerts are on", body: "We will warn you the evening before dangerous heat at your saved places." };
const DANGER = 39.5, EXTREME = 51, ALERTS_PER_RUN = 30, REPEAT_DAYS = 3;

// The app's own signing key, made the first time it is needed and kept in the database.
async function vapid(env) {
  await env.DB.prepare("INSERT OR IGNORE INTO saved (k,at,v) VALUES ('vapid',?,?)").bind(Date.now(), await (async () => {
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return JSON.stringify({ jwk: await crypto.subtle.exportKey("jwk", k.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", k.publicKey)) });
  })()).run();
  return JSON.parse((await env.DB.prepare("SELECT v FROM saved WHERE k='vapid'").first()).v);
}
async function sendPush(endpoint, keys) {
  const head = b64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: "mailto:hello@reezrheat.com" })));
  const key = await crypto.subtle.importKey("jwk", keys.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + claims));
  const r = await fetch(endpoint, { method: "POST", headers: { Authorization: "vapid t=" + head + "." + claims + "." + b64u(sig) + ", k=" + keys.pub, TTL: "43200", Urgency: "normal", "Content-Length": "0" } });
  return r.status;
}
const subId = async endpoint => b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
function cleanPlaces(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const x of list.slice(0, 5)) {
    const lat = +x?.lat, lon = +x?.lon;
    if (!(lat >= 3 && lat <= 15 && lon >= 2 && lon <= 16)) return null;
    out.push({ name: String(x.name || "Saved place").slice(0, 80), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });
  }
  return out;
}
async function push(req, url, env) {
  const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
  try {
    if (!env.DB) return json({ error: "unavailable" }, 503);
    await ensureSchema(env);
    if (url.pathname === "/api/push/key") return json({ key: (await vapid(env)).pub });
    // When the evening check last ran, and how much it did. No places or addresses.
    if (url.pathname === "/api/push/health") {
      const row = await env.DB.prepare("SELECT at,v FROM saved WHERE k='alerts_run'").first();
      return json(row ? { at: row.at, ...JSON.parse(row.v) } : { at: null });
    }
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const text = await req.text();
    if (text.length > 4000) return json({ error: "too long" }, 400);
    const body = JSON.parse(text), endpoint = String(body.endpoint || "");
    let host = "";
    try { const u = new URL(endpoint); host = u.protocol === "https:" ? u.hostname : ""; } catch (e) {}
    if (!PUSH_HOST.test(host) || endpoint.length > 1000) return json({ error: "bad endpoint" }, 400);
    const id = await subId(endpoint);
    if (url.pathname === "/api/push/del") {
      await env.DB.prepare("DELETE FROM subs WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
    if (url.pathname === "/api/push/msg") {
      const row = await env.DB.prepare("SELECT msg FROM subs WHERE id=?").bind(id).first();
      return json(row?.msg ? JSON.parse(row.msg) : NOTICE);
    }
    if (url.pathname === "/api/push/sub") {
      const places = cleanPlaces(body.places);
      if (!places || !places.length) return json({ error: "bad places" }, 400);
      const had = await env.DB.prepare("SELECT id FROM subs WHERE id=?").bind(id).first();
      await env.DB.prepare("INSERT INTO subs (id,endpoint,places,msg,at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET places=excluded.places")
        .bind(id, endpoint, JSON.stringify(places), JSON.stringify(NOTICE), Date.now()).run();
      // A first message right away, so people see that alerts reach their phone.
      const pushed = had ? 0 : await sendPush(endpoint, await vapid(env));
      return json({ ok: true, pushed });
    }
    return new Response("Not found", { status: 404 });
  } catch (e) {
    console.error("push failed", e);
    return json({ error: "failed" }, 500);
  }
}
// Runs every five minutes from 6pm Nigerian time and takes a small batch each time, because a
// Cloudflare free-plan run may only make about 50 outside calls.
async function runAlerts(env) {
  await ensureSchema(env);
  const now = Date.now(), today = watDay(now), tomorrow = watDay(now + DAY_MS);
  const subs = (await env.DB.prepare("SELECT id,endpoint,places,warned FROM subs WHERE day IS NULL OR day<>? LIMIT ?").bind(today, ALERTS_PER_RUN).all()).results;
  const note = o => env.DB.prepare("INSERT OR REPLACE INTO saved (k,at,v) VALUES ('alerts_run',?,?)").bind(now, JSON.stringify(o)).run();
  if (!subs.length) return note({ checked: 0, sent: 0 });
  const lists = subs.map(x => JSON.parse(x.places)), spots = [], at = {};
  for (const l of lists) for (const x of l) {
    const k = x.lat + "," + x.lon;
    if (!(k in at)) { at[k] = spots.length; spots.push(x); }
  }
  const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + spots.map(x => x.lat).join(",") + "&longitude=" + spots.map(x => x.lon).join(",") +
    "&hourly=temperature_2m,relative_humidity_2m&forecast_days=3&models=" + MODELS.join(",") + "&timezone=GMT");
  if (!r.ok) throw new Error("forecast " + r.status);
  const all = await r.json(), peaks = (Array.isArray(all) ? all : [all]).map(o => {
    const v = feelsHours(o.hourly).filter(x => watDay(x[0]) === tomorrow).map(x => x[1]);
    return v.length ? Math.max(...v) : null;
  });
  const keys = await vapid(env), writes = [];
  let sent = 0;
  for (let i = 0; i < subs.length; i++) {
    const warned = JSON.parse(subs[i].warned || "{}"), hot = [];
    for (const x of lists[i]) {
      const k = x.lat + "," + x.lon, f = peaks[at[k]], w = warned[k];
      if (f == null || f < DANGER) continue;
      // Hot spells can last for weeks, so during one, warn again only every few days, or if it gets worse.
      const days = w ? Math.round((Date.parse(tomorrow) - Date.parse(w.d)) / DAY_MS) : Infinity;
      if (days < REPEAT_DAYS && f < w.f + 2 && f < EXTREME) continue;
      warned[k] = { d: tomorrow, f: Math.round(f) };
      hot.push({ name: x.name, f });
    }
    let status = 0, msg = null;
    if (hot.length) {
      hot.sort((a, b) => b.f - a.f);
      msg = JSON.stringify({ title: (hot[0].f >= EXTREME ? "Extreme danger" : "Dangerous heat") + " tomorrow", body: hot.map(x => x.name + ": feels like " + (x.f > 55 ? "55+" : Math.round(x.f)) + "°C").join("\n") + "\nTap to plan your day." });
      await env.DB.prepare("UPDATE subs SET msg=? WHERE id=?").bind(msg, subs[i].id).run();
      status = await sendPush(subs[i].endpoint, keys);
      sent++;
    }
    if (status === 404 || status === 410) writes.push(env.DB.prepare("DELETE FROM subs WHERE id=?").bind(subs[i].id));
    else writes.push(env.DB.prepare("UPDATE subs SET day=?,warned=? WHERE id=?").bind(today, JSON.stringify(warned), subs[i].id));
  }
  await env.DB.batch(writes);
  return note({ checked: subs.length, sent });
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function stats(env, url) {
  if (!env.STATS_TOKEN || !same(url.searchParams.get("key") || "", env.STATS_TOKEN)) return new Response("Not found", { status: 404 });
  if (!env.DB) return Response.json({ error: "No database connected" }, { status: 503 });
  await ensureSchema(env);
  const days = Math.max(1, Math.min(366, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const from = watDay(Date.now() - (days - 1) * DAY_MS);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then(r => r.results);

  const daily = await q(`SELECT day,
      COUNT(DISTINCT device) AS people,
      COUNT(DISTINCT CASE WHEN name='open' AND is_new=1 THEN device END) AS new_people,
      COUNT(DISTINCT session) AS visits,
      SUM(name='share_link' AND m IN ('native','copy','whatsapp')) AS link_shares,
      SUM(name='share_link' AND m='whatsapp') AS whatsapp_shares,
      SUM(name='share_picture' AND m IN ('native','download')) AS picture_shares,
      SUM(name='open' AND src='link') AS opened_from_shared_link,
      SUM(name='reading' AND src='gps') AS used_location,
      SUM(name='reading' AND src='search') AS searched_town,
      SUM(name='reading' AND lv IN ('Dangerous','Extreme danger')) AS dangerous_readings,
      SUM(name='install') AS installs,
      SUM(name='plan') AS used_plan_ahead,
      SUM(name='tab' AND tab='map') AS map_views,
      SUM(name='save' AND m='add') AS places_saved,
      SUM(name='alert' AND m='on') AS alerts_turned_on,
      ROUND(SUM(CASE WHEN name='hide' THEN secs ELSE 0 END)/60.0, 1) AS minutes_used
    FROM events WHERE day >= ? GROUP BY day ORDER BY day`, from);
  const [tot] = await q(`SELECT COUNT(DISTINCT device) AS people, COUNT(DISTINCT session) AS visits,
      ROUND(SUM(CASE WHEN name='hide' THEN secs ELSE 0 END)/60.0, 1) AS minutes_used,
      SUM(name='share_link' AND m IN ('native','copy','whatsapp')) AS link_shares,
      SUM(name='share_link' AND m='whatsapp') AS whatsapp_shares,
      SUM(name='share_picture' AND m IN ('native','download')) AS picture_shares,
      SUM(name='open' AND src='link') AS opened_from_shared_link,
      COUNT(DISTINCT CASE WHEN name='open' AND src='link' THEN device END) AS people_from_shared_links,
      SUM(name='tab' AND tab='map') AS map_views,
      SUM(name='save' AND m='add') AS places_saved,
      SUM(name='alert' AND m='on') AS alerts_turned_on,
      SUM(name='install') AS installs,
      SUM(name='plan') AS used_plan_ahead,
      SUM(name='reading' AND lv IN ('Dangerous','Extreme danger')) AS dangerous_readings
    FROM events WHERE day >= ?`, from);
  // People who used the app on two or more different days in the period.
  const [alerts] = await q("SELECT COUNT(*) AS n FROM subs");
  const adviceFor = await q(`SELECT m AS person, COUNT(DISTINCT device) AS people FROM events WHERE day >= ? AND name='who' AND m IS NOT NULL AND m<>'all' GROUP BY m ORDER BY people DESC`, from);
  const tabs = await q(`SELECT tab, COUNT(*) AS views FROM events WHERE day >= ? AND name='tab' AND tab IS NOT NULL GROUP BY tab ORDER BY views DESC`, from);
  const sources = await q(`SELECT src AS source, COUNT(*) AS readings FROM events WHERE day >= ? AND name='reading' AND src IS NOT NULL GROUP BY src ORDER BY readings DESC`, from);
  const [ret] = await q(`SELECT COUNT(*) AS returning_people FROM (SELECT device FROM events WHERE day >= ? GROUP BY device HAVING COUNT(DISTINCT day) >= 2)`, from);
  const states = await q(`SELECT COALESCE(region,'Unknown') AS state, COUNT(DISTINCT device) AS people FROM events
    WHERE day >= ? AND country='NG' GROUP BY region ORDER BY people DESC`, from);
  const countries = await q(`SELECT COALESCE(country,'??') AS country, COUNT(DISTINCT device) AS people FROM events
    WHERE day >= ? GROUP BY country ORDER BY people DESC`, from);
  const levels = await q(`SELECT lv AS level, COUNT(*) AS readings FROM events WHERE day >= ? AND name='reading' AND lv IS NOT NULL
    GROUP BY lv ORDER BY readings DESC`, from);

  if (url.searchParams.get("format") === "csv") {
    const cols = Object.keys(daily[0] || { day: "" });
    const csv = [cols.join(","), ...daily.map(r => cols.map(c => r[c] ?? 0).join(","))].join("\n");
    return new Response(csv + "\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="reezr-heat-${from}-to-${watDay(Date.now())}.csv"` },
    });
  }
  const t = tot || {};
  return Response.json({
    period: { from, to: watDay(Date.now()), days },
    totals: {
      ...t,
      returning_people: ret?.returning_people ?? 0,
      alerts_on: alerts?.n ?? 0,
      minutes_per_visit: t.visits ? Math.round((t.minutes_used / t.visits) * 10) / 10 : 0,
    },
    by_state: states, by_country: countries, levels_seen: levels, advice_for: adviceFor, tabs, reading_sources: sources, daily,
  }, { headers: { "cache-control": "no-store" } });
}
