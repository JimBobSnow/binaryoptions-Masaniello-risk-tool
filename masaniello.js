/*
 * Masaniello staking engine — pure functions, no DOM/storage dependencies.
 * See masaniello-risk-tool-prompt.md section 3.3 for the algorithm spec.
 */
(function (root) {
  'use strict';

  // t[n][k] = capital growth multiplier required so that reaching k wins
  // within the next n trades, in any order, lands on the same final capital.
  // qAvg is a decimal (0.80, not 80).
  function buildTable(N, qAvg) {
    if (!Number.isInteger(N) || N < 0) throw new Error('N must be a non-negative integer');
    const size = N + 1;
    const t = Array.from({ length: size }, () => new Array(size).fill(0));

    for (let n = 0; n <= N; n++) {
      t[n][0] = 1; // target already met — stop staking, session done
    }

    for (let m = 0; m <= N; m++) {
      t[m][m] = Math.pow(1 + qAvg, m); // must-win-every-remaining-trade case
    }

    for (let n = 1; n <= N; n++) {
      const kMax = Math.min(n - 1, N);
      for (let k = 1; k <= kMax; k++) {
        const A = t[n - 1][k - 1]; // multiplier if this trade wins
        const B = t[n - 1][k]; // multiplier if this trade loses
        t[n][k] = (A * B * (1 + qAvg)) / (A * qAvg + B);
      }
    }

    return t;
  }

  // Fraction of CURRENT capital to stake on the next trade.
  // n = trades remaining, k = wins still needed, qNext = actual payout
  // (decimal) offered on THIS trade. diagonalMode covers the n===k case
  // (section 3.4): 'pure' stakes it all, 'capped' caps at maxStakePercent
  // (0-100) of current capital.
  function stakeFraction(n, k, qNext, t, diagonalMode, maxStakePercent) {
    if (k <= 0) return 0; // already hit target win count — stop risking capital
    if (n <= k) {
      if (diagonalMode === 'capped') {
        const cap = typeof maxStakePercent === 'number' ? maxStakePercent : 100;
        return Math.min(1, Math.max(0, cap / 100));
      }
      return 1; // pure mode: must-win-all-remaining, stake it all
    }
    const A = t[n - 1][k - 1];
    const B = t[n - 1][k];
    const denom = A * qNext + B;
    if (denom <= 0) return 0;
    return (B - A) / denom;
  }

  function nextStake(currentCapital, tradesRemaining, winsStillNeeded, qNext, t, diagonalMode, maxStakePercent) {
    const frac = stakeFraction(tradesRemaining, winsStillNeeded, qNext, t, diagonalMode, maxStakePercent);
    return currentCapital * frac;
  }

  // Dollar-denominated take-profit/stop-loss is ambiguous: "$X" could mean
  // "X dollars of profit/loss from the starting bankroll" (amount mode, the
  // default) or "stop once the balance itself reaches $X" (ceiling for TP,
  // floor for SL). Percent doesn't have this ambiguity — X% lost is always
  // the same balance as (100-X)% remaining — so dollarMode only matters when
  // type === 'dollar'. tpSl = { type: 'percent'|'dollar', value, dollarMode }.
  function thresholdAmount(bankroll, tpSl) {
    if (tpSl.type === 'percent') return bankroll * (tpSl.value / 100);
    if (tpSl.dollarMode === 'floor') return Math.max(0, bankroll - tpSl.value);
    if (tpSl.dollarMode === 'ceiling') return Math.max(0, tpSl.value - bankroll);
    return tpSl.value; // default 'amount' mode
  }

  // Wins needed out of n trades to hit a target win rate, rounded to the
  // nearest whole win and clamped to the valid [1, n] range.
  function winsNeededForRate(n, winRatePct) {
    return Math.min(n, Math.max(1, Math.round((winRatePct / 100) * n)));
  }

  // How many trades can this bankroll actually fund at a given target win
  // rate, given a broker minimum stake (default $1)? The trade-1 stake is
  // the binding constraint: for a fixed win rate, spreading the same
  // proportional win target over more trades generally shrinks trade 1's
  // stake, so there's a largest N beyond which trade 1 would need to be
  // smaller than the minimum. Scans N upward (K = win rate * N, rounded,
  // clamped to [1,N]) and stops at the first N whose trade-1 stake would
  // fall below the minimum, reporting N-1. Deliberately does NOT keep
  // scanning past that point: because K jumps in discrete steps as N grows,
  // a later N can occasionally clear the minimum again even though smaller
  // N in between didn't — but "you can plan for 9 trades, just not 7 or 8"
  // is not a coherent answer to "how many trades can I take", so the first
  // shortfall is treated as the ceiling. Capped at maxSearchN — the caller
  // passes 20 to keep the resulting trade-count picker to a manageable size;
  // cappedAtSearchLimit tells the caller the true math-only ceiling might be
  // higher than what's offered.
  function computeMaxTrades(bankroll, winRatePct, avgPayoutPct, diagonalMode, maxStakePercent, minStake, maxSearchN) {
    minStake = typeof minStake === 'number' ? minStake : 1;
    maxSearchN = typeof maxSearchN === 'number' ? maxSearchN : 300;

    if (!(bankroll >= minStake) || !(winRatePct > 0) || !(avgPayoutPct > 0)) {
      return { n: 0, k: 0, achievedWinRatePct: 0, cappedAtSearchLimit: false };
    }

    const q = avgPayoutPct / 100;
    let bestN = 0;
    let bestK = 0;

    for (let n = 1; n <= maxSearchN; n++) {
      const k = winsNeededForRate(n, winRatePct);
      const table = buildTable(n, q);
      const stake1 = bankroll * stakeFraction(n, k, q, table, diagonalMode, maxStakePercent);
      if (stake1 >= minStake - 1e-9) {
        bestN = n;
        bestK = k;
      } else {
        break;
      }
    }

    return {
      n: bestN,
      k: bestK,
      achievedWinRatePct: bestN > 0 ? (bestK / bestN) * 100 : 0,
      cappedAtSearchLimit: bestN === maxSearchN,
    };
  }

  const Masaniello = { buildTable, stakeFraction, nextStake, thresholdAmount, computeMaxTrades, winsNeededForRate };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Masaniello;
  } else {
    root.Masaniello = Masaniello;
  }
})(typeof window !== 'undefined' ? window : globalThis);
