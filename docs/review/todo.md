# Calcutta App — Fix Plan & Todo
Generated: February 19, 2026  
Source: docs/review/code_review.md

---

## Priority 1 — High (Fix Before Auction)

### [TODO-1] Wire `selfBuyBack` checkbox into EV calculation
**File:** `js/app.js` — `runFullAnalysis()`  
**Impact:** EV, Optimal Bid, and Buyer Return columns are wrong for all teams
because the buyer keep-fraction is hardcoded to 75% regardless of the
checkbox.

**Plan:**
1. Confirm semantics: is the checkbox "skip WILL buy back" (checked = buyer
   keeps 75%) or "skip opted OUT" (checked = buyer keeps 100%)?
2. In `runFullAnalysis`, inside the per-team loop, read:
   ```js
   const bid = bids.find(b => b.teamId === est.teamId);
   const noBuyBack = bid ? (bid.selfBuyBack === false) : false;
   ```
   (adjust for confirmed checkbox semantics)
3. Pass `noBuyBack` to `PoolEstimator.computeEV(...)`.
4. Re-run and verify EV changes for teams with buy-back unchecked.

**Test:** Uncheck buy-back for one team, confirm Buyer Return = grossEV (100%
keep) and Optimal Bid increases.

---

### [TODO-2] Fix `btn-clear-all` to restore bundled data
**File:** `js/app.js` — `bindSettingsActions()`  
**Impact:** After clearing, the app is completely blank and unusable until the
user manually reloads the page.

**Plan:**
1. After `CalcuttaData.clearAll()`, rebuild state from bundled data:
   ```js
   await autoLoadData();
   loadBracketTree();
   await loadPrecomputedOdds();
   renderAll();
   runFullAnalysis();
   ```
2. Update the confirm dialog message to say "This will clear all bids and
   settings. Team data will be reloaded from bundled data."

**Test:** Enter some bids, click "Clear All Data", confirm bids are gone but
teams and odds still show.

---

## Priority 2 — Medium (Fix Before or Soon After Auction)

### [TODO-3] Fix optimizer buyer dropdown resetting on `renderAll`
**File:** `js/app.js` — `populateOptimizerBuyerDropdown()`  
**Impact:** If the user changes the buyer in the optimizer and then updates any
bid, the dropdown snaps back to "Poole".

**Plan:**
1. Add a module-level variable: `let optimizerBuyer = 'Poole';`
2. Change `populateOptimizerBuyerDropdown` to use/set that variable instead
   of reading `select.value` from the DOM.
3. Bind a `change` listener on `#opt-buyer` that updates `optimizerBuyer`.
   (Do this once in `bindBidActions` or a new `bindOptimizerActions`.)

**Test:** Change buyer to another name, update a bid amount, confirm dropdown
stays on the selected name.

---

### [TODO-4] Fix `pWinAny` independence approximation in optimizer
**File:** `js/pool-estimator.js` — `optimizeBudget()`  
**Impact:** P(Any Win) display in optimizer results can be inflated,
particularly when the portfolio holds strong favorites.

**Plan:**
1. Replace the independence formula:
   ```js
   // Old
   1 - Math.max(0, 1 - fA) * Math.max(0, 1 - fB) * ...
   // New (union bound — conservative, always correct)
   Math.min(1, fA + fB + fC + fD)
   ```
   Or use `computePaybackProb` with `totalCost = 0` to get a probability-
   consistent answer.
2. Update the result card label to clarify what it means.

**Test:** Portfolio with one team having 80% in all four events. Old formula
~99.8%, corrected formula = min(1, 3.2) = 100% (union bound floors at 1), or
~80% if using payback prob with cost=0.

---

## Priority 3 — Low (Cleanup / Polish)

### [TODO-5] Add console warning for unmatched teams in `mapToTeams`
**File:** `js/odds.js` — `mapToTeams()`  
**Plan:**
```js
if (!o) console.warn(`No odds for team ${t.id} (${t.name}) — using zeros`);
```

---

### [TODO-6] Fix shallow merge in `importJSON`
**File:** `js/data.js` — `importJSON()`  
**Plan:**
```js
// Replace:
if (parsed.mens) state.mens = parsed.mens;
// With:
if (parsed.mens) state.mens = { ...state.mens, ...parsed.mens };
```
Same for `womens`.

---

### [TODO-7] Resync division toggle buttons after `clearAll`
**File:** `js/app.js` — after `CalcuttaData.clearAll()` call  
**Plan:** After clear+reload, force all `.div-btn` to reflect `activeDivision`:
```js
document.querySelectorAll('.div-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.division === CalcuttaData.activeDivision);
});
```

---

### [TODO-8] Validate bid amounts (reject negatives)
**File:** `js/app.js` — `saveRow()`  
**Plan:**
```js
const amount = Math.max(0, parseFloat(row.querySelector('[data-field="amount"]').value) || 0);
```

---

### [TODO-9] Only render charts on tab activation, not in `renderAll`
**File:** `js/app.js` — `renderOddsChart`, `renderEVChart`, `bindTabs()`  
**Impact:** Charts are blank if a render fires while their tab is inactive.  
**Plan:**
1. Remove chart rendering calls from `renderAll`.
2. Call chart rendering in `bindTabs` after activating each tab:
   ```js
   if (btn.dataset.tab === 'odds') renderOddsChart(cachedOdds);
   if (btn.dataset.tab === 'analysis') renderEVChart(cachedAnalysis);
   ```

---

## Priority 4 — Info / Future (Nice to Have)

### [TODO-10] Show bundled odds generation timestamp in UI
**Files:** `scripts/bundle_data.py`, `js/app.js`  
**Plan:**
1. In `bundle_data.py`, add a `generatedAt` timestamp to `BundledData`:
   ```python
   "generatedAt": datetime.now().isoformat()
   ```
2. In the Settings tab or Odds tab header, display:
   ```
   Odds generated: {BundledData.generatedAt}
   ```

---

## Execution Order

```
Week of auction:
  [TODO-1] selfBuyBack EV fix          ← most impactful for correct numbers
  [TODO-2] clear-all restore fix        ← prevents data loss confusion
  [TODO-3] optimizer buyer fix          ← UX annoyance during live auction
  [TODO-4] pWinAny formula fix          ← display accuracy

Post-auction / next year:
  [TODO-5] odds.js warning
  [TODO-6] importJSON merge fix
  [TODO-7] division toggle resync
  [TODO-8] negative bid validation
  [TODO-9] chart render on tab activate
  [TODO-10] odds timestamp
```
