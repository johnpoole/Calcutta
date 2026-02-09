/* ═══════════════════════════════════════════════════════════
   Calcutta Auction — Kalman Filter Module
   Predicts current-year payouts from prior-year data and
   this year's bids.
   ═══════════════════════════════════════════════════════════ */

const KalmanFilter = (() => {
  'use strict';

  /**
   * Single-variable Kalman Filter
   *
   * State: estimated payout for a team
   * Measurement: this year's bid-implied value
   *
   * predict  →  x̂ₖ⁻ = x̂ₖ₋₁  (constant model)
   *             Pₖ⁻ = Pₖ₋₁ + Q
   * update   →  Kₖ  = Pₖ⁻ / (Pₖ⁻ + R)
   *             x̂ₖ  = x̂ₖ⁻ + Kₖ (zₖ − x̂ₖ⁻)
   *             Pₖ  = (1 − Kₖ) Pₖ⁻
   *
   * @param {number} priorEstimate  - last year's payout (x̂₀)
   * @param {number} measurement    - this year's bid-implied value (z)
   * @param {Object} params         - { Q, R, P0 }
   * @returns {Object} { estimate, gain, uncertainty }
   */
  function singleStep(priorEstimate, measurement, params = {}) {
    const Q  = params.Q  ?? 100;   // process noise
    const R  = params.R  ?? 200;   // measurement noise
    const P0 = params.P0 ?? 500;   // initial uncertainty

    // Predict
    const xPrior = priorEstimate;
    const pPrior = P0 + Q;

    // Update
    const K = pPrior / (pPrior + R);
    const xPost = xPrior + K * (measurement - xPrior);
    const pPost = (1 - K) * pPrior;

    return {
      priorEstimate: xPrior,
      estimate: xPost,
      gain: K,
      uncertainty: pPost,
    };
  }

  /**
   * Multi-step Kalman over an array of measurements.
   * Useful when we have multiple years of historical data.
   *
   * @param {number}   x0            - initial estimate
   * @param {number[]} measurements  - array of observed values
   * @param {Object}   params        - { Q, R, P0 }
   * @returns {Object[]} array of { estimate, gain, uncertainty } per step
   */
  function multiStep(x0, measurements, params = {}) {
    const Q  = params.Q  ?? 100;
    const R  = params.R  ?? 200;
    let P    = params.P0 ?? 500;
    let x    = x0;
    const results = [];

    for (const z of measurements) {
      // Predict
      const pPrior = P + Q;
      // Update
      const K = pPrior / (pPrior + R);
      x = x + K * (z - x);
      P = (1 - K) * pPrior;

      results.push({
        estimate: x,
        gain: K,
        uncertainty: P,
      });
    }

    return results;
  }

  /**
   * Predict payouts for all teams in a division.
   *
   * For each team:
   *   - prior = last year's actual payout (or pool share estimate)
   *   - measurement = this year's bid as a proportion of the pool
   *                   scaled to expected pool size
   *
   * @param {Object[]} teams         - team objects
   * @param {Object[]} bids          - bid objects
   * @param {Object[]} priorPayouts  - [{ teamId, amount }]
   * @param {number}   priorPool     - last year's total pool
   * @param {number}   currentPool   - this year's total pool
   * @param {Object}   payoutPcts    - { A, B, C, D }
   * @param {Object}   kalmanParams  - { Q, R, P0 }
   * @returns {Object[]} predictions per team
   */
  function predictPayouts(teams, bids, priorPayouts, priorPool, currentPool, payoutPcts, kalmanParams) {
    const results = [];
    const totalPayout = currentPool; // the entire pool is paid out across events

    for (const team of teams) {
      const bid = bids.find(b => b.teamId === team.id);
      const bidAmount = bid ? bid.amount : 0;

      // Prior: last year's payout for this team, or share of pool
      const prior = priorPayouts.find(p => p.teamId === team.id);
      const priorValue = prior ? prior.amount : (priorPool / Math.max(teams.length, 1));

      // Measurement: this year's bid implies the market values the team at this level
      // Scale bid relative to pool to get an "implied payout"
      const bidShare = currentPool > 0 ? bidAmount / currentPool : 0;
      const impliedPayout = bidShare * totalPayout * 2; // market-implied (bids tend to be ~50% of expected value)

      const kf = singleStep(priorValue, impliedPayout || priorValue, kalmanParams);

      results.push({
        teamId: team.id,
        teamName: team.name,
        bid: bidAmount,
        priorEstimate: kf.priorEstimate,
        predictedPayout: kf.estimate,
        kalmanGain: kf.gain,
        uncertainty: kf.uncertainty,
        selfBuyBack: bid ? bid.selfBuyBack : false,
      });
    }

    return results;
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
   * @returns {Object} { ev, evWithBuyBack, optimalBid }
   */
  function computeEV(probs, payouts, bid, selfBuyBack = false, buyBackConfig = {}) {
    const fee = buyBackConfig.fee ?? 40;
    const pct = buyBackConfig.payoutPct ?? 0.25;

    // Raw EV from buyer's perspective
    const grossEV = (probs.A * payouts.A) +
                    (probs.B * payouts.B) +
                    (probs.C * payouts.C) +
                    (probs.D * payouts.D);

    const ev = grossEV - bid;

    // If team self-buys-back, they get buyBackPct of any payout for an extra fee
    let evWithBuyBack = ev;
    if (selfBuyBack) {
      const buyBackEV = (probs.A * payouts.A * pct) +
                        (probs.B * payouts.B * pct) +
                        (probs.C * payouts.C * pct) +
                        (probs.D * payouts.D * pct) - fee;
      evWithBuyBack = ev + buyBackEV;
    }

    // Optimal bid = gross expected value (break-even point)
    const optimalBid = grossEV;

    return {
      grossEV,
      ev,
      evWithBuyBack,
      optimalBid,
    };
  }

  // ── Public API ─────────────────────────────────────────
  return {
    singleStep,
    multiStep,
    predictPayouts,
    computeEV,
  };
})();
