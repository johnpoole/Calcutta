/* ═══════════════════════════════════════════════════════════
   Calcutta Auction — Main Application Logic
   Wires UI events, renders tables/charts, and orchestrates
   the data, odds, and pool-estimator modules.
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Cached odds & analysis results ─────────────────────
  let cachedOdds = [];      // [{ teamId, A, B, C, D, any }]  (loaded from pre-computed JSON)
  let cachedAnalysis = [];   // [{ teamId, ev, optimalBid, ... }]  (pool estimates + EV, computed client-side)

  // ── Optimizer state ────────────────────────────────────
  // Stored here so renderAll() rebuilding the dropdown doesn't reset the user's selection.
  let optimizerBuyer = 'Poole';

  // ═══════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      CalcuttaData.load();
      // If no teams exist, auto-load from bundled JSON data files
      if (CalcuttaData.getTeams().length === 0) {
        await autoLoadData();
      }
      syncSettingsUI();
      bindTabs();
      bindDivisionToggles();
      bindTeamActions();
      bindDrawActions();
      bindBidActions();
      bindOddsActions();
      bindAnalysisActions();
      bindSettingsActions();
      bindModal();
      bindInfoPopup();

      // Load bracket + odds BEFORE first render so nothing shows "Loading…"
      loadBracketTree();
      await loadPrecomputedOdds();

      renderAll();
      runFullAnalysis();
    } catch (e) {
      console.error('Init failed:', e);
    }
  });

  async function autoLoadData() {
    try {
      for (const div of ['mens', 'womens']) {
        const teams = BundledData.teams[div];
        const draw  = BundledData.draw[div];
        if (teams) {
          CalcuttaData.activeDivision = div;
          CalcuttaData.importJSON(teams);
        }
        if (draw) {
          CalcuttaData.activeDivision = div;
          CalcuttaData.state[div].draw = draw;
        }
      }
      CalcuttaData.activeDivision = 'mens';
      CalcuttaData.state.config = CalcuttaData.config; // keep defaults
      CalcuttaData.save();
      console.log('Auto-loaded team and draw data from bundled data.');
    } catch (e) {
      console.warn('Auto-load failed:', e);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  TABS
  // ═══════════════════════════════════════════════════════
  function bindTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
        renderAll();
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  DIVISION TOGGLES
  // ═══════════════════════════════════════════════════════
  function bindDivisionToggles() {
    document.querySelectorAll('.division-toggle').forEach(container => {
      container.querySelectorAll('.div-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          // Update all division toggles in sync
          document.querySelectorAll('.div-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll(`.div-btn[data-division="${btn.dataset.division}"]`)
            .forEach(b => b.classList.add('active'));
          CalcuttaData.activeDivision = btn.dataset.division;
          cachedOdds = [];
          cachedAnalysis = [];
          cachedBracketTree = null;
          loadBracketTree();
          renderAll();
          loadPrecomputedOdds().then(() => runFullAnalysis());
        });
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  RENDER ALL
  // ═══════════════════════════════════════════════════════
  function renderAll() {
    renderStandings();
    renderBracket();
    renderBids();
    renderPayoutCards();
    renderOdds();
    renderAnalysis();
    populateOptimizerBuyerDropdown();
  }

  // ═══════════════════════════════════════════════════════
  //  STANDINGS TABLE
  // ═══════════════════════════════════════════════════════
  function renderStandings() {
    const tbody = document.querySelector('#standings-table tbody');
    tbody.innerHTML = '';
    const teams = CalcuttaData.getTeams();

    if (teams.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;">No teams added yet</td></tr>';
      return;
    }

    const sorted = [...teams].sort((a, b) => CalcuttaData.winPct(b) - CalcuttaData.winPct(a));
    for (const t of sorted) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(t.name)}</strong>${overrideBadge(t.name)}</td>
        <td>${t.wins}</td>
        <td>${t.losses}</td>
        <td>${t.ties}</td>
        <td>${pct(CalcuttaData.winPct(t))}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  DRAW / BRACKET  (renders from bracket-tree JSON)
  // ═══════════════════════════════════════════════════════
  let cachedBracketTree = null;
  let activeEvent = 'a';

  function loadBracketTree() {
    const div = CalcuttaData.activeDivision;
    const tree = BundledData.bracket[div] || null;
    if (tree) {
      cachedBracketTree = tree;
    } else {
      cachedBracketTree = null;
      console.warn('No bundled bracket tree for', div);
    }
  }

  /* ── Recursive tree → HTML ─────────────────────────── */
  function treeNodeHTML(node) {
    if (node.team) {
      const t = CalcuttaData.getTeams().find(t => t.id === node.team);
      const name = t ? t.name : node.team;
      const seed = t ? t.seed : '';
      return `<div class="bt-team">${seed ? `<small style="color:var(--muted)">${seed}.</small> ` : ''}${esc(name)}</div>`;
    }
    if (node.slot) {
      return `<div class="bt-slot">${esc(node.slot)}</div>`;
    }
    const m = node.match;
    const loser = m.loserSlot ? `<span class="bt-loser">→${m.loserSlot}</span>` : '';
    return `<div class="bt-match">
      <div class="bt-seeds">
        <div class="bt-seed">${treeNodeHTML(m.left)}</div>
        <div class="bt-seed">${treeNodeHTML(m.right)}</div>
      </div>
      <div class="bt-line"><div class="bt-line-t"></div><div class="bt-line-b"></div></div>
      <div class="bt-out"></div>
      ${loser}
    </div>`;
  }

  /* ── Render full bracket page ──────────────────────── */
  function renderBracket() {
    const container = document.getElementById('bracket-container');
    if (!cachedBracketTree) {
      container.innerHTML = '<p style="color:var(--muted);">No bracket data available</p>';
      return;
    }

    const tree = cachedBracketTree;

    // Build per-event HTML
    const events = {};

    // A Event
    const qLabels = tree.a_event.length === 4
      ? ['Qualifier 1', 'Qualifier 2', 'Qualifier 3', 'Qualifier 4']
      : ['Qualifier 1', 'Qualifier 2'];
    let aHTML = '';
    tree.a_event.forEach((q, i) => {
      aHTML += `<div class="qualifier-section"><h4>${qLabels[i]}</h4>
        <div class="bracket-tree" style="overflow-x:auto;padding:.5rem 0;">${treeNodeHTML(q)}</div></div>`;
    });
    events.a = aHTML;

    // B Event
    const bStart = tree.a_event.length + 1;
    const bLabels = tree.b_event.map((_, i) => `Qualifier ${bStart + i}`);
    let bHTML = '';
    tree.b_event.forEach((q, i) => {
      bHTML += `<div class="qualifier-section"><h4>${bLabels[i]}</h4>
        <div class="bracket-tree" style="overflow-x:auto;padding:.5rem 0;">${treeNodeHTML(q)}</div></div>`;
    });
    events.b = bHTML;

    // Championship
    events.champ = renderChampionship(tree.championship);

    // C Event
    events.c = `<div class="qualifier-section"><h4>C Event Bracket</h4>
      <div class="bracket-tree" style="overflow-x:auto;padding:.5rem 0;">${treeNodeHTML(tree.c_event)}</div></div>`;

    // D Event
    events.d = `<div class="qualifier-section"><h4>D Event Bracket</h4>
      <div class="bracket-tree" style="overflow-x:auto;padding:.5rem 0;">${treeNodeHTML(tree.d_event)}</div></div>`;

    // Path to Win
    events.path = renderPathToWin();

    // Most Likely Path
    events.likely = renderMostLikelyPath();

    let html = '';
    for (const key of ['a', 'b', 'champ', 'c', 'd', 'path', 'likely']) {
      html += `<div class="bracket-event${key === activeEvent ? ' active' : ''}" data-event="${key}">${events[key]}</div>`;
    }
    container.innerHTML = html;

    // If path tab is active, initialize the result
    if (activeEvent === 'path') {
      updatePathResult();
      const sel = document.getElementById('path-team-select');
      if (sel) sel.addEventListener('change', updatePathResult);
    }
    if (activeEvent === 'likely') {
      updateLikelyResult();
      const sel = document.getElementById('likely-team-select');
      if (sel) sel.addEventListener('change', updateLikelyResult);
    }
  }

  function renderChampionship(champ) {
    const n = champ.numQualifiers;
    let html = '';

    // Quarterfinals (or first round)
    const qfLabel = n === 8 ? 'Quarterfinals' : 'Semifinals';
    html += `<div class="champ-round"><h5>${qfLabel}</h5><div class="champ-matches">`;
    champ.quarterSeed.forEach(([a, b], i) => {
      html += `<div class="champ-card"><span class="qualifier">Q${a + 1}</span><span class="vs">vs</span><span class="qualifier">Q${b + 1}</span></div>`;
    });
    html += '</div></div>';

    // Semifinals (if 8 qualifiers)
    if (n === 8) {
      html += `<div class="champ-round"><h5>Semifinals</h5><div class="champ-matches">`;
      champ.semiPairs.forEach(([a, b]) => {
        html += `<div class="champ-card">${qfLabel.slice(0, -1)} ${a + 1} Winner <span class="vs">vs</span> ${qfLabel.slice(0, -1)} ${b + 1} Winner</div>`;
      });
      html += '</div></div>';
    }

    // Final
    const sfLabel = n === 8 ? 'Semifinal' : qfLabel.slice(0, -1);
    html += `<div class="champ-round"><h5>Championship Final</h5><div class="champ-matches">`;
    html += `<div class="champ-card">${sfLabel} Winners → <strong>Champion</strong> (40% payout)</div>`;
    html += '</div></div>';

    // Consolation
    html += `<div class="champ-round"><h5>Consolation Final</h5><div class="champ-matches">`;
    html += `<div class="champ-card">${sfLabel} Losers → <strong>Consolation</strong> (30% payout)</div>`;
    html += '</div></div>';

    return html;
  }

  /* ── Path to Win: trace a team's opponents ─────────── */

  /** Collect all team ids from a subtree */
  function collectTeams(node) {
    if (node.team) return [node.team];
    if (node.slot) return []; // slots are unknown at auction time
    const m = node.match;
    return [...collectTeams(m.left), ...collectTeams(m.right)];
  }

  function renderPathToWin() {
    if (!cachedBracketTree) return '';
    const teams = CalcuttaData.getTeams();
    if (teams.length === 0) return '<p style="color:var(--muted);">No teams loaded</p>';

    const tree = cachedBracketTree;
    const sorted = [...teams].sort((a, b) => a.seed - b.seed);

    // Team selector
    let html = `<div class="path-selector">
      <label style="margin-right:.5rem;font-weight:600;">Select team:</label>
      <select id="path-team-select">
        ${sorted.map(t => `<option value="${t.id}">${t.seed}. ${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    <div id="path-result"></div>`;

    return html;
  }

  function updatePathResult() {
    const resultEl = document.getElementById('path-result');
    if (!resultEl || !cachedBracketTree) return;

    const teamId = document.getElementById('path-team-select')?.value;
    if (!teamId) return;

    const tree = cachedBracketTree;
    const teams = CalcuttaData.getTeams();
    const teamName = (id) => {
      const t = teams.find(t => t.id === id);
      return t ? `${t.seed}. ${t.name}` : id;
    };

    // Build slot → team names map: which real teams could fill each slot
    const slotTeams = {};
    function mapSlotsFromTree(node) {
      if (!node.match) return;
      const m = node.match;
      mapSlotsFromTree(m.left);
      mapSlotsFromTree(m.right);
      if (m.loserSlot) {
        // Loser of this match fills this slot — collect all leaf teams from both sides
        const leftTeams = collectAllLeaves(m.left);
        const rightTeams = collectAllLeaves(m.right);
        slotTeams[m.loserSlot] = [...new Set([...leftTeams, ...rightTeams])];
      }
    }
    function collectAllLeaves(node) {
      if (node.team) return [node.team];
      if (node.slot) {
        // Recursively resolve: this slot is itself filled by teams from a prior event
        if (slotTeams[node.slot]) return slotTeams[node.slot];
        return [node.slot]; // fallback
      }
      if (!node.match) return [];
      return [...collectAllLeaves(node.match.left), ...collectAllLeaves(node.match.right)];
    }
    // Map A-event slots first (they have real teams), then B-event (which reference A-event slots)
    tree.a_event.forEach(q => mapSlotsFromTree(q));
    tree.b_event.forEach(q => mapSlotsFromTree(q));

    // Resolve a ref (slot or team id) to display names, excluding the selected team
    function resolveToNames(ref) {
      if (slotTeams[ref]) return slotTeams[ref].filter(id => id !== teamId).map(id => teamName(id));
      if (ref === teamId) return [];  // don't show self
      return [teamName(ref)];
    }

    // Find which A-event qualifier this team is in
    let qualifierIdx = -1;
    let aPath = null;
    for (let i = 0; i < tree.a_event.length; i++) {
      aPath = findPathWithSlots(tree.a_event[i], teamId);
      if (aPath) { qualifierIdx = i; break; }
    }

    if (!aPath) {
      resultEl.innerHTML = '<p style="color:var(--muted);">Team not found in bracket.</p>';
      return;
    }

    const champ = tree.championship;
    const numQ = champ.numQualifiers;
    const qNum = qualifierIdx + 1;

    // Get odds for this team
    const odds = cachedOdds.find(o => o.teamId === teamId);

    let html = '<div class="path-rounds">';

    // ── CHAMPIONSHIP PATH (40% payout) ────────────────────
    const aPct = odds ? (odds.A * 100).toFixed(1) + '%' : '';
    html += `<div class="path-section-title">🏆 Championship (40%)${aPct ? ` <span style="color:var(--success);font-weight:400;font-size:.85rem;">${aPct}</span>` : ''}</div>`;
    html += `<div style="color:var(--muted);font-size:.8rem;margin-bottom:.5rem;">Win A-Event Q${qNum} → Win Championship bracket</div>`;

    const aRoundNames = getRoundNames(aPath.length);
    aPath.forEach((step, i) => {
      html += renderPathRound(aRoundNames[i], step.opponents.map(id => teamName(id)));
    });

    // Build qualifier → team names map for Championship bracket
    // Q0-Q3 = A-event qualifier winners, Q4-Q7 = B-event qualifier winners
    // Exclude the selected team — they can't be their own opponent
    const qualifierTeams = [];
    for (let i = 0; i < tree.a_event.length; i++) {
      qualifierTeams.push([...new Set(collectTeams(tree.a_event[i]))].filter(id => id !== teamId).map(id => teamName(id)));
    }
    for (let i = 0; i < tree.b_event.length; i++) {
      const bTeams = [...new Set(collectAllLeaves(tree.b_event[i]))].filter(id => id !== teamId).map(id => teamName(id));
      qualifierTeams.push(bTeams);
    }

    // Championship rounds
    html += renderChampionshipPath(qualifierIdx, champ, 'win', qualifierTeams);

    // ── CONSOLATION PATH (30% payout) ──────
    const bPct = odds ? (odds.B * 100).toFixed(1) + '%' : '';
    html += `<hr class="path-divider"><div class="path-section-title">🥈 Consolation (30%)${bPct ? ` <span style="color:var(--primary);font-weight:400;font-size:.85rem;">${bPct}</span>` : ''}</div>`;
    html += `<div style="color:var(--muted);font-size:.8rem;margin-bottom:.5rem;">Lose in A-Event → Win B-Event qualifier → Win Consolation bracket</div>`;

    // Show which B-event slot each A-round loss feeds into
    for (let i = 0; i < aPath.length; i++) {
      const slot = aPath[i].loserSlot;
      if (slot) {
        const lossRound = aPath.length === 1 ? 'Qualifier Final' : aRoundNames[i];
        html += `<div class="path-round"><div class="path-round-label" style="color:var(--danger);">Lose ${lossRound}</div>`;
        html += `<div class="path-opponents"><span class="path-opponent seed-info">→ Enter B Event</span></div></div>`;

        // Trace the B-event path for this slot
        const bPath = findSlotPath(tree.b_event, slot);
        if (bPath) {
          const bRounds = getRoundNames(bPath.length);
          bPath.forEach((step, j) => {
            // Resolve slot refs to actual team names (deduplicated)
            const names = [...new Set(step.opponents.flatMap(ref => resolveToNames(ref)))];
            html += renderPathRound('  ' + bRounds[j], names);
          });
        }
      }
    }
    html += renderChampionshipPath(qualifierIdx, champ, 'consolation', qualifierTeams);

    // ── C EVENT PATH (15% payout) ────────────────────
    const cPct = odds ? (odds.C * 100).toFixed(1) + '%' : '';
    html += `<hr class="path-divider"><div class="path-section-title">🥉 C Event (15%)${cPct ? ` <span style="color:var(--warning);font-weight:400;font-size:.85rem;">${cPct}</span>` : ''}</div>`;
    html += `<div style="color:var(--muted);font-size:.8rem;margin-bottom:.5rem;">Lose in A → Lose in B-Event → Win C-Event bracket</div>`;

    // Collect all C-slots this team could land in, then trace full path through C bracket
    const cSlots = collectDownstreamSlots(tree.b_event, aPath, 'C');
    if (cSlots.length > 0 && tree.c_event) {
      // Show path from first entry slot (they're all equivalent routes through the same bracket)
      const cEntrySlot = cSlots[0];
      const cPath = findSlotInTree(tree.c_event, cEntrySlot);
      if (cPath) {
        const cRounds = getRoundNames(cPath.length);
        cPath.forEach((step, j) => {
          const names = [...new Set(step.opponents.flatMap(ref => resolveToNames(ref)))];
          html += renderPathRound(cRounds[j], names);
        });
      } else {
        const cNames = [...new Set(cSlots.flatMap(s => resolveToNames(s)))];
        html += renderPathRound('Opponents', cNames);
      }
    } else {
      html += `<div class="path-round"><div class="path-round-label">Path</div>`;
      html += `<div class="path-opponents"><span class="path-opponent seed-info">Via B-Event losses → C bracket</span></div></div>`;
    }

    // ── D EVENT PATH (15% payout) ────────────────────
    const dPct = odds ? (odds.D * 100).toFixed(1) + '%' : '';
    html += `<hr class="path-divider"><div class="path-section-title">4️⃣ D Event (15%)${dPct ? ` <span style="color:var(--muted);font-weight:400;font-size:.85rem;">${dPct}</span>` : ''}</div>`;
    html += `<div style="color:var(--muted);font-size:.8rem;margin-bottom:.5rem;">Lose in A → Lose B-Event qualifier final → Win D-Event bracket</div>`;

    const dSlots = collectDownstreamSlots(tree.b_event, aPath, 'D');
    if (dSlots.length > 0 && tree.d_event) {
      const dEntrySlot = dSlots[0];
      const dPath = findSlotInTree(tree.d_event, dEntrySlot);
      if (dPath) {
        const dRounds = getRoundNames(dPath.length);
        dPath.forEach((step, j) => {
          const names = [...new Set(step.opponents.flatMap(ref => resolveToNames(ref)))];
          html += renderPathRound(dRounds[j], names);
        });
      } else {
        const dNames = [...new Set(dSlots.flatMap(s => resolveToNames(s)))];
        html += renderPathRound('Opponents', dNames);
      }
    } else {
      html += `<div class="path-round"><div class="path-round-label">Path</div>`;
      html += `<div class="path-opponents"><span class="path-opponent seed-info">Lose B-Event qualifier final → D bracket</span></div></div>`;
    }

    html += '</div>';
    resultEl.innerHTML = html;
  }

  /* ── Most Likely: simulate bracket, show team's game-by-game results ── */

  function renderMostLikelyPath() {
    if (!cachedBracketTree) return '';
    const teams = CalcuttaData.getTeams();
    if (teams.length === 0) return '<p style="color:var(--muted);">No teams loaded</p>';

    const sorted = [...teams].sort((a, b) => a.seed - b.seed);
    let html = `<div class="path-selector">
      <label style="margin-right:.5rem;font-weight:600;">Select team:</label>
      <select id="likely-team-select">
        ${sorted.map(t => `<option value="${t.id}">${t.seed}. ${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    <div id="likely-result"></div>`;
    return html;
  }

  /**
   * Simulate the entire bracket. At each match the higher win% team wins.
   * Returns a map: slotId → winning teamId (for loser slots feeding into B/C/D).
   * Also returns simResults: matchKey → { winner, loser }
   */
  function simulateBracket(tree, teams) {
    const teamMap = new Map(teams.map(t => [t.id, t]));
    const getStrength = (id) => {
      const t = teamMap.get(id);
      return t ? CalcuttaData.winPct(t) : 0;
    };

    // slotWinners: which team fills each loser slot
    const slotWinners = {};
    // games: ordered list of { winner, loser, event, round } for every match
    const allGames = [];

    /** Simulate a subtree node. Returns the winning team id. */
    function sim(node, event, depth) {
      if (node.team) return node.team;
      if (node.slot) return slotWinners[node.slot] || null;
      const m = node.match;
      const leftWinner = sim(m.left, event, depth + 1);
      const rightWinner = sim(m.right, event, depth + 1);
      if (!leftWinner || !rightWinner) return leftWinner || rightWinner || null;

      const leftStr = getStrength(leftWinner);
      const rightStr = getStrength(rightWinner);
      const winner = leftStr >= rightStr ? leftWinner : rightWinner;
      const loser = winner === leftWinner ? rightWinner : leftWinner;

      allGames.push({ winner, loser, event });

      if (m.loserSlot) {
        slotWinners[m.loserSlot] = loser;
      }
      return winner;
    }

    // Simulate A-event qualifiers
    const aWinners = [];
    tree.a_event.forEach((q, i) => {
      aWinners.push(sim(q, 'A', 0));
    });

    // Simulate B-event qualifiers (losers from A feed in via slots)
    const bWinners = [];
    tree.b_event.forEach((q, i) => {
      bWinners.push(sim(q, 'B', 0));
    });

    // Simulate C event
    if (tree.c_event) sim(tree.c_event, 'C', 0);

    // Simulate D event
    if (tree.d_event) sim(tree.d_event, 'D', 0);

    // Simulate championship bracket
    // Build qualifier list: A winners first, then B winners
    const qualifiers = [...aWinners, ...bWinners];
    const champ = tree.championship;

    // Quarter/Semifinals
    const qfWinners = [];
    const qfLosers = [];
    champ.quarterSeed.forEach(([a, b]) => {
      const tA = qualifiers[a], tB = qualifiers[b];
      if (!tA || !tB) { qfWinners.push(tA || tB); qfLosers.push(null); return; }
      const winner = getStrength(tA) >= getStrength(tB) ? tA : tB;
      const loser = winner === tA ? tB : tA;
      allGames.push({ winner, loser, event: 'Champ' });
      qfWinners.push(winner);
      qfLosers.push(loser);
    });

    if (champ.numQualifiers === 8 && champ.semiPairs) {
      const sfWinners = [];
      const sfLosers = [];
      champ.semiPairs.forEach(([a, b]) => {
        const tA = qfWinners[a], tB = qfWinners[b];
        if (!tA || !tB) { sfWinners.push(tA || tB); sfLosers.push(null); return; }
        const winner = getStrength(tA) >= getStrength(tB) ? tA : tB;
        const loser = winner === tA ? tB : tA;
        allGames.push({ winner, loser, event: 'Champ' });
        sfWinners.push(winner);
        sfLosers.push(loser);
      });
      // Final
      if (sfWinners[0] && sfWinners[1]) {
        const winner = getStrength(sfWinners[0]) >= getStrength(sfWinners[1]) ? sfWinners[0] : sfWinners[1];
        const loser = winner === sfWinners[0] ? sfWinners[1] : sfWinners[0];
        allGames.push({ winner, loser, event: 'Final' });
      }
      // Consolation final
      if (sfLosers[0] && sfLosers[1]) {
        const winner = getStrength(sfLosers[0]) >= getStrength(sfLosers[1]) ? sfLosers[0] : sfLosers[1];
        const loser = winner === sfLosers[0] ? sfLosers[1] : sfLosers[0];
        allGames.push({ winner, loser, event: 'Consolation' });
      }
    } else {
      // 4 qualifiers: QF winners go to final
      if (qfWinners[0] && qfWinners[1]) {
        const winner = getStrength(qfWinners[0]) >= getStrength(qfWinners[1]) ? qfWinners[0] : qfWinners[1];
        const loser = winner === qfWinners[0] ? qfWinners[1] : qfWinners[0];
        allGames.push({ winner, loser, event: 'Final' });
      }
      if (qfLosers[0] && qfLosers[1]) {
        const winner = getStrength(qfLosers[0]) >= getStrength(qfLosers[1]) ? qfLosers[0] : qfLosers[1];
        const loser = winner === qfLosers[0] ? qfLosers[1] : qfLosers[0];
        allGames.push({ winner, loser, event: 'Consolation' });
      }
    }

    return allGames;
  }

  function updateLikelyResult() {
    const resultEl = document.getElementById('likely-result');
    if (!resultEl || !cachedBracketTree) return;

    const teamId = document.getElementById('likely-team-select')?.value;
    if (!teamId) return;

    const teams = CalcuttaData.getTeams();
    const allGames = simulateBracket(cachedBracketTree, teams);

    // Filter to games involving the selected team
    const myGames = allGames.filter(g => g.winner === teamId || g.loser === teamId);

    if (myGames.length === 0) {
      resultEl.innerHTML = '<p style="color:var(--muted);">No games found for this team.</p>';
      return;
    }

    const teamLabel = (id) => {
      const t = teams.find(t => t.id === id);
      return t ? `${t.seed}. ${t.name}` : id;
    };

    let html = '<div class="path-rounds">';
    myGames.forEach((g, i) => {
      const won = g.winner === teamId;
      const oppId = won ? g.loser : g.winner;
      const result = won
        ? '<span style="color:var(--success);font-weight:600;">W</span>'
        : '<span style="color:var(--danger);font-weight:600;">L</span>';
      html += `<div class="path-round">
        <div class="path-round-label">Game ${i + 1} <span style="font-size:.75rem;color:var(--muted);">${esc(g.event)}</span></div>
        <div class="path-opponents"><span class="path-opponent">vs ${esc(teamLabel(oppId))} ${result}</span></div>
      </div>`;
    });
    html += '</div>';
    resultEl.innerHTML = html;
  }

  /** Like findPath but also captures the loserSlot at each match node */
  function findPathWithSlots(node, teamId) {
    if (node.team) return node.team === teamId ? [] : null;
    if (node.slot) return null;
    if (!node.match) return null;
    const m = node.match;

    const leftPath = findPathWithSlots(m.left, teamId);
    if (leftPath !== null) {
      leftPath.push({ opponents: collectTeams(m.right), loserSlot: m.loserSlot || null });
      return leftPath;
    }
    const rightPath = findPathWithSlots(m.right, teamId);
    if (rightPath !== null) {
      rightPath.push({ opponents: collectTeams(m.left), loserSlot: m.loserSlot || null });
      return rightPath;
    }
    return null;
  }

  /** Find the path through a B-event bracket for a given slot entry */
  function findSlotPath(bTrees, slotRef) {
    for (const bTree of bTrees) {
      const path = findSlotInTree(bTree, slotRef);
      if (path) return path;
    }
    return null;
  }

  function findSlotInTree(node, slotRef) {
    if (node.slot) return node.slot === slotRef ? [] : null;
    if (node.team) return null;
    if (!node.match) return null;
    const m = node.match;

    const leftPath = findSlotInTree(m.left, slotRef);
    if (leftPath !== null) {
      const opps = collectSlotRefs(m.right);
      leftPath.push({ opponents: opps, loserSlot: m.loserSlot || null });
      return leftPath;
    }
    const rightPath = findSlotInTree(m.right, slotRef);
    if (rightPath !== null) {
      const opps = collectSlotRefs(m.left);
      rightPath.push({ opponents: opps, loserSlot: m.loserSlot || null });
      return rightPath;
    }
    return null;
  }

  /** Collect slot refs from a subtree (for showing B-event opponents as slot labels) */
  function collectSlotRefs(node) {
    if (node.slot) return [node.slot];
    if (node.team) return [node.team];
    if (!node.match) return [];
    return [...collectSlotRefs(node.match.left), ...collectSlotRefs(node.match.right)];
  }

  /** Collect all downstream C or D slots reachable from B-event trees for a given A-path */
  function collectDownstreamSlots(bTrees, aPath, prefix) {
    const slots = [];
    for (const step of aPath) {
      if (!step.loserSlot) continue;
      // Find the B-event path from this slot
      const bPath = findSlotPath(bTrees, step.loserSlot);
      if (bPath) {
        for (const bStep of bPath) {
          if (bStep.loserSlot && bStep.loserSlot.startsWith(prefix)) {
            slots.push(bStep.loserSlot);
          }
        }
      }
    }
    return [...new Set(slots)];
  }

  function renderPathRound(label, displayNames) {
    const oppHtml = displayNames.length > 0
      ? displayNames.map(n => `<span class="path-opponent">${esc(n)}</span>`).join('<span class="path-or">or</span>')
      : '<span class="path-opponent seed-info">TBD</span>';
    return `<div class="path-round">
      <div class="path-round-label">${label}</div>
      <div class="path-opponents">${oppHtml}</div>
    </div>`;
  }

  function renderChampionshipPath(qualifierIdx, champ, mode, qualifierTeams) {
    const numQ = champ.numQualifiers;
    let html = '';

    // Helper: get display names for a qualifier index
    const qTeams = (idx) => (qualifierTeams && qualifierTeams[idx]) ? qualifierTeams[idx] : [`Q${idx + 1}`];
    // Helper: render a deduplicated list of team names joined by 'or'
    const teamSpans = (indices) => {
      const names = [...new Set(indices.flatMap(i => qTeams(i)))];
      return names.map(n => `<span class="path-opponent">${esc(n)}</span>`).join('<span class="path-or">or</span>');
    };

    if (numQ === 8) {
      const qfPair = champ.quarterSeed.find(p => p.includes(qualifierIdx));
      const qfOpp = qfPair[0] === qualifierIdx ? qfPair[1] : qfPair[0];
      const qfIdx = champ.quarterSeed.indexOf(qfPair);
      const semiPair = champ.semiPairs.find(p => p.includes(qfIdx));
      const semiOppQfIdx = semiPair[0] === qfIdx ? semiPair[1] : semiPair[0];
      const semiOppSeeds = champ.quarterSeed[semiOppQfIdx];
      const otherSemi = champ.semiPairs.find(p => !p.includes(qfIdx));
      const otherSeeds = otherSemi.flatMap(i => champ.quarterSeed[i]);

      if (mode === 'win') {
        html += `<div class="path-round"><div class="path-round-label">Quarterfinal</div>
          <div class="path-opponents">${teamSpans([qfOpp])}</div></div>`;
        html += `<div class="path-round"><div class="path-round-label">Semifinal</div>
          <div class="path-opponents">${teamSpans(semiOppSeeds)}</div></div>`;
        html += `<div class="path-round"><div class="path-round-label">Final</div>
          <div class="path-opponents">${teamSpans(otherSeeds)}</div></div>`;
      } else {
        html += `<div style="color:var(--muted);font-size:.8rem;margin-top:.5rem;">Then win Consolation bracket (QF/SF/Final losers play)</div>`;
      }
    } else {
      const sfPair = champ.quarterSeed.find(p => p.includes(qualifierIdx));
      const sfOpp = sfPair[0] === qualifierIdx ? sfPair[1] : sfPair[0];
      const otherPair = champ.quarterSeed.find(p => !p.includes(qualifierIdx));

      if (mode === 'win') {
        html += `<div class="path-round"><div class="path-round-label">Semifinal</div>
          <div class="path-opponents">${teamSpans([sfOpp])}</div></div>`;
        html += `<div class="path-round"><div class="path-round-label">Final</div>
          <div class="path-opponents">${teamSpans(otherPair)}</div></div>`;
      } else {
        html += `<div style="color:var(--muted);font-size:.8rem;margin-top:.5rem;">Then win Consolation Final (SF losers play)</div>`;
      }
    }
    return html;
  }

  function getRoundNames(total) {
    if (total === 1) return ['Qualifier Final'];
    if (total === 2) return ['Round 1', 'Qualifier Final'];
    if (total === 3) return ['Round 1', 'Semifinal', 'Qualifier Final'];
    if (total === 4) return ['Round 1', 'Round 2', 'Semifinal', 'Qualifier Final'];
    return Array.from({ length: total }, (_, i) => i === total - 1 ? 'Qualifier Final' : `Round ${i + 1}`);
  }

  function bindDrawActions() {
    // Event tab switching
    document.querySelectorAll('.event-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.event-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.bracket-event').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        activeEvent = btn.dataset.event;
        const panel = document.querySelector(`.bracket-event[data-event="${btn.dataset.event}"]`);
        if (panel) panel.classList.add('active');
        // Initialize path result when switching to path tab
        if (activeEvent === 'path') {
          updatePathResult();
          const sel = document.getElementById('path-team-select');
          if (sel) sel.addEventListener('change', updatePathResult);
        }
        if (activeEvent === 'likely') {
          updateLikelyResult();
          const sel = document.getElementById('likely-team-select');
          if (sel) sel.addEventListener('change', updateLikelyResult);
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  BIDS TABLE
  // ═══════════════════════════════════════════════════════
  function renderBids() {
    const tbody = document.querySelector('#bids-table tbody');
    tbody.innerHTML = '';
    const teams = CalcuttaData.getTeams();
    const bids = CalcuttaData.getBids();

    if (teams.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);text-align:center;">No teams added</td></tr>';
      return;
    }

    // Sort by EV descending when analysis is available, otherwise by seed
    const sortedTeams = [...teams].sort((a, b) => {
      const aEV = cachedAnalysis.find(x => x.teamId === a.id);
      const bEV = cachedAnalysis.find(x => x.teamId === b.id);
      if (aEV && bEV) return bEV.buyerEV - aEV.buyerEV;
      return (a.seed || 0) - (b.seed || 0);
    });

    for (const t of sortedTeams) {
      const bid = bids.find(b => b.teamId === t.id);
      const curBuyer = bid?.buyer || '';
      // Build buyer dropdown: team names + "Other" for free-text
      const teamNames = teams.map(tm => tm.name);
      const isOther = curBuyer && !teamNames.includes(curBuyer);
      let buyerOpts = '<option value="">— select —</option>';
      for (const tm of teams) {
        const sel = (curBuyer === tm.name) ? ' selected' : '';
        buyerOpts += `<option value="${esc(tm.name)}"${sel}>${esc(tm.name)}</option>`;
      }
      buyerOpts += `<option value="__other__"${isOther ? ' selected' : ''}>Other…</option>`;

      const tr = document.createElement('tr');
      const analysis = cachedAnalysis.find(a => a.teamId === t.id);
      const expReturn = analysis ? fmt$(analysis.buyerReturn) : '—';
      const evProfit = analysis ? fmt$(analysis.buyerEV) : '—';
      const evColor = analysis ? (analysis.buyerEV >= 0 ? 'var(--success)' : 'var(--danger)') : 'var(--muted)';
      const optBid = analysis
        ? (analysis.targetOptimalBid === Infinity ? '∞' : fmt$(analysis.targetOptimalBid))
        : '—';
      tr.innerHTML = `
        <td style="text-align:center;padding:0 .3rem;width:1.5rem;">
          <span class="info-btn" data-team="${t.id}" title="Team info"
                style="cursor:pointer;font-size:1.1rem;color:var(--muted);opacity:.7;">&#9432;</span>
        </td>
        <td>${esc(t.name)}${overrideBadge(t.name)}</td>
        <td>
          <select class="bid-input buyer-select" data-team="${t.id}" data-field="buyerSelect"
                  style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:.25rem .4rem;color:var(--text);width:120px;font-size:.85rem;">
            ${buyerOpts}
          </select>
          <input type="text" class="bid-input buyer-other" data-team="${t.id}" data-field="buyerOther"
                 value="${isOther ? esc(curBuyer) : ''}" placeholder="Name"
                 style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:.25rem .4rem;color:var(--text);width:100px;margin-top:3px;font-size:.85rem;display:${isOther ? 'block' : 'none'};">
        </td>
        <td>
          <input type="number" class="bid-input" data-team="${t.id}" data-field="amount"
                 value="${bid?.amount || 0}" min="0" step="5"
                 style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:.25rem .4rem;color:var(--text);width:70px;font-size:.85rem;">
        </td>
        <td>
          <input type="checkbox" class="bid-input" data-team="${t.id}" data-field="selfBuyBack"
                 ${bid?.selfBuyBack !== false ? 'checked' : ''}>
        </td>
        <td style="text-align:right">${expReturn}</td>
        <td style="text-align:right;color:${evColor}">${evProfit}</td>
        <td style="text-align:right">${optBid}</td>
      `;
      tbody.appendChild(tr);
    }

    // Auto-save helper: reads row fields and persists
    function saveRow(row) {
      const teamId = row.dataset.team || row.querySelector('[data-field="buyerSelect"]')?.dataset.team;
      if (!teamId) return;
      const selectVal = row.querySelector('[data-field="buyerSelect"]').value;
      const otherVal = row.querySelector('[data-field="buyerOther"]').value.trim();
      const buyer = (selectVal === '__other__') ? otherVal : selectVal;
      const amount = parseFloat(row.querySelector('[data-field="amount"]').value) || 0;
      const selfBuyBack = row.querySelector('[data-field="selfBuyBack"]').checked;
      CalcuttaData.setBid(teamId, { buyer, amount, selfBuyBack });
      CalcuttaData.save();
      renderPayoutCards();
      runFullAnalysis();
    }

    // Toggle "Other" text field when dropdown changes
    tbody.querySelectorAll('.buyer-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const otherInput = sel.closest('td').querySelector('.buyer-other');
        if (sel.value === '__other__') {
          otherInput.style.display = 'block';
          otherInput.focus();
        } else {
          otherInput.style.display = 'none';
          otherInput.value = '';
        }
        saveRow(sel.closest('tr'));
      });
    });

    // Auto-save on blur for text/number inputs, change for checkboxes
    tbody.querySelectorAll('input[data-field="amount"]').forEach(inp => {
      inp.addEventListener('change', () => saveRow(inp.closest('tr')));
    });
    tbody.querySelectorAll('input[data-field="buyerOther"]').forEach(inp => {
      inp.addEventListener('change', () => saveRow(inp.closest('tr')));
    });
    tbody.querySelectorAll('input[data-field="selfBuyBack"]').forEach(inp => {
      inp.addEventListener('change', () => saveRow(inp.closest('tr')));
    });

    // Info buttons
    tbody.querySelectorAll('.info-btn').forEach(btn => {
      btn.addEventListener('click', () => showTeamInfo(btn.dataset.team));
    });
  }

  // ═══════════════════════════════════════════════════════
  //  TEAM INFO POPUP
  // ═══════════════════════════════════════════════════════
  function showTeamInfo(teamId) {
    const div = CalcuttaData.activeDivision;
    const teamInfo = (BundledData.teamInfo || {})[div] || [];
    const info = teamInfo.find(i => i.id === teamId);
    const team = CalcuttaData.getTeamById(teamId);
    if (!info || !team) return;

    const overlay = document.getElementById('info-overlay');
    const titleEl = document.getElementById('info-title');
    const bodyEl = document.getElementById('info-body');

    titleEl.textContent = team.name;

    // Build roster section
    let html = '<div style="margin-bottom:1rem;">';
    html += '<h4 style="margin:0 0 .5rem;font-size:.9rem;color:var(--accent);">Calcutta Roster</h4>';
    html += '<table style="width:100%;font-size:.85rem;">';
    html += `<tr><td style="padding:.15rem .4rem;"><strong>${esc(info.skip)}</strong> <span style="color:var(--muted);font-size:.75rem;">(skip)</span></td></tr>`;
    for (const m of info.members) {
      html += `<tr><td style="padding:.15rem .4rem;">${esc(m)}</td></tr>`;
    }
    html += '</table></div>';

    // Build league teams section
    if (info.leagueTeams.length > 0) {
      const isMulti = info.leagueTeams.length > 1;
      html += '<div>';
      html += `<h4 style="margin:0 0 .5rem;font-size:.9rem;color:var(--accent);">League Record${isMulti ? 's (Combined)' : ''}</h4>`;

      let totalW = 0, totalL = 0, totalT = 0;

      for (const lt of info.leagueTeams) {
        const gp = lt.wins + lt.losses + lt.ties;
        const wpct = gp > 0 ? ((lt.wins + lt.ties * 0.5) / gp * 100).toFixed(0) : '—';
        totalW += lt.wins; totalL += lt.losses; totalT += lt.ties;

        html += '<div style="margin-bottom:.6rem;padding:.5rem .6rem;background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);">';
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem;">`;
        html += `<strong style="font-size:.85rem;">${esc(lt.team)} <span style="color:var(--muted);font-weight:normal;">(${esc(lt.league)})</span></strong>`;
        html += `<span style="font-size:.85rem;font-weight:600;">${lt.wins}-${lt.losses}-${lt.ties} <span style="color:var(--muted);font-weight:normal;">(${wpct}%)</span></span>`;
        html += '</div>';
        html += '<div style="font-size:.8rem;color:var(--muted);">' + lt.roster.map(esc).join(', ') + '</div>';
        html += '</div>';
      }

      if (isMulti) {
        const totalGP = totalW + totalL + totalT;
        const totalPct = totalGP > 0 ? ((totalW + totalT * 0.5) / totalGP * 100).toFixed(0) : '—';
        html += '<div style="padding:.4rem .6rem;border-top:1px solid var(--border);font-size:.85rem;font-weight:600;">';
        html += `Combined: ${totalW}-${totalL}-${totalT} (${totalPct}%)`;
        html += '</div>';
      }

      html += '</div>';
    }

    bodyEl.innerHTML = html;
    overlay.classList.remove('hidden');
  }

  function bindInfoPopup() {
    const overlay = document.getElementById('info-overlay');
    document.getElementById('info-close').addEventListener('click', () => {
      overlay.classList.add('hidden');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) overlay.classList.add('hidden');
    });
  }

  function renderPayoutCards() {
    const payouts = CalcuttaData.eventPayouts();
    const pcts = CalcuttaData.config.payoutPcts;
    document.getElementById('payout-a').textContent = fmt$(payouts.A);
    document.getElementById('payout-b').textContent = fmt$(payouts.B);
    document.getElementById('payout-c').textContent = fmt$(payouts.C);
    document.getElementById('payout-d').textContent = fmt$(payouts.D);
    document.getElementById('payout-a-hdr').textContent = `Championship (${Math.round(pcts.A * 100)}%)`;
    document.getElementById('payout-b-hdr').textContent = `Consolation (${Math.round(pcts.B * 100)}%)`;
    document.getElementById('payout-c-hdr').textContent = `C Event (${Math.round(pcts.C * 100)}%)`;
    document.getElementById('payout-d-hdr').textContent = `D Event (${Math.round(pcts.D * 100)}%)`;
  }

  function bindBidActions() {
    document.getElementById('btn-optimize').addEventListener('click', runBudgetOptimizer);
    // Persist buyer selection in module-level var so renderAll() can't reset it
    document.getElementById('opt-buyer').addEventListener('change', (e) => {
      optimizerBuyer = e.target.value;
    });
  }

  // ═══════════════════════════════════════════════════════
  //  BUDGET OPTIMIZER
  // ═══════════════════════════════════════════════════════

  /** Populate the 'My Buyer Name' dropdown from team names + existing buyers. */
  function populateOptimizerBuyerDropdown() {
    const select = document.getElementById('opt-buyer');
    if (!select) return;
    const teams = CalcuttaData.getTeams();
    const bids  = CalcuttaData.getBids();
    const names = new Set();
    for (const t of teams) names.add(t.name);
    for (const b of bids) { if (b.buyer) names.add(b.buyer); }
    select.innerHTML = '<option value="">— planning mode —</option>';
    for (const n of [...names].sort()) {
      select.innerHTML += `<option value="${esc(n)}">${esc(n)}</option>`;
    }
    // Restore from module-level variable — never lost on re-render
    select.value = optimizerBuyer;
  }

  /**
   * Run the budget optimizer and render results.
   * Classifies teams as locked/sold/candidate based on the selected
   * buyer name, then calls PoolEstimator.optimizeBudget().
   */
  function runBudgetOptimizer() {
    const budget    = parseFloat(document.getElementById('opt-budget').value) || 0;
    const buyerName = document.getElementById('opt-buyer').value;
    const objective = document.getElementById('opt-objective').value;
    const container = document.getElementById('optimizer-results');

    if (budget <= 0) {
      container.innerHTML = '<p style="color:var(--danger);">Enter a budget &gt; 0.</p>';
      return;
    }
    if (cachedAnalysis.length === 0 || cachedOdds.length === 0) {
      container.innerHTML = '<p style="color:var(--muted);">Waiting for analysis data…</p>';
      return;
    }

    const bids = CalcuttaData.getBids();
    const cfg  = CalcuttaData.config;
    const keepFrac = 1 - (cfg.buyBack.payoutPct ?? 0.25);

    // Build locked / sold / candidate lists
    const locked     = [];
    const candidates = [];
    const soldOther  = [];

    for (const a of cachedAnalysis) {
      const bid  = bids.find(b => b.teamId === a.teamId);
      const odds = cachedOdds.find(o => o.teamId === a.teamId);
      if (!odds) continue;
      const probs = { A: odds.A, B: odds.B, C: odds.C, D: odds.D };

      if (bid && bid.amount > 0 && buyerName && bid.buyer === buyerName) {
        // Mine — locked in
        locked.push({ teamId: a.teamId, teamName: a.teamName, bid: bid.amount, probs });
      } else if (bid && bid.amount > 0 && buyerName && bid.buyer !== buyerName) {
        // Sold to someone else — unavailable
        soldOther.push({ teamId: a.teamId, teamName: a.teamName, bid: bid.amount, probs });
      } else {
        // Unsold or planning mode (no buyer name selected)
        const price = Math.max(5, Math.round((a.predictedPayout || 50) / 5) * 5);
        candidates.push({
          teamId: a.teamId, teamName: a.teamName, price,
          probs, buyerReturn: a.buyerReturn, optimalBid: a.optimalBid,
        });
      }
    }

    // Estimated pool
    const teams = CalcuttaData.getTeams();
    const priorPool = cfg.priorPools[CalcuttaData.activeDivision] || 0;
    const priorPayouts = CalcuttaData.getPriorPayouts();
    let effectivePriors = priorPayouts;
    if (!effectivePriors || effectivePriors.length === 0) {
      effectivePriors = cachedOdds.map(o => {
        const share = (o.A * cfg.payoutPcts.A) + (o.B * cfg.payoutPcts.B) +
                      (o.C * cfg.payoutPcts.C) + (o.D * cfg.payoutPcts.D);
        return { teamId: o.teamId, amount: share * priorPool };
      });
    }
    const poolEst = PoolEstimator.estimatePayouts(
      teams, bids, effectivePriors, priorPool
    );
    const estPool = PoolEstimator.estimatedPool(poolEst);

    const t0 = performance.now();
    const result = PoolEstimator.optimizeBudget({
      candidates, locked, budget, estPool,
      payoutPcts: cfg.payoutPcts, keepFrac, objective,
    });
    const elapsed = (performance.now() - t0).toFixed(0);

    renderOptimizerResults(result, soldOther, budget, elapsed);
  }

  /**
   * Render the optimizer output into #optimizer-results.
   */
  function renderOptimizerResults(result, soldOther, budget, elapsed) {
    const container = document.getElementById('optimizer-results');
    const selectedIds = new Set(result.selected.map(s => s.teamId));

    // --- Summary cards ---
    const summaryHTML = `
      <div class="payout-grid" style="margin-bottom:1rem;">
        <div class="payout-card" style="border-left:3px solid var(--accent);">
          <h4 style="font-size:.75rem;">Total Spend</h4>
          <p class="big-number" style="font-size:1.3rem;">${fmt$(result.totalSpend)}</p>
          <span style="font-size:.7rem;color:var(--muted);">of ${fmt$(budget)} budget</span>
        </div>
        <div class="payout-card" style="border-left:3px solid var(--success);">
          <h4 style="font-size:.75rem;">P(Payback)</h4>
          <p class="big-number" style="font-size:1.3rem;">${(result.paybackProb * 100).toFixed(1)}%</p>
          <span style="font-size:.7rem;color:var(--muted);">payout ≥ cost</span>
        </div>
        <div class="payout-card" style="border-left:3px solid #a78bfa;">
          <h4 style="font-size:.75rem;">P(Any Win)</h4>
          <p class="big-number" style="font-size:1.3rem;">${(result.pWinAny * 100).toFixed(1)}%</p>
          <span style="font-size:.7rem;color:var(--muted);">win at least one event</span>
        </div>
        <div class="payout-card" style="border-left:3px solid ${result.ev >= 0 ? 'var(--success)' : 'var(--danger)'};">
          <h4 style="font-size:.75rem;">Expected Value</h4>
          <p class="big-number" style="font-size:1.3rem;">${fmt$(result.ev)}</p>
          <span style="font-size:.7rem;color:var(--muted);">exp. return ${fmt$(result.expectedReturn)}</span>
        </div>
      </div>
      <div style="display:flex;gap:1.5rem;flex-wrap:wrap;font-size:.8rem;color:var(--muted);margin-bottom:.8rem;">
        <span>Locked: ${result.locked.length} teams (${fmt$(result.lockedSpend)})</span>
        <span>Buy: ${result.selected.length} teams (${fmt$(result.candidateSpend)})</span>
        <span>Remaining: ${fmt$(result.budgetRemaining)}</span>
        <span>Pool est: ${fmt$(result.payoutAmounts.A + result.payoutAmounts.B + result.payoutAmounts.C + result.payoutAmounts.D)}</span>
        <span>Solved in ${elapsed} ms</span>
      </div>
    `;

    // --- Event breakdown ---
    const p = result.portfolioProbs;
    const eventHTML = `
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem;">
        <span class="badge" style="background:#4f8cff22;color:#4f8cff;padding:.2rem .6rem;border-radius:4px;font-size:.8rem;">
          Champ ${(p.A * 100).toFixed(1)}%</span>
        <span class="badge" style="background:#a78bfa22;color:#a78bfa;padding:.2rem .6rem;border-radius:4px;font-size:.8rem;">
          Consol ${(p.B * 100).toFixed(1)}%</span>
        <span class="badge" style="background:#34d39922;color:#34d399;padding:.2rem .6rem;border-radius:4px;font-size:.8rem;">
          C Event ${(p.C * 100).toFixed(1)}%</span>
        <span class="badge" style="background:#fbbf2422;color:#fbbf24;padding:.2rem .6rem;border-radius:4px;font-size:.8rem;">
          D Event ${(p.D * 100).toFixed(1)}%</span>
      </div>
    `;

    // --- Team table ---
    let rows = '';
    // Locked teams first
    for (const t of result.locked) {
      rows += `<tr style="background:rgba(79,140,255,0.06);">
        <td style="color:var(--accent);">&#x1F512; Locked</td>
        <td><strong>${esc(t.teamName)}</strong></td>
        <td style="text-align:right;">${fmt$(t.bid)}</td>
        <td style="text-align:right;">${pct(t.probs.A + t.probs.B + t.probs.C + t.probs.D)}</td>
        <td style="text-align:right;">${pct(t.probs.A)}</td>
        <td style="text-align:right;">${pct(t.probs.B)}</td>
        <td style="text-align:right;">${pct(t.probs.C)}</td>
        <td style="text-align:right;">${pct(t.probs.D)}</td>
      </tr>`;
    }
    // Recommended buys (sorted by EV descending)
    const buyTeams = [...result.selected].sort(
      (a, b) => (b.probs.A + b.probs.B + b.probs.C + b.probs.D) -
                (a.probs.A + a.probs.B + a.probs.C + a.probs.D)
    );
    for (const t of buyTeams) {
      rows += `<tr style="background:rgba(52,211,153,0.08);">
        <td style="color:var(--success);font-weight:600;">&#x2705; Buy</td>
        <td><strong>${esc(t.teamName)}</strong></td>
        <td style="text-align:right;">${fmt$(t.price)}</td>
        <td style="text-align:right;">${pct(t.probs.A + t.probs.B + t.probs.C + t.probs.D)}</td>
        <td style="text-align:right;">${pct(t.probs.A)}</td>
        <td style="text-align:right;">${pct(t.probs.B)}</td>
        <td style="text-align:right;">${pct(t.probs.C)}</td>
        <td style="text-align:right;">${pct(t.probs.D)}</td>
      </tr>`;
    }
    // Skipped candidates
    const skipped = result.allCandidates.filter(c => !selectedIds.has(c.teamId));
    for (const t of skipped) {
      rows += `<tr style="opacity:.5;">
        <td style="color:var(--muted);">&#x274C; Skip</td>
        <td>${esc(t.teamName)}</td>
        <td style="text-align:right;">${fmt$(t.price)}</td>
        <td style="text-align:right;">${pct(t.probs.A + t.probs.B + t.probs.C + t.probs.D)}</td>
        <td style="text-align:right;">${pct(t.probs.A)}</td>
        <td style="text-align:right;">${pct(t.probs.B)}</td>
        <td style="text-align:right;">${pct(t.probs.C)}</td>
        <td style="text-align:right;">${pct(t.probs.D)}</td>
      </tr>`;
    }
    // Sold to others
    for (const t of soldOther) {
      rows += `<tr style="opacity:.35;">
        <td style="color:var(--muted);">Sold</td>
        <td>${esc(t.teamName)}</td>
        <td style="text-align:right;">${fmt$(t.bid)}</td>
        <td style="text-align:right;">${pct(t.probs.A + t.probs.B + t.probs.C + t.probs.D)}</td>
        <td style="text-align:right;">—</td>
        <td style="text-align:right;">—</td>
        <td style="text-align:right;">—</td>
        <td style="text-align:right;">—</td>
      </tr>`;
    }

    const tableHTML = `
      <table style="width:100%;font-size:.85rem;">
        <thead>
          <tr>
            <th style="width:5rem;">Status</th>
            <th>Team</th>
            <th style="text-align:right;">Price</th>
            <th style="text-align:right;">Win&nbsp;Any</th>
            <th style="text-align:right;">Champ</th>
            <th style="text-align:right;">Consol</th>
            <th style="text-align:right;">C</th>
            <th style="text-align:right;">D</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    container.innerHTML = summaryHTML + eventHTML + tableHTML;
  }

  // ═══════════════════════════════════════════════════════
  //  ODDS TABLE & CHART
  // ═══════════════════════════════════════════════════════
  function renderOdds() {
    const tbody = document.querySelector('#odds-table tbody');
    tbody.innerHTML = '';

    if (cachedOdds.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;">No odds data available</td></tr>';
      clearCanvas('odds-chart');
      return;
    }

    const sorted = [...cachedOdds].sort((a, b) => b.A - a.A);
    for (const row of sorted) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(row.teamName)}</strong>${overrideBadge(row.teamName)}</td>
        <td>${pct(row.A)}</td>
        <td>${pct(row.B)}</td>
        <td>${pct(row.C)}</td>
        <td>${pct(row.D)}</td>
        <td>${pct(row.any)}</td>
      `;
      tbody.appendChild(tr);
    }

    renderOddsChart(sorted);
  }

  function renderOddsChart(odds) {
    const canvas = document.getElementById('odds-chart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // If panel is hidden (display:none), rect is 0 — skip to avoid corrupting canvas
    if (rect.width < 10 || rect.height < 10) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (odds.length === 0) return;

    const margin = { top: 30, right: 20, bottom: 60, left: 50 };
    const w = rect.width - margin.left - margin.right;
    const h = rect.height - margin.top - margin.bottom;
    const barGroupWidth = w / odds.length;
    const barWidth = Math.max(3, barGroupWidth * 0.18);
    const gap = 2;

    const colors = ['#4f8cff', '#a78bfa', '#34d399', '#fbbf24'];
    const events = ['A', 'B', 'C', 'D'];
    const eventLabels = ['Champ', 'Consol', 'C', 'D'];
    const maxVal = Math.max(0.01, ...odds.map(o => Math.max(o.A, o.B, o.C, o.D)));

    // Y axis
    ctx.strokeStyle = '#2e3344';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = margin.top + h - (h * i / 5);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + w, y);
      ctx.stroke();
      ctx.fillStyle = '#8b8fa3';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(pct(maxVal * i / 5), margin.left - 5, y + 4);
    }

    // Bars
    for (let i = 0; i < odds.length; i++) {
      const x0 = margin.left + i * barGroupWidth + barGroupWidth / 2 - (barWidth * 2 + gap * 1.5);
      for (let e = 0; e < 4; e++) {
        const val = odds[i][events[e]];
        const barH = (val / maxVal) * h;
        const x = x0 + e * (barWidth + gap);
        const y = margin.top + h - barH;
        ctx.fillStyle = colors[e];
        ctx.fillRect(x, y, barWidth, barH);
      }
      // Team label
      ctx.save();
      ctx.fillStyle = '#8b8fa3';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      const labelX = margin.left + i * barGroupWidth + barGroupWidth / 2;
      ctx.translate(labelX, margin.top + h + 10);
      ctx.rotate(Math.PI / 4);
      ctx.fillText(odds[i].teamName.substring(0, 10), 0, 0);
      ctx.restore();
    }

    // Legend
    const legendY = 12;
    let legendX = margin.left;
    for (let e = 0; e < 4; e++) {
      ctx.fillStyle = colors[e];
      ctx.fillRect(legendX, legendY, 10, 10);
      ctx.fillStyle = '#e4e6ed';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(eventLabels[e], legendX + 14, legendY + 9);
      legendX += 75;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ODDS LOADING (from pre-computed Python output)
  // ═══════════════════════════════════════════════════════
  async function loadPrecomputedOdds() {
    const precomputed = await OddsLoader.loadCurrentOdds();
    const teams = CalcuttaData.getTeams();

    if (precomputed && precomputed.length > 0) {
      cachedOdds = OddsLoader.mapToTeams(precomputed, teams);
    } else {
      cachedOdds = [];
    }
    renderOdds();
  }

  function bindOddsActions() {
    // Odds are bundled inline — no reload needed
  }

  // ═══════════════════════════════════════════════════════
  //  EXPECTED VALUE / ANALYSIS
  // ═══════════════════════════════════════════════════════
  function renderAnalysis() {
    const poolBody = document.querySelector('#pool-table tbody');
    poolBody.innerHTML = '';

    if (cachedAnalysis.length === 0) {
      poolBody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center;">—</td></tr>';
      clearCanvas('ev-chart');
      return;
    }

    const sorted = [...cachedAnalysis].sort((a, b) => b.ev - a.ev);

    // Pool estimate table
    for (const row of sorted) {
      const ptr = document.createElement('tr');
      ptr.innerHTML = `
        <td>${esc(row.teamName)}</td>
        <td>${fmt$(row.priorPayout)}</td>
        <td>${row.scaleFactor.toFixed(2)}×</td>
        <td>${fmt$(row.predictedPayout)}</td>
      `;
      poolBody.appendChild(ptr);
    }

    renderEVChart(sorted);
  }

  function renderEVChart(analysis) {
    const canvas = document.getElementById('ev-chart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (analysis.length === 0) return;

    const margin = { top: 30, right: 20, bottom: 60, left: 60 };
    const w = rect.width - margin.left - margin.right;
    const h = rect.height - margin.top - margin.bottom;
    const barWidth = Math.max(8, w / analysis.length * 0.6);

    const maxAbs = Math.max(10, ...analysis.map(a => Math.abs(a.ev)));
    const midY = margin.top + h / 2;

    // Zero line
    ctx.strokeStyle = '#2e3344';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, midY);
    ctx.lineTo(margin.left + w, midY);
    ctx.stroke();
    ctx.fillStyle = '#8b8fa3';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('$0', margin.left - 5, midY + 4);

    // Grid
    for (let v of [-maxAbs, -maxAbs / 2, maxAbs / 2, maxAbs]) {
      const y = midY - (v / maxAbs) * (h / 2);
      ctx.strokeStyle = '#1e2130';
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + w, y);
      ctx.stroke();
      ctx.fillStyle = '#8b8fa3';
      ctx.fillText(fmt$(v), margin.left - 5, y + 4);
    }

    // Bars
    for (let i = 0; i < analysis.length; i++) {
      const ev = analysis[i].ev;
      const barH = (Math.abs(ev) / maxAbs) * (h / 2);
      const x = margin.left + (i + 0.5) * (w / analysis.length) - barWidth / 2;
      const y = ev >= 0 ? midY - barH : midY;

      ctx.fillStyle = ev >= 0 ? '#34d399' : '#f87171';
      ctx.fillRect(x, y, barWidth, barH);

      // Label
      ctx.save();
      ctx.fillStyle = '#8b8fa3';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.translate(x + barWidth / 2, margin.top + h + 10);
      ctx.rotate(Math.PI / 4);
      ctx.fillText(analysis[i].teamName.substring(0, 10), 0, 0);
      ctx.restore();
    }

    // Title
    ctx.fillStyle = '#e4e6ed';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Expected Value by Team', margin.left, 16);
  }

  function bindAnalysisActions() {
    // Analysis auto-runs on load and after each bid save
  }

  async function runFullAnalysis() {
    const teams = CalcuttaData.getTeams();
    if (teams.length < 2) return;

    const bids = CalcuttaData.getBids();
    const cfg = CalcuttaData.config;
    const draw = CalcuttaData.getDraw();
    const priorPayouts = CalcuttaData.getPriorPayouts();
    const priorPool = cfg.priorPools[CalcuttaData.activeDivision] || 0;
    const currentPool = CalcuttaData.totalPool();
    const payouts = CalcuttaData.eventPayouts();

    // 1. Load pre-computed odds if not already cached
    if (cachedOdds.length === 0) {
      const precomputed = await OddsLoader.loadCurrentOdds();
      if (precomputed) {
        cachedOdds = OddsLoader.mapToTeams(precomputed, teams);
      } else {
        return;
      }
    }

    // 2. Pool estimation (prior-year scaling)
    // If no prior payouts exist, derive them from odds so predictions
    // are proportional to each team's win probabilities, not flat equal.
    let effectivePriors = priorPayouts;
    if (!effectivePriors || effectivePriors.length === 0) {
      const basePcts = cfg.payoutPcts;
      effectivePriors = cachedOdds.map(o => {
        const share = (o.A * basePcts.A) + (o.B * basePcts.B) +
                      (o.C * basePcts.C) + (o.D * basePcts.D);
        return { teamId: o.teamId, amount: share * priorPool };
      });
    }

    const poolEstimates = PoolEstimator.estimatePayouts(
      teams, bids, effectivePriors, priorPool
    );
    const estPool = PoolEstimator.estimatedPool(poolEstimates);
    // Scale event payouts by estimated pool
    const estPayouts = {
      A: estPool * cfg.payoutPcts.A,
      B: estPool * cfg.payoutPcts.B,
      C: estPool * cfg.payoutPcts.C,
      D: estPool * cfg.payoutPcts.D,
    };

    // 3. Compute EV for each team
    cachedAnalysis = [];
    for (const est of poolEstimates) {
      const odds = cachedOdds.find(o => o.teamId === est.teamId);
      if (!odds) continue;

      const probs = { A: odds.A, B: odds.B, C: odds.C, D: odds.D };
      // Pool without this team's contribution (for elastic optimal bid)
      const poolWithoutTeam = estPool - (est.bid > 0 ? est.bid : est.predictedPayout);
      const poolCtx = { poolWithoutTeam, payoutPcts: cfg.payoutPcts };
      // selfBuyBack checked (true) = skip WILL buy back 25% → buyer keeps 75%.
      // selfBuyBack unchecked (false) = skip opted out → buyer keeps 100%.
      // Default to true (checked) so noBuyBack is false unless explicitly unchecked.
      const bidRecord = bids.find(b => b.teamId === est.teamId);
      const noBuyBack = bidRecord ? (bidRecord.selfBuyBack === false) : false;
      const evResult = PoolEstimator.computeEV(probs, estPayouts, est.bid, noBuyBack, cfg.buyBack, poolCtx);

      // Target-return bid: the bid that yields the configured return on investment.
      // optimalBid is the zero-EV ceiling; dividing by (1 + targetReturnPct)
      // gives the bid where expected profit = targetReturnPct × cost.
      const targetReturn = cfg.targetReturnPct ?? 0;
      const targetOptimalBid = evResult.optimalBid === Infinity
        ? Infinity
        : evResult.optimalBid / (1 + targetReturn);

      cachedAnalysis.push({
        teamId: est.teamId,
        teamName: est.teamName,
        bid: est.bid,
        priorPayout: est.priorPayout,
        predictedPayout: est.predictedPayout,
        scaleFactor: est.scaleFactor,
        grossEV: evResult.grossEV,
        buyerReturn: evResult.buyerReturn,
        buyerEV: evResult.buyerEV,
        ev: evResult.ev,
        optimalBid: evResult.optimalBid,
        targetOptimalBid,
      });
    }

    renderAll();
  }

  // ═══════════════════════════════════════════════════════
  //  TEAM MODAL
  // ═══════════════════════════════════════════════════════
  function openTeamModal(teamId) {
    const team = teamId ? CalcuttaData.getTeamById(teamId) : null;
    const isEdit = !!team;

    document.getElementById('modal-title').textContent = isEdit ? 'Edit Team' : 'Add Team';
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <div class="form-group">
        <label>Team Name</label>
        <input type="text" id="inp-team-name" value="${esc(team?.name || '')}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.6rem;">
        <div class="form-group"><label>Wins</label><input type="number" id="inp-team-w" value="${team?.wins ?? 0}" min="0"></div>
        <div class="form-group"><label>Losses</label><input type="number" id="inp-team-l" value="${team?.losses ?? 0}" min="0"></div>
        <div class="form-group"><label>Ties</label><input type="number" id="inp-team-t" value="${team?.ties ?? 0}" min="0"></div>
      </div>
      <div class="form-group">
        <label>Seed</label>
        <input type="number" id="inp-team-seed" value="${team?.seed ?? CalcuttaData.getTeams().length + 1}" min="1">
      </div>
    `;

    showModal(() => {
      const fields = {
        name: document.getElementById('inp-team-name').value.trim() || 'New Team',
        wins: parseInt(document.getElementById('inp-team-w').value) || 0,
        losses: parseInt(document.getElementById('inp-team-l').value) || 0,
        ties: parseInt(document.getElementById('inp-team-t').value) || 0,
        seed: parseInt(document.getElementById('inp-team-seed').value) || 99,
      };

      if (isEdit) {
        CalcuttaData.updateTeam(teamId, fields);
      } else {
        CalcuttaData.addTeam(fields);
      }
      CalcuttaData.save();
      cachedOdds = [];
      cachedAnalysis = [];
      renderAll();
      loadPrecomputedOdds();
    });
  }

  function bindTeamActions() {
    // Teams come from bundled data — no manual add/import/export needed
  }

  // ═══════════════════════════════════════════════════════
  //  MODAL HELPERS
  // ═══════════════════════════════════════════════════════
  let modalSaveCallback = null;

  function showModal(onSave) {
    modalSaveCallback = onSave;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function hideModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    modalSaveCallback = null;
  }

  function bindModal() {
    document.querySelector('.modal-close').addEventListener('click', hideModal);
    document.getElementById('modal-cancel').addEventListener('click', hideModal);
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideModal();
    });
    document.getElementById('modal-save').addEventListener('click', () => {
      if (modalSaveCallback) modalSaveCallback();
      hideModal();
    });
  }

  // ═══════════════════════════════════════════════════════
  //  SETTINGS
  // ═══════════════════════════════════════════════════════
  function syncSettingsUI() {
    const c = CalcuttaData.config;
    document.getElementById('set-payout-a').value = c.payoutPcts.A * 100;
    document.getElementById('set-payout-b').value = c.payoutPcts.B * 100;
    document.getElementById('set-payout-c').value = c.payoutPcts.C * 100;
    document.getElementById('set-payout-d').value = c.payoutPcts.D * 100;
    document.getElementById('set-mens-pool').value = c.priorPools.mens;
    document.getElementById('set-womens-pool').value = c.priorPools.womens;
    document.getElementById('set-buyback-fee').value = c.buyBack.fee;
    document.getElementById('set-buyback-pct').value = c.buyBack.payoutPct * 100;
    document.getElementById('set-target-return').value = (c.targetReturnPct ?? 0) * 100;
    const targetPct = Math.round((c.targetReturnPct ?? 0) * 100);
    const colHeader = document.getElementById('bid-col-optimal');
    if (colHeader) {
      colHeader.textContent = targetPct > 0 ? `Target (${targetPct}%)` : 'Optimal';
    }
  }

  function readSettingsFromUI() {
    const c = CalcuttaData.config;
    c.payoutPcts.A = (parseFloat(document.getElementById('set-payout-a').value) || 40) / 100;
    c.payoutPcts.B = (parseFloat(document.getElementById('set-payout-b').value) || 30) / 100;
    c.payoutPcts.C = (parseFloat(document.getElementById('set-payout-c').value) || 15) / 100;
    c.payoutPcts.D = (parseFloat(document.getElementById('set-payout-d').value) || 15) / 100;
    c.priorPools.mens = parseFloat(document.getElementById('set-mens-pool').value) || 12400;
    c.priorPools.womens = parseFloat(document.getElementById('set-womens-pool').value) || 4700;
    c.buyBack.fee = parseFloat(document.getElementById('set-buyback-fee').value) || 40;
    c.buyBack.payoutPct = (parseFloat(document.getElementById('set-buyback-pct').value) || 25) / 100;
    c.targetReturnPct = (parseFloat(document.getElementById('set-target-return').value) || 0) / 100;
  }

  function bindSettingsActions() {
    // Monitor all settings inputs for changes
    document.querySelectorAll('#settings input').forEach(inp => {
      inp.addEventListener('change', () => {
        readSettingsFromUI();
        syncSettingsUI();
        CalcuttaData.save();
        cachedAnalysis = [];
        renderAll();
        runFullAnalysis();
      });
    });

    document.getElementById('btn-save-all').addEventListener('click', () => {
      readSettingsFromUI();
      CalcuttaData.save();
      alert('All data saved to browser localStorage.');
    });

    document.getElementById('btn-load-all').addEventListener('click', () => {
      CalcuttaData.load();
      syncSettingsUI();
      cachedOdds = [];
      cachedAnalysis = [];
      renderAll();
      alert('Data loaded from localStorage.');
    });

    document.getElementById('btn-export-all').addEventListener('click', () => {
      readSettingsFromUI();
      CalcuttaData.exportAll();
    });

    document.getElementById('btn-clear-all').addEventListener('click', async () => {
      if (confirm('This will clear all bids and settings. Team and odds data will be reloaded from bundled data. Are you sure?')) {
        CalcuttaData.clearAll();
        syncSettingsUI();
        cachedOdds = [];
        cachedAnalysis = [];
        await autoLoadData();
        loadBracketTree();
        await loadPrecomputedOdds();
        renderAll();
        runFullAnalysis();
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  UTILITY
  // ═══════════════════════════════════════════════════════
  /**
   * Return an HTML badge if this team has an active win-pct override.
   * Keyed by team name (lowercase) in BundledData.overrides.
   * @param {string} teamName
   * @returns {string} HTML string — empty if no override
   */
  function overrideBadge(teamName) {
    const overrides = BundledData.overrides || {};
    const key = (teamName || '').toLowerCase();
    if (!(key in overrides)) return '';
    const pctVal = (overrides[key] * 100).toFixed(1);
    return `<span title="Win % manually overridden to ${pctVal}%" ` +
      `style="display:inline-block;margin-left:.4rem;padding:.05rem .3rem;` +
      `background:#fbbf2425;border:1px solid #fbbf2455;border-radius:3px;` +
      `font-size:.68rem;color:#fbbf24;vertical-align:middle;cursor:default;` +
      `line-height:1.4;">&#9733; override</span>`;
  }

  function fmt$(n) {
    if (typeof n !== 'number' || isNaN(n)) return '$0';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString();
  }

  function pct(n) {
    return (n * 100).toFixed(1) + '%';
  }

  function esc(s) {
    const el = document.createElement('span');
    el.textContent = s ?? '';
    return el.innerHTML;
  }

  function clearCanvas(id) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#8b8fa3';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data — run calculation first', rect.width / 2, rect.height / 2);
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

})();
