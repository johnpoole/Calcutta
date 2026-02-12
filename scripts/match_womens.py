#!/usr/bin/env python3
"""Match women's league standings to bonspiel team IDs."""
import json, csv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

with open(DATA / "rosters_full.json") as f:
    rosters = json.load(f)
with open(DATA / "women_standings.csv") as f:
    reader = csv.DictReader(f)
    standings = list(reader)

print("Bonspiel teams:")
for t in rosters["womens"]:
    print(f"  {t['id']:12s} skip={t['skip']:20s} members={t.get('members',[])}")

print()
print("League teams:")
for s in standings:
    print(f"  {s['Team']:25s} {s['W']}W-{s['L']}L-{s['T']}T")

# Direct name matches
league_names = {s["Team"].lower(): s for s in standings}
print()
print("Direct matches:")
for t in rosters["womens"]:
    name = t["name"].lower()
    skip_last = t["skip"].split()[-1].lower()
    if name in league_names:
        s = league_names[name]
        print(f"  {t['id']:12s} -> {s['Team']:20s} {s['W']}W-{s['L']}L-{s['T']}T")
    elif skip_last in league_names:
        s = league_names[skip_last]
        print(f"  {t['id']:12s} -> {s['Team']:20s} {s['W']}W-{s['L']}L-{s['T']}T (via skip)")
    else:
        print(f"  {t['id']:12s} -> NO MATCH (skip={t['skip']})")
