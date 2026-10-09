// build-entry.js — bundle entry for the RAILWAY CRON path.
// Exports runCycle + store with NO Bun.serve and NO setInterval scheduler:
// Railway cron executes the start command and expects the process to exit.
// The dashboard + in-code scheduler remain in server.js (repo Dockerfile path
// used by template installs); this entry only feeds the cron bundle.

import { MoltbookClient } from "./moltbook.js";
import { generatePost, solveChallenge } from "./llm.js";
import { loadProducts, store } from "./store.js";
import { crossPost, bloggerEnabled, devtoEnabled, anyBlogEnabled } from "./blog.js";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-20250514";
const AGENT_NAME = process.env.AGENT_NAME || "RailwayDeployer";
const POST_INTERVAL_MIN = parseInt(process.env.POST_INTERVAL_MIN || "240", 10);
const DRY_RUN = process.env.DRY_RUN === "1";
const PORT = parseInt(process.env.PORT || "3000", 10);

const client = new MoltbookClient(MOLTBOOK_API_KEY);
const PRODUCTS = loadProducts();
const configured = MOLTBOOK_API_KEY.startsWith("moltbook_");

async function runCycle(explicitSubmolt, forcedTopic = null) {
  const s = store.get();
  let entryDebug = null;
  try {
    if (!configured) throw new Error("MOLTBOOK_API_KEY not set (must start with moltbook_)");

    // 0. live submolt list (TTL-cached; refreshes lazily so it never goes stale)
    const liveSubmolts = await client.listSubmolts();

    // 1. generate content via LLM
    const recentTitles = s.recent_posts.map((p) => p.title);
    const { title, content, submolt: llmSubmolt, tags: llmTags, imageQuery: llmImageQuery } = await generatePost({
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
      agentName: AGENT_NAME,
      products: PRODUCTS,
      recentTitles,
      forcedTopic,
      allowedSubmolts: explicitSubmolt ? [] : liveSubmolts.map((x) => `${x.name}: ${(x.description || "").slice(0, 100)}`),
    });
    // submolt priority: explicit request param > LLM pick (validated against
    // live list) > DEFAULT_SUBMOLT. LLM's own catalog names never leak in.
    const submolt = explicitSubmolt
      || normalizeSubmolt(llmSubmolt, liveSubmolts)
      || DEFAULT_SUBMOLT_FALLBACK;
    if (llmSubmolt && submolt !== llmSubmolt) {
      console.log(`[submolt] LLM picked "${llmSubmolt}" -> not in live list, using "${submolt}"`);
    }

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
      let vres = null;
      try {
        vres = await client.submitVerification(code, answer);
        verified = !!vres?.success;
      } catch (e) {
        verified = false;
        vres = { error: String(e?.message || e) };
      }
      entryDebug = `challenge="${String(verification.challenge_text || "").slice(0, 200)}" | answer="${answer}" | ${verified ? "ok" : String(vres?.error || "failed").slice(0, 60)}`;
    }

    const entry = {
      at: new Date().toISOString(),
      title,
      submolt,
      post_id: res?.post?.id || null,
      verification_status: verification ? (verified ? "verified" : "failed") : "none",
      ...(entryDebug ? { debug: entryDebug } : {}),
    };
    store.addPost(entry, 20);
    console.log(`[post] ${title} -> m/${submolt} (verified=${verified})`);

    // 4. cross-publish to Blogger / Dev.to (env-configured; inert when unset)
    let blog = null;
    try {
      const moltbookUrl = entry.post_id ? `https://www.moltbook.com/post/${entry.post_id}` : null;
      blog = await crossPost({ title, content, moltbookUrl, tags: llmTags, imageQuery: llmImageQuery });
    } catch (e) {
      blog = { enabled: true, results: [], error: String(e?.message || e).slice(0, 200) };
    }
    return { ok: true, ...entry, blog };
  } catch (err) {
    const entry = { at: new Date().toISOString(), title: forcedTopic || "(cycle)", submolt: typeof submolt !== "undefined" ? submolt : DEFAULT_SUBMOLT_FALLBACK, error: String(err?.message || err) };
    store.addPost(entry, 20);
    console.error("[post] failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// Submolt selection: the LLM picks the best-fit submolt per post from the
// LIVE list fetched via GET /submolts (public endpoint, TTL-cached in
// moltbook.js so a long-running container never goes stale). SUBMOLTS env
// restricts to a fixed set; DEFAULT_SUBMOLT is the fallback when the model's
// pick isn't in the live list (e.g. brand-new agent, restricted submolts).
const SUBMOLT_LIST = (process.env.SUBMOLTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_SUBMOLT_FALLBACK = process.env.DEFAULT_SUBMOLT || "selfhosted";

function normalizeSubmolt(raw, live) {
  const s = String(raw || "").trim().toLowerCase().replace(/^m\//, "").replace(/[^a-z0-9_-]/g, "");
  if (SUBMOLT_LIST.length) return SUBMOLT_LIST.includes(s) ? s : null;
  if (live && live.length) return live.some((x) => x.name === s) ? s : null;
  return s || null;
}

export { runCycle, store };