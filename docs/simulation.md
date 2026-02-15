# Calcutta Simulation — How It Works

## Overview

The odds calculator (`scripts/calculate_odds.py`) runs a **Monte Carlo simulation** — it plays the entire bonspiel 500,000 times and counts how often each team wins each event.

## Team Strength

Each team's strength is their **win percentage** from regular-season standings:

```
strength = (wins + ties × 0.5) / games_played
```

Teams with no games played default to 0.5.

## Game Outcome Model (Bradley-Terry)

When two teams play, the probability of Team A beating Team B is:

```
P(A wins) = strength_A / (strength_A + strength_B)
```

**Example:** Moss (9-1, strength 0.9) vs Feilding (1-10, strength 0.091):
- P(Moss wins) = 0.9 / (0.9 + 0.091) = **90.8%**

**Example:** Moss (0.9) vs Carson (8-2, strength 0.8):
- P(Moss wins) = 0.9 / (0.9 + 0.8) = **52.9%**

This model is relatively gentle — even large skill gaps don't produce extreme probabilities, which reflects curling's inherent variance.

## Bracket Flow

Each simulated bonspiel follows the actual bracket structure in order:

1. **A-Event qualifiers** — First-round games between all teams. Winners advance within A; losers drop to B-event slots.
2. **B-Event qualifiers** — Losers from A play through B brackets. Winners advance to Championship; losers drop to C-event slots.
3. **Championship bracket** — A and B qualifier winners play quarterfinals, semifinals, and a final. The winner takes the **Championship (40% payout)**. Quarterfinal/semifinal losers form the Consolation bracket; the Consolation winner takes **30% payout**.
4. **C-Event** — Teams who lost in B-event play through the C bracket. Winner takes **15% payout**.
5. **D-Event** — Teams who lost the B-event qualifier finals play. Winner takes **15% payout**.

Losers flow between events via named slots (e.g., `B2`, `C5`). The bracket JSON files define the exact tree structure and slot mappings.

## Simulation Loop

```
For each of 500,000 iterations:
    1. Clear the slot map (tracks which team fills each loser slot)
    2. Simulate all A-Event qualifier trees
       - Each game: random outcome weighted by Bradley-Terry probability
       - Losers are placed into their designated B-event slots
    3. Simulate all B-Event qualifier trees
       - Slots are resolved to the actual losers from step 2
       - Losers placed into C-event and D-event slots
    4. Simulate Championship + Consolation brackets
       - Record the Championship and Consolation winners
    5. Simulate C-Event tree → record winner
    6. Simulate D-Event tree → record winner
```

## Output

After all iterations, the win count for each team in each event is divided by 500,000 to produce probabilities:

| Team | Champ (A) | Consolation (B) | C Event | D Event | Any |
|------|-----------|-----------------|---------|---------|-----|
| Moss | 12.5% | 9.4% | 5.1% | 6.0% | 33.0% |
| ... | ... | ... | ... | ... | ... |

The probabilities for each event sum to ~100% across all teams (within Monte Carlo noise).

## Expected Value Calculation

For auction bidding, expected value uses these probabilities:

```
Gross EV = P(A) × Pool × 40% + P(B) × Pool × 30% + P(C) × Pool × 15% + P(D) × Pool × 15%
Buyer EV = Gross EV × 75% − Bid
```

The 75% factor reflects the standard $40 buy-back: every skip buys back 25% of their team's winnings.

The sum of all teams' Buyer EV equals 75% of the total pool (before subtracting bids).
