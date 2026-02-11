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
