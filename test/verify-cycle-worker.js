// Worker for verify-cycle.test.js. Runs in its OWN bun process because
// build-entry.js and moltbook.js freeze env (MOLTBOOK_API_BASE etc.) at
// module-import time, and `bun test` runs files in parallel workers sharing
// process.env. Prints one JSON line: RESULT_JSON:{...}.
// Usage: bun test/verify-cycle-worker.js <moltPort> <llmPort> <mode>
//   mode = success (first answer accepted) | reject (all answers refused)
//        | expired (challenge already expired — nothing may be submitted)
//
// DRY_RUN is deliberately NOT set: the flow under test is a real POST /posts
// followed by the verification retry loop against this mock server.
process.env.MOLTBOOK_RETRY_BASE_MS = "1";
const MOLT_PORT = Number(process.argv[2]);
const LLM_PORT = Number(process.argv[3]);
const VERIFY_MODE = process.argv[4] || "success";

process.env.MOLTBOOK_API_BASE = `http://127.0.0.1:${MOLT_PORT}/api/v1`;
process.env.MOLTBOOK_API_KEY = "moltbook_test";
process.env.LLM_BASE_URL = `http://127.0.0.1:${LLM_PORT}`;
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL = "mock";
process.env.DATA_DIR = `/tmp/verify-cycle-${VERIFY_MODE}-${MOLT_PORT}`;
process.env.TREND_SOURCES = "moltbook";
process.env.INAPP_SOURCES = ""; // inapp watcher does real network fetches — keep it out of this mock
delete process.env.PRODUCTS_REGISTRY_URL;
delete process.env.BLOGGER_CLIENT_ID;
delete process.env.BLOGGER_CLIENT_SECRET;
delete process.env.BLOGGER_REFRESH_TOKEN;
delete process.env.DEVTO_API_KEY;

const CHALLENGE_TEXT =
  "A train travels twenty five meters and slows by five meters. What is the new speed?";
// deobfuscated -> "25 ... slows by 5 ..." -> deterministic 25-5 = 20.00.
const CORRECT_ANSWER = "20.00";

const verifyCalls = [];
let postsCalls = 0;

const moltServer = Bun.serve({
  port: MOLT_PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/v1/feed") {
      return Response.json({
        posts: [
          { title: "Why our Postgres backup restore took 6 hours", submolt_name: "selfhosted", upvotes: 40, comment_count: 12 },
          { title: "Postgres backup restore pitfalls nobody warns about", submolt_name: "selfhosted", upvotes: 30, comment_count: 9 },
          { title: "Totally unrelated: someone shipped a discord bot", submolt_name: "builds", upvotes: 5, comment_count: 1 },
        ],
      });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/submolts") {
      return Response.json({
        submolts: [
          { name: "selfhosted", description: "running your own stack" },
          { name: "builds", description: "things agents shipped" },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/posts") {
      postsCalls++;
      const body = await req.json();
      if (!body.title || !body.content) {
        return Response.json({ error: "Title must be 5-300 characters" }, { status: 400 });
      }
      const expiresAt =
        VERIFY_MODE === "expired"
          ? new Date(Date.now() - 60000).toISOString()
          : new Date(Date.now() + 300000).toISOString();
      return Response.json({
        post: {
          id: "p1",
          verification: {
            verification_code: "vcode-1",
            challenge_text: CHALLENGE_TEXT,
            instructions: "Answer with the result in 2 decimal places.",
            expires_at: expiresAt,
          },
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/verify") {
      const body = await req.json();
      verifyCalls.push(body.answer);
      const success = VERIFY_MODE === "success" && body.answer === CORRECT_ANSWER;
      return Response.json({ success, error: success ? undefined : "wrong answer" });
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

const llmServer = Bun.serve({
  port: LLM_PORT,
  fetch: async (req) => {
    if (new URL(req.url).pathname === "/chat/completions") {
      const body = await req.json();
      const user = (body.messages || []).find((m) => m.role === "user")?.content || "";
      if (user.includes("Problem:")) {
        // mirror the real glm failure mode: a confident wrong answer
        return Response.json({ choices: [{ message: { content: "0.00" } }] });
      }
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
      JSON.stringify({
        ok: result.ok,
        title: result.title || "",
        verification_status: result.verification_status,
        verification_attempts: result.verification_attempts,
        blog: result.blog,
        verifyCalls,
        postsCalls,
      })
  );
} catch (e) {
  moltServer.stop(true);
  llmServer.stop(true);
  console.log("RESULT_JSON:" + JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
}