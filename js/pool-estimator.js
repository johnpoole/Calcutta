/* ═══════════════════════════════════════════════════════════
   Calcutta Auction — Pool Estimator Module
   Estimates the total pool and per-team payouts using
   prior-year data.

   Logic:
     1. Before any bids: estimated pool = prior year pool
     2. As teams sell: replace their prior with the actual bid
     3. Unsold teams keep their prior (best estimate until sold)
     4. Scale factor = sold_bids / sold_priors  (informational —
        shows whether the auction is running hot or cold)
     5. EV = Σ(P(event) × Payout(event)) − Bid
   ═══════════════════════════════════════════════════════════ */

const PoolEstimator = (() => {
  'use strict';

  /**
   * Estimate the total pool and per-team predicted payouts.
   *
   * @param {Object[]} teams         - team objects
   * @param {Object[]} bids          - bid objects [{ teamId, amount, buyer, selfBuyBack }]
   * @param {Object[]} priorPayouts  - [{ teamId, amount }]
   * @param {number}   priorPool     - last year's total pool
   * @returns {Object[]} predictions per team:
   *   [{ teamId, teamName, bid, selfBuyBack, priorPayout, predictedPayout, scaleFactor }]
   */
  function estimatePayouts(teams, bids, priorPayouts, priorPool) {
    const priorMap = {};
    for (const p of priorPayouts) {
      priorMap[p.teamId] = p.amount;
    }

    // Default prior: even share of last year's pool
    const defaultPrior = priorPool / Math.max(teams.length, 1);

    // Separate sold vs unsold teams
    const bidMap = {};
    for (const b of bids) {
      if (b.amount > 0) bidMap[b.teamId] = b;
    }

    // Compute scaling factor from sold teams (shows whether auction is hot or cold)
    let soldPrior = 0;
    let soldActual = 0;
    for (const tid of Object.keys(bidMap)) {
      const prior = priorMap[tid] ?? defaultPrior;
      soldPrior += prior;
      soldActual += bidMap[tid].amount;
    }
    const scaleFactor = soldPrior > 0 ? (soldActual / soldPrior) : 1.0;

    // soldFraction: how much of the field has sold (0 → 1).
    // Used to progressively blend unsold team priors toward the scale-adjusted
    // estimate as auction data accumulates.  At 0% sold the estimate is pure
    // prior (no data yet); at 100% sold it fully reflects the auction pace.
    const soldFraction = Object.keys(bidMap).length / Math.max(teams.length, 1);

    // Build per-team predictions
    // Sold teams: use actual bid as their pool contribution.
    // Unsold teams: blend prior with scale-adjusted prior, weighted by how
    // much of the field has already sold.
    const results = [];
    for (const team of teams) {
      const bid = bidMap[team.id];
      const bidAmount = bid ? bid.amount : 0;
      const selfBuyBack = bid ? bid.selfBuyBack : false;
      const prior = priorMap[team.id] ?? defaultPrior;

      const predictedPayout = bid
        ? bidAmount
        : prior * (1 - soldFraction + soldFraction * scaleFactor);

      results.push({
        teamId: team.id,
        teamName: team.name,
        bid: bidAmount,
        selfBuyBack,
        priorPayout: prior,
        predictedPayout,
        scaleFactor,
      });
    }

    return results;
  }

  /**
   * Estimate total pool from current bids + projected unsold teams.
   *
   * @param {Object[]} estimates - output from estimatePayouts()
   * @returns {number} estimated total pool
   */
  function estimatedPool(estimates) {
    return estimates.reduce((sum, e) => sum + (e.bid > 0 ? e.bid : e.predictedPayout), 0);
  }

  /**
   * Compute expected value for a team given event probabilities and payouts.
   *
   * By default every skip buys back 25% of winnings ($40 fee),
   * so the buyer keeps only 75% of any payout.
   *   Buyer EV = 0.75 × grossEV − Bid
   *
   * If a skip opts out of the Calcutta entirely (noBuyBack = true),
   * the buyer keeps 100%.
   *
   * @param {Object} probs      - { A, B, C, D } probabilities
   * @param {Object} payouts    - { A, B, C, D } dollar amounts
   * @param {number} bid        - bid amount
   * @param {boolean} noBuyBack - true only if skip opted out of Calcutta
   * @param {Object} buyBackConfig - { fee, payoutPct }
   * @param {Object} [poolCtx]  - optional pool context for elastic optimal bid
   * @param {number} poolCtx.poolWithoutTeam - estimated pool minus this team's contribution
   * @param {Object} poolCtx.payoutPcts      - { A, B, C, D } payout percentages
   * @returns {Object} { grossEV, ev, buyerReturn, buyerEV, optimalBid }
   */
  function computeEV(probs, payouts, bid, noBuyBack = false, buyBackConfig = {}, poolCtx = null) {
    const pct = buyBackConfig.payoutPct ?? 0.25;

    const grossEV = (probs.A * payouts.A) +
                    (probs.B * payouts.B) +
                    (probs.C * payouts.C) +
                    (probs.D * payouts.D);

    // Buyer keeps (1 - pct) of winnings by default (skip buys back 25%).
    // Only if skip opted out entirely does the buyer keep 100%.
    const keepFrac = noBuyBack ? 1.0 : (1 - pct);
    const buyerReturn = grossEV * keepFrac;
    const buyerEV = buyerReturn - bid;

    // Pool-elastic optimal bid: the break-even bid accounting for the
    // fact that your bid increases the pool (and thus your own payout).
    //   weightedProb = Σ(p_i × payoutPct_i)
    //   optimalBid = (keepFrac × wp × poolWithoutTeam) / (1 − keepFrac × wp)
    let optimalBid = buyerReturn; // fallback if no pool context
    if (poolCtx) {
      const wp = (probs.A * poolCtx.payoutPcts.A) +
                 (probs.B * poolCtx.payoutPcts.B) +
                 (probs.C * poolCtx.payoutPcts.C) +
                 (probs.D * poolCtx.payoutPcts.D);
      const kwp = keepFrac * wp;
      optimalBid = kwp < 1 ? (kwp * poolCtx.poolWithoutTeam) / (1 - kwp) : Infinity;
    }

    return { grossEV, ev: buyerEV, buyerReturn, buyerEV, optimalBid };
  }

  /**
   * Compute probability of payback (winnings ≥ cost) for a portfolio.
   * Enumerates all 16 win/loss combinations across the 4 events.
   *
   * @param {Object} portfolioProbs - { A, B, C, D } combined prob that
   *   at least one owned team wins each event
   * @param {Object} payoutAmounts  - { A, B, C, D } dollar payouts per event
   * @param {number} keepFrac       - fraction of winnings the buyer keeps
   * @param {number} totalCost      - total amount spent on all portfolio teams
   * @returns {number} probability that payout × keepFrac ≥ totalCost
   */
  function computePaybackProb(portfolioProbs, payoutAmounts, keepFrac, totalCost) {
    if (totalCost <= 0) return 1;
    const events = ['A', 'B', 'C', 'D'];
    let prob = 0;
    for (let mask = 0; mask < 16; mask++) {
      let p = 1;
      let payout = 0;
      for (let i = 0; i < 4; i++) {
        const e = events[i];
        const pe = Math.min(Math.max(portfolioProbs[e], 0), 1);
        if (mask & (1 << i)) {
          p *= pe;
          payout += payoutAmounts[e];
        } else {
          p *= (1 - pe);
        }
      }
      if (payout * keepFrac >= totalCost) prob += p;
    }
    return prob;
  }

  /**
   * Find the optimal team portfolio within a budget that maximises either
   * P(payback) or expected value.
   *
   * Uses recursive branch-and-bound (exact for up to ~25 candidates).
   *
   * @param {Object}   params
   * @param {Object[]} params.candidates - teams available to buy
   *   [{ teamId, teamName, price, probs:{A,B,C,D} }]
   * @param {Object[]} params.locked - teams already purchased
   *   [{ teamId, teamName, bid, probs:{A,B,C,D} }]
   * @param {number}   params.budget     - total budget
   * @param {number}   params.estPool    - estimated total auction pool
   * @param {Object}   params.payoutPcts - { A, B, C, D }
   * @param {number}   params.keepFrac   - buyer keep fraction (e.g. 0.75)
   * @param {string}   params.objective  - 'payback' | 'ev'
   * @returns {Object} optimal portfolio result
   */
  function optimizeBudget(params) {
    const { candidates, locked, budget, estPool, payoutPcts, keepFrac,
            objective = 'payback' } = params;

    const payoutAmounts = {
      A: estPool * payoutPcts.A,
      B: estPool * payoutPcts.B,
      C: estPool * payoutPcts.C,
      D: estPool * payoutPcts.D,
    };

    const lockedSpend = locked.reduce((s, t) => s + t.bid, 0);
    const lA = locked.reduce((s, t) => s + t.probs.A, 0);
    const lB = locked.reduce((s, t) => s + t.probs.B, 0);
    const lC = locked.reduce((s, t) => s + t.probs.C, 0);
    const lD = locked.reduce((s, t) => s + t.probs.D, 0);

    const remaining = Math.max(0, budget - lockedSpend);

    // Sort by price ascending so we can prune branches early
    const sorted = [...candidates].sort((a, b) => a.price - b.price);
    const n = Math.min(sorted.length, 25); // cap for performance

    let bestMask = 0;
    let bestScore = -Infinity;
    let bestCost = Infinity;

    function score(pA, pB, pC, pD, totalSpend) {
      if (objective === 'ev') {
        return keepFrac * (pA * payoutAmounts.A + pB * payoutAmounts.B +
                           pC * payoutAmounts.C + pD * payoutAmounts.D)
               - totalSpend;
      }
      return computePaybackProb(
        { A: pA, B: pB, C: pC, D: pD },
        payoutAmounts, keepFrac, totalSpend
      );
    }

    function search(idx, cost, pA, pB, pC, pD, mask) {
      const totalSpend = lockedSpend + cost;
      const s = score(pA, pB, pC, pD, totalSpend);
      if (s > bestScore || (s === bestScore && cost < bestCost)) {
        bestScore = s;
        bestMask = mask;
        bestCost = cost;
      }
      for (let i = idx; i < n; i++) {
        const c = sorted[i];
        const nc = cost + c.price;
        if (nc > remaining) break; // all subsequent are more expensive
        search(i + 1, nc,
               pA + c.probs.A, pB + c.probs.B,
               pC + c.probs.C, pD + c.probs.D,
               mask | (1 << i));
      }
    }

    search(0, 0, lA, lB, lC, lD, 0);

    // Build result from best mask
    const selected = [];
    let finalCost = 0;
    let fA = lA, fB = lB, fC = lC, fD = lD;
    for (let i = 0; i < n; i++) {
      if (bestMask & (1 << i)) {
        selected.push(sorted[i]);
        finalCost += sorted[i].price;
        fA += sorted[i].probs.A;
        fB += sorted[i].probs.B;
        fC += sorted[i].probs.C;
        fD += sorted[i].probs.D;
      }
    }

    const totalSpend = lockedSpend + finalCost;
    const finalProbs = { A: fA, B: fB, C: fC, D: fD };
    const expectedReturn = keepFrac * (
      fA * payoutAmounts.A + fB * payoutAmounts.B +
      fC * payoutAmounts.C + fD * payoutAmounts.D
    );

    return {
      selected,
      locked,
      totalSpend,
      lockedSpend,
      candidateSpend: finalCost,
      budgetRemaining: budget - totalSpend,
      expectedReturn,
      ev: expectedReturn - totalSpend,
      paybackProb: computePaybackProb(finalProbs, payoutAmounts, keepFrac, totalSpend),
      // Union bound: exact when events are mutually exclusive per team (they always are
      // for a single team), and a conservative lower bound for a multi-team portfolio
      // where different teams can win different events simultaneously.
      pWinAny: Math.min(1, fA + fB + fC + fD),
      portfolioProbs: finalProbs,
      payoutAmounts,
      objective,
      allCandidates: sorted,
    };
  }

  return {
    estimatePayouts,
    estimatedPool,
    computeEV,
    computePaybackProb,
    optimizeBudget,
  };
})();
