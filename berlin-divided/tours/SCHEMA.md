# Tour files

Each tour lives in `tours/<city>/<tour-id>/`:

```
tour.json          the tour: written by hand, completed by scripts/build_tour.py
tour.nl.json       optional translation (same shape, no geometry)
audio/stories/     intro, outro, one story per stop, "tell me more" and bonus stories
audio/nav/         spoken directions (file name: first 10 hex of md5 of the spoken text)
<lang>/audio/...   voiced translations
photos/            then and now photos (scripts/add_photos.py)
.osrm.json         the cached OSRM reply, so rebuilds work offline
```

`tours/index.json` is the catalogue the app loads. It is generated: never edit it by hand.

## Build

```
python scripts/build_tour.py tours/amsterdam/golden-age     # route, checks, directions, voice
python scripts/build_tour.py tours/amsterdam/golden-age --no-audio --strict
python scripts/build_tour.py tours/berlin/divided --lang nl # voice a translation
python scripts/build_tour.py --catalogue                    # only tours/index.json
python -m unittest scripts/test_build_tour.py               # tests, no network needed
```

Routing needs `routing.openstreetmap.de`, voice needs `speech.platform.bing.com` (edge-tts).
A tour without a `route` is listed as "Coming soon".

## Fields written by hand

| field | meaning |
|---|---|
| `id` | the folder name |
| `city` | the city folder name (`amsterdam`); the app shows its name from `strings.js` (`city_<city>`) |
| `title`, `subtitle` | shown in the catalogue |
| `mode` | `bike` or `walk`: OSRM profile, trigger radii and speeds in the app |
| `order` | position within the city |
| `voice` | edge-tts voice, default `en-GB-RyanNeural` |
| `intro`, `outro` | `{id, title, script}`; about 120 and 80 words |
| `stops[]` | `{id, title, short, lat, lng, script, sources[], via[[lat,lng]]?, more?{script}, photo?}` |
| `bonus[]` | optional detours: a stop plus `after` (stop id), `detour` (metres), `hint` |
| `sources[]` | sources for the tour as a whole |
| `keep_route` | true: never re-route (Berlin, whose route predates this script) |

Stories are 250 to 320 words, end with a one-sentence pointer to the next stop that matches
the route, use no em dashes, and only state facts that are in the listed sources. Anything that
still needs checking goes in `tours/FACTCHECK.md`.

`via` points pull the route through a street before the stop they belong to. A stop more than
20 m from the route is moved onto it; one more than 150 m away stops the build.

## Fields the build fills in

| field | meaning |
|---|---|
| `route` | `[[lat, lng], ...]` from OSRM |
| `legs[]` | one per stop-to-stop leg: `{distance, steps[{lat, lng, text, clip, pre?{text, clip}}]}` |
| `distance_km`, `ride_min` | from OSRM |
| `duration_min` | ride time × 1.2 + story time + 2 minutes per stop |
| `audio`, `dur` | on intro, outro, stops, `more` and bonus stops |
| `turnaround`, `offroute` | `{text, clip}` spoken when riding the wrong way or off the route |

Directions: "arrive" and straight "new name"/"continue" steps are dropped, maneuvers less than
30 m apart are spoken together ("Turn left, then turn right onto X"), a next maneuver more than
450 m away adds "and stay on it for about N metres", and each leg starts with "Directions to the
next stop.". A pre-announcement ("In 150 metres, ...") is made for every step after the first.

## Translations

`tour.<lang>.json` has `id`, `lang`, `voice`, `navIntro`, optional `title` and `subtitle`, and
`intro`, `outro`, `stops[]`, `bonus[]` (matched by `id`, with `title`, `short`, `script`, `more`),
`legs[].steps[]` (by position: `text`, `pre`), `turnaround` and `offroute`. Without recorded
audio, the phone's own voice reads it. A language without a translation shows the interface in
that language and the tour in English.
