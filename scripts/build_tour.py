#!/usr/bin/env python3
"""Build one tour: routing, checks, turn-by-turn directions, voice, tour.json and the catalogue.

    python scripts/build_tour.py tours/amsterdam/golden-age            # everything that is missing
    python scripts/build_tour.py tours/amsterdam/golden-age --reroute  # ask OSRM again
    python scripts/build_tour.py tours/amsterdam/golden-age --no-audio # route + texts only
    python scripts/build_tour.py tours/berlin/divided --lang nl        # voice a translation
    python scripts/build_tour.py tours/amsterdam/golden-age --check    # only the content checks
    python scripts/build_tour.py --catalogue                           # only rebuild tours/index.json

Paths are relative to the app folder (berlin-divided/) or the current directory.
The tour folder holds tour.json (written by hand, completed by this script) and audio/.

Authoring fields in tour.json (see tours/SCHEMA.md): id, city, title, subtitle, mode (bike|walk),
intro{script}, outro{script}, stops[{id, title, short, lat, lng, script, sources[], via[[lat,lng]]}],
sources[]. The script fills in: route, legs[{steps[{lat,lng,text,clip,pre}]}], distance_km,
ride_min, duration_min, audio paths and durations, turnaround, offroute.

Pipeline
 1. Routing: OSRM at routing.openstreetmap.de (routed-bike or routed-foot) through every stop (and
    optional via points), overview=full&geometries=geojson&steps=true. The reply is cached in
    .osrm.json so later builds do not need the network. Every stop must lie within 20 m of the
    route; a stop further away is moved onto the route when OSRM snapped it less than 150 m away,
    otherwise the build stops and asks for a via point.
 2. Directions: drop "arrive" and straight "new name"/"continue"; merge maneuvers less than 30 m
    apart ("Turn left, then turn right onto X"); add "and stay on it for about N metres" when the
    next maneuver is more than 450 m away; the first step of every leg starts with
    "Directions to the next stop.". Spoken text replaces ß with ss.
 3. Voice: edge-tts en-GB-RyanNeural (or the file's "voice"), rate -4% for stories and -2% for
    directions, re-encoded with ffmpeg to mono 22.05 kHz 32 kbps MP3.
 4. Checks: word counts (stories 250-320, intro about 120, outro about 80), no em dashes, every stop
    has sources. Problems are printed; --strict makes them fatal.
"""
import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import urllib.request

OSRM = "https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true"
UA = "tour-platform-build/1.0 (https://github.com/etzy123/toursjelle)"
STOP_TOLERANCE = 20      # metres: every stop must be this close to the route
MAX_SNAP = 150           # metres: further than this and the stop needs a via point instead
MERGE_BELOW = 30         # metres between maneuvers that are spoken as one
STAY_ON_ABOVE = 450      # metres to the next maneuver before "and stay on it for about ..."
FERRY_NAME = re.compile(r"(veer|ferry|fähre|traghetto|ferri)\b", re.I)
PRE_DISTANCE = 150       # metres, the pre-announcement; must match PRE_AT in index.html
LEG_INTRO = "Directions to the next stop. "
PRE_PREFIX = {"en": f"In {PRE_DISTANCE} metres, ", "nl": f"Over {PRE_DISTANCE} meter ", "de": f"In {PRE_DISTANCE} Metern "}
TURNAROUND = "Turn around when it is safe, then ride back to the route."
TURNAROUND_WALK = "Turn around when it is safe, then walk back to the route."
OFFROUTE = "You seem to be off the route. Follow the arrow on the screen back to it."
RATE_STORY, RATE_NAV = "-4%", "-2%"
APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "berlin-divided")


# ---------- geometry ----------
def dist(a, b):
    """metres between [lat, lng] points"""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def nearest_on_route(p, route):
    """(distance in m, [lat, lng] of the nearest point on the polyline)"""
    k = math.cos(math.radians(p[0]))
    xy = lambda q: ((q[1] - p[1]) * k * 111320, (q[0] - p[0]) * 110540)
    best = (float("inf"), None)
    for a, b in zip(route, route[1:]):
        (ax, ay), (bx, by) = xy(a), xy(b)
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        u = max(0.0, min(1.0, (-ax * dx - ay * dy) / L)) if L else 0.0
        x, y = ax + u * dx, ay + u * dy
        d = math.hypot(x, y)
        if d < best[0]:
            best = (d, [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u])
    return best


def cardinal(bearing):
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][round(bearing / 45) % 8]


def ordinal(n):
    return ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"][max(1, min(8, n or 1)) - 1]


def about(m):
    """'about 700 metres' / 'about 1.7 kilometres'"""
    if m < 950:
        return f"about {int(round(m / 100.0) * 100)} metres"
    km = round(m / 1000.0, 1)
    km_s = f"{km:g}"
    return f"about {km_s} kilometre" + ("" if km_s == "1" else "s")


# ---------- directions from OSRM steps ----------
def maneuver_text(step):
    """English instruction for one OSRM step, or None if the step is not spoken."""
    m = step["maneuver"]
    t, mod, name = m.get("type"), m.get("modifier"), step.get("name") or ""
    onto = f" onto {name}" if name else ""
    side = "left" if mod and "left" in mod else "right" if mod and "right" in mod else None
    if t == "arrive" or t in ("exit roundabout", "exit rotary"):
        return None
    if t in ("new name", "continue", "notification", "use lane") and mod in (None, "straight"):
        return None
    if t == "depart":
        return f"Head {cardinal(m.get('bearing_after', 0))}" + (f" on {name}" if name else "")
    if t in ("roundabout", "rotary", "roundabout turn"):
        return f"At the roundabout, take the {ordinal(m.get('exit'))} exit{onto}"
    if t == "fork":
        return f"Keep {side}{onto}" if side else f"Keep straight on{onto}"
    if t == "end of road":
        return f"At the end of the road, turn {side or 'left'}{onto}"
    if t == "merge":
        return f"Merge {side}{onto}" if side else f"Merge{onto}"
    if t in ("on ramp", "off ramp"):
        return f"Take the ramp on the {side}{onto}" if side else f"Take the ramp{onto}"
    if mod == "uturn":
        return "Make a U-turn" + (f" onto {name}" if name else "")
    if mod == "straight":
        return f"Continue onto {name}" if name else "Go straight on"
    if mod in ("slight left", "slight right"):
        return f"Bear {side}{onto}"
    if mod in ("sharp left", "sharp right"):
        return f"Turn sharp {side}{onto}"
    if side:
        return f"Turn {side}{onto}"
    return None


def lower_first(s):
    return s[:1].lower() + s[1:]


def leg_directions(osrm_legs):
    """Spoken steps for one stop-to-stop leg, made of one or more OSRM legs (more when via points are used)."""
    kept, pos, mode = [], 0.0, False
    total = sum(l["distance"] for l in osrm_legs)
    for li, leg in enumerate(osrm_legs):
        for step in leg["steps"]:
            t = step["maneuver"].get("type")
            if li > 0 and t == "depart":  # leaving a via point is not a new direction
                pos += step["distance"]
                continue
            # some profiles give ferries their own mode, others only a name like "NDSM-werfveer"
            on_ferry = step.get("mode") == "ferry" or bool(FERRY_NAME.search(step.get("name") or ""))
            text = "Take the ferry" if on_ferry and not mode else maneuver_text(step)
            mode = on_ferry
            if text:
                lng, lat = step["maneuver"]["location"]
                kept.append({"pos": pos, "lat": round(lat, 6), "lng": round(lng, 6), "text": text,
                             "ferry": step["distance"] if on_ferry and text == "Take the ferry" else 0})
            pos += step["distance"]
    # maneuvers closer than MERGE_BELOW are spoken together
    groups = []
    for k in kept:
        if groups and k["pos"] - groups[-1][-1]["pos"] < MERGE_BELOW:
            groups[-1].append(k)
        else:
            groups.append([k])
    steps = []
    for i, g in enumerate(groups):
        text = g[0]["text"] + "".join(", then " + lower_first(x["text"]) for x in g[1:])
        nxt = groups[i + 1][0]["pos"] if i + 1 < len(groups) else total
        gap = nxt - g[-1]["pos"]
        crossing = sum(x["ferry"] for x in g)
        if crossing:
            text += f". The crossing is {about(crossing)}"
        elif gap > STAY_ON_ABOVE:
            text += f", and stay on it for {about(gap)}"
        text += "."
        if i == 0:
            text = LEG_INTRO + text
        steps.append({"lat": g[0]["lat"], "lng": g[0]["lng"], "text": text})
    return steps


def spoken(text):
    return text.replace("ß", "ss")


def clip_id(text):
    return hashlib.md5(spoken(text).encode("utf-8")).hexdigest()[:10]


def pre_text(text, lang="en", intro=LEG_INTRO):
    t = text.replace(intro, "")
    return f"{PRE_PREFIX[lang]}{lower_first(t)}"


# ---------- routing ----------
def waypoints(tour):
    pts = []
    for i, s in enumerate(tour["stops"]):
        for v in s.get("via", []) if i else []:
            pts.append(("via", v))
        pts.append(("stop", [s["lat"], s["lng"]]))
    return pts


def fetch_route(tour, cache):
    profile = "foot" if tour["mode"] == "walk" else "bike"
    coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for _, p in waypoints(tour))
    url = OSRM.format(profile=profile, coords=coords)
    print(f"  routing ({profile}) through {len(waypoints(tour))} points")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    if data.get("code") != "Ok":
        sys.exit(f"OSRM: {data.get('code')} {data.get('message', '')}")
    data["_request"] = {"profile": profile, "coords": coords}
    json.dump(data, open(cache, "w"), indent=1)
    return data


def apply_route(tour, osrm, problems):
    r = osrm["routes"][0]
    route = [[round(lat, 6), round(lng, 6)] for lng, lat in r["geometry"]["coordinates"]]
    kinds = [k for k, _ in waypoints(tour)]
    # a stop further than STOP_TOLERANCE from the route moves onto it (OSRM snapped it there)
    si = 0
    for k, wp in zip(kinds, osrm["waypoints"]):
        if k != "stop":
            continue
        s = tour["stops"][si]
        si += 1
        d, pt = nearest_on_route([s["lat"], s["lng"]], route)
        if d > STOP_TOLERANCE:
            if wp.get("distance", d) > MAX_SNAP:
                problems.append(f"stop {s['id']} is {d:.0f} m from the route; add a via point near it")
                continue
            print(f"  moved stop {s['id']} {d:.0f} m onto the route")
            s["lat"], s["lng"] = round(pt[0], 6), round(pt[1], 6)
    # legs between consecutive stops (OSRM legs are between consecutive waypoints)
    stop_at = [i for i, k in enumerate(kinds) if k == "stop"]
    legs = []
    for a, b in zip(stop_at, stop_at[1:]):
        steps = leg_directions(r["legs"][a:b])
        legs.append({"distance": round(sum(l["distance"] for l in r["legs"][a:b])), "steps": steps})
    tour["route"] = route
    tour["legs"] = legs
    tour["distance_km"] = round(r["distance"] / 1000, 1)
    tour["ride_min"] = round(r["duration"] / 60)


# ---------- voice ----------
def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found: install it, or pip install imageio-ffmpeg")


def mp3_duration(path):
    """Seconds of MPEG layer III audio, found by walking every frame."""
    data = open(path, "rb").read()
    i = 0
    if data[:3] == b"ID3":
        i = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    r1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    r2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    srs = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    sec = 0.0
    while i + 4 <= len(data):
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1
            continue
        v, bri, sri = (data[i + 1] >> 3) & 3, data[i + 2] >> 4, (data[i + 2] >> 2) & 3
        if v == 1 or bri in (0, 15) or sri == 3:
            i += 1
            continue
        m1 = v == 3
        kb, sr = (r1 if m1 else r2)[bri], srs[v][sri]
        i += (144 if m1 else 72) * kb * 1000 // sr + ((data[i + 2] >> 1) & 1)
        sec += (1152 if m1 else 576) / sr
    return round(sec, 1)


async def speak(text, voice, rate, out):
    import edge_tts  # only needed when audio is built
    raw = out + ".raw.mp3"
    try:
        await edge_tts.Communicate(spoken(text), voice, rate=rate).save(raw)
    except Exception:
        if os.path.exists(raw):
            os.remove(raw)
        raise
    if not os.path.exists(raw) or os.path.getsize(raw) == 0:
        raise RuntimeError(f"edge-tts returned no audio for: {text[:60]}")
    subprocess.run([ffmpeg_exe(), "-y", "-loglevel", "error", "-i", raw, "-ac", "1", "-ar", "22050", "-b:a", "32k", out], check=True)
    os.remove(raw)


def audio_jobs(tour, root, rebuild, sub=""):
    """(kind, item, relative path or folder, rate) for every clip that is missing."""
    jobs = []
    stories = [(tour["intro"], "intro"), (tour["outro"], "outro")] + [(s, s["id"]) for s in tour["stops"]]
    stories += [(s["more"], s["id"] + "-more") for s in tour["stops"] if s.get("more")]
    stories += [(b, b["id"]) for b in tour.get("bonus", [])]
    for item, fid in stories:
        have = item.get("audio") and os.path.exists(os.path.join(root, item["audio"]))
        if rebuild or not have:
            jobs.append(("story", item, fid, RATE_STORY))
    for item in nav_items(tour):
        rel = f"{sub}audio/nav/{clip_id(item['text'])}.mp3"
        # clips made by the old build_audio.py are named after the unspoken text
        legacy = f"{sub}audio/nav/{hashlib.md5(item['text'].encode('utf-8')).hexdigest()[:10]}.mp3"
        have = [p for p in (rel, legacy) if os.path.exists(os.path.join(root, p))]
        if rebuild or not have:
            jobs.append(("nav", item, rel, RATE_NAV))
        else:
            item["clip"] = have[0]
    return jobs


def nav_items(tour):
    items = [s for leg in tour.get("legs", []) for s in leg["steps"]]
    items += [s["pre"] for leg in tour.get("legs", []) for s in leg["steps"] if s.get("pre")]
    items += [x for x in (tour.get("turnaround"), tour.get("offroute")) if x and x.get("text")]
    return items


def build_audio(tour, root, rebuild, lang="en"):
    sub = "" if lang == "en" else f"{lang}/"  # translations: audio/<lang>/... would clash, so <lang>/audio/...
    jobs = audio_jobs(tour, root, rebuild, sub)
    if not jobs:
        return
    voice = tour.get("voice", "en-GB-RyanNeural")
    os.makedirs(os.path.join(root, sub, "audio", "stories"), exist_ok=True)
    os.makedirs(os.path.join(root, sub, "audio", "nav"), exist_ok=True)

    async def run():
        for n, (kind, item, target, rate) in enumerate(jobs, 1):
            text = item["script"] if kind == "story" else item["text"]
            print(f"  [{n}/{len(jobs)}] {text[:64]}")
            if kind == "nav":
                await speak(text, voice, rate, os.path.join(root, target))
                item["clip"] = target
            else:
                tmp = os.path.join(root, sub, "audio", "stories", f"{target}.mp3")
                await speak(text, voice, rate, tmp)
                rel = f"{sub}audio/stories/{target}-{hashlib.md5(open(tmp, 'rb').read()).hexdigest()[:8]}.mp3"
                old = item.get("audio")
                os.replace(tmp, os.path.join(root, rel))
                if old and old != rel and os.path.exists(os.path.join(root, old)):
                    os.remove(os.path.join(root, old))
                item["audio"], item["dur"] = rel, mp3_duration(os.path.join(root, rel))
    asyncio.run(run())


# ---------- checks ----------
def words(t):
    return len(re.findall(r"\b[\w'’-]+\b", t))


def check(tour, problems):
    def span(label, text, lo, hi):
        n = words(text)
        if not lo <= n <= hi:
            problems.append(f"{label}: {n} words (want {lo}-{hi})")
    span("intro", tour["intro"]["script"], 90, 150)
    span("outro", tour["outro"]["script"], 60, 110)
    for s in tour["stops"]:
        span(f"stop {s['id']}", s["script"], 250, 320)
        if not s.get("sources"):
            problems.append(f"stop {s['id']}: no sources")
    blob = json.dumps(tour, ensure_ascii=False)
    if "—" in blob:
        problems.append("contains an em dash")
    ids = [s["id"] for s in tour["stops"]]
    if len(ids) != len(set(ids)):
        problems.append("duplicate stop ids")


def fill_texts(tour, lang="en"):
    """pre-announcements, turn-around and off-route prompts (English tours; translations bring their own)"""
    intro = tour.get("navIntro", LEG_INTRO)
    for leg in tour.get("legs", []):
        for j, st in enumerate(leg["steps"]):
            if j:
                t = pre_text(st["text"], lang, intro)
                if (st.get("pre") or {}).get("text") != t:
                    st["pre"] = {"text": t}
    if lang == "en":
        want = TURNAROUND_WALK if tour.get("mode") == "walk" else TURNAROUND
        if (tour.get("turnaround") or {}).get("text") != want:
            tour["turnaround"] = {"text": want}
        if not tour.get("offroute"):
            tour["offroute"] = {"text": OFFROUTE}


def durations(tour):
    story_s = sum((s.get("dur") or words(s["script"]) / 2.5) for s in tour["stops"])
    story_s += sum((x.get("dur") or words(x["script"]) / 2.5) for x in (tour["intro"], tour["outro"]))
    ride = tour.get("ride_min") or 0
    tour["duration_min"] = int(round(ride * 1.2 + story_s / 60 + 2 * len(tour["stops"])))


# ---------- catalogue ----------
def build_catalogue(app):
    base = os.path.join(app, "tours")
    tours = []
    for city in sorted(os.listdir(base)):
        cdir = os.path.join(base, city)
        if not os.path.isdir(cdir):
            continue
        for tid in sorted(os.listdir(cdir)):
            p = os.path.join(cdir, tid, "tour.json")
            if not os.path.exists(p):
                continue
            with open(p, encoding="utf-8") as f:
                t = json.load(f)
            langs = sorted(f[5:-5] for f in os.listdir(os.path.join(cdir, tid)) if re.fullmatch(r"tour\.\w\w\.json", f))
            tours.append({"path": f"{city}/{tid}", "id": t["id"], "city": t["city"], "title": t["title"], "subtitle": t.get("subtitle", ""),
                          "mode": t["mode"], "distance_km": t.get("distance_km"), "duration_min": t.get("duration_min"),
                          "stops": len(t["stops"]), "start": [t["stops"][0]["lat"], t["stops"][0]["lng"]] if t["stops"] and "lat" in t["stops"][0] else None,
                          "ready": bool(t.get("route")), "langs": langs, "order": t.get("order", 99)})
    tours.sort(key=lambda x: (x["city"], x["order"], x["title"]))
    out = {"tours": tours}
    with open(os.path.join(base, "index.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"catalogue: {len(tours)} tours, {sum(t['ready'] for t in tours)} ready")


# ---------- main ----------
def resolve(path):
    for p in (path, os.path.join(APP, path)):
        if os.path.exists(os.path.join(p, "tour.json")):
            return os.path.abspath(p)
    sys.exit(f"no tour.json in {path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tour", nargs="?")
    ap.add_argument("--reroute", action="store_true", help="ask OSRM again instead of using .osrm.json")
    ap.add_argument("--osrm-file", help="use this saved OSRM reply")
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--all-audio", action="store_true", help="rebuild every clip")
    ap.add_argument("--lang", default="en", help="voice tour.<lang>.json instead")
    ap.add_argument("--strict", action="store_true", help="content problems stop the build")
    ap.add_argument("--catalogue", action="store_true", help="only rebuild tours/index.json")
    ap.add_argument("--check", action="store_true", help="only check the content; no routing, no audio, nothing written")
    a = ap.parse_args()
    if a.catalogue or not a.tour:
        build_catalogue(APP)
        return
    root = resolve(a.tour)
    fname = "tour.json" if a.lang == "en" else f"tour.{a.lang}.json"
    path = os.path.join(root, fname)
    tour = json.load(open(path, encoding="utf-8"))
    print(f"{tour.get('title', tour.get('id'))} ({a.lang})")
    problems = []
    if a.check:
        check(tour, problems)
        for s in tour["stops"]:
            print(f"  {s['id']}: {words(s['script'])} words")
        print(f"  intro {words(tour['intro']['script'])}, outro {words(tour['outro']['script'])} words")
        for p in problems:
            print("  CHECK:", p)
        sys.exit(1 if problems else 0)
    if a.lang == "en":
        cache = os.path.join(root, ".osrm.json")
        if tour.get("keep_route") and tour.get("route") and not a.reroute:
            print("  keeping the existing route (keep_route)")
            km = sum(dist(a, b) for a, b in zip(tour["route"], tour["route"][1:])) / 1000
            tour["distance_km"] = round(km, 1)
            tour["ride_min"] = round(km / (4.5 if tour["mode"] == "walk" else 14) * 60)
        else:
            src = a.osrm_file or (cache if os.path.exists(cache) and not a.reroute else None)
            osrm = json.load(open(src)) if src else fetch_route(tour, cache)
            apply_route(tour, osrm, problems)
        check(tour, problems)
    fill_texts(tour, a.lang)
    if not a.no_audio:
        build_audio(tour, root, a.all_audio, a.lang)
    if a.lang == "en":
        durations(tour)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(tour, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"  {tour.get('distance_km')} km, ride {tour.get('ride_min')} min, tour about {tour.get('duration_min')} min, {len(tour['stops'])} stops")
    for p in problems:
        print("  CHECK:", p)
    build_catalogue(APP)
    if problems and a.strict:
        sys.exit(1)


if __name__ == "__main__":
    main()
