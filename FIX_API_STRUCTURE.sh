#!/usr/bin/env bash
set -e

echo "🔧 Fix API structuur voor Vercel"

mkdir -p api

# Verplaats top10 als hij verkeerd staat
if [ -f top10.js ]; then
  mv top10.js api/top10.js
fi

if [ -f top10_bear.js ]; then
  mv top10_bear.js api/top10_bear.js
fi

echo "📦 Controle structuur:"
ls -R

git add .
git commit -m "fix: ensure api routes in root /api folder"
git push

echo "✅ Klaar. Wacht op Vercel redeploy."
