#!/usr/bin/env python3
"""
simulate_auction.py — Portfolio-aware Monte Carlo auction simulation.

Simulates the Calcutta auction to estimate Poole's expected profit
when buying undervalued teams within a fixed budget.

Uses the FULL bracket simulation (same as calculate_odds.py) so that
tournament outcomes respect draw-dependent correlations. Poole evaluates
each team's MARGINAL value to the existing portfolio — two teams in the
same bracket quarter cannibalize each other's value.

Strategy:
  - Pre-simulate M bracket outcomes per auction
  - For each team (alphabetical order), compute marginal EV of adding
    it to current portfolio using cached bracket outcomes
  - Buy if market price < marginal EV (positive expected profit)
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
AUCTION_SIMS = 1000
BRACKET_SIMS = 2000         # bracket outcomes cached per auction


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
        multiplier = random.uniform(1.10, 1.60)
    elif pct < 0.6:
        multiplier = random.uniform(0.75, 1.25)
    else:
        multiplier = random.uniform(0.40, 0.80)

    bid = max(10, fv * multiplier)
    return round(bid / 5) * 5


def presimulate_bracket(bracket, strength_map, teams_map, n_sims):
    """
    Run the full bracket n_sims times. Returns a list of outcome dicts,
    each mapping event -> winner team ID.

    These cached outcomes are used to evaluate portfolio marginal EV
    without re-running the bracket simulation.
    """
    a_event = bracket["a_event"]
    b_event = bracket["b_event"]
    champ_cfg = bracket["championship"]
    c_tree = bracket["c_event"]
    d_tree = bracket["d_event"]

    outcomes = []
    for _ in range(n_sims):
        slot_map = {}

        a_qualifiers = []
        for q_tree in a_event:
            winner = simulate_tree(q_tree, strength_map, teams_map, slot_map)
            a_qualifiers.append(winner)

        b_qualifiers = []
        for q_tree in b_event:
            winner = simulate_tree(q_tree, strength_map, teams_map, slot_map)
            b_qualifiers.append(winner)

        all_qualifiers = a_qualifiers + b_qualifiers
        champ_winner, consol_winner = simulate_championship(
            all_qualifiers, champ_cfg, strength_map)

        try:
            c_winner = simulate_tree(c_tree, strength_map, teams_map, slot_map)
            c_id = c_winner["id"]
        except KeyError:
            c_id = None

        try:
            d_winner = simulate_tree(d_tree, strength_map, teams_map, slot_map)
            d_id = d_winner["id"]
        except KeyError:
            d_id = None

        outcomes.append({
            "A": champ_winner["id"],
            "B": consol_winner["id"],
            "C": c_id,
            "D": d_id,
        })

    return outcomes


def portfolio_ev(portfolio_set, outcomes):
    """
    Average payout fraction for a portfolio across cached bracket outcomes.
    Returns the fraction of pool won (before KEEP_FRAC).
    """
    if not portfolio_set:
        return 0.0

    total = 0.0
    for outcome in outcomes:
        for event, pct in PAYOUT_PCTS.items():
            if outcome[event] in portfolio_set:
                total += pct
    return total / len(outcomes)


def marginal_ev(tid, portfolio_set, outcomes, pool):
    """
    Compute the marginal EV (in dollars, after buyback) of adding team tid
    to the current portfolio, using cached bracket outcomes.

    This captures draw-dependent effects: if we already own a team in the
    same bracket region, the candidate's marginal value is reduced because
    they compete for the same event slots.
    """
    current_ev = portfolio_ev(portfolio_set, outcomes)
    new_set = portfolio_set | {tid}
    new_ev = portfolio_ev(new_set, outcomes)
    return (new_ev - current_ev) * pool * KEEP_FRAC


def simulate_one_auction(teams_by_alpha, odds_map, strength_order, outcomes):
    """
    Run one auction simulation with portfolio-aware bidding.

    For each team in alphabetical order:
    1. Generate market bid
    2. Compute marginal EV of adding team to Poole's current portfolio
    3. Buy if market price < marginal EV and within budget

    Returns (poole_teams, all_bids, total_pool).
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

    # Phase 2: Poole's portfolio-aware bidding
    poole_teams = []
    poole_set = set()
    poole_spent = 0
    all_bids = dict(market_bids)

    # Estimate pool from market bids (what Poole sees as the auction unfolds)
    est_pool = sum(market_bids.values())

    for t in teams_by_alpha:
        tid = t["id"]
        market_price = market_bids[tid]
        buy_price = market_price + 5  # outbid by $5

        if poole_spent + buy_price > POOLE_BUDGET:
            continue

        # Compute marginal value of this team given current portfolio
        mev = marginal_ev(tid, poole_set, outcomes, est_pool)

        # Buy if the price is below marginal EV (positive expected profit)
        if buy_price < mev:
            poole_teams.append(tid)
            poole_set.add(tid)
            all_bids[tid] = buy_price
            poole_spent += buy_price

    total_pool = sum(all_bids.values())
    return poole_teams, all_bids, total_pool


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
    teams_map = {t["id"]: t for t in teams_data}

    odds_map = {t["teamId"]: t for t in odds_data}
    teams_by_alpha = sorted(teams_data, key=lambda t: t["name"])
    strength_order = sorted(
        [t["id"] for t in teams_data],
        key=lambda tid: -odds_map[tid]["any"]
    )

    print("=" * 65)
    print("  Calcutta Auction Simulation — Portfolio-Aware Strategy")
    print(f"  Budget: ${POOLE_BUDGET}  |  Auction sims: {AUCTION_SIMS:,}"
          f"  |  Bracket sims: {BRACKET_SIMS:,}")
    print(f"  Draw-dependent marginal EV bidding")
    print("=" * 65)

    # Show fair values for reference
    print(f"\n  {'Team':<14} {'Any%':>5} {'FairVal':>8} {'Strength':>9}")
    print(f"  {chr(9472)*14} {chr(9472)*5} {chr(9472)*8} {chr(9472)*9}")
    for t in sorted(teams_data, key=lambda t: -odds_map[t["id"]]["any"]):
        tid = t["id"]
        o = odds_map[tid]
        fv = fair_value(o, PRIOR_POOL)
        s = strength_map[tid]
        print(f"  {t['name']:<14} {o['any']*100:>4.1f}% ${fv:>7.0f}    {s:.3f}")

    print(f"\n  Pre-simulating {BRACKET_SIMS:,} bracket outcomes...")
    outcomes = presimulate_bracket(bracket, strength_map, teams_map, BRACKET_SIMS)

    # Show marginal EVs for reference (empty portfolio = standalone EV)
    print(f"\n  Standalone marginal EVs (empty portfolio, pool=${PRIOR_POOL:,}):")
    standalone = []
    for t in teams_data:
        mev = marginal_ev(t["id"], set(), outcomes, PRIOR_POOL)
        standalone.append((t["name"], t["id"], mev))
    standalone.sort(key=lambda x: -x[2])
    for name, tid, mev in standalone:
        fv = fair_value(odds_map[tid], PRIOR_POOL)
        print(f"    {name:<14} marginal EV: ${mev:>7.0f}  (static FV: ${fv:.0f})")

    print(f"\n  Running {AUCTION_SIMS:,} auction simulations...")

    profits = []
    teams_bought_count = {}
    total_teams_bought = 0
    total_spent = 0

    for sim in range(AUCTION_SIMS):
        # Re-simulate bracket outcomes periodically for variety
        if sim % 100 == 0:
            outcomes = presimulate_bracket(bracket, strength_map, teams_map, BRACKET_SIMS)

        poole_teams, bids, pool = simulate_one_auction(
            teams_by_alpha, odds_map, strength_order, outcomes)

        poole_cost = sum(bids[tid] for tid in poole_teams)

        # Evaluate actual profit using these bracket outcomes
        poole_set = set(poole_teams)
        ev_frac = portfolio_ev(poole_set, outcomes)
        avg_winnings = ev_frac * pool * KEEP_FRAC

        profit = avg_winnings - poole_cost
        profits.append(profit)

        total_teams_bought += len(poole_teams)
        total_spent += poole_cost
        for tid in poole_teams:
            teams_bought_count[tid] = teams_bought_count.get(tid, 0) + 1

        if (sim + 1) % 200 == 0:
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
    for tid, count in sorted(teams_bought_count.items(), key=lambda x: -x[1])[:15]:
        name = next(t["name"] for t in teams_data if t["id"] == tid)
        fv = fair_value(odds_map[tid], PRIOR_POOL)
        mev = marginal_ev(tid, set(), outcomes, PRIOR_POOL)
        print(f"    {name:<14} bought {count:>5}/{AUCTION_SIMS} "
              f"({count/AUCTION_SIMS*100:>4.0f}%)  FV: ${fv:.0f}  standalone MEV: ${mev:.0f}")

    # Show example portfolio composition
    print(f"\n  Example portfolio from last auction:")
    if poole_teams:
        cumulative_set = set()
        for tid in poole_teams:
            cumulative_set.add(tid)
            name = next(t["name"] for t in teams_data if t["id"] == tid)
            cost = bids[tid]
            cum_ev = portfolio_ev(cumulative_set, outcomes) * pool * KEEP_FRAC
            print(f"    + {name:<14} paid ${cost:>4}  portfolio EV now: ${cum_ev:.0f}")
        print(f"    Total cost: ${poole_cost:.0f}  |  Portfolio EV: ${avg_winnings:.0f}"
              f"  |  Profit: ${profit:+.0f}")

    print(f"\n{'=' * 65}")


if __name__ == "__main__":
    main()
