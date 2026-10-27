// Verification for src/topics.js — trend discovery + catalog self-update.
// Pure functions and mocked fetch; no network and no Moltbook needed.
import { test, expect } from "bun:test";
import { pickTrendTopic, matchProduct, tokenize, syncCatalogFromRegistry } from "../src/topics.js";

const feed = (title, upvotes = 5, comments = 2) => ({ title, submolt: "x", upvotes, comments });

test("tokenize filters stopwords, short tokens, urls, numbers", () => {
  // URL junk is stripped; stopwords and tiny tokens (k8s) are dropped.
  expect(tokenize("Visit https://example.com/x for the best K8s tips!!")).toEqual(["visit", "best", "tips"]);
  // real content tokens survive
  expect(tokenize("Backups failed because Postgres hit the disk limit")).toEqual(
    expect.arrayContaining(["backups", "postgres", "disk", "limit"])
  );
});

test("pickTrendTopic returns null for empty/insufficient feeds", () => {
  expect(pickTrendTopic([], [])).toBeNull();
  expect(pickTrendTopic([feed("one single post about kubernetes")], [])).toBeNull(); // only 1 mention
});

test("pickTrendTopic prefers a repeated specific bigram", () => {
  const posts = [
    feed("Why our Postgres backup restore took 6 hours", 40, 12),
    feed("Postgres backup restore pitfalls nobody warns about", 30, 9),
    feed("Totally unrelated: my agent built a discord bot", 5, 1),
  ];
  const trend = pickTrendTopic(posts, []);
  expect(trend).not.toBeNull();
  // "postgres backup" and "backup restore" score identically — both are
  // legitimate emerging bigrams; any of them (not "took hours"-style chaff,
  // not the single-mention discord post) winning is correct.
  expect(["postgres backup", "backup restore"]).toContain(trend.phrase);
  expect(trend.mentions).toBe(2);
});

test("pickTrendTopic skips topics already covered recently and banned words", () => {
  const posts = [feed("Postgres connection pooling at scale", 10), feed("Postgres connection pooling horror", 10)];
  expect(pickTrendTopic(posts, ["How we fixed Postgres connection pooling"])).toBeNull();
  const banned = [feed("free crypto bitcoin wallet giveaway", 10), feed("crypto wallet trading bot", 10)];
  expect(pickTrendTopic(banned, [])).toBeNull();
});

test("matchProduct requires a real overlap (>=2 keywords)", () => {
  const catalog = [
    {
      name: "Log Search API",
      category: "Dev Tools",
      description: "Runs fast full-text searches over shipped application logs with structured filters and time windows",
    },
    {
      name: "DNS Toolkit",
      category: "Networking",
      description: "Queries and monitors DNS records for domains with expiry and misconfiguration checks",
    },
  ];
  expect(matchProduct("postgres backup restore", catalog)).toBeNull();
  expect(matchProduct("searching application logs at scale", catalog)?.name).toBe("Log Search API");
  expect(matchProduct("dns expiry monitoring checks", catalog)?.name).toBe("DNS Toolkit");
});

test("matchProduct never matches banned products", () => {
  expect(
    matchProduct("crypto wallet payments", [
      { name: "Crypto Wallet API", category: "Payments", description: "Handles wallet and payment integrations for agents" },
    ])
  ).toBeNull();
});

test("syncCatalogFromRegistry validates, de-bans, dedupes and merges", async () => {
  const catalog = [{ name: "Existing Tool", description: "A long enough description for the existing tool entry", category: "Dev Tools" }];
  const reg = {
    products: [
      { name: "Cron Pin API", description: "Pins cron schedules across regions with drift detection and alerts", category: "Dev Tools", url: "https://x402.freeq.one/tools/cron_pin.html" },
      { name: "Crypto Trader", description: "Executes token trades on decentralized blockchain wallet exchanges", category: "Finance" },
      { name: "Http Only Thing", description: "short", category: "Dev Tools" },
      { name: "Insecure Tool", description: "Serves the same purpose over plain http endpoints for testing", url: "http://example.com/tool" },
      { name: "Existing Tool", description: "A long enough description for the existing tool entry", category: "Dev Tools" },
    ],
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => reg });
  try {
    const { added, merged, error } = await syncCatalogFromRegistry("https://registry.example/reg.json", catalog);
    expect(error).toBeNull();
    expect(added.map((x) => x.name)).toEqual(["Cron Pin API"]);
    expect(merged.length).toBe(2);
    expect(merged[1].url).toBe("https://x402.freeq.one/tools/cron_pin.html");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("syncCatalogFromRegistry reports errors instead of throwing", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("down");
  };
  try {
    const { added, error } = await syncCatalogFromRegistry("https://registry.example/reg.json", []);
    expect(added).toEqual([]);
    expect(error).toContain("down");
  } finally {
    globalThis.fetch = origFetch;
  }
});