// Pump Momentum Guard — a pump.fun replay bot (agent-fun/replay/v2).
//
// Strategy (momentum with a risk brake), written from the competition prose spec
// and tuned on the kit dev window. The dev data shows two facts that shape it:
//
//  1. The big move happens in a coin's FIRST MINUTE (median time to a 3x peak is
//     56 s), and most early spikes are flash pumps that fade within minutes.
//     Chasing the first crossing of a multiple means buying the top, because
//     the pump usually completes inside a single slot before the bot can act.
//  2. What separates the coins that keep running from the flash pumps is
//     SUSTAINED elevation: a coin that is STILL >=3x its first price a full
//     minute after it appeared is the only place the big moves live. A third
//     of them turn out to be one-second whale bursts that freeze at ~14x and
//     never trade again (untradeable after the fact), so the runner tier is
//     kept small and exits tight: it is an option on the real runners, not a
//     bet that every 3x coin runs.
//
// So the bot runs two tiers, both one position per coin, never adding to a
// loser, purely a function of the events seen so far:
//
//  RUNNER — the profit tier. Buy when a coin aged 60-180 s is still >=3x and
//    <=5x its first-trade price. Size 0.10 SOL (90% of the harness per-mint
//    buy cap, capped). Exit: sell half at +30%, ride the rest with a 15%
//    trailing stop, hard stop -20%, max hold 30 min. A coin first bought small
//    as a filler may be scaled up to a runner when it proves itself (it is up
//    >=3x, so this is adding to a winner, never to a loser); the position
//    stays one position, its entry price re-blends on the add-on fill.
//  FILLER — the breadth tier. Flat young coins (60-120 s, still <1.5x) get a
//    minimum-size 0.011 SOL position, with fast exits (half at +30%, 10%
//    trail, -30% stop, flat after 2 min, max hold 4 min). They keep the bot
//    trading the required 20 distinct mints per window while the runners are
//    rare, and they never take the last slots: at most 2 positions may be
//    committed when a filler is bought, so a runner always finds a free slot.
//
// Fully deterministic: no clock, no randomness, no I/O, no network.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- parameters (tuned on the kit dev window; few, round numbers) ----
const PARAMS = {
  // Runner tier
  runnerMinAgeSec: 60,
  runnerMaxAgeSec: 180,
  runnerMultBps: 30000, // >=3x first price (bps of the multiple: 30000 = 3.00x)
  runnerMaxMultBps: 50000, // never chase past 5x: entries at 7-8x sit at the top
  runnerSizeLamports: 100_000_000n, // 0.10 SOL
  runnerTp1Bps: 3000, // +30%
  runnerTrailBps: 1500, // -15% from peak
  runnerHardSlBps: 2000, // -20%
  runnerMaxHoldSec: 1800,
  // Filler tier
  fillerMinAgeSec: 60,
  fillerMaxAgeSec: 120,
  fillerSizeLamports: 11_000_000n, // 0.011 SOL (minimum above the 0.01 SOL bar)
  fillerSkipMultBps: 15000, // only flat coins (<1.5x); runners-to-be stay free
  fillerTp1Bps: 3000, // +30%
  fillerTrailBps: 1000, // -10% from peak
  fillerHardSlBps: 3000, // -30%
  fillerTimeExitSec: 120,
  fillerFlatThrBps: 500, // +5%
  fillerMaxHoldSec: 240,
  // Shared
  /** Only buy when the size cap lets us spend at least this much (lamports). */
  minBuyLamports: 11_000_000n, // 0.011 SOL (above the 0.01 SOL round-trip bar)
  /** Use this share of the harness per-mint buy cap, leaving headroom. */
  capUseBps: 9000, // 90% of 1% of real reserves
  /** Fillers may only be bought while fewer than this many positions are committed. */
  fillerMaxCommitted: 2,
  /** Buy slippage allowance (bps vs decision-time reserves). */
  buySlippageBps: 1000,
  /** Sell slippage allowance: wide, so exits actually execute in a fast dump. */
  sellSlippageBps: 2000,
};

const BPS = 10_000n;

type Tier = 'runner' | 'filler';

interface Coin {
  firstTs: number;
  firstPrice: number; // SOL per token at the first trade
  fillerBought: boolean;
  runnerBought: boolean;
  tier: Tier; // tier of the last buy (for the add-on re-blend)
}

interface Held {
  tier: Tier;
  entryPrice: number; // effective SOL per token paid (cost / tokens)
  peakPrice: number;
  tp1Done: boolean;
  buyTs: number;
}

const coins = new Map<string, Coin>();
const watch = new Set<string>(); // young, not-yet-decided coins (entry candidates)
const held = new Map<string, Held>();
let nowSec = 0;

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function tierParams(tier: Tier) {
  return tier === 'runner'
    ? {
        tp1Bps: PARAMS.runnerTp1Bps,
        trailBps: PARAMS.runnerTrailBps,
        hardSlBps: PARAMS.runnerHardSlBps,
        maxHoldSec: PARAMS.runnerMaxHoldSec,
        timeExitSec: Number.POSITIVE_INFINITY,
        flatThrBps: 0,
      }
    : {
        tp1Bps: PARAMS.fillerTp1Bps,
        trailBps: PARAMS.fillerTrailBps,
        hardSlBps: PARAMS.fillerHardSlBps,
        maxHoldSec: PARAMS.fillerMaxHoldSec,
        timeExitSec: PARAMS.fillerTimeExitSec,
        flatThrBps: PARAMS.fillerFlatThrBps,
      };
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  // 1. Fold this batch's events into per-coin tracking, and learn entry
  //    prices from buy fills (position cost / tokens, fees included). A fill
  //    on an already-held coin is the runner add-on: re-blend the entry price
  //    and switch the position to the runner's exit rules.
  for (const e of batch.events) {
    const ts = Number(e.timestamp);
    if (ts > nowSec) nowSec = ts;
    if (e.event === 'TradeEvent') {
      const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      let c = coins.get(e.mint);
      if (!c) {
        c = { firstTs: ts, firstPrice: p, fillerBought: false, runnerBought: false, tier: 'filler' };
        coins.set(e.mint, c);
        watch.add(e.mint);
      }
    }
  }
  for (const f of batch.fills) {
    if (f.side === 'buy' && f.status === 'filled') {
      const pos = state.positions.get(f.mint);
      const c = coins.get(f.mint);
      if (!pos || pos.token_amount === 0n || !c) continue;
      const entry = Number(pos.cost_lamports) / Number(pos.token_amount);
      const h = held.get(f.mint);
      const curve = state.curves.get(f.mint);
      const px = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : entry;
      if (h) {
        // Add-on fill: re-blend, upgrade tier, restart the clock and the peak.
        h.entryPrice = entry;
        h.tier = c.tier;
        h.tp1Done = false;
        h.peakPrice = Math.max(h.peakPrice, px, entry);
        h.buyTs = nowSec;
      } else {
        held.set(f.mint, { tier: c.tier, entryPrice: entry, peakPrice: Math.max(px, entry), tp1Done: false, buyTs: nowSec });
      }
    }
  }

  const out: OrderInput[] = [];

  // Sells already in flight: never re-send while one is pending (a failed or
  // rejected sell must be retried, but only after its fill comes back).
  const pendingSells = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') pendingSells.add(p.order.mint);
  }

  // 2. Exits first: every held position gets its own tier's rules, every batch.
  for (const [mint, h] of held) {
    const pos = state.positions.get(mint);
    if (!pos || pos.token_amount === 0n) {
      held.delete(mint);
      continue;
    }
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) continue; // harness closes completed curves itself
    const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (px <= 0) continue;
    if (px > h.peakPrice) h.peakPrice = px;
    const tp = tierParams(h.tier);
    const gainBps = Math.floor(((px - h.entryPrice) / h.entryPrice) * 10000);
    let sellAll = false;
    let sellHalf = false;
    if (!h.tp1Done && gainBps >= tp.tp1Bps) {
      sellHalf = true;
      h.tp1Done = true;
    } else if (h.tp1Done) {
      const trailBps = Math.floor(((h.peakPrice - px) / h.peakPrice) * 10000);
      if (trailBps >= tp.trailBps) sellAll = true;
    }
    if (gainBps <= -tp.hardSlBps) sellAll = true;
    const ageSec = nowSec - h.buyTs;
    if (!sellAll && ageSec >= tp.timeExitSec && gainBps < tp.flatThrBps) sellAll = true;
    if (!sellAll && ageSec >= tp.maxHoldSec) sellAll = true;
    if (sellAll) {
      // The held record stays until the position is actually gone: a failed
      // or rejected sell is retried on the next batch, not forgotten.
      if (!pendingSells.has(mint)) {
        out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: PARAMS.sellSlippageBps });
      }
    } else if (sellHalf) {
      if (!pendingSells.has(mint)) {
        out.push({ side: 'sell', mint, token_amount: pos.token_amount / 2n, max_slippage_bps: PARAMS.sellSlippageBps });
      }
    }
  }

  // 3. Entries, in two passes: runners first (they are rare and the money),
  //    then fillers only while slots are plentiful.
  const pendingBuys = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
  }
  const sentThisBatch = new Set<string>();
  const committedNow = () => state.committedPositionCount() + sentThisBatch.size;

  // Pass 1 — runners (fresh buys and add-ons to filler-held coins).
  if (committedNow() < state.hello.caps.max_open_positions) {
    for (const mint of [...watch]) {
      if (committedNow() >= state.hello.caps.max_open_positions) break;
      if (out.length >= state.hello.caps.max_orders_per_batch) break;
      const c = coins.get(mint);
      if (!c) {
        watch.delete(mint);
        continue;
      }
      const age = nowSec - c.firstTs;
      if (age > PARAMS.runnerMaxAgeSec) {
        // Too old for a runner; a filler may still take it (pass 2 prunes).
        continue;
      }
      if (pendingBuys.has(mint) || sentThisBatch.has(mint) || c.runnerBought) continue;
      const h = held.get(mint);
      if (h && h.tier === 'runner') continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) {
        watch.delete(mint);
        continue;
      }
      const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (px <= 0 || c.firstPrice <= 0) continue;
      if (age < PARAMS.runnerMinAgeSec) continue;
      const multBps = Math.floor((px / c.firstPrice) * 10000);
      if (multBps < PARAMS.runnerMultBps || multBps > PARAMS.runnerMaxMultBps) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < PARAMS.minBuyLamports) {
        continue;
      }
      let size = (cap * BigInt(PARAMS.capUseBps)) / BPS;
      if (size > PARAMS.runnerSizeLamports) size = PARAMS.runnerSizeLamports;
      if (size < PARAMS.minBuyLamports) continue;
      const free = state.freeCashLamports();
      if (free < size + state.txFeeLamports() + LAMPORTS_PER_SOL) continue;
      out.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: PARAMS.buySlippageBps });
      sentThisBatch.add(mint);
      c.runnerBought = true;
      c.tier = 'runner';
      watch.delete(mint);
    }
  } else {
  }

  // Pass 2 — fillers (flat young coins, only while slots are plentiful).
  if (committedNow() < PARAMS.fillerMaxCommitted) {
    for (const mint of [...watch]) {
      if (committedNow() >= PARAMS.fillerMaxCommitted) break;
      if (out.length >= state.hello.caps.max_orders_per_batch) break;
      const c = coins.get(mint);
      if (!c) {
        watch.delete(mint);
        continue;
      }
      const age = nowSec - c.firstTs;
      if (age > Math.max(PARAMS.runnerMaxAgeSec, PARAMS.fillerMaxAgeSec)) {
        watch.delete(mint);
        continue;
      }
      if (pendingBuys.has(mint) || sentThisBatch.has(mint)) continue;
      if (c.fillerBought || held.has(mint) || c.runnerBought) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) {
        watch.delete(mint);
        continue;
      }
      const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (px <= 0 || c.firstPrice <= 0) continue;
      if (age < PARAMS.fillerMinAgeSec || age > PARAMS.fillerMaxAgeSec) continue;
      const multBps = Math.floor((px / c.firstPrice) * 10000);
      if (multBps >= PARAMS.fillerSkipMultBps) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < PARAMS.minBuyLamports) {
        continue;
      }
      let size = (cap * BigInt(PARAMS.capUseBps)) / BPS;
      if (size > PARAMS.fillerSizeLamports) size = PARAMS.fillerSizeLamports;
      if (size < PARAMS.minBuyLamports) continue;
      const free = state.freeCashLamports();
      if (free < size + state.txFeeLamports() + LAMPORTS_PER_SOL) continue;
      out.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: PARAMS.buySlippageBps });
      sentThisBatch.add(mint);
      c.fillerBought = true;
      c.tier = 'filler';
      // Stays in watch: it may still prove itself a runner before age 180 s.
    }
  }

  return out;
}

await runBot({
  onBatch,
  onDone() {},
});
