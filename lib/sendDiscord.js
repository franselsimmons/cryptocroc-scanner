// lib/sendDiscord.js
// Robust Discord sender with chunking + retries + 429 handling

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkString(str, maxLen) {
  const s = String(str || "");
  if (!s.length) return ["—"];
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out.length ? out : ["—"];
}

function parseRetryAfterMs(res) {
  const ra = res?.headers?.get?.("retry-after");
  if (!ra) return 0;
  const n = Number(ra);
  if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  return 0;
}

async function postWithRetry(url, body, { maxRetries = 4 } = {}) {
  let attempt = 0;
  let backoffMs = 650;

  while (true) {
    attempt++;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) return true;

    const status = res.status;
    const txt = await res.text().catch(() => "");
    const msg = txt.slice(0, 240);

    // 429 rate limit
    if (status === 429 && attempt <= maxRetries) {
      const waitMs = parseRetryAfterMs(res) || backoffMs;
      await sleep(waitMs);
      backoffMs = Math.min(6000, Math.round(backoffMs * 1.6));
      continue;
    }

    // transient server errors
    if ((status >= 500 || status === 408) && attempt <= maxRetries) {
      await sleep(backoffMs);
      backoffMs = Math.min(6000, Math.round(backoffMs * 1.6));
      continue;
    }

    throw new Error(`Discord ${status}: ${msg || "unknown_error"}`);
  }
}

// Returns true if sent, throws on hard error
export async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return false;

  const chunks = chunkString(description, 3800);

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      embeds: [
        {
          title: i === 0 ? title : `${title} (vervolg ${i + 1})`,
          description: chunks[i],
          color,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    await postWithRetry(webhook, payload, { maxRetries: 4 });
  }

  return true;
}