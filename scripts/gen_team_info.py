#!/usr/bin/env python3
"""
Generate team_info.json — pre-computed roster + league data for the info popup.

For each Calcutta team, includes:
  - Calcutta roster (skip + members)
  - League teams the skip plays on, with roster and record
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Nickname mapping for matching
NICKNAME_MAP = {
    "stu": "stuart", "stuart": "stu",
    "rob": "robert", "bob": "robert", "robert": "rob",
    "dave": "david", "david": "dave",
    "mike": "michael", "michael": "mike",
    "bill": "william", "william": "bill",
    "jim": "james", "james": "jim",
    "tom": "thomas", "thomas": "tom",
    "dan": "daniel", "daniel": "dan",
    "greg": "gregory", "gregory": "greg",
}


def name_variants(full_name):
    parts = full_name.strip().lower().split()
    variants = [" ".join(parts)]
    if parts:
        first = parts[0]
        if first in NICKNAME_MAP:
            variants.append(NICKNAME_MAP[first] + " " + " ".join(parts[1:]))
    return variants


def main():
    rosters = json.loads((DATA / "rosters_full.json").read_text())
    ptd = json.loads((DATA / "poole_team_data.json").read_text())

    standings = ptd.get("standings", {})
    all_rosters = ptd.get("all_team_rosters", {})

    # Build player -> [(team_name, league)] index
    player_teams = {}
    for team_name, leagues in all_rosters.items():
        for league, players in leagues.items():
            if league not in ("Monday Night", "Tuesday Night"):
                continue
            for p in players:
                key = p.strip().lower()
                player_teams.setdefault(key, []).append((team_name, league))

    result = {}

    for division in ("mens", "womens"):
        div_info = []
        for entry in rosters.get(division, []):
            tid = entry["id"]
            skip = entry.get("skip", "")
            members = entry.get("members", [])

            # Find league teams for this skip
            skip_key = skip.strip().lower()
            found = player_teams.get(skip_key, [])
            if len(found) <= 1:
                for variant in name_variants(skip):
                    if variant != skip_key:
                        extra = player_teams.get(variant, [])
                        if extra:
                            found = found + extra
                            break

            league_teams = []
            for team_name, league in found:
                lg_short = "Mon" if "Monday" in league else "Tue"
                st = standings.get(league, {}).get(team_name, {})
                roster = all_rosters.get(team_name, {}).get(league, [])
                league_teams.append({
                    "team": team_name,
                    "league": lg_short,
                    "roster": roster,
                    "wins": st.get("wins", 0),
                    "losses": st.get("losses", 0),
                    "ties": st.get("ties", 0),
                })

            div_info.append({
                "id": tid,
                "skip": skip,
                "members": members,
                "leagueTeams": league_teams,
            })

        result[division] = div_info

    out = DATA / "team_info.json"
    out.write_text(json.dumps(result, indent=2))
    print(f"Wrote {out} ({len(result.get('mens', []))} mens, {len(result.get('womens', []))} womens)")


if __name__ == "__main__":
    main()
