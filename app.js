(function () {
  'use strict';

  // ---------- Storage ----------
  const KEY_ACTIVE = 'masaniello_active_session_v1';
  const KEY_HISTORY = 'masaniello_history_v1';
  const KEY_COUNTER = 'masaniello_counter_v1';

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.error('Failed to read localStorage key', key, e);
      return fallback;
    }
  }
  function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  let state = {
    activeSession: loadJSON(KEY_ACTIVE, null),
    history: loadJSON(KEY_HISTORY, []),
    counter: loadJSON(KEY_COUNTER, { count: 0, autoCount: true }),
  };

  function persistActive() {
    if (state.activeSession) saveJSON(KEY_ACTIVE, state.activeSession);
    else localStorage.removeItem(KEY_ACTIVE);
  }
  function persistHistory() { saveJSON(KEY_HISTORY, state.history); }
  function persistCounter() { saveJSON(KEY_COUNTER, state.counter); }

  let stakeUsedDirty = false;
  let qNextDirty = false;
  let tpType = 'percent';
  let slType = 'percent';
  let tpDollarMode = 'amount'; // 'amount' | 'ceiling'
  let slDollarMode = 'amount'; // 'amount' | 'floor'
  let tpForceEnd = true;
  let slForceEnd = true;
  let computedPlan = { n: 0, k: 0 };

  // ---------- Utilities ----------
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function formatMoney(n) {
    if (!isFinite(n)) n = 0;
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatPercent(n) {
    if (!isFinite(n)) n = 0;
    const sign = n > 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }
  function formatDate(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  const END_REASON_LABELS = {
    take_profit: 'Take Profit Hit',
    stop_loss: 'Stop Loss Hit',
    target_hit: 'Target Hit',
    target_unreachable: 'Target Unreachable',
    trades_exhausted: 'Trades Exhausted',
    manual: 'Ended Manually',
  };
  const END_REASON_TONE = {
    take_profit: 'good',
    target_hit: 'good',
    stop_loss: 'bad',
    target_unreachable: 'bad',
    trades_exhausted: 'neutral',
    manual: 'neutral',
  };

  // ---------- Masaniello glue ----------
  const thresholdAmount = Masaniello.thresholdAmount;
  function buildSessionTable(session) {
    return Masaniello.buildTable(session.inputs.N, session.inputs.avgPayoutPct / 100);
  }
  function suggestedStakeFor(session, table, qNextPct) {
    const qNext = qNextPct / 100;
    return Masaniello.nextStake(
      session.currentCapital,
      session.tradesRemaining,
      session.winsNeeded,
      qNext,
      table,
      session.inputs.diagonalMode,
      session.inputs.maxStakePercent
    );
  }
  // Precedence: mathematical impossibility first, then the designed win
  // target, then the profit/loss dollar overlay, then simply running out
  // of trades. See build-prompt section 3.4 / 4 / 5.
  function checkEndConditions(session) {
    const inputs = session.inputs;
    const C0 = inputs.bankroll;
    const currentCapital = session.currentCapital;

    if (session.tradesRemaining < session.winsNeeded) return 'target_unreachable';
    if (session.winsNeeded === 0) return 'target_hit';

    const tpAmt = thresholdAmount(C0, inputs.takeProfit);
    if (inputs.takeProfit.forceEnd !== false && currentCapital - C0 >= tpAmt) return 'take_profit';

    const slAmt = thresholdAmount(C0, inputs.stopLoss);
    if (inputs.stopLoss.forceEnd !== false && C0 - currentCapital >= slAmt) return 'stop_loss';

    if (session.tradesRemaining === 0) return 'trades_exhausted';
    return null;
  }

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);

  const setupPanel = $('setupPanel');
  const dashboardPanel = $('dashboardPanel');
  const setupError = $('setupError');

  const bankrollInput = $('bankrollInput');
  const winRateInput = $('winRateInput');
  const avgPayoutInput = $('avgPayoutInput');
  const tradeCountSelect = $('tradeCountSelect');
  const computedWinsEl = $('computedWins');
  const computedWinRateEl = $('computedWinRate');
  const computedGrowthEl = $('computedGrowth');
  const computedPlanNoteEl = $('computedPlanNote');
  const tpTypePercentBtn = $('tpTypePercentBtn');
  const tpTypeDollarBtn = $('tpTypeDollarBtn');
  const tpValueInput = $('tpValueInput');
  const tpValueLabel = $('tpValueLabel');
  const tpDollarModeField = $('tpDollarModeField');
  const tpModeAmountBtn = $('tpModeAmountBtn');
  const tpModeCeilingBtn = $('tpModeCeilingBtn');
  const tpDollarModeHint = $('tpDollarModeHint');
  const tpForceEndYesBtn = $('tpForceEndYesBtn');
  const tpForceEndNoBtn = $('tpForceEndNoBtn');
  const slTypePercentBtn = $('slTypePercentBtn');
  const slTypeDollarBtn = $('slTypeDollarBtn');
  const slValueInput = $('slValueInput');
  const slValueLabel = $('slValueLabel');
  const slDollarModeField = $('slDollarModeField');
  const slModeAmountBtn = $('slModeAmountBtn');
  const slModeFloorBtn = $('slModeFloorBtn');
  const slDollarModeHint = $('slDollarModeHint');
  const slForceEndYesBtn = $('slForceEndYesBtn');
  const slForceEndNoBtn = $('slForceEndNoBtn');
  const diagonalModeSelect = $('diagonalModeSelect');
  const maxStakePercentField = $('maxStakePercentField');
  const maxStakePercentInput = $('maxStakePercentInput');
  const startSessionBtn = $('startSessionBtn');

  const endBanner = $('endBanner');
  const sessionStatus = $('sessionStatus');
  const statCurrentCapital = $('statCurrentCapital');
  const statStartingCapital = $('statStartingCapital');
  const statNetPL = $('statNetPL');
  const statTrades = $('statTrades');
  const statWins = $('statWins');
  const projFinalCapitalEl = $('projFinalCapital');
  const projProfitEl = $('projProfit');
  const projGainPercentEl = $('projGainPercent');
  const projNoteEl = $('projNote');
  const endgameWarning = $('endgameWarning');
  const qNextInput = $('qNextInput');
  const suggestedStakeValueEl = $('suggestedStakeValue');
  const tpProgressFill = $('tpProgressFill');
  const slProgressFill = $('slProgressFill');
  const tpRingFill = $('tpRingFill');
  const slRingFill = $('slRingFill');
  const tpProgressLabel = $('tpProgressLabel');
  const slProgressLabel = $('slProgressLabel');
  const tpHitNote = $('tpHitNote');
  const slHitNote = $('slHitNote');
  const stakeUsedInput = $('stakeUsedInput');
  const winBtn = $('winBtn');
  const lossBtn = $('lossBtn');
  const dashboardError = $('dashboardError');
  const tradeLogBody = $('tradeLogBody');
  const endSessionBtn = $('endSessionBtn');
  const startNewSessionBtn = $('startNewSessionBtn');

  const counterBigNumber = $('counterBigNumber');
  const counterPlusBtn = $('counterPlusBtn');
  const counterMinusBtn = $('counterMinusBtn');
  const counterResetBtn = $('counterResetBtn');
  const autoCountToggle = $('autoCountToggle');
  const totalSessionsEl = $('totalSessions');
  const totalWinSessionsEl = $('totalWinSessions');
  const totalLossSessionsEl = $('totalLossSessions');
  const totalCumulativePLEl = $('totalCumulativePL');
  const sessionHistoryList = $('sessionHistoryList');

  const clearAllDataBtn = $('clearAllDataBtn');
  const disclaimerLink = $('disclaimerLink');
  const disclaimerModal = $('disclaimerModal');
  const disclaimerCloseBtn = $('disclaimerCloseBtn');
  const toastEl = $('toast');
  const themeBtns = document.querySelectorAll('.theme-btn');

  // ---------- Theme switcher ----------
  const THEME_KEY = 'masaniello_theme_v1';
  const VALID_THEMES = { ledger: 1, terminal: 1, gauge: 1 };

  function applyTheme(theme) {
    if (!VALID_THEMES[theme]) theme = 'terminal';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    themeBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.themeChoice === theme); });
  }

  themeBtns.forEach(function (b) {
    b.addEventListener('click', function () { applyTheme(b.dataset.themeChoice); });
  });

  // ---------- Toast ----------
  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2500);
  }

  // ---------- Setup panel ----------
  function updateTpToggleUI() {
    tpTypePercentBtn.classList.toggle('active', tpType === 'percent');
    tpTypeDollarBtn.classList.toggle('active', tpType === 'dollar');
    tpDollarModeField.classList.toggle('hidden', tpType !== 'dollar');
    tpModeAmountBtn.classList.toggle('active', tpDollarMode === 'amount');
    tpModeCeilingBtn.classList.toggle('active', tpDollarMode === 'ceiling');
    if (tpType === 'percent') {
      tpValueLabel.textContent = 'Take-Profit (% of balance)';
    } else if (tpDollarMode === 'ceiling') {
      tpValueLabel.textContent = 'Take-Profit — target balance ($)';
      tpDollarModeHint.textContent = 'Balance ceiling: the session ends once your balance reaches this amount. E.g. with a $100 balance, entering $150 ends the session at $150 — a $50 profit — not when you’ve merely gained $150.';
    } else {
      tpValueLabel.textContent = 'Take-Profit — profit amount ($)';
      tpDollarModeHint.textContent = 'Amount to gain: the session ends once your cumulative profit from the starting balance reaches this many dollars.';
    }
    if (tpType !== 'dollar') tpDollarModeHint.textContent = '';
  }
  function updateSlToggleUI() {
    slTypePercentBtn.classList.toggle('active', slType === 'percent');
    slTypeDollarBtn.classList.toggle('active', slType === 'dollar');
    slDollarModeField.classList.toggle('hidden', slType !== 'dollar');
    slModeAmountBtn.classList.toggle('active', slDollarMode === 'amount');
    slModeFloorBtn.classList.toggle('active', slDollarMode === 'floor');
    if (slType === 'percent') {
      slValueLabel.textContent = 'Stop-Loss (% of balance)';
    } else if (slDollarMode === 'floor') {
      slValueLabel.textContent = 'Stop-Loss — balance floor ($)';
      slDollarModeHint.textContent = 'Balance floor: the session ends once your balance drops to this amount. E.g. with a $100 balance, entering $55 ends the session once your balance falls to $55 — you can lose up to $45 first — rather than ending as soon as you’ve lost $55 in total.';
    } else {
      slValueLabel.textContent = 'Stop-Loss — loss amount ($)';
      slDollarModeHint.textContent = 'Amount you can lose: the session ends once your cumulative loss from the starting balance reaches this many dollars. A small value here (e.g. $1) will end the session on almost any losing trade.';
    }
    if (slType !== 'dollar') slDollarModeHint.textContent = '';
  }

  function updateTpForceEndUI() {
    tpForceEndYesBtn.classList.toggle('active', tpForceEnd === true);
    tpForceEndNoBtn.classList.toggle('active', tpForceEnd === false);
  }
  function updateSlForceEndUI() {
    slForceEndYesBtn.classList.toggle('active', slForceEnd === true);
    slForceEndNoBtn.classList.toggle('active', slForceEnd === false);
  }

  tpTypePercentBtn.addEventListener('click', function () { tpType = 'percent'; updateTpToggleUI(); });
  tpTypeDollarBtn.addEventListener('click', function () { tpType = 'dollar'; updateTpToggleUI(); });
  tpModeAmountBtn.addEventListener('click', function () { tpDollarMode = 'amount'; updateTpToggleUI(); });
  tpModeCeilingBtn.addEventListener('click', function () { tpDollarMode = 'ceiling'; updateTpToggleUI(); });
  tpForceEndYesBtn.addEventListener('click', function () { tpForceEnd = true; updateTpForceEndUI(); });
  tpForceEndNoBtn.addEventListener('click', function () { tpForceEnd = false; updateTpForceEndUI(); });
  slTypePercentBtn.addEventListener('click', function () { slType = 'percent'; updateSlToggleUI(); });
  slTypeDollarBtn.addEventListener('click', function () { slType = 'dollar'; updateSlToggleUI(); });
  slModeAmountBtn.addEventListener('click', function () { slDollarMode = 'amount'; updateSlToggleUI(); });
  slModeFloorBtn.addEventListener('click', function () { slDollarMode = 'floor'; updateSlToggleUI(); });
  slForceEndYesBtn.addEventListener('click', function () { slForceEnd = true; updateSlForceEndUI(); });
  slForceEndNoBtn.addEventListener('click', function () { slForceEnd = false; updateSlForceEndUI(); });

  diagonalModeSelect.addEventListener('change', function () {
    maxStakePercentField.classList.toggle('hidden', diagonalModeSelect.value !== 'capped');
    updateComputedPlan();
  });

  // ---------- Computed plan: which trade counts can this balance fund? ----------
  const MAX_TRADE_COUNT_OPTIONS = 20;
  let computedOptions = []; // [{n, k, projectedFinal, profit, profitPct}, ...] — every n clears the $1 minimum on trade 1

  function applySelectedTradeCount() {
    const n = parseInt(tradeCountSelect.value, 10);
    const opt = computedOptions.filter(function (o) { return o.n === n; })[0];
    if (!opt) {
      computedPlan = { n: 0, k: 0 };
      computedWinsEl.textContent = '—';
      computedWinRateEl.textContent = '—';
      computedGrowthEl.textContent = '—';
      return;
    }
    computedPlan = { n: opt.n, k: opt.k };
    computedWinsEl.textContent = String(opt.k);
    computedWinRateEl.textContent = ((opt.k / opt.n) * 100).toFixed(1) + '%';
    computedGrowthEl.textContent = formatMoney(opt.profit) + ' (' + formatPercent(opt.profitPct) + ')';
  }

  function updateComputedPlan() {
    const bankroll = parseFloat(bankrollInput.value);
    const winRatePct = parseFloat(winRateInput.value);
    const avgPayoutPct = parseFloat(avgPayoutInput.value);
    const diagonalMode = diagonalModeSelect.value;
    const maxStakePercent = diagonalMode === 'capped' ? parseFloat(maxStakePercentInput.value) : null;

    if (!(bankroll > 0) || !(winRatePct > 0) || !(avgPayoutPct > 0)) {
      computedOptions = [];
      computedPlan = { n: 0, k: 0 };
      tradeCountSelect.innerHTML = '';
      computedWinsEl.textContent = '—';
      computedWinRateEl.textContent = '—';
      computedGrowthEl.textContent = '—';
      computedPlanNoteEl.textContent = 'Set your balance, target win rate, and payout above to see how many trades you can choose from.';
      return;
    }

    const result = Masaniello.computeMaxTrades(bankroll, winRatePct, avgPayoutPct, diagonalMode, maxStakePercent, 1, MAX_TRADE_COUNT_OPTIONS);

    if (result.n < 1) {
      computedOptions = [];
      computedPlan = { n: 0, k: 0 };
      tradeCountSelect.innerHTML = '';
      computedWinsEl.textContent = '—';
      computedWinRateEl.textContent = '—';
      computedGrowthEl.textContent = '—';
      computedPlanNoteEl.textContent = 'Your starting balance is below the $1 minimum trade size — increase it to plan a session.';
      return;
    }

    // Projected growth per option reuses the same table[n][k] multiplier the
    // active-session projection box uses — how much the balance grows if
    // this plan lands on exactly k wins in n trades, assuming the average
    // payout above holds for every remaining trade.
    computedOptions = [];
    for (let n = 1; n <= result.n; n++) {
      const k = Masaniello.winsNeededForRate(n, winRatePct);
      const table = Masaniello.buildTable(n, avgPayoutPct / 100);
      const projectedFinal = bankroll * table[n][k];
      const profit = projectedFinal - bankroll;
      computedOptions.push({ n: n, k: k, projectedFinal: projectedFinal, profit: profit, profitPct: (profit / bankroll) * 100 });
    }

    const prevSelected = parseInt(tradeCountSelect.value, 10);
    const stillValid = computedOptions.some(function (o) { return o.n === prevSelected; });
    const selectN = stillValid ? prevSelected : result.n;

    tradeCountSelect.innerHTML = computedOptions.map(function (o) {
      return '<option value="' + o.n + '">' + o.n + ' trade' + (o.n === 1 ? '' : 's') +
        ' (' + o.k + ' win' + (o.k === 1 ? '' : 's') + ' needed) — ' +
        formatMoney(o.profit) + ' (' + formatPercent(o.profitPct) + ')</option>';
    }).join('');
    tradeCountSelect.value = String(selectN);
    applySelectedTradeCount();

    computedPlanNoteEl.textContent = (result.cappedAtSearchLimit
      ? 'Your balance and win rate could fund even more, but sessions are capped at ' + MAX_TRADE_COUNT_OPTIONS + ' trades.'
      : 'Every option above keeps trade 1’s stake at or above the $1 minimum.') +
      ' Growth figures assume your average payout % holds for every trade.';
  }

  bankrollInput.addEventListener('input', updateComputedPlan);
  winRateInput.addEventListener('input', updateComputedPlan);
  avgPayoutInput.addEventListener('input', updateComputedPlan);
  maxStakePercentInput.addEventListener('input', updateComputedPlan);
  tradeCountSelect.addEventListener('change', applySelectedTradeCount);

  function renderSetupErrors(errors) {
    if (!errors.length) {
      setupError.classList.add('hidden');
      setupError.innerHTML = '';
      return;
    }
    setupError.classList.remove('hidden');
    setupError.innerHTML = errors.map(function (e) { return '&bull; ' + e; }).join('<br>');
  }

  startSessionBtn.addEventListener('click', function () {
    const bankroll = parseFloat(bankrollInput.value);
    const winRatePct = parseFloat(winRateInput.value);
    const avgPayoutPct = parseFloat(avgPayoutInput.value);
    const tpValue = parseFloat(tpValueInput.value);
    const slValue = parseFloat(slValueInput.value);
    const diagonalMode = diagonalModeSelect.value;
    const maxStakePercent = diagonalMode === 'capped' ? parseFloat(maxStakePercentInput.value) : null;

    updateComputedPlan();
    const N = computedPlan.n;
    const K = computedPlan.k;

    const errors = [];
    if (!(bankroll > 0)) errors.push('Starting balance must be greater than 0.');
    if (!(winRatePct > 0 && winRatePct <= 100)) errors.push('Target win rate must be greater than 0 and no more than 100%.');
    if (!(avgPayoutPct > 0)) errors.push('Default/average payout % must be greater than 0.');
    if (bankroll > 0 && winRatePct > 0 && avgPayoutPct > 0 && N < 1) {
      errors.push('Your starting balance is below the $1 minimum trade size — increase it to plan a session.');
    }
    if (!(tpValue > 0)) errors.push('Take-profit value must be greater than 0.');
    if (!(slValue > 0)) errors.push('Stop-loss value must be greater than 0.');
    if (slType === 'percent' && slValue > 100) errors.push('Stop-loss % cannot exceed 100% of balance.');
    if (tpType === 'dollar' && tpDollarMode === 'ceiling' && bankroll > 0 && !(tpValue > bankroll)) {
      errors.push('Take-profit balance ceiling must be greater than your starting balance.');
    }
    if (slType === 'dollar' && slDollarMode === 'floor' && bankroll > 0 && !(slValue >= 0 && slValue < bankroll)) {
      errors.push('Stop-loss balance floor must be between $0 and less than your starting balance.');
    }
    if (diagonalMode === 'capped' && !(maxStakePercent > 0 && maxStakePercent <= 100)) {
      errors.push('Max stake % (capped mode) must be between 0 and 100.');
    }

    if (errors.length) { renderSetupErrors(errors); return; }
    renderSetupErrors([]);

    const session = {
      id: uuid(),
      startedAt: new Date().toISOString(),
      status: 'active',
      inputs: {
        bankroll: bankroll,
        N: N,
        K: K,
        avgPayoutPct: avgPayoutPct,
        takeProfit: { type: tpType, value: tpValue, dollarMode: tpDollarMode, forceEnd: tpForceEnd },
        stopLoss: { type: slType, value: slValue, dollarMode: slDollarMode, forceEnd: slForceEnd },
        diagonalMode: diagonalMode,
        maxStakePercent: maxStakePercent,
      },
      currentCapital: bankroll,
      tradesRemaining: N,
      winsNeeded: K,
      trades: [],
      endReason: null,
      endedAt: null,
    };

    state.activeSession = session;
    stakeUsedDirty = false;
    qNextDirty = false;
    persistActive();
    renderAll();
  });

  // ---------- Dashboard: end session / new session ----------
  function endSession(session, reason) {
    session.status = 'ended';
    session.endReason = reason;
    session.endedAt = new Date().toISOString();

    const netPL = round2(session.currentCapital - session.inputs.bankroll);
    const record = {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      inputs: JSON.parse(JSON.stringify(session.inputs)),
      trades: JSON.parse(JSON.stringify(session.trades)),
      endReason: reason,
      finalCapital: round2(session.currentCapital),
      netPL: netPL,
      netPLPercent: round2((netPL / session.inputs.bankroll) * 100),
    };

    state.history.unshift(record);
    persistHistory();

    if (state.counter.autoCount) {
      state.counter.count += 1;
      persistCounter();
    }
    persistActive();
  }

  endSessionBtn.addEventListener('click', function () {
    const s = state.activeSession;
    if (!s || s.status !== 'active') return;
    const ok = confirm('End this session now? It will be archived to history immediately with end reason "Ended Manually". This cannot be undone.');
    if (!ok) return;
    endSession(s, 'manual');
    renderAll();
  });

  startNewSessionBtn.addEventListener('click', function () {
    state.activeSession = null;
    stakeUsedDirty = false;
    persistActive();
    renderAll();
  });

  // ---------- Recording trades ----------
  function showDashboardError(msg) {
    dashboardError.textContent = msg;
    dashboardError.classList.remove('hidden');
  }
  function clearDashboardError() {
    dashboardError.classList.add('hidden');
    dashboardError.textContent = '';
  }

  qNextInput.addEventListener('input', function () {
    qNextDirty = true;
    renderDashboard();
  });
  stakeUsedInput.addEventListener('input', function () { stakeUsedDirty = true; });

  function recordTrade(result) {
    const s = state.activeSession;
    if (!s || s.status !== 'active') return;

    const qNextPct = parseFloat(qNextInput.value);
    if (!(qNextPct > 0)) {
      showDashboardError('Enter a valid payout % (greater than 0) for this trade before recording a result.');
      return;
    }

    const table = buildSessionTable(s);
    const suggested = round2(clamp(suggestedStakeFor(s, table, qNextPct), 0, s.currentCapital));
    let stakeUsed = parseFloat(stakeUsedInput.value);
    if (!(stakeUsed >= 0)) stakeUsed = suggested;
    if (stakeUsed > s.currentCapital + 0.001) {
      showDashboardError('Stake used cannot exceed current capital (' + formatMoney(s.currentCapital) + ').');
      return;
    }
    stakeUsed = round2(stakeUsed);

    const capitalAfter = result === 'win'
      ? round2(s.currentCapital + stakeUsed * (qNextPct / 100))
      : round2(s.currentCapital - stakeUsed);

    s.trades.push({
      index: s.trades.length + 1,
      payoutPctUsed: qNextPct,
      stakeSuggested: suggested,
      stakeUsed: stakeUsed,
      result: result,
      capitalAfter: capitalAfter,
    });

    s.currentCapital = capitalAfter;
    s.tradesRemaining -= 1;
    if (result === 'win') s.winsNeeded -= 1;

    clearDashboardError();
    stakeUsedDirty = false;
    qNextDirty = false;

    const endReason = checkEndConditions(s);
    if (endReason) endSession(s, endReason);
    else persistActive();

    renderAll();
  }

  winBtn.addEventListener('click', function () { recordTrade('win'); });
  lossBtn.addEventListener('click', function () { recordTrade('loss'); });

  // Inline W/L correction — only while the session is still active (not yet
  // archived), so we never have to retroactively un-archive a history record.
  function editTradeResult(idx, newResult) {
    const s = state.activeSession;
    if (!s || s.status !== 'active') return;
    const trade = s.trades[idx - 1];
    if (!trade || trade.result === newResult) return;
    trade.result = newResult;

    for (let i = idx - 1; i < s.trades.length; i++) {
      const t = s.trades[i];
      const before = i === 0 ? s.inputs.bankroll : s.trades[i - 1].capitalAfter;
      t.capitalAfter = t.result === 'win'
        ? round2(before + t.stakeUsed * (t.payoutPctUsed / 100))
        : round2(before - t.stakeUsed);
    }

    const wins = s.trades.filter(function (t) { return t.result === 'win'; }).length;
    s.currentCapital = s.trades.length ? s.trades[s.trades.length - 1].capitalAfter : s.inputs.bankroll;
    s.tradesRemaining = s.inputs.N - s.trades.length;
    s.winsNeeded = s.inputs.K - wins;

    const endReason = checkEndConditions(s);
    if (endReason) endSession(s, endReason);
    else persistActive();

    renderAll();
  }

  // ---------- Rendering ----------
  function renderTradeLog(s) {
    tradeLogBody.innerHTML = '';
    if (!s.trades.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="empty-state">No trades recorded yet.</td>';
      tradeLogBody.appendChild(tr);
      return;
    }
    const canEdit = s.status === 'active';
    s.trades.forEach(function (t, i) {
      const idx = i + 1;
      const ret = t.result === 'win' ? t.stakeUsed * (t.payoutPctUsed / 100) : -t.stakeUsed;
      const tr = document.createElement('tr');
      const resultCell = canEdit
        ? '<div class="result-toggle" data-idx="' + idx + '">' +
          '<button class="win ' + (t.result === 'win' ? 'active' : '') + '" data-result="win">W</button>' +
          '<button class="loss ' + (t.result === 'loss' ? 'active' : '') + '" data-result="loss">L</button>' +
          '</div>'
        : '<span class="' + (t.result === 'win' ? 'return-positive' : 'return-negative') + '">' + (t.result === 'win' ? 'Win' : 'Loss') + '</span>';

      tr.innerHTML =
        '<td>' + idx + '</td>' +
        '<td>' + t.payoutPctUsed.toFixed(2) + '%</td>' +
        '<td>' + resultCell + '</td>' +
        '<td>' + formatMoney(t.stakeUsed) + '</td>' +
        '<td class="' + (ret >= 0 ? 'return-positive' : 'return-negative') + '">' + formatMoney(ret) + '</td>' +
        '<td>' + formatMoney(t.capitalAfter) + '</td>';
      tradeLogBody.appendChild(tr);
    });

    if (canEdit) {
      tradeLogBody.querySelectorAll('.result-toggle button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const idx = parseInt(btn.parentElement.getAttribute('data-idx'), 10);
          editTradeResult(idx, btn.getAttribute('data-result'));
        });
      });
    }
  }

  function renderDashboard() {
    const s = state.activeSession;
    if (!s) return;
    const table = buildSessionTable(s);
    const ended = s.status === 'ended';
    const netPL = s.currentCapital - s.inputs.bankroll;

    if (ended) {
      const tone = END_REASON_TONE[s.endReason] || 'neutral';
      endBanner.classList.remove('hidden');
      endBanner.className = 'end-banner ' + tone;
      endBanner.innerHTML = (END_REASON_LABELS[s.endReason] || s.endReason) +
        '<div class="sub">Final capital ' + formatMoney(s.currentCapital) + ' &middot; Net P/L ' +
        formatMoney(netPL) + ' (' + formatPercent((netPL / s.inputs.bankroll) * 100) + ')</div>';
      sessionStatus.classList.add('hidden');
    } else {
      endBanner.classList.add('hidden');
      sessionStatus.classList.remove('hidden');
    }

    statCurrentCapital.textContent = formatMoney(s.currentCapital);
    statStartingCapital.textContent = formatMoney(s.inputs.bankroll);
    statNetPL.textContent = formatMoney(netPL) + ' (' + formatPercent((netPL / s.inputs.bankroll) * 100) + ')';
    statNetPL.className = 'value ' + (netPL > 0 ? 'positive' : netPL < 0 ? 'negative' : '');
    statTrades.textContent = s.trades.length + ' / ' + s.inputs.N + ' taken · ' + s.tradesRemaining + ' remaining';
    statWins.textContent = (s.inputs.K - s.winsNeeded) + ' / ' + s.inputs.K + ' · ' + s.winsNeeded + ' needed';

    const projFinal = s.inputs.bankroll * table[s.inputs.N][s.inputs.K];
    const projProfit = projFinal - s.inputs.bankroll;
    projFinalCapitalEl.textContent = formatMoney(projFinal);
    projProfitEl.textContent = formatMoney(projProfit);
    projGainPercentEl.textContent = formatPercent((projProfit / s.inputs.bankroll) * 100);
    projNoteEl.textContent = 'Estimate only — assumes ' + s.inputs.avgPayoutPct.toFixed(2) +
      '% payout continues on every remaining trade at exactly the suggested stake. Actual results ' +
      'will differ once a trade’s real payout or stake used differs from that.';

    const mustWinEndgame = !ended && s.winsNeeded > 0 && s.tradesRemaining === s.winsNeeded;
    endgameWarning.classList.toggle('hidden', !mustWinEndgame);
    if (mustWinEndgame) {
      endgameWarning.textContent = 'Must-win endgame: every one of the ' + s.tradesRemaining +
        ' remaining trade(s) must win to reach the target — this is why take-profit and stop-loss matter as a safety overlay.';
    }

    if (!ended && !qNextDirty) {
      const lastPayout = s.trades.length ? s.trades[s.trades.length - 1].payoutPctUsed : s.inputs.avgPayoutPct;
      qNextInput.value = lastPayout;
    }

    const qNextPct = parseFloat(qNextInput.value) || 0;
    let suggested = 0;
    if (!ended) suggested = clamp(suggestedStakeFor(s, table, qNextPct), 0, s.currentCapital);
    suggestedStakeValueEl.textContent = formatMoney(suggested);
    if (!ended && !stakeUsedDirty) stakeUsedInput.value = round2(suggested);

    const tpAmt = thresholdAmount(s.inputs.bankroll, s.inputs.takeProfit);
    const slAmt = thresholdAmount(s.inputs.bankroll, s.inputs.stopLoss);
    const tpProgress = clamp(((s.currentCapital - s.inputs.bankroll) / tpAmt) * 100, 0, 100);
    const slProgress = clamp(((s.inputs.bankroll - s.currentCapital) / slAmt) * 100, 0, 100);
    tpProgressFill.style.width = tpProgress + '%';
    slProgressFill.style.width = slProgress + '%';
    const RING_CIRCUMFERENCE = 213.63;
    tpRingFill.setAttribute('stroke-dasharray', (tpProgress / 100 * RING_CIRCUMFERENCE).toFixed(2) + ' ' + RING_CIRCUMFERENCE);
    slRingFill.setAttribute('stroke-dasharray', (slProgress / 100 * RING_CIRCUMFERENCE).toFixed(2) + ' ' + RING_CIRCUMFERENCE);
    tpProgressLabel.innerHTML = '<span>Take-Profit</span><span>' + formatMoney(Math.max(0, netPL)) + ' / ' + formatMoney(tpAmt) + '</span>';
    slProgressLabel.innerHTML = '<span>Stop-Loss</span><span>' + formatMoney(Math.max(0, -netPL)) + ' / ' + formatMoney(slAmt) + '</span>';

    const tpHitNotForced = !ended && s.inputs.takeProfit.forceEnd === false && (netPL >= tpAmt);
    const slHitNotForced = !ended && s.inputs.stopLoss.forceEnd === false && (-netPL >= slAmt);
    tpHitNote.classList.toggle('hidden', !tpHitNotForced);
    slHitNote.classList.toggle('hidden', !slHitNotForced);

    winBtn.disabled = ended;
    lossBtn.disabled = ended;
    endSessionBtn.classList.toggle('hidden', ended);
    startNewSessionBtn.classList.toggle('hidden', !ended);
    qNextInput.disabled = ended;
    stakeUsedInput.disabled = ended;
    if (ended) clearDashboardError();

    renderTradeLog(s);
  }

  function renderHistoryPanel() {
    counterBigNumber.textContent = String(state.counter.count);
    autoCountToggle.checked = !!state.counter.autoCount;

    const sessionsCompleted = state.history.length;
    const winSessions = state.history.filter(function (h) { return h.netPL > 0; }).length;
    const lossSessions = state.history.filter(function (h) { return h.netPL <= 0; }).length;
    const cumulativePL = state.history.reduce(function (sum, h) { return sum + h.netPL; }, 0);

    totalSessionsEl.textContent = String(sessionsCompleted);
    totalWinSessionsEl.textContent = String(winSessions);
    totalLossSessionsEl.textContent = String(lossSessions);
    totalCumulativePLEl.textContent = formatMoney(cumulativePL);
    totalCumulativePLEl.className = 'value ' + (cumulativePL > 0 ? 'positive' : cumulativePL < 0 ? 'negative' : '');

    sessionHistoryList.innerHTML = '';
    if (!state.history.length) {
      sessionHistoryList.innerHTML = '<div class="empty-state">No sessions archived yet. Completed sessions will appear here.</div>';
      return;
    }

    state.history.forEach(function (h) {
      const details = document.createElement('details');
      details.className = 'session-row';
      const netPLClass = h.netPL > 0 ? 'return-positive' : h.netPL < 0 ? 'return-negative' : '';

      const summary = document.createElement('summary');
      summary.innerHTML =
        '<span>' + formatDate(h.startedAt) + '</span>' +
        '<span class="tag">' + h.inputs.N + ' trades planned</span>' +
        '<span class="tag">' + h.inputs.K + ' win' + (h.inputs.K === 1 ? '' : 's') + ' targeted</span>' +
        '<span class="tag">' + (END_REASON_LABELS[h.endReason] || h.endReason) + '</span>' +
        '<span class="' + netPLClass + '" style="margin-left:auto;font-weight:700;">' +
        formatMoney(h.netPL) + ' (' + formatPercent(h.netPLPercent) + ')</span>';
      details.appendChild(summary);

      const detail = document.createElement('div');
      detail.className = 'session-detail';
      let rows = '<div style="overflow-x:auto;"><table class="log-table"><thead><tr>' +
        '<th>No.</th><th>Payout %</th><th>Result</th><th>Trade Amount</th><th>Return</th><th>Running Balance</th>' +
        '</tr></thead><tbody>';
      h.trades.forEach(function (t, i) {
        const ret = t.result === 'win' ? t.stakeUsed * (t.payoutPctUsed / 100) : -t.stakeUsed;
        rows += '<tr><td>' + (i + 1) + '</td><td>' + t.payoutPctUsed.toFixed(2) + '%</td><td>' +
          (t.result === 'win' ? 'Win' : 'Loss') + '</td><td>' + formatMoney(t.stakeUsed) + '</td>' +
          '<td class="' + (ret >= 0 ? 'return-positive' : 'return-negative') + '">' + formatMoney(ret) + '</td>' +
          '<td>' + formatMoney(t.capitalAfter) + '</td></tr>';
      });
      rows += '</tbody></table></div>';
      detail.innerHTML = rows;
      details.appendChild(detail);
      sessionHistoryList.appendChild(details);
    });
  }

  function renderAll() {
    const hasActive = !!state.activeSession;
    setupPanel.classList.toggle('hidden', hasActive);
    dashboardPanel.classList.toggle('hidden', !hasActive);
    if (hasActive) renderDashboard();
    renderHistoryPanel();
  }

  // ---------- Counter controls ----------
  counterPlusBtn.addEventListener('click', function () {
    state.counter.count += 1;
    persistCounter();
    renderHistoryPanel();
  });
  counterMinusBtn.addEventListener('click', function () {
    state.counter.count = Math.max(0, state.counter.count - 1);
    persistCounter();
    renderHistoryPanel();
  });
  counterResetBtn.addEventListener('click', function () {
    const ok = confirm('Reset the session counter to 0?\n\nThis only resets the counter NUMBER. Your archived session history below is a separate record and will NOT be deleted.');
    if (!ok) return;
    state.counter.count = 0;
    persistCounter();
    renderHistoryPanel();
  });
  autoCountToggle.addEventListener('change', function () {
    state.counter.autoCount = autoCountToggle.checked;
    persistCounter();
  });

  // ---------- Clear all data ----------
  clearAllDataBtn.addEventListener('click', function () {
    const ok = confirm('Clear ALL data stored by this tool in this browser?\n\nThis permanently deletes your active session, your full session history, and the session counter. This cannot be undone.');
    if (!ok) return;
    localStorage.removeItem(KEY_ACTIVE);
    localStorage.removeItem(KEY_HISTORY);
    localStorage.removeItem(KEY_COUNTER);
    state = { activeSession: null, history: [], counter: { count: 0, autoCount: true } };
    stakeUsedDirty = false;
    renderAll();
    showToast('All local data cleared.');
  });

  // ---------- Disclaimer modal ----------
  disclaimerLink.addEventListener('click', function () { disclaimerModal.classList.remove('hidden'); });
  disclaimerCloseBtn.addEventListener('click', function () { disclaimerModal.classList.add('hidden'); });
  disclaimerModal.addEventListener('click', function (e) {
    if (e.target === disclaimerModal) disclaimerModal.classList.add('hidden');
  });

  // ---------- Init ----------
  applyTheme(document.documentElement.getAttribute('data-theme') || 'terminal');
  updateTpToggleUI();
  updateSlToggleUI();
  updateTpForceEndUI();
  updateSlForceEndUI();
  maxStakePercentField.classList.toggle('hidden', diagonalModeSelect.value !== 'capped');
  updateComputedPlan();
  renderAll();
})();
