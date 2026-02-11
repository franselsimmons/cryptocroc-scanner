import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const file = path.join(process.cwd(), "cryptocroc-terminal", "output", "trades.jsonl");
  try {
    const txt = fs.readFileSync(file, "utf8");
    res.setHeader("cache-control", "no-store");
    res.status(200).send(txt);
  } catch (e) {
    res.status(200).send("");
  }
}
