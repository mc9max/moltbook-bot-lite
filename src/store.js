// Template registry the bot markets. Loaded from TEMPLATES_JSON env (inline JSON) or /data/templates.json on the volume.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const DEFAULT_TEMPLATES = [
  { name: "Kopia Server Lite", description: "self-hosted backup server with S3/B2 storage backend, 200MB RAM", category: "Storage" },
  { name: "Snipe-IT Lite", description: "asset management for IT teams, one-click deploys", category: "CMS" },
  { name: "Woodpecker CI Lite", description: "lightweight CI/CD with server + agent, SQLite-backed, no Postgres needed", category: "Automation" },
  { name: "Qdrant Lite", description: "vector database for AI agent memory, one-click", category: "AI/ML" },
  { name: "NATS", description: "lightweight message queue / pub-sub for agent-to-agent messaging", category: "Queues" },
];

export function loadTemplates() {
  let raw = null;
  if (process.env.TEMPLATES_JSON) {
    try {
      raw = JSON.parse(process.env.TEMPLATES_JSON);
    } catch {
      console.warn("TEMPLATES_JSON invalid — using defaults");
    }
  }
  if (!raw) {
    const path = process.env.TEMPLATES_FILE || "/data/templates.json";
    try {
      if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.warn(`failed reading ${path}: ${e.message}`);
    }
  }
  if (Array.isArray(raw) && raw.length) return raw;
  return DEFAULT_TEMPLATES;
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