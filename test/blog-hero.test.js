// Tests for hero resolution order in blog.js:
// explicit override > per-post stock search (R2-hosted) > pool fallback.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveHero } from "../src/blog.js";

const VARS = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PUBLIC_URL",
  "PIXABAY_API_KEY",
  "PEXELS_API_KEY",
  "BLOG_HERO_IMAGES",
  "BLOG_HERO_APPEND",
  "BLOG_HERO_STOCK",
];

const saved = {};
let fetchCalls;
let origFetch;

function setEnv(patch) {
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, patch);
}

function baseEnv() {
  return {
    R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_BUCKET: "blog-images",
    R2_ACCESS_KEY_ID: "TESTACCESSKEY",
    R2_SECRET_ACCESS_KEY: "TESTSECRET",
    R2_PUBLIC_URL: "https://cdn.freeq.one",
    PIXABAY_API_KEY: "PIXKEY",
    PEXELS_API_KEY: "PEXKEY",
    BLOG_HERO_IMAGES: "https://pool.example/a.jpg,https://pool.example/b.jpg",
  };
}

// Stub fetch: Pixabay returns one hit, the image download returns 6KB,
// the R2 PUT succeeds. `pixabayHits` controls the search result.
function stubFetch(pixabayHits) {
  return async (url, opts = {}) => {
    fetchCalls.push(String(url));
    const u = String(url);
    if (u.startsWith("https://pixabay.com/api/")) {
      return { ok: true, status: 200, json: async () => ({ hits: pixabayHits }) };
    }
    if (u.startsWith("https://api.pexels.com/")) {
      return { ok: true, status: 200, json: async () => ({ photos: [] }) };
    }
    if (u.includes(".r2.cloudflarestorage.com/")) {
      expect(opts.method).toBe("PUT");
      return { ok: true, status: 200, text: async () => "" };
    }
    // Image download.
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(6000).buffer,
      text: async () => "",
    };
  };
}

beforeEach(() => {
  for (const k of VARS) { saved[k] = process.env[k]; }
  fetchCalls = [];
  origFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = origFetch;
});

describe("resolveHero", () => {
  test("explicit override wins over stock and pool", async () => {
    setEnv(baseEnv());
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    const hero = await resolveHero({ imageQuery: "server rack", heroImage: "https://override.example/h.jpg" });
    expect(hero).toBe("https://override.example/h.jpg");
  });

  test("stock hit wins over the pool", async () => {
    setEnv(baseEnv());
    globalThis.fetch = stubFetch([{ largeImageURL: "https://cdn.pixabay.com/photo-1.jpg" }]);
    const hero = await resolveHero({ imageQuery: "server rack" });
    expect(hero).toMatch(/^https:\/\/cdn\.freeq\.one\/heroes\/moltbook-hero-\d+-[a-z0-9]+\.jpg$/);
    expect(hero).not.toContain("pool.example");
  });

  test("stock miss falls back to the pool", async () => {
    setEnv(baseEnv());
    globalThis.fetch = stubFetch([]);
    const hero = await resolveHero({ imageQuery: "server rack" });
    expect(["https://pool.example/a.jpg", "https://pool.example/b.jpg"]).toContain(hero);
  });

  test("BLOG_HERO_APPEND=0 disables heroes entirely", async () => {
    setEnv({ ...baseEnv(), BLOG_HERO_APPEND: "0" });
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    expect(await resolveHero({ imageQuery: "server rack" })).toBeNull();
  });

  test("BLOG_HERO_STOCK=0 falls back to the pool", async () => {
    setEnv({ ...baseEnv(), BLOG_HERO_STOCK: "0" });
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    const hero = await resolveHero({ imageQuery: "server rack" });
    expect(["https://pool.example/a.jpg", "https://pool.example/b.jpg"]).toContain(hero);
  });

  test("no stock keys and no pool yields null (hero-less, never a temp host)", async () => {
    const env = baseEnv();
    delete env.PIXABAY_API_KEY;
    delete env.PEXELS_API_KEY;
    delete env.BLOG_HERO_IMAGES;
    setEnv(env);
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    expect(await resolveHero({ imageQuery: "server rack" })).toBeNull();
  });

  test("missing R2 config falls back to the pool", async () => {
    const env = baseEnv();
    delete env.R2_SECRET_ACCESS_KEY;
    setEnv(env);
    globalThis.fetch = stubFetch([{ largeImageURL: "https://cdn.pixabay.com/photo-1.jpg" }]);
    const hero = await resolveHero({ imageQuery: "server rack" });
    expect(["https://pool.example/a.jpg", "https://pool.example/b.jpg"]).toContain(hero);
    // No R2 PUT was attempted.
    expect(fetchCalls.some((u) => u.includes(".r2.cloudflarestorage.com/"))).toBe(false);
  });
});
