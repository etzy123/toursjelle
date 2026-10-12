# De app in Google Play zetten

De Android-app is een Trusted Web Activity (TWA): een kleine app die de tour-site in Chrome opent,
volledig scherm, zonder adresbalk. Elke update van de site is dus meteen in de app, zonder nieuwe
versie in de Play Store. Het bouwen gebeurt in GitHub Actions (workflow "Android app").

## 1. Ontwikkelaarsaccount

1. Ga naar https://play.google.com/console en maak een account (eenmalig 25 dollar).
2. Kies "persoonlijk" of "organisatie". Met een organisatie (KvK-nummer en D-U-N-S-nummer, gratis aan te vragen)
   hoef je niet de verplichte testperiode te doen.
3. Een **nieuw persoonlijk account** moet eerst een gesloten test draaien: minstens 12 testers, 14 dagen
   achter elkaar ingeschreven. Pas daarna kun je "Productie" aanvragen.

## 2. De uploadsleutel (eenmalig)

Op je eigen computer (Java nodig, of Android Studio):

```
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Bewaar `upload.jks` en het wachtwoord goed (bijvoorbeeld in een wachtwoordmanager). Zet daarna in GitHub,
onder Settings > Secrets and variables > Actions, deze vier secrets:

| Secret | Waarde |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | de uitvoer van `base64 -w0 upload.jks` (macOS: `base64 -i upload.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | het wachtwoord van de keystore |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | het wachtwoord van de sleutel (meestal hetzelfde) |

Start dan in het tabblad Actions de workflow **Android app** ("Run workflow"). Onder Artifacts staat
`audio-tours-play-release` met `app-release.aab`: dat bestand upload je naar Play.

## 3. App aanmaken in de Play Console

1. "App maken": naam **Audio Tours** (of je eigen naam), standaardtaal Nederlands of Engels, App, Gratis.
2. Testen > Gesloten test (of Interne test om zelf eerst te proberen) > Nieuwe release > upload `app-release.aab`.
   Accepteer **Play App Signing** (Google bewaart de echte ondertekeningssleutel).

## 4. Koppeling app en site (geen adresbalk)

Zonder deze stap toont Chrome bovenin een adresbalk.

1. Play Console > je app > Testen en releasen > App-integriteit > App-ondertekening.
2. Kopieer de **SHA-256** van de "app signing key" (die van Google) en ook die van de "upload key".
3. Zet in Railway bij de service de variabele
   `ANDROID_CERT_SHA256` = beide waarden, met een komma ertussen.
4. Controleer: `https://toursjelle123-production.up.railway.app/.well-known/assetlinks.json` toont nu je app.

## 5. Wat Play verder vraagt (App-content)

- **Privacybeleid**: `https://toursjelle123-production.up.railway.app/privacy.html`
- **Advertenties**: nee.
- **App-toegang**: alles werkt zonder inloggen.
- **Contentclassificatie**: vul de vragenlijst in (categorie "Referentie, nieuws of educatief"); geen geweld
  als spel, wel historische verhalen over oorlog. Uitkomst is meestal PEGI 3 of 7.
- **Doelgroep**: 13 jaar en ouder.
- **Gegevensveiligheid** (Data safety):
  - Locatie, nauwkeurig: verzameld, niet gedeeld, niet verplicht voor het hele gebruik, doel "App-functionaliteit".
    Alleen bij "Maak een tour" en "Samen fietsen" gaat de positie naar de server.
  - Naam (bij samen fietsen): optioneel, app-functionaliteit, wordt niet bewaard.
  - Berichten in de app (vraag aan de gids): app-functionaliteit, wordt niet bewaard.
  - Versleuteld onderweg: ja. Gegevens laten verwijderen: niet nodig, er is geen account.
- **Doel-API**: de app bouwt al met API 36, zoals Play nu eist.
- **Categorie**: Reizen en lokaal.

## 6. Winkelvermelding

Afbeeldingen maakt de workflow **Store screenshots** (tabblad Actions). Die zet ze op de branch
`store-assets`: per taal vijf telefoonschermen (1080 x 1920), `feature-graphic.png` (1024 x 500)
en `icon-512.png`.

### Nederlands

**Titel** (max 30): Audio Tours: stad op het oor

**Korte beschrijving** (max 80): Audiotours te voet of op de fiets, gemaakt voor de plek waar je nu staat.

**Volledige beschrijving**:

> Loop of fiets door de stad en hoor het verhaal precies op de plek waar het gebeurde.
>
> - **Maak een tour waar je staat.** Kies hoe lang, te voet of op de fiets en waar je van houdt. De app
>   zoekt de interessantste plekken in de buurt, schrijft de verhalen en spreekt ze in.
> - **Vraag het de gids.** Stel bij elke stop een vraag, getypt of ingesproken, en krijg meteen een
>   gesproken antwoord.
> - **Samen fietsen.** Maak een groep, deel de code, en iedereen hoort hetzelfde verhaal tegelijk en
>   ziet elkaar op de kaart.
> - **Navigatie met stem.** Afslag voor afslag, ook op de fiets, met een 3D-kaart die met je meedraait.
> - **Werkt offline.** Download een tour vooraf en gebruik geen mobiele data onderweg.
> - **Zorgvuldige tours** in Amsterdam en Berlijn, met bronnen bij elk verhaal.
> - In het Nederlands, Engels en Duits. Geen account, geen advertenties, geen tracking.

### English

**Title**: Audio Tours: hear the city

**Short description**: Audio tours on foot or by bike, made for exactly where you are standing.

**Full description**:

> Walk or ride through the city and hear the story right where it happened.
>
> - **Make a tour right here.** Choose how long, on foot or by bike, and what you like. The app finds the
>   most interesting places nearby, writes their stories and records them.
> - **Ask the guide.** At any stop, type or say a question and hear the answer straight away.
> - **Ride together.** Start a group, share the code, and everyone hears the same story at the same moment
>   and sees each other on the map.
> - **Voice navigation.** Turn by turn, on foot or by bike, on a 3D map that turns with you.
> - **Works offline.** Download a tour beforehand and use no mobile data on the way.
> - **Carefully made tours** in Amsterdam and Berlin, with sources for every story.
> - In English, Dutch and German. No account, no ads, no tracking.

## 7. Updates

Een nieuwe versie van de app is alleen nodig als iets in `android/` verandert. Draai dan de workflow
opnieuw (het versienummer telt vanzelf op) en upload de nieuwe `.aab`. Veranderingen aan de site
zelf staan direct in de app.
