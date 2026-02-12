#!/usr/bin/env bash
set -euo pipefail

echo "🧹 Fix: haal runtime config uit vercel.json (dit veroorzaakt jouw build fail)"

# 1) Weg met vercel.json (runtime error bron)
rm -f vercel.json

# 2) Zorg dat package.json Node 24 gebruikt (Vercel vroeg dit eerder expliciet)
node - <<'NODE'
import fs from "fs";
const p = JSON.parse(fs.readFileSync("package.json","utf8"));
p.engines = { node: "24.x" };
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
console.log("✅ package.json engines.node = 24.x");
NODE

# 3) Schone install (niet verplicht maar fijn)
rm -rf node_modules
rm -f package-lock.json
npm install

# 4) Commit + push
git add -A
git commit -m "Fix: remove vercel.json runtime (let Vercel choose), keep Node 24 engines" || true
git push

echo "🚀 Gepusht. Nu moet Vercel wél kunnen builden."
