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

import json
import random
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


# ═══════════════════════════════════════════════════════════
#  STRENGTH CALCULATIONS
# ═══════════════════════════════════════════════════════════

def strength_from_standings(t: dict) -> float:
    """Win percentage as strength signal (0–1)."""
    gp = t.get("wins", 0) + t.get("losses", 0) + t.get("ties", 0)
    if gp == 0:
        return 0.5
    return (t["wins"] + t.get("ties", 0) * 0.5) / gp


def strength_from_h2h(t: dict) -> float:
    """Average H2H win rate across tracked opponents."""
    h2h = t.get("h2h", {})
    if not h2h:
        return 0.5
    tw, tg = 0, 0
    for rec in h2h.values():
        tw += rec.get("w", 0)
        tg += rec.get("w", 0) + rec.get("l", 0)
    return tw / tg if tg else 0.5


def composite_strength(t: dict, weights: dict) -> float:
    """Weighted combination of strength signals.

    If a team has no h2h data, the h2h weight is redistributed
    proportionally to standings and seed weights so the total
    weighting still sums to 1.0.
    """
    w_stand = weights.get("standings", 0.5)
    w_h2h   = weights.get("h2h", 0.3)
    w_seed  = weights.get("draw", 0.2)

    has_h2h = bool(t.get("h2h"))
    if not has_h2h and (w_stand + w_seed) > 0:
        # Redistribute h2h weight to standings and seed proportionally
        extra = w_h2h
        total_other = w_stand + w_seed
        w_stand += extra * (w_stand / total_other)
        w_seed  += extra * (w_seed  / total_other)
        w_h2h = 0

    ws = w_stand * strength_from_standings(t)
    wh = w_h2h * strength_from_h2h(t)
    # Seed-based factor: lower seed = stronger (normalised to 0–1)
    seed = t.get("seed", 50)
    ws_seed = w_seed * max(0, 1.0 - seed / 50.0)
    return ws + wh + ws_seed


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
    parser.add_argument("--iterations", "-n", type=int, default=50_000)
    parser.add_argument("--divisions", "-d", nargs="+", default=["mens", "womens"])
    parser.add_argument("--standings-weight", type=float, default=0.5)
    parser.add_argument("--h2h-weight", type=float, default=0.3)
    parser.add_argument("--draw-weight", type=float, default=0.2)
    parser.add_argument("--seed", "-s", type=int, default=None)
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    weights = {
        "standings": args.standings_weight,
        "h2h": args.h2h_weight,
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
