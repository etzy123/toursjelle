# Berlin divided: self-guided Cold War bike tour

Web app plus a small Node server (`server.js`) that serves it and runs group rides over a
WebSocket at `/group`. `index.html` holds the app; the tour itself lives in data files:

- `data/berlin-divided.json`: route, stops, turn instructions and paths to audio
- `audio/stories/*.mp3`: intro, outro and one story per stop (loaded on demand)
- `audio/nav/*.mp3`: spoken turn instructions (file name = first 10 hex of md5 of the text)
- `audio/more/*.mp3`: optional "Tell me more" deep dives
- `photos/`: then and now photos with attribution in the JSON (added by `scripts/add_photos.py`)
- `vendor/leaflet/`: Leaflet 1.9.4 (BSD-2-Clause), served locally so the map works offline

Run locally: `npm install && npm start`, then open http://localhost:3000.
Audio and photos are built with the scripts in `../scripts`; tests are in `../tests`.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway: New Project > Deploy from GitHub repo > pick the repo. Set Root Directory to `berlin-divided`.
3. Settings > Networking > Generate Domain.
4. Open the https URL on your phone. Location access needs https, which Railway provides.

Railway runs `npm start` (`node server.js`) and sets `PORT`. Groups are kept in memory, so a
redeploy ends running group rides; riders just start a new group.
