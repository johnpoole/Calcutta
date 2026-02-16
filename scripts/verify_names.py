#!/usr/bin/env python3
"""Verify full-name matching and flag same-last-name different-person cases."""
import json

with open('data/rosters_full.json') as f:
    rosters = json.load(f)
with open('data/poole_team_data.json') as f:
    ptd = json.load(f)

all_rosters = ptd['all_team_rosters']
skips = {t['id']: t['skip'] for t in rosters['mens']}

for tid, skip in sorted(skips.items()):
    exact_matches = []
    same_last_name = []
    skip_last = skip.split()[-1].lower()
    
    for team_name, leagues in all_rosters.items():
        for league, players in leagues.items():
            if league not in ('Monday Night', 'Tuesday Night'):
                continue
            for p in players:
                p_last = p.split()[-1].lower()
                if p.strip().lower() == skip.strip().lower():
                    exact_matches.append(f'  EXACT: {team_name} {league}: "{p}"')
                elif p_last == skip_last:
                    same_last_name.append(f'  !! RELATIVE? {team_name} {league}: "{p}" (skip is "{skip}")')
    
    if exact_matches or same_last_name:
        print(f'{tid:<14} skip="{skip}"')
        for m in exact_matches:
            print(m)
        for m in same_last_name:
            print(m)
        print()
