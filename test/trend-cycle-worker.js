// Worker for trend-cycle.test.js. Runs in its OWN bun process because
// build-entry.js and moltbook.js freeze env (MOLTBOOK_API_BASE etc.) at
// module-import time, and `bun test` runs files in parallel workers sharing
// process.env — a sibling test file (waf) would otherwise race this setup.
// Prints one JSON line on success: { resultTitle, userPrompt }.
process.env.MOLTBOOK_RETRY_BASE_MS = "1";
const MOLT_PORT = Number(process.argv[2]);
const LLM_PORT = Number(process.argv[3]);

process.env.MOLTBOOK_API_BASE = `http://127.0.0.1:${MOLT_PORT}/api/v1`;
process.env.MOLTBOOK_API_KEY = "moltbook_test";
process.env.LLM_BASE_URL = `http://127.0.0.1:${LLM_PORT}`;
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL = "mock";
process.env.DRY_RUN = "1";
process.env.DATA_DIR = "/tmp/trend-cycle-test-data";
process.env.TREND_SOURCES = "moltbook";
delete process.env.PRODUCTS_REGISTRY_URL;

let capturedUserPrompt = null;

const moltServer = Bun.serve({
  port: MOLT_PORT,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/feed") {
      return Response.json({
        posts: [
          { title: "Why our Postgres backup restore took 6 hours", submolt_name: "selfhosted", upvotes: 40, comment_count: 12 },
          { title: "Postgres backup restore pitfalls nobody warns about", submolt_name: "selfhosted", upvotes: 30, comment_count: 9 },
          { title: "My agent built itself a discord bot and it immediately spammed everyone", submolt_name: "builds", upvotes: 5, comment_count: 1 },
        ],
      });
    }
    if (url.pathname === "/api/v1/submolts") {
      return Response.json({
        submolts: [
          { name: "selfhosted", description: "running your own stack" },
          { name: "builds", description: "things agents shipped" },
          { name: "infrastructure", description: "networks and queues" },
        ],
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

const CONTENT =
  "Last quarter I trusted a nightly database dump that had been silently failing for weeks. " +
  "The failure mode was boring: the cron job succeeded, the log said OK, but the dump file was " +
  "zero bytes because the disk filled the day before and the error went to stderr nobody read. " +
  "When the underlying host rebooted mid-upgrade, the volume came back corrupted and my restore " +
  "path was a guess. Rebuilding from scratch took most of a weekend and taught me more than any " +
  "tutorial: verify the restore, not the backup. Now I schedule an automated test restore into a " +
  "throwaway container every night, checksum the result, and alert on stale or empty dumps. " +
  "The tooling took an afternoon; the confidence it buys is worth several weekends.";
// 300+ chars, no CTAs, no links: passes generatePost's goodContent gate.

const llmServer = Bun.serve({
  port: LLM_PORT,
  fetch: async (req) => {
    if (new URL(req.url).pathname === "/chat/completions") {
      const body = await req.json();
      const user = (body.messages || []).find((m) => m.role === "user")?.content || "";
      capturedUserPrompt = user;
      const post = {
        title: "A silently failing backup cost me a weekend of rebuilding",
        content: CONTENT,
        submolt: "selfhosted",
        tags: ["postgres", "backups"],
      };
      return Response.json({ choices: [{ message: { content: JSON.stringify(post) } }] });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

try {
  const { runCycle } = await import("../src/build-entry.js");
  const result = await runCycle(null);
  moltServer.stop(true);
  llmServer.stop(true);
  console.log(
    "RESULT_JSON:" +
      JSON.stringify({ ok: result.ok, dryRun: result.dry_run, resultTitle: result.title || "", userPrompt: capturedUserPrompt || "" })
  );
} catch (e) {
  moltServer.stop(true);
  llmServer.stop(true);
  console.log("RESULT_JSON:" + JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
}