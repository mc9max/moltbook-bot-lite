// Product catalog the bot markets — any digital product, not just deploy templates.
// Loaded from PRODUCTS_JSON env (inline JSON) or /data/products.json on the volume.
// Each item: { name, description, category, url? } — url is mentioned naturally in posts.
// Default = x402.freeq.one utility APIs only. Moltbook hard-bans crypto/payment
// content (see src/llm.js system prompt), so the catalog is phrased as plain
// agent/dev utilities and the wallet/token/ZK/giftcard tools are excluded.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const DEFAULT_PRODUCTS = [
  { name: "URL-to-Markdown API", description: "Fetches any web URL and converts the main content to clean, LLM-ready Markdown — strips navigation, ads and sidebars. Options: output format (markdown/text/json), CSS selector targeting, length limits, link and image handling. Built for feeding web pages into RAG pipelines and agent context windows.", category: "Document Processing", url: "https://x402.freeq.one/tools/markdown.html" },
  { name: "HTML-to-Markdown API", description: "Converts raw HTML strings to clean, LLM-ready Markdown. Handles headings, links, images, tables, lists and code blocks. Options: heading style (atx/setext), bullet marker, code block style, emphasis delimiters — so output matches whatever Markdown flavor your pipeline expects.", category: "Document Processing", url: "https://x402.freeq.one/tools/html_to_markdown.html" },
  { name: "PDF-to-Markdown API", description: "Converts PDF documents (direct URL or base64 bytes) to clean, LLM-ready Markdown. Auto-extracts headings, paragraphs, lists and tables. Ideal for feeding reports, papers and contracts into RAG pipelines.", category: "Document Processing", url: "https://x402.freeq.one/tools/pdf_to_markdown.html" },
  { name: "DOCX-to-Markdown API", description: "Converts Word documents (direct URL or base64 bytes) to clean Markdown, preserving headings, lists, tables and formatting. Turns contracts, resumes, reports and letters into text an agent can actually read.", category: "Document Processing", url: "https://x402.freeq.one/tools/docx_to_markdown.html" },
  { name: "PPTX-to-Markdown API", description: "Converts PowerPoint presentations to Markdown — each slide becomes a heading with its text content. Pitch decks and slide reports become LLM-readable text in one call.", category: "Document Processing", url: "https://x402.freeq.one/tools/pptx_to_markdown.html" },
  { name: "XLSX-to-Markdown API", description: "Converts XLSX spreadsheets or CSV to a Markdown table AND a JSON array of row objects in a single call. All sheets included; multi-sheet workbooks flattened in sheet order. Spreadsheets become queryable data for agents.", category: "Document Processing", url: "https://x402.freeq.one/tools/xlsx_to_markdown.html" },
  { name: "EPUB-to-Markdown API", description: "Converts EPUB ebooks to clean Markdown, preserving chapter structure and formatting. Feed books, manuals and long-form docs into any text pipeline.", category: "Document Processing", url: "https://x402.freeq.one/tools/epub_to_markdown.html" },
  { name: "Universal Document-to-Markdown API", description: "Auto-detects file type and converts PDF, DOCX, PPTX, XLSX, EPUB, HTML or text files to Markdown in one call — no separate endpoints to pick between. Give it any document URL or bytes and get LLM-ready text back.", category: "Document Processing", url: "https://x402.freeq.one/tools/document_to_markdown.html" },
  { name: "Mermaid Diagram Renderer API", description: "Renders Mermaid diagram syntax to an image (PNG or SVG), returned base64-encoded. Flowcharts, sequence diagrams, class diagrams and gantt charts become shareable images without installing headless browsers or a render stack.", category: "Media Generation", url: "https://x402.freeq.one/tools/mermaid.html" },
  { name: "QR Code Generator API", description: "Generates QR codes and barcodes as images (SVG or PNG, base64-encoded). Symbologies: qrcode, code128, code39, ean13, ean8, upca, upce, isbn10, isbn13, issn, itf, gs1-128, databar. One call replaces a local image library.", category: "Media Generation", url: "https://x402.freeq.one/tools/qr_generator.html" },
  { name: "OG Image Generator API", description: "Generates Open Graph social-card images (1200x630 PNG) from a title and description, optionally embedding a header image. Returns base64-encoded PNG ready for a website's social previews. Title capped at 60 chars, description at 120.", category: "Media Generation", url: "https://x402.freeq.one/tools/og_image_generator.html" },
  { name: "OpenAPI Changelog Generator API", description: "Diffs two OpenAPI specs and generates a structured breaking-change changelog — deterministic diff, no LLM hallucination. Provide a base spec URL and the new spec; get machine- and human-readable changes for release notes.", category: "Dev Tools", url: "https://x402.freeq.one/tools/changelog_openapi.html" },
  { name: "Git Changelog Generator API", description: "Diffs git commits and generates a structured breaking-change changelog. Provide repository URL, base commit and optional target commit. Turns commit history into release notes without an LLM rewriting your history.", category: "Dev Tools", url: "https://x402.freeq.one/tools/changelog_git.html" },
  { name: "LLM Chat API", description: "OpenAI-compatible /v1/chat/completions endpoint giving access to 50+ models through one integration — including auto/eco/premium routing tiers and frontier models. Swap providers without rewriting client code; full model list and rates available at the /tools/llm_chat/models endpoint.", category: "AI/ML", url: "https://x402.freeq.one/tools/llm_chat.html" },
  { name: "Job Postings Search API", description: "Searches live job postings by keywords and locations. Returns structured results: title, company, location, apply URL, work type, employment type, seniority, industry, salary and description. One call covers the whole market for a keyword + location pair.", category: "Search", url: "https://x402.freeq.one/tools/jobs.html" },
  { name: "Short Link Creator API", description: "Creates permanent short links on freeq.one with optional custom slug and TTL auto-expiry. Returns the short URL plus a one-time manage secret that gates free click-stats and free link deletion. Short links survive the bot restart that created them.", category: "Link Utilities", url: "https://x402.freeq.one/tools/shortlink_create.html" },
  { name: "Short Link Stats API", description: "Click analytics for freeq.one short links: total clicks, last-30-day clicks, last click time. Free for the link owner with the manage secret; agents can also check liveness and traffic on links they didn't create.", category: "Link Utilities", url: "https://x402.freeq.one/tools/shortlink_stats.html" },
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