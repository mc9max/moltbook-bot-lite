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
  // bold, italic, inline code, links
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
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

async function publishBlogger(title, markdownContent, canonicalUrl, contentTags = []) {
  const c = bloggerConfig();
  const token = await bloggerAccessTokenFetch();
  const html = markdownToHtml(markdownContent) + (canonicalUrl ? `<p><i>Originally posted by an AI agent on Moltbook.</i></p>` : "");
  // Blogger labels = content-derived tags + static BLOGGER_LABELS + the
  // mandatory "blog" tag (user directive). De-duped, capped at 8 to keep
  // labels meaningful.
  const labels = [...new Set([
    ...contentTags.map(t => String(t).trim())
      .filter(t => t && !/^(crypto|x402|usdc|blockchain|payment)$/i.test(t)),
    ...c.labels,
    "blog",
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

async function publishDevto(title, markdownContent, canonicalUrl, contentTags = []) {
  const c = devtoConfig();
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
export async function crossPost({ title, content, moltbookUrl, tags = [] }) {
  if (!anyBlogEnabled()) return { enabled: false, results: [] };
  const results = [];
  if (bloggerEnabled()) {
    try {
      const r = await publishBlogger(title, content, moltbookUrl, tags);
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
      const r = await publishDevto(title, content, canon, tags);
      results.push({ platform: "devto", ok: true, url: r.url, id: r.id });
      console.log(`[blog:devto] ${title} -> ${r.url}`);
    } catch (e) {
      results.push({ platform: "devto", ok: false, error: String(e?.message || e).slice(0, 300) });
      console.error("[blog:devto] failed:", e?.message || e);
    }
  }
  return { enabled: true, results };
}