#!/usr/bin/env python3
"""
update_standings.py — Update teams_mens.json with league standings
from poole_team_data.json.

Teams that skip on both Monday and Tuesday have their records combined.
Nickname mappings (e.g. "Plaid Lads" → smith, "The Pants" → wilson)
are handled automatically.

Teams that don't skip a league team (lefebvre, bell, richardson,
lessard, feilding) keep wins=0/losses=0 and get default strength
in the odds calculator.

Usage:
    python scripts/update_standings.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# ── Nickname → bonspiel team ID ──────────────────────────
NICKNAME_MAP = {
    "Plaid Lads": "smith",
    "The Pants": "wilson",
}


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  ✓ {path.relative_to(ROOT)}")


def standings_name_to_id(name):
    """Convert a standings team name to a bonspiel team ID."""
    if name in NICKNAME_MAP:
        return NICKNAME_MAP[name]
    return name.lower()


def main():
    print("═" * 60)
    print("  Updating Men's Team Standings from League Data")
    print("═" * 60)

    poole_data = load_json(DATA_DIR / "poole_team_data.json")
    teams = load_json(DATA_DIR / "teams_mens.json")

    standings = poole_data.get("standings", {})
    team_ids = {t["id"] for t in teams}

    # ── Aggregate records across both nights ─────────────
    combined = {}  # bonspiel_id → { wins, losses, ties, nights }
    for league_name, league_teams in standings.items():
        for team_name, record in league_teams.items():
            bid = standings_name_to_id(team_name)
            if bid not in team_ids:
                continue  # not a bonspiel team
            if bid not in combined:
                combined[bid] = {"wins": 0, "losses": 0, "ties": 0, "nights": []}
            combined[bid]["wins"] += record.get("wins", 0)
            combined[bid]["losses"] += record.get("losses", 0)
            combined[bid]["ties"] += record.get("ties", 0)
            combined[bid]["nights"].append(league_name)

    # ── Apply to teams JSON ──────────────────────────────
    updated = 0
    no_data = []
    for t in teams:
        if t["id"] in combined:
            c = combined[t["id"]]
            t["wins"] = c["wins"]
            t["losses"] = c["losses"]
            t["ties"] = c["ties"]
            t["h2h"] = {}  # no h2h data available
            updated += 1
            nights = " + ".join(c["nights"])
            gp = c["wins"] + c["losses"] + c["ties"]
            pct = (c["wins"] + c["ties"] * 0.5) / gp if gp else 0
            print(f"  {t['name']:>12}  {c['wins']:>2}W {c['losses']:>2}L {c['ties']:>1}T  "
                  f"({pct:.3f})  [{nights}]")
        else:
            t["wins"] = 0
            t["losses"] = 0
            t["ties"] = 0
            t["h2h"] = {}
            no_data.append(t["name"])

    print(f"\n  Updated {updated} teams from league standings")
    if no_data:
        print(f"  No league data for: {', '.join(no_data)}")
        print("  (These teams will use default 0.50 strength)")

    save_json(DATA_DIR / "teams_mens.json", teams)

    print(f"\n{'═' * 60}")
    print("  Done!  Next: python scripts/calculate_odds.py")
    print(f"{'═' * 60}\n")


if __name__ == "__main__":
    main()
