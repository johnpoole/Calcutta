#!/usr/bin/env python3
"""
Parse the 2026 Club Championship Excel file and generate complete
bracket-tree JSON files for the Calcutta auction calculator.

The bracket trees encode the FULL tournament structure so the Monte Carlo
simulator can follow the actual draw paths (not a generic bracket).

Tournament structure (Men's — 23 teams):
  A Event bracket → 4 qualifiers (Q1-Q4)
  B Event bracket (A losers) → 4 qualifiers (Q5-Q8)
  Championship bracket: Q1-Q8 play Sat/Sun
    → Winner = "A Event" champion (40% payout)
    → Consolation = "B Event" champion (30% payout)
  C Event: B Event losers (11 teams) → C champion (15%)
  D Event: B qualifier losers (4 teams) → D champion (15%)

Tournament structure (Women's — 12 teams):
  A Event bracket → 2 qualifiers (Q1-Q2)
  B Event bracket (A losers) → 2 qualifiers (Q7-Q8, a.k.a. Q3-Q4 in Champ.)
  Championship bracket: 4 qualifiers play Sun
    → Winner = "A Event" champion (40%)
    → Consolation = "B Event" champion (30%)
  C Event: B Event losers (6 teams) → C champion (15%)
  D Event: B qualifier losers (2 teams) → D champion (15%)

Generates:
  data/teams_mens.json, data/teams_womens.json   — for odds calculator
  data/bracket_mens.json, data/bracket_womens.json — full bracket trees
  data/draw_mens.json, data/draw_womens.json       — flat match list (web app)
  data/rosters_full.json                           — full roster details
  data/calcutta_2026.json                          — web app importable state

Usage:
  python scripts/parse_excel.py
"""

import xlrd
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

XLS_NAME = "2026 Ladies (12) and Men (23) Club Champs.xls"
XLS_PATH = DATA_DIR / XLS_NAME

MENS_NICKNAMES = {
    "The Pants": "wilson",
    "Plaid Lads": "smith",
}


# ═══════════════════════════════════════════════════════════
#  BRACKET TREE HELPERS
# ═══════════════════════════════════════════════════════════

def team(tid):
    """Leaf node: a specific team by id."""
    return {"team": tid}

def slot(ref):
    """Slot node: filled during simulation by a loser from another bracket."""
    return {"slot": ref}

def match(left, right, loser_slot=None):
    """Match node: left and right play; loser optionally fills a slot."""
    node = {"match": {"left": left, "right": right}}
    if loser_slot:
        node["match"]["loserSlot"] = loser_slot
    return node


# ═══════════════════════════════════════════════════════════
#  ROSTER PARSING
# ═══════════════════════════════════════════════════════════

def parse_rosters(wb):
    sheet = wb.sheet_by_name("2026 Team Rosters")
    womens_teams, mens_teams = [], []
    current = None

    for r in range(sheet.nrows):
        row = [sheet.cell_value(r, c) for c in range(sheet.ncols)]
        first = str(row[0]).strip()
        if "Ladies" in first and "Championship" in first:
            current = womens_teams
            continue
        elif "Mens" in first or ("Men" in first and "Championship" in first):
            current = mens_teams
            continue
        if current is None or not isinstance(row[0], (int, float)) or row[0] == 0:
            continue

        num = int(row[0])
        skip_name = str(row[1]).strip()
        if not skip_name:
            continue

        members = [str(row[c]).strip() for c in range(2, min(6, sheet.ncols))
                    if str(row[c]).strip()]
        last_name = skip_name.split()[-1].lower()

        current.append({
            "id": last_name, "name": skip_name.split()[-1],
            "skip": skip_name, "members": members, "rosterNum": num,
            "wins": 0, "losses": 0, "ties": 0,
            "h2h": {}, "seed": num,
        })

    return mens_teams, womens_teams


# ═══════════════════════════════════════════════════════════
#  MEN'S BRACKET (23 teams)
# ═══════════════════════════════════════════════════════════

def build_mens_bracket():
    # ── A Event: 4 quarter-brackets → Q1–Q4 ──────────

    # Q1 (5 teams): Lessard, Clark, Duckworth, Smith(Plaid Lads), Carson
    q1 = match(
        match(match(team("lessard"), team("clark"), "B1"),
              team("duckworth"), "B9"),
        match(team("smith"), team("carson"), "B8"),
        "B28")

    # Q2 (6 teams): Wilson(The Pants), Poole, Moss, Feilding, Flock, Linder
    q2 = match(
        match(match(team("wilson"), team("poole"), "B2"),
              team("moss"), "B10"),
        match(match(team("feilding"), team("flock"), "B3"),
              team("linder"), "B11"),
        "B27")

    # Q3 (6 teams): Richardson, Kelly, Waddell, Bell, Nickles, Lefebvre
    q3 = match(
        match(match(team("richardson"), team("kelly"), "B4"),
              team("waddell"), "B12"),
        match(match(team("bell"), team("nickles"), "B5"),
              team("lefebvre"), "B13"),
        "B29")

    # Q4 (6 teams): Henry, Annable, Kennedy, Cameron, Snethun, Fairbanks
    q4 = match(
        match(match(team("henry"), team("annable"), "B6"),
              team("kennedy"), "B14"),
        match(match(team("cameron"), team("snethun"), "B7"),
              team("fairbanks"), "B15"),
        "B30")

    # ── B Event (19 A-losers → Q5–Q8) ────────────────

    # Q5 (4 slots, linear): B1→B12→B13→B27
    q5 = match(
        match(match(slot("B1"), slot("B12"), "C1"),
              slot("B13"), "C8"),
        slot("B27"), "D1")

    # Q6 (5 slots): B14,B15 vs B2,B3 → B28
    q6 = match(
        match(match(slot("B14"), slot("B15"), "C2"),
              match(slot("B2"), slot("B3"), "C3"), "C9"),
        slot("B28"), "D2")

    # Q7 (5 slots): B9,B4 vs B8,B5 → B29
    q7 = match(
        match(match(slot("B9"), slot("B4"), "C4"),
              match(slot("B8"), slot("B5"), "C5"), "C10"),
        slot("B29"), "D3")

    # Q8 (5 slots): B10,B6 vs B11,B7 → B30
    q8 = match(
        match(match(slot("B10"), slot("B6"), "C6"),
              match(slot("B11"), slot("B7"), "C7"), "C11"),
        slot("B30"), "D4")

    # ── Championship (Q1-Q8) ─────────────────────────
    championship = {
        "numQualifiers": 8,
        "quarterSeed": [[0,7],[1,6],[2,5],[3,4]],
        "semiPairs": [[0,1],[2,3]],
    }

    # ── C Event (11 slots: C1–C11) ───────────────────
    c_event = match(
        match(
            match(match(slot("C3"), slot("C6")), slot("C7")),
            match(match(slot("C4"), slot("C5")), slot("C9"))),
        match(
            match(slot("C11"), slot("C8")),
            match(match(slot("C1"), slot("C2")), slot("C10"))))

    # ── D Event (4 slots: D1–D4) ─────────────────────
    d_event = match(
        match(slot("D1"), slot("D2")),
        match(slot("D3"), slot("D4")))

    return {
        "a_event": [q1, q2, q3, q4],
        "b_event": [q5, q6, q7, q8],
        "championship": championship,
        "c_event": c_event,
        "d_event": d_event,
    }


# ═══════════════════════════════════════════════════════════
#  WOMEN'S BRACKET (12 teams)
# ═══════════════════════════════════════════════════════════

def build_womens_bracket():
    # ── A Event: 2 half-brackets → Q1, Q2 ────────────

    # Q1 (6 teams): Williams, Patrick, Sheeran, Wilson, Lougheed, Snethun
    q1 = match(
        match(match(team("williams"), team("patrick"), "L3"),
              team("sheeran"), "L5"),
        match(match(team("wilson"), team("lougheed"), "L2"),
              team("snethun"), "L6"),
        "L9")

    # Q2 (6 teams): Hawkins, Inman, Newman, Loczy, Vogt, Clark
    q2 = match(
        match(match(team("hawkins"), team("inman"), "L1"),
              team("newman"), "L7"),
        match(match(team("loczy"), team("vogt"), "L4"),
              team("clark"), "L8"),
        "L10")

    # ── B Event (10 A-losers → Q7, Q8) ───────────────

    # Q7 (5 slots): L3,L6 vs L4,L5 → L10
    q7 = match(
        match(match(slot("L3"), slot("L6"), "C1"),
              match(slot("L4"), slot("L5"), "C2"), "C5"),
        slot("L10"), "D1")

    # Q8 (5 slots): L1,L8 vs L2,L7 → L9
    q8 = match(
        match(match(slot("L1"), slot("L8"), "C3"),
              match(slot("L2"), slot("L7"), "C4"), "C6"),
        slot("L9"), "D2")

    # ── Championship (4 qualifiers) ──────────────────
    championship = {
        "numQualifiers": 4,
        "quarterSeed": [[0,3],[1,2]],
        "semiPairs": [[0,1]],
    }

    # ── C Event (6 slots: C1–C6) ─────────────────────
    c_event = match(
        match(match(slot("C1"), slot("C2")), slot("C6")),
        match(match(slot("C3"), slot("C4")), slot("C5")))

    # ── D Event (2 slots: D1, D2) ────────────────────
    d_event = match(slot("D1"), slot("D2"))

    return {
        "a_event": [q1, q2],
        "b_event": [q7, q8],
        "championship": championship,
        "c_event": c_event,
        "d_event": d_event,
    }


# ═══════════════════════════════════════════════════════════
#  FLATTEN BRACKET → DRAW MATCH LIST (web app)
# ═══════════════════════════════════════════════════════════

def flatten_bracket(tree, event_label, division, counter=None):
    """Extract team-vs-team matches from bracket tree (skip slot nodes)."""
    if counter is None:
        counter = [0]
    matches = []
    if "match" not in tree:
        return matches
    m = tree["match"]
    matches.extend(flatten_bracket(m["left"], event_label, division, counter))
    matches.extend(flatten_bracket(m["right"], event_label, division, counter))

    lt = m["left"].get("team")
    rt = m["right"].get("team")
    if lt and rt:
        counter[0] += 1
        matches.append({
            "id": f"{division}-{event_label}-{counter[0]}",
            "drawNum": counter[0],
            "sheet": "", "team1Id": lt, "team2Id": rt,
            "event": event_label[0].upper(), "winnerId": "",
            "loserGoesTo": m.get("loserSlot", ""),
        })
    return matches


# ═══════════════════════════════════════════════════════════
#  OUTPUT HELPERS
# ═══════════════════════════════════════════════════════════

def strip_extra_fields(teams):
    keep = ("id", "name", "wins", "losses", "ties", "h2h", "seed")
    return [{k: t[k] for k in keep} for t in teams]


def build_flat_draw(bracket, division):
    matches = []
    for i, q in enumerate(bracket["a_event"], 1):
        matches.extend(flatten_bracket(q, f"a-q{i}", division))
    return matches


def build_webapp_state(mt, wt, md, wd):
    return {
        "mens": {"teams": strip_extra_fields(mt), "draw": md,
                 "bids": [], "priorPayouts": []},
        "womens": {"teams": strip_extra_fields(wt), "draw": wd,
                   "bids": [], "priorPayouts": []},
        "config": {
            "payoutPcts": {"A": 0.40, "B": 0.30, "C": 0.15, "D": 0.15},
            "priorPools": {"mens": 12400, "womens": 4700},
            "buyBack": {"fee": 40, "payoutPct": 0.25},
            "weights": {"standings": 0.5, "h2h": 0.3, "draw": 0.2},
            "currentYear": 2026,
        },
    }


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  ✓ {path.relative_to(ROOT)}")


def count_nodes(node, key):
    if key in node:
        return 1
    if "match" in node:
        return count_nodes(node["match"]["left"], key) + \
               count_nodes(node["match"]["right"], key)
    return 0


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def main():
    print("═" * 60)
    print("  Parsing 2026 Club Championship — Full Bracket Trees")
    print("═" * 60)

    if not XLS_PATH.exists():
        print(f"\n  ✗ Excel file not found: {XLS_PATH}")
        return

    wb = xlrd.open_workbook(str(XLS_PATH))
    mens_teams, womens_teams = parse_rosters(wb)
    print(f"\n  Found {len(mens_teams)} men's teams, {len(womens_teams)} women's teams")

    for label, teams in [("Men's", mens_teams), ("Women's", womens_teams)]:
        print(f"\n  {label} teams:")
        for t in teams:
            print(f"    #{t['rosterNum']:>2}  {t['skip']:<25} id={t['id']}")

    mens_bracket = build_mens_bracket()
    womens_bracket = build_womens_bracket()

    for label, b in [("Men's", mens_bracket), ("Women's", womens_bracket)]:
        a_t = sum(count_nodes(q, "team") for q in b["a_event"])
        b_s = sum(count_nodes(q, "slot") for q in b["b_event"])
        print(f"\n  {label} A Event: {a_t} teams → {len(b['a_event'])} qualifiers")
        print(f"  {label} B Event: {b_s} slots → {len(b['b_event'])} qualifiers")
        print(f"  {label} C Event: {count_nodes(b['c_event'], 'slot')} slots")
        print(f"  {label} D Event: {count_nodes(b['d_event'], 'slot')} slots")

    mens_draw = build_flat_draw(mens_bracket, "mens")
    womens_draw = build_flat_draw(womens_bracket, "womens")

    print(f"\n  Writing JSON files:")
    write_json(DATA_DIR / "bracket_mens.json", mens_bracket)
    write_json(DATA_DIR / "bracket_womens.json", womens_bracket)
    write_json(DATA_DIR / "teams_mens.json", strip_extra_fields(mens_teams))
    write_json(DATA_DIR / "teams_womens.json", strip_extra_fields(womens_teams))
    write_json(DATA_DIR / "draw_mens.json", mens_draw)
    write_json(DATA_DIR / "draw_womens.json", womens_draw)
    write_json(DATA_DIR / "rosters_full.json",
               {"mens": mens_teams, "womens": womens_teams})
    state = build_webapp_state(mens_teams, womens_teams, mens_draw, womens_draw)
    write_json(DATA_DIR / "calcutta_2026.json", state)

    print(f"\n{'═' * 60}")
    print("  Done!  Next steps:")
    print("    1. Add league standings to teams JSONs")
    print("    2. Run:  python scripts/calculate_odds.py")
    print(f"{'═' * 60}\n")


if __name__ == "__main__":
    main()
