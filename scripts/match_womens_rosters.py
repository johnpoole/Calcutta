#!/usr/bin/env python3
"""Cross-reference women's league rosters (from Excel Ladies tab) with bonspiel rosters
to map creative league team names to bonspiel team IDs."""

import json
import csv
import os

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

# Load bonspiel women's rosters
with open('data/rosters_full.json') as f:
    rosters = json.load(f)
bonspiel = rosters['womens']

# League rosters parsed from Ladies tab of Excel
league = {
    '1': ['Donna Newman', 'Karen Emery', 'Gail Bell', 'Sarah Scott'],
    'Sweep Dreams': ['Lorraine Patrick', 'Judy Forshner', 'Trish Gray', 'Joanne Feick', 'Lorri Cavanagh'],
    'Skip Happens': ['Beth Iredale', 'Tina Ho-Chung-Qui', 'Cara Bonney-Barr', 'Cory Royal'],
    'Tartan Tarts': ['Terry Griffin', 'Jane Arnold', "Carey O'Brien", 'Leslie Gell', 'Anne Armstrong', 'Terry McNaughton'],
    '5': ['Linda Vogt', 'Trish Snethun', 'Jill Mitchell', "Lynn O'Neil"],
    'Sweeping Beauties': ['Gwen Harris', 'Marguerite Boisjolie', 'Donna Guichon', 'Lisa Loczy', 'Charlotte Annable'],
    'Sheet Disturbers': ['JoAnne Josefchak', 'Carolyn Best', 'Carol Taylor', 'Shelly Lebbert', 'Anne Cataford'],
    '8': ['Kim Snethun', 'Andrew Kosa', 'Julia Phelps'],
    'Team Pink': ['Louise Sheeran', 'Nancy Baxter', 'Shelley MacDougall', 'Lisa Cole', 'Christiane Gauthier'],
    '10': ['Mildred Hawkins', 'Margie Kennedy', 'Tracye Osler', 'Margot Theriault', 'Dena Flock'],
    '11': ['Diane Williams', 'Joanne Hruska', 'Margo Harris', 'Kia Hawkins', 'Renee Duckworth', 'Kathy Lowe'],
    'Patchwork': ['Joyce Clark', 'Joanne Saunders', 'Megan Waddell', 'Erin Waite'],
    'RAAA': ['Amy Yunker', 'Reagan Wilson', 'Amber Fairhurst', 'Alexandra Sinclair'],
    'Sheets & Giggles': ['Karen Radford', 'Dana Lougheed', 'Trish Brown', 'Jennifer Crysdale', 'Tamara Cohos'],
    'OK Broomer': ['Emma Moult', 'Natalia Duska', 'Alli Lebbert', 'Laura McCowan', 'Tigra Bailey'],
    "Nancy's Crew": ['Gail Fetting', 'Pamela Bowman', 'Jeannie Rooney', 'Donna Horton', 'Shirley Reid', 'Sheena Rogers'],
    'Hack Attack': ['Deborah Johnson', 'Kaylee Jukes', 'Emily Hoult', 'Erinn Roberts', 'Vivienne Allain'],
    'The Householders': ['Dixie Inman', "Barb O'Connor", 'Anna Worth', 'Angela McKinnon', 'Simonne Birrell'],
}

def normalize(name):
    return name.lower().replace("'", "").replace("-", " ").strip()

# Cross-reference
print("=== BONSPIEL → LEAGUE MATCHING ===\n")
matches = {}
for bt in bonspiel:
    all_bonspiel = [bt['skip']] + bt.get('members', [])
    bn = set(normalize(n) for n in all_bonspiel)

    best_match = None
    best_count = 0
    best_overlap = set()
    for lname, lplayers in league.items():
        ln = set(normalize(n) for n in lplayers)
        overlap = bn & ln
        if len(overlap) > best_count:
            best_count = len(overlap)
            best_match = lname
            best_overlap = overlap

    status = 'MATCH' if best_count >= 2 else 'WEAK' if best_count == 1 else 'NONE'
    print(f"  {bt['id']:12s} (skip={bt['skip']:20s}) -> League '{best_match}' overlap={best_count} [{status}]")
    if best_overlap:
        print(f"               shared: {best_overlap}")
    if best_count >= 2:
        matches[best_match] = bt['id']

print(f"\n=== CONFIRMED MATCHES ({len(matches)}) ===\n")
for league_name, bonspiel_id in sorted(matches.items(), key=lambda x: x[1]):
    print(f"  League '{league_name}' -> bonspiel '{bonspiel_id}'")

# Now check standings CSV
print("\n=== STANDINGS CSV MAPPING ===\n")
with open('data/women_standings.csv') as f:
    reader = csv.DictReader(f)
    for row in reader:
        team_name = row.get('Team', '').strip()
        if team_name in matches:
            bid = matches[team_name]
            w, l, t = row.get('W', 0), row.get('L', 0), row.get('T', 0)
            print(f"  '{team_name}' -> {bid} ({w}W-{l}L-{t}T)")
        else:
            # Check if it's a direct skip-name match
            norm = team_name.lower()
            direct = None
            for bt in bonspiel:
                if bt['skip'].lower().split()[-1] == norm or bt['id'] == norm:
                    direct = bt['id']
                    break
            if direct:
                w, l, t = row.get('W', 0), row.get('L', 0), row.get('T', 0)
                print(f"  '{team_name}' -> {direct} (direct) ({w}W-{l}L-{t}T)")
            else:
                print(f"  '{team_name}' -> ??? (no bonspiel match)")
