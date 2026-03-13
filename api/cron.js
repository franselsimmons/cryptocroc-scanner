// api/cron.js
import mainScan from "./scan.js";

function createMockReq(mode) {
  return {
    query: {
      mode,
      token: process.env.CRON_SECRET,
    },
    headers: {
      authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
    },
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    setHeader(key, value) {
      this.headers[key] = value;
    },

    json(payload) {
      this.body = payload;
      return this;
    },

    end(payload) {
      try {
        this.body = typeof payload === "string" ? JSON.parse(payload) : payload;
      } catch {
        this.body = payload;
      }
      return this;
    },
  };
}

async function runMode(mode) {
  const req = createMockReq(mode);
  const res = createMockRes();
  await mainScan(req, res);

  return {
    ok: res.statusCode < 400,
    statusCode: res.statusCode,
    body: res.body,
  };
}

export default async function handler(req, res) {
  try {
    const auth =
      req.query?.token ||
      req.headers?.authorization?.replace("Bearer ", "");

    if (auth !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const mode = String(req.query?.mode || "bull").toLowerCase();

    if (mode !== "bull" && mode !== "bear") {
      return res.status(400).json({
        ok: false,
        error: "use mode=bull or mode=bear",
      });
    }

    const result = await runMode(mode);

    return res.status(200).json({
      ok: true,
      mode,
      result,
    });
  } catch (e) {
    console.error("api/cron.js error:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "cron failed",
    });
  }
}