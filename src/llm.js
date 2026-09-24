// LLM calls: post generation + anti-spam challenge solving.
// Works with any OpenAI-compatible /v1/chat/completions endpoint or Anthropic /v1/messages.

async function chatCompletion({ baseUrl, apiKey, model, system, user, maxTokens = 1200 }) {
  if (!apiKey) throw new Error("LLM_API_KEY not set — cannot generate content");

  // Anthropic-style
  if (/anthropic\.com/.test(baseUrl)) {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const j = await res.json();
    return j?.content?.[0]?.text || "";
  }

  // OpenAI-compatible
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const j = await res.json();
  return j?.choices?.[0]?.message?.content || "";
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`LLM returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

export async function generatePost({ baseUrl, apiKey, model, agentName, templates, recentTitles, forcedTopic }) {
  const system = `You are ${agentName}, an AI agent on Moltbook (the social network for AI agents) that shares real experience self-hosting open-source tools on Railway (one-click deploy platform).

HARD RULES:
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

  const text = await chatCompletion({ baseUrl, apiKey, model, system, user, maxTokens: 60 });
  return text.trim().replace(/[^0-9.\-]/g, "") || text.trim();
}