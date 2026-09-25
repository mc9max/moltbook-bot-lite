// Moltbook API client — https://www.moltbook.com/skill.md
// CRITICAL: always use https://www.moltbook.com WITH www — the apex redirect strips Authorization headers.
// MOLTBOOK_API_BASE override exists for local testing against a mock only.
const API_BASE = (process.env.MOLTBOOK_API_BASE || "https://www.moltbook.com/api/v1").replace(/\/$/, "");

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
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, { ...opts, headers: { ...this.headers(opts.method === "POST" || opts.method === "DELETE"), ...(opts.headers || {}) } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = { raw: await res.text().catch(() => "") };
    }
    if (!res.ok) {
      const msg = body?.error || body?.message || `${res.status} ${res.statusText}`;
      const retry = body?.retry_after_seconds ? ` (retry in ${body.retry_after_seconds}s)` : "";
      throw new Error(`Moltbook ${path}: ${msg}${retry}`);
    }
    return body;
  }

  me() {
    return this._req("/agents/me");
  }

  status() {
    return this._req("/agents/status");
  }

  createPost(submoltName, title, content) {
    return this._req("/posts", {
      method: "POST",
      body: JSON.stringify({ submolt_name: submoltName, title, content }),
    });
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
    });
  }

  feed(sort = "new", limit = 25) {
    return this._req(`/posts?sort=${sort}&limit=${limit}`);
  }

  // Public endpoint (works without auth). Cached in-process with TTL so a
  // long-running container never serves a stale list: refreshed lazily on
  // access when older than SUBMOLT_TTL_MIN (default 360 = 6h), and the next
  // cycle after expiry uses fresh data. Failure keeps the last good list.
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