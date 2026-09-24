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
      throw new Error(`Moltbook ${path}: ${msg}`);
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
}