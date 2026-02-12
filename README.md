# 🐊 CryptoCroc Scanner (Vercel + Upstash)

Dit project is 100% Vercel serverless.

## Wat je krijgt
- **/api/scan** -> doet scan + schrijft output + memory naar Upstash
- **/api/bull** en **/api/bear** -> UI haalt hier data op
- Funnel met geheugen: RADAR -> BUILDUP -> ALMOST -> ENTRY
- Side (BULL/BEAR) op **bands** (niet op +/- teken)
- Stage minima: RADAR breed, ENTRY streng
- Orderbook (Bitget spot) **alleen** Almost/Entry
- ENTRY wordt ENTRY alleen als OB bevestigt

## Vereist
- Upstash Redis: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
- Secrets:
  - `CRON_SECRET` (voor cron scan endpoint)
  - `ACTION_SECRET` (later voor trade actions / admin)

## Handmatig scannen
Open:
`/api/scan?secret=<CRON_SECRET>`

## GitHub Actions cron
Zet in GitHub → Settings → Secrets and variables → Actions:
- `CRON_SECRET`
- `VERCEL_URL` (zonder https://, bv: `jouwproject.vercel.app`)

