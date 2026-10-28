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

const EVENTS = new Set(["open", "hide", "reading", "location", "share_link", "share_picture", "tab", "install"]);
// Allowed values for each optional field; anything else is dropped.
const FIELDS = {
  src: ["link", "saved", "none", "gps", "search"],
  lv: ["Comfortable", "Warm", "Hot", "Dangerous", "Extreme danger"],
  m: ["native", "copy", "download", "cancel", "fail"],
  ok: ["granted", "denied", "outside", "unsupported"],
  tab: ["today", "safe", "words"],
};
const ID = /^[a-z0-9-]{8,40}$/i;
const DAY_MS = 86400000;
// Report days in Nigerian time (WAT, UTC+1).
const watDay = ms => new Date(ms + 3600000).toISOString().slice(0, 10);

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, day TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, name TEXT NOT NULL, country TEXT, region TEXT, src TEXT, lv TEXT, m TEXT, ok TEXT, tab TEXT, secs INTEGER, is_new INTEGER, installed INTEGER, mobile INTEGER)",
  "CREATE INDEX IF NOT EXISTS events_day ON events(day)",
  "CREATE INDEX IF NOT EXISTS events_device ON events(device)",
];
// Creates the table on first use, so the database needs no separate setup step.
let ready = null;
const ensureSchema = env => (ready ??= env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).catch(e => { ready = null; throw e; }));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/e") return req.method === "POST" ? collect(req, env) : new Response(null, { status: 405 });
    if (url.pathname === "/api/stats") return stats(env, url);
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(req);
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
      const session = ID.test(e.s) ? e.s : body.s;
      rows.push(stmt.bind(ts, watDay(ts), body.d, session, e.n, country, region, pick("src"), pick("lv"), pick("m"), pick("ok"), pick("tab"),
        secs, p.new === true ? 1 : p.new === false ? 0 : null, p.inst === true ? 1 : p.inst === false ? 0 : null, mobile));
    }
    if (rows.length) await env.DB.batch(rows);
  } catch (e) {
    console.error("collect failed", e);
  }
  return ok;
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
      SUM(name='share_link' AND m IN ('native','copy')) AS link_shares,
      SUM(name='share_picture' AND m IN ('native','download')) AS picture_shares,
      SUM(name='open' AND src='link') AS opened_from_shared_link,
      SUM(name='reading' AND src='gps') AS used_location,
      SUM(name='reading' AND src='search') AS searched_town,
      SUM(name='reading' AND lv IN ('Dangerous','Extreme danger')) AS dangerous_readings,
      SUM(name='install') AS installs,
      ROUND(SUM(CASE WHEN name='hide' THEN secs ELSE 0 END)/60.0, 1) AS minutes_used
    FROM events WHERE day >= ? GROUP BY day ORDER BY day`, from);
  const [tot] = await q(`SELECT COUNT(DISTINCT device) AS people, COUNT(DISTINCT session) AS visits,
      ROUND(SUM(CASE WHEN name='hide' THEN secs ELSE 0 END)/60.0, 1) AS minutes_used,
      SUM(name='share_link' AND m IN ('native','copy')) AS link_shares,
      SUM(name='share_picture' AND m IN ('native','download')) AS picture_shares,
      SUM(name='open' AND src='link') AS opened_from_shared_link,
      SUM(name='install') AS installs,
      SUM(name='reading' AND lv IN ('Dangerous','Extreme danger')) AS dangerous_readings
    FROM events WHERE day >= ?`, from);
  // People who used the app on two or more different days in the period.
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
      minutes_per_visit: t.visits ? Math.round((t.minutes_used / t.visits) * 10) / 10 : 0,
    },
    by_state: states, by_country: countries, levels_seen: levels, daily,
  }, { headers: { "cache-control": "no-store" } });
}
