"""Generate random league records for testing the full flow."""
import json, random
from pathlib import Path

random.seed(2026)
DATA = Path(r'c:\Users\jdpoo\Documents\GitHub\Calcutta\data')

for division in ['mens', 'womens']:
    teams = json.loads((DATA / f'teams_{division}.json').read_text())
    n = len(teams)
    ids = [t['id'] for t in teams]

    # Derive W/L/T from 18-22 league games per team (no score tracking)
    for t in teams:
        gp = random.randint(18, 22)
        ties = random.randint(0, 3)
        wins = random.randint(2, gp - ties - 2)
        losses = gp - wins - ties
        t['wins'] = wins
        t['losses'] = losses
        t['ties'] = ties
        # Remove score fields if present (league only tracks W/L)
        t.pop('pointsFor', None)
        t.pop('pointsAgainst', None)

    # Seed by win pct
    teams.sort(key=lambda t: -(t['wins'] + t['ties'] * 0.5) / max(1, t['wins'] + t['losses'] + t['ties']))
    for rank, t in enumerate(teams, 1):
        t['seed'] = rank

    (DATA / f'teams_{division}.json').write_text(json.dumps(teams, indent=2))
    print(f'{division}: {n} teams seeded')
    for t in teams:
        gp = t['wins'] + t['losses'] + t['ties']
        pct = (t['wins'] + t['ties'] * 0.5) / gp if gp else 0
        print(f"  #{t['seed']:>2} {t['name']:<15} {t['wins']}-{t['losses']}-{t['ties']}  ({pct:.3f})")
