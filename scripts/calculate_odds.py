#!/usr/bin/env python3
"""
Calcutta Auction — Win Probability Calculator

Runs Monte Carlo simulations over the ACTUAL bracket structure to estimate
each team's probability of winning the Championship (A), Consolation (B),
C Event, or D Event.

Reads bracket trees from data/bracket_{division}.json and team data from
data/teams_{division}.json.  Writes results to data/odds_{division}.json.

Run before deploying the website:
    python scripts/calculate_odds.py
"""

import csv
import json
import random
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


# ═══════════════════════════════════════════════════════════
#  COMBINED RECORD LOOKUP
# ═══════════════════════════════════════════════════════════

def build_combined_records(division="mens"):
    """
    Build combined Monday + Tuesday league records for each Calcutta team
    by looking up the skip's name across all league rosters.

    Returns dict: team_id -> {"wins": W, "losses": L, "ties": T}
    Only includes entries where the skip was found on multiple league teams.
    Falls back to single-team record otherwise (no entry returned).
    """
    rosters_path = DATA_DIR / "rosters_full.json"
    ptd_path = DATA_DIR / "poole_team_data.json"

    if not rosters_path.exists() or not ptd_path.exists():
        return {}

    with open(rosters_path) as f:
        rosters = json.load(f)
    with open(ptd_path) as f:
        ptd = json.load(f)

    # Skip names keyed by team id
    skips = {}
    for entry in rosters.get(division, []):
        skips[entry["id"]] = entry.get("skip", "")

    standings = ptd.get("standings", {})
    all_rosters = ptd.get("all_team_rosters", {})

    # Common nickname mappings for matching
    NICKNAME_MAP = {
        "stu": "stuart",
        "stuart": "stu",
        "rob": "robert",
        "bob": "robert",
        "dave": "david",
        "mike": "michael",
        "bill": "william",
        "jim": "james",
        "tom": "thomas",
        "dan": "daniel",
        "greg": "gregory",
    }

    def name_variants(full_name):
        """Return lowercase name plus variant with nickname swap."""
        parts = full_name.strip().lower().split()
        variants = [" ".join(parts)]
        if parts:
            first = parts[0]
            if first in NICKNAME_MAP:
                alt_parts = [NICKNAME_MAP[first]] + parts[1:]
                variants.append(" ".join(alt_parts))
        return variants

    # Build player -> [(team_name, league)] from all_team_rosters
    player_teams = {}
    for team_name, leagues in all_rosters.items():
        for league, players in leagues.items():
            if league not in ("Monday Night", "Tuesday Night"):
                continue
            for p in players:
                key = p.strip().lower()
                player_teams.setdefault(key, []).append((team_name, league))

    combined = {}
    for tid, skip_name in skips.items():
        skip_key = skip_name.strip().lower()
        found = player_teams.get(skip_key, [])
        # Try nickname variants if no match or only one match
        if len(found) <= 1:
            for variant in name_variants(skip_name):
                if variant != skip_key:
                    extra = player_teams.get(variant, [])
                    if extra:
                        found = found + extra
                        break
        if len(found) <= 1:
            continue  # only one league team — no combined record needed

        w_total, l_total, t_total = 0, 0, 0
        for team_name, league in found:
            st = standings.get(league, {}).get(team_name)
            if st:
                w_total += st["wins"]
                l_total += st["losses"]
                t_total += st["ties"]

        if w_total + l_total + t_total > 0:
            combined[tid] = {"wins": w_total, "losses": l_total, "ties": t_total}

    return combined


# ═══════════════════════════════════════════════════════════
#  WIN-PERCENTAGE OVERRIDES
# ═══════════════════════════════════════════════════════════

def load_overrides() -> dict:
    """Read data/overrides.csv → { team_name_lower: win_pct_float }.

    CSV format:  Team,WinPct
    Blank WinPct values are ignored.
    WinPct can be 0-100 (treated as %) or 0-1 (treated as fraction).
    """
    path = DATA_DIR / "overrides.csv"
    if not path.exists():
        return {}
    overrides = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("Team") or "").strip()
            val = (row.get("WinPct") or "").strip()
            if not name or not val:
                continue
            try:
                v = float(val)
            except ValueError:
                continue
            # Treat values > 1 as percentages (e.g. 75 → 0.75)
            if v > 1:
                v /= 100.0
            overrides[name.lower()] = v
    return overrides


# ═══════════════════════════════════════════════════════════
#  STRENGTH CALCULATIONS
# ═══════════════════════════════════════════════════════════

def strength_from_standings(t: dict) -> float:
    """Win percentage as strength signal (0–1)."""
    gp = t.get("wins", 0) + t.get("losses", 0) + t.get("ties", 0)
    if gp == 0:
        return 0.5
    return (t["wins"] + t.get("ties", 0) * 0.5) / gp


def composite_strength(t: dict, weights: dict) -> float:
    """Team strength — uses manual override if set, otherwise win percentage."""
    if "_override_pct" in t:
        return t["_override_pct"]
    return strength_from_standings(t)


def pairwise_win_prob(sa: float, sb: float) -> float:
    """Bradley-Terry P(A beats B)."""
    total = sa + sb
    return sa / total if total > 0 else 0.5


# ═══════════════════════════════════════════════════════════
#  BRACKET TREE SIMULATION
# ═══════════════════════════════════════════════════════════

def simulate_tree(node, strength_map, teams_map, slot_map):
    """
    Recursively simulate a bracket tree node.

    Returns the winning team dict.
    Side effect: if the match has a loserSlot, the loser is recorded
    in slot_map so downstream brackets can reference it.

    Node types:
      {"team": "id"}      — known team
      {"slot": "B1"}      — look up from slot_map
      {"match": {…}}      — recursively simulate
    """
    if "team" in node:
        return teams_map[node["team"]]

    if "slot" in node:
        ref = node["slot"]
        t = slot_map.get(ref)
        if t is None:
            raise KeyError(f"Slot '{ref}' not yet filled — bracket order error")
        return t

    if "match" in node:
        m = node["match"]
        left = simulate_tree(m["left"], strength_map, teams_map, slot_map)
        right = simulate_tree(m["right"], strength_map, teams_map, slot_map)

        sl = strength_map.get(left["id"], 0.5)
        sr = strength_map.get(right["id"], 0.5)

        if random.random() < pairwise_win_prob(sl, sr):
            winner, loser = left, right
        else:
            winner, loser = right, left

        if "loserSlot" in m:
            slot_map[m["loserSlot"]] = loser

        return winner

    raise ValueError(f"Unknown bracket node: {node}")


def simulate_championship(qualifiers, championship_cfg, strength_map):
    """
    Simulate the Championship / Consolation bracket from qualifier winners.

    Returns (championship_winner, consolation_winner).
    """
    qs = championship_cfg["quarterSeed"]   # e.g. [[0,7],[1,6],[2,5],[3,4]]
    semi_pairs = championship_cfg["semiPairs"]  # e.g. [[0,1],[2,3]]

    # Quarterfinals
    qf_winners = []
    qf_losers = []
    for i, j in qs:
        a, b = qualifiers[i], qualifiers[j]
        sa = strength_map.get(a["id"], 0.5)
        sb = strength_map.get(b["id"], 0.5)
        if random.random() < pairwise_win_prob(sa, sb):
            qf_winners.append(a); qf_losers.append(b)
        else:
            qf_winners.append(b); qf_losers.append(a)

    # Championship semis
    champ_semi_winners = []
    for i, j in semi_pairs:
        a, b = qf_winners[i], qf_winners[j]
        sa = strength_map.get(a["id"], 0.5)
        sb = strength_map.get(b["id"], 0.5)
        if random.random() < pairwise_win_prob(sa, sb):
            champ_semi_winners.append(a)
        else:
            champ_semi_winners.append(b)

    # Championship final
    if len(champ_semi_winners) >= 2:
        a, b = champ_semi_winners[0], champ_semi_winners[1]
        sa = strength_map.get(a["id"], 0.5)
        sb = strength_map.get(b["id"], 0.5)
        champ_winner = a if random.random() < pairwise_win_prob(sa, sb) else b
    else:
        champ_winner = champ_semi_winners[0]

    # Consolation semis
    consol_semi_winners = []
    for i, j in semi_pairs:
        a, b = qf_losers[i], qf_losers[j]
        sa = strength_map.get(a["id"], 0.5)
        sb = strength_map.get(b["id"], 0.5)
        if random.random() < pairwise_win_prob(sa, sb):
            consol_semi_winners.append(a)
        else:
            consol_semi_winners.append(b)

    # Consolation final
    if len(consol_semi_winners) >= 2:
        a, b = consol_semi_winners[0], consol_semi_winners[1]
        sa = strength_map.get(a["id"], 0.5)
        sb = strength_map.get(b["id"], 0.5)
        consol_winner = a if random.random() < pairwise_win_prob(sa, sb) else b
    else:
        consol_winner = consol_semi_winners[0]

    return champ_winner, consol_winner


# ═══════════════════════════════════════════════════════════
#  FULL TOURNAMENT SIMULATION
# ═══════════════════════════════════════════════════════════

def simulate(teams, bracket, weights, iterations=50_000):
    """
    Monte Carlo simulation over the full tournament bracket.

    Returns list of dicts: [{ teamId, teamName, A, B, C, D, any }, ...]
    """
    if len(teams) < 2:
        return [{"teamId": t["id"], "teamName": t["name"],
                 "A": 0, "B": 0, "C": 0, "D": 0, "any": 0} for t in teams]

    teams_map = {t["id"]: t for t in teams}
    strength_map = {t["id"]: composite_strength(t, weights) for t in teams}

    event_wins = {e: {t["id"]: 0 for t in teams} for e in ("A", "B", "C", "D")}

    a_event = bracket["a_event"]
    b_event = bracket["b_event"]
    champ_cfg = bracket["championship"]
    c_tree = bracket["c_event"]
    d_tree = bracket["d_event"]

    for _ in range(iterations):
        slot_map = {}

        # ── Phase 1: A Event brackets → qualifiers ────
        a_qualifiers = []
        for q_tree in a_event:
            winner = simulate_tree(q_tree, strength_map, teams_map, slot_map)
            a_qualifiers.append(winner)

        # ── Phase 2: B Event brackets → qualifiers ────
        b_qualifiers = []
        for q_tree in b_event:
            winner = simulate_tree(q_tree, strength_map, teams_map, slot_map)
            b_qualifiers.append(winner)

        # ── Phase 3: Championship + Consolation ───────
        all_qualifiers = a_qualifiers + b_qualifiers
        champ_winner, consol_winner = simulate_championship(
            all_qualifiers, champ_cfg, strength_map)

        event_wins["A"][champ_winner["id"]] += 1
        event_wins["B"][consol_winner["id"]] += 1

        # ── Phase 4: C Event ──────────────────────────
        try:
            c_winner = simulate_tree(c_tree, strength_map, teams_map, slot_map)
            event_wins["C"][c_winner["id"]] += 1
        except KeyError:
            pass  # some slots unfilled (shouldn't happen with correct brackets)

        # ── Phase 5: D Event ──────────────────────────
        try:
            d_winner = simulate_tree(d_tree, strength_map, teams_map, slot_map)
            event_wins["D"][d_winner["id"]] += 1
        except KeyError:
            pass

    # Convert counts to probabilities
    results = []
    for t in teams:
        tid = t["id"]
        pa = event_wins["A"][tid] / iterations
        pb = event_wins["B"][tid] / iterations
        pc = event_wins["C"][tid] / iterations
        pd = event_wins["D"][tid] / iterations
        results.append({
            "teamId": tid,
            "teamName": t["name"],
            "A": round(pa, 5),
            "B": round(pb, 5),
            "C": round(pc, 5),
            "D": round(pd, 5),
            "any": round(min(1.0, pa + pb + pc + pd), 5),
        })

    return results


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def load_json(p: Path):
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)


def process_division(division, weights, iterations):
    teams_path = DATA_DIR / f"teams_{division}.json"
    bracket_path = DATA_DIR / f"bracket_{division}.json"
    out_path = DATA_DIR / f"odds_{division}.json"

    teams = load_json(teams_path)
    if not teams:
        print(f"  ⚠  No teams file: {teams_path} — skipping")
        return

    bracket = load_json(bracket_path)
    if not bracket:
        print(f"  ⚠  No bracket file: {bracket_path} — skipping")
        return

    # Merge combined Mon+Tue records for multi-league skips
    combined = build_combined_records(division)
    if combined:
        print(f"  → Combined records for {len(combined)} multi-league skips:")
        for tid, rec in sorted(combined.items()):
            orig = next((t for t in teams if t["id"] == tid), None)
            if orig:
                orig_gp = orig["wins"] + orig["losses"] + orig.get("ties", 0)
                orig_pct = (orig["wins"] + orig.get("ties", 0) * 0.5) / orig_gp * 100 if orig_gp else 0
                new_gp = rec["wins"] + rec["losses"] + rec["ties"]
                new_pct = (rec["wins"] + rec["ties"] * 0.5) / new_gp * 100 if new_gp else 0
                print(f"    {orig['name']:<14} {orig['wins']}-{orig['losses']}-{orig.get('ties',0)} "
                      f"({orig_pct:.0f}%) → {rec['wins']}-{rec['losses']}-{rec['ties']} ({new_pct:.0f}%)")
        # Override team W-L-T with combined records
        for t in teams:
            if t["id"] in combined:
                t["wins"] = combined[t["id"]]["wins"]
                t["losses"] = combined[t["id"]]["losses"]
                t["ties"] = combined[t["id"]]["ties"]

    # Apply manual win% overrides from data/overrides.csv
    overrides = load_overrides()
    applied = []
    for t in teams:
        ov = overrides.get(t["name"].lower())
        if ov is not None:
            t["_override_pct"] = ov
            applied.append((t["name"], ov))
    if applied:
        print(f"  → Manual overrides from overrides.csv:")
        for name, pct in applied:
            print(f"    {name:<14} → {pct*100:.0f}%")

    print(f"  → {len(teams)} teams, {len(bracket['a_event'])} A qualifiers")
    print(f"  → Running {iterations:,} iterations...")

    results = simulate(teams, bracket, weights, iterations)

    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  ✓ Wrote {out_path.relative_to(ROOT)}")

    sorted_r = sorted(results, key=lambda r: r["A"], reverse=True)
    print(f"\n  {'Team':<15} {'Champ%':>7} {'Consol%':>8} {'C%':>7} {'D%':>7} {'Any%':>7}")
    print(f"  {'─'*15} {'─'*7} {'─'*8} {'─'*7} {'─'*7} {'─'*7}")
    for r in sorted_r:
        print(f"  {r['teamName']:<15} {r['A']*100:>6.1f}% {r['B']*100:>7.1f}% "
              f"{r['C']*100:>6.1f}% {r['D']*100:>6.1f}% {r['any']*100:>6.1f}%")


def main():
    parser = argparse.ArgumentParser(
        description="Calculate Calcutta win probabilities via bracket simulation")
    parser.add_argument("--iterations", "-n", type=int, default=500_000)
    parser.add_argument("--divisions", "-d", nargs="+", default=["mens", "womens"])
    parser.add_argument("--standings-weight", type=float, default=1.0)
    parser.add_argument("--draw-weight", type=float, default=0.0)
    parser.add_argument("--seed", "-s", type=int, default=None)
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    weights = {
        "standings": args.standings_weight,
        "draw": args.draw_weight,
    }

    DATA_DIR.mkdir(exist_ok=True)

    print("═" * 60)
    print("  Calcutta Auction — Win Probability Calculator")
    print("  (Using actual bracket trees)")
    print("═" * 60)

    for div in args.divisions:
        print(f"\n▸ Processing {div.upper()}:")
        process_division(div, weights, args.iterations)

    print(f"\n{'═' * 60}")
    print("  Done! Odds JSON files are ready for the website.")
    print(f"{'═' * 60}\n")


if __name__ == "__main__":
    main()
