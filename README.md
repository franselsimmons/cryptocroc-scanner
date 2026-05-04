# CryptoCroc Runner System

Telemetry-driven crypto runner voor scanner → trade-funnel → TradeSystem execution.

## Kern

Het systeem bestaat uit:

- Scanner funnel
  - Bull / Bear gescheiden stages
  - `radar`
  - `buildup`
  - `almost`
  - `entry`

- Runner / TradeSystem
  - ENTRY / HOLD / WAIT / EXIT
  - A / B / GOD setup classificatie
  - RR, confluence, RSI, orderbook, funding en BTC-gates
  - Durable position memory via KV / Upstash
  - Discord alerts

- Telemetry optimizer
  - Reject reason logging
  - Feature-store
  - Shadow outcomes
  - MFE / MAE tracking
  - Post-exit analysis
  - Final filter decision logging

Professionele naam:

```txt
Telemetry-driven Closed-Loop Optimization Engine