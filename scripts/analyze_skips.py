#!/usr/bin/env python3
"""Analyze combined Monday/Tuesday records for all Calcutta skips."""
import json

with open('data/rosters_full.json') as f:
    rosters = json.load(f)

with open('data/poole_team_data.json') as f:
    ptd = json.load(f)

with open('data/teams_mens.json') as f:
    teams = json.load(f)

standings = ptd['standings']
all_rosters = ptd['all_team_rosters']

# Get skip names for each Calcutta team
skips = {t['id']: t['skip'] for t in rosters['mens']}

# Build a map: player name -> [(team, league)] from all_team_rosters
player_teams = {}
for team_name, leagues in all_rosters.items():
    for league, players in leagues.items():
        if league not in ('Monday Night', 'Tuesday Night'):
            continue
        for p in players:
            p_lower = p.strip().lower()
            if p_lower not in player_teams:
                player_teams[p_lower] = []
            player_teams[p_lower].append((team_name, league))

# Current teams_mens.json records
current = {t['id']: t for t in teams}

def pct(w, l, t):
    gp = w + l + t
    if gp == 0:
        return 0
    return (w + t * 0.5) / gp * 100

print(f"{'Calcutta Team':<14} {'Skip':<20} {'Current':>9} {'Cur%':>5}")
print(f"{'-'*14} {'-'*20} {'-'*9} {'-'*5}")

changes = []

for t in sorted(teams, key=lambda x: x['name']):
    tid = t['id']
    skip_name = skips.get(tid, '?')
    skip_lower = skip_name.strip().lower()
    
    cur_w, cur_l, cur_t = t['wins'], t['losses'], t['ties']
    cur_pct = pct(cur_w, cur_l, cur_t)
    
    # Find all Mon/Tue teams this skip plays on
    found = player_teams.get(skip_lower, [])
    
    combined_w, combined_l, combined_t = 0, 0, 0
    details = []
    for team_name, league in found:
        lg_short = 'Mon' if 'Monday' in league else 'Tue'
        st = standings.get(league, {}).get(team_name)
        if st:
            w, l, ti = st['wins'], st['losses'], st['ties']
            combined_w += w
            combined_l += l
            combined_t += ti
            gp = w + l + ti
            p = pct(w, l, ti)
            details.append(f"  {team_name} {lg_short} {w}-{l}-{ti} ({p:.0f}%)")
        else:
            details.append(f"  {team_name} {lg_short} (no standings)")
    
    combined_gp = combined_w + combined_l + combined_t
    combined_pct_val = pct(combined_w, combined_l, combined_t)
    
    diff = combined_pct_val - cur_pct if combined_gp > 0 else 0
    
    multi = len(found) > 1
    marker = " <-- MULTI-LEAGUE" if multi else ""
    
    print(f"\n{t['name']:<14} {skip_name:<20} {cur_w}-{cur_l}-{cur_t} {cur_pct:>4.0f}%{marker}")
    for d in details:
        print(d)
    if multi and combined_gp > 0:
        print(f"  ** Combined: {combined_w}-{combined_l}-{combined_t} ({combined_pct_val:.1f}%)  [diff from current: {diff:+.1f}%]")
        if abs(diff) > 3:
            changes.append((t['name'], skip_name, cur_pct, combined_pct_val, diff,
                            combined_w, combined_l, combined_t))
    
    if not found:
        print("  (not found in any Mon/Tue roster)")

print("\n" + "="*70)
print("SKIPS WITH SIGNIFICANT DIFFERENCE (>3%) WHEN USING COMBINED RECORD:")
print("="*70)
for name, skip, cur, comb, diff, w, l, ti in sorted(changes, key=lambda x: -abs(x[4])):
    print(f"  {name:<14} {skip:<20} Current: {cur:.1f}%  Combined: {comb:.1f}%  ({diff:+.1f}%)")
