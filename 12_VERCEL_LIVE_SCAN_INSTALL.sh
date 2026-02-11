#!/usr/bin/env bash
set -e

echo "== CryptoCroc Vercel LIVE scan install (FREE compatible) =="

mkdir -p api

############################################
# 1. VERCEL SCAN RUNNER
############################################
cat << 'EOR' > api/_runner.mjs
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const SCAN_PATH = path.join(process.cwd(), "cryptocroc-terminal", "scanner", "scan.js");

let CACHE = { ts: 0, bull: null, bear: null };

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function runScanToTmp() {
  return new Promise((resolve, reject) => {
    const OUT_DIR = "/tmp/cryptocroc-output";
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const p = spawn(process.execPath, [SCAN_PATH], {
      env: { ...process.env, OUT_DIR },
      stdio: "inherit",
    });

    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("scan.js exited with code " + code));
      }

      const bull = readJsonSafe(path.join(OUT_DIR, "bull.json"));
      const bear = readJsonSafe(path.join(OUT_DIR, "bear.json"));

      if (!bull || !bear) {
        return reject(new Error("Scan output ontbreekt in /tmp"));
      }

      CACHE = { ts: Date.now(), bull, bear };
      resolve(CACHE);
    });
  });
}

export async function getScanCached(maxAgeMs = 120000) {
  const fresh = CACHE?.bull && CACHE?.bear && (Date.now() - CACHE.ts) < maxAgeMs;
  if (fresh) return CACHE;
  return await runScanToTmp();
}
EOR

############################################
# 2. /api/bull
############################################
cat << 'EOB' > api/bull.mjs
import { getScanCached } from "./_runner.mjs";

export default async function handler(req, res) {
  try {
    const data = await getScanCached();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data.bull);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
EOB

############################################
# 3. /api/bear
############################################
cat << 'EOC' > api/bear.mjs
import { getScanCached } from "./_runner.mjs";

export default async function handler(req, res) {
  try {
    const data = await getScanCached();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data.bear);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
EOC

############################################
# 4. scan.js aanpassen voor Vercel /tmp
############################################
SCAN_FILE="cryptocroc-terminal/scanner/scan.js"

if grep -q "process.env.OUT_DIR" "$SCAN_FILE"; then
  echo "scan.js OUT_DIR al correct."
else
  echo "OUT_DIR patchen in scan.js..."

  sed -i 's|const OUT_DIR = .*|const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), "cryptocroc-terminal", "output");|' "$SCAN_FILE" || true
fi

echo "✅ Vercel LIVE scan installatie voltooid"
echo "➡️ Nu: git add .  &&  git commit -m \"vercel live scan\"  &&  git push"
