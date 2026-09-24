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
  const posts = JSON.stringify(s.recent_posts || []).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Moltbook Bot Lite</title>
<style>body{font-family:system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;background:#0f1117;color:#e6e6e6}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{padding:.4rem .6rem;border-bottom:1px solid #2a2d3a;text-align:left}
th{cursor:pointer;user-select:none;white-space:nowrap}th:hover{color:#ff6a3d}th .arrow{font-size:.7rem;opacity:.7}
.k{color:#ff6a3d;font-weight:700}code{background:#1a1d29;padding:.1rem .35rem;border-radius:4px}
.toolbar{display:flex;gap:.6rem;align-items:center;margin:.6rem 0;flex-wrap:wrap}
input[type=search]{background:#1a1d29;color:#e6e6e6;border:1px solid #2a2d3a;border-radius:6px;padding:.4rem .6rem;width:240px}
button{background:#1a1d29;color:#e6e6e6;border:1px solid #2a2d3a;border-radius:6px;padding:.3rem .7rem;cursor:pointer}
button:hover{border-color:#ff6a3d}.pager{font-variant-numeric:tabular-nums}
.err{color:#ff7b7b}.ok{color:#7bd88f}.dim{color:#8b8fa3}
td.time{white-space:nowrap;color:#8b8fa3}</style></head><body>
<h1><span class="k">🦞</span> Moltbook Bot Lite</h1>
<p>Agent: <code>${esc(AGENT_NAME)}</code> · Configured: <b>${configured}</b> · Posts every <b>${POST_INTERVAL_MIN} min</b> · Dry-run: <b>${DRY_RUN}</b> · Next run: <b class="humantime" data-ts="${new Date(nextRun).toISOString()}"></b></p>
<p>Templates marketed: ${TEMPLATES.map((t) => `<code>${esc(t.name)}</code>`).join(", ")}</p>
<h2>Posts</h2>
<div class="toolbar">
  <input id="q" type="search" placeholder="Search title, submolt, status…">
  <span class="dim" id="count"></span>
  <span style="flex:1"></span>
  <button id="prev">‹ Prev</button><span class="pager" id="pageinfo"></span><button id="next">Next ›</button>
</div>
<table id="tbl"><thead><tr>
<th data-k="at">Time <span class="sort"></span></th>
<th data-k="submolt">Submolt <span class="sort"></span></th>
<th data-k="title">Title <span class="sort"></span></th>
<th data-k="state">Status <span class="sort"></span></th>
</tr></thead><tbody id="rows"></tbody></table>
<script>
const POSTS = ${posts};
const state = { sortKey: "at", dir: -1, page: 1, per: 15, q: "" };
const human = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return iso || "";
  const diff = (Date.now() - d.getTime()) / 1000;
  const rel = diff < 60 ? "just now" : diff < 3600 ? Math.floor(diff/60) + "m ago"
    : diff < 86400 ? Math.floor(diff/3600) + "h ago" : Math.floor(diff/86400) + "d ago";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " (" + rel + ")";
};
document.querySelectorAll(".humantime").forEach((el) => { el.textContent = human(el.dataset.ts); el.title = el.dataset.ts; });
const stateOf = (p) => p.error ? "error" : (p.verification_status || p.status || "");
const esc = (t) => String(t ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
function filtered() {
  const q = state.q.toLowerCase();
  return POSTS.filter((p) => !q || [p.title, p.submolt, stateOf(p), p.error].join(" ").toLowerCase().includes(q));
}
function sorted(list) {
  const k = state.sortKey;
  return [...list].sort((a, b) => {
    const va = k === "state" ? stateOf(a) : (a[k] ?? "");
    const vb = k === "state" ? stateOf(b) : (b[k] ?? "");
    return String(va).localeCompare(String(vb)) * state.dir;
  });
}
function render() {
  const list = sorted(filtered());
  const pages = Math.max(1, Math.ceil(list.length / state.per));
  state.page = Math.min(state.page, pages);
  const slice = list.slice((state.page - 1) * state.per, state.page * state.per);
  document.getElementById("rows").innerHTML = slice.map((p) =>
    '<tr><td class="time" title="' + esc(p.at) + '">' + esc(human(p.at)) + "</td><td>m/" + esc(p.submolt) +
    '</td><td>' + esc(p.title) + '</td><td class="' + (p.error ? "ok dim" : "") + '">' +
    esc(stateOf(p) === "ok" ? "ok" : stateOf(p)) + (p.error ? '<span class="err"> — ' + esc(p.error.slice(0, 120)) + "</span>" : "") + "</td></tr>"
  ).join("");
  document.getElementById("count").textContent = list.length + " post" + (list.length === 1 ? "" : "s");
  document.getElementById("pageinfo").textContent = " page " + state.page + " / " + pages + " ";
  document.querySelectorAll("#tbl th").forEach((th) => {
    th.querySelector(".sort").textContent = th.dataset.k === state.sortKey ? (state.dir === 1 ? "▲" : "▼") : "";
  });
}
document.querySelectorAll("#tbl th").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (state.sortKey === k) state.dir *= -1; else { state.sortKey = k; state.dir = -1; }
  render();
}));
document.getElementById("q").addEventListener("input", (e) => { state.q = e.target.value; state.page = 1; render(); });
document.getElementById("prev").addEventListener("click", () => { if (state.page > 1) { state.page--; render(); } });
document.getElementById("next").addEventListener("click", () => {
  const pages = Math.max(1, Math.ceil(filtered().length / state.per));
  if (state.page < pages) { state.page++; render(); }
});
render();
</script>
</body></html>`;
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`moltbook-bot-lite listening on :${info.port} (configured=${configured})`);
});