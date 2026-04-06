// lib/sendDiscord.js
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function chunkString(str, maxLen) {
  const s = String(str || "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

async function postWithRetry(url, body, { maxRetries = 4 } = {}) {
  let attempt = 0;
  let backoffMs = 650;
  while (true) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      if (res.status === 429 && attempt <= maxRetries) {
        const ra = res.headers.get("retry-after");
        await sleep(ra ? Math.round(Number(ra) * 1000) : backoffMs);
        continue;
      }
      if (res.status >= 500 && attempt <= maxRetries) {
        await sleep(backoffMs);
        backoffMs *= 2;
        continue;
      }
      return false;
    } catch (e) {
      if (attempt > maxRetries) return false;
      await sleep(backoffMs);
    }
  }
}

export async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return false;
  const chunks = chunkString(description, 3800);
  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      embeds: [{
        title: i === 0 ? title : `${title} (vervolg)`,
        description: chunks[i],
        color,
        timestamp: new Date().toISOString(),
      }],
    };
    const ok = await postWithRetry(webhook, payload);
    if (!ok) {
      console.error(`sendDiscord: chunk ${i+1}/${chunks.length} failed for webhook ${webhook.slice(0,50)}...`);
      allOk = false;
    }
  }
  return allOk;
}