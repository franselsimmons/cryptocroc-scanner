#!/usr/bin/env bash
set -e

echo "== Vercel FIX: static frontend + /api serverless =="

mkdir -p api

# 1) Kopieer public -> root zodat Vercel het meteen als static site serveert
if [ -f public/index.html ]; then cp public/index.html index.html; fi
if [ -f public/app.js ]; then cp public/app.js app.js; fi
if [ -f public/styles.css ]; then cp public/styles.css styles.css; fi

# 2) Vercel config (GEEN cron, want gratis = 1x per dag limit)
cat << 'VJSON' > vercel.json
{
  "version": 2,
  "builds": [
    { "src": "api/*.js", "use": "@vercel/node" },
    { "src": "index.html", "use": "@vercel/static" },
    { "src": "app.js", "use": "@vercel/static" },
    { "src": "styles.css", "use": "@vercel/static" }
  ]
}
VJSON

# 3) API endpoints lezen uit repo files (output wordt door GitHub Actions geüpdatet)
cat << 'BULL' > api/bull.js
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const file = path.join(process.cwd(), "cryptocroc-terminal", "output", "bull.json");
  try {
    const txt = fs.readFileSync(file, "utf8");
    res.setHeader("cache-control", "no-store");
    res.status(200).json(JSON.parse(txt));
  } catch (e) {
    res.status(404).json({ ok:false, error:"bull.json not found", hint:"Wacht tot GitHub Actions scan klaar is en gepusht heeft." });
  }
}
BULL

cat << 'BEAR' > api/bear.js
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const file = path.join(process.cwd(), "cryptocroc-terminal", "output", "bear.json");
  try {
    const txt = fs.readFileSync(file, "utf8");
    res.setHeader("cache-control", "no-store");
    res.status(200).json(JSON.parse(txt));
  } catch (e) {
    res.status(404).json({ ok:false, error:"bear.json not found", hint:"Wacht tot GitHub Actions scan klaar is en gepusht heeft." });
  }
}
BEAR

cat << 'PORT' > api/portfolio.js
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const file = path.join(process.cwd(), "cryptocroc-terminal", "output", "portfolio.json");
  try {
    const txt = fs.readFileSync(file, "utf8");
    res.setHeader("cache-control", "no-store");
    res.status(200).json(JSON.parse(txt));
  } catch (e) {
    res.status(404).json({ ok:false, error:"portfolio.json not found" });
  }
}
PORT

cat << 'TRADES' > api/trades.js
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const file = path.join(process.cwd(), "cryptocroc-terminal", "output", "trades.jsonl");
  try {
    const txt = fs.readFileSync(file, "utf8");
    res.setHeader("cache-control", "no-store");
    res.status(200).send(txt);
  } catch (e) {
    res.status(200).send("");
  }
}
TRADES

# LET OP: action (OPEN/CLOSE) kan niet veilig “naar file schrijven” op Vercel (niet persistent).
# Daarom maken we hem read-only, zodat deploy 100% werkt. Later koppelen we Upstash gratis voor persistence.
cat << 'ACT' > api/action.js
export default async function handler(req, res) {
  res.status(400).json({
    ok:false,
    error:"/api/action is disabled on Vercel Free without persistent storage.",
    fix:"Gebruik Upstash (gratis) of Vercel KV om OPEN/CLOSE persistent te maken."
  });
}
ACT

echo "✅ Klaar. Nu commit + push."
