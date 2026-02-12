import { Redis } from "@upstash/redis";

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  throw new Error("Missing KV_REST_API_URL / KV_REST_API_TOKEN (Vercel → Settings → Environment Variables)");
}

export const kv = new Redis({ url, token });
