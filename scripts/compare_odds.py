#!/usr/bin/env python3
"""Compare old vs new odds."""
import json

old = {r['teamId']: r for r in json.load(open('data/odds_mens_old.json'))}
new = {r['teamId']: r for r in json.load(open('data/odds_mens.json'))}

hdr = f"{'Team':<14} {'Old Champ':>10} {'New Champ':>10} {'Diff':>7} | {'Old Any':>8} {'New Any':>8} {'Diff':>7}"
print(hdr)
print('-' * len(hdr))

for tid in sorted(old.keys(), key=lambda x: new[x]['A'], reverse=True):
    o, n = old[tid], new[tid]
    dc = (n['A'] - o['A']) * 100
    da = (n['any'] - o['any']) * 100
    marker = ' **' if abs(dc) > 1 else ''
    print(f"  {n['teamName']:<14} {o['A']*100:>8.1f}% {n['A']*100:>8.1f}%  {dc:>+5.1f}% | {o['any']*100:>6.1f}% {n['any']*100:>6.1f}%  {da:>+5.1f}%{marker}")
