"""Builds nigeria-map.json: simplified state outlines and each state's capital.

Usage: python build_map.py ne_10m_admin_1_states_provinces.geojson ../places ../nigeria-map.json
Outlines: Natural Earth (public domain). Capitals' positions come from our own place files, and
each must fall inside its own state or the build stops. Needs shapely 2.1 or newer.
"""
import glob, json, math, os, sys, unicodedata
import shapely
from shapely.geometry import Point, shape

geo, places, out = sys.argv[1:4]
CAPITALS = {"Abia": "Umuahia", "Adamawa": "Yola", "Akwa Ibom": "Uyo", "Anambra": "Awka", "Bauchi": "Bauchi", "Bayelsa": "Yenagoa",
            "Benue": "Makurdi", "Borno": "Maiduguri", "Cross River": "Calabar", "Delta": "Asaba", "Ebonyi": "Abakaliki", "Edo": "Benin City",
            "Ekiti": "Ado Ekiti", "Enugu": "Enugu", "FCT Abuja": "Abuja", "Gombe": "Gombe", "Imo": "Owerri", "Jigawa": "Dutse",
            "Kaduna": "Kaduna", "Kano": "Kano", "Katsina": "Katsina", "Kebbi": "Birnin Kebbi", "Kogi": "Lokoja", "Kwara": "Ilorin",
            "Lagos": "Ikeja", "Nasarawa": "Lafia", "Niger": "Minna", "Ogun": "Abeokuta", "Ondo": "Akure", "Osun": "Osogbo", "Oyo": "Ibadan",
            "Plateau": "Jos", "Rivers": "Port Harcourt", "Sokoto": "Sokoto", "Taraba": "Jalingo", "Yobe": "Damaturu", "Zamfara": "Gusau"}
NE_NAME = {"Federal Capital Territory": "FCT Abuja"}

feats = {}
for f in json.load(open(geo, encoding="utf-8"))["features"]:
    p = f["properties"]
    if p.get("adm0_a3") == "NGA":
        n = NE_NAME.get(p["name"], p["name"]).replace("Nassarawa", "Nasarawa")
        feats[n] = shape(f["geometry"]).buffer(0)
missing = set(CAPITALS) - set(feats)
assert not missing, (missing, sorted(feats))

plain = lambda x: "".join(c for c in unicodedata.normalize("NFD", x.lower()) if not unicodedata.combining(c))
best = {}
for fn in glob.glob(os.path.join(places, "*.txt")):
    for ln in open(fn, encoding="utf-8"):
        p = ln.rstrip("\n").split("\t")
        if len(p) < 6:
            continue
        for st, cap in CAPITALS.items():
            if p[2] == st and plain(p[0]) == plain(cap):
                k = int(p[5])
                if st not in best or k > best[st][0]:
                    best[st] = (k, float(p[3]), float(p[4]))
missing = set(CAPITALS) - set(best)
assert not missing, missing
for st, (k, la, lo) in best.items():
    d = feats[st].distance(Point(lo, la))
    assert d < 0.05, (st, la, lo, d)
    assert k >= 2, (st, k)

names = sorted(feats)
simple = shapely.coverage_simplify([feats[n] for n in names], 0.03)
K = 100
W0, N0 = min(g.bounds[0] for g in simple), max(g.bounds[3] for g in simple)
CX = math.cos(math.radians(9.1))
px = lambda lo: round((lo - W0) * CX * K)
py = lambda la: round((N0 - la) * K)


def path(g):
    out_ = []
    for poly in getattr(g, "geoms", [g]):
        if poly.area < 0.002:
            continue
        pts, last = [], None
        for lo, la in poly.exterior.coords[:-1]:
            q = (px(lo), py(la))
            if q != last:
                pts.append(q)
            last = q
        s, (x0, y0) = f"M{pts[0][0]} {pts[0][1]}", pts[0]
        for x, y in pts[1:]:
            s += f"l{x - x0} {y - y0}"
            x0, y0 = x, y
        out_.append(s + "z")
    return "".join(out_)


states = []
for n, g in zip(names, simple):
    _, la, lo = best[n]
    # The label sits in the roomiest part of the state, which is often not where the capital is.
    mid = shapely.maximum_inscribed_circle(max(getattr(g, "geoms", [g]), key=lambda q: q.area), tolerance=0.01).coords[0]
    states.append({"s": n, "c": CAPITALS[n], "lat": round(la, 2), "lon": round(lo, 2), "x": px(mid[0]), "y": py(mid[1]), "d": path(g)})
bx = max(g.bounds[2] for g in simple)
by = min(g.bounds[1] for g in simple)
json.dump({"w": px(bx), "h": py(by), "states": states}, open(out, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, separators=(",", ":"))
print(len(states), "states", os.path.getsize(out), "bytes", "size", px(bx), py(by))
print({s["s"]: (s["lat"], s["lon"]) for s in states})
