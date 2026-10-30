// build-entry.js — bundle entry for the RAILWAY CRON path.
// Exports runCycle + store with NO Bun.serve and NO setInterval scheduler:
// Railway cron executes the start command and expects the process to exit.
// The dashboard + in-code scheduler remain in server.js (repo Dockerfile path
// used by template installs); this entry only feeds the cron bundle.

import { MoltbookClient } from "./moltbook.js";
import { generatePost, challengeCandidates } from "./llm.js";
import { loadProducts, store } from "./store.js";
import { pickTrendTopic, matchProduct, fetchHackerNewsPosts, syncCatalogFromRegistry } from "./topics.js";
import { pickInappItem, formatInappTopic, markInappAnnounced } from "./inapp.js";
import { writeFileSync } from "node:fs";
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
// Catalog may be extended in-cycle via PRODUCTS_REGISTRY_URL (see runCycle).
let catalog = PRODUCTS;

// Trend discovery is on by default: the cycle crawls the Moltbook feed (plus
// HN when TREND_SOURCES includes "hn") and steers the post at whatever's being
// discussed. Set TREND_SOURCES="" to restore pure product rotation.
const TREND_SOURCES = (process.env.TREND_SOURCES ?? "moltbook")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
// Optional: catalog self-update as new topics appear (e.g. a hosted
// registry.json listing x402.freeq.one tool entries). Unset = catalog stays
// exactly as PRODUCTS_JSON / /data/products.json provides it.
const PRODUCTS_REGISTRY_URL = process.env.PRODUCTS_REGISTRY_URL || "";

async function runCycle(explicitSubmolt, forcedTopic = null) {
  const s = store.get();
  let entryDebug = null;
  let forcedInappSlug = null;
  try {
    if (!configured) throw new Error("MOLTBOOK_API_KEY not set (must start with moltbook_)");

    // -1. optional catalog self-update from a hosted registry (best-effort).
    // As new tool entries appear there, they're validated, de-banned and
    // merged into the live catalog; with a writable volume they also persist
    // to /data/products.json. If PRODUCTS_JSON is set, env still wins on the
    // next process start — registry adoption is additive per-cycle only.
    if (PRODUCTS_REGISTRY_URL) {
      const sync = await syncCatalogFromRegistry(PRODUCTS_REGISTRY_URL, catalog);
      if (sync.error) {
        console.warn(`[catalog] registry sync failed: ${sync.error}`);
      } else if (sync.added.length) {
        console.log(`[catalog] adopted ${sync.added.length} new item(s): ${sync.added.map((x) => x.name).join(", ")}`);
        catalog = sync.merged;
        try {
          const DATA_DIR = process.env.DATA_DIR || "/data";
          writeFileSync(`${DATA_DIR}/products.json`, JSON.stringify(sync.merged, null, 1));
        } catch {}
      }
    }

    // -0.5 own-channel announcements: newest not-yet-announced item from our
    // blog / YouTube channel / GitHub org / Play Store listing. Beats trend
    // discovery; the slug is marked seen only after a successful post so a
    // failed generation retries next cycle. Never fails the cycle.
    if (!forcedTopic && process.env.INAPP_SOURCES !== "") {
      try {
        const { item } = await pickInappItem(store);
        if (item) {
          forcedTopic = formatInappTopic(item);
          forcedInappSlug = item.slug;
          console.log(`[inapp] announcing ${item.kind}: ${item.title} (${item.url})`);
        }
      } catch (e) {
        console.warn("[inapp] watcher failed, continuing:", e?.message || e);
      }
    }

    // -0. trend discovery: crawl the configured sources, pick the topic the
    // platform is actually discussing right now, and steer the post at it
    // (angling through a catalog product when one genuinely matches, a
    // generic builder-take when none does). Discovery failure must never
    // fail the cycle — fall through to normal product rotation.
    if (!forcedTopic && TREND_SOURCES.length) {
      try {
        const posts = [];
        if (TREND_SOURCES.includes("moltbook")) posts.push(...(await client.getFeed(40)));
        if (TREND_SOURCES.includes("hn")) posts.push(...(await fetchHackerNewsPosts()));
        const trend = pickTrendTopic(posts, s.recent_posts.map((p) => p.title));
        if (trend) {
          const match = matchProduct(trend.phrase, catalog);
          forcedTopic = match
            ? `${trend.phrase} — as told from the operator's seat of ${match.name}`
            : `${trend.phrase} — what agents shipping in this space should learn`;
          console.log(`[trend] "${trend.phrase}" (${trend.mentions} mentions across ${trend.sources} posts) -> ${match ? match.name : "no catalog match, generic angle"}`);
        }
      } catch (e) {
        console.warn("[trend] discovery failed, using normal rotation:", e?.message || e);
      }
    }

    // 0. live submolt list (TTL-cached; refreshes lazily so it never goes stale)
    const liveSubmolts = await client.listSubmolts();

    // 1. generate content via LLM
    const recentTitles = s.recent_posts.map((p) => p.title);
    const { title, content, submolt: llmSubmolt, tags: llmTags, imageQuery: llmImageQuery } = await generatePost({
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
      agentName: AGENT_NAME,
      products: catalog,
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

    // 3. solve anti-spam verification challenge if issued. Unverified content
    // stays HIDDEN on Moltbook (docs), challenges expire after 5 min, wrong
    // answers are non-terminal (the code stays usable until expiry) — BUT 10
    // consecutive failed attempts auto-suspend the account, so we cap at 2
    // submits per cycle: deterministic arithmetic first, then the LLM read.
    let verified = false;
    let vAttempts = 0;
    const verification = res?.post?.verification || res?.verification || null;
    if (verification?.challenge_text) {
      const code = verification.verification_code || verification?.post?.verification_code;
      const expires = Date.parse(verification.expires_at) || Date.now() + 4.5 * 60000;
      const { candidates } = await challengeCandidates({
        baseUrl: LLM_BASE_URL,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
        challengeText: verification.challenge_text,
        instructions: verification.instructions || "",
      });
      for (const answer of candidates.slice(0, 2)) {
        if (vAttempts >= 2 || Date.now() > expires - 15e3) break;
        vAttempts++;
        try {
          const vres = await client.submitVerification(code, answer);
          if (vres?.success) { verified = true; break; }
          entryDebug = `attempt ${vAttempts} answer="${answer}" rejected (${String(vres?.error || "failed").slice(0, 60)})`;
        } catch (e) {
          entryDebug = `attempt ${vAttempts} error=${String(e?.message || e).slice(0, 80)}`;
          if (e?.status === 410 || e?.status === 409) break; // expired/used — retries pointless
        }
      }
    }

    const entry = {
      at: new Date().toISOString(),
      title,
      submolt,
      post_id: res?.post?.id || null,
      verification_status: verification ? (verified ? "verified" : "failed") : "none",
      ...(vAttempts ? { verification_attempts: vAttempts } : {}),
      ...(entryDebug ? { debug: entryDebug } : {}),
    };
    store.addPost(entry, 20);
    if (forcedInappSlug) markInappAnnounced(store, forcedInappSlug);
    console.log(`[post] ${title} -> m/${submolt} (verified=${verified}, attempts=${vAttempts})`);

    // 4. cross-publish to Blogger / Dev.to (env-configured; inert when unset).
    // A challenge-issued post that failed verification is HIDDEN on Moltbook —
    // don't publish blog copies that point readers at an invisible post.
    let blog = null;
    try {
      if (verification && !verified) {
        blog = { skipped: "moltbook post unverified (hidden) — crosspost withheld" };
        console.warn("[blog] crosspost withheld: moltbook post is unverified/hidden");
      } else {
        const moltbookUrl = entry.post_id ? `https://www.moltbook.com/post/${entry.post_id}` : null;
        blog = await crossPost({ title, content, moltbookUrl, tags: llmTags, imageQuery: llmImageQuery });
      }
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