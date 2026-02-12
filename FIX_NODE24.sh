#!/usr/bin/env bash
set -euo pipefail

echo "🔧 Fix: Node 24 for Vercel"

# package.json aanpassen naar node 24.x
node - <<'NODE'
import fs from "fs";

const p = JSON.parse(fs.readFileSync("package.json","utf8"));
p.engines = p.engines || {};
p.engines.node = "24.x";
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
console.log("✅ package.json -> engines.node = 24.x");
NODE

# vercel.json runtime aanpassen naar nodejs24.x
cat > vercel.json << 'JSON'
{
  "functions": {
    "api/*.js": {
      "runtime": "nodejs24.x"
    }
  }
}
JSON
echo "✅ vercel.json -> runtime nodejs24.x"

# opnieuw install (veilig) + push
npm install

git add package.json vercel.json package-lock.json 2>/dev/null || true
git add -A
git commit -m "Fix: use Node 24 on Vercel" || true
git push

echo "🎉 Klaar. Ga naar Vercel en hij deployt opnieuw."
