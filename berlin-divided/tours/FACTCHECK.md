# Fact-check list

Things in the tour scripts that a person should check before a tour goes live. Tick them off, or
fix the script and rebuild (`python scripts/build_tour.py tours/<city>/<tour>`).

Everything not listed here is, as far as I know, well established and in the sources on the stop.

## For every Amsterdam tour

- [ ] **Coordinates.** Every stop's lat/lng was written by hand, without a map or geocoder
      (neither was reachable), and is only approximately right. The build moves a stop onto
      the route if it is within 150 m, so check on the map that each stop sits where the
      rider should stop and look, and on the correct side of the canal.
- [ ] **"Now ride/walk to the next stop" sentences.** They were written before the routes
      existed. After the build, check that each one matches the real route (direction, street,
      "a few hundred metres").
- [ ] **Time and distance** in the intros ("about eight kilometres" and so on) against the
      routed `distance_km` and `ride_min`.

## The Golden Age by bike (`amsterdam/golden-age`)

- [ ] dam: the Atlas statue is on the far (west) side of the roof, not visible from the Dam.
- [ ] dam: the Wisselbank (exchange bank) kept its reserves in the city hall cellars.
- [ ] oudekerk: "one of the largest medieval wooden vaults in Europe" (the church's own claim).
- [ ] oudekerk: Sweelinck organist here "for more than forty years", buried here in 1621.
- [ ] schreierstoren: a stone with a weeping woman is on the tower (there is one, dated 1569,
      according to most guides); the name from an old word for a sharp angle.
- [ ] schreierstoren: Hudson's departure plaque is on this tower.
- [ ] scheepvaarthuis: "the faces of Dutch seafarers" on the front, and "six shipping companies".
- [ ] scheepvaarthuis: Houtman's 1595 fleet was four ships, and "most of the crew never came home"
      (usually given as 87 survivors of about 249).
- [ ] wic: the WIC used this building "in its first decades" (usually 1623 to 1647); the statue of
      Peter Stuyvesant stands in the courtyard.
- [ ] wic: tone and numbers of the slavery passage; "hundreds of thousands of people" is
      deliberately general. Consider asking NiNsee or the Amsterdam Museum to review it.
- [ ] wic: Mayor Halsema's apology was on 1 July 2021, the King's on 1 July 2023.
- [ ] westerkerk: Pieter de Keyser completed the church after his father's death.
- [ ] goldenbend: Herengracht 497 is still the cat museum (Kattenkabinet); 502 the mayor's residence.
- [ ] goldenbend: "more than a hundred thousand inhabitants by 1622".
- [ ] rijksmuseum: the 2003 to 2013 plans to close the passage to bikes, and the cyclists' protest.
- [ ] rijksmuseum: two figures lost when The Night Watch was cut in 1715.

## Amsterdam in the war (`amsterdam/war`)

This tour is about persecution and murder. Please have it read by someone from the Anne Frank
House, the Jewish Cultural Quarter or the NIOD before it goes live.

- [ ] annefrank: the family moved from Frankfurt "in the 1930s" (Otto in 1933, the family by early
      1934).
- [ ] annefrank: "It is still not known for certain who betrayed them, or whether anyone did"
      (wording chosen after the disputed 2022 cold case book).
- [ ] homomonument: which triangle points where, and that one steps down to the water, one is level
      and one raised; "one of the first monuments of its kind anywhere in the world".
- [ ] homomonument: the Germans introduced a law against sex between men in the occupied
      Netherlands in 1940 (Verordnung 81/1940).
- [ ] monument: height "about twenty-two metres"; the description of the figures (bound men, a
      mother with her child, doves); the urns with earth from execution sites and one from the
      former Dutch East Indies.
- [ ] monument: the shooting of 7 May 1945 came from a building on the corner of the square
      (the Groote Club); "more than twenty people were killed" (counts vary from 19 to 32).
- [ ] dokwerker: the fights of February 1941 and the defence groups, as described.
- [ ] dokwerker: the 425 men "almost none of them came back" (often: two survived).
- [ ] dokwerker: "one of the very few mass protests against the persecution of Jews anywhere in
      occupied Europe"; the statue "with his sleeves rolled up, facing the square".
- [ ] synagogue: "hundreds of candles" (often given as over a thousand); "Most of this
      congregation was among them".
- [ ] synagogue: about 140,000 Jews in the Netherlands, around 102,000 murdered.
- [ ] schouwburg: "about forty-six thousand people"; "around six hundred children"; the tram and
      the college garden in the rescue; the memorial wall of family names.
- [ ] holocaustmuseum: the museum occupies the former teachers' college (and the crèche); the
      order and dates of the anti-Jewish measures; the Sinti and Roma round-up of May 1944.
- [ ] verzetsmuseum: the register attack: date, "some disguised as police officers", the
      firemen, "twelve of them were executed" on 1 July 1943, and Arondeus's message.

## Rebels and freethinkers (`amsterdam/rebels`)

- [ ] vondelpark: the stop point, near the Vondel statue (the "hippie" part of the park was
      around the lawns further in).
- [ ] vondelpark: Lucifer banned in 1654 after two performances; Paradiso 1968, Melkweg 1970; the
      city tolerating sleepers in the park in the early 1970s.
- [ ] wedding: the coach route, and that the smoke bombs were thrown on the Raadhuisstraat; the
      construction worker's death and riots in June 1966; Van Hall dismissed in 1967.
- [ ] multatuli: the Torensluis is "one of the oldest bridges" and the widest over the Singel.
- [ ] multatuli: statue by Hans Bayens, 1987; Lebak, 1856, the buffaloes; Droogstoppel on the
      Lauriergracht.
- [ ] spui: the Lieverdje paid for by a tobacco company; Grootveld's happenings from 1964 at
      midnight on Saturdays; arrests for handing out raisins.
- [ ] spui: police took the white bicycles away because unlocked bicycles "invited theft".
- [ ] spui: Provo won a council seat in 1966 and dissolved itself in May 1967 in the Vondelpark;
      the Maagdenhuis occupation in May 1969.
- [ ] spinoza: the coat with flowers and birds and a parakeet; the inscription.
- [ ] nieuwmarkt: the plan for a wide road through the area and that it was dropped; the date and
      methods of the clearance (24 March 1975); artworks in the metro station.
- [ ] nieuwmarkt: the ferry to NDSM leaves from behind Centraal Station, takes about 15 minutes and
      takes bikes. Check the route uses it (OSRM bike routing follows ferries).
- [ ] ndsm: NDSM formed in 1946 from two older yards; bankrupt in 1984; a crane turned into a hotel.
