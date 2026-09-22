# XAU EDGE V2

A state-machine signal engine built around this flow:

`/SIGNAL` -> full market analysis -> setup/map -> WAITING_ZONE -> price touches zone -> re-analysis -> deterministic confirmation + OpenAI validator -> confirmed entry or invalidation.

## What is included

- Telegram command listener: `/signal`, `/status`, `/cancel`, `/help`
- MT5 Expert Advisor (`mt5/XAU_EDGE_V2.mq5`) that streams XAUUSD tick data and M5/M30 bars
- M30 bias engine
- M5 structure engine
- Supply / demand zones
- liquidity swing levels
- sweep detection
- BOS / CHoCH detection
- EMA trend alignment
- ATR volatility guard
- RSI momentum filter
- candle displacement / body strength
- risk guard with configurable max stop distance and RR
- persistent state in `/data`
- OpenAI confirmation validator with strict JSON output
- Telegram setup and confirmed-entry messages
- zone-break / invalidation notification
- HTTP health and ingestion endpoints
- Dockerfile for blitz.cloud

## Signal lifecycle

1. User sends `/SIGNAL` in Telegram.
2. Server uses the latest MT5 market snapshot.
3. Setup Engine calculates trend, structure, liquidity, zone, entry, SL, TP and score.
4. If no valid setup exists, Telegram receives a no-setup message.
5. If valid, Telegram receives the setup/map and the engine enters `WAITING_ZONE`.
6. When price enters the zone, the Confirmation Engine re-runs technical checks.
7. OpenAI is called only at this confirmation stage when enabled.
8. Hard technical invalidation cannot be overridden by AI.
9. When confirmed, Telegram receives the final entry message.
10. After confirmation or cancellation, the engine enters cooldown and waits for the next `/SIGNAL`.

## Important design rule

The bot does NOT buy/sell simply because price enters a zone. Zone touch is a trigger to re-analyse. The final signal requires confirmation.

## Local run

```bash
cp .env.example .env
# fill values
node src/server.js
```

The server listens on `PORT` (default 8080).

## Blitz deployment

1. Push the repo to a public GitHub repository.
2. Blitz: Host something new -> My own code -> paste the public repo URL.
3. Keep the Dockerfile at repository root.
4. After the first deploy, set environment variables in the Environment tab.
5. Configure a kept folder `/data` so persistent state survives restarts. Blitz environment variables are encrypted and applied after restart. See: https://blitz.cloud/docs/settings-and-files/
6. Open the app URL and test `/health`.

The current Blitz documentation says public GitHub projects can be built and run directly, and apps can use port 8080. See: https://blitz.cloud/docs/deploy-from-github/

## MT5 setup

1. Open `mt5/XAU_EDGE_V2.mq5` in MetaEditor.
2. Compile.
3. Attach it to XAUUSD.
4. In MT5: Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL.
5. Add the exact Blitz URL, for example:
   `https://YOUR-APP.YOUR-ACCOUNT.blitz.cloud`
6. In EA inputs set `ApiBaseUrl`, `IngestKey` and `SymbolName`.
7. Enable Algo Trading.

## Telegram

The server uses long polling, so it does not need a Telegram webhook. On startup it clears the bot webhook to avoid update conflicts. Use a dedicated bot for this project if the old bot was using a webhook.

Commands:

- `/signal` create a new setup from the latest market data
- `/status` show state and current setup
- `/cancel` cancel the active setup
- `/help` show commands

## Persistence

The starter uses an atomic JSON store. For production, move to Blitz managed PostgreSQL and keep the same state-machine layer. A JSON file is not a backup, and kept folders on Blitz are not backed up. See: https://blitz.cloud/docs/settings-and-files/

## Safety / trading scope

This project is a signal system, not an execution system. It does not place broker orders. Test on demo data before using any live account.
