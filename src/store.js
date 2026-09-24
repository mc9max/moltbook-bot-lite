// Product catalog the bot markets — any digital product, not just deploy templates.
// Loaded from PRODUCTS_JSON env (inline JSON) or /data/products.json on the volume.
// Each item: { name, description, category, url? } — url is mentioned naturally in posts.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const DEFAULT_PRODUCTS = [
  { name: "x402.freeq.one tool APIs", description: "30 tool APIs agents call over HTTP: URL-to-markdown extraction, Mermaid diagram rendering, QR codes, OG images, token prices, wallet portfolios, whale alerts, job search, doc-to-markdown conversion. Agent-friendly, pay-per-call from $0.001, discovery at https://x402.freeq.one/llms.txt", category: "Agent APIs", url: "https://x402.freeq.one" },
  { name: "Kopia Server Lite", description: "self-hosted backup server with S3/B2 storage backend, 200MB RAM", category: "Storage" },
  { name: "Snipe-IT Lite", description: "asset management for IT teams, one-click deploys", category: "CMS" },
  { name: "Woodpecker CI Lite", description: "lightweight CI/CD with server + agent, SQLite-backed, no Postgres needed", category: "Automation" },
  { name: "Qdrant Lite", description: "vector database for AI agent memory, one-click", category: "AI/ML" },
  { name: "NATS", description: "lightweight message queue / pub-sub for agent-to-agent messaging", category: "Queues" },
];

export function loadProducts() {
  let raw = null;
  if (process.env.PRODUCTS_JSON) {
    try {
      raw = JSON.parse(process.env.PRODUCTS_JSON);
    } catch {
      console.warn("PRODUCTS_JSON invalid — using defaults");
    }
  }
  if (!raw) {
    const path = process.env.PRODUCTS_FILE || "/data/products.json";
    try {
      if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.warn(`failed reading ${path}: ${e.message}`);
    }
  }
  if (!raw && process.env.TEMPLATES_JSON) {
    // backwards compatibility: old env var name still works
    try {
      raw = JSON.parse(process.env.TEMPLATES_JSON);
    } catch {}
  }
  if (!raw) {
    const legacyPath = process.env.TEMPLATES_FILE || "/data/templates.json";
    try {
      if (existsSync(legacyPath)) raw = JSON.parse(readFileSync(legacyPath, "utf8"));
    } catch {}
  }
  if (Array.isArray(raw) && raw.length) return raw;
  return DEFAULT_PRODUCTS;
}

// ---------- tiny JSON state store on the volume (/data), fallback to memory ----------
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = `${DATA_DIR}/state.json`;

const mem = { recent_posts: [] };

function ensureDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

export const store = {
  get() {
    try {
      if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {}
    return mem;
  },
  addPost(entry, cap = 20) {
    try {
      ensureDir();
      const s = this.get();
      s.recent_posts = [entry, ...(s.recent_posts || [])].slice(0, cap);
      writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
    } catch (e) {
      mem.recent_posts = [entry, ...(mem.recent_posts || [])].slice(0, cap);
      if (!/EROFS|EACCES|EROFS|ENOENT/.test(e.code || "")) console.warn(`state persist failed: ${e.message}`);
    }
  },
};