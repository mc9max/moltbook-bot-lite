// End-to-end verification of the trend-discovery wiring in build-entry.js:
// crawling a (mock) Moltbook feed -> picking an emerging topic -> steering the
// LLM prompt with it (forcedTopic). DRY_RUN so nothing is ever posted.
// The actual cycle runs in test/trend-cycle-worker.js in its OWN bun process:
// build-entry.js/moltbook.js freeze env at module-import time, and `bun test`
// runs files in parallel workers sharing process.env (waf.test.js would race
// this setup — env must be set before that import, hence process isolation).
//   bun test test/trend-cycle.test.js
import { test, expect } from "bun:test";

function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const p = s.port;
  s.stop(true);
  return p;
}

test("cycle crawls the feed and steers the LLM prompt at the trending topic", async () => {
  const moltPort = freePort();
  const llmPort = freePort();
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", "test/trend-cycle-worker.js", String(moltPort), String(llmPort)],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  const line = out.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
  expect(line).toBeTruthy();
  const r = JSON.parse(line.replace("RESULT_JSON:", ""));
  expect(r.ok).toBe(true);
  expect(r.dryRun).toBe(true);
  // forcedTopic reached the LLM user prompt ("Write a Moltbook post about: ...")
  expect(r.userPrompt).toContain("Write a Moltbook post about:");
  expect(r.userPrompt).toContain("postgres backup");
  // generic angle (no catalog product matches postgres backups) — no product
  // name is force-stitched into the topic line
  expect(r.userPrompt).toContain("what agents shipping in this space should learn");
  // the prompt still carries full catalog + submolt guidance
  expect(r.userPrompt).toContain("URL-to-Markdown API");
}, 30_000);