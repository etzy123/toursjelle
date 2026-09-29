# Berlin divided: self-guided Cold War bike tour

Static web app. `index.html` holds the app; the tour itself lives in data files:

- `data/berlin-divided.json`: route, stops, turn instructions and paths to audio
- `audio/stories/*.mp3`: intro, outro and one story per stop (loaded on demand)
- `audio/nav/*.mp3`: spoken turn instructions (file name = first 10 hex of md5 of the text)
- `vendor/leaflet/`: Leaflet 1.9.4 (BSD-2-Clause), served locally so the map works offline

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway: New Project > Deploy from GitHub repo > pick the repo. Set Root Directory to `berlin-divided`.
3. Settings > Networking > Generate Domain.
4. Open the https URL on your phone. Location access needs https, which Railway provides.
