#!/usr/bin/env python3
"""
simulate_auction.py — Monte Carlo auction simulation.

Simulates the Calcutta auction to estimate Poole's expected profit
when buying undervalued teams within a fixed budget.

Uses the FULL bracket simulation (same as calculate_odds.py) so that
tournament outcomes respect draw-dependent correlations — teams in the
same bracket quarter can't both win A-event, losers drop to B/C/D, etc.

Auction model:
  - Teams auctioned in alphabetical order
  - Other bidders overbid strong teams, underbid weak teams
  - Poole bids on undervalued teams up to a budget cap
  - After auction, bracket simulation determines tournament outcomes
"""

import json
import random
import sys
from pathlib import Path

# Import bracket simulation functions from calculate_odds.py
sys.path.insert(0, str(Path(__file__).resolve().parent))
from calculate_odds import (
    simulate_tree,
    simulate_championship,
    composite_strength,
    load_overrides,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# ── Config ────────────────────────────────────────────────
POOLE_BUDGET = 800
PAYOUT_PCTS = {"A": 0.40, "B": 0.30, "C": 0.15, "D": 0.15}
BUYBACK_PCT = 0.25          # team buys back 25%, buyer keeps 75%
KEEP_FRAC = 1 - BUYBACK_PCT
PRIOR_POOL = 12400          # estimated total pool for fair-value calc
AUCTION_SIMS = 10000        # number of auction simulations
TOURNEY_SIMS = 5000         # tournament outcomes per auction sim


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def team_ev(odds, pool):
    """Gross EV of a team given event odds and total pool."""
    return (odds["A"] * pool * PAYOUT_PCTS["A"] +
            odds["B"] * pool * PAYOUT_PCTS["B"] +
            odds["C"] * pool * PAYOUT_PCTS["C"] +
            odds["D"] * pool * PAYOUT_PCTS["D"])


def fair_value(odds, pool):
    """What a rational buyer should pay (break-even bid, buyer keeps 75%)."""
    return team_ev(odds, pool) * KEEP_FRAC


def generate_market_bid(fv, strength_rank, n_teams):
    """
    Generate a random bid from other auction participants.
    Top teams get overbid, bottom teams get underbid.

    strength_rank: 0 = strongest, n_teams-1 = weakest
    """
    pct = strength_rank / (n_teams - 1)  # 0.0 = top, 1.0 = bottom

    if pct < 0.3:
        # Top teams: overbid by 10-60%
        multiplier = random.uniform(1.10, 1.60)
    elif pct < 0.6:
        # Middle teams: slight variance around fair value
        multiplier = random.uniform(0.75, 1.25)
    else:
        # Bottom teams: underbid by 20-60%
        multiplier = random.uniform(0.40, 0.80)

    bid = max(10, fv * multiplier)  # minimum $10
    # Round to nearest $5 (auction increments)
    return round(bid / 5) * 5


def simulate_one_auction(teams_by_alpha, odds_map, strength_order):
    """
    Run one auction simulation. Returns (poole_teams, all_bids, total_pool).

    poole_teams: list of team IDs Poole bought
    all_bids: dict team_id -> bid amount
    """
    n = len(teams_by_alpha)
    strength_rank = {tid: i for i, tid in enumerate(strength_order)}

    # Phase 1: generate market bids for all teams
    market_bids = {}
    for t in teams_by_alpha:
        tid = t["id"]
        fv = fair_value(odds_map[tid], PRIOR_POOL)
        rank = strength_rank[tid]
        market_bids[tid] = generate_market_bid(fv, rank, n)

    # Phase 2: Poole's strategy — buy undervalued teams in alphabetical order
    poole_teams = []
    poole_spent = 0
    all_bids = dict(market_bids)

    for t in teams_by_alpha:
        tid = t["id"]

        market_price = market_bids[tid]
        fv = fair_value(odds_map[tid], PRIOR_POOL)

        # Buy if price is below 90% of fair value and we can afford it
        if market_price < fv * 0.90 and poole_spent + market_price + 5 <= POOLE_BUDGET:
            poole_teams.append(tid)
            # Poole wins at market price + $5 (outbids by $5)
            all_bids[tid] = market_price + 5
            poole_spent += market_price + 5

    total_pool = sum(all_bids.values())
    return poole_teams, all_bids, total_pool


def simulate_tournament_bracket(poole_teams, teams, bracket, strength_map, n_sims):
    """
    Simulate the full tournament bracket n_sims times.
    Returns average winnings for Poole's portfolio.

    Uses the same bracket simulation as calculate_odds.py:
    A-event qualifiers -> B-event qualifiers -> Championship/Consolation -> C/D events.
    """
    if not poole_teams:
        return 0.0

    poole_set = set(poole_teams)
    teams_map = {t["id"]: t for t in teams}

    a_event = bracket["a_event"]
    b_event = bracket["b_event"]
    champ_cfg = bracket["championship"]
    c_tree = bracket["c_event"]
    d_tree = bracket["d_event"]

    total_winnings = 0.0
    for _ in range(n_sims):
        slot_map = {}

        # Phase 1: A Event brackets -> qualifiers
        a_qualifiers = []
        for q_tree in a_event:
            winner = simulate_tree(q_tree, strength_map, teams_map, slot_map)
            a_qualifiers.append(winner)

        # Phase 2: B Event brackets -> qualifiers
        b_qualifiers = []
        for q_tree in b_event:
            winner = simulate_tree(q_tree, strength_map, teams_map, slot_map)
            b_qualifiers.append(winner)

        # Phase 3: Championship + Consolation
        all_qualifiers = a_qualifiers + b_qualifiers
        champ_winner, consol_winner = simulate_championship(
            all_qualifiers, champ_cfg, strength_map)

        # Phase 4: C Event
        try:
            c_winner = simulate_tree(c_tree, strength_map, teams_map, slot_map)
        except KeyError:
            c_winner = {"id": None}

        # Phase 5: D Event
        try:
            d_winner = simulate_tree(d_tree, strength_map, teams_map, slot_map)
        except KeyError:
            d_winner = {"id": None}

        # Calculate winnings for this simulation
        # total_pool is passed via closure from the caller — we use a fixed pool per auction
        winnings = 0.0
        if champ_winner["id"] in poole_set:
            winnings += PAYOUT_PCTS["A"]
        if consol_winner["id"] in poole_set:
            winnings += PAYOUT_PCTS["B"]
        if c_winner["id"] in poole_set:
            winnings += PAYOUT_PCTS["C"]
        if d_winner["id"] in poole_set:
            winnings += PAYOUT_PCTS["D"]

        total_winnings += winnings

    # Return average payout fraction (caller multiplies by pool * KEEP_FRAC)
    return total_winnings / n_sims


def main():
    odds_data = load_json(DATA_DIR / "odds_mens.json")
    teams_data = load_json(DATA_DIR / "teams_mens.json")
    bracket = load_json(DATA_DIR / "bracket_mens.json")

    # Apply overrides (same as calculate_odds.py)
    overrides = load_overrides("mens")
    for t in teams_data:
        ov = overrides.get(t["name"].lower())
        if ov is not None:
            t["_override_pct"] = ov

    weights = {"alpha": 4.0}
    strength_map = {t["id"]: composite_strength(t, weights) for t in teams_data}

    odds_map = {t["teamId"]: t for t in odds_data}
    teams_by_alpha = sorted(teams_data, key=lambda t: t["name"])
    strength_order = sorted(
        [t["id"] for t in teams_data],
        key=lambda tid: -odds_map[tid]["any"]  # strongest first
    )

    print("=" * 65)
    print("  Calcutta Auction Simulation — Poole's Strategy")
    print(f"  Budget: ${POOLE_BUDGET}  |  Auction sims: {AUCTION_SIMS:,}"
          f"  |  Tourney sims: {TOURNEY_SIMS:,}")
    print(f"  Using FULL BRACKET simulation (draw-dependent)")
    print("=" * 65)

    # Show fair values for reference
    print(f"\n  {'Team':<14} {'Any%':>5} {'FairVal':>8} {'Buyer EV':>9}")
    print(f"  {chr(9472)*14} {chr(9472)*5} {chr(9472)*8} {chr(9472)*9}")
    for t in sorted(teams_data, key=lambda t: -odds_map[t["id"]]["any"]):
        tid = t["id"]
        o = odds_map[tid]
        fv = fair_value(o, PRIOR_POOL)
        ev = team_ev(o, PRIOR_POOL)
        print(f"  {t['name']:<14} {o['any']*100:>4.1f}% ${fv:>7.0f}  ${ev*KEEP_FRAC:>7.0f}")

    print(f"\n  Running {AUCTION_SIMS:,} auction simulations...")

    profits = []
    teams_bought_count = {}
    total_teams_bought = 0
    total_spent = 0

    for sim in range(AUCTION_SIMS):
        poole_teams, bids, pool = simulate_one_auction(
            teams_by_alpha, odds_map, strength_order)

        poole_cost = sum(bids[tid] for tid in poole_teams)

        # Simulate tournament using full bracket
        avg_payout_frac = simulate_tournament_bracket(
            poole_teams, teams_data, bracket, strength_map, TOURNEY_SIMS)
        avg_winnings = avg_payout_frac * pool * KEEP_FRAC

        profit = avg_winnings - poole_cost
        profits.append(profit)

        total_teams_bought += len(poole_teams)
        total_spent += poole_cost
        for tid in poole_teams:
            teams_bought_count[tid] = teams_bought_count.get(tid, 0) + 1

        if (sim + 1) % 1000 == 0:
            print(f"    ... {sim + 1:,}/{AUCTION_SIMS:,} auctions complete")

    avg_profit = sum(profits) / len(profits)
    median_profit = sorted(profits)[len(profits) // 2]
    positive = sum(1 for p in profits if p > 0)
    min_p = min(profits)
    max_p = max(profits)
    avg_teams = total_teams_bought / AUCTION_SIMS
    avg_spent = total_spent / AUCTION_SIMS

    print(f"\n  {'-' * 50}")
    print(f"  RESULTS ({AUCTION_SIMS:,} simulated auctions)")
    print(f"  {'-' * 50}")
    print(f"  Avg teams bought:    {avg_teams:.1f}")
    print(f"  Avg spent:           ${avg_spent:.0f}")
    print(f"  Avg profit:          ${avg_profit:+.0f}")
    print(f"  Median profit:       ${median_profit:+.0f}")
    print(f"  Profitable auctions: {positive}/{AUCTION_SIMS} ({positive/AUCTION_SIMS*100:.0f}%)")
    print(f"  Best case:           ${max_p:+.0f}")
    print(f"  Worst case:          ${min_p:+.0f}")

    print(f"\n  Teams most frequently bought:")
    for tid, count in sorted(teams_bought_count.items(), key=lambda x: -x[1])[:10]:
        name = next(t["name"] for t in teams_data if t["id"] == tid)
        fv = fair_value(odds_map[tid], PRIOR_POOL)
        print(f"    {name:<14} bought {count:>5}/{AUCTION_SIMS} "
              f"({count/AUCTION_SIMS*100:>4.0f}%)  fair value: ${fv:.0f}")

    print(f"\n{'=' * 65}")


if __name__ == "__main__":
    main()
