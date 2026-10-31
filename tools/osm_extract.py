"""Pull named places, streets and landmarks plus LGA and state shapes from a Nigeria OSM extract.
Usage: PYTHONPATH=pylib python osm_extract.py osm/ng.pbf osm/raw.tsv osm/admin.tsv
"""
import sys, time, osmium
from osmium.geom import WKTFactory
src, raw, adm = sys.argv[1:4]
PLACE = {"city","town","village","hamlet","suburb","quarter","neighbourhood","locality","isolated_dwelling","borough","city_block"}
AMEN = {"marketplace","hospital","university","college","school","bus_station","fuel","clinic","ferry_terminal","townhall"}
HIGH = {"motorway","trunk","primary","secondary","tertiary","unclassified","residential","living_street","service","pedestrian","road","motorway_link","trunk_link","primary_link","secondary_link","tertiary_link","track","footway","path"}
BAD = {"footway","path","track","service"}
wkt = WKTFactory()
out = open(raw, "w", encoding="utf-8", newline="\n"); a = open(adm, "w", encoding="utf-8", newline="\n")
seen = set(); n = {"place":0,"street":0,"poi":0,"admin":0}; t0 = time.time()
def clean(s): return s.replace("\t"," ").replace("\n"," ").strip()
def write(kind, tags, lat, lon):
    name = clean(tags.get("name",""))
    if len(name) < 2: return
    alts = "|".join(clean(tags.get(k)) for k in ("alt_name","loc_name","old_name","short_name","name:en") if tags.get(k) and clean(tags.get(k))!=name)
    if kind == "street":
        k = (name.lower(), round(lat*100), round(lon*100))     # about 1 km grid: one row per street stretch
        if k in seen: return
        seen.add(k)
    out.write(f"{kind}\t{name}\t{alts}\t{lat:.4f}\t{lon:.4f}\t{tags.get('place') or tags.get('amenity') or tags.get('highway') or tags.get('shop') or tags.get('aeroway') or tags.get('railway') or ''}\n")
    n[kind if kind in n else "poi"] += 1
def classify(tags):
    if tags.get("place") in PLACE: return "place"
    if tags.get("amenity") in AMEN or tags.get("shop") == "mall" or tags.get("aeroway") == "aerodrome" or tags.get("railway") in ("station","halt") or tags.get("highway") == "bus_stop": return "poi"
    h = tags.get("highway")
    if h in HIGH and h not in BAD: return "street"
    return None
fp = osmium.FileProcessor(src).with_locations().with_areas(osmium.filter.TagFilter(("boundary","administrative")))
for i, o in enumerate(fp):
    if i % 5000000 == 0 and i: print(i, n, int(time.time()-t0), "s", flush=True)
    t = o.tags
    if not t: continue
    if o.is_area():
        lv = t.get("admin_level")
        if t.get("boundary") == "administrative" and lv in ("4","6","7","8","9","10") and t.get("name"):
            try: g = wkt.create_multipolygon(o)
            except Exception: continue
            a.write(f"{lv}\t{clean(t['name'])}\t{g}\n"); n["admin"] += 1
        continue
    if not ("name" in t): continue
    c = classify(t)
    if not c: continue
    if o.is_node():
        if o.location.valid(): write(c, t, o.location.lat, o.location.lon)
    elif o.is_way():
        nd = o.nodes
        if len(nd):
            m = nd[len(nd)//2]
            if m.location.valid(): write(c, t, m.location.lat, m.location.lon)
print("DONE", n, int(time.time()-t0), "s", flush=True)
