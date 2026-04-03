// lib/sendDiscord.js
export async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return false;

  const chunks = [];
  const max = 3800;
  let s = String(description || "");

  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  if (s.length || chunks.length === 0) chunks.push(s);

  // helper: fetch met timeout + retry (429 + transient)
  async function postOnce(embed) {
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
        signal: controller.signal,
      });

      // Discord kan 204 teruggeven (OK zonder body)
      if (r.ok) return { ok: true, status: r.status, retryAfterMs: 0 };

      // rate limit
      const ra = r.headers?.get?.("retry-after");
      const raMs = ra ? Math.ceil(Number(ra) * 1000) : 0;

      const txt = await r.text().catch(() => "");
      return {
        ok: false,
        status: r.status,
        retryAfterMs: raMs,
        text: txt.slice(0, 250),
      };
    } catch (e) {
      return { ok: false, status: 0, retryAfterMs: 0, text: String(e?.message || e) };
    } finally {
      clearTimeout(t);
    }
  }

  async function postWithRetry(embed) {
    const maxTries = 4;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const res = await postOnce(embed);
      if (res.ok) return true;

      const isRateLimit = res.status === 429;
      const isTransient =
        res.status === 0 || // network/timeout
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504;

      if (!isRateLimit && !isTransient) {
        throw new Error(`Discord ${res.status}: ${res.text || ""}`);
      }

      const backoffMs =
        res.retryAfterMs > 0
          ? res.retryAfterMs
          : Math.min(2500 * attempt, 8000);

      if (attempt === maxTries) {
        throw new Error(`Discord ${res.status}: ${res.text || "failed"} (after retries)`);
      }

      await new Promise((r) => setTimeout(r, backoffMs));
    }

    return false;
  }

  for (let i = 0; i < chunks.length; i++) {
    const embed = {
      title: i === 0 ? title : `${title} (vervolg ${i + 1})`,
      description: chunks[i],
      color,
      timestamp: new Date().toISOString(),
    };

    await postWithRetry(embed);
  }

  return true;
}