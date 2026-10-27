// topics.js — trend discovery: crawl sources, pick an emerging topic, match a
// catalog product so the bot's marketing rides what's being discussed instead
// of blind rotation. Catalog updates land via PRODUCTS_REGISTRY_URL below.
// All crawl failures degrade to "no topic found" — the cycle keeps its normal
// product-rotation path; discovery must never fail a run.

const STOPWORDS = new Set(
  ("a an and are as at be but by can did do for from get got had has have how i in is it its just me my no not of on or our out so than that the then they this to too up was we what when which who why will with would you your about after all any because been before being could doing done during each even ever every few first good great here him his into let like made make many more most much need new now off only other over really said same should since some still such take than thing things think time times today use used using very via way well went were while without yeah yet").split(" ")
);

const BAN_RX = /crypto|bitcoin|btc|usdc|blockchain|wallet|payment|stripe|paypal|x402/i;

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && t.length <= 24 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

// Score single tokens and bigrams across post titles. A "topic" must appear
// at least MIN_MENTIONS times (unless HN-sourced, where one title is a trend).
export function pickTrendTopic(posts, recentTitles = [], { minMentions = 2 } = {}) {
  const clean = (posts || []).filter((p) => p && p.title && tokenize(p.title).length >= 2);
  if (!clean.length) return null;

  const recent = (recentTitles || []).map((t) => String(t || "").toLowerCase());
  const singles = new Map();
  const bigrams = new Map();
  for (const p of clean) {
    const toks = [...new Set(tokenize(p.title))];
    for (const t of toks) {
      const e = singles.get(t) || { mentions: 0, score: 0 };
      e.mentions += 1;
      e.score += (p.upvotes || 0) + 2 * (p.comments || 0) + 1;
      singles.set(t, e);
    }
    for (let i = 0; i < toks.length - 1; i++) {
      const bg = `${toks[i]} ${toks[i + 1]}`;
      const e = bigrams.get(bg) || { mentions: 0, score: 0 };
      e.mentions += 1;
      e.score += (p.upvotes || 0) + 2 * (p.comments || 0) + 3; // bigram = specific phrase, bonus
      bigrams.set(bg, e);
    }
  }

  const candidates = [...bigrams.entries(), ...singles.entries()].filter(
    ([phrase, e]) =>
      e.mentions >= minMentions &&
      !recent.some((t) => t.includes(phrase)) &&
      !BAN_RX.test(phrase)
  );
  if (!candidates.length) return null;

  candidates.sort((a, b) => b[1].score * b[1].mentions - a[1].score * a[1].mentions);
  const best = candidates[0];
  // Prefer a specific bigram over its generic parts.
  const better = candidates.find(([phrase, e], ) => phrase.includes(" ") && e.mentions >= Math.max(2, Math.floor(best[1].mentions * 0.75)));
  const [phrase, e] = better || best;
  return { phrase, mentions: e.mentions, sources: clean.length };
}

// Match a topic phrase against the catalog: keyword overlap between topic
// tokens and each product's name/category/description. Needs >= 2 distinct
// overlapping keywords (or 1 multi-word hit) so it's a real fit, not a stretch.
export function matchProduct(topicPhrase, products) {
  const toks = new Set(tokenize(topicPhrase));
  if (!toks.size || !products?.length) return null;
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    if (BAN_RX.test(p.name) || BAN_RX.test(p.category)) continue;
    const words = new Set(tokenize(`${p.name} ${p.category} ${p.description}`));
    let overlap = 0;
    for (const t of toks) {
      for (const w of words) {
        if (w === t) {
          overlap += 1;
          break;
        }
        // Stem-level match only for substantial tokens (>=6 chars each) —
        // loose prefixing matches junk ("post"~"postgres", "back"~"backup")
        // and force-stitches unrelated products onto topics.
        if (t.length >= 6 && w.length >= 6 && (w.startsWith(t) || t.startsWith(w))) {
          overlap += 1;
          break;
        }
      }
    }
    const score = overlap;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 2 ? best : null;
}

// Keyless HN front page via Algolia — safe to call, returns [] on any failure.
export async function fetchHackerNewsPosts() {
  try {
    const res = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.hits || [])
      .filter((h) => h.title)
      .map((h) => ({ title: h.title, submolt: "", upvotes: h.points || 0, comments: h.num_comments || 0 }));
  } catch (e) {
    console.warn("[hn] front page fetch failed:", e?.message || e);
    return [];
  }
}

// Optional catalog self-update: fetch PRODUCTS_REGISTRY_URL (array of
// {name, description, category, url?}), keep non-banned entries, and merge
// names not already in the live catalog. Returns { merged, added } where
// merged is the full new catalog; the caller decides how to persist it.
export async function syncCatalogFromRegistry(registryUrl, currentProducts) {
  if (!registryUrl) return { added: [], merged: currentProducts, error: null };
  try {
    const res = await fetch(registryUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body?.products || body?.tools || [];
    const known = new Set((currentProducts || []).map((p) => p.name.toLowerCase()));
    const added = [];
    for (const it of items) {
      const name = String(it?.name || "").trim();
      const description = String(it?.description || "").trim();
      const category = String(it?.category || "").trim() || "Dev Tools";
      const url = it?.url;
      if (!name || description.length < 30) continue;
      if (BAN_RX.test(name) || BAN_RX.test(category) || BAN_RX.test(description)) continue;
      if (url && !/^https:\/\//.test(url)) continue;
      if (known.has(name.toLowerCase())) continue;
      known.add(name.toLowerCase());
      added.push({ name, description, category, ...(url ? { url } : {}) });
    }
    return { added, merged: [...(currentProducts || []), ...added], error: null };
  } catch (e) {
    return { added: [], merged: currentProducts, error: e?.message || String(e) };
  }
}