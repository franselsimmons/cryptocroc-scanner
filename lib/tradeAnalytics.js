import { kv } from "@vercel/kv";
export async function logTradeOpened(data) { await kv.lpush("analytics:trades:opened", data); }
export async function logTradeClosed(data) { await kv.lpush("analytics:trades:closed", data); }
