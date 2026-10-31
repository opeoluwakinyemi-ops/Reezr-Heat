"""Build the search files in places/ from OpenStreetMap and GeoNames.

Usage: python build_places.py raw.tsv admin.tsv NG.txt known_areas.txt ../places
raw.tsv and admin.tsv come from osm_extract.py; NG.txt is GeoNames' Nigeria file.
Many Nigerian areas are not mapped as places, only through streets and landmarks named after
them, so besides the map's own places this adds:
  - GeoNames towns, villages and wards, with their other spellings
  - known_areas.txt, areas checked by hand (guessing areas from street names produced nonsense)
Each row is stored once per first two letters of its words, so a search only downloads a small file.
Row: name, LGA, state, lat, lon, kind (0 landmark, 1 street, 2 place, 3 city or town), other names,
and "?" at the end when the location is unconfirmed.
Data © OpenStreetMap contributors (ODbL) and GeoNames (CC BY 4.0).
"""
import sys, unicodedata, re
from collections import defaultdict
from pathlib import Path
from statistics import median
import numpy as np
import shapely
from shapely import wkt

raw, adm, geo, known, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], Path(sys.argv[5])
NAME_LIMIT = 70
TARABA = {"Ardo Kola", "Ardo-Kola", "Bali", "Donga", "Gashaka", "Gassol", "Ibi", "Jalingo", "Karim Lamido", "Kurmi", "Lau", "Sardauna", "Takum", "Ussa", "Wukari", "Yorro", "Zing"}
COMMON = {"street", "road", "close", "avenue", "crescent", "drive", "lane", "way", "school", "primary", "secondary", "hospital", "clinic", "market", "station", "the", "of", "and"}

def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if not unicodedata.combining(c))


def words_of(s):
    return re.findall(r"[a-z0-9]+", norm(s))


def tidy(name):
    """Readable names: no ALL CAPS, no administrative endings."""
    name = re.sub(r"\s+(Ward|Suburban District|Local Government Area|L\.?G\.?A\.?)$", "", name.strip())
    if name.isupper() and len(name) > 4:
        name = name.title()
    return name


polys = defaultdict(list)
wards = []
for line in open(adm, encoding="utf-8"):
    lv, name, g = line.rstrip("\n").split("\t")
    try:
        geom = shapely.make_valid(wkt.loads(g))
    except Exception:
        continue
    if lv in ("4", "6"):
        polys[lv].append((name, geom))
    if lv != "4":
        wards.append((name, geom))
states = ["FCT Abuja" if n == "Federal Capital Territory" else n for n, _ in polys["4"]]
lgas = [n for n, _ in polys["6"]]
tree4 = shapely.STRtree([g for _, g in polys["4"]])
tree6 = shapely.STRtree([g for _, g in polys["6"]])

# [name, other names, lat, lon, kind, source]
rows = []
for line in open(raw, encoding="utf-8"):
    kind, name, alts, lat, lon, val = line.rstrip("\n").split("\t")
    k = {"poi": 0, "street": 1, "place": 3 if val in ("city", "town") else 2}[kind]
    rows.append([tidy(name), alts, float(lat), float(lon), k, "osm"])
for name, g in wards:
    p = g.representative_point()
    rows.append([tidy(name), "", p.y, p.x, 2, "ward"])
for line in open(geo, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    cls, code = f[6], f[7]
    if not (cls == "P" or (cls == "A" and code in ("ADM2", "ADM3"))):
        continue
    big = code in ("PPLC", "PPLA", "PPLA2") or int(f[14] or 0) > 20000
    alts = "|".join(a for a in f[3].split(",") if a and a != f[1] and a.isascii() and len(a) < 40)[:120]
    rows.append([tidy(f[1]), alts, float(f[4]), float(f[5]), 3 if big else 2, "geonames"])
print("rows in", len(rows), flush=True)

pts = shapely.points([r[3] for r in rows], [r[2] for r in rows])


def assign(tree, points):
    a = np.full(len(points), -1)
    i, j = tree.query(points, predicate="intersects")
    a[i] = j
    miss = np.where(a < 0)[0]
    if len(miss):  # just off a boundary line, such as the coast
        i2, j2 = tree.query_nearest(points[miss], max_distance=0.05, all_matches=False)
        a[miss[i2]] = j2
    return a


st = assign(tree4, pts)
lg = assign(tree6, pts)
table = []  # name, alts, lat, lon, kind, lga, state, source
dropped = defaultdict(int)
for r, si, li in zip(rows, st, lg):
    lga = lgas[li] if li >= 0 else ""
    # OpenStreetMap has no outline for Taraba State, so its places are recognised by their LGA.
    state = "Taraba" if lga in TARABA else states[si] if si >= 0 else ""
    if not state:
        dropped[lga] += 1
    elif len(r[0]) <= NAME_LIMIT and re.search(r"[^\W\d_]", r[0]):
        table.append([r[0], r[1], r[2], r[3], r[4], lga, state, r[5]])
print("no state found, by LGA:", sorted(dropped.items(), key=lambda x: -x[1])[:25], flush=True)
print("rows per state:", sorted(((n, sum(t[6] == n for t in table)) for n in states + ["Taraba"]), key=lambda x: x[1])[:6], flush=True)

# Known areas, placed from everything in that state whose name contains them.
known_rows, unplaced = [], []
for line in open(known, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    f = line.split("|")
    want = " " + " ".join(words_of(f[0])) + " "
    hits = [t for t in table if t[6] == f[1] and want in " " + " ".join(words_of(t[0])) + " "]
    if len(f) >= 4:
        lat, lon = float(f[2]), float(f[3])
        li = assign(tree6, shapely.points([lon], [lat]))[0]
        lga = lgas[li] if li >= 0 else ""
    elif hits:
        # Most of the matches, not a stray one far away.
        lat, lon = median(t[2] for t in hits), median(t[3] for t in hits)
        near = [t for t in hits if abs(t[2] - lat) < .05 and abs(t[3] - lon) < .05] or hits
        lat, lon = median(t[2] for t in near), median(t[3] for t in near)
        lgs = [t[5] for t in near if t[5]]
        lga = max(set(lgs), key=lgs.count) if lgs else ""
    else:
        unplaced.append(f[0])
        continue
    known_rows.append([f[0], "?" if f[-1] == "?" else "", lat, lon, 2, lga, f[1], "known"])
print("known areas", len(known_rows), "unplaced", unplaced, flush=True)

# Places first, so a street or landmark never replaces a place of the same name nearby.
everything = sorted(table + known_rows, key=lambda t: (-t[4], t[7] != "known"))
seen = set()
shards = defaultdict(list)
kept = defaultdict(int)
for name, alts, lat, lon, k, lga, state, src in everything:
    key = (norm(name), round(lat / .03), round(lon / .03))
    if key in seen:
        continue
    seen.add(key)
    kept[src] += 1
    # For hand-checked areas the other-names column only carries the unconfirmed mark.
    unconfirmed, alts = (alts == "?", "") if src == "known" else (False, alts)
    row = "\t".join((name, lga, state, f"{lat:.3f}", f"{lon:.3f}", str(k), alts) + (("?",) if unconfirmed else ()))
    # Words nearly every row shares would only make their files large for no use.
    for c in {w[:2] for w in words_of(name + " " + alts) if len(w) >= 2 and w not in COMMON}:
        shards[c].append(row)
out.mkdir(parents=True, exist_ok=True)
sizes = {}
for c, v in sorted(shards.items()):
    b = ("\n".join(v) + "\n").encode("utf-8")
    (out / f"{c}.txt").write_bytes(b)
    sizes[c] = len(b)
print("kept", dict(kept), "total rows", sum(kept.values()), "files", len(shards), "total KB", sum(sizes.values()) // 1024, "largest KB", max(sizes.values()) // 1024)
