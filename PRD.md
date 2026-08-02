# PRD: Live Sandbox Demo — "Deploy Now" → Real Tenki Sandbox + Browser Terminal

**Status:** Phase 1 shipped & e2e-verified 2026-08-01 (broker + Deploy Now + Open Terminal live) · **Owner:** Colin · **Last updated:** 2026-08-01

> Implementation notes: broker lives in `broker/` (Node, `@tenkicloud/sandbox@0.5.4`); ttyd runs on port **8080** inside demo sandboxes — the platform rejects exposing non-standard ports (7681 fails with `invalid_argument`; the base image runs its own ttyd there). Frontend falls back to an inline "open it ↗" link when a popup blocker eats the terminal window.
>
> Shipped beyond original P0 scope (2026-08-01): **self-destruct** (DELETE /api/demo-sessions/:id + status-line button), **agent pills wired** (claude/codex/opencode launch in the browser terminal — all three ship in the base image), and **Build wired** (agent selector + prompt → terminal running the chosen agent with that prompt, passed base64 so visitor text never touches shell quoting). P2 item 11 is therefore partially delivered.
>
> **Kimi K3 toggle** (2026-08-01): toggles in both the Build panel and 02 Access route agent launches through [kimi-relay](https://github.com/opencolin/kimi-relay) to Kimi K3 on Nebius Token Factory — no agent login. Both toggles share one state and are **on by default** (off only if the visitor switches it off). Broker launches `kimirelay <agent>` with `NEBIUS_API_KEY` (+ `TAVILY_API_KEY` when set) from its env; relay preinstalls in each demo sandbox right after creation (bun ships in the base image, install ≈1.5s).
>
> **Known trade-off — audited 2026-08-01:** the Nebius and Tavily keys are trivially readable by any visitor: `/tmp/launch.sh` holds them in plaintext (mode 755), visitors have passwordless sudo in their own VM, and Claude Code's own Bash tool will print them on request. There is no way to hide a secret in a VM the visitor controls as root. Confirmed *not* exposed: `TENKI_API_KEY` never enters demo sandboxes (verified: zero hits). With the toggle now default-on, every visitor agent session spends the Nebius key — use a spend-capped, rotatable key. The durable fix is running the relay centrally on the hosting sandbox and issuing per-session tokens to sandboxes (see P2).

## Problem Statement

The tenki-redesign site sells "sandboxes in an instant," but every button on it is a mock — `fakeBuild()` swaps button text for 1.6 seconds and the Access buttons do nothing. A visitor evaluating Tenki can read about instant sandboxes but can't feel one, and the gap between the marketing claim and a clickable proof is exactly where infra buyers bounce. Making "Deploy Now" mint a real sandbox and "Open Terminal" drop the visitor into it turns the landing page into the product demo — the strongest possible argument for an infrastructure product.

## Goals

1. **Prove the product claim in one click** — a first-time visitor gets a real, running sandbox from "Deploy Now" with no signup, no CLI, no docs.
2. **Terminal in under 10 seconds** — from clicking "Open Terminal" to an interactive shell prompt in a new window (stretch: < 5s via prebaked template).
3. **Self-serve conversion signal** — measure how many visitors who click "Deploy Now" reach a live terminal (target: > 60% of deploy clicks reach a running sandbox; > 30% open the terminal).
4. **Bounded cost** — demo sandboxes are small, short-lived, and capped, keeping worst-case spend predictable (< $X/day hard ceiling via caps, X set by finance/owner).

## Non-Goals

- **User accounts / auth on the site** — the demo is anonymous by design; requiring signup would defeat the "no setup" claim. (The 03 Review / GitHub sign-in step stays a mock.)
- **"Open VS Code" and "Create SSH Tunnel" buttons** — same pattern, separate follow-ups. SSH tunnel requires client-side key handling; VS Code likely maps to the underdocumented OpenCode integration (see Open Questions). Keeping v1 to one access path keeps the surface auditable.
- **Running user-supplied build prompts** — the 01 Build prompt box keeps its current mock behavior in v1. Piping arbitrary visitor prompts into provisioning is a different feature (and a different abuse surface).
- **Persistent sandboxes / volumes / snapshots for visitors** — demo sandboxes evaporate; "it turns to sand" is the brand.
- **Replacing the site's hosting model** — the site stays a static page on its existing Tenki sandbox; we add a thin API beside it, not a framework rewrite.

## User Stories

- As a **prospective customer**, I want clicking "Deploy Now" to provision a real sandbox while I look at the deploy page, so that the "instant sandbox" claim is demonstrated rather than described.
- As a **prospective customer**, I want "Open Terminal" to open a new window with a live shell inside my sandbox, so I can poke around a real machine (run `htop`, `uname`, install things) and judge the product myself.
- As a **prospective customer**, I want visible provisioning state (creating → running, session ID, specs), so the page feels like a console, not a brochure.
- As a **returning visitor in the same browser session**, I want the page to reuse my still-running sandbox instead of minting a new one, so refreshing doesn't burn quota.
- As a **visitor whose sandbox expired**, I want a clear "this sandbox turned to sand — deploy another" state, so a dead terminal never looks like an outage.
- As the **site owner**, I want per-IP and global caps with a kill switch, so a traffic spike or abuse can't run up unbounded VM spend.

## Design / Architecture (the plan)

### The one structural change

The site is a static `index.html` with no backend, and `TENKI_API_KEY` must never reach the client. So v1 adds a **thin deploy-broker API** that owns the key, colocated on the sandbox that already hosts the site (dogfooding: the demo runs on the product it demos). The Python `http.server` is replaced by one small Node process (Hono or Express) that serves the static files **and** three API routes, using the official `@tenkicloud/sandbox` TypeScript SDK:

```
POST /api/demo-sessions        → create demo sandbox, return {id, state}
GET  /api/demo-sessions/:id    → state for polling {state, specs, createdAt, expiresAt}
POST /api/demo-sessions/:id/terminal → start ttyd (if needed), expose port, return {url, expiresAt}
```

### Demo sandbox shape

| Setting | Value | Why |
|---|---|---|
| CPU / RAM | 1 core / 1024 MB | Enough for a shell demo; cheapest unit |
| Sticky | **No** | Demos must evaporate |
| Idle timeout | 15 min | Visitor walks away → auto-pause |
| Max duration | 60 min | Hard stop regardless of activity |
| Inbound | Enabled | Required for terminal preview URL |
| Metadata | `demo=true`, `source=landing-page`, hashed IP | Filtering, cleanup, abuse tracing |

### Terminal approach (v1): ttyd + exposed port

On first "Open Terminal" click, the broker runs `ttyd` inside the sandbox (backgrounded, per the exec caveat: `>/tmp/ttyd.log 2>&1 </dev/null &`), exposes its port with a TTL matching the sandbox's remaining lifetime, and returns the `previewUrl` from the expose call (docs: never construct hostnames). The frontend does `window.open(url)`.

**Terminal security:** an exposed ttyd is an unauthenticated shell. Required mitigations: (a) ttyd runs with basic-auth credentials minted per-session by the broker and embedded in the returned URL, so the link is not usable by URL-guessers; (b) expose TTL ≤ sandbox lifetime; (c) the shell runs as the unprivileged `tenki` user in a disposable, isolated VM — blast radius is the sandbox itself. Outbound egress stays enabled in v1 (it's part of the demo: `pip install` should work) — revisit if abused.

**Rejected for v1:** xterm.js + WebSocket proxy over the SDK's raw SSH byte-stream. More control (no exposed port at all) but meaningfully more code on both ends; it's the v2 path if ttyd proves limiting. OpenCode (`enableOpenCode`) is underdocumented — evaluated separately for the VS Code button.

### Frontend changes (all inside existing `index.html`)

- `showDeploy()` additionally calls `POST /api/demo-sessions` (unless `sessionStorage` holds a live session ID) and starts polling.
- Step 01 panel gains a small status line: `creating…` → `● running · sbx-019f… · 1 vCPU / 1 GB · turns to sand in 58m`.
- "Open Terminal" button: disabled until state = RUNNING; click → `POST …/terminal` → `window.open`. Errors and expiry render an inline "deploy another" state, never a dead button.

### Abuse & cost controls

Worst-case spend is already bounded at the platform level: the Tenki Cloud workspace has a **hard concurrency limit of 5 VMs**. Since the site-hosting sandbox permanently occupies one slot, the demo has **at most 4 concurrent demo sandboxes** — cost control is solved by the platform, and the remaining work is fair sharing and UX at a small capacity:

- Per-IP: max 1 concurrent demo sandbox, max 5 creations/hour — with only 4 slots, one visitor must not hold several.
- Broker treats "workspace at limit" as the expected case, not an error: friendly "demo at capacity — sandboxes free up within minutes" state, and creation requests must never evict or touch the hosting sandbox (filter by `demo=true` metadata for every lifecycle operation).
- Kill switch: `DEMO_ENABLED=false` env var → buttons fall back to current mock behavior.
- Reaper: broker sweeps sessions tagged `demo=true` past max duration — with 4 slots, promptly reclaiming expired sandboxes is what keeps the demo usable, so consider shortening idle timeout to 10 min.

## Requirements

### P0 — Must have

1. **Real sandbox on Deploy Now.** Given a visitor under rate limits, when they click "Deploy Now" (nav or hero), then a demo sandbox is created with the shape above and the deploy page shows live state within 2s of the API response. Session ID stored in `sessionStorage`; refresh reuses a still-RUNNING session.
2. **Live browser terminal.** Given a RUNNING demo sandbox, when the visitor clicks "Open Terminal," then a new window shows an interactive shell in that sandbox within 10s, protected by per-session credentials, expiring with the sandbox.
3. **API key never client-side.** All Tenki API calls originate from the broker; the served HTML/JS contains no credentials. (Verified by grep on served assets in CI.)
4. **Caps + kill switch** as specified above, with structured logs per creation (hashed IP, session ID, outcome).
5. **Honest failure states.** Capacity, rate-limit, creation-failure, and expiry each render distinct, friendly UI states; no silent dead buttons.

### P1 — Nice to have

6. **Prebaked template/snapshot** with ttyd already running at boot → terminal open in < 5s with zero first-click setup. (Downgraded from launch-relevant to minor optimization: ttyd ships in the base image, verified 2026-08-01.)
7. **Countdown + "turns to sand" moment** — live remaining-time in the status line; on expiry the deploy panel plays the existing sand-dissolve animation. On-brand delight.
8. **Basic funnel metrics** emitted from the broker (deploy clicks, sandboxes created, terminals opened, time-to-terminal) to logs or a counter endpoint.

### P2 — Future considerations (design for, don't build)

9. **xterm.js in-page terminal** over SDK SSH byte-stream (no exposed ports; terminal embedded in step 02 instead of a popup).
10. **"Open VS Code"** via OpenCode integration; **"Create SSH Tunnel"** with ephemeral keys. Broker routes are namespaced (`/api/demo-sessions/:id/terminal`) so `/vscode` and `/ssh` slot in.
11. **Build-prompt wiring** — the 01 prompt box parameterizing the sandbox (with heavy input constraints).

## Success Metrics

**Leading (first 2 weeks):** deploy-click → sandbox-RUNNING conversion > 60%; sandbox → terminal-opened > 30%; median time-to-terminal < 10s (P1 target < 5s); creation error rate < 5%.
**Lagging (quarter):** demo-driven signups/"Talk to sales" contacts (add `?src=demo` attribution); demo cost per terminal-opened session trending down; zero abuse incidents requiring the kill switch.
**Measurement:** broker structured logs; evaluate at 1 week and 1 month.

## Open Questions

1. ~~Daily spend ceiling / global cap?~~ **Resolved 2026-08-01:** the workspace's platform-level limit of 5 concurrent VMs bounds spend; 4 slots are available for demos (the hosting sandbox uses one). **Decision (owner):** launch with 4; a plan upgrade to 25 sandboxes is available and will be taken if launch traffic shows sustained "at capacity" states — the broker's capacity handling must not hardcode the limit (read it from config/env) so the upgrade is a config change, not a code change.
2. ~~Does the base image include `ttyd`?~~ **Resolved 2026-08-01:** yes — `/usr/local/bin/ttyd` ships in the base image (verified on a live session). No install step needed; the 10s P0 target is achievable without a template prebake, and P1 #6 drops to a minor optimization.
3. **[Tenki platform]** Preview-URL TTL semantics: can TTL be set to match remaining session lifetime, and does pause/resume invalidate it? (Non-blocking; affects reconnect UX.)
4. **[Product]** Should the paused state (idle timeout at 15 min) offer "resume" to the visitor, or is expired-only simpler and more on-brand? (Non-blocking.)
5. **[Eng]** Rate-limit state storage: in-process memory is fine for one broker instance — confirm we're staying single-instance. (Non-blocking.)

## Phasing

- **Phase 1 (build, ~days):** Node broker replacing `http.server` (static + 3 routes), P0 items 1–5, ttyd installed at first terminal click. Ship behind `DEMO_ENABLED`.
- **Phase 2 (fast follow):** template/snapshot prebake (P1 #6), countdown/sand moment (P1 #7), funnel metrics (P1 #8).
- **Phase 3 (separate specs):** VS Code / SSH tunnel buttons, in-page terminal, build-prompt wiring.

No hard external deadline, no blocking technical unknowns, and no launch gates — the terminal path (ttyd) is verified against a live sandbox, and spend is bounded by the platform's 5-VM workspace limit. Phase 1 can start immediately.
