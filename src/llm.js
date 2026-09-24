// LLM calls: post generation + anti-spam challenge solving.
// Works with Anthropic, any OpenAI-compatible endpoint, and Ollama native.
//
// LLM_BASE_URL is normalized client-side so users can paste whatever shape the
// provider's docs show:
//   https://host                      -> {base}/v1/chat/completions
//   https://host/v1                   -> {base}/v1/chat/completions
//   https://host/v1/chat/completions  -> used as-is
//   https://host/api/chat             -> Ollama native, used as-is
// If the first guess 404s, remaining candidates are probed once and the working
// path is cached for the process lifetime (handles LiteLLM/OpenRouter/proxies).

const ANTHROPIC_RE = /anthropic\.com/;

function candidatePaths(base) {
  const u = base.replace(/\/+$/, "");
  const c = [];
  if (/\/chat\/completions$/.test(u)) c.push({ url: u, flavor: "openai" });
  else if (/\/v1$/.test(u)) {
    c.push({ url: `${u}/chat/completions`, flavor: "openai" });
    c.push({ url: `${u.replace(/\/v1$/, "")}/api/chat`, flavor: "ollama" });
  } else if (/\/api\/chat$/.test(u)) {
    c.push({ url: u, flavor: "ollama" });
    c.push({ url: `${u.replace(/\/api\/chat$/, "")}/v1/chat/completions`, flavor: "openai" });
  } else {
    c.push({ url: `${u}/v1/chat/completions`, flavor: "openai" });
    c.push({ url: `${u}/api/chat`, flavor: "ollama" });
    c.push({ url: `${u}/chat/completions`, flavor: "openai" });
  }
  return c;
}

// resolved endpoint cache, keyed by baseUrl
const endpointCache = new Map();

function buildRequest(flavor, { model, system, user, maxTokens }) {
  if (flavor === "ollama") {
    return {
      body: {
        model,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        think: false,
        options: { num_predict: Math.max(maxTokens * 3, 4000) },
      },
      extract: (j) => j?.message?.content || "",
    };
  }
  return {
    body: {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    extract: (j) => j?.choices?.[0]?.message?.content || j?.choices?.[0]?.message?.reasoning_content || "",
  };
}

async function openaiOrOllama({ baseUrl, apiKey, model, system, user, maxTokens }) {
  const cached = endpointCache.get(baseUrl);
  const candidates = cached ? [cached] : candidatePaths(baseUrl);
  let lastErr = null;

  for (const cand of candidates) {
    const { body, extract } = buildRequest(cand.flavor, { model, system, user, maxTokens });
    const res = await fetch(cand.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const rawText = await res.text().catch(() => "");
      let j = null;
      try { j = JSON.parse(rawText); } catch {}
      if (j) {
        const text = extract(j);
        if (text) {
          if (!cached) endpointCache.set(baseUrl, cand);
          return text;
        }
        lastErr = new Error(`LLM ${res.status} at ${cand.url}: empty content — body: ${rawText.slice(0, 300)}`);
        continue;
      }
      lastErr = new Error(`LLM at ${cand.url}: non-JSON response — body: ${rawText.slice(0, 300)}`);
      continue;
      lastErr = new Error(`LLM at ${cand.url}: non-JSON response`);
      continue;
    }
    const errText = await res.text().catch(() => res.statusText);
    lastErr = new Error(`LLM ${res.status} at ${cand.url}: ${errText.slice(0, 300)}`);
    // 404/405 = wrong path -> probe next candidate. Auth/other errors are terminal.
    if (res.status !== 404 && res.status !== 405) break;
  }
  throw lastErr || new Error("LLM request failed: no endpoint candidate succeeded");
}

async function chatCompletion(opts) {
  if (!opts.apiKey) throw new Error("LLM_API_KEY not set — cannot generate content");

  // Anthropic-style
  if (ANTHROPIC_RE.test(opts.baseUrl)) {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const j = await res.json();
    return j?.content?.[0]?.text || "";
  }

  return openaiOrOllama(opts);
}

function extractJson(text) {
  // strip markdown code fences if present
  text = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "");
  // brace-balanced scan from the first { — greedy regex breaks when prose
  // after the JSON contains another brace pair
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`LLM returned no JSON: ${text.slice(0, 200)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const cand = text.slice(start, i + 1);
        try { return JSON.parse(cand); } catch {}
        try { return JSON.parse(cand.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")); } catch {}
        // last resort: single-quoted keys/strings
        try { return JSON.parse(cand.replace(/([{,]\s*)'(\w+)':/g, '$1"$2":').replace(/:(\s*)'([^']*)'/g, ':$1"$2"')); } catch {}
        text = cand; // fall through to final throw with slice of cand
        throw new Error(`LLM returned unparseable JSON: ${cand.slice(0, 300)}`);
      }
    }
  }
  throw new Error(`LLM returned unparseable JSON: ${text.slice(start, start + 300)}`);
}

export async function generatePost({ baseUrl, apiKey, model, agentName, templates, recentTitles, forcedTopic }) {
  const system = `You are ${agentName}, an AI agent on Moltbook (the social network for AI agents) that shares real experience self-hosting open-source tools on Railway (one-click deploy platform).

HARD RULES:
- Respond in ENGLISH ONLY. All output (title and content) must be in English.
- Write like a genuine engineer sharing hands-on experience, NOT an ad. No "check out my link", no hype, no emoji spam.
- NEVER mention cryptocurrency, USDC, blockchain, payments, or x402 — Moltbook auto-removes crypto content.
- Mention deploy links naturally at most once, only if it fits the story.
- Title: max 120 chars, specific and honest. Content: 150-400 words, markdown, first-person.
- Do not repeat topics from recently posted titles.

Respond with ONLY JSON: {"title": "...", "content": "..."}`;

  const tplList = templates
    .map((t) => `- ${t.name}: ${t.description} (${t.category})`)
    .join("\n");
  const recent = recentTitles?.length ? `\n\nRecently posted titles (do NOT repeat these topics):\n${recentTitles.map((t) => `- ${t}`).join("\n")}` : "";

  const user = forcedTopic
    ? `Write a Moltbook post about: ${forcedTopic}\n\nYour templates:\n${tplList}${recent}`
    : `Pick ONE of your templates (rotate through, prefer ones not covered recently) and write a Moltbook post about a concrete lesson from deploying/operating it: a config gotcha, a resource tuning win, a failure story, a comparison with the managed alternative.

Your templates:\n${tplList}${recent}`;

  const text = await chatCompletion({ baseUrl, apiKey, model, system, user, maxTokens: 1500 });
  const { title, content } = extractJson(text);
  if (!title || !content) throw new Error("LLM JSON missing title/content");
  return { title: String(title).slice(0, 300), content: String(content).slice(0, 40000) };
}

export async function solveChallenge({ baseUrl, apiKey, model, challengeText, instructions }) {
  const system =
    "You solve obfuscated math word problems. The text is scrambled (alternating caps, stray symbols like ^ ] / -, shattered words). Reconstruct it, solve the math, and respond with ONLY the answer in the requested format (usually a number with 2 decimal places). No explanation, no punctuation, nothing else.";
  const user = `${instructions}\n\nProblem:\n${challengeText}`;

  const text = await chatCompletion({ baseUrl, apiKey, model, system, user, maxTokens: 4000 });
  let cleaned = text.trim().replace(/[^0-9.\-]/g, "");
  // normalize: strip trailing dots/dashes fragments, keep last valid number group
  const nums = cleaned.match(/-?[0-9]+(\.[0-9]+)?/g);
  if (nums) cleaned = nums[nums.length - 1];
  if (/2 decimal/i.test(instructions || "") && /^-?\d+(\.\d?)?$/.test(cleaned)) {
    const [i, f = ""] = cleaned.split(".");
    cleaned = `${i}.${(f + "00").slice(0, 2)}`;
  }
  return cleaned || text.trim();
}