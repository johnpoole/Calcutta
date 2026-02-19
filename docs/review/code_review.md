# Calcutta App — Code Review
**Date:** February 19, 2026  
**Reviewer:** GitHub Copilot  
**Scope:** Full review of all JavaScript modules (`data.js`, `odds.js`, `pool-estimator.js`, `app.js`) and the Python odds pipeline (`calculate_odds.py`).

---

## Architecture Overview

The app is a single-page curling Calcutta auction tool with:
- **`data.js`** — in-memory state + localStorage persistence
- **`odds.js`** — synchronous wrapper over pre-bundled win probabilities
- **`pool-estimator.js`** — pool estimation and EV/optimizer math
- **`app.js`** — UI rendering, event binding, orchestration
- **`scripts/calculate_odds.py`** — Monte Carlo simulator (run offline; output bundled)
- **`scripts/bundle_data.py`** — packs Python output into `bundled-data.js`

Data flow:
```
standings / draw (JSON)
        ↓
  calculate_odds.py  (Monte Carlo simulation)
        ↓
  bundle_data.py     (packs into bundled-data.js)
        ↓
  app.js (loads odds → computes EV → renders UI)
```

---

## Module Reviews

---

### `data.js` — State & Persistence

**Strengths:**
- Clean IIFE module pattern with explicit public API.
- `structuredClone` on `DEFAULT_CONFIG` prevents accidental mutation.
- Deep merge on `load()` ensures new config keys survive deploys.
- `winPct`, `totalPool`, `eventPayouts` are pure computed helpers.

**Issues:**

#### [LOW] Shallow merge on `importJSON` may drop new sub-object fields
`importJSON` replaces `state.mens`/`state.womens` wholesale. If a new field
(e.g. `priorPayouts`) is added later, importing an old export will silently
drop that field rather than merging it in.

```js
// Current
if (parsed.mens) state.mens = parsed.mens;

// Safer
if (parsed.mens) state.mens = { ...state.mens, ...parsed.mens };
```

#### [LOW] `winPct` uses single-team record only
The standings tab displays single-team win% while the odds engine uses a
combined Mon+Tue record. This divergence is technically correct (they are
different things) but could confuse users who expect standings to match odds.
Consider adding a tooltip or note.

#### [LOW] `clearAll` does not resync division toggle buttons
After `clearAll()`, the in-memory `activeDivision` resets to `'mens'` but the
`.div-btn.active` CSS class may still show "Womens" if that was selected.
`renderAll()` does not touch the toggle button DOM.

#### [LOW] `totalPool` does not account for buy-back fees
Buy-back fees ($40/team) are collected but not added to the pool. Confirm
whether this is intentional (fees go to organizer, not back into pool).

---

### `odds.js` — Odds Loader

**Strengths:**
- Correct async wrapper pattern preserves existing call sites.
- `mapToTeams` handles missing teams gracefully.

**Issues:**

#### [LOW] Silent zero-fill for unmatched teams
If a team's ID in the team list has no corresponding odds entry (e.g. after a
partial rebundle), `mapToTeams` fills all probabilities with 0. EV will show
$0 with no warning, which could be misread as "this team has no value."

```js
// Add a warn:
if (!o) console.warn(`No odds for team ${t.id} (${t.name})`);
```

---

### `pool-estimator.js` — Pool & EV Math

**Strengths:**
- Pool estimation logic is sound: actual bids replace priors for sold teams;
  unsold teams keep their prior. This prevents one outlier sale from
  distorting all projections.
- `computePaybackProb` correctly enumerates all 16 event-win combinations.
- Branch-and-bound optimizer is exact for ≤25 candidates; price-ascending
  sort enables correct early pruning.

**Issues:**

#### [MEDIUM] `pWinAny` uses independence approximation — can mislead
The formula:
```js
1 - (1 - fA) * (1 - fB) * (1 - fC) * (1 - fD)
```
treats the four event outcomes as independently Bernoulli-distributed. For a
*portfolio* of teams, `fA` is the sum of individual A-event probabilities
across all held teams. Because a team can only win one event, A/B/C/D are
mutually exclusive *per team*, so treating them as independent at the portfolio
level overstates P(win any). A team with 50% in every event would yield ~94%,
which is misleading.

A more accurate (conservative) estimate:
```js
Math.min(1, fA + fB + fC + fD)   // union bound
```
Or use the `computePaybackProb` enumeration with a $0 break-even threshold.

#### [LOW] Candidate price uses `predictedPayout`, not `optimalBid`
In `runBudgetOptimizer`, each candidate's price is:
```js
Math.max(5, Math.round((a.predictedPayout || 50) / 5) * 5)
```
Teams with very low priors get priced at $5 regardless of actual EV. This is
an intentional simplification but can cause the optimizer to underweight
strong-value low-prior teams. Consider using `optimalBid` as the price
(clamped to a minimum).

#### [LOW] `optimalBid` pool context is slightly off before auction starts
`poolWithoutTeam` subtracts either `est.bid` (if sold) or `est.predictedPayout`
(if unsold). Before auction, `predictedPayout = prior`, so the context pool
may not reflect reality well if the prior is far from the actual expected bid.
This is inherent to pre-auction estimates; a comment acknowledging this would
help maintainers.

---

### `app.js` — UI / Orchestration

**Strengths:**
- Clean tab/section structure.
- `saveRow()` fires on every bid change — data is never lost.
- `runFullAnalysis` gracefully falls back to odds-derived priors when no
  historical payout data exists.
- `autoLoadData()` on first run gives a good out-of-box experience.

**Issues:**

#### [HIGH] `selfBuyBack` checkbox is saved but never used in EV math
The checkbox is rendered and persisted to the `bid` object, but `runFullAnalysis`
never reads `bid.selfBuyBack` back. The `noBuyBack` parameter in `computeEV` is
always `false`:

```js
// Current — always false:
const noBuyBack = est.noBuyBack || false;

// Should be:
const bid = bids.find(b => b.teamId === est.teamId);
const noBuyBack = bid?.selfBuyBack === false;  // unchecked = opted out = no buy-back
```

Note: confirm checkbox semantics — is "checked" = "will buy back" (buyer keeps
75%) or "checked" = "opted out of buy-back" (buyer keeps 100%)?

#### [HIGH] `btn-clear-all` leaves app in blank/broken state
After `clearAll()`, `getTeams()` returns `[]` and all panels show "No data."
The user must manually reload the page to restore bundled data. The handler
should call `autoLoadData()` + `loadPrecomputedOdds()` + `runFullAnalysis()`
after clearing.

```js
document.getElementById('btn-clear-all').addEventListener('click', async () => {
  if (confirm('This will delete ALL data. Are you sure?')) {
    CalcuttaData.clearAll();
    syncSettingsUI();
    cachedOdds = [];
    cachedAnalysis = [];
    await autoLoadData();            // ← add
    loadBracketTree();               // ← add
    await loadPrecomputedOdds();     // ← add
    renderAll();
    runFullAnalysis();               // ← add
  }
});
```

#### [MEDIUM] Optimizer buyer dropdown resets on every `renderAll` call
`populateOptimizerBuyerDropdown()` re-reads `select.value` from the DOM via
`prev = select.value`, but immediately wipes the DOM with `innerHTML = ...`
before restoring. If `prev` is empty (first load), it falls through to
`select.value = 'Poole'`. However, any full `renderAll()` triggered by a bid
change will reset the dropdown to "Poole" if the user had changed it to
something not yet saved in a bid.

Fix: store the selected optimizer buyer in a module-level variable.

```js
let optimizerBuyer = 'Poole';

function populateOptimizerBuyerDropdown() {
  const select = document.getElementById('opt-buyer');
  if (!select) return;
  // ... build options ...
  select.value = optimizerBuyer;
}

// In the optimizer buyer select change handler:
select.addEventListener('change', () => { optimizerBuyer = select.value; });
```

#### [LOW] Charts skip rendering when tab is not active
`renderOddsChart` and `renderEVChart` check `rect.width < 10` and silently
return when the tab is hidden (display:none → zero width). Charts only render
correctly the first time a hidden tab becomes visible after a render cycle.
This is handled by `renderAll()` being called on tab switch, so it works, but
if a render is triggered *while* a non-active tab is shown, that tab's chart
will be blank until the user clicks away and back.

A robust fix is to skip chart rendering entirely in `renderAll` and only render
charts inside `bindTabs` on tab activation.

#### [LOW] Negative bid amounts are accepted
There is no client-side validation on bid `amount` inputs. A negative value is
saved to state and subtracts from `totalPool()`, which flows into all payout
and EV calculations.

```js
// In saveRow():
const amount = Math.max(0, parseFloat(row.querySelector('[data-field="amount"]').value) || 0);
```

#### [INFO] No staleness warning for bundled odds
If teams or draw change but `bundle_data.py` is not re-run, the in-app odds
are silently stale. Consider embedding a generation timestamp in
`bundled-data.js` and displaying it in the UI (e.g. "Odds generated: Feb 17,
2026").

---

## Issue Summary Table

| # | Severity | Module | Issue |
|---|----------|--------|-------|
| 1 | **High** | `app.js` | `selfBuyBack` checkbox saves but is never read back into EV math |
| 2 | **High** | `app.js` | `btn-clear-all` leaves app blank — should reload bundled data |
| 3 | **Medium** | `pool-estimator.js` | `pWinAny` independence approximation can mislead |
| 4 | **Medium** | `app.js` | Optimizer buyer dropdown resets on every `renderAll` |
| 5 | **Low** | `odds.js` | Silent zero-fill for unmatched teams, no console warning |
| 6 | **Low** | `data.js` | `importJSON` shallow merge can drop new sub-object fields |
| 7 | **Low** | `data.js` | `clearAll` doesn't resync division toggle button CSS |
| 8 | **Low** | `app.js` | Charts don't render when tab is inactive during a render cycle |
| 9 | **Low** | `app.js` | Negative bid amounts accepted without validation |
| 10 | **Info** | Pipeline | No staleness indicator for bundled odds |
