// lib/sendDiscord.js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkString(str, maxLen) {
  const s = String(str || "");
  if (!s) return [];

  const size = Math.max(1, Number(maxLen || 3800));
  const out = [];

  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + size));
    i += size;
  }

  return out;
}

async function postJsonWithTimeout(url, body, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function getRetryDelayMs(res, fallbackMs) {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const retryNum = Number(retryAfter);
    if (Number.isFinite(retryNum) && retryNum > 0) {
      return Math.round(retryNum * 1000);
    }
  }

  const resetAfter = res.headers.get("x-ratelimit-reset-after");
  if (resetAfter) {
    const resetNum = Number(resetAfter);
    if (Number.isFinite(resetNum) && resetNum > 0) {
      return Math.round(resetNum * 1000);
    }
  }

  return fallbackMs;
}

async function postWithRetry(url, body, { maxRetries = 4, timeoutMs = 12000 } = {}) {
  let attempt = 0;
  let backoffMs = 750;

  while (attempt <= maxRetries) {
    attempt += 1;

    try {
      const res = await postJsonWithTimeout(url, body, timeoutMs);

      if (res.ok) return true;

      if (res.status === 429 && attempt <= maxRetries) {
        const waitMs = getRetryDelayMs(res, backoffMs);
        await sleep(waitMs);
        backoffMs = Math.min(backoffMs * 2, 10000);
        continue;
      }

      if (res.status >= 500 && attempt <= maxRetries) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10000);
        continue;
      }

      let errorText = "";
      try {
        errorText = await res.text();
      } catch {}

      console.error(
        `sendDiscord: HTTP ${res.status} failed` +
          (errorText ? ` | ${errorText.slice(0, 500)}` : "")
      );
      return false;
    } catch (err) {
      const isAbort = err?.name === "AbortError";

      if (attempt > maxRetries) {
        console.error(
          `sendDiscord: request failed after ${attempt} attempts` +
            ` | ${isAbort ? "timeout" : err?.message || String(err)}`
        );
        return false;
      }

      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }

  return false;
}

export async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return false;

  const safeTitle = String(title || "").slice(0, 256).trim() || "Signal";
  const safeDescription = String(description || "").trim();

  if (!safeDescription) {
    console.warn("sendDiscord: skipped empty description");
    return false;
  }

  const chunks = chunkString(safeDescription, 3800);
  if (!chunks.length) return false;

  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      embeds: [
        {
          title: i === 0 ? safeTitle : `${safeTitle} (vervolg ${i + 1}/${chunks.length})`,
          description: chunks[i],
          color: Number.isFinite(Number(color)) ? Number(color) : 3066993,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const ok = await postWithRetry(webhook, payload, {
      maxRetries: 4,
      timeoutMs: 12000,
    });

    if (!ok) {
      const preview =
        typeof webhook === "string" ? `${webhook.slice(0, 60)}...` : "unknown_webhook";
      console.error(
        `sendDiscord: chunk ${i + 1}/${chunks.length} failed for webhook ${preview}`
      );
      allOk = false;
    }
  }

  return allOk;
}

export default {
  sendDiscord,
};