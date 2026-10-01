// Blog cross-publishing — mirror each Moltbook post to Blogger and Dev.to.
//
// Enabled purely via env vars; when none are set, publishers are inert and
// report { enabled: false } so the bot loop is untouched.
//
// Blogger: Google OAuth2 refresh token flow. The refresh_token must be obtained
// ONCE out-of-band (see the blog-publishing skill's OAuth script — access_type=offline
// + prompt=consent). This module only refreshes access tokens at publish time.
// Needs: BLOGGER_CLIENT_ID, BLOGGER_CLIENT_SECRET, BLOGGER_REFRESH_TOKEN,
//        BLOGGER_BLOG_ID (numeric). Optional: BLOGGER_LABELS (comma list),
//        (Blogger has no API draft creation — posts go live immediately.)
//
// Dev.to: Forem API key from https://dev.to/settings/extensions → "DEV Community API Keys".
// Needs: DEVTO_API_KEY. Optional: DEVTO_TAGS (comma list, max 4 — API hard-rejects 5+),
//        DEVTO_PUBLISHED=0 to save as draft (default: publish immediately),
//        DEVTO_ORGANIZATION (optional org slug). The canonical_url is set to the
//        first successful platform URL so SEO credits the origin.
//
// Common: BLOG_CROSSPOST=0 disables everything even when creds are present.
// DRY_RUN=1 keeps blogs out of the loop entirely (consistent with Moltbook skip).

import { setTimeout as sleep } from "node:timers/promises";

const env = (k, d = "") => (process.env[k] ?? d).trim();

const CROSSPOST_ENABLED = env("BLOG_CROSSPOST", "1") !== "0";
const DRY_RUN = process.env.DRY_RUN === "1";

// --- hero image --------------------------------------------------------------
// Per-post stock-photo hero, mirroring ~/Work/recipe-auto-blogger's flow:
// LLM picks an imageQuery → Pixabay (primary) / Pexels (fallback) search →
// download → rehost to catbox.moe (hotlink-safe, permanent) → hero URL.
// Blogger: leading <figure>; dev.to: article.main_image.
// Needs: PIXABAY_API_KEY and/or PEXELS_API_KEY. Set BLOG_HERO_STOCK=0 to
// disable the stock pipeline; per-call { heroImage } still overrides; a
// BLOG_HERO_IMAGES pool (if set) takes priority over stock search.

async function searchPixabay(key, query) {
  const u = new URL("https://pixabay.com/api/");
  u.searchParams.set("key", key);
  u.searchParams.set("q", query);
  u.searchParams.set("image_type", "photo");
  u.searchParams.set("safesearch", "true");
  u.searchParams.set("per_page", "3");
  u.searchParams.set("order", "popular");
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`pixabay ${r.status}`);
  const d = await r.json();
  return (d.hits || []).map(h => h.largeImageURL || h.webformatURL).filter(Boolean);
}

async function searchPexels(key, query) {
  const u = new URL("https://api.pexels.com/v1/search");
  u.searchParams.set("query", query);
  u.searchParams.set("per_page", "3");
  const r = await fetch(u, { headers: { Authorization: key }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`pexels ${r.status}`);
  const d = await r.json();
  return (d.photos || []).map(p => p?.src?.large2x || p?.src?.large).filter(Boolean);
}

// Rehost a downloaded image to catbox.moe (same channel as Railway template
// icons). Catbox allows direct hotlinking and never expires — unlike Pixabay
// CDN URLs which rotate and break embedded posts.
async function catboxUpload(buf, filename) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", new Blob([buf], { type: "image/jpeg" }), filename);
  const r = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`catbox ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const url = (await r.text()).trim();
  if (!/^https:\/\/files\.catbox\.moe\//.test(url)) throw new Error(`catbox unexpected: ${url.slice(0, 120)}`);
  return url;
}

// Downloads the top stock result (recipe-bot: resize to <=800px, JPEG q85 —
// Blogger thumbnails need <300KB). Uses sharp-free pure-JS path via canvas is
// unavailable; images from Pixabay 'large' URLs are already <=1280px and well
// under the limit after their CDN compression.
async function fetchStockHero(imageQuery) {
  const q = String(imageQuery || "").trim();
  if (!q || env("BLOG_HERO_STOCK") === "0") return null;
  const pixKey = env("PIXABAY_API_KEY");
  const pexKey = env("PEXELS_API_KEY");
  if (!pixKey && !pexKey) return null;

  let urls = [];
  const errs = [];
  if (pixKey) { try { urls = await searchPixabay(pixKey, q); } catch (e) { errs.push(String(e.message || e)); } }
  if (!urls.length && pexKey) { try { urls = await searchPexels(pexKey, q); } catch (e) { errs.push(String(e.message || e)); } }
  if (!urls.length) {
    // broader retry like recipe-bot: first two words
    const broad = q.split(/\s+/).slice(0, 2).join(" ");
    if (broad && broad !== q) {
      if (pixKey) { try { urls = await searchPixabay(pixKey, broad); } catch { /* ignore */ } }
      if (!urls.length && pexKey) { try { urls = await searchPexels(pexKey, broad); } catch { /* ignore */ } }
    }
  }
  if (!urls.length) {
    console.warn(`[hero] no stock photo for "${q}"${errs.length ? ` (${errs.join("; ")})` : ""}`);
    return null;
  }

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5000 || buf.length > 5_000_000) continue; // sanity bounds
      const name = `moltbook-hero-${Date.now()}.jpg`;
      const hosted = await catboxUpload(buf, name);
      console.log(`[hero] "${q}" -> ${hosted} (${Math.round(buf.length / 1024)}KB)`);
      return hosted;
    } catch (e) {
      console.warn(`[hero] candidate failed: ${e?.message || e}`);
    }
  }
  return null;
}

let heroIdx = 0;
function pickHeroImage(override = null) {
  if (override) return String(override).trim();
  if (env("BLOG_HERO_APPEND") === "0") return null;
  const pool = env("BLOG_HERO_IMAGES").split(",").map(s => s.trim()).filter(Boolean);
  if (!pool.length) return null;
  const url = pool[heroIdx % pool.length];
  heroIdx++;
  return url;
}

// --- config -----------------------------------------------------------------

export const bloggerConfig = () => ({
  clientId: env("BLOGGER_CLIENT_ID"),
  clientSecret: env("BLOGGER_CLIENT_SECRET"),
  refreshToken: env("BLOGGER_REFRESH_TOKEN"),
  blogId: env("BLOGGER_BLOG_ID"),
  labels: env("BLOGGER_LABELS").split(",").map(s => s.trim()).filter(Boolean),
  // Kept for backward compatibility; Blogger API v3 cannot create drafts.
  isDraft: env("BLOGGER_IS_DRAFT") === "1",
});

export const devtoConfig = () => ({
  apiKey: env("DEVTO_API_KEY"),
  tags: env("DEVTO_TAGS").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 4),
  published: env("DEVTO_PUBLISHED", "1") !== "0",
  organization: env("DEVTO_ORGANIZATION"),
  apiBase: env("DEVTO_API_BASE", "https://dev.to/api").replace(/\/$/, ""),
});

export function bloggerEnabled() {
  const c = bloggerConfig();
  return CROSSPOST_ENABLED && !!(c.clientId && c.clientSecret && c.refreshToken && c.blogId);
}

export function devtoEnabled() {
  const c = devtoConfig();
  return CROSSPOST_ENABLED && !!c.apiKey;
}

export function anyBlogEnabled() {
  if (DRY_RUN) return false;
  return bloggerEnabled() || devtoEnabled();
}

// --- markdown conversion ----------------------------------------------------

// LLM post content is markdown (Blogger wants HTML, Dev.to wants markdown).
// No dependency: convert the subset the LLM system prompt allows — headings,
// paragraphs, bold/italic, inline code, fenced code, lists, links. Unknown
// syntax falls through as plain text, which is safe for prose posts.
function markdownToHtml(md) {
  let s = String(md || "");
  // fenced code blocks first (protect from inline rules)
  const blocks = [];
  s = s.replace(/```([a-z0-9]*)\n([\s\S]*?)```/gi, (_, lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  // headings
  s = s.replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>");
  // bold, italic, inline code, links.
  // Inline code and [text](url) links are captured to placeholders BEFORE the
  // bare-URL autolinker runs, so URLs inside <code> or inside an existing
  // anchor never get double-wrapped in nested <a> tags.
  const prot = [];
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => (prot.push(`<img src="${url}" alt="${alt}" />`), `\u0000P${prot.length - 1}\u0000`))
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, (_, c) => (prot.push(`<code>${c}</code>`), `\u0000P${prot.length - 1}\u0000`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt, url) => (prot.push(`<a href="${url}">${txt}</a>`), `\u0000P${prot.length - 1}\u0000`))
    // bare URLs -> hyperlinks (trailing punctuation kept outside the anchor,
    // matching dev.to's native autolink behaviour)
    .replace(/https?:\/\/[^\s<>"']+/g, (m) => {
      const trail = (m.match(/[.,;:!?)\]]+$/) || [""])[0];
      const url = trail ? m.slice(0, -trail.length) : m;
      return `<a href="${url}">${url}</a>${trail}`;
    });
  s = s.replace(/\u0000P(\d+)\u0000/g, (_, i) => prot[Number(i)]);
  // lists
  s = s.replace(/^(?:- (.*)\n?)+/gm, (m) => {
    const items = m.trim().split("\n").map((l) => `<li>${l.replace(/^- /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  // paragraphs: split on blank lines, wrap leftover text blocks
  s = s.split(/\n{2,}/).map((chunk) => {
    const t = chunk.trim();
    if (!t) return "";
    return /^<(h[1-4]|ul|pre|blockquote)/.test(t) ? t : `<p>${t.replace(/\n/g, "<br/>")}</p>`;
  }).join("\n");
  // restore code blocks
  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return s;
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- poster -----------------------------------------------------------------

async function withRetries(label, fn, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      // Blogger 429 rate-limit: growing backoff; other errors: short backoff + retry once-ish
      const wait = msg.includes("rateLimitExceeded") ? [15_000, 30_000, 60_000][i] : 5_000 * (i + 1);
      console.warn(`[blog:${label}] attempt ${i + 1}/${attempts} failed: ${msg} — retrying in ${wait / 1000}s`);
      if (i + 1 < attempts) await sleep(wait);
    }
  }
  throw lastErr;
}

let bloggerAccessToken = null;
let bloggerTokenExpires = 0;

async function bloggerAccessTokenFetch() {
  if (bloggerAccessToken && Date.now() < bloggerTokenExpires - 60_000) return bloggerAccessToken;
  const c = bloggerConfig();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Blogger token refresh ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  bloggerAccessToken = j.access_token;
  bloggerTokenExpires = Date.now() + (j.expires_in || 3600) * 1000;
  return bloggerAccessToken;
}

async function publishBlogger(title, markdownContent, canonicalUrl, contentTags = [], heroImage = null) {
  const c = bloggerConfig();
  const token = await bloggerAccessTokenFetch();
  const hero = pickHeroImage(heroImage);
  const heroHtml = hero
    ? `<figure><img src="${escapeHtml(hero)}" alt="${escapeHtml(title)}" /></figure>\n`
    : "";
  const html = heroHtml + markdownToHtml(markdownContent) + (canonicalUrl ? `<p><i>Originally posted by an AI agent on Moltbook.</i></p>` : "");
  // Blogger labels = content-derived tags + static BLOGGER_LABELS + the
  // mandatory "blog" tag (user directive). "blog" is inserted FIRST and the
  // cap applied after, so later content tags can never push it out.
  const labels = [...new Set([
    "blog",
    ...contentTags.map(t => String(t).trim())
      .filter(t => t && !/^(crypto|x402|usdc|blockchain|payment)$/i.test(t)),
    ...c.labels,
  ])].filter(Boolean).slice(0, 8);
  return withRetries("blogger", async () => {
    const res = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(c.blogId)}/posts/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "blogger#post",
        title,
        content: html,
        ...(labels.length ? { labels } : {}),
        // NOTE: the Blogger API v3 cannot create drafts (posts.insert always
        // publishes; isDraft is read-only) — posts go live immediately.
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Blogger create ${res.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    return { url: j.url || `https://www.blogger.com/blogger.g?blogID=${c.blogId}`, id: j.id };
  });
}

async function publishDevto(title, markdownContent, canonicalUrl, contentTags = [], heroImage = null) {
  const c = devtoConfig();
  const hero = pickHeroImage(heroImage);
  // Dev.to tags: lowercase alnum only (hyphens stripped), max 4 — the API
  // hard-rejects 5+ ("Tag list exceed the maximum of 4 tags"). Topical tags
  // from the LLM take priority; static DEVTO_TAGS fill the remaining slots.
  // Crypto keywords stripped safety-net style (LLM prompt also forbids them).
  const scrub = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
  const tags = [...new Set([
    ...contentTags.map(scrub).filter(t => t && !/^(crypto|x402|usdc|blockchain|payment)$/.test(t)),
    ...c.tags.map(scrub).filter(t => t && !/^(crypto|x402|usdc|blockchain|payment)$/.test(t)),
  ])].slice(0, 4);
  return withRetries("devto", async () => {
    const res = await fetch(`${c.apiBase}/articles`, {
      method: "POST",
      headers: { "api-key": c.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        article: {
          title,
          body_markdown: String(markdownContent || "").trim(),
          ...(hero ? { main_image: hero } : {}),
          published: c.published,
          tags,
          ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
          ...(c.organization ? { organization_id: c.organization } : {}),
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Dev.to create ${res.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    return { url: j.url || j.page?.url, id: String(j.id) };
  });
}

// Cross-post to every enabled platform. Returns per-platform results; a failure
// on one platform never blocks the other (Moltbook post already succeeded).
export async function crossPost({ title, content, moltbookUrl, tags = [], imageQuery = null, heroImage = null }) {
  if (!anyBlogEnabled()) return { enabled: false, results: [] };
  const results = [];
  // Hero resolution order: explicit override > BLOG_HERO_IMAGES pool (round-robin)
  // > per-post stock search (LLM imageQuery). At most one is used per post.
  let hero = pickHeroImage(heroImage);
  if (!hero) {
    try { hero = await fetchStockHero(imageQuery); } catch (e) { console.warn("[hero] stock lookup failed:", e?.message || e); }
  }
  if (bloggerEnabled()) {
    try {
      const r = await publishBlogger(title, content, moltbookUrl, tags, hero);
      results.push({ platform: "blogger", ok: true, url: r.url, id: r.id });
      console.log(`[blog:blogger] ${title} -> ${r.url}`);
    } catch (e) {
      results.push({ platform: "blogger", ok: false, error: String(e?.message || e).slice(0, 300) });
      console.error("[blog:blogger] failed:", e?.message || e);
    }
  }
  if (devtoEnabled()) {
    try {
      // canonical_url prefers Blogger (self-hosted origin of record).
      const canon = results.find(r => r.ok && r.platform === "blogger")?.url || moltbookUrl || null;
      const r = await publishDevto(title, content, canon, tags, hero);
      results.push({ platform: "devto", ok: true, url: r.url, id: r.id });
      console.log(`[blog:devto] ${title} -> ${r.url}`);
    } catch (e) {
      results.push({ platform: "devto", ok: false, error: String(e?.message || e).slice(0, 300) });
      console.error("[blog:devto] failed:", e?.message || e);
    }
  }
  return { enabled: true, results };
}