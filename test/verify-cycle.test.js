// Verification for the anti-spam verification retry flow in build-entry.js:
// candidate-order retries (deterministic first, LLM second), the 2-attempt cap,
// expiry handling, and the crosspost withholding for unverified (hidden) posts.
// Each scenario runs in its own bun worker process (test/verify-cycle-worker.js)
// against a local mock moltbook + mock LLM — never the real APIs.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";

function runWorker(moltPort, llmPort, mode) {
  const proc = spawnSync("bun", ["test/verify-cycle-worker.js", String(moltPort), String(llmPort), mode], {
    cwd: import.meta.dir + "/..",
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const line = (proc.stdout || "").split("\n").find((l) => l.startsWith("RESULT_JSON:"));
  if (!line) {
    throw new Error(`worker produced no RESULT_JSON (mode=${mode})\nstdout: ${proc.stdout}\nstderr: ${proc.stderr}`);
  }
  return JSON.parse(line.slice("RESULT_JSON:".length));
}

test("verify cycle: deterministic candidate accepted on attempt 1", () => {
  const r = runWorker(45951, 45952, "success");
  expect(r.ok).toBe(true);
  expect(r.verification_status).toBe("verified");
  expect(r.verification_attempts).toBe(1);
  expect(r.verifyCalls).toEqual(["20.00"]);
  // verified post -> crosspost decision untouched (no platforms configured)
  expect(r.blog?.skipped).toBeUndefined();
});

test("verify cycle: wrong answers retry to the 2-attempt cap, crosspost withheld", () => {
  const r = runWorker(45953, 45954, "reject");
  expect(r.ok).toBe(true); // a failed verification must not fail the cycle
  expect(r.verification_status).toBe("failed");
  expect(r.verification_attempts).toBe(2);
  expect(r.verifyCalls).toEqual(["20.00", "0.00"]);
  // unverified moltbook posts are hidden — the blog copy points at nothing
  expect(String(r.blog?.skipped)).toContain("unverified");
});

test("verify cycle: expired challenge is not submitted at all", () => {
  const r = runWorker(45955, 45956, "expired");
  expect(r.ok).toBe(true);
  expect(r.verification_status).toBe("failed");
  expect(r.verification_attempts).toBeUndefined(); // 0 attempts recorded
  expect(r.verifyCalls).toEqual([]);
});