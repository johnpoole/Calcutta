#!/usr/bin/env python3
"""
bundle_data.py — Reads all JSON data files and writes js/bundled-data.js
so the SPA works from file:// without any HTTP server.

Run after calculate_odds.py (or any time the JSON files change):
    python scripts/bundle_data.py
"""

import json
import os
import sys

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
OUT_FILE = os.path.join(os.path.dirname(__file__), '..', 'js', 'bundled-data.js')

FILES = {
    'teams_mens':    'teams_mens.json',
    'teams_womens':  'teams_womens.json',
    'draw_mens':     'draw_mens.json',
    'draw_womens':   'draw_womens.json',
    'bracket_mens':  'bracket_mens.json',
    'bracket_womens':'bracket_womens.json',
    'odds_mens':     'odds_mens.json',
    'odds_womens':   'odds_womens.json',
}

def main():
    parts = []
    parts.append('/* ═══════════════════════════════════════════════════════════')
    parts.append('   Calcutta Auction — Bundled Data  (auto-generated)')
    parts.append('   Created by scripts/bundle_data.py — do not edit by hand.')
    parts.append('   ═══════════════════════════════════════════════════════════ */')
    parts.append('')
    parts.append('const BundledData = (() => {')
    parts.append("  'use strict';")
    parts.append('')

    for key, filename in FILES.items():
        path = os.path.join(DATA_DIR, filename)
        if not os.path.exists(path):
            print(f'WARNING: {path} not found — using empty fallback')
            parts.append(f'  const {key} = null;')
        else:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # Write as compact JSON (one line per entry is fine since we minify)
            json_str = json.dumps(data, separators=(',', ':'))
            parts.append(f'  const {key} = {json_str};')
        parts.append('')

    parts.append('  return {')
    parts.append('    teams:   { mens: teams_mens,   womens: teams_womens },')
    parts.append('    draw:    { mens: draw_mens,     womens: draw_womens },')
    parts.append('    bracket: { mens: bracket_mens,  womens: bracket_womens },')
    parts.append('    odds:    { mens: odds_mens,     womens: odds_womens },')
    parts.append('  };')
    parts.append('})();')
    parts.append('')

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write('\n'.join(parts))

    print(f'Wrote {OUT_FILE}')

if __name__ == '__main__':
    main()
