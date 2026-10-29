// Tests for the R2 uploader: config loading, SigV4-signed PUT shape,
// public URL construction, and failure contract (null, never a throw
// for ordinary failures).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadR2Config, uploadToR2 } from "../src/r2-upload.js";

const VARS = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PUBLIC_URL",
];

const saved = {};
let fetchCalls;
let origFetch;

function setR2Env() {
  process.env.R2_ENDPOINT = "https://625ce86369eadb2f31a8818a3c575af4.r2.cloudflarestorage.com";
  process.env.R2_BUCKET = "blog-images";
  process.env.R2_ACCESS_KEY_ID = "TESTACCESSKEY";
  process.env.R2_SECRET_ACCESS_KEY = "TESTSECRET";
  process.env.R2_PUBLIC_URL = "https://cdn.freeq.one";
}

beforeEach(() => {
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
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

describe("loadR2Config", () => {
  test("returns null when any variable is missing", () => {
    setR2Env();
    delete process.env.R2_SECRET_ACCESS_KEY;
    expect(loadR2Config()).toBeNull();
  });

  test("returns the config when all variables are set", () => {
    setR2Env();
    const c = loadR2Config();
    expect(c.bucket).toBe("blog-images");
    expect(c.publicUrl).toBe("https://cdn.freeq.one");
  });
});

describe("uploadToR2", () => {
  test("PUTs a SigV4-signed request and returns the public URL", async () => {
    setR2Env();
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, status: 200, text: async () => "" };
    };
    const out = await uploadToR2(Buffer.alloc(6000, 1), "moltbook-hero-1-abc123.jpg");
    expect(out).toBe("https://cdn.freeq.one/heroes/moltbook-hero-1-abc123.jpg");
    expect(fetchCalls.length).toBe(1);
    const { url, opts } = fetchCalls[0];
    expect(url).toBe(
      "https://625ce86369eadb2f31a8818a3c575af4.r2.cloudflarestorage.com/blog-images/heroes/moltbook-hero-1-abc123.jpg",
    );
    expect(opts.method).toBe("PUT");
    expect(opts.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(opts.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=TESTACCESSKEY\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
  });

  test("returns null on a non-2xx response", async () => {
    setR2Env();
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
    const out = await uploadToR2(Buffer.alloc(6000, 1), "x.jpg");
    expect(out).toBeNull();
  });

  test("returns null when config is missing", async () => {
    globalThis.fetch = async () => { throw new Error("must not be called"); };
    const out = await uploadToR2(Buffer.alloc(6000, 1), "x.jpg");
    expect(out).toBeNull();
  });
});
