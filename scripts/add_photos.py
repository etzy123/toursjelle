#!/usr/bin/env python3
"""Add "then and now" photos from Wikimedia Commons to a tour, with licence checks.

Usage (from the repo root, needs internet access to commons.wikimedia.org):
    python scripts/add_photos.py                                       # Berlin, scripts/photos.json
    python scripts/add_photos.py --tour berlin-divided/tours/berlin/divided --dry-run  # only check licences

scripts/photos.json lists one candidate per stop:
    [{"stop": "charlie", "file": "File:....jpg", "caption": "American tanks at Checkpoint Charlie"}]

For each candidate the script asks the Commons API for the file's licence, author, date and
source, and only accepts public domain, CC0, CC BY and CC BY-SA. Anything else (NC, ND, GFDL,
fair use, unknown) is rejected and reported. Accepted images are downloaded at 1024 px wide into
<tour folder>/photos/ (served by the app, cached for offline use) and written to the stop's "photo" field
together with everything needed for attribution. Nothing is hotlinked.
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia asks for a descriptive user agent with a way to reach the maintainer
UA = "audio-tours/1.0 (https://github.com/etzy123/toursjelle) python-urllib"
ALLOWED = re.compile(r"^(public domain|pd(-[\w.-]+)?|cc0( 1\.0)?|cc[ -]by(-sa)?[ -]\d\.\d( [a-z]{2,})?)$", re.I)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def text(meta, key):
    raw = (meta.get(key) or {}).get("value", "")
    return html.unescape(re.sub(r"<[^>]+>", "", str(raw))).strip()


def lookup(file_title):
    q = urllib.parse.urlencode({
        "action": "query", "format": "json", "formatversion": 2, "titles": file_title,
        "prop": "imageinfo", "iiprop": "url|extmetadata|mime", "iiurlwidth": 1024,
    })
    page = json.loads(get(f"{API}?{q}"))["query"]["pages"][0]
    if page.get("missing"):
        raise LookupError("file not found on Commons")
    info = page["imageinfo"][0]
    meta = info.get("extmetadata", {})
    return {
        "licence": text(meta, "LicenseShortName"),
        "licenceUrl": text(meta, "LicenseUrl"),
        "author": text(meta, "Artist") or text(meta, "Credit"),
        "credit": text(meta, "Credit"),
        "date": text(meta, "DateTimeOriginal"),
        "restrictions": text(meta, "Restrictions"),
        "source": info["descriptionurl"],
        "thumb": info.get("thumburl") or info["url"],
        "mime": info.get("mime", ""),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tour", default="berlin-divided/tours/berlin/divided", help="the tour folder")
    ap.add_argument("--list", default="scripts/photos.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = args.tour
    json_path = os.path.join(root, "tour.json")
    tour = json.load(open(json_path, encoding="utf-8"))
    places = {s["id"]: s for s in tour["stops"] + tour.get("bonus", [])}
    wanted = json.load(open(args.list, encoding="utf-8"))
    os.makedirs(os.path.join(root, "photos"), exist_ok=True)

    ok, bad = 0, 0
    for c in wanted:
        place = places.get(c["stop"])
        if not place:
            print(f"  skip  {c['stop']}: no such stop")
            bad += 1
            continue
        try:
            info = lookup(c["file"])
        except Exception as e:  # network, missing file, unexpected API shape
            print(f"  FAIL  {c['stop']}: {c['file']}: {e}")
            bad += 1
            continue
        if not ALLOWED.match(info["licence"]) or not info["mime"].startswith("image/"):
            print(f"  REJECT {c['stop']}: {c['file']}: licence '{info['licence'] or 'unknown'}'")
            bad += 1
            continue
        year = (re.search(r"\b(18|19|20)\d\d\b", info["date"]) or [None])[0]
        print(f"  ok    {c['stop']}: {info['licence']}, {info['author'][:60]}, {year or 'no date'}"
              + (f"  (note: {info['restrictions']})" if info["restrictions"] else ""))
        ok += 1
        if args.dry_run:
            continue
        data = get(info["thumb"])
        ext = ".png" if info["mime"] == "image/png" else ".jpg"
        rel = f"photos/{c['stop']}-{hashlib.md5(data).hexdigest()[:8]}{ext}"
        old = (place.get("photo") or {}).get("src")
        if old and old != rel and os.path.exists(os.path.join(root, old)):
            os.remove(os.path.join(root, old))
        open(os.path.join(root, rel), "wb").write(data)
        place["photo"] = {
            "src": rel, "caption": c["caption"], "year": year,
            "author": info["author"], "licence": info["licence"], "licenceUrl": info["licenceUrl"],
            "source": info["source"], "commons": c["file"],
        }

    if not args.dry_run:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(tour, f, ensure_ascii=False, indent=1)
            f.write("\n")
    print(f"{ok} accepted, {bad} rejected or failed")
    sys.exit(1 if bad and not ok else 0)


if __name__ == "__main__":
    main()
