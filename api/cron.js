// api/cron.js
import mainScan from "./scan.js";

async function runSingle(mode) {
  const req = {
    query: {
      mode,
      token: process.env.CRON_SECRET,
    },
    headers: {},
  };

  let body = null;
  let statusCode = 200;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(obj) {
      body = obj;
      return this;
    },
    setHeader() {},
    end(payload) {
      try {
        body = typeof payload === "string" ? JSON.parse(payload) : payload;
      } catch {
        body = payload;
      }
      return this;
    },
    statusCode: 200,
  };

  await mainScan(req, res);
  return { statusCode, body };
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "both").toLowerCase();

    if (mode === "bull") {
      const bull = await runSingle("bull");
      return res.status(200).json({ ok: true, mode: "bull", bull });
    }

    if (mode === "bear") {
      const bear = await runSingle("bear");
      return res.status(200).json({ ok: true, mode: "bear", bear });
    }

    const bull = await runSingle("bull");
    const bear = await runSingle("bear");

    return res.status(200).json({
      ok: true,
      mode: "both",
      bull,
      bear,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}