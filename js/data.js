/* ═══════════════════════════════════════════════════════════
   Calcutta Auction — Data Module
   Manages all team, draw, bid, and historical data.
   Everything is held in-memory and persisted to localStorage.
   ═══════════════════════════════════════════════════════════ */

const CalcuttaData = (() => {
  'use strict';

  // ── Default configuration ──────────────────────────────
  const DEFAULT_CONFIG = {
    payoutPcts: { A: 0.40, B: 0.30, C: 0.15, D: 0.15 },
    priorPools: { mens: 12400, womens: 4700 },
    buyBack: { fee: 40, payoutPct: 0.25 },

    weights: { standings: 0.5, h2h: 0.3, draw: 0.2 },
    currentYear: 2026,
  };

  // ── State ──────────────────────────────────────────────
  let state = {
    config: structuredClone(DEFAULT_CONFIG),
    activeDivision: 'mens',
    mens: { teams: [], draw: [], bids: [], priorPayouts: [] },
    womens: { teams: [], draw: [], bids: [], priorPayouts: [] },
  };

  // ── Team schema ────────────────────────────────────────
  /**
   * @typedef {Object} Team
   * @property {string}  id         - unique slug
   * @property {string}  name       - display name
   * @property {number}  wins
   * @property {number}  losses
   * @property {number}  ties
   * @property {Object}  h2h        - { opponentId: { w, l } }
   * @property {number}  seed       - seeding rank (1 = best)
   */
  function createTeam(overrides = {}) {
    return {
      id: overrides.id || crypto.randomUUID().slice(0, 8),
      name: overrides.name || 'New Team',
      wins: overrides.wins ?? 0,
      losses: overrides.losses ?? 0,
      ties: overrides.ties ?? 0,
      h2h: overrides.h2h || {},
      seed: overrides.seed ?? 99,
    };
  }

  // ── Draw match schema ──────────────────────────────────
  /**
   * @typedef {Object} DrawMatch
   * @property {string} id
   * @property {number} drawNum     - round / draw number
   * @property {string} sheet       - sheet letter
   * @property {string} team1Id
   * @property {string} team2Id
   * @property {string} event       - A | B | C | D
   * @property {string} winnerId    - '' until result known
   */
  function createMatch(overrides = {}) {
    return {
      id: overrides.id || crypto.randomUUID().slice(0, 8),
      drawNum: overrides.drawNum ?? 1,
      sheet: overrides.sheet || 'A',
      team1Id: overrides.team1Id || '',
      team2Id: overrides.team2Id || '',
      event: overrides.event || 'A',
      winnerId: overrides.winnerId || '',
    };
  }

  // ── Bid schema ─────────────────────────────────────────
  /**
   * @typedef {Object} Bid
   * @property {string}  teamId
   * @property {string}  buyer
   * @property {number}  amount
   * @property {boolean} selfBuyBack
   */
  function createBid(overrides = {}) {
    return {
      teamId: overrides.teamId || '',
      buyer: overrides.buyer || '',
      amount: overrides.amount ?? 0,
      selfBuyBack: overrides.selfBuyBack ?? false,
    };
  }

  // ── Helpers ────────────────────────────────────────────
  function div() {
    return state[state.activeDivision];
  }

  function getTeams() { return div().teams; }
  function getDraw() { return div().draw; }
  function getBids() { return div().bids; }
  function getPriorPayouts() { return div().priorPayouts; }

  function getTeamById(id) { return div().teams.find(t => t.id === id); }
  function getTeamName(id) { return getTeamById(id)?.name || '—'; }

  function addTeam(team) {
    const t = createTeam(team);
    div().teams.push(t);
    return t;
  }

  function updateTeam(id, fields) {
    const t = getTeamById(id);
    if (t) Object.assign(t, fields);
    return t;
  }

  function removeTeam(id) {
    const d = div();
    d.teams = d.teams.filter(t => t.id !== id);
    d.bids = d.bids.filter(b => b.teamId !== id);
    d.draw = d.draw.filter(m => m.team1Id !== id && m.team2Id !== id);
  }

  function addMatch(match) {
    const m = createMatch(match);
    div().draw.push(m);
    return m;
  }

  function setBid(teamId, fields) {
    const d = div();
    let bid = d.bids.find(b => b.teamId === teamId);
    if (bid) {
      Object.assign(bid, fields);
    } else {
      bid = createBid({ teamId, ...fields });
      d.bids.push(bid);
    }
    return bid;
  }

  // ── Derived data ───────────────────────────────────────
  function winPct(team) {
    const total = team.wins + team.losses + team.ties;
    return total === 0 ? 0 : (team.wins + team.ties * 0.5) / total;
  }

  function totalPool() {
    return div().bids.reduce((sum, b) => sum + b.amount, 0);
  }

  function eventPayouts() {
    const pool = totalPool();
    const p = state.config.payoutPcts;
    return {
      A: pool * p.A,
      B: pool * p.B,
      C: pool * p.C,
      D: pool * p.D,
    };
  }

  // ── Persistence ────────────────────────────────────────
  const STORAGE_KEY = 'calcutta_auction_data';

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save to localStorage:', e);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Deep merge with defaults so new config keys are always present
        state = {
          ...state,
          ...parsed,
          config: { ...DEFAULT_CONFIG, ...parsed.config },
        };
      }
    } catch (e) {
      console.warn('Failed to load from localStorage:', e);
    }
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calcutta_data_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      if (parsed.mens || parsed.womens) {
        if (parsed.mens) state.mens = parsed.mens;
        if (parsed.womens) state.womens = parsed.womens;
        if (parsed.config) state.config = { ...DEFAULT_CONFIG, ...parsed.config };
      } else if (Array.isArray(parsed)) {
        // Assume it's an array of teams
        div().teams = parsed.map(t => createTeam(t));
      }
      save();
      return true;
    } catch (e) {
      console.error('Import failed:', e);
      return false;
    }
  }

  function clearAll() {
    state = {
      config: structuredClone(DEFAULT_CONFIG),
      activeDivision: 'mens',
      mens: { teams: [], draw: [], bids: [], priorPayouts: [] },
      womens: { teams: [], draw: [], bids: [], priorPayouts: [] },
    };
    localStorage.removeItem(STORAGE_KEY);
  }

  // ── Public API ─────────────────────────────────────────
  return {
    get state() { return state; },
    get config() { return state.config; },
    set activeDivision(d) { state.activeDivision = d; },
    get activeDivision() { return state.activeDivision; },

    createTeam, createMatch, createBid,
    getTeams, getDraw, getBids, getPriorPayouts,
    getTeamById, getTeamName,
    addTeam, updateTeam, removeTeam,
    addMatch,
    setBid,
    winPct, totalPool, eventPayouts,
    save, load, exportAll, importJSON, clearAll,
    DEFAULT_CONFIG,
  };
})();
