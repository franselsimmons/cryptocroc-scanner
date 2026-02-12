import { Redis } from "@upstash/redis";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export const redis = new Redis({
  url: must("KV_REST_API_URL"),
  token: must("KV_REST_API_TOKEN"),
});
