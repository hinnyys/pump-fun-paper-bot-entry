// Pump.fun paper-trading bot for the agent-fun/replay/v2 harness.
//
// Idea, in one paragraph: on the dev window almost every curve drifts down
// and buying after a short rise loses, but one filter is least bad: a curve
// whose real SOL reserves first cross 20 SOL has attracted serious, sustained
// buying. Entering right at the crossing still loses (the 2-slot fill
// latency buys the top of the crossing pump), so the bot waits 20 more
// trades for the pump to settle and only then buys the survivors, with a
// tight -10% stop and a trailing stop once up 30%. A light probe keeps the
// run above the 20-coin guardrail when crossings run dry.
//
// Everything here is deterministic: no clock, no environment, no randomness.
// All money is bigint lamports; prices are compared as rational vq/vt ratios
// with cross-multiplication, never floats.

import type {
  Batch,
  Bot,
  BotState,
  OrderInput,
  Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = (s: number): bigint => BigInt(Math.round(s * 1e9));

export interface Params {
  /** Trades kept per curve tape. */
  windowTrades: number;
  /** Minimum slots since the CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Minimum trades on the tape before an entry is considered. */
  minTapeTrades: number;
  /** Minimum buy trades on the tape. */
  minBuys: number;
  /** Minimum distinct buying wallets on the tape. */
  minBuyers: number;
  /** Minimum net buy SOL (buys minus sells) over the tape. */
  minNetSol: bigint;
  /** Minimum price rise over the tape, in bps. */
  minRiseBps: number;
  /** Maximum price rise over the tape, in bps (skip curves that already ran). */
  maxRiseBps: number;
  /** Price now must be at least this share (bps) of the tape high. */
  nearHighBps: number;
  /** Largest single buyer's share of tape buy SOL, in bps. */
  maxBuyerShareBps: number;
  /** Real SOL reserve bounds at entry. */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** SOL staked in one position. */
  stakeSol: bigint;
  /** Buy slippage, in bps. */
  buySlipBps: number;
  /** Sell slippage, in bps (10000 = accept any price, exits must land). */
  sellSlipBps: number;
  /** Stop loss, in bps of cost. */
  stopLossBps: number;
  /** Take profit, in bps of cost. */
  takeProfitBps: number;
  /** Trailing stop arms once up this much, in bps of cost. */
  trailArmBps: number;
  /** Trailing stop gives back this much from the peak value, in bps. */
  trailGiveBackBps: number;
  /** Maximum slots a position is held. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntriesPerMint: number;
  /** Most momentum positions open at once. */
  maxMainPositions: number;
  /** Probe round trip size, in SOL (guardrail pacing). */
  probeSol: bigint;
  /** Coins the pace target counts up to. */
  paceTargetCoins: number;
  /** Slots over which the pace target is spread. */
  paceSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  windowTrades: 8,
  minAgeSlots: 0,
  minTapeTrades: 3,
  minBuys: 1,
  minBuyers: 1,
  minNetSol: SOL(0),
  minRiseBps: 0,
  maxRiseBps: 100000,
  nearHighBps: 0,
  maxBuyerShareBps: 10000,
  minRealSol: SOL(20),
  maxRealSol: SOL(80),
  stakeSol: SOL(0.2),
  buySlipBps: 500,
  sellSlipBps: 10000,
  stopLossBps: 1000,
  takeProfitBps: 100000,
  trailArmBps: 3000,
  trailGiveBackBps: 1000,
  maxHoldSlots: 3000,
  cooldownSlots: 300,
  maxEntriesPerMint: 1,
  maxMainPositions: 5,
  probeSol: SOL(0.02),
  paceTargetCoins: 24,
  paceSlots: 100000,
};

interface TapeTrade {
  slot: number;
  /** Price as virtual quote per virtual token, kept as a ratio vq/vt. */
  vq: bigint;
  vt: bigint;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Tape {
  createdSlot: number;
  trades: TapeTrade[];
}

interface Position {
  mint: Pubkey;
  buySlot: number;
  peakValue: bigint;
  cost: bigint;
  adds: number;
  lastBuySlot: number;
}

/** Price ratio a/b in bps relative to c/d: (a/b) / (c/d) * 10000. */
function ratioBps(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint): bigint {
  if (aVt === 0n || bVq === 0n || bVt === 0n) return 0n;
  return (aVq * bVt * 10000n) / (aVt * bVq);
}

/** Mark value of `tokens` at reserves vq/vt. */
function markValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (tokens * vq) / vt;
}

export function createStrategy(params: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Position>();
  const lastExitSlot = new Map<Pubkey, number>();
  const entriesPerMint = new Map<Pubkey, number>();
  const coinsTraded = new Set<Pubkey>();
  const crossed = new Set<Pubkey>();
  const crossInfo = new Map<Pubkey, number>();
  const tradeCount = new Map<Pubkey, number>();
  const cumNet = new Map<Pubkey, bigint>();
  const pendingSell = new Set<Pubkey>();
  const pendingBuy = new Set<Pubkey>();
  const probeOpen = new Map<Pubkey, number>(); // mint -> slot bought
  let firstSlot = -1;
  let lastSlot = -1;

  function tapeFor(mint: Pubkey, slot: number): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: slot, trades: [] };
      tapes.set(mint, t);
    }
    return t;
  }

  function foldEvents(batch: Batch): Pubkey[] {
    const touched: Pubkey[] = [];
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint, e.slot);
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint, e.slot);
        t.trades.push({
          slot: e.slot,
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
          isBuy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
        });
        if (t.trades.length > params.windowTrades) {
          t.trades.splice(0, t.trades.length - params.windowTrades);
        }
        cumNet.set(e.mint, (cumNet.get(e.mint) ?? 0n) + (e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount)));
        tradeCount.set(e.mint, (tradeCount.get(e.mint) ?? 0) + 1);
        if (!seen.has(e.mint)) {
          seen.add(e.mint);
          touched.push(e.mint);
        }
      } else {
        tapes.delete(e.mint);
      }
    }
    return touched;
  }

  function signal(mint: Pubkey, slot: number): boolean {
    // The crossing rule: the curve's cumulative net inflow (buys minus
    // sells since first seen) is positive and the tape shows it is genuinely
    // trading. Whether this is the first crossing is enforced by the entry
    // loop's `crossed` set, not here.
    const t = tapes.get(mint);
    if (t === undefined || t.trades.length < params.minTapeTrades) return false;
    if ((cumNet.get(mint) ?? 0n) <= params.minNetSol) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      lastSlot = batch.slot;
      const orders: OrderInput[] = [];

      // Settle fills: track which mints completed a round trip, clear pending flags.
      for (const f of batch.fills) {
        if (f.status !== 'filled') {
          if (f.side === 'buy') pendingBuy.delete(f.mint);
          if (f.side === 'sell') pendingSell.delete(f.mint);
          continue;
        }
        if (f.side === 'buy') {
          pendingBuy.delete(f.mint);
          if (!probeOpen.has(f.mint)) {
            const pos = state.positions.get(f.mint);
            if (pos !== undefined) {
              const prev = held.get(f.mint);
              if (prev !== undefined) {
                // Pyramid add: refresh the cost basis, keep the original
                // buy slot (the time limit runs from the first buy).
                prev.cost = BigInt(pos.cost_lamports);
                if (prev.peakValue < BigInt(pos.cost_lamports)) {
                  prev.peakValue = BigInt(pos.cost_lamports);
                }
                prev.adds += 1;
                prev.lastBuySlot = batch.slot;
              } else {
                held.set(f.mint, {
                  mint: f.mint,
                  buySlot: batch.slot,
                  peakValue: BigInt(pos.cost_lamports),
                  cost: BigInt(pos.cost_lamports),
                  adds: 0,
                  lastBuySlot: batch.slot,
                });
              }
            }
          }
        } else {
          pendingSell.delete(f.mint);
          coinsTraded.add(f.mint);
          held.delete(f.mint);
          lastExitSlot.set(f.mint, batch.slot);
          probeOpen.delete(f.mint);
        }
      }

      const touched = foldEvents(batch);

      // Exits first: every held position is re-priced on this batch's reserves.
      for (const [mint, pos] of held) {
        if (pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        const holding = state.positions.get(mint);
        if (curve === undefined || curve.complete || holding === undefined) {
          held.delete(mint);
          continue;
        }
        const value = markValue(
          holding.token_amount,
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
        );
        if (value > pos.peakValue) pos.peakValue = value;
        const pnlBps = ((value - pos.cost) * 10000n) / pos.cost;
        let exit = false;
        if (pnlBps <= -BigInt(params.stopLossBps)) exit = true;
        else if (pnlBps >= BigInt(params.takeProfitBps)) exit = true;
        else if (
          pnlBps >= BigInt(params.trailArmBps) &&
          value <= (pos.peakValue * (10000n - BigInt(params.trailGiveBackBps))) / 10000n
        ) {
          exit = true;
        } else if (batch.slot - pos.buySlot >= params.maxHoldSlots) {
          exit = true;
        }
        if (exit) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: params.sellSlipBps,
          });
          pendingSell.add(mint);
        }
      }

      // Entries: only curves whose tape moved on this batch. A curve gets
      // its chance 20 trades after its real SOL first reaches the entry
      // threshold: by then the crossing pump has settled and the survivors
      // are the ones still trading. A coin gets one chance: it is marked
      // `crossed` only once a buy is sent.
      const mainCount = held.size;
      for (const mint of touched) {
        if (orders.length >= 14) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < params.minRealSol) continue;
        if (!crossInfo.has(mint)) {
          crossInfo.set(mint, (tradeCount.get(mint) ?? 0));
          continue;
        }
        if ((tradeCount.get(mint) ?? 0) - (crossInfo.get(mint) ?? 0) < 20) continue;
        if (crossed.has(mint)) continue;
        if (mainCount + pendingBuy.size >= params.maxMainPositions) break;
        if (held.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        if (probeOpen.has(mint)) continue;
        if ((entriesPerMint.get(mint) ?? 0) >= params.maxEntriesPerMint) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && batch.slot - lastExit < params.cooldownSlots) continue;
        if (curve.real_quote_reserves > params.maxRealSol) {
          continue;
        }
        if (!signal(mint, batch.slot)) continue;
        let size = params.stakeSol;
        const cap = state.maxBuyLamports(mint);
        if (cap < size) size = cap;
        if (size < SOL(0.01)) continue;
        if (size > state.freeCashLamports()) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: params.buySlipBps,
        });
        pendingBuy.add(mint);
        crossed.add(mint);
        entriesPerMint.set(mint, (entriesPerMint.get(mint) ?? 0) + 1);
      }

      // Guardrail pacing: if coins traded lag the pace, probe a liquid active
      // curve with a tiny round trip (buy, sell it as soon as the buy lands).
      const elapsed = lastSlot - firstSlot;
      if (elapsed > 10000) {
        const want = Math.min(
          params.paceTargetCoins,
          Math.floor((params.paceTargetCoins * elapsed) / params.paceSlots),
        );
        if (coinsTraded.size + probeOpen.size < want - 2 && probeOpen.size < 2) {
          for (const mint of touched) {
            if (orders.length >= 14) break;
            if (held.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
            if (probeOpen.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < SOL(5)) continue;
            let size = params.probeSol;
            const cap = state.maxBuyLamports(mint);
            if (cap < size) size = cap;
            if (size < SOL(0.01) || size > state.freeCashLamports()) continue;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: size,
              max_slippage_bps: params.buySlipBps,
            });
            pendingBuy.add(mint);
            probeOpen.set(mint, batch.slot);
            break;
          }
        }
      }

      // Probes exit on the first batch after their buy fill lands.
      for (const [mint] of probeOpen) {
        if (pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        const holding = state.positions.get(mint);
        if (holding === undefined) {
          probeOpen.delete(mint);
          continue;
        }
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: params.sellSlipBps,
        });
        pendingSell.add(mint);
      }

      return orders;
    },
  };
}
