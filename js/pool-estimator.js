/* ═══════════════════════════════════════════════════════════
   Calcutta Auction — Pool Estimator Module
   Estimates the total pool and per-team payouts using
   prior-year scaling.

   Logic:
     1. Before any bids: estimated pool = prior year pool
     2. As teams sell: compute a scaling factor from
        (actual bids for sold teams) / (prior payouts for sold teams)
     3. Unsold teams are projected at their prior payout × scale
     4. EV = Σ(P(event) × Payout(event)) − Bid
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

    // Compute scaling factor from sold teams
    let soldPrior = 0;
    let soldActual = 0;
    for (const tid of Object.keys(bidMap)) {
      const prior = priorMap[tid] ?? defaultPrior;
      soldPrior += prior;
      soldActual += bidMap[tid].amount;
    }

    // Scale factor: how the auction is trending vs last year
    // If no teams sold yet, scale = 1 (use prior as-is)
    const scaleFactor = soldPrior > 0 ? (soldActual / soldPrior) : 1.0;

    // Build per-team predictions
    const results = [];
    for (const team of teams) {
      const bid = bidMap[team.id];
      const bidAmount = bid ? bid.amount : 0;
      const selfBuyBack = bid ? bid.selfBuyBack : false;
      const prior = priorMap[team.id] ?? defaultPrior;

      // Predicted payout for this team:
      //   - If sold: use actual bid as market-clearing value
      //   - If unsold: scale their prior payout by the auction trend
      const predictedPayout = bid ? bidAmount : (prior * scaleFactor);

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
   * EV = Σ(P(event) × Payout(event)) − Bid
   * For self buy-back: team owner gets buyBackPct of payout for $buyBackFee extra
   *
   * @param {Object} probs      - { A, B, C, D } probabilities
   * @param {Object} payouts    - { A, B, C, D } dollar amounts
   * @param {number} bid        - bid amount
   * @param {boolean} selfBuyBack
   * @param {Object} buyBackConfig - { fee, payoutPct }
   * @returns {Object} { grossEV, ev, evWithBuyBack, optimalBid }
   */
  function computeEV(probs, payouts, bid, selfBuyBack = false, buyBackConfig = {}) {
    const fee = buyBackConfig.fee ?? 40;
    const pct = buyBackConfig.payoutPct ?? 0.25;

    const grossEV = (probs.A * payouts.A) +
                    (probs.B * payouts.B) +
                    (probs.C * payouts.C) +
                    (probs.D * payouts.D);

    const ev = grossEV - bid;

    let evWithBuyBack = ev;
    if (selfBuyBack) {
      const buyBackEV = (probs.A * payouts.A * pct) +
                        (probs.B * payouts.B * pct) +
                        (probs.C * payouts.C * pct) +
                        (probs.D * payouts.D * pct) - fee;
      evWithBuyBack = ev + buyBackEV;
    }

    const optimalBid = grossEV;

    return { grossEV, ev, evWithBuyBack, optimalBid };
  }

  return {
    estimatePayouts,
    estimatedPool,
    computeEV,
  };
})();
