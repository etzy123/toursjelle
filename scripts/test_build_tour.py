"""Tests for build_tour.py that need no network: python -m unittest scripts/test_build_tour.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_tour as b  # noqa: E402

LAT = 52.37  # a test street running east from (52.37, 4.89); 1e-5 degrees of longitude is about 0.68 m here


def east(m):
    return 4.89 + m / 67_900


def step(t, m, dist, name="", mod=None, **extra):
    man = {"type": t, "location": [east(m), LAT], **extra}
    if mod:
        man["modifier"] = mod
    return {"maneuver": man, "name": name, "distance": dist}


def osrm(legs, stops):
    """A reply shaped like OSRM's: the route runs straight east along LAT."""
    total = sum(sum(s["distance"] for s in leg) for leg in legs)
    coords = [[east(m), LAT] for m in range(0, int(total) + 1, 10)]
    return {"code": "Ok", "routes": [{"distance": total, "duration": total / 4,
                                      "geometry": {"coordinates": coords},
                                      "legs": [{"distance": sum(s["distance"] for s in leg), "steps": leg} for leg in legs]}],
            "waypoints": [{"distance": d} for d in stops]}


class Directions(unittest.TestCase):
    def test_drops_arrive_and_straight_new_name(self):
        leg = [step("depart", 0, 100, "Damrak", bearing_after=90), step("new name", 100, 100, "Rokin", "straight"),
               step("turn", 200, 100, "Spui", "left"), step("arrive", 300, 0)]
        texts = [s["text"] for s in b.leg_directions([{"distance": 300, "steps": leg}])]
        self.assertEqual(texts, ["Directions to the next stop. Head east on Damrak.", "Turn left onto Spui."])

    def test_merges_close_maneuvers(self):
        leg = [step("depart", 0, 200, bearing_after=0), step("turn", 200, 20, "", "left"),
               step("turn", 220, 100, "Herengracht", "right"), step("arrive", 320, 0)]
        steps = b.leg_directions([{"distance": 320, "steps": leg}])
        self.assertEqual(steps[1]["text"], "Turn left, then turn right onto Herengracht.")
        self.assertAlmostEqual(steps[1]["lng"], round(east(200), 6))

    def test_stay_on_for_long_stretches(self):
        leg = [step("depart", 0, 100, bearing_after=180), step("turn", 100, 1700, "Prinsengracht", "right"),
               step("turn", 1800, 600, "Leidsestraat", "slight left"), step("arrive", 2400, 0)]
        t = [s["text"] for s in b.leg_directions([{"distance": 2400, "steps": leg}])]
        self.assertEqual(t[1], "Turn right onto Prinsengracht, and stay on it for about 1.7 kilometres.")
        self.assertEqual(t[2], "Bear left onto Leidsestraat, and stay on it for about 600 metres.")

    def test_via_point_depart_is_not_spoken(self):
        a = [step("depart", 0, 100, bearing_after=90), step("arrive", 100, 0)]
        c = [step("depart", 100, 100, bearing_after=90), step("turn", 200, 100, "Spui", "right"), step("arrive", 300, 0)]
        t = [s["text"] for s in b.leg_directions([{"distance": 100, "steps": a}, {"distance": 200, "steps": c}])]
        self.assertEqual(t, ["Directions to the next stop. Head east.", "Turn right onto Spui."])

    def test_ferry(self):
        leg = [step("depart", 0, 100, bearing_after=0, ), step("notification", 100, 1000, "NDSM", "straight"),
               step("notification", 1100, 100, "", "straight"), step("turn", 1200, 100, "TT Neveritaweg", "left"), step("arrive", 1300, 0)]
        for s_, m in zip(leg, ["cycling", "ferry", "cycling", "cycling", "cycling"]):
            s_["mode"] = m
        t = [s["text"] for s in b.leg_directions([{"distance": 1300, "steps": leg}])]
        self.assertEqual(t[1], "Take the ferry. The crossing is about 1 kilometre.")
        self.assertEqual(t[2], "Turn left onto TT Neveritaweg.")

    def test_ferry_by_name(self):
        leg = [step("depart", 0, 100, bearing_after=0), step("turn", 100, 2400, "NDSM-werfveer", "straight"),
               step("turn", 2500, 100, "NDSM-kade", "right"), step("arrive", 2600, 0)]
        t = [s["text"] for s in b.leg_directions([{"distance": 2600, "steps": leg}])]
        self.assertEqual(t[1:], ["Take the ferry. The crossing is about 2.4 kilometres.", "Turn right onto NDSM-kade."])
        self.assertEqual(b.maneuver_text(step("turn", 0, 0, "Warmoesstraat", "straight")), "Continue onto Warmoesstraat")

    def test_roundabout_and_about(self):
        s = step("roundabout", 0, 0, "Weteringcircuit", "right", exit=2)
        self.assertEqual(b.maneuver_text(s), "At the roundabout, take the second exit onto Weteringcircuit")
        self.assertEqual(b.about(960), "about 1 kilometre")
        self.assertEqual(b.about(640), "about 600 metres")

    def test_spoken_text_and_pre(self):
        self.assertEqual(b.spoken("Turn left onto Straße"), "Turn left onto Strasse")
        self.assertEqual(b.clip_id("Straße"), b.clip_id("Strasse"))
        self.assertEqual(b.pre_text("Directions to the next stop. Turn left."), "In 150 metres, turn left.")


class Routing(unittest.TestCase):
    def tour(self):
        return {"id": "t", "mode": "bike", "stops": [
            {"id": "a", "lat": LAT, "lng": east(0)},
            {"id": "b", "lat": LAT + 0.0004, "lng": east(500)},  # about 44 m north of the street
            {"id": "c", "lat": LAT, "lng": east(1000), "via": [[LAT, east(800)]]}]}

    def legs(self):
        return [[step("depart", 0, 500, bearing_after=90), step("arrive", 500, 0)],
                [step("depart", 500, 300, bearing_after=90), step("arrive", 800, 0)],
                [step("depart", 800, 100, bearing_after=90), step("turn", 900, 100, "Spui", "left"), step("arrive", 1000, 0)]]

    def test_snaps_stops_and_splits_legs_at_stops(self):
        t, problems = self.tour(), []
        b.apply_route(t, osrm(self.legs(), [0, 44, 0, 0]), problems)
        self.assertEqual(problems, [])
        self.assertAlmostEqual(t["stops"][1]["lat"], LAT, places=5)  # moved onto the route
        self.assertEqual(len(t["legs"]), 2)                          # a via point does not start a leg
        self.assertEqual(t["legs"][1]["distance"], 500)
        self.assertEqual([s["text"] for s in t["legs"][1]["steps"]], ["Directions to the next stop. Head east.", "Turn left onto Spui."])
        self.assertEqual(t["distance_km"], 1.0)

    def test_far_stop_needs_a_via_point(self):
        t, problems = self.tour(), []
        b.apply_route(t, osrm(self.legs(), [0, 400, 0, 0]), problems)
        self.assertIn("add a via point", problems[0])

    def test_waypoints_order(self):
        self.assertEqual([k for k, _ in b.waypoints(self.tour())], ["stop", "stop", "via", "stop"])


class Checks(unittest.TestCase):
    def test_word_counts_sources_and_dashes(self):
        w = lambda n: " ".join(["word"] * n)
        t = {"intro": {"script": w(120)}, "outro": {"script": w(80)},
             "stops": [{"id": "a", "script": w(280), "sources": ["x"]}, {"id": "b", "script": w(200) + " —"}]}
        problems = []
        b.check(t, problems)
        self.assertEqual(problems, ["stop b: 200 words (want 250-320)", "stop b: no sources", "contains an em dash"])

    def test_fill_texts(self):
        t = {"mode": "walk", "legs": [{"steps": [{"text": "Directions to the next stop. Head north."}, {"text": "Turn left."}]}]}
        b.fill_texts(t)
        self.assertNotIn("pre", t["legs"][0]["steps"][0])
        self.assertEqual(t["legs"][0]["steps"][1]["pre"]["text"], "In 150 metres, turn left.")
        self.assertIn("walk back", t["turnaround"]["text"])


class Catalogue(unittest.TestCase):
    def test_lists_every_tour(self):
        app = tempfile.mkdtemp()
        try:
            for city, tid, route in (("amsterdam", "war", None), ("amsterdam", "golden-age", [[1, 2]]), ("berlin", "divided", [[1, 2]])):
                os.makedirs(os.path.join(app, "tours", city, tid))
                json.dump({"id": tid, "city": city, "title": tid.title(), "mode": "walk", "order": 2 if tid == "war" else 1,
                           "stops": [{}], "route": route}, open(os.path.join(app, "tours", city, tid, "tour.json"), "w"))
            open(os.path.join(app, "tours", "berlin", "divided", "tour.nl.json"), "w").write("{}")
            b.build_catalogue(app)
            cat = json.load(open(os.path.join(app, "tours", "index.json")))["tours"]
            self.assertEqual([t["path"] for t in cat], ["amsterdam/golden-age", "amsterdam/war", "berlin/divided"])
            self.assertEqual([t["ready"] for t in cat], [True, False, True])
            self.assertEqual(cat[2]["langs"], ["nl"])
        finally:
            shutil.rmtree(app)


class Audio(unittest.TestCase):
    def test_reencode_to_mono_22k_32k(self):
        src = os.path.join(b.APP, "tours", "berlin", "divided", "audio", "nav")
        clip = os.path.join(src, sorted(os.listdir(src))[0])
        out = os.path.join(tempfile.mkdtemp(), "x.mp3")
        subprocess.run([b.ffmpeg_exe(), "-y", "-loglevel", "error", "-i", clip, "-ac", "1", "-ar", "22050", "-b:a", "32k", out], check=True)
        data = open(out, "rb").read()
        i = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
        self.assertEqual(data[i:i + 2], b"\xff\xf3")         # MPEG-2 layer III: the 22.05 kHz family
        self.assertEqual((data[i + 2] >> 2) & 3, 0)          # 22050 Hz
        self.assertEqual(data[i + 3] >> 6, 3)                # mono
        kbps = len(data) * 8 / b.mp3_duration(out) / 1000   # the first frame is an info frame, so average
        self.assertTrue(28 < kbps < 38, kbps)
        self.assertGreater(b.mp3_duration(out), 0.5)


if __name__ == "__main__":
    unittest.main()
