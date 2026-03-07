#!/usr/bin/env python3
"""
update_standings.py — Update teams_mens.json and teams_womens.json
from league standings using roster config files.

Men's config:  data/roster_mens.json   (maps bonspiel teams → league sources)
Men's data:    data/poole_team_data.json  (league standings)
Women's config: data/roster_womens.json
Women's data:   data/women_standings.csv

Usage:
    python scripts/update_standings.py
"""

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  ✓ {path.relative_to(ROOT)}")


def update_division(roster_path, standings, out_path):
    """
    Build teams JSON from a roster config + standings dict.

    roster_path: path to roster_<division>.json
    standings:   dict like {"Monday Night": {"TeamName": {wins,losses,ties}, ...}, ...}
    out_path:    path to write teams_<division>.json
    """
    roster = load_json(roster_path)
    teams = []
    errors = []

    for entry in roster:
        tid = entry["id"]
        name = entry["name"]
        seed = entry["seed"]

        # Fixed record (no league source)
        if "record" in entry:
            rec = entry["record"]
            teams.append({
                "id": tid, "name": name, "seed": seed,
                "wins": rec["wins"], "losses": rec["losses"], "ties": rec["ties"],
            })
            gp = rec["wins"] + rec["losses"] + rec["ties"]
            pct = (rec["wins"] + rec["ties"] * 0.5) / gp if gp else 0
            print(f"  {name:>14}  {rec['wins']:>2}W {rec['losses']:>2}L {rec['ties']:>1}T  "
                  f"({pct:.0%})  [fixed]")
            continue

        # Sum W-L-T from all listed sources
        sources = entry.get("sources", [])
        if not sources:
            errors.append(f"{name}: no sources and no fixed record")
            continue

        w, l, t = 0, 0, 0
        source_labels = []
        for src in sources:
            league = src["league"]
            team_name = src["team"]
            league_standings = standings.get(league, {})
            rec = league_standings.get(team_name)
            if rec is None:
                errors.append(f"{name}: '{team_name}' not found in {league} standings")
                continue
            w += rec.get("wins", 0)
            l += rec.get("losses", 0)
            t += rec.get("ties", 0)
            source_labels.append(f"{league[:3]} {team_name}")

        teams.append({
            "id": tid, "name": name, "seed": seed,
            "wins": w, "losses": l, "ties": t,
        })
        gp = w + l + t
        pct = (w + t * 0.5) / gp if gp else 0
        src_str = " + ".join(source_labels)
        mapped = f" ← {src_str}" if source_labels[0].split(" ", 1)[1] != name else f"  [{src_str}]"
        print(f"  {name:>14}  {w:>2}W {l:>2}L {t:>1}T  ({pct:.0%}){mapped}")

    if errors:
        print(f"\n  ERRORS:", file=sys.stderr)
        for e in errors:
            print(f"    {e}", file=sys.stderr)

    save_json(out_path, teams)
    return len(teams), len(errors)


def main():
    # ── Men's ────────────────────────────────────────────
    mens_roster = DATA_DIR / "roster_mens.json"
    if not mens_roster.exists():
        print(f"ERROR: {mens_roster} not found", file=sys.stderr)
        sys.exit(1)

    ptd_path = DATA_DIR / "poole_team_data.json"
    if not ptd_path.exists():
        print(f"ERROR: {ptd_path} not found", file=sys.stderr)
        sys.exit(1)

    print("=" * 60)
    print("  Updating Men's Standings from Roster Config")
    print("=" * 60)

    ptd = load_json(ptd_path)
    standings = ptd.get("standings", {})
    count, errs = update_division(mens_roster, standings, DATA_DIR / "teams_mens.json")
    print(f"\n  {count} teams written, {errs} errors")

    # ── Women's ──────────────────────────────────────────
    womens_roster = DATA_DIR / "roster_womens.json"
    if womens_roster.exists():
        print(f"\n{'=' * 60}")
        print("  Updating Women's Standings from Roster Config")
        print("=" * 60)

        csv_path = DATA_DIR / "women_standings.csv"
        if not csv_path.exists():
            print("  women_standings.csv not found — skipping", file=sys.stderr)
        else:
            # Build standings dict from CSV
            csv_standings = {"Wednesday Ladies": {}}
            with open(csv_path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    name = row["Team"].strip()
                    csv_standings["Wednesday Ladies"][name] = {
                        "wins": int(row["W"]),
                        "losses": int(row["L"]),
                        "ties": int(row["T"]),
                    }
            count, errs = update_division(womens_roster, csv_standings, DATA_DIR / "teams_womens.json")
            print(f"\n  {count} teams written, {errs} errors")
    else:
        print(f"\n  No roster_womens.json — skipping women's update")

    print(f"\n{'=' * 60}")
    print("  Done!  Next: python scripts/calculate_odds.py")
    print(f"{'=' * 60}\n")


if __name__ == "__main__":
    main()
