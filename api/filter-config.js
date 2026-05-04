import { getFilters, setFilters } from "../lib/filterState.js";

const SYSTEM_PROFILE = "RUNNER";

function isAuthorized(req) {
  const token = req.headers["x-admin-token"];
  return token && token === process.env.ADMIN_TOKEN;
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!isAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: "unauthorized"
    });
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      filters: getFilters()
    });
  }

  if (req.method === "POST") {
    const updated = setFilters(req.body || {});

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      filters: updated,
      updatedAt: Date.now()
    });
  }

  return res.status(405).json({
    ok: false,
    profile: SYSTEM_PROFILE,
    error: "method_not_allowed"
  });
}