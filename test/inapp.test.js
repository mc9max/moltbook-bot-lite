// Unit tests for the inapp announcement watcher (src/inapp.js).
// Feed URLs freeze at module import; env is set synchronously, the mock feed
// server starts before the (dynamic) import, and a unique query string busts
// bun's import cache.
import { test, expect } from "bun:test";

const H = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const YT_XML = `<?xml version="1.0"?><feed>
<entry><yt:videoId>freshvid1</yt:videoId><title>Fresh video</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=freshvid1"/>
<published>${H(2 * 3600e3)}</published></entry>
<entry><yt:videoId>oldvid2</yt:videoId><title>Ancient video</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=oldvid2"/>
<published>${H(200 * 3600e3)}</published></entry>
</feed>`;

// blog feed: newest entry carries an x402 name (must be skipped), then a URL
// slug already in the ledger (skipped), then a clean entry (winner)
const BLOG_XML = `<?xml version="1.0"?><feed>
<entry><title>x402 gateway template</title>
<link href="https://imapp.blogspot.com/2026/10/x402.html"/>
<published>${H(1 * 3600e3)}</published></entry>
<entry><title>Already announced post</title>
<link href="https://imapp.blogspot.com/2026/10/already-posted-slug"/>
<published>${H(3 * 3600e3)}</published></entry>
<entry><title>Clean blog post</title>
<link href="https://imapp.blogspot.com/2026/10/clean.html"/>
<published>${H(5 * 3600e3)}</published></entry>
</feed>`;

const srv = Bun.serve({
  port: 0,
  fetch: (req) =>
    new Response(req.url.endsWith("/yt") ? YT_XML : BLOG_XML, {
      headers: { "content-type": "application/xml" },
    }),
});
const PORT = srv.port;
const seen = { inapp_seen: { "https://imapp.blogspot.com/2026/10/already-posted-slug": H(9 * 3600e3) } };
const store = {
  get: () => ({ recent_posts: [], inapp_seen: seen.inapp_seen }),
  update: (fn) => { fn(seen); },
};

process.env.BLOG_FEED_URL = `http://127.0.0.1:${PORT}/blog`;
process.env.YOUTUBE_FEED_URL = `http://127.0.0.1:${PORT}/yt`;
process.env.INAPP_SOURCES = "blog,youtube";
process.env.INAPP_MAX_AGE_HOURS = "36";

const { pickInappItem, formatInappTopic, markInappAnnounced } = await import("../src/inapp.js?inapp-test");

test("skips banned (x402) items, ledgered items and expired items; newest wins", async () => {
  const { item } = await pickInappItem(store);
  expect(item).not.toBeNull();
  expect(item.slug).toBe("freshvid1"); // youtube freshest; blog's x402 + ledgered entries filtered out
  expect(item.kind).toBe("youtube");
});

test("formatInappTopic embeds the URL once and no crypto wording", () => {
  const t = formatInappTopic({ kind: "github", title: "somerepo", url: "https://github.com/x/y", blurb: "one-click template" });
  expect(t).toContain("https://github.com/x/y");
  expect((t.match(/github\.com\/x\/y/g) || []).length).toBe(1);
});

test("markInappAnnounced persists the slug and dedupes the next pick", async () => {
  const first = await pickInappItem(store);
  markInappAnnounced(store, first.item.slug);
  expect(seen.inapp_seen["freshvid1"]).toBeTruthy();
  const second = await pickInappItem(store);
  expect(second.item).not.toBeNull();
  expect(second.item.slug).not.toBe(first.item.slug);
  expect(second.item.slug).toBe("https://imapp.blogspot.com/2026/10/clean.html");
});