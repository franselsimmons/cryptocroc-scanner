import { kv } from "@vercel/kv";
export function uid(prefix = "id") { return `${prefix}_${Math.random().toString(36).substr(2, 9)}`; }
export async function pushEvent(name, payload) {
    await kv.lpush("analytics:events", { name, payload, ts: Date.now() });
}
