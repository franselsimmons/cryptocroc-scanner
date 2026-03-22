export default async function handler(req, res) {
  const { secret } = req.query;
  if (secret !== "lara-roos") return res.status(401).end();

  const data = await fetch(
    `${process.env.BASE_URL}/api/analyze-pro?secret=${secret}`
  ).then(r => r.json());

  function renderSection(title, items) {
    return `
      <div style="margin-bottom:30px">
        <h2>${title}</h2>
        ${items.map(i => `
          <div style="background:#111826;padding:12px;margin-bottom:10px;border-radius:10px">
            <b>${i.filter}</b> — ${i.score}/10<br/>
            ❌ ${i.issue}<br/>
            ✔ ${i.fix}<br/>
            🔥 ${i.target}
          </div>
        `).join("")}
      </div>
    `;
  }

  const html = `
  <html>
  <body style="background:#0b0f14;color:white;font-family:sans-serif;padding:20px">

  <h1>🔥 COMPLETE SYSTEM ANALYSE</h1>

  ${renderSection("MAIN FUNNEL", data.main)}
  ${renderSection("MOON FUNNEL", data.moon)}
  ${renderSection("TRADE FUNNEL", data.trade)}

  </body>
  </html>
  `;

  res.send(html);
}