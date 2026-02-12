import "dotenv/config";
import { getRedis } from "../api/_lib/redis.js";
import { runFullScan } from "../api/_lib/scanCore.js";

const redis = getRedis();
const res = await runFullScan(redis);
console.log(res);
