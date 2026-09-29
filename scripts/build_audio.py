#!/usr/bin/env python3
"""Build the spoken audio for a tour from the texts in its JSON file.

Usage (from the repo root):
    pip install edge-tts
    python scripts/build_audio.py                  # add missing clips only
    python scripts/build_audio.py --all            # rebuild every clip, stories included
    python scripts/build_audio.py --texts-only     # only (re)derive prompt texts, no audio

What it produces, next to the tour's index.html:
    audio/stories/<id>-<md5 of mp3, 8 hex>.mp3   intro, outro and one story per stop
    audio/nav/<md5 of text, 10 hex>.mp3          every spoken direction

Spoken directions:
    nav[leg][step].text / .clip          at-turn prompt (existing)
    nav[leg][step].pre.text / .clip      "In 150 metres, ..." pre-announcement (steps after the first)
    turnaround.text / .clip              "Turn around" prompt for off-route recovery
    offroute                             clip id of the off-route warning (text unknown, never rebuilt)

The voice is taken from the tour JSON ("voice"), default en-GB-RyanNeural.
User-facing text must not contain em dashes; the script refuses to voice any that do.
"""
import argparse
import asyncio
import hashlib
import json
import os
import re
import sys

PRE_DISTANCE = 150  # metres, must match PRE_AT in index.html
TURNAROUND_TEXT = "Turn around when it is safe, then ride back to the route."


def clip_id(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:10]


def pre_text(text):
    """'Turn left onto X.' -> 'In 150 metres, turn left onto X.'"""
    text = text.replace("Directions to the next stop. ", "")
    return f"In {PRE_DISTANCE} metres, {text[0].lower()}{text[1:]}"


def mp3_duration(path):
    """Seconds of MPEG layer III audio, found by walking every frame (works for VBR too)."""
    data = open(path, "rb").read()
    i = 0
    if data[:3] == b"ID3":
        i = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    rates1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    rates2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    srates = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    seconds = 0.0
    while i + 4 <= len(data):
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1  # skip junk between frames
            continue
        version, bri, sri = (data[i + 1] >> 3) & 3, data[i + 2] >> 4, (data[i + 2] >> 2) & 3
        if version == 1 or bri in (0, 15) or sri == 3:
            i += 1
            continue
        mpeg1 = version == 3
        kbps, sr, pad = (rates1 if mpeg1 else rates2)[bri], srates[version][sri], (data[i + 2] >> 1) & 1
        i += (144 if mpeg1 else 72) * kbps * 1000 // sr + pad
        seconds += (1152 if mpeg1 else 576) / sr
    return round(seconds, 1)


async def speak(text, voice, path):
    import edge_tts  # imported late so --texts-only works without it
    tmp = path + ".part"
    await edge_tts.Communicate(text, voice).save(tmp)
    if os.path.getsize(tmp) == 0:
        raise RuntimeError(f"edge-tts returned no audio for: {text[:60]}")
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tour", default="berlin-divided", help="folder with index.html and data/<tour>.json")
    ap.add_argument("--all", action="store_true", help="rebuild every clip, not only missing ones")
    ap.add_argument("--texts-only", action="store_true", help="derive prompt texts without generating audio")
    args = ap.parse_args()

    root = args.tour
    json_path = os.path.join(root, "data", os.path.basename(os.path.normpath(root)) + ".json")
    tour = json.load(open(json_path, encoding="utf-8"))
    voice = tour.get("voice", "en-GB-RyanNeural")

    # 1. derive texts for the prompts that are built from other texts
    for leg in tour["nav"]:
        for j, step in enumerate(leg):
            if j == 0:
                continue  # the first step is spoken as the leg starts, no pre-announcement
            text = pre_text(step["text"])
            if step.get("pre", {}).get("text") != text:
                step["pre"] = {"text": text}
    if tour.get("turnaround", {}).get("text") != TURNAROUND_TEXT:
        tour["turnaround"] = {"text": TURNAROUND_TEXT}

    # 2. everything that is spoken
    nav_items = [s for leg in tour["nav"] for s in leg]
    nav_items += [s["pre"] for leg in tour["nav"] for s in leg if "pre" in s]
    nav_items.append(tour["turnaround"])
    stories = [tour["intro"], tour["outro"], *tour["stops"]]

    for item in nav_items + stories:
        if "—" in item["text"]:
            sys.exit(f"Em dash in text, rewrite it first: {item['text'][:80]}")

    jobs = []
    for item in nav_items:
        cid = clip_id(item["text"])
        rel = f"audio/nav/{cid}.mp3"
        have = os.path.exists(os.path.join(root, rel))
        if have and not args.all:
            item["clip"] = cid
            tour["clips"][cid] = rel
        else:
            jobs.append(("nav", item, cid, rel))
    for t in stories:
        have = t.get("audio") and os.path.exists(os.path.join(root, t["audio"]))
        if args.all or not have:
            jobs.append(("story", t, None, None))

    if args.texts_only:
        print(f"{len(jobs)} clips still need audio; run without --texts-only to generate them.")
    else:
        os.makedirs(os.path.join(root, "audio", "nav"), exist_ok=True)
        os.makedirs(os.path.join(root, "audio", "stories"), exist_ok=True)

        async def run():
            for n, (kind, item, cid, rel) in enumerate(jobs, 1):
                print(f"[{n}/{len(jobs)}] {item['text'][:70]}")
                if kind == "nav":
                    await speak(item["text"], voice, os.path.join(root, rel))
                    item["clip"] = cid
                    tour["clips"][cid] = rel
                else:
                    tmp = os.path.join(root, "audio", "stories", f"{item['id']}.mp3")
                    await speak(item["text"], voice, tmp)
                    digest = hashlib.md5(open(tmp, "rb").read()).hexdigest()[:8]
                    rel = f"audio/stories/{item['id']}-{digest}.mp3"
                    old = item.get("audio")
                    os.replace(tmp, os.path.join(root, rel))
                    if old and old != rel and os.path.exists(os.path.join(root, old)):
                        os.remove(os.path.join(root, old))
                    item["audio"] = rel
                    item["dur"] = mp3_duration(os.path.join(root, rel))

        asyncio.run(run())

        # drop nav clips nothing refers to any more
        used = {tour["offroute"]} | {i["clip"] for i in nav_items if "clip" in i}
        for cid in list(tour["clips"]):
            if cid not in used:
                path = os.path.join(root, tour["clips"].pop(cid))
                if os.path.exists(path):
                    os.remove(path)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(tour, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Wrote {json_path}")


if __name__ == "__main__":
    main()
