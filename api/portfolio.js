import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const file = path.join(process.cwd(), "cryptocroc-terminal", "output", "portfolio.json");
  try {
    const txt = fs.readFileSync(file, "utf8");
    res.setHeader("cache-control", "no-store");
    res.status(200).json(JSON.parse(txt));
  } catch (e) {
    res.status(404).json({ ok:false, error:"portfolio.json not found" });
  }
}
