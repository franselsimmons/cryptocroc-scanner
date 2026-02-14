async function load() {
  const res = await fetch("/api/latest?mode=bull", { cache: "no-store" });
  const data = await res.json();

  document.getElementById("topline").innerText =
    "Laatste update: " + new Date(data.ts).toLocaleTimeString() +
    " | Radar: " + data.counts.radar;

  render("list-entry",  data.funnel.entry);
  render("list-almost", data.funnel.almost);
  render("list-buildup",data.funnel.buildup);
  render("list-radar",  data.funnel.radar);
}

function render(id, list) {
  const el = document.getElementById(id);
  if (!list || list.length === 0) {
    el.innerHTML = "<div>Geen coins.</div>";
    return;
  }

  el.innerHTML = list.map(c => `
    <div class="coin">
      <b>${c.symbol}</b> | $${c.price} | ${c.change24}%
      <br>Vol: ${c.volume} | MC: ${c.marketCap}
    </div>
  `).join("");
}

load();
setInterval(load, 15000);