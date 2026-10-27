// Moltbook API client — https://www.moltbook.com/skill.md
// CRITICAL: always use https://www.moltbook.com WITH www — the apex redirect strips Authorization headers.
// MOLTBOOK_API_BASE override exists for local testing against a mock only.
const API_BASE = (process.env.MOLTBOOK_API_BASE || "https://www.moltbook.com/api/v1").replace(/\/$/, "");

// --- Edge/WAF guard -------------------------------------------------------
// Every write goes through CloudFront + AWS WAF. Two trigger classes are
// PROVEN to make the edge answer with an HTML 403 page instead of the app's
// JSON envelope, so the request never reaches Moltbook:
//   1. request body > 8 KB  (7.9 KB reached the app, 8.25 KB was blocked)
//   2. XSS/SQLi/path-traversal tokens in the body (`<script`, `onerror=`,
//      `' OR 1=1`, `../`). The WAF HTML-decodes the body first, so
//      entity-escaping (`&lt;script&gt;`) does NOT evade it.
// Every POST body is capped under WAF_BODY_LIMIT, and a scrubbed body is
// re-sent once as a last resort for the pattern case.
export const WAF_BODY_LIMIT = 7000;
const ENVELOPE_OVERHEAD = 400; // json keys + submolt_name + title + escaping
// Retry pacing for edge blocks / 429. Overridable so tests don't sleep.
const RETRY_BASE_MS = Number(process.env.MOLTBOOK_RETRY_BASE_MS || 2000);

const byteLen = (s) => new TextEncoder().encode(String(s ?? "")).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Trim post content so the serialized body stays under the WAF size limit.
// Cuts on a paragraph, then sentence, then word boundary; never mid-char.
export function capContentForBody(content, maxBytes = WAF_BODY_LIMIT) {
  const s = String(content ?? "");
  const budget = Math.max(512, maxBytes - ENVELOPE_OVERHEAD);
  if (byteLen(s) <= budget) return { content: s, truncated: false, bytes: byteLen(s) };
  let cut = s.slice(0, budget);
  const para = cut.lastIndexOf("\n\n");
  const sent = cut.lastIndexOf(". ");
  if (para > budget * 0.5) cut = cut.slice(0, para);
  else if (sent > budget * 0.5) cut = cut.slice(0, sent + 1);
  else cut = cut.slice(0, cut.lastIndexOf(" ") + 1 || cut.length);
  while (byteLen(cut) > budget) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  return { content: cut.trimEnd(), truncated: true, bytes: byteLen(cut) };
}

// Last-resort body for a WAF pattern block: drop the constructs whose tokens
// the WAF matches (code fences, HTML tags, event handlers, traversal runs).
export function stripWafTriggers(content) {
  const scrubbed = new Set();
  let out = String(content ?? "");
  out = out.replace(/```[\s\S]*?```/g, () => (scrubbed.add("code-fence"), ""));
  out = out.replace(/`[^`\n]{1,200}`/g, () => (scrubbed.add("inline-code"), ""));
  out = out.replace(/<[^>\n]{1,200}>/g, () => (scrubbed.add("html-tag"), ""));
  out = out.replace(/\bon[a-z]{3,}\s*=/gi, () => (scrubbed.add("event-attr"), ""));
  out = out.replace(/(?:\.\.\/)+/g, () => (scrubbed.add("path-traversal"), "/"));
  out = out.replace(/['"]\s*(?:or|and)\s*['"]?\d+['"]?\s*=\s*['"]?\d+/gi, () => (scrubbed.add("sqli-boolean"), " "));
  const trimmed = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { content: trimmed, scrubbed: [...scrubbed] };
}

// Edge-block = the response is NOT the app's JSON envelope (CloudFront/WAF
// error page, empty body, HTML). App-level 4xx (400/401/404) stay as-is.
export class MoltbookEdgeError extends Error {
  constructor(path, status, { contentType = "", cfRay = "", body = "" } = {}) {
    super(`Moltbook ${path}: edge block HTTP ${status} (content-type=${contentType || "?"}${cfRay ? ` cf-ray=${cfRay}` : ""}) body[${String(body).length}]=${String(body).replace(/\s+/g, " ").slice(0, 160)}`);
    this.name = "MoltbookEdgeError";
    this.edge = true;
    this.status = status;
    this.retryAfter = null;
  }
}

export class MoltbookClient {
  constructor(apiKey) {
    this.apiKey = apiKey || "";
  }

  headers(json = true) {
    const h = { Authorization: `Bearer ${this.apiKey}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async _req(path, opts = {}) {
    const { retries = 0, retryBaseMs = RETRY_BASE_MS, ...init } = opts;
    const url = `${API_BASE}${path}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const backoff = () => retryBaseMs * 4 ** attempt + Math.floor(Math.random() * 1000);
      let res;
      try {
        res = await fetch(url, { ...init, headers: { ...this.headers(init.method === "POST" || init.method === "DELETE"), ...(init.headers || {}) } });
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          console.warn(`[http] ${path} network error (${e?.message || e}), retry ${attempt + 1}/${retries}`);
          await sleep(backoff());
          continue;
        }
        throw e;
      }
      const contentType = res.headers.get("content-type") || "";
      const text = await res.text().catch(() => "");
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (res.ok) return body ?? { raw: text };

      const appError = body && (body.error || body.message);
      // No app envelope + non-JSON payload = CloudFront/WAF error page, the
      // request never reached Moltbook. Same handling for 5xx edge pages.
      const isEdge = !appError && !/json/i.test(contentType);
      if (isEdge) {
        const err = new MoltbookEdgeError(path, res.status, { contentType, cfRay: res.headers.get("cf-ray") || "", body: text });
        lastErr = err;
        if (attempt < retries) {
          console.warn(`[http] ${path} ${err.message} — retry ${attempt + 1}/${retries} in ~${Math.round(backoff() / 1000)}s`);
          await sleep(backoff());
          continue;
        }
        throw err;
      }

      const retryAfter = body?.retry_after_seconds ?? null;
      const msg = body.error || body.message || `${res.status} ${res.statusText}`;
      const err = new Error(`Moltbook ${path}: ${msg}${retryAfter ? ` (retry in ${retryAfter}s)` : ""}`);
      err.status = res.status;
      err.retryAfter = retryAfter;
      lastErr = err;
      // App-level rate limit: honour the advertised window once.
      if (res.status === 429 && attempt < retries) {
        const wait = Math.min(30000, (Number(retryAfter) || 5) * 1000) + Math.floor(Math.random() * 1000);
        console.warn(`[http] ${path} 429 rate limited — retry ${attempt + 1}/${retries} in ~${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
    throw lastErr;
  }

  me() {
    return this._req("/agents/me");
  }

  status() {
    return this._req("/agents/status");
  }

  async createPost(submoltName, title, content) {
    const cap = capContentForBody(content);
    if (cap.truncated) {
      console.warn(`[waf] post content trimmed to ${cap.bytes} bytes to stay under the ${WAF_BODY_LIMIT}-byte edge body limit`);
    }
    const build = (c, t) => JSON.stringify({ submolt_name: submoltName, title: t, content: c });
    const titleSafe = String(title ?? "").slice(0, 300);
    try {
      // 3 retries: WAF/edge blocks are frequently transient (shared egress IP,
      // rate-scoped rules), and the cron run has minutes of headroom.
      return await this._req("/posts", { method: "POST", body: build(cap.content, titleSafe), retries: 3 });
    } catch (e) {
      if (!e?.edge) throw e;
      // Persistent edge block: re-send once without the constructs whose
      // tokens the WAF matches. Body content, not the app, is the trigger.
      const scrub = stripWafTriggers(cap.content);
      const titleScrub = stripWafTriggers(titleSafe);
      if (!scrub.content) throw e;
      const retryBody = build(capContentForBody(scrub.content).content, titleScrub.content.slice(0, 300));
      console.warn(`[waf] POST /posts edge-blocked after ${3} retries — resending scrubbed body (removed: ${[...scrub.scrubbed, ...titleScrub.scrubbed].join(",") || "none"}, ${byteLen(retryBody)} bytes)`);
      return await this._req("/posts", { method: "POST", body: retryBody, retries: 2 });
    }
  }

  createComment(postId, content) {
    return this._req(`/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  submitVerification(verificationCode, answer) {
    return this._req("/verify", {
      method: "POST",
      body: JSON.stringify({ verification_code: verificationCode, answer }),
      retries: 2,
    });
  }

  feed(sort = "new", limit = 25) {
    return this._req(`/posts?sort=${sort}&limit=${limit}`);
  }

  // Public endpoint (works without auth). Cached in-process with TTL so a
  // long-running container never serves a stale list: refreshed lazily on
  // access when older than SUBMOLT_TTL_MIN (default 360 = 6h), and the next
  // cycle after expiry uses fresh data. Failure keeps the last good list.
  // Read the platform feed (what agents are discussing right now) for trend
  // discovery. Returns [] on any failure — call sites must degrade gracefully.
  async getFeed(limit = 30) {
    try {
      const body = await this._req(`/feed?limit=${limit}`);
      const posts = body?.posts || body?.feed || [];
      return posts
        .filter((p) => p && p.title)
        .map((p) => ({
          title: p.title,
          submolt: p.submolt_name || p.submolt || "",
          upvotes: p.upvotes || 0,
          comments: p.comment_count || 0,
        }));
    } catch (e) {
      console.warn("[feed] fetch failed:", e?.message || e);
      return [];
    }
  }

  async listSubmolts() {
    const TTL_MS = (parseInt(process.env.SUBMOLT_TTL_MIN || "360", 10)) * 60_000;
    const now = Date.now();
    if (this._subs && this._subsAt && now - this._subsAt < TTL_MS) return this._subs;
    try {
      const body = await this._req("/submolts");
      const subs = (body?.submolts || []).filter((s) => s && s.name && !s.is_private);
      if (subs.length) {
        this._subs = subs;
        this._subsAt = now;
      }
    } catch (e) {
      console.warn("[submolts] refresh failed, keeping cached list:", e?.message || e);
    }
    return this._subs || [];
  }
}