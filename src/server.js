import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { MoltbookClient } from "./moltbook.js";
import { generatePost, solveChallenge } from "./llm.js";
import { loadTemplates, store } from "./store.js";

const app = new Hono();

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-20250514";
const AGENT_NAME = process.env.AGENT_NAME || "RailwayDeployer";
const POST_INTERVAL_MIN = parseInt(process.env.POST_INTERVAL_MIN || "240", 10);
const DRY_RUN = process.env.DRY_RUN === "1";
const PORT = parseInt(process.env.PORT || "3000", 10);

const client = new MoltbookClient(MOLTBOOK_API_KEY);
const TEMPLATES = loadTemplates();
const configured = MOLTBOOK_API_KEY.startsWith("moltbook_");

// ---------- dashboard ----------
app.get("/", (c) => {
  const s = store.get();
  return c.html(renderDashboard(s));
});

app.get("/health", (c) => c.json({ status: "ok", service: "moltbook-bot-lite", configured, timestamp: new Date().toISOString() }));

app.get("/api/status", (c) => {
  const s = store.get();
  return c.json({ configured, agent_name: AGENT_NAME, post_interval_min: POST_INTERVAL_MIN, dry_run: DRY_RUN, ...s, templates: TEMPLATES.map(t => t.name) });
});

app.post("/api/post-now", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const submolt = body.submolt || process.env.DEFAULT_SUBMOLT || "selfhosted";
  const result = await runCycle(submolt, body.topic || null);
  return c.json(result, result.ok ? 200 : 502);
});

// ---------- bot loop ----------
async function runCycle(submolt, forcedTopic = null) {
  const s = store.get();
  try {
    if (!configured) throw new Error("MOLTBOOK_API_KEY not set (must start with moltbook_)");

    // 1. generate content via LLM
    const recentTitles = s.recent_posts.map((p) => p.title);
    const { title, content } = await generatePost({
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
      agentName: AGENT_NAME,
      templates: TEMPLATES,
      recentTitles,
      forcedTopic,
    });

    if (DRY_RUN) {
      const entry = { at: new Date().toISOString(), title, submolt, status: "dry_run" };
      store.addPost(entry, 20);
      return { ok: true, dry_run: true, title, content };
    }

    // 2. post to Moltbook
    const res = await client.createPost(submolt, title, content);

    // 3. solve anti-spam verification challenge if issued
    let verified = false;
    const verification = res?.post?.verification || res?.verification || null;
    if (verification?.challenge_text) {
      const answer = await solveChallenge({
        baseUrl: LLM_BASE_URL,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
        challengeText: verification.challenge_text,
        instructions: verification.instructions || "",
      });
      const code = verification.verification_code || verification?.post?.verification_code;
      const vres = await client.submitVerification(code, answer);
      verified = !!vres?.success;
    }

    const entry = {
      at: new Date().toISOString(),
      title,
      submolt,
      post_id: res?.post?.id || null,
      verification_status: verification ? (verified ? "verified" : "failed") : "none",
    };
    store.addPost(entry, 20);
    console.log(`[post] ${title} -> m/${submolt} (verified=${verified})`);
    return { ok: true, ...entry };
  } catch (err) {
    const entry = { at: new Date().toISOString(), title: forcedTopic || "(cycle)", submolt, error: String(err?.message || err) };
    store.addPost(entry, 20);
    console.error("[post] failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// keep a single timer
let nextRun = Date.now() + 60_000; // first cycle 1 min after boot
setInterval(async () => {
  if (Date.now() < nextRun) return;
  nextRun = Date.now() + POST_INTERVAL_MIN * 60_000;
  if (DRY_RUN || configured) {
    const submolt = process.env.DEFAULT_SUBMOLT || "selfhosted";
    await runCycle(submolt);
  }
}, 30_000).unref();

// ---------- dashboard ----------
function esc(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDashboard(s) {
  const rows = s.recent_posts
    .map(
      (p) => `<tr><td>${esc(p.at)}</td><td>${esc(p.submolt)}</td><td>${esc(p.title)}</td><td>${esc(p.verification_status || p.status || p.error || "")}</td></tr>`
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(AGENT_NAME)} — Moltbook Bot Lite</title>
<style>body{font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;background:#0f1117;color:#e6e6e6}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{padding:.4rem .6rem;border-bottom:1px solid #2a2d3a;text-align:left}
.k{color:#ff6a3d;font-weight:700}code{background:#1a1d29;padding:.1rem .35rem;border-radius:4px}</style></head><body>
<h1><span class="k">🦞</span> ${esc(AGENT_NAME)} — Moltbook Bot Lite</h1>
<p>Configured: <b>${configured}</b> · Posts every <b>${POST_INTERVAL_MIN} min</b> · Dry-run: <b>${DRY_RUN}</b> · Next run: <b>${new Date(nextRun).toISOString()}</b></p>
<p>Templates marketed: ${TEMPLATES.map((t) => `<code>${esc(t.name)}</code>`).join(", ")}</p>
<h2>Recent posts</h2><table><tr><th>Time</th><th>Submolt</th><th>Title</th><th>Status</th></tr>${rows}</table>
</body></html>`;
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`moltbook-bot-lite listening on :${info.port} (configured=${configured})`);
});