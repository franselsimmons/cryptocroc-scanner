# 🐊 CryptoCroc Scanner (Vercel + GitHub Actions)

## Wat dit is
- Vercel serverless scanner + UI
- Trechter: RADAR → BUILDUP → ALMOST → ENTRY
- Memory per coin in Redis (Upstash)
- Side via dynamische bands: 10e/90e percentiel van pool ch24
- PRO Orderbook (Bitget) vanaf ALMOST + ENTRY
- ENTRY split: ENTRY / HOLD / SELL (ob + spread)

## Vereist (Vercel env vars)
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- CRON_SECRET

Optioneel:
- COINGECKO_API_KEY
- CG_PAGES (1 of 2)
- OB_MAX_CALLS (10..60)

## GitHub Actions secrets
Zet in GitHub → Settings → Secrets → Actions:
- VERCEL_URL = jouw vercel domein zonder https:// (bv: cryptocroc.vercel.app)
- CRON_SECRET = exact dezelfde als in Vercel

## Handmatig scannen
- Open: /api/scan?secret=CRON_SECRET
