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

function buildRequest(flavor, { model, system, userMsg, maxTokens }) {
  if (flavor === "ollama") {
    return {
      body: {
        model,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
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
        { role: "user", content: userMsg },
      ],
    },
    extract: (j) => j?.choices?.[0]?.message?.content || j?.choices?.[0]?.message?.reasoning_content || "",
  };
}

async function openaiOrOllama({ baseUrl, apiKey, model, system, user, maxTokens, extraUser }) {
  const userMsg = extraUser ? `${user}${extraUser}` : user;
  const cached = endpointCache.get(baseUrl);
  const candidates = cached ? [cached] : candidatePaths(baseUrl);
  let lastErr = null;

  for (const cand of candidates) {
    const { body, extract } = buildRequest(cand.flavor, { model, system, userMsg, maxTokens });
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
  const userMsg = opts.extraUser ? `${opts.user}${opts.extraUser}` : opts.user;
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
        messages: [{ role: "user", content: userMsg }],
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

export async function generatePost({ baseUrl, apiKey, model, agentName, products, recentTitles, forcedTopic }) {
  const system = `You are ${agentName}, an AI agent on Moltbook (the social network for AI agents) that shares genuine hands-on experience with digital products you build or operate — self-hosted tools, developer APIs, agent utilities, automation services. Your goal is to make other agents aware of your products by telling honest engineering stories about them.

HARD RULES:
- Respond in ENGLISH ONLY. All output (title and content) must be in English.
- Write like a genuine engineer sharing hands-on experience, NOT an ad. No "check out my link", no hype, no emoji spam.
- NEVER mention cryptocurrency, USDC, blockchain, payments, or x402 — Moltbook auto-removes crypto content.
- Mention a product URL naturally at most once, only if it fits the story. Never more than one link per post.
- Title: max 120 chars, specific and honest. Content: 150-400 words, markdown, first-person.
- Do not repeat topics from recently posted titles.

Respond with ONLY JSON: {"title": "...", "content": "..."}`;

  const prodList = products
    .map((t) => `- ${t.name}: ${t.description} (${t.category})${t.url ? ` [URL: ${t.url}]` : ""}`)
    .join("\n");
  const recent = recentTitles?.length ? `\n\nRecently posted titles (do NOT repeat these topics):\n${recentTitles.map((t) => `- ${t}`).join("\n")}` : "";

  const user = forcedTopic
    ? `Write a Moltbook post about: ${forcedTopic}\n\nYour products:\n${prodList}${recent}`
    : `Pick ONE of your products (rotate through, prefer ones not covered recently) and write a Moltbook post about a concrete lesson from building/operating it: a config gotcha, a resource tuning win, a failure story, a real use case, a comparison with the managed or commercial alternative, or how other agents can use it.

Your products:\n${prodList}${recent}`;

  // up to 3 attempts: glm-class models drift (placeholder titles, Chinese,
  // missing JSON). Validate hard before returning anything.
  const isEnglishish = (s) => {
    if (!s) return false;
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
    return letters >= 20 && nonAscii <= Math.max(2, letters * 0.05);
  };
  const goodTitle = (t) => {
    const s = String(t || "").trim();
    return s.length >= 15 && s.length <= 120 && !/^\W+$/.test(s) && /\s/.test(s) && isEnglishish(s);
  };
  const goodContent = (c) => {
    const s = String(c || "").trim();
    return s.length >= 300 && isEnglishish(s) && !/^\.{2,}/.test(s);
  };

  let lastRaw = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const text = await chatCompletion({
      baseUrl, apiKey, model, system, user,
      maxTokens: 1500,
      extraUser: attempt > 1 ? "\n\nREMINDER: Respond in ENGLISH with ONLY the JSON object. Title must be a real descriptive sentence (never \"...\" or placeholders)." : undefined,
    });
    lastRaw = text;
    let parsed;
    try {
      parsed = extractJson(text);
    } catch {
      continue;
    }
    const title = String(parsed?.title || "").trim();
    const content = String(parsed?.content || "").trim();
    if (!goodTitle(title)) continue;
    if (!goodContent(content)) continue;
    return { title: title.slice(0, 300), content: content.slice(0, 40000) };
  }
  throw new Error(`LLM produced no usable post after 4 attempts — last output: ${String(lastRaw || "").slice(0, 200)}`);
}

// Moltbook challenge text is scrambled: alternating caps, stray symbols
// (^ ] / - ~), shattered words. De-obfuscate deterministically in code so the
// LLM only sees clean arithmetic — removes the main source of wrong answers.
function deobfuscateChallenge(raw) {
  const NUM_WORDS = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90, hundred:100, thousand:1000, percent:0, half:0, quarter:0, times:0, plus:0, minus:0, gained:0, gain:0, loses:0, lose:0, increases:0, increase:0, decreases:0, decrease:0, and:0, is:0, what:0, the:0, new:0, per:0, second:0, minute:0, hour:0, speed:0, velocity:0, total:0 };
  // strip EVERYTHING except letters, digits and spaces — intra-word noise like
  // "i.r.Ty" (thirty) or "fIiV/e" (five) must not survive into dict matching
  let t = (raw || "").replace(/[^A-Za-z0-9 ]/g, "");
  // alternating caps means word boundaries are real but caps alternate; lowercase everything
  t = t.toLowerCase().replace(/\s+/g, " ").trim();
  // re-glue shattered words: scan window of fragments, match against dictionary
  const words = t.split(" ");
  const out = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    // try longest phrase first (up to 6 fragments) starting at i
    for (let len = Math.min(6, words.length - i); len >= 1; len--) {
      const phrase = words.slice(i, i + len).join("");
      const phraseNoSpace = phrase.replace(/[^a-z]/g, "");
      if (len > 1 && phraseNoSpace in NUM_WORDS) {
        out.push(phraseNoSpace);
        i += len;
        matched = true;
        break;
      }
      if (len === 1 && words[i] in NUM_WORDS) {
        out.push(words[i]);
        i++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(words[i]);
      i++;
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Convert number words to digits: "thirty five" -> 35
function wordsToNumbers(text) {
  const SMALL = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
  const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
  let out = text;
  // compound: tens + units ("twenty five" -> 25)
  for (const [ten, tv] of Object.entries(TENS)) {
    for (const [unit, uv] of Object.entries(SMALL)) {
      if (uv === 0) continue;
      out = out.replace(new RegExp("\\b" + ten + "\\s+" + unit + "\\b", "g"), String(tv + uv));
    }
    out = out.replace(new RegExp("\\b" + ten + "\\b", "g"), String(tv));
  }
  for (const [w, v] of Object.entries(SMALL)) {
    if (v > 0) out = out.replace(new RegExp("\\b" + w + "\\b", "g"), String(v));
  }
  out = out.replace(/\bhundred\b/g, "100").replace(/\bthousand\b/g, "1000");
  return out;
}

// Solve "N units + M units" / "N minus M" style problems deterministically.
// Returns null when no confident parse.
function solveArithmetic(cleanedText) {
  const t = wordsToNumbers(cleanedText.toLowerCase());
  // find all numbers in the text
  const nums = [...t.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((m) => parseFloat(m[1]));
  if (nums.length < 2) return null;
  // choose operation from keywords
  const isSubtract = /\b(loses|lose|decreases|decrease|minus|drops|drop|slows|slow|reduces|reduce)\b/.test(t);
  const isDivide = /\b(splits|split|divides|divide|shares|shared equally)\b/.test(t);
  if (isDivide) return nums[0] / 2; // "splits N equally between two"
  const isMultiply = /\b(multiplies|multiplied|multiply|times|doubles|doubled|triples|tripled|product)\b/.test(t);
  if (isMultiply) {
    // "N multiplies by M" or "N doubles" (x2)
    if (/\b(doubles|doubled)\b/.test(t)) return nums[0] * 2;
    return nums[0] * nums[1];
  }
  if (isSubtract) return nums[0] - nums[1];
  return nums[0] + nums[1]; // gains/increases/total/default
}

export async function solveChallenge({ baseUrl, apiKey, model, challengeText, instructions }) {
  const cleanedChallenge = deobfuscateChallenge(challengeText);
  const system =
    'You solve simple math word problems, usually addition/subtraction of two numbers. The text was auto-reconstructed from an obfuscated form; words may be slightly garbled but number words (twenty, thirty, five, twelve...) are reliable. Combine compound numbers correctly: "twenty five" = 25, "thirty five" = 35. Compute the arithmetic carefully. Respond with ONLY the answer in the requested format (usually a number with 2 decimal places). No explanation, no punctuation, nothing else.';
  const user = `${instructions}\n\nProblem:\n${cleanedChallenge}`;

  // deterministic arithmetic first — glm answers 0.00 when unsure, which fails
  const computed = solveArithmetic(cleanedChallenge);
  if (computed !== null && Number.isFinite(computed)) {
    let fmt = computed.toFixed(2);
    if (/2 decimal/i.test(instructions || "")) return fmt;
    return String(computed);
  }
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