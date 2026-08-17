# Sandboxmaxxing — two AI engineering teams, one prompt, 24 sandboxes

**Status:** Spec · **Owner:** Colin · **Last updated:** 2026-08-17

One visitor prompt. The broker fills the entire workspace — 24 demo sandboxes on
the 25-slot plan (the host keeps one) — with two competing engineering teams of
12 agents each. Both teams build the same thing; both publish to a live URL; a
judge picks the winner on a public scoreboard. It is the "it turns to sand"
story at maximum scale: an org-chart's worth of compute materializes, ships, and
dissolves.

Distinct from **benchmark mode** (specced separately): benchmark mode fans one
prompt across harness×model combos to *compare* them; sandboxmaxxing composes
models into *teams* that cooperate internally and compete externally.

## Teams

Rosters come from [openengineer](https://github.com/colygon/openengineer)
(12 roles, one per AI lab). Same 12 roles per team:

| Seat | Role (openengineer) | Duty in the run |
|---|---|---|
| architect | Main orchestrator | Decomposes the prompt into tasks.md, assigns, arbitrates |
| engineer | Autonomous deep worker | Core implementation |
| strategist | Deep reasoning | Hard sub-problems handed off by architect |
| librarian | OSS code & docs search | Finds libraries/snippets; writes CITATIONS.md |
| researcher | Broad knowledge synthesis | Requirements → acceptance criteria |
| analyst | Fast codebase exploration | Reviews teammates' pushes, files issues |
| designer | Visual/UI tasks | Styling, layout, assets |
| product-manager | Strategic planning | Scope cuts, keeps team shipping by deadline |
| consultant | Architecture advisor | Advises architect; no direct commits |
| qa-engineer | Plan reviewer | Tests against acceptance criteria |
| technical-lead | Plan executor | Merges, resolves conflicts, owns the publish |
| junior-architect | Lighter coding tasks | Small tasks, README, cleanup |

All 24 seats run the **opencode** harness (openengineer is built for OpenCode,
and opencode is the one harness that works with both free model sources). No
Anthropic/OpenAI logins; no Nebius dependency in free mode.

## Models — free mode (default)

Per Colin: seats use **free opencode models or OpenRouter models** — not paid
Nebius. Two free pools, measured this session:

- **opencode-native free** (no key at all, verified): `big-pickle`,
  `deepseek-v4-flash-free`, `hy3-free`, `mimo-v2.5-free`,
  `nemotron-3-ultra-free`. (`north-mini-code-free` is broken — excluded.)
- **OpenRouter `:free`** (needs our key → rides the broker relay; 15
  tool-calling models incl. `nvidia/nemotron-3-ultra-550b-a55b:free`,
  `nemotron-3.5-lightning:free`, `gemma-4-31b-it:free`, `laguna-s-2.1:free`,
  `gpt-oss-20b:free`, …).

Seat mapping per team: **5 seats on opencode-native** (one per model) + **7 on
OpenRouter free**. Team B draws 7 *different* OpenRouter models than Team A
(14 ≤ 15 available), so no model appears twice on the OpenRouter key and the
teams have genuinely different lineups. Architect/technical-lead get the
strongest models (nemotron-3-ultra variants); junior seats get the small ones.

**The binding constraint is OpenRouter's free rate limit: 20 req/min shared
across the whole key** (measured docs; 50/day under $10 lifetime credits,
1000/day above). 14 OR-backed agents sharing 20 rpm ≈ 1.4 req/min each — an
agent turn is several requests, so OR seats will visibly *think in queue*.
Mitigations: broker staggers agent kickoff (30s apart), relay returns 429s
untouched so opencode's own backoff engages, and the 10 native seats (5/team)
carry no cap at all. If the account is on the 50/day tier, free mode does not
survive one run — **the 1000/day tier ($10 lifetime credits) is a
prerequisite**. Open question below.

## Models — frontier mode

Same structure, better brains, real spend. Seats map to OpenRouter's **paid**
catalogue (one key already covers Claude, GPT, Gemini, DeepSeek, etc.) plus
Kimi K3 via Nebius for a couple of seats. No `:free` caps apply. Spend is
bounded by existing relay guards — per-session call cap (`MAX_RELAY_CALLS`,
600) and `max_tokens` clamp (32k) — plus a per-mode `RELAY_MODELS` allowlist so
a prompt-injected agent cannot upgrade itself to o3-pro. Ballpark at Kimi-like
pricing: ~$0.05–0.15/agent-session → **$1–4 per free-adjacent run; frontier
models 5–20× → budget $10–50 per frontier run** and surface the estimate in the
UI before launch.

## How a run works

1. `POST /api/maxx {prompt, mode}` → broker checks 24 slots free, else 409
   with current occupancy. Creates run id, then sandboxes staggered 30s apart
   (rate limit + createDemoSession reuse of existing caps, but matrix-created
   sessions bypass MAX_PER_IP and carry `maxx=<runId>` + `team=A|B` +
   `seat=<role>` metadata).
2. Each sandbox gets the existing per-session tokens (expose + relay) plus:
   pinned model (stored on the tracked entry; relay `forceModel` reads the
   session's pin — today it pins one global model, small change), the
   openengineer role file as the opencode agent config, and TEAM.md describing
   the roster, the shared repo, and the deadline.
3. **Team workspace:** each team's architect sandbox hosts a bare git repo
   served over HTTP on port 9000 (`git http-backend` behind the exposed
   preview URL). Teammates clone/push via that URL. tasks.md in the repo is
   the coordination bus: architect writes tasks; agents claim by commit. No
   new infrastructure — it is the same expose primitive the deploy flow uses.
4. Agents run `opencode --auto` in ttyd (every terminal watchable live — that
   is the spectacle), working until done or the run deadline (default 30 min;
   sandboxes created with maxDuration = deadline so the platform enforces it).
5. **Publish:** each technical-lead runs the app and `tenki-publish 3000`.
   Broker records both URLs.
6. **Judging:** no 25th sandbox exists, so the judge is a broker-side LLM call
   through the relay (no VM): it fetches both published URLs, both repos'
   summary stats (commits, files, LOC, test results), and scores against the
   researcher's acceptance criteria. Verdict + both URLs go on the scoreboard.
   Tie-breaker/appeal: the visitor can override the judge with one click —
   they were watching.
7. Run ends: all 24 self-destruct (existing DELETE), scoreboard persists in
   broker state.

## UI

New "sandboxmaxxing" panel on the deploy page (and linked from ixio.com):
prompt box, Free/Frontier switch (frontier shows the budget estimate), a
**2×12 grid of live seat cards** — role, model, state dot, terminal link — a
countdown, then the two published URLs side-by-side with the verdict. The
grid of 24 live terminals is the marketing asset.

## Caps, failure modes, honesty

- **Occupancy:** a run consumes every demo slot for up to 30 min. The normal
  Deploy Now flow returns "demo at capacity" meanwhile — acceptable for a
  spectacle feature, but runs are queued (one at a time) and the button shows
  live occupancy before launch.
- **Seat failure is expected** (model 429s, agent wedges): seats retry twice,
  then the card goes grey ("turned to sand early"); a team plays shorthanded
  rather than aborting the run. The judge scores what shipped.
- **Cost floor (free mode):** models $0, but 24 VMs × 30 min of 1cpu/1024mb is
  real Tenki spend — the plan upgrade is the gate, not tokens.
- **Prompt injection scope:** each agent holds only its own session tokens;
  a hostile prompt can waste its own team's time, not read another sandbox or
  any real key. Judge input is fetched server-side, never executed.

## Prerequisites & open questions

1. **[Colin]** 25-sandbox plan upgrade — hard prerequisite (today: 5).
2. **[Colin]** OpenRouter account tier: are lifetime purchased credits ≥ $10?
   (`usage: $6.76` observed; *purchased* amount unknown.) Free mode needs the
   1000/day tier.
3. **[measure]** opencode-native free models: rate limits are unpublished —
   run 5 concurrent sessions and observe before trusting 10 seats to them.
4. **[eng]** Relay: per-session model pin (small); `/api/maxx` + run state
   machine + stagger + judge call (the real work); git-over-HTTP seat image
   check (`git http-backend` ships in the base image? verify).
5. **[product]** Deadline default (30 min?) and whether visitors can watch
   both teams or only one until the reveal.

## Phasing

- **P0 — one team of 12, no competition:** proves coordination (shared repo,
  tasks.md, publish). Fits the *current* 5-slot plan at 4 seats for a dry run
  of the machinery.
- **P1 — two teams + judge + scoreboard** after the plan upgrade.
- **P2 — spectacle polish:** shareable replay, per-seat token/cost meters,
  frontier mode.
