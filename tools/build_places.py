"""Build the search files in places/ from what osm_extract.py pulled out.

Usage: python build_places.py raw.tsv admin.tsv ../places
Each row is stored once per first two letters of its words, so a search only downloads a small file.
Row: name, LGA, state, lat, lon, kind (0 landmark, 1 street, 2 place, 3 city or town), other names.
Data © OpenStreetMap contributors, ODbL.
"""
import sys, unicodedata, re
from collections import defaultdict
from pathlib import Path
import numpy as np
import shapely
from shapely import wkt

raw, adm, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
csv_limit = 70
COMMON = {"street", "road", "close", "avenue", "crescent", "drive", "lane", "way", "school", "primary", "secondary", "hospital", "clinic", "market", "station", "the", "of", "and"}
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
print("states", len(polys["4"]), "LGAs", len(polys["6"]), "areas", len(wards), flush=True)
states = [n for n, _ in polys["4"]]
lgas = [n for n, _ in polys["6"]]
tree4 = shapely.STRtree([g for _, g in polys["4"]])
tree6 = shapely.STRtree([g for _, g in polys["6"]])

rows = []
for line in open(raw, encoding="utf-8"):
    kind, name, alts, lat, lon, val = line.rstrip("\n").split("\t")
    k = {"poi": 0, "street": 1, "place": 3 if val in ("city", "town") else 2}[kind]
    rows.append([name, alts, float(lat), float(lon), k])
for name, g in wards:
    p = g.representative_point()
    rows.append([name, "", p.y, p.x, 2])
print("rows in", len(rows), flush=True)

pts = shapely.points([r[3] for r in rows], [r[2] for r in rows])


def assign(tree, n):
    a = np.full(n, -1)
    i, j = tree.query(pts, predicate="intersects")
    a[i] = j
    miss = np.where(a < 0)[0]
    if len(miss):  # just off a boundary line, such as the coast
        i2, j2 = tree.query_nearest(pts[miss], max_distance=0.05, all_matches=False)
        a[miss[i2]] = j2
    return a


st = assign(tree4, len(rows))
lg = assign(tree6, len(rows))


def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if not unicodedata.combining(c))


seen = set()
shards = defaultdict(list)
kept = 0
for r, si, li in zip(rows, st, lg):
    name, alts, lat, lon, k = r
    if si < 0 or len(name) > csv_limit or not re.search(r"[^\W\d_]", name):
        continue
    state = "FCT Abuja" if states[si] == "Federal Capital Territory" else states[si]
    lga = lgas[li] if li >= 0 else ""
    key = (norm(name), round(lat, 2), round(lon, 2))
    if key in seen:
        continue
    seen.add(key)
    kept += 1
    row = "\t".join((name, lga, state, f"{lat:.3f}", f"{lon:.3f}", str(k), alts))
    # Words nearly every row shares would only make their files large for no use.
    for c in {w[:2] for w in re.findall(r"[a-z0-9]+", norm(name + " " + alts)) if len(w) >= 2 and w not in COMMON}:
        shards[c].append(row)
out.mkdir(parents=True, exist_ok=True)
total = 0
for c, v in sorted(shards.items()):
    b = ("\n".join(v) + "\n").encode("utf-8")
    (out / f"{c}.txt").write_bytes(b)
    total += len(b)
print("kept", kept, "files", len(shards), "total KB", total // 1024, "largest KB", max(len("\n".join(v).encode()) for v in shards.values()) // 1024)
