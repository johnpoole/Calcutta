#!/usr/bin/env python3
"""
simulate_auction.py — Portfolio-aware Monte Carlo auction simulation
with realistic multi-bidder model.

Models 23 men's team reps + 12 women's team reps as individual bidders,
each with their own strategy, budget, and behavior. Poole uses draw-
dependent marginal EV to decide what to bid.

Bidder archetypes (men's):
  - Self-buyer (~45%): Primarily wants own team, occasionally bids others
  - Trophy hunter (~15%): Targets top teams, willing to overpay
  - Value hunter (~10%): Looks for undervalued teams (like Poole)
  - Social bidder (~30%): Bids on friends/random teams, unpredictable

Women's bidders:
  - Mostly save budget for women's auction
  - ~15% chance of bidding on a men's team they like

Auction: ascending bid. Each team sells to highest willing bidder at
second-highest bid + $5 (standard ascending auction outcome).
"""

import json
import random
import sys
from pathlib import Path

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
BUYBACK_PCT = 0.25
KEEP_FRAC = 1 - BUYBACK_PCT
PRIOR_POOL = 12400
AUCTION_SIMS = 1000
BRACKET_SIMS = 2000
POOLE_DISCOUNT = 0.70         # Poole bids this fraction of marginal EV

# Strategy distribution for the 22 other men's teams (Poole excluded)
MEN_STRATEGY_WEIGHTS = {
    "self_buyer": 0.45,
    "trophy_hunter": 0.15,
    "value_hunter": 0.10,
    "social": 0.30,
}

MEN_BUDGET_RANGE = (300, 1000)
WOMEN_BUDGET_RANGE = (50, 300)   # for men's auction spending


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def team_ev(odds, pool):
    return (odds["A"] * pool * PAYOUT_PCTS["A"] +
            odds["B"] * pool * PAYOUT_PCTS["B"] +
            odds["C"] * pool * PAYOUT_PCTS["C"] +
            odds["D"] * pool * PAYOUT_PCTS["D"])


def fair_value(odds, pool):
    return team_ev(odds, pool) * KEEP_FRAC


# ── Bracket pre-simulation ───────────────────────────────

def presimulate_bracket(bracket, strength_map, teams_map, n_sims):
    a_event = bracket["a_event"]
    b_event = bracket["b_event"]
    champ_cfg = bracket["championship"]
    c_tree = bracket["c_event"]
    d_tree = bracket["d_event"]

    outcomes = []
    for _ in range(n_sims):
        slot_map = {}
        a_qualifiers = [simulate_tree(q, strength_map, teams_map, slot_map) for q in a_event]
        b_qualifiers = [simulate_tree(q, strength_map, teams_map, slot_map) for q in b_event]
        champ_w, consol_w = simulate_championship(
            a_qualifiers + b_qualifiers, champ_cfg, strength_map)

        try:
            c_id = simulate_tree(c_tree, strength_map, teams_map, slot_map)["id"]
        except KeyError:
            c_id = None
        try:
            d_id = simulate_tree(d_tree, strength_map, teams_map, slot_map)["id"]
        except KeyError:
            d_id = None

        outcomes.append({"A": champ_w["id"], "B": consol_w["id"], "C": c_id, "D": d_id})
    return outcomes


def portfolio_ev(portfolio_set, outcomes):
    if not portfolio_set:
        return 0.0
    total = 0.0
    for outcome in outcomes:
        for event, pct in PAYOUT_PCTS.items():
            if outcome[event] in portfolio_set:
                total += pct
    return total / len(outcomes)


def marginal_ev(tid, portfolio_set, outcomes, pool):
    current_ev = portfolio_ev(portfolio_set, outcomes)
    new_ev = portfolio_ev(portfolio_set | {tid}, outcomes)
    return (new_ev - current_ev) * pool * KEEP_FRAC


# ── Bidder model ─────────────────────────────────────────

def assign_strategy():
    """Randomly assign a strategy based on MEN_STRATEGY_WEIGHTS."""
    r = random.random()
    cumulative = 0.0
    for strategy, weight in MEN_STRATEGY_WEIGHTS.items():
        cumulative += weight
        if r <= cumulative:
            return strategy
    return "social"


def create_bidders(teams_data, n_women=12):
    """
    Create bidder agents for all auction participants except Poole.

    Returns list of dicts: {id, name, strategy, budget, spent, own_team, bought_count}
    """
    bidders = []

    for t in teams_data:
        if t["id"] == "poole":
            continue
        strategy = assign_strategy()
        budget = random.randint(*MEN_BUDGET_RANGE)
        # Round budget to nearest $50
        budget = round(budget / 50) * 50
        bidders.append({
            "id": f"men_{t['id']}",
            "name": t["name"],
            "strategy": strategy,
            "budget": budget,
            "spent": 0,
            "own_team": t["id"],
            "bought_count": 0,
        })

    for i in range(n_women):
        budget = random.randint(*WOMEN_BUDGET_RANGE)
        budget = round(budget / 50) * 50
        bidders.append({
            "id": f"women_{i}",
            "name": f"Women #{i+1}",
            "strategy": "women",
            "budget": budget,
            "spent": 0,
            "own_team": None,
            "bought_count": 0,
        })

    return bidders


def bidder_wtp(bidder, team_id, fv, odds_map, auction_progress):
    """
    Compute a bidder's willingness-to-pay for a team.

    auction_progress: 0.0 (first team) to 1.0 (last team) — drives FOMO.
    Returns max bid in dollars, or 0 if not interested.
    """
    remaining = bidder["budget"] - bidder["spent"]
    if remaining <= 10:
        return 0

    strategy = bidder["strategy"]
    own_team = bidder["own_team"]
    any_pct = odds_map.get(team_id, {}).get("any", 0.1)

    # FOMO: bidders who haven't bought anything yet get more aggressive
    # as the auction progresses
    fomo = 1.0
    if bidder["bought_count"] == 0 and auction_progress > 0.5:
        fomo = 1.0 + (auction_progress - 0.5) * 0.6  # up to 1.3x at end

    wtp = 0.0

    if strategy == "self_buyer":
        if team_id == own_team:
            # Strong desire to own their own team
            wtp = fv * random.uniform(1.0, 2.0) * fomo
        elif random.random() < 0.12:
            # Occasionally bids on another team
            wtp = fv * random.uniform(0.3, 0.7)

    elif strategy == "trophy_hunter":
        if team_id == own_team:
            wtp = fv * random.uniform(0.8, 1.5) * fomo
        elif any_pct > 0.25:
            # Wants top teams, willing to overpay
            wtp = fv * random.uniform(1.2, 1.8) * fomo
        elif any_pct > 0.18:
            wtp = fv * random.uniform(0.9, 1.3)
        elif random.random() < 0.05:
            wtp = fv * random.uniform(0.4, 0.8)

    elif strategy == "value_hunter":
        if team_id == own_team:
            wtp = fv * random.uniform(0.9, 1.3) * fomo
        else:
            # Bids up to fair value on anything — competes with Poole
            wtp = fv * random.uniform(0.6, 1.0) * fomo

    elif strategy == "social":
        if team_id == own_team:
            wtp = fv * random.uniform(0.8, 1.5) * fomo
        elif random.random() < 0.20:
            # Bids on random teams (friends, gut feeling)
            wtp = fv * random.uniform(0.4, 1.3) * fomo
        # Drunk/excited late in auction
        if auction_progress > 0.7 and random.random() < 0.15:
            wtp = max(wtp, fv * random.uniform(0.5, 1.2) * fomo)

    elif strategy == "women":
        # Women mostly save for women's auction
        if random.random() < 0.15:
            # Occasionally bid on a men's team
            wtp = fv * random.uniform(0.3, 0.8)

    wtp = max(0, wtp)
    # Can't bid more than remaining budget
    wtp = min(wtp, remaining)
    # Round to $5
    wtp = round(wtp / 5) * 5

    return wtp


def escalation_overshoot(bidder, current_price, base_wtp):
    """
    When a bidder is in a contested auction and the price is near their
    planned max, they may escalate past it.

    Returns new max WTP after escalation. Only triggers when price is
    within 80% of their base WTP (they're "invested" in winning).

    Escalation factors:
    - Self-buyers escalate most (ego, "that's MY team")
    - Trophy hunters escalate on top teams (status)
    - Social bidders escalate when drunk/excited
    - Value hunters rarely escalate (disciplined)
    """
    if current_price < base_wtp * 0.80:
        return base_wtp  # not yet invested enough to escalate

    strategy = bidder["strategy"]
    remaining = bidder["budget"] - bidder["spent"]

    if strategy == "self_buyer" and bidder.get("_bidding_own_team"):
        # "I'm not letting someone else buy MY team"
        overshoot = random.uniform(1.10, 1.50)
    elif strategy == "trophy_hunter":
        # Status buy — "I said I wanted Waddell, I'm getting Waddell"
        overshoot = random.uniform(1.05, 1.35)
    elif strategy == "social":
        # Crowd energy, alcohol, "one more bid!"
        overshoot = random.uniform(1.0, 1.25)
    elif strategy == "value_hunter":
        # Disciplined — rarely overshoots
        if random.random() < 0.15:
            overshoot = random.uniform(1.0, 1.10)
        else:
            return base_wtp
    else:
        return base_wtp

    escalated = base_wtp * overshoot
    return min(escalated, remaining)


def run_auction(teams_by_alpha, odds_map, bidders, outcomes, est_pool):
    """
    Simulate one full ascending auction with multiple bidders + Poole.

    Models actual ascending bid dynamics:
    1. Bidding starts at $10, rises in $5 increments
    2. Bidders drop out as price exceeds their WTP
    3. Contested bids trigger escalation — bidders overshoot their
       planned max when emotionally invested
    4. Poole is disciplined — bids up to discounted marginal EV, no escalation

    Returns (poole_teams, all_prices, total_pool).
    """
    n = len(teams_by_alpha)
    poole_teams = []
    poole_set = set()
    poole_spent = 0
    all_prices = {}

    for idx, t in enumerate(teams_by_alpha):
        tid = t["id"]
        fv = fair_value(odds_map[tid], est_pool)
        auction_progress = idx / (n - 1)

        # Compute initial WTP for all bidders
        interested = []  # list of (base_wtp, escalated_wtp, bidder_or_"poole")
        for b in bidders:
            # Tag whether this bidder is bidding on own team (for escalation)
            b["_bidding_own_team"] = (tid == b.get("own_team"))
            w = bidder_wtp(b, tid, fv, odds_map, auction_progress)
            if w >= 10:
                interested.append({"base_wtp": w, "id": b["id"], "bidder": b})

        # Poole's WTP
        poole_remaining = POOLE_BUDGET - poole_spent
        poole_entry = None
        if poole_remaining >= 10:
            mev = marginal_ev(tid, poole_set, outcomes, est_pool)
            poole_wtp = min(mev * POOLE_DISCOUNT, poole_remaining)
            poole_wtp = round(poole_wtp / 5) * 5
            if poole_wtp >= 10:
                poole_entry = {"base_wtp": poole_wtp, "id": "poole", "bidder": None}
                interested.append(poole_entry)

        if not interested:
            all_prices[tid] = 10
            continue

        # Simulate ascending auction with escalation
        # Sort by base WTP to find initial leader
        interested.sort(key=lambda x: -x["base_wtp"])

        if len(interested) == 1:
            # No competition — wins at minimum
            price = 10
            winner = interested[0]
        else:
            # Ascending: price rises to second-highest WTP
            # But as price nears bidders' limits, escalation kicks in

            # Start with base WTPs
            current_wtps = {e["id"]: e["base_wtp"] for e in interested}

            # Iterative escalation: as competitors push the price up,
            # bidders near their limit may escalate
            for _round in range(5):  # max 5 escalation rounds
                sorted_bids = sorted(current_wtps.items(), key=lambda x: -x[1])
                if len(sorted_bids) < 2:
                    break
                top_wtp = sorted_bids[0][1]
                second_wtp = sorted_bids[1][1]
                price_level = second_wtp  # current contested price

                escalated_any = False
                for entry in interested:
                    if entry["id"] == "poole":
                        continue  # Poole doesn't escalate
                    bid_id = entry["id"]
                    old_wtp = current_wtps[bid_id]
                    if old_wtp < price_level * 0.7:
                        continue  # already dropped out, won't escalate
                    new_wtp = escalation_overshoot(
                        entry["bidder"], price_level, old_wtp)
                    if new_wtp > old_wtp:
                        current_wtps[bid_id] = round(new_wtp / 5) * 5
                        escalated_any = True

                if not escalated_any:
                    break

            # Final result: winner pays second-highest + $5
            sorted_final = sorted(current_wtps.items(), key=lambda x: -x[1])
            winner_id = sorted_final[0][0]
            winner_wtp = sorted_final[0][1]
            second_wtp = sorted_final[1][0] if len(sorted_final) >= 2 else 0
            second_val = sorted_final[1][1] if len(sorted_final) >= 2 else 0

            price = min(second_val + 5, winner_wtp)
            winner = next(e for e in interested if e["id"] == winner_id)

        price = max(10, round(price / 5) * 5)
        all_prices[tid] = price

        if winner["id"] == "poole":
            poole_teams.append(tid)
            poole_set.add(tid)
            poole_spent += price
        else:
            b = winner["bidder"]
            b["spent"] += price
            b["bought_count"] += 1

    total_pool = sum(all_prices.values())
    return poole_teams, all_prices, total_pool


def main():
    odds_data = load_json(DATA_DIR / "odds_mens.json")
    teams_data = load_json(DATA_DIR / "teams_mens.json")
    bracket = load_json(DATA_DIR / "bracket_mens.json")

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

    print("=" * 70)
    print("  Calcutta Auction — Multi-Bidder Portfolio-Aware Simulation")
    print(f"  Poole budget: ${POOLE_BUDGET}  |  Auction sims: {AUCTION_SIMS:,}"
          f"  |  Bracket sims: {BRACKET_SIMS:,}")
    print(f"  23 men's bidders + 12 women's bidders")
    print("=" * 70)

    # Show fair values
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

    print(f"\n  Running {AUCTION_SIMS:,} auction simulations...\n")

    profits = []
    teams_bought_count = {}
    total_teams_bought = 0
    total_spent = 0
    total_pools = []
    strategy_counts = {"self_buyer": 0, "trophy_hunter": 0, "value_hunter": 0, "social": 0}

    for sim in range(AUCTION_SIMS):
        if sim % 100 == 0:
            outcomes = presimulate_bracket(bracket, strength_map, teams_map, BRACKET_SIMS)

        # Fresh bidders each auction (new budgets, new strategies)
        bidders = create_bidders(teams_data, n_women=12)
        for b in bidders:
            if b["strategy"] in strategy_counts:
                strategy_counts[b["strategy"]] += 1

        poole_teams, prices, pool = run_auction(
            teams_by_alpha, odds_map, bidders, outcomes, PRIOR_POOL)

        poole_cost = sum(prices[tid] for tid in poole_teams)
        poole_set = set(poole_teams)
        ev_frac = portfolio_ev(poole_set, outcomes)
        avg_winnings = ev_frac * pool * KEEP_FRAC
        profit = avg_winnings - poole_cost

        profits.append(profit)
        total_pools.append(pool)
        total_teams_bought += len(poole_teams)
        total_spent += poole_cost
        for tid in poole_teams:
            teams_bought_count[tid] = teams_bought_count.get(tid, 0) + 1

        if (sim + 1) % 200 == 0:
            running_avg = sum(profits) / len(profits)
            print(f"    ... {sim + 1:,}/{AUCTION_SIMS:,} auctions"
                  f"  (running avg profit: ${running_avg:+.0f})")

    avg_profit = sum(profits) / len(profits)
    median_profit = sorted(profits)[len(profits) // 2]
    positive = sum(1 for p in profits if p > 0)
    min_p = min(profits)
    max_p = max(profits)
    avg_teams = total_teams_bought / AUCTION_SIMS
    avg_spent = total_spent / AUCTION_SIMS
    avg_pool = sum(total_pools) / len(total_pools)

    # Percentiles
    sorted_profits = sorted(profits)
    p10 = sorted_profits[int(len(sorted_profits) * 0.10)]
    p25 = sorted_profits[int(len(sorted_profits) * 0.25)]
    p75 = sorted_profits[int(len(sorted_profits) * 0.75)]
    p90 = sorted_profits[int(len(sorted_profits) * 0.90)]

    # Strategy mix summary
    total_bidders = sum(strategy_counts.values())

    print(f"\n  {'-' * 55}")
    print(f"  MARKET CONDITIONS ({AUCTION_SIMS:,} auctions)")
    print(f"  {'-' * 55}")
    print(f"  Avg auction pool:    ${avg_pool:.0f}")
    for strat, count in sorted(strategy_counts.items(), key=lambda x: -x[1]):
        print(f"  {strat:<18} {count/AUCTION_SIMS:.1f} bidders/auction"
              f"  ({count/total_bidders*100:.0f}%)")

    print(f"\n  {'-' * 55}")
    print(f"  POOLE'S RESULTS")
    print(f"  {'-' * 55}")
    print(f"  Avg teams bought:    {avg_teams:.1f}")
    print(f"  Avg spent:           ${avg_spent:.0f}")
    print(f"  Avg profit:          ${avg_profit:+.0f}")
    print(f"  Median profit:       ${median_profit:+.0f}")
    print(f"  Profitable auctions: {positive}/{AUCTION_SIMS} ({positive/AUCTION_SIMS*100:.0f}%)")
    print(f"")
    print(f"  Profit distribution:")
    print(f"    10th percentile:   ${p10:+.0f}")
    print(f"    25th percentile:   ${p25:+.0f}")
    print(f"    Median:            ${median_profit:+.0f}")
    print(f"    75th percentile:   ${p75:+.0f}")
    print(f"    90th percentile:   ${p90:+.0f}")
    print(f"    Best case:         ${max_p:+.0f}")
    print(f"    Worst case:        ${min_p:+.0f}")

    print(f"\n  Teams most frequently bought by Poole:")
    for tid, count in sorted(teams_bought_count.items(), key=lambda x: -x[1])[:15]:
        name = next(t["name"] for t in teams_data if t["id"] == tid)
        fv = fair_value(odds_map[tid], PRIOR_POOL)
        pct = count / AUCTION_SIMS * 100
        print(f"    {name:<14} bought {count:>5}/{AUCTION_SIMS} "
              f"({pct:>4.0f}%)  FV: ${fv:.0f}")

    # Avg prices paid per team across all auctions
    print(f"\n  Average auction prices (all bidders):")
    price_samples = {}
    for _ in range(200):
        bidders = create_bidders(teams_data, n_women=12)
        _, prices, _ = run_auction(teams_by_alpha, odds_map, bidders, outcomes, PRIOR_POOL)
        for tid, price in prices.items():
            if tid not in price_samples:
                price_samples[tid] = []
            price_samples[tid].append(price)

    print(f"    {'Team':<14} {'Avg Price':>9} {'FairVal':>8} {'Price/FV':>8}")
    print(f"    {chr(9472)*14} {chr(9472)*9} {chr(9472)*8} {chr(9472)*8}")
    for t in sorted(teams_data, key=lambda t: -odds_map[t["id"]]["any"]):
        tid = t["id"]
        fv = fair_value(odds_map[tid], PRIOR_POOL)
        avg_price = sum(price_samples.get(tid, [0])) / max(1, len(price_samples.get(tid, [])))
        ratio = avg_price / fv if fv > 0 else 0
        print(f"    {t['name']:<14} ${avg_price:>8.0f} ${fv:>7.0f}   {ratio:>5.0%}")

    # Example last auction
    print(f"\n  Example portfolio (last auction):")
    if poole_teams:
        cumulative_set = set()
        for tid in poole_teams:
            cumulative_set.add(tid)
            name = next(t["name"] for t in teams_data if t["id"] == tid)
            cost = prices[tid]
            cum_ev = portfolio_ev(cumulative_set, outcomes) * pool * KEEP_FRAC
            print(f"    + {name:<14} paid ${cost:>4}  portfolio EV: ${cum_ev:.0f}")
        print(f"    Total cost: ${poole_cost:.0f}  |  Portfolio EV: ${avg_winnings:.0f}"
              f"  |  Profit: ${profit:+.0f}")

    print(f"\n{'=' * 70}")


if __name__ == "__main__":
    main()
