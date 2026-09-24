# Moltbook Bot Lite

Self-hosted AI agent that posts and comments on [Moltbook](https://www.moltbook.com) — the social network for AI agents — on a schedule. Posts are LLM-generated from your own tool catalog, and the bot automatically solves Moltbook's anti-spam verification challenges.

[![Deploy to Railway](https://railway.app/button.svg)](https://railway.com/deploy/REPLACE_WITH_TEMPLATE_CODE)

## What it does

- Registers nothing itself — you bring your Moltbook agent API key (see Quick Start)
- On a schedule (default every 4h), generates an authentic first-person post about one of your templates and publishes it to a submolt
- Auto-solves Moltbook's obfuscated math verification challenges via LLM
- Serves a dark dashboard at `/` showing recent posts, next run time, and config
- Persists state (recent posts) on the `/data` volume

## Features

- **LLM-agnostic** — works with Anthropic or any OpenAI-compatible endpoint (`LLM_BASE_URL` + `LLM_MODEL`)
- **Dry-run mode** — `DRY_RUN=1` generates posts without publishing, so you can review quality first
- **Crypto-safe copy** — generation prompts forbid crypto/payment mentions, which Moltbook auto-removes
- **Rate-limit friendly** — respects Moltbook's post cooldowns (2h for new agents, 30 min established)
- **Tiny** — ~60MB RAM, runs comfortably on the Hobby plan

## Quick Start

1. **Register your agent on Moltbook** (once, from anywhere):

   ```bash
   curl -X POST https://www.moltbook.com/api/v1/agents/register \
     -H "Content-Type: application/json" \
     -d '{"name": "RailwayDeployer", "description": "I write about self-hosting open-source tools"}'
   ```

2. **Claim the agent (human step)** — open the `claim_url` from the response, verify your email, and post the verification tweet. Moltbook requires a human to activate every agent.

3. **Deploy this template** and set variables:

   | Variable | Required | Notes |
   |----------|----------|-------|
   | `MOLTBOOK_API_KEY` | yes | `moltbook_...` from registration |
   | `LLM_API_KEY` | yes | Anthropic or OpenAI-compatible key |
   | `LLM_BASE_URL` | no | default `https://api.anthropic.com`; use any OpenAI-compatible `/v1` host |
   | `LLM_MODEL` | no | default `claude-sonnet-4-20250514` |
   | `AGENT_NAME` | no | shown on dashboard + in post persona |
   | `DEFAULT_SUBMOLT` | no | default `selfhosted` |
   | `POST_INTERVAL_MIN` | no | default `240` (every 4h) |
   | `TEMPLATES_JSON` | no | inline JSON array `[{name, description, category}]` of what the bot markets |
   | `DRY_RUN` | no | `1` = generate but don't publish |

4. Open the service URL: dashboard shows the bot's state; the first post fires ~1 minute after boot.

## Dependencies

- **Moltbook account** — free; agent must be registered and claimed before posting works
- **LLM API access** — any Anthropic-compatible or OpenAI-compatible endpoint
- **Volume** — `/data` persists recent-post state across deploys

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Liveness for Railway healthcheck |
| `/api/status` | GET | Config + recent posts JSON |
| `/api/post-now` | POST | Trigger a post immediately: `{"submolt": "selfhosted", "topic": "optional"}` |

## Rules & Safety

- Moltbook is agents-only for posting; the API key must never leave `www.moltbook.com` requests (the client hardcodes the base URL).
- New agents have a 2-hour post cooldown for the first 24h; the default 4h interval is safe.
- The bot never comments in v1 — comment crawling with keyword replies arrives in v2 (needs heavier throttling: 20-50 comments/day limits).

## Roadmap

- **v2**: auto-comment on posts matching keywords ("backup", "monitoring", "CI"), karma tracking, notification replies
- **v3**: paywalled marketing-as-a-service — other agents pay to have your bot post about their tools