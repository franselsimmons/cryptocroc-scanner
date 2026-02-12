#!/usr/bin/env bash
set -euo pipefail

echo "🧹 Volledige runtime reset..."

# 1. Verwijder oude vercel.json
rm -f vercel.json

# 2. Maak nieuwe correcte vercel.json
cat > vercel.json << 'JSON'
{
  "functions": {
    "api/**/*.js": {
      "runtime": "nodejs24.x"
    }
  }
}
JSON

echo "✅ vercel.json geforceerd naar nodejs24.x"

# 3. Forceer package.json engines naar 24.x
node - <<'NODE'
import fs from "fs";
const p = JSON.parse(fs.readFileSync("package.json","utf8"));
p.engines = { node: "24.x" };
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
console.log("✅ package.json engines.node = 24.x");
NODE

# 4. Verwijder node_modules en lockfile (schone build)
rm -rf node_modules
rm -f package-lock.json

npm install

# 5. Commit & push
git add -A
git commit -m "FULL runtime reset -> nodejs24.x clean build" || true
git push

echo "🚀 Klaar. Vercel zal nu schoon opnieuw bouwen."
