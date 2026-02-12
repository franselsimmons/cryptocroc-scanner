#!/usr/bin/env bash
set -euo pipefail

echo "🚀 CryptoCroc – Clean runtime rebuild"

# ===============================
# 1️⃣ Check of we in git repo zitten
# ===============================
if [ ! -d ".git" ]; then
  echo "❌ Geen .git map gevonden. Ga naar je project root."
  exit 1
fi

# ===============================
# 2️⃣ Laatste versie ophalen
# ===============================
echo "⬇️ Git pull..."
git pull --rebase || true

# ===============================
# 3️⃣ Oude vercel.json verwijderen
# ===============================
if [ -f "vercel.json" ]; then
  echo "🗑 Oude vercel.json verwijderen..."
  rm vercel.json
fi

# ===============================
# 4️⃣ Nieuwe correcte vercel.json maken
# ===============================
cat << 'JSON' > vercel.json
{
  "version": 2
}
JSON

echo "✅ Nieuwe vercel.json aangemaakt"

# ===============================
# 5️⃣ Node 18 forceren
# ===============================
echo "🔧 Node 18 instellen..."
npm pkg set engines.node=">=18"

# ===============================
# 6️⃣ Oude node_modules verwijderen (zekerheid)
# ===============================
if [ -d "node_modules" ]; then
  echo "🗑 node_modules verwijderen..."
  rm -rf node_modules
fi

if [ -f "package-lock.json" ]; then
  rm package-lock.json
fi

# ===============================
# 7️⃣ Dependencies opnieuw installeren
# ===============================
echo "📦 npm install..."
npm install

# ===============================
# 8️⃣ Commit + Push
# ===============================
echo "📤 Commit & Push..."
git add .
git commit -m "fix: clean vercel runtime config + node18 rebuild"
git push

echo ""
echo "🎯 Klaar."
echo "Ga nu naar Vercel → Deployments → Redeploy → Clear Cache aanzetten."
echo ""
