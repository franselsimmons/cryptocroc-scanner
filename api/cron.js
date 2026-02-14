// /api/cron.js
import scan from "./scan.js";
import { RUNTIME_CONFIG, requireSecret } from "./_core.js";

export const config = RUNTIME_CONFIG;

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    end(txt) {
      this.body = txt || "";
    },
  };
}

function safeJson(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: String(txt || "") };
  }
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const secret = process.env.CRON_SECRET || "";
    const authHeader = secret ? { authorization: `Bearer ${secret}` } : {};

    const reqBull = { method: "GET", query: { mode: "bull" }, headers: authHeader };
    const reqBear = { method: "GET", query: { mode: "bear" }, headers: authHeader };

    const resBull = makeRes();
    const resBear = makeRes();

    await scan(reqBull, resBull);
    await scan(reqBear, resBear);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        bull: safeJson(resBull.body),
        bear: safeJson(resBear.body),
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}