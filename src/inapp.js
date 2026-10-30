// inapp.js — announcement watcher for our own shipping channels.
// Checked in priority order before trend discovery; the newest item not yet
// announced wins. The "seen" ledger persists in /data/state.json (store) so
// items are announced exactly once across cron runs; items whose post failed
// generation are NOT marked and retry next cycle.
//
// Source kinds (enable/disable via INAPP_SOURCES, comma-separated; "" = off):
//   blog    — ATOM feed (imapp.blogspot.com), newest post within age cutoff
//   youtube — ATOM feed (YouTube channel uploads), newest video
//   github  — newest created repo (templates ship as a new repo per template)
//
// Moltbook hard-bans crypto/payment mentions (llm.js system prompt), so any
// item whose title/name contains x402/402/payment/usdc/crypto is skipped
// outright — the name would leak into the generated post.

const BLOG_FEED = process.env.BLOG_FEED_URL || "https://imapp.blogspot.com/feeds/posts/default?max-results=8";
const YOUTUBE_FEED = process.env.YOUTUBE_FEED_URL || "https://www.youtube.com/feeds/videos.xml?channel_id=UC1R5ZxoeG81sIyW8mpjJdTg";
const GITHUB_OWNER = process.env.GITHUB_INAPP_ORG || "mc9max";
const MAX_AGE_MS = (parseInt(process.env.INAPP_MAX_AGE_HOURS || "36", 10) || 36) * 3600e3;
const SOURCES = (process.env.INAPP_SOURCES ?? "blog,youtube,github")
  .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

const UA = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/126 Safari/537.36", Accept: "*/*" };
const BANNED = /x402|402|payment|paying|usdc|crypto|blockchain/i;

const decodeEntities = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();

async function fetchText(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// Minimal ATOM entry extraction (no XML dependency; feeds are simple and ours).
function parseAtom(xml, kind) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = decodeEntities(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
    const link = decodeEntities(e.match(/<link[^>]*href="([^"]+)"/)?.[1] || "");
    const published = e.match(/<(?:published|updated)>([\s\S]*?)<\/(?:published|updated)>/)?.[1];
    const videoId = e.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1]?.trim();
    if (!title) continue;
    out.push({
      kind,
      slug: videoId || link || title,
      title,
      url: link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ""),
      published: published ? Date.parse(published) || null : null,
    });
  }
  return out;
}

async function fetchBlog() {
  const xml = await fetchText(BLOG_FEED);
  return parseAtom(xml, "blog")
    .map((x) => ({ ...x, blurb: "new post published on our engineering blog" }));
}

async function fetchYouTube() {
  const xml = await fetchText(YOUTUBE_FEED);
  return parseAtom(xml, "youtube")
    .map((x) => ({ ...x, blurb: "video walkthrough just went up on our channel" }));
}

async function fetchGitHub() {
  let repos = null;
  // the owner may be an org or a user account; try org first (404 = not an org)
  for (const path of ["orgs", "users"]) {
    try {
      repos = JSON.parse(await fetchText(`https://api.github.com/${path}/${GITHUB_OWNER}/repos?sort=created&per_page=20`));
      if (Array.isArray(repos)) break;
    } catch (e) {
      if (path === "users" || !/404/.test(String(e?.message || e))) throw e;
    }
  }
  if (!Array.isArray(repos)) throw new Error("unexpected GitHub response");
  return repos
    .filter((r) => !r.fork)
    .map((r) => ({
      kind: "github",
      slug: r.full_name,
      title: r.name,
      url: r.html_url,
      published: r.created_at ? Date.parse(r.created_at) : null,
      blurb: r.description ? decodeEntities(r.description) : "a new repo went up",
    }));
}

const FETCHERS = { blog: fetchBlog, youtube: fetchYouTube, github: fetchGitHub };
// null-age items sort as freshest of their group; otherwise newest first
const byFreshness = (a, b) => {
  const ta = a.published ?? Date.now() + 1;
  const tb = b.published ?? Date.now() + 1;
  return tb - ta;
};

export function formatInappTopic(item) {
  const lead =
    item.kind === "github" ? "Just shipped a new one-click deploy template"
    : item.kind === "blog" ? "Published a new write-up"
    : "Released a new video walkthrough";
  const blurb = item.blurb ? `. ${item.blurb}` : "";
  return (
    `${lead}: ${item.title}${blurb}. ` +
    `Write an engineer's story about what went into it (why it exists, one concrete detail of how it works, one thing it costs the operator) ` +
    `and mention this URL naturally exactly once: ${item.url}`
  );
}

// Returns { item, seenSlugs } for the item to announce now, or { item: null }.
export async function pickInappItem(store) {
  const seen = store.get().inapp_seen || {};
  const now = Date.now();
  const fresh = [];
  for (const kind of SOURCES) {
    try {
      const raw = await FETCHERS[kind]();
      fresh.push(...raw);
    } catch (e) {
      console.warn(`[inapp] source ${kind} failed (skipped): ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  // items must be within the age cutoff so a dead ledger can't resurrect
  // ancient posts
  const candidates = fresh
    .filter((x) => x.url && !BANNED.test(`${x.title} ${x.slug}`))
    .filter((x) => (Math.abs(x.published) || 0) > now - MAX_AGE_MS)
    .filter((x) => !seen[x.slug])
    .sort(byFreshness);

  const item = candidates[0] || null;
  return { item, seenSlugs: Object.keys(seen) };
}

export function markInappAnnounced(store, slug) {
  try {
    store.update((s) => {
      s.inapp_seen = { ...(s.inapp_seen || {}), [slug]: new Date().toISOString() };
      // cap the ledger at 200 entries (oldest dropped) so state.json stays small
      const entries = Object.entries(s.inapp_seen).sort((a, b) => (a[1] < b[1] ? -1 : 1));
      if (entries.length > 200) s.inapp_seen = Object.fromEntries(entries.slice(-200));
    });
  } catch (e) {
    console.warn(`[inapp] could not mark slug seen: ${String(e?.message || e).slice(0, 120)}`);
  }
}

export const inappDebug = { SOURCES, BLOG_FEED, YOUTUBE_FEED, GITHUB_OWNER };