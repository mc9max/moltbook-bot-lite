// cron-entry.js — run-and-exit entrypoint for Railway cron (startCommand).
// Railway cron executes the service's start command on the schedule and
// expects the process to terminate; moltbook's internal setInterval scheduler
// is NOT run here (a never-exiting process would make Railway skip all later
// runs). One process = one posting cycle, then exit 0 (or 1 on failure so the
// restart policy can retry).
//
// Scheduling model: RAILWAY CRON OWNS THE CADENCE. POST_INTERVAL_MIN is only
// a guard vs. the last recorded cycle: if a cycle started less than
// POST_INTERVAL_MIN ago (e.g. a manual redeploy right after a run), this run
// exits 0 without posting. The internal setInterval scheduler in server.js is
// for the repo Dockerfile path (template installs) only.

import { runCycle, store } from "./build-entry.js";

const POST_INTERVAL_MIN = parseInt(process.env.POST_INTERVAL_MIN || "240", 10);
// Railway cron OWNS the cadence. This guard only prevents surprise duplicate
// posts from off-schedule executions (manual redeploys, var changes). It must
// sit BELOW the cron interval or every other cron run skips (beat pattern:
// 4h cron + 240-min guard => 8h cadence). POST_INTERVAL_MIN - 10 keeps the
// historical spacing intent for redeploys while letting each 4h cron fire
// through (elapsed ~240 > 230).
const GUARD_MIN = Math.max(POST_INTERVAL_MIN - 10, 5);

const last = (store.get().recent_posts || []).map((p) => Date.parse(p.at)).find((t) => !isNaN(t)) || 0;
const elapsedMin = last ? (Date.now() - last) / 60000 : Infinity;
if (elapsedMin < GUARD_MIN) {
  console.log(`[cron] last cycle ${Math.round(elapsedMin)} min ago (< guard ${GUARD_MIN}) — skipping, exit 0`);
  process.exit(0);
}

try {
  const result = await runCycle(null); // submolt decided inside the cycle from live list
  console.log(`[cron] cycle done: ok=${result.ok}${result.title ? ` title="${result.title}"` : ""}${result.error ? ` error=${result.error}` : ""}`);
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  console.error("[cron] cycle crashed:", e?.message || e);
  process.exit(1);
}