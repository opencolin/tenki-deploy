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

## Teams are config, not code

Team composition is a **template file** in `broker/teams/*.json`, versioned in
the repo — trying a different org chart is editing a file, never touching the
broker. A run names its templates (`teamA`/`teamB`, defaulting to
`openengineer-classic` mirror-match), and templates need not be 12 seats or
symmetric: "12 juniors vs 4 seniors" is a legal matchup, bounded only by
`teamA.seats + teamB.seats ≤ free slots`. One-off experiments can pass an
inline roster in the POST body without saving a file.

```jsonc
// broker/teams/<name>.json
{
  "name": "openengineer-classic",
  "description": "12 roles, one per AI lab — colygon/openengineer",
  "seats": [
    { "role": "architect",  "duty": "Decompose the prompt into tasks.md; assign; arbitrate.",
      "pool": "native-free", "modelHint": "strongest" },
    { "role": "engineer",   "duty": "Core implementation.", "pool": "openrouter-free" }
    // …one entry per seat; "pool" picks the model source per mode
    // (native-free | openrouter-free | frontier), or "model" pins one exactly.
  ]
}
```

The broker assigns concrete models at launch: it walks each team's seats,
draws distinct models from the seat's pool for the active mode (Team B drawing
after Team A so lineups differ), honors explicit `model` pins, and applies
`modelHint: "strongest"` seats first. The per-seat `duty` text becomes that
sandbox's role file, so a template fully defines both *who is on the team* and
*what each seat is told to do*.

### Default template: `openengineer-classic`

From [openengineer](https://github.com/colygon/openengineer)
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

## The real ceiling is preview URLs, not VMs (discovered 2026-08-18)

`client.getUsage()` (`@tenkicloud/sandbox`) reports three limits. The
VM/session cap is **`max_concurrent_jobs`** — confusingly named, but its label
is "Active sessions" and its helpText is "Active sessions hold live VM
resources" — at **100** (plenty). The binding limit for a *watchable* run is
the other one: **`preview_urls_per_workspace` = 20**. Every watchable seat
exposes one preview URL (its ttyd viewer), so:

- **A 24-seat run needs 24 preview URLs and cannot fit under the 20 cap** — the
  VM-count upgrade doesn't help. The two-team × 12 vision needs either a
  preview-URL limit increase, or a design where seats *don't* each hold a
  preview URL (stream their logs through the broker instead of one ttyd per
  seat, exposing viewers only on demand).
- The capacity guard now reads `preview_urls_per_workspace` (the binding
  limit) minus `MAXX_RESERVED_PREVIEWS` headroom, and 503s with the real
  numbers. The earlier code looked for a key named `active_sessions` — the
  SDK docstring's name, but only the *label*; the actual key is
  `max_concurrent_jobs` — so the `.find()` missed it and silently defaulted
  to 5. The VM cap itself (100) is not the constraint; preview URLs (20) are.

## P0 build notes (shipped 2026-08-18)

Broker orchestrator in `broker/maxx.js` (factory handed the broker's client +
tracked map + helpers), routes `POST/GET/DELETE /api/maxx` + `GET /api/maxx`
(list templates). Teams are `broker/teams/*.json`. Verified live:

- **Machinery works end to end:** a run loads a template, assigns distinct
  native-free models (strongest → `modelHint` seats), creates sandboxes tagged
  `maxx=<runId>`, launches each seat's opencode agent under a live ttyd viewer,
  and returns per-seat terminal URLs. Capacity guard 503s when seats > free
  slots. `notifyExpose` records the architect's published URL as the run's
  deliverable. `DELETE` tears the whole run down.
- **25-slot upgrade confirmed** (a 4-seat launch cleared the capacity guard).
- **Known reality — free-model completion is variable.** In one-shot
  `opencode run` mode a tiny free model sometimes does the minimal thing (write
  one file and stop) rather than the full serve+publish, and occasionally
  ignores `cd`/path instructions. The same model/flags completed a full
  build+publish in earlier tests, so it's variance, not breakage. Mitigations
  for P0.5: put the architect (the seat that must publish) on a stronger model
  or interactive mode; make the publish step a broker-driven phase rather than
  trusting the agent to reach it.

Not yet built (next increments): the **frontend team grid**, real
**cross-sandbox coordination** (the git-http-backend CGI transport is verified
working on loopback but not wired — a broker-hosted blackboard is the more
robust alternative), and **two-team competition + judge** (P1).

## Repo input + gortex indexing (shipped 2026-08-19)

A run may name an existing repo (`POST /api/maxx {..., "repo":"https://…"}`).
The broker validates it (public **https** git URL only — no ssh/file scheme,
no inline creds, since seats clone without credentials) and every seat then:

1. clones the repo into `/home/tenki/work`,
2. installs **gortex** (single ~50 MB Go binary, ~2 s), starts its daemon, and
   `gortex track`s the clone (a 217-file repo indexes to ~1,920 nodes in ~25 s),
3. gets an `opencode.json` MCP entry pointing at `gortex mcp`, so the agent can
   navigate the code graph (symbols, callers, call chains) instead of reading
   whole files — up to ~50× cheaper on context.

Each seat indexes its own clone (100 % local, no cross-sandbox coordination).
Verified live: clone → gortex install+index → `opencode mcp list` shows gortex
**connected** → the agent calls `gortex_search`. Whether a given free model
prefers the graph over file reads is model behaviour; the infra delivers it.

**Autonomous-agent fix (important):** ttyd runs its command *per browser
connection*, so running the agent directly under ttyd made it start only when
watched and die on disconnect — fine for the human demo terminal, wrong for a
team agent. Seats now run the agent in the background (`nohup`, logging to
`/tmp/agent.log`) and ttyd serves `tail -f` of that log: the agent runs to
completion regardless of viewers. Verified: a seat's agent ran and produced
output with **no viewer connected**.

Fork/push (writing results back to GitHub) is deferred — it needs the user's
GitHub token, a separate credential decision.

## Watch drops into the live opencode TUI (2026-08-19)

Seats run opencode's **TUI** in a detached **tmux** session (`tmux new-session
-d -s agent 'opencode --auto --model … --prompt …'`), not `opencode run` piped
to a file. The file path prints a bare `$ command` transcript that reads like a
shell; the TUI in a real pty is the live interface. tmux makes it both
autonomous and attachable. On-demand **watch** now runs `tmux attach -rt agent`
(read-only) under ttyd, so opening a seat drops into the running opencode —
code being written live, token meter, model, `esc interrupt` — instead of a log
tail. tmux (absent from the base image) installs in ~5s via apt at seat start.
Verified in-browser: the watch URL shows the live TUI writing the app.

## Two teams, Frontier, headless seats, judge (shipped 2026-08-19)

- **Headless seats.** Seats no longer each hold a ttyd preview URL — they run
  the agent via `nohup` and expose nothing. A full 24-agent run costs **zero**
  preview URLs; only each team's shipped app takes one. Verified: 8 seats up,
  `preview_urls_per_workspace` unchanged at 5/20. This is what makes the
  two-team vision fit under the 20-URL cap.
- **Two teams + judge.** `POST /api/maxx {compete:true}` runs Team A + Team B
  (Team B's free lineup offset so they differ; both architects on the strongest
  model). When both ship (or after `JUDGE_MAX_WAIT_MS`), the broker fetches both
  apps and scores them with a free model **directly — no judge sandbox, no
  preview URL** — storing `run.verdict {winner, reasoning}`. Verified: two teams
  launch headless with distinct lineups; the arena renders A-vs-B with a verdict
  panel.
- **Frontier via the relay.** `mode:"frontier"` points each seat's opencode at a
  custom OpenAI-compatible provider → the broker relay → **Kimi K3 on Nebius**.
  The seat's bearer is its per-session relayToken (32 chars), so the real key
  never enters the VM. Verified end to end: a seat ran `build · moonshotai/
  Kimi-K3` with tool calls through the relay.
- **Frontend.** The site's `#maxx` view has Solo/Compete and Free/Frontier
  toggles; the arena renders one or two team columns of headless seat cards plus
  the judge verdict.

## Phasing

- **P0 — one team, no competition:** proves coordination (shared repo,
  tasks.md, publish) using the `lean-four` template — 4 seats, all on
  opencode-native free models (no keys, no rate caps, no relay), which fits
  the *current* 5-slot plan. Same machinery the 24-seat runs will use.
- **P1 — two teams + judge + scoreboard** after the plan upgrade.
- **P2 — spectacle polish:** shareable replay, per-seat token/cost meters,
  frontier mode.
