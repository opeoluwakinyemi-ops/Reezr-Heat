"""ERA5 normals on a half-degree grid over Nigeria, one table of months and 3-hour blocks per point.

Usage: python -I usual_grid.py <places dir> <output dir>
Only points beside a known place are asked for. Paced to stay inside Open-Meteo's free limits,
saves after every point, and carries on where it stopped if run again.
"""
import datetime as dt, glob, json, math, os, pickle, sys, time, urllib.error, urllib.request

places, out = sys.argv[1], sys.argv[2]
path = os.path.join(out, "grid.pkl")


def hi_c(tc, r):
    T = tc * 9 / 5 + 32
    hi = 0.5 * (T + 61 + (T - 68) * 1.2 + r * 0.094)
    if (hi + T) / 2 >= 80:
        hi = (-42.379 + 2.04901523 * T + 10.14333127 * r - 0.22475541 * T * r - 0.00683783 * T * T
              - 0.05481717 * r * r + 0.00122874 * T * T * r + 0.00085282 * T * r * r - 0.00000199 * T * T * r * r)
        if r < 13 and 80 <= T <= 112:
            hi -= ((13 - r) / 4) * math.sqrt((17 - abs(T - 95)) / 17)
        if r > 85 and 80 <= T <= 87:
            hi += ((r - 85) / 10) * ((87 - T) / 5)
    return max((hi - 32) * 5 / 9, tc)


cells = set()
for f in glob.glob(os.path.join(places, "*.txt")):
    for ln in open(f, encoding="utf-8"):
        p = ln.split("\t")
        if len(p) < 5:
            continue
        la, lo = float(p[3]), float(p[4])
        a, b = math.floor(la * 2) / 2, math.floor(lo * 2) / 2
        for x in (a, a + .5):
            for y in (b, b + .5):
                cells.add((x, y))
cells = sorted(cells)
grid = pickle.load(open(path, "rb")) if os.path.exists(path) else {}
print(len(cells), "points,", len(grid), "already done", flush=True)

for c in cells:
    if c in grid:
        continue
    url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={c[0]}&longitude={c[1]}&start_date=2020-01-01&end_date=2024-12-31"
           "&hourly=temperature_2m,relative_humidity_2m&models=era5&timezone=GMT")
    while True:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "reezr-heat-validation"}), timeout=120) as r:
                j = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            print("wait", c, e.code, e.read()[:100], flush=True)
            time.sleep(1800 if e.code == 429 else 60)
        except Exception as e:
            print("retry", c, e, flush=True)
            time.sleep(60)
    h = j["hourly"]
    per = {}
    for ts, t, rh in zip(h["time"], h["temperature_2m"], h["relative_humidity_2m"]):
        if t is None or rh is None:
            continue
        x = dt.datetime(int(ts[:4]), int(ts[5:7]), int(ts[8:10]), int(ts[11:13])) + dt.timedelta(hours=1)
        per.setdefault((x.month - 1, x.hour // 3), {}).setdefault(x.year, []).append(hi_c(t, rh))
    grid[c] = {"elev": j.get("elevation"), "t": {k: sum(sum(v) / len(v) for v in by.values()) / len(by) for k, by in per.items()}}
    pickle.dump(grid, open(path + ".tmp", "wb"))
    os.replace(path + ".tmp", path)
    if len(grid) % 20 == 0:
        print(len(grid), "of", len(cells), flush=True)
    time.sleep(20)
print("done", len(grid), flush=True)
