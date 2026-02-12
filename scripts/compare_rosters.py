#!/usr/bin/env python3
"""Compare bonspiel rosters against league rosters to find 3+ member overlaps."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

def norm(n):
    """Normalize a name for fuzzy matching."""
    return n.strip().lower().replace("-", " ").replace("  ", " ")

def main():
    with open(DATA / "rosters_full.json") as f:
        bonspiel = json.load(f)
    with open(DATA / "poole_team_data.json") as f:
        league = json.load(f)

    # Build bonspiel rosters: skip + members
    bonspiel_teams = []
    for div in ["mens", "womens"]:
        for t in bonspiel[div]:
            people = set()
            people.add(norm(t["skip"]))
            for m in t.get("members", []):
                people.add(norm(m))
            bonspiel_teams.append({
                "id": t["id"], "name": t["name"],
                "skip": t["skip"], "div": div, "people": people
            })

    # Build league rosters (combine all nights)
    league_rosters = league.get("all_team_rosters", {})
    league_teams = []
    for team_name, leagues_dict in league_rosters.items():
        people = set()
        nights = []
        for league_name, players in leagues_dict.items():
            nights.append(league_name)
            for p in players:
                people.add(norm(p))
        league_teams.append({"name": team_name, "nights": nights, "people": people})

    # Compare
    matches = []
    for bt in bonspiel_teams:
        for lt in league_teams:
            overlap = bt["people"] & lt["people"]
            if len(overlap) >= 3:
                matches.append({
                    "bonspiel": f"{bt['name']} ({bt['skip']}) [{bt['div']}]",
                    "bonspiel_id": bt["id"],
                    "league": lt["name"],
                    "league_nights": lt["nights"],
                    "count": len(overlap),
                    "people": sorted(overlap),
                })

    matches.sort(key=lambda x: (-x["count"], x["bonspiel"]))

    print(f"Found {len(matches)} bonspiel↔league pairs with 3+ overlapping members:\n")
    for m in matches:
        nights = ", ".join(m["league_nights"])
        print(f"  {m['bonspiel']:45s} <-> {m['league']} ({nights})  [{m['count']} people]")
        for p in m["people"]:
            print(f"      - {p}")
        print()

if __name__ == "__main__":
    main()
