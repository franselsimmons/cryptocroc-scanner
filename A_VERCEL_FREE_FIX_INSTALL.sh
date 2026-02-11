#!/usr/bin/env bash
set -e

echo "== A) Vercel Free Fix (routes + github actions ping) =="

# 1) Vercel routes: /, /bull, /bear moeten allemaal index.html renderen
cat > vercel.json << 'EOV'
{
  "version": 2,
  "builds": [
    { "src": "api/**/*.js", "use": "@vercel/node" },
    { "src": "index.html", "use": "@vercel/static" },
    { "src": "app.js", "use": "@vercel/static" },
    { "src": "styles.css", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1" },

    { "src": "/bull", "dest": "/index.html" },
    { "src": "/bear", "dest": "/index.html" },
    { "src": "/", "dest": "/index.html" }
  ]
}
EOV

echo "✅ vercel.json routes fixed (/ /bull /bear -> index.html)"

# 2) app.js: als je op /bull of /bear binnenkomt, zet hij automatisch de juiste tab
# (we patchen minimal: bovenaan SIDE bepalen op basis van pathname)
node - <<'NODE'
const fs = require("fs");
let s = fs.readFileSync("app.js","utf8");

// alleen patchen als het nog niet bestaat
if(!s.includes("location.pathname === \"/bear\"") && s.includes("let SIDE =")){
  s = s.replace(
    /let SIDE =[^;]*;/,
    `let SIDE =
  (location.pathname === "/bear" || location.hash === "#bear") ? "bear" :
  (location.pathname === "/bull" || location.hash === "#bull") ? "bull" :
  "bull";`
  );
  fs.writeFileSync("app.js", s);
  console.log("✅ app.js patched: /bull en /bear werken");
} else {
  console.log("ℹ️ app.js patch al aanwezig of SIDE regel niet gevonden");
}
NODE

# 3) GitHub Actions: elke 10 min jouw /api/scan “aanroepen”
mkdir -p .github/workflows
cat > .github/workflows/scan.yml << 'YML'
name: scan

on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Call /api/scan
        run: |
          echo "Pinging scan url..."
          curl -sS -L "${{ secrets.SCAN_URL }}" | head -c 500
YML

echo "✅ .github/workflows/scan.yml gemaakt (cron */10)"

echo ""
echo "NEXT:"
echo "1) Zet GitHub Secret: SCAN_URL = https://JOUW-VERCEL-DOMAIN/api/scan"
echo "2) Commit + push"
