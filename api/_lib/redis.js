import { Redis } from "@upstash/redis";

let client = null;

export function redis() {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  }
  client = new Redis({ url, token });
  return client;
}

// simpele lock tegen dubbele scans (180 sec)
export async function acquireLock(key, ttlSec = 180) {
  const r = redis();
  const ok = await r.set(key, Date.now(), { nx: true, ex: ttlSec });
  return !!ok;
}
export async function releaseLock(key) {
  const r = redis();
  await r.del(key);
}
