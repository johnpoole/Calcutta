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

  // ═══════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async () => {
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
    renderAll();
    // Auto-load pre-computed odds, bracket tree, and run analysis on startup
    loadPrecomputedOdds().then(() => runFullAnalysis());
    loadBracketTree();
  });

  async function autoLoadData() {
    try {
      for (const div of ['mens', 'womens']) {
        const [teamsResp, drawResp] = await Promise.all([
          fetch(`data/teams_${div}.json`),
          fetch(`data/draw_${div}.json`),
        ]);
        if (teamsResp.ok) {
          const teams = await teamsResp.json();
          CalcuttaData.activeDivision = div;
          // Import teams array into the active division
          CalcuttaData.importJSON(teams);
        }
        if (drawResp.ok) {
          const draw = await drawResp.json();
          CalcuttaData.activeDivision = div;
          CalcuttaData.state[div].draw = draw;
        }
      }
      CalcuttaData.activeDivision = 'mens';
      CalcuttaData.state.config = CalcuttaData.config; // keep defaults
      CalcuttaData.save();
      console.log('Auto-loaded team and draw data from JSON files.');
    } catch (e) {
      console.warn('Auto-load failed (OK if running without data files):', e);
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
          renderAll();
          loadPrecomputedOdds().then(() => runFullAnalysis());
          loadBracketTree();
        });
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  RENDER ALL
  // ═══════════════════════════════════════════════════════
  function renderAll() {
    renderDashboard();
    renderStandings();
    renderH2H();
    renderBracket();
    renderBids();
    renderPayoutCards();
    renderOdds();
    renderAnalysis();
  }

  // ═══════════════════════════════════════════════════════
  //  DASHBOARD
  // ═══════════════════════════════════════════════════════
  function renderDashboard() {
    const teams = CalcuttaData.getTeams();
    const pool = CalcuttaData.totalPool();
    const bids = CalcuttaData.getBids();

    document.getElementById('dash-pool').textContent = fmt$(pool);
    document.getElementById('dash-teams').textContent = teams.length;

    const maxBid = bids.length > 0 ? Math.max(...bids.map(b => b.amount)) : 0;
    document.getElementById('dash-high-bid').textContent = fmt$(maxBid);

    // Best EV
    if (cachedAnalysis.length > 0) {
      const best = [...cachedAnalysis].sort((a, b) => b.ev - a.ev)[0];
      document.getElementById('dash-best-ev').textContent = best ? fmt$(best.ev) : '—';
    } else {
      document.getElementById('dash-best-ev').textContent = '—';
    }

    // Top 5 table
    const tbody = document.querySelector('#dash-top5 tbody');
    tbody.innerHTML = '';

    if (cachedAnalysis.length > 0) {
      const top5 = [...cachedAnalysis].sort((a, b) => b.ev - a.ev).slice(0, 5);
      for (const row of top5) {
        const odds = cachedOdds.find(o => o.teamId === row.teamId);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${esc(row.teamName)}</td>
          <td>${odds ? pct(odds.A) : '—'}</td>
          <td>${fmt$(row.bid)}</td>
          <td class="${row.ev >= 0 ? 'positive' : 'negative'}">${fmt$(row.ev)}</td>
        `;
        tbody.appendChild(tr);
      }
    } else {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center;">Run analysis to see results</td></tr>';
    }
  }

  // ═══════════════════════════════════════════════════════
  //  STANDINGS TABLE
  // ═══════════════════════════════════════════════════════
  function renderStandings() {
    const tbody = document.querySelector('#standings-table tbody');
    tbody.innerHTML = '';
    const teams = CalcuttaData.getTeams();

    if (teams.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);text-align:center;">No teams added yet</td></tr>';
      return;
    }

    const sorted = [...teams].sort((a, b) => CalcuttaData.winPct(b) - CalcuttaData.winPct(a));
    for (const t of sorted) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(t.name)}</strong></td>
        <td>${t.wins}</td>
        <td>${t.losses}</td>
        <td>${t.ties}</td>
        <td>${pct(CalcuttaData.winPct(t))}</td>
        <td>
          <button class="btn" data-action="edit-team" data-id="${t.id}" style="padding:.2rem .5rem;font-size:.78rem;">Edit</button>
          <button class="btn btn-danger" data-action="delete-team" data-id="${t.id}" style="padding:.2rem .5rem;font-size:.78rem;">×</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    // Bind edit/delete buttons
    tbody.querySelectorAll('[data-action="edit-team"]').forEach(btn => {
      btn.addEventListener('click', () => openTeamModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="delete-team"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Remove this team?')) {
          CalcuttaData.removeTeam(btn.dataset.id);
          CalcuttaData.save();
          renderAll();
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  HEAD-TO-HEAD MATRIX
  // ═══════════════════════════════════════════════════════
  function renderH2H() {
    const container = document.getElementById('h2h-matrix');
    const teams = CalcuttaData.getTeams();
    if (teams.length === 0) {
      container.innerHTML = '<p style="color:var(--muted);">Add teams to see head-to-head matrix</p>';
      return;
    }

    let html = '<table><thead><tr><th></th>';
    for (const t of teams) html += `<th title="${esc(t.name)}">${esc(t.name.substring(0, 6))}</th>`;
    html += '</tr></thead><tbody>';

    for (const t of teams) {
      html += `<tr><th>${esc(t.name.substring(0, 10))}</th>`;
      for (const opp of teams) {
        if (t.id === opp.id) {
          html += '<td class="self">—</td>';
        } else {
          const rec = t.h2h[opp.id];
          if (rec) {
            const cls = rec.w > rec.l ? 'win' : rec.l > rec.w ? 'loss' : '';
            html += `<td class="${cls}">${rec.w}-${rec.l}</td>`;
          } else {
            html += '<td style="color:var(--muted);">—</td>';
          }
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════
  //  DRAW / BRACKET  (renders from bracket-tree JSON)
  // ═══════════════════════════════════════════════════════
  let cachedBracketTree = null;
  let activeEvent = 'a';

  async function loadBracketTree() {
    const div = CalcuttaData.activeDivision;
    try {
      const resp = await fetch(`data/bracket_${div}.json`);
      if (resp.ok) {
        cachedBracketTree = await resp.json();
        renderBracket();
      }
    } catch (e) {
      console.warn('Could not load bracket tree:', e);
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
      container.innerHTML = '<p style="color:var(--muted);">Loading bracket…</p>';
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

    let html = '';
    for (const key of ['a', 'b', 'champ', 'c', 'd', 'path']) {
      html += `<div class="bracket-event${key === activeEvent ? ' active' : ''}" data-event="${key}">${events[key]}</div>`;
    }
    container.innerHTML = html;

    // If path tab is active, initialize the result
    if (activeEvent === 'path') {
      updatePathResult();
      const sel = document.getElementById('path-team-select');
      if (sel) sel.addEventListener('change', updatePathResult);
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

  /**
   * Find the path from a team to the root of a bracket tree.
   * Returns array of { opponents: [teamId, …], roundLabel: string } from
   * first round to qualifier final, or null if team is not in this tree.
   */
  function findPath(node, teamId, depth) {
    if (node.team) {
      return node.team === teamId ? [] : null;
    }
    if (node.slot) return null;
    if (!node.match) return null;
    const m = node.match;

    const leftPath = findPath(m.left, teamId, depth + 1);
    if (leftPath !== null) {
      leftPath.push({ opponents: collectTeams(m.right) });
      return leftPath;
    }
    const rightPath = findPath(m.right, teamId, depth + 1);
    if (rightPath !== null) {
      rightPath.push({ opponents: collectTeams(m.left) });
      return rightPath;
    }
    return null;
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

    // Find which qualifier this team is in
    let qualifierIdx = -1;
    let path = null;
    for (let i = 0; i < tree.a_event.length; i++) {
      path = findPath(tree.a_event[i], teamId, 0);
      if (path) { qualifierIdx = i; break; }
    }

    if (!path) {
      resultEl.innerHTML = '<p style="color:var(--muted);">Team not found in A Event bracket.</p>';
      return;
    }

    const champ = tree.championship;
    const numQ = champ.numQualifiers;
    const qNum = qualifierIdx + 1; // Q1-based

    let html = `<div class="path-rounds">`;

    // A Event path  
    html += `<div class="path-section-title">A Event — Qualifier ${qNum}</div>`;
    const roundNames = getRoundNames(path.length);
    path.forEach((step, i) => {
      html += `<div class="path-round">
        <div class="path-round-label">${roundNames[i]}</div>
        <div class="path-opponents">
          ${step.opponents.length > 0
            ? step.opponents.map(id => `<span class="path-opponent">${esc(teamName(id))}</span>`).join('<span class="path-or">or</span>')
            : '<span class="path-opponent seed-info">TBD (slot)</span>'}
        </div>
      </div>`;
    });

    // Championship path
    html += `<hr class="path-divider"><div class="path-section-title">Championship (as Q${qNum})</div>`;

    if (numQ === 8) {
      // Quarterfinal opponent
      const qfPair = champ.quarterSeed.find(p => p.includes(qualifierIdx));
      const qfOpp = qfPair[0] === qualifierIdx ? qfPair[1] : qfPair[0];
      html += `<div class="path-round">
        <div class="path-round-label">Quarterfinal</div>
        <div class="path-opponents"><span class="path-opponent">Q${qfOpp + 1} winner</span></div>
      </div>`;

      // Which half of the draw? Find the semi pair index
      const qfIdx = champ.quarterSeed.indexOf(qfPair);
      const semiPair = champ.semiPairs.find(p => p.includes(qfIdx));
      const semiOppQfIdx = semiPair[0] === qfIdx ? semiPair[1] : semiPair[0];
      const semiOppSeeds = champ.quarterSeed[semiOppQfIdx];
      html += `<div class="path-round">
        <div class="path-round-label">Semifinal</div>
        <div class="path-opponents">
          <span class="path-opponent">Q${semiOppSeeds[0] + 1}</span>
          <span class="path-or">or</span>
          <span class="path-opponent">Q${semiOppSeeds[1] + 1}</span>
        </div>
      </div>`;

      // Final — the other semi bracket
      const otherSemiIdx = champ.semiPairs.find(p => !p.includes(qfIdx));
      const otherSeeds = otherSemiIdx.flatMap(i => champ.quarterSeed[i]);
      html += `<div class="path-round">
        <div class="path-round-label">Final</div>
        <div class="path-opponents">
          ${otherSeeds.map(s => `<span class="path-opponent">Q${s + 1}</span>`).join('<span class="path-or">or</span>')}
        </div>
      </div>`;
    } else {
      // 4 qualifiers — semifinals then final
      const sfPair = champ.quarterSeed.find(p => p.includes(qualifierIdx));
      const sfOpp = sfPair[0] === qualifierIdx ? sfPair[1] : sfPair[0];
      html += `<div class="path-round">
        <div class="path-round-label">Semifinal</div>
        <div class="path-opponents"><span class="path-opponent">Q${sfOpp + 1} winner</span></div>
      </div>`;

      const otherPair = champ.quarterSeed.find(p => !p.includes(qualifierIdx));
      html += `<div class="path-round">
        <div class="path-round-label">Final</div>
        <div class="path-opponents">
          <span class="path-opponent">Q${otherPair[0] + 1}</span>
          <span class="path-or">or</span>
          <span class="path-opponent">Q${otherPair[1] + 1}</span>
        </div>
      </div>`;
    }

    html += '</div>';
    resultEl.innerHTML = html;
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
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;">No teams added</td></tr>';
      return;
    }

    for (const t of teams) {
      const bid = bids.find(b => b.teamId === t.id);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(t.name)}</td>
        <td>
          <input type="text" class="bid-input" data-team="${t.id}" data-field="buyer"
                 value="${esc(bid?.buyer || '')}" placeholder="Buyer name"
                 style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:.3rem .5rem;color:var(--text);width:120px;">
        </td>
        <td>
          <input type="number" class="bid-input" data-team="${t.id}" data-field="amount"
                 value="${bid?.amount || 0}" min="0" step="5"
                 style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:.3rem .5rem;color:var(--text);width:90px;">
        </td>
        <td>
          <input type="checkbox" class="bid-input" data-team="${t.id}" data-field="selfBuyBack"
                 ${bid?.selfBuyBack ? 'checked' : ''}>
        </td>
        <td>
          <button class="btn" data-action="save-bid" data-team="${t.id}" style="padding:.2rem .5rem;font-size:.78rem;">Save</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    // Save bid buttons
    tbody.querySelectorAll('[data-action="save-bid"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const teamId = btn.dataset.team;
        const row = btn.closest('tr');
        const buyer = row.querySelector('[data-field="buyer"]').value;
        const amount = parseFloat(row.querySelector('[data-field="amount"]').value) || 0;
        const selfBuyBack = row.querySelector('[data-field="selfBuyBack"]').checked;
        CalcuttaData.setBid(teamId, { buyer, amount, selfBuyBack });
        CalcuttaData.save();
        renderPayoutCards();
        renderDashboard();
      });
    });
  }

  function renderPayoutCards() {
    const payouts = CalcuttaData.eventPayouts();
    document.getElementById('payout-a').textContent = fmt$(payouts.A);
    document.getElementById('payout-b').textContent = fmt$(payouts.B);
    document.getElementById('payout-c').textContent = fmt$(payouts.C);
    document.getElementById('payout-d').textContent = fmt$(payouts.D);
  }

  function bindBidActions() {
    document.getElementById('btn-import-bids').addEventListener('click', () => {
      document.getElementById('file-import-bids').click();
    });
    document.getElementById('file-import-bids').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (Array.isArray(data)) {
            for (const b of data) CalcuttaData.setBid(b.teamId, b);
            CalcuttaData.save();
            renderAll();
          }
        } catch (err) { alert('Invalid JSON: ' + err.message); }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('btn-export-bids').addEventListener('click', () => {
      const bids = CalcuttaData.getBids();
      downloadJSON(bids, `bids_${CalcuttaData.activeDivision}.json`);
    });
  }

  // ═══════════════════════════════════════════════════════
  //  ODDS TABLE & CHART
  // ═══════════════════════════════════════════════════════
  function renderOdds() {
    const tbody = document.querySelector('#odds-table tbody');
    tbody.innerHTML = '';

    if (cachedOdds.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;">Click "Recalculate Odds" to compute probabilities</td></tr>';
      clearCanvas('odds-chart');
      return;
    }

    const sorted = [...cachedOdds].sort((a, b) => b.A - a.A);
    for (const row of sorted) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(row.teamName)}</strong></td>
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
      ctx.fillText(events[e] + ' Event', legendX + 14, legendY + 9);
      legendX += 75;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ODDS LOADING (from pre-computed Python output)
  // ═══════════════════════════════════════════════════════
  async function loadPrecomputedOdds() {
    const statusEl = document.getElementById('odds-status');
    if (statusEl) statusEl.textContent = 'Loading…';

    const precomputed = await OddsLoader.loadCurrentOdds();
    const teams = CalcuttaData.getTeams();

    if (precomputed && precomputed.length > 0) {
      cachedOdds = OddsLoader.mapToTeams(precomputed, teams);
      if (statusEl) statusEl.textContent = `Loaded ${cachedOdds.length} teams (from data/odds_${CalcuttaData.activeDivision}.json)`;
    } else {
      cachedOdds = [];
      if (statusEl) statusEl.textContent = 'No odds file found — run scripts/calculate_odds.py first';
    }
    renderOdds();
    renderDashboard();
  }

  function bindOddsActions() {
    document.getElementById('btn-reload-odds').addEventListener('click', () => {
      OddsLoader.clearCache();
      loadPrecomputedOdds();
    });
  }

  // ═══════════════════════════════════════════════════════
  //  EXPECTED VALUE / ANALYSIS
  // ═══════════════════════════════════════════════════════
  function renderAnalysis() {
    const tbody = document.querySelector('#ev-table tbody');
    tbody.innerHTML = '';
    const poolBody = document.querySelector('#pool-table tbody');
    poolBody.innerHTML = '';

    if (cachedAnalysis.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;">Click "Run Full Analysis" to compute</td></tr>';
      poolBody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center;">—</td></tr>';
      clearCanvas('ev-chart');
      return;
    }

    const sorted = [...cachedAnalysis].sort((a, b) => b.ev - a.ev);
    for (const row of sorted) {
      const rating = row.ev > 50 ? 'great' : row.ev > 0 ? 'good' : row.ev > -50 ? 'fair' : 'poor';
      const ratingLabel = row.ev > 50 ? 'Great' : row.ev > 0 ? 'Good' : row.ev > -50 ? 'Fair' : 'Avoid';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(row.teamName)}</strong></td>
        <td>${fmt$(row.bid)}</td>
        <td>${fmt$(row.predictedPayout)}</td>
        <td style="color:${row.ev >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt$(row.ev)}</td>
        <td>${fmt$(row.optimalBid)}</td>
        <td><span class="badge badge-${rating}">${ratingLabel}</span></td>
      `;
      tbody.appendChild(tr);
    }

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
    document.getElementById('btn-run-analysis').addEventListener('click', runFullAnalysis);
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
      const evResult = PoolEstimator.computeEV(probs, estPayouts, est.bid, est.selfBuyBack, cfg.buyBack);

      cachedAnalysis.push({
        teamId: est.teamId,
        teamName: est.teamName,
        bid: est.bid,
        priorPayout: est.priorPayout,
        predictedPayout: est.predictedPayout,
        scaleFactor: est.scaleFactor,
        grossEV: evResult.grossEV,
        ev: evResult.ev,
        evWithBuyBack: evResult.evWithBuyBack,
        optimalBid: evResult.optimalBid,
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
    document.getElementById('btn-add-team').addEventListener('click', () => openTeamModal(null));

    document.getElementById('btn-import-teams').addEventListener('click', () => {
      document.getElementById('file-import-teams').click();
    });
    document.getElementById('file-import-teams').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const ok = CalcuttaData.importJSON(ev.target.result);
        if (ok) {
          cachedOdds = [];
          cachedAnalysis = [];
          renderAll();
        }
        else alert('Import failed — check JSON format.');
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('btn-export-teams').addEventListener('click', () => {
      downloadJSON(CalcuttaData.getTeams(), `teams_${CalcuttaData.activeDivision}.json`);
    });
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

  }

  function bindSettingsActions() {
    // Monitor all settings inputs for changes
    document.querySelectorAll('#settings input').forEach(inp => {
      inp.addEventListener('change', () => {
        readSettingsFromUI();
        CalcuttaData.save();
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

    document.getElementById('btn-clear-all').addEventListener('click', () => {
      if (confirm('This will delete ALL data. Are you sure?')) {
        CalcuttaData.clearAll();
        syncSettingsUI();
        cachedOdds = [];
        cachedAnalysis = [];
        renderAll();
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  UTILITY
  // ═══════════════════════════════════════════════════════
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
