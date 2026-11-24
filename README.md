# Pump.fun Paper-Trading Bot

[![Pump.fun Paper Sprint](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hinnyys/pump-fun-paper-bot-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hinnyys/pump-fun-paper-bot-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

[![Pump.fun Replay Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hinnyys/pump-fun-paper-bot-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hinnyys/pump-fun-paper-bot-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A momentum paper-trading bot for pump.fun bonding curves, built for the
[make.fun](https://make.fun) replay competitions. One program, `main.ts`
(Node 22), paper-trades 10 SOL on a replay of real pump.fun chain data. No
real money is ever touched.

## Strategy

- **Enter** 20 trades after a curve's real SOL reserves first reach 20 SOL:
  the crossing pump has settled and the survivors are still trading, with
  positive cumulative net inflow.
- **Stake** up to 0.2 SOL per position (the 1%-of-reserve cap usually binds),
  at most 5 positions at once.
- **Exit** the whole position on the first of: a −10% stop loss, a trailing
  stop once up 30% (sell if it gives back 10% from the peak), or a 3,000-slot
  time limit.
- **Probes**: tiny 0.02 SOL round trips keep the run above the 20-coin
  guardrail when momentum entries run dry.
- **Deterministic**: no clock, no environment, no randomness — every run
  replays identically.

## Files

- `main.ts` — entrypoint: hands the strategy to the harness shim.
- `strategy.ts` — the strategy (written from scratch for these bounties).
- `vendor/makefun-bot.ts` — the kit's harness shim, vendored as-is.
- `LICENSE` — MIT.

## Local backtest

With the bounty kit unpacked, grade the bot on the dev window with the
kit's own grader (process driver, no Docker needed):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```
