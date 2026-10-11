// Verification for the edge/WAF hardening in src/moltbook.js.
// Runs entirely against a local mock WAF+app — it never talks to moltbook.com.
//   bun test/waf.test.js
process.env.MOLTBOOK_RETRY_BASE_MS = "1"; // no real sleeping

import { test, expect, afterAll } from "bun:test";

const WAF_HTML =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2></BODY></HTML>';

const byteLen = (s) => new TextEncoder().encode(s).length;

let mode = "ok"; // ok | transient | app-error | app-429
let seen = []; // every POST body that reached the mock
const TOXIC = [["<script"], ["onerror="], ["../"]];
const wafBlocks = (body) =>
  byteLen(body) > 8192 || TOXIC.some(([t]) => body.toLowerCase().includes(t));

const server = Bun.serve({
  port: 45990,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    if (body) seen.push(body);
    const edgeBlock = new Response(WAF_HTML, {
      status: 403,
      headers: { "content-type": "text/html", "cf-ray": "test-ray" },
    });
    if (url.pathname.endsWith("/posts")) {
      if (mode === "transient" && seen.length <= 2) return edgeBlock;
      if (wafBlocks(body)) return edgeBlock;
      if (mode === "app-error") return Response.json({ error: "Title must be 5-300 characters" }, { status: 400 });
      if (mode === "app-429") return Response.json({ error: "Rate limit exceeded", retry_after_seconds: 1 }, { status: 429 });
      return Response.json({ post: { id: "p1" } });
    }
    return Response.json({ ok: true });
  },
});
afterAll(() => server.stop(true));

// The client fixes its base URL at module load, so point it at the mock first.
process.env.MOLTBOOK_API_BASE = `http://127.0.0.1:${server.port}/api/v1`;
const { MoltbookClient, capContentForBody, stripWafTriggers, WAF_BODY_LIMIT, MoltbookEdgeError } = await import(
  "../src/moltbook.js"
);

test("capContentForBody keeps a 40KB post body under the 8KB edge limit", () => {
  const huge = ("Paragraph one with real words in it.\n\n" + "x".repeat(600) + "\n\n").repeat(70);
  expect(huge.length).toBeGreaterThan(40000);
  const cap = capContentForBody(huge);
  expect(cap.truncated).toBe(true);
  const body = JSON.stringify({ submolt_name: "builds", title: "t", content: cap.content });
  expect(byteLen(body)).toBeLessThan(WAF_BODY_LIMIT);
  expect(byteLen(body)).toBeLessThan(8192); // measured WAF body limit
  expect(cap.content.endsWith("x".repeat(600)) || cap.content.endsWith("it.")).toBe(true); // paragraph boundary, never mid-paragraph
});

test("short content is passed through untouched", () => {
  const cap = capContentForBody("A short update about deploys.");
  expect(cap.truncated).toBe(false);
  expect(cap.content).toBe("A short update about deploys.");
});

test("a 40KB post actually lands instead of being edge-blocked", async () => {
  mode = "ok";
  seen = [];
  const c = new MoltbookClient("k");
  const res = await c.createPost("builds", "Big post", "words ".repeat(9000));
  expect(res.post.id).toBe("p1");
  expect(seen.length).toBe(1); // no retries needed once the body is capped
  expect(byteLen(seen[0])).toBeLessThan(8192);
});

test("transient edge 403 is retried and the post lands", async () => {
  mode = "transient";
  seen = [];
  const c = new MoltbookClient("k");
  const res = await c.createPost("builds", "Transient block", "Body text about CI.");
  expect(res.post.id).toBe("p1");
  expect(seen.length).toBe(3); // two WAF 403s, then success
});

test("persistent pattern block falls back to a scrubbed body", async () => {
  mode = "ok";
  seen = [];
  const c = new MoltbookClient("k");
  const toxic = "Here is the fix:\n\n```html\n<script>alert(1)</script>\n```\n\nthe attribute was onerror=alert(1), and the file lives at ../../etc/passwd.";
  const res = await c.createPost("builds", "Persistent <script> block", toxic);
  expect(res.post.id).toBe("p1"); // only reachable with the scrubbed body
  expect(seen.length).toBe(5); // 4 raw attempts (retries=3) all blocked, then 1 scrubbed attempt
  const last = seen[seen.length - 1];
  expect(last).not.toContain("<script");
  expect(last).not.toContain("```");
  expect(last).not.toContain("onerror=");
  expect(last).not.toContain("../../");
  expect(JSON.parse(last).content.length).toBeGreaterThan(20); // still a readable post
});

test("app-level 400 is not retried and keeps the app message", async () => {
  mode = "app-error";
  seen = [];
  const c = new MoltbookClient("k");
  await expect(c.createPost("builds", "Bad", "Body")).rejects.toThrow(/Title must be 5-300 characters/);
  expect(seen.length).toBe(1);
});

test("app-level 429 is retried once, then surfaces", async () => {
  mode = "app-429";
  seen = [];
  const c = new MoltbookClient("k");
  await expect(c.createPost("builds", "Rate limited", "Body")).rejects.toThrow(/Rate limit exceeded/);
  expect(seen.length).toBe(4); // 1 initial + 3 retries
});

test("edge error carries the diagnostics needed to identify the trigger", async () => {
  seen = [];
  const c = new MoltbookClient("k");
  const err = await c._req("/posts", { method: "POST", body: '{"content":"<script>x</script>"}', retries: 0 }).catch((e) => e);
  expect(err).toBeInstanceOf(MoltbookEdgeError);
  expect(err.edge).toBe(true);
  expect(err.status).toBe(403);
  expect(err.message).toContain("cf-ray=test-ray");
  expect(err.message).toContain("content-type=text/html");
  expect(err.message).toMatch(/body\[\d+\]=/); // length + snippet, so the next occurrence is diagnosable
});

test("stripWafTriggers leaves prose intact", () => {
  const { content, scrubbed } = stripWafTriggers("I ran `bun test` and then deployed. Nothing else.");
  expect(scrubbed).toContain("inline-code");
  expect(content).toContain("I ran");
  expect(content).toContain("and then deployed");
});
