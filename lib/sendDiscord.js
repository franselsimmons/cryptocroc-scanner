export async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return;

  const max = 3800;
  const chunks = [];
  let s = String(description || "");

  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  chunks.push(s);

  for (let i = 0; i < chunks.length; i++) {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: i === 0 ? title : `${title} (vervolg ${i + 1})`,
            description: chunks[i],
            color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Discord ${r.status}: ${txt.slice(0, 200)}`);
    }
  }
}