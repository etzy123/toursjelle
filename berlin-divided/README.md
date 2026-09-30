# Berlin divided: self-guided Cold War bike tour

Web app plus a small Node server (`server.js`) that serves it and runs group rides over a
WebSocket at `/group`. `index.html` holds the app; the tour itself lives in data files:

- `data/berlin-divided.json`: route, stops, turn instructions and paths to audio (English)
- `data/berlin-divided.nl.json`, `data/berlin-divided.de.json`: Dutch and German texts with the same
  shape, minus the geometry; their audio goes to `audio/nl/` and `audio/de/`
  (`python scripts/build_audio.py --lang nl`). Until it is built, the phone's own voice reads them.
- `strings.js`: interface text in English, Dutch and German
- `audio/stories/*.mp3`: intro, outro and one story per stop (loaded on demand)
- `audio/nav/*.mp3`: spoken turn instructions (file name = first 10 hex of md5 of the text)
- `audio/more/*.mp3`: optional "Tell me more" deep dives
- `photos/`: then and now photos with attribution in the JSON (added by `scripts/add_photos.py`)
- `vendor/leaflet/`: Leaflet 1.9.4 (BSD-2-Clause), served locally so the map works offline

Interface: built from the Figma design "Berlin Divided Bike Tour App" (Plus Jakarta Sans, indigo
#584DD3, white cards) with a matching dark palette. Screens: home, tours, tour page, group lobby,
riding, story, tour complete, settings. Street map tiles come from OpenStreetMap (dimmed in dark
mode); a paid tile provider is needed before heavy or commercial use.

App code (html, js, css, json) is served no-cache and fetched network-first by the service worker,
so phones never keep an old interface. After changing strings.js, also bump its ?v= in index.html
and sw.js so copies cached by older versions are skipped.

Run locally: `npm install && npm start`, then open http://localhost:3000.
Audio and photos are built with the scripts in `../scripts`; tests are in `../tests`.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway: New Project > Deploy from GitHub repo > pick the repo. Set Root Directory to `berlin-divided`.
3. Settings > Networking > Generate Domain.
4. Open the https URL on your phone. Location access needs https, which Railway provides.

Railway runs `npm start` (`node server.js`) and sets `PORT`. Groups are kept in memory, so a
redeploy ends running group rides; riders just start a new group.
