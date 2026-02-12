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

    // Compute scaling factor from sold teams (informational)
    let soldPrior = 0;
    let soldActual = 0;
    for (const tid of Object.keys(bidMap)) {
      const prior = priorMap[tid] ?? defaultPrior;
      soldPrior += prior;
      soldActual += bidMap[tid].amount;
    }
    const scaleFactor = soldPrior > 0 ? (soldActual / soldPrior) : 1.0;

    // Build per-team predictions
    // Sold teams: use actual bid as their pool contribution
    // Unsold teams: use prior as best estimate (stable — one
    // cheap/expensive sale doesn't distort the whole pool)
    const results = [];
    for (const team of teams) {
      const bid = bidMap[team.id];
      const bidAmount = bid ? bid.amount : 0;
      const selfBuyBack = bid ? bid.selfBuyBack : false;
      const prior = priorMap[team.id] ?? defaultPrior;

      const predictedPayout = bid ? bidAmount : prior;

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
   * Without buy-back: EV = grossEV − Bid
   * With buy-back: the skip paid $fee to buy back 25% of winnings,
   *   so the buyer only keeps 75% of any payout.
   *   Buyer EV = 0.75 × grossEV − Bid
   *
   * @param {Object} probs      - { A, B, C, D } probabilities
   * @param {Object} payouts    - { A, B, C, D } dollar amounts
   * @param {number} bid        - bid amount
   * @param {boolean} selfBuyBack
   * @param {Object} buyBackConfig - { fee, payoutPct }
   * @returns {Object} { grossEV, ev, buyerReturn, buyerEV, optimalBid }
   */
  function computeEV(probs, payouts, bid, selfBuyBack = false, buyBackConfig = {}) {
    const pct = buyBackConfig.payoutPct ?? 0.25;

    const grossEV = (probs.A * payouts.A) +
                    (probs.B * payouts.B) +
                    (probs.C * payouts.C) +
                    (probs.D * payouts.D);

    // Buyer keeps (1 - pct) of winnings when buy-back is active
    const buyerReturn = selfBuyBack ? grossEV * (1 - pct) : grossEV;
    const buyerEV = buyerReturn - bid;

    const optimalBid = buyerReturn;

    return { grossEV, ev: buyerEV, buyerReturn, buyerEV, optimalBid };
  }

  return {
    estimatePayouts,
    estimatedPool,
    computeEV,
  };
})();
