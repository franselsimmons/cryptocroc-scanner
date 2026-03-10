// /api/moon/run-all.js

import runAllCron from "./run_all_cron.js";

export { config } from "./run_all_cron.js";

export default async function handler(req, res) {
  return runAllCron(req, res);
}