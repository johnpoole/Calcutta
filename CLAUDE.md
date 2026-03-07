# Calcutta Auction Calculator

Curling bonspiel auction bid calculator — a static SPA that helps bidders analyze win probabilities, expected value, and optimize their portfolio during a Calcutta auction.

## Tech Stack

- **Frontend:** Vanilla JavaScript (ES2020+), HTML5, CSS3, Chart.js (CDN)
- **Data Pipeline:** Python 3 scripts for Monte Carlo simulation and data bundling
- **Deployment:** GitHub Pages via GitHub Actions (push to `main`)
- **No build tools or package managers** — pure static site

## Project Structure

```
index.html              # SPA entry point
js/
  app.js                # Main UI logic and event handlers
  bundled-data.js       # Auto-generated — DO NOT edit manually
  data.js               # State management and localStorage persistence
  odds.js               # Odds loader module
  pool-estimator.js     # EV and payout calculation engine
css/styles.css          # Dark theme styling
scripts/                # Python data pipeline
  update_standings.py   # Reads roster config + standings → teams JSON
  calculate_odds.py     # Monte Carlo bracket simulation (core algorithm)
  bundle_data.py        # Bundles JSON/CSV into js/bundled-data.js
  parse_excel.py        # Parse Excel roster files
  gen_team_info.py      # Generate team info JSON
data/                   # JSON and CSV data files
  roster_mens.json      # Bonspiel team config: maps team IDs → league sources
  poole_team_data.json  # League standings source (Mon/Tue nights)
  teams_{mens,womens}.json    # DERIVED — team records (written by update_standings.py)
  draw_{mens,womens}.json     # Draw structure
  bracket_{mens,womens}.json  # Bracket tree
  odds_{mens,womens}.json     # DERIVED — pre-computed probabilities
  overrides_{mens,womens}.csv # Manual win % overrides (team name, percentage 0-100)
  women_standings.csv         # Women's league standings source
tests/test.html         # Browser-based unit tests
docs/                   # Documentation
```

## Data Flow

Single source of truth: `data/roster_mens.json` maps each bonspiel team to its league team name(s) and league night.

```
roster_mens.json + poole_team_data.json
        ↓  update_standings.py
    teams_mens.json  (DERIVED — do not hand-edit)
        ↓  calculate_odds.py
    odds_mens.json   (DERIVED)
        ↓  bundle_data.py
    bundled-data.js  (DERIVED)
        ↓  app.js syncTeamRecords()
    localStorage     (bids preserved, W-L-T always refreshed from bundled data)
```

**Do not hand-edit `teams_mens.json` or `odds_mens.json`** — they are overwritten by the pipeline. To change a team's record or league mapping, edit `roster_mens.json` and re-run the pipeline.

## Common Commands

```bash
# Local development
python -m http.server 8000    # Serve locally, open http://localhost:8000

# Data pipeline (run in order when updating data)
python scripts/update_standings.py        # Build teams JSON from roster config + standings
python scripts/calculate_odds.py          # Run Monte Carlo simulation
python scripts/bundle_data.py             # Bundle data into JS module

# Full data refresh from source
python scripts/parse_excel.py             # Parse Excel rosters
python scripts/update_standings.py        # Build teams from roster config
python scripts/gen_team_info.py           # Generate team info
python scripts/calculate_odds.py          # Recalculate odds
python scripts/bundle_data.py             # Rebundle for frontend
```

## Key Conventions

- **Module pattern:** All JS modules use `const ModuleName = (() => { ... })()` IIFE pattern
- **'use strict'** in all JS modules
- **No frameworks or build tools** — keep dependencies minimal
- **`js/bundled-data.js` is auto-generated** by `scripts/bundle_data.py` — never edit directly
- **Script load order matters** in index.html: `bundled-data.js` → `pool-estimator.js` → `odds.js` → `data.js` → `app.js`
- **localStorage key:** `calcutta_auction_data` stores all app state
- **Data model:** Teams have `{ id, name, wins, losses, ties, seed }`
- **Win probability:** Bradley-Terry model with Monte Carlo simulation (500K iterations default)
- **Event colors:** A=blue, B=purple, C=green, D=yellow

## Testing

Open `tests/test.html` in a browser — tests run inline with no framework. There is no automated test runner.

## Deployment

Push to `main` branch triggers GitHub Actions (`.github/workflows/pages.yml`) which deploys to GitHub Pages. No build step — the repo is deployed as-is, so `js/bundled-data.js` must be committed.

## Key Algorithms

- **Win probability:** `(wins + ties * 0.5) / totalGames`
- **Bradley-Terry:** `P(A beats B) = strengthA / (strengthA + strengthB)`
- **EV:** `sum(P(event) * poolAmount * payoutPct) * buyBackFactor - bidAmount`
- **Overrides:** `data/overrides_{mens,womens}.csv` allows manual win % adjustments (team name, percentage 0-100)
