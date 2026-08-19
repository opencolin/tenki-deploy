/* Sandboxmaxxing — configurable agent teams building one prompt in parallel
 * sandboxes. Supports two rival teams with a judge, Free (keyless opencode
 * native models) or Frontier (opencode → the broker's relay → Kimi K3, keys
 * server-side), and an optional starting repo (gortex-indexed per seat).
 *
 * Seats run HEADLESS — no per-seat preview URL — so a full 24-agent run costs
 * zero preview URLs; only each team's SHIPPED app takes one. Watchability is a
 * later on-demand add. Teams are data (broker/teams/*.json).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Keyless opencode-native free models (verified unauthenticated). Free mode
// draws seat models here. north-mini-code-free is excluded (it errors).
const NATIVE_FREE = [
  "opencode/nemotron-3-ultra-free",   // strongest — seat 0 (lead) always gets this
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/hy3-free",
];
// Frontier mode routes opencode through the broker relay to a hosted model.
// nebius/Kimi-K3 is genuinely stronger than the free tier; the seat sends its
// per-session relayToken as the bearer, so the real key never enters the VM.
const FRONTIER_PROVIDER = process.env.MAXX_FRONTIER_PROVIDER || "nebius";
const FRONTIER_MODEL = process.env.MAXX_FRONTIER_MODEL || "moonshotai/Kimi-K3";
// $0 judge: a strong OpenRouter free model scores the two builds.
const JUDGE_MODEL = process.env.MAXX_JUDGE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

const APP_PORT = 3000;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
const SEAT_STAGGER_MS = 1500;
const JUDGE_MAX_WAIT_MS = 20 * 60_000;   // judge on whatever shipped by here

export function createMaxx({ client, tracked, saveState, indexRelay, log, json, readJson, brokerUrl }) {
  const DIR = path.dirname(new URL(import.meta.url).pathname);
  const TEAMS_DIR = path.join(DIR, "teams");
  const STATE_FILE = path.join(DIR, "maxx-state.json");

  let runs = {};
  try { runs = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(runs));

  const loadTemplate = (name) => {
    const safe = String(name || "").replace(/[^a-z0-9-]/gi, "");
    if (!safe) return null;
    try { return JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, `${safe}.json`), "utf8")); }
    catch { return null; }
  };
  const listTemplates = () =>
    fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
      try { const t = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, f), "utf8"));
            return { name: t.name, description: t.description, seats: t.seats?.length ?? 0 }; }
      catch { return null; }
    }).filter(Boolean);

  // Seat 0 (lead/architect) always gets the strongest model; others round-robin.
  // Frontier: everyone on the one hosted model (relay pins it). offset shifts
  // Team B's free lineup so the two teams differ.
  function assignModels(seats, mode, offset) {
    if (mode === "frontier") return seats.map(() => `relay/${FRONTIER_MODEL}`);
    const [strong, ...rest] = NATIVE_FREE;
    let i = offset;
    return seats.map((s, idx) =>
      s.model ? s.model
      : idx === 0 || s.modelHint === "strongest" ? strong
      : rest[i++ % rest.length]);
  }

  const token = () => crypto.randomBytes(24).toString("base64url");

  function trackSeat(id) {
    tracked[id] = {
      createdAt: Date.now(), ipHash: "maxx", terminal: null,
      exposeToken: token(), exposeCount: 0,
      relayToken: token(), relayCalls: 0, relayInFlight: 0, maxx: true,
    };
    saveState(); indexRelay();
    return tracked[id];
  }

  // Publish helper (lets a seat expose its OWN app port through the broker).
  function seatEnv(id, entry) {
    const publishHelper =
      "mkdir -p $HOME/.local/bin && cat > $HOME/.local/bin/tenki-publish <<'PUBLISH'\n" +
      "#!/bin/bash\nport=\"${1:?usage: tenki-publish <port>}\"\n" +
      "curl -fsS -X POST \"$TENKI_BROKER_URL/api/demo-sessions/$TENKI_SESSION_ID/expose\" \\\n" +
      "  -H \"x-expose-token: $TENKI_EXPOSE_TOKEN\" -H 'content-type: application/json' \\\n" +
      "  -d \"{\\\"port\\\":$port}\"\nPUBLISH\nchmod +x $HOME/.local/bin/tenki-publish";
    return [
      `export TENKI_SESSION_ID='${id}'`,
      `export TENKI_EXPOSE_TOKEN='${entry.exposeToken}'`,
      `export TENKI_BROKER_URL='${brokerUrl}'`,
      'export PATH="$HOME/.local/bin:$PATH"',
      publishHelper,
    ];
  }

  // The opencode.json a seat needs: a gortex MCP entry when a repo is indexed,
  // and a relay provider when the seat runs Frontier. Merged into one file.
  function opencodeConfig({ frontier, relayToken, gortex }) {
    const cfg = { $schema: "https://opencode.ai/config.json" };
    if (frontier) {
      cfg.provider = { relay: {
        npm: "@ai-sdk/openai-compatible", name: "relay",
        options: { baseURL: `${brokerUrl}/relay/${FRONTIER_PROVIDER}/v1`, apiKey: relayToken },
        models: { [FRONTIER_MODEL]: {} },
      } };
    }
    if (gortex) cfg.mcp = { gortex: { type: "local", command: ["gortex", "mcp"], enabled: true } };
    return cfg;
  }

  // Run a shell body HEADLESS: write it to /tmp/work.sh and nohup it (no ttyd,
  // no exposePort → no preview URL). The agent runs to completion unattended.
  async function runHeadless(session, bodyLines) {
    const b64 = Buffer.from(`#!/bin/bash\n${bodyLines.join("\n")}\n`).toString("base64");
    const start =
      `echo ${b64} | base64 -d > /tmp/work.sh; chmod +x /tmp/work.sh; ` +
      `: > /tmp/agent.log; nohup bash /tmp/work.sh >/tmp/agent.log 2>&1 </dev/null & echo STARTED`;
    await session.exec("bash", { args: ["-lc", start], timeoutMs: 20_000 });
  }

  async function launchSeat(run, team, seat, isArchitect) {
    const ttl = Math.max(60_000, run.deadline - Date.now());
    const session = await client.create({
      name: `maxx-${team.tag}-${seat.role}-${crypto.randomBytes(2).toString("hex")}`,
      cpuCores: 1, memoryMb: 1024, allowInbound: true, allowOutbound: true,
      maxDurationMs: ttl, idleTimeoutMinutes: 0,
      metadata: { demo: "true", source: "maxx", maxx: run.id, team: team.tag, role: seat.role },
      waitReady: true,
    });
    const entry = trackSeat(session.id);
    seat.id = session.id;

    const frontier = run.mode === "frontier";
    const model = seat.model;
    const publishNote = isArchitect
      ? `\n\nWhen the app is ready, serve it on port ${APP_PORT} bound to 0.0.0.0 in the background, then run: tenki-publish ${APP_PORT} — and print the URL.`
      : "";
    const repoNote = run.repoUrl
      ? `\n\nThis sandbox is a clone of ${run.repoUrl} (in /home/tenki/work), indexed by gortex — use the gortex MCP tools to navigate the code instead of reading whole files.`
      : "";

    const cfg = opencodeConfig({ frontier, relayToken: entry.relayToken, gortex: !!run.repoUrl });
    const cfgB64 = Buffer.from(JSON.stringify(cfg, null, 2)).toString("base64");

    const setup = run.repoUrl
      ? [
          `git clone --depth 1 ${run.repoUrl} /home/tenki/work 2>/dev/null || mkdir -p /home/tenki/work`,
          "cd /home/tenki/work",
          "curl -fsSL -o /tmp/g.tgz https://github.com/zzet/gortex/releases/latest/download/gortex_linux_amd64.tar.gz && tar xzf /tmp/g.tgz -C /tmp && (sudo mv /tmp/gortex /usr/local/bin/gortex 2>/dev/null || mv /tmp/gortex $HOME/.local/bin/gortex)",
          "nohup gortex daemon start >/tmp/gortex-daemon.log 2>&1 </dev/null & sleep 2",
          "gortex track /home/tenki/work >/tmp/gortex-track.log 2>&1 || true",
        ]
      : ["mkdir -p /home/tenki/work && cd /home/tenki/work"];

    const body = [
      ...seatEnv(session.id, entry),
      ...setup,
      `echo ${cfgB64} | base64 -d > /home/tenki/work/opencode.json`,
      `cat > /tmp/prompt.txt <<'PROMPT'\n${seat.duty}\n\nBUILD REQUEST:\n${run.prompt}${repoNote}${publishNote}\nPROMPT`,
      // Run opencode's TUI in a detached tmux session, not `opencode run`
      // piped to a file: the file path prints a bare "$ command" transcript
      // (looks like a shell), whereas the TUI in a real pty is the live
      // interface. tmux makes it BOTH autonomous and attachable, so watch
      // drops into the running opencode rather than a log tail.
      `command -v tmux >/dev/null 2>&1 || { sudo apt-get update >/tmp/tmux-install.log 2>&1; sudo apt-get install -y tmux >>/tmp/tmux-install.log 2>&1; }`,
      `cat > /tmp/agent-cmd.sh <<'CMD'\n#!/bin/bash\ncd /home/tenki/work\nexec opencode --auto --model __MODEL__ --prompt "$(cat /tmp/prompt.txt)"\nCMD`,
      `sed -i "s|__MODEL__|${model}|" /tmp/agent-cmd.sh && chmod +x /tmp/agent-cmd.sh`,
      `tmux kill-server 2>/dev/null; tmux new-session -d -s agent -x 220 -y 50 'bash /tmp/agent-cmd.sh'`,
      `echo "[maxx] opencode running in tmux session 'agent' — watch attaches to the live TUI"`,
    ];
    await runHeadless(session, body);
    seat.state = "running"; seat.terminalUrl = null;
    save();
  }

  async function launchRun(run) {
    try {
      for (const team of run.teams) {
        for (let k = 0; k < team.seats.length; k++) {
          if (run.aborted) { log("maxx_launch_aborted", { runId: run.id }); return; }
          try { await launchSeat(run, team, team.seats[k], k === 0); }
          catch (e) {
            team.seats[k].state = "failed"; team.seats[k].error = e.message; save();
            log("maxx_seat_failed", { runId: run.id, team: team.tag, role: team.seats[k].role, message: e.message });
          }
          await new Promise((r) => setTimeout(r, SEAT_STAGGER_MS));
        }
      }
      if (!run.aborted) {
        run.state = "running"; save();
        log("maxx_launched", { runId: run.id, teams: run.teams.length, seats: run.teams.reduce((n, t) => n + t.seats.length, 0) });
        if (run.compete) setTimeout(() => judge(run, true).catch(() => {}), JUDGE_MAX_WAIT_MS);
      }
    } catch (e) {
      run.state = "failed"; run.error = e.message; save();
      log("maxx_launch_failed", { runId: run.id, message: e.message });
    }
  }

  /* Broker-side judge — no sandbox. When both teams have shipped (or the max
   * wait elapses), fetch both apps and score them with a free model directly.
   * The broker holds the key, so this costs nothing and needs no VM. */
  async function judge(run, force) {
    if (run.verdict || run.judging || !run.compete) return;
    const shipped = run.teams.filter((t) => t.publishedUrl);
    if (!force && shipped.length < run.teams.length) return;   // wait for both
    if (shipped.length === 0) return;
    if (!process.env.OPENROUTER_API_KEY) return;
    run.judging = true; save();
    try {
      const htmls = await Promise.all(run.teams.map(async (t) => {
        if (!t.publishedUrl) return "(no build shipped)";
        try { const r = await fetch(t.publishedUrl, { signal: AbortSignal.timeout(8000) }); return (await r.text()).slice(0, 3500); }
        catch { return "(build unreachable)"; }
      }));
      const prompt =
        `Judge two builds for this brief:\n"${run.prompt}"\n\n` +
        `TEAM A — ${run.teams[0].publishedUrl || "did not ship"}:\n${htmls[0]}\n\n` +
        `TEAM B — ${run.teams[1].publishedUrl || "did not ship"}:\n${htmls[1]}\n\n` +
        `Which better fulfils the brief and looks like it actually works? ` +
        `First line EXACTLY "WINNER: A" or "WINNER: B". Then one sentence why.`;
      const rr = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 220, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(60_000),
      });
      const jd = await rr.json();
      const text = (jd.choices?.[0]?.message?.content || "").trim();
      const m = /WINNER:\s*([AB])/i.exec(text);
      run.verdict = {
        winner: m ? m[1].toUpperCase() : null,
        reasoning: text.replace(/^\s*WINNER:\s*[AB]\.?\s*/i, "").trim().slice(0, 500),
        at: Date.now(),
      };
      save(); log("maxx_judged", { runId: run.id, winner: run.verdict.winner });
    } catch (e) {
      run.verdict = { winner: null, reasoning: "Judge unavailable.", at: Date.now() };
      save(); log("maxx_judge_failed", { runId: run.id, message: e.message });
    } finally {
      run.judging = false; save();
    }
  }

  const publicRun = (r) => ({
    id: r.id, template: r.template, state: r.state, mode: r.mode, compete: r.compete,
    deadline: r.deadline, prompt: r.prompt, repoUrl: r.repoUrl ?? null, error: r.error ?? null,
    verdict: r.verdict ?? null,
    teams: r.teams.map((t) => ({
      tag: t.tag, publishedUrl: t.publishedUrl ?? null,
      seats: t.seats.map((s) => ({ role: s.role, model: s.model, state: s.state, terminalUrl: s.terminalUrl ?? null })),
    })),
  });

  function cleanRepoUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    let u; try { u = new URL(raw.trim()); } catch { return null; }
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.href.replace(/\.git$/, "") + ".git";
  }

  async function start(req, res) {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 4000) : "";
    if (!prompt) return json(res, 400, { error: "prompt_required" });
    const template = loadTemplate(body.team || "lean-four");
    if (!template) return json(res, 400, { error: "unknown_team", have: listTemplates().map((t) => t.name) });
    const mode = body.mode === "frontier" ? "frontier" : "free";
    const compete = body.compete === true;
    const repoUrl = body.repo ? cleanRepoUrl(body.repo) : null;
    if (body.repo && !repoUrl) return json(res, 400, { error: "bad_repo", note: "public https git URL only" });
    if (mode === "frontier" && !/^https:\/\//.test(brokerUrl))
      return json(res, 501, { error: "relay_unconfigured" });

    const teamCount = compete ? 2 : 1;
    const totalSeats = template.seats.length * teamCount;

    // Preview-URL budget: seats are headless, so a run needs one preview URL per
    // SHIPPED app = one per team (plus headroom). VMs (100 cap) easily cover seats.
    const RESERVED = Number(process.env.MAXX_RESERVED_PREVIEWS || 3);
    let previewMax = 20, previewUsed = 0;
    try {
      const u = (await client.getUsage()).find((x) => x.key === "preview_urls_per_workspace");
      if (u) { previewMax = u.max ?? previewMax; previewUsed = u.current ?? 0; }
    } catch {}
    if (teamCount > previewMax - previewUsed - RESERVED)
      return json(res, 503, { error: "capacity", need: teamCount, freePreviews: previewMax - previewUsed - RESERVED, previewMax, previewUsed, note: "each team ships one app (one preview URL)" });

    const mkTeam = (tag, offset) => ({
      tag, publishedUrl: null,
      seats: assignModels(template.seats, mode, offset).map((model, i) => ({
        role: template.seats[i].role, duty: template.seats[i].duty, model,
        state: "pending", id: null, terminalUrl: null,
      })),
    });
    const runId = crypto.randomBytes(6).toString("hex");
    runs[runId] = {
      id: runId, template: template.name, prompt, repoUrl, mode, compete,
      state: "launching", createdAt: Date.now(), deadline: Date.now() + DEFAULT_DEADLINE_MS,
      verdict: null,
      teams: compete ? [mkTeam("A", 0), mkTeam("B", 2)] : [mkTeam("A", 0)],
    };
    save();
    launchRun(runs[runId]).catch((e) => log("maxx_bg_failed", { runId, message: e.message }));
    return json(res, 201, publicRun(runs[runId]));
  }

  async function get(res, runId) {
    const r = runs[runId];
    return r ? json(res, 200, publicRun(r)) : json(res, 404, { error: "not_found" });
  }

  // Stop the run's agents. By default the shipped deliverable(s) are KEPT alive
  // — stopping the agents shouldn't destroy the end product. `releaseAll` also
  // tears the deliverables down (full cleanup).
  async function stop(res, runId, releaseAll) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    r.aborted = true; save();
    const kept = [];
    for (const team of r.teams) for (const s of team.seats) {
      if (!s.id) continue;
      if (s.published && !releaseAll) { if (team.publishedUrl) kept.push(team.publishedUrl); continue; }
      try { const sess = await client.get(s.id); await sess.closeIfOpen(); } catch {}
      delete tracked[s.id];
    }
    saveState(); indexRelay();
    r.state = releaseAll ? "released" : "stopped"; save();
    log("maxx_stopped", { runId, kept: kept.length, releaseAll: !!releaseAll });
    return json(res, 200, { ok: true, kept });
  }

  // On-demand watch: start a ttyd tailing this seat's agent log and expose it,
  // so a preview URL is spent only on seats someone actually opens. The browser
  // never learns seat session ids — it addresses a seat by {team, role}.
  async function watch(req, res, runId) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    const body = await readJson(req);
    let seat = null;
    for (const t of r.teams) if (t.tag === body.team) { seat = t.seats.find((s) => s.role === body.role); break; }
    if (!seat || !seat.id) return json(res, 404, { error: "seat_not_found" });
    if (seat.terminalUrl && seat.watchExpires > Date.now() + 60_000)
      return json(res, 200, { url: seat.terminalUrl });
    try {
      const s = await client.get(seat.id);
      if (s.state !== "RUNNING") return json(res, 409, { error: "not_running", state: s.state });
      const t = crypto.randomBytes(16).toString("base64url");
      // Attach (read-only) to the agent's tmux session, so the viewer sees the
      // live opencode TUI. pkill -x (exact NAME) — never -f, which would match
      // this shell's own command line and self-kill the exec.
      const start =
        `pkill -x ttyd 2>/dev/null; sleep 0.2; ` +
        `nohup ttyd -p 8080 -W -b /t-${t} bash -lc ` +
        `'tmux attach -rt agent 2>/dev/null || { echo; echo "  agent not attached — the run is still starting or has finished."; sleep 4; }' ` +
        `>/tmp/ttyd.log 2>&1 </dev/null & ` +
        `sleep 0.4; curl -sf -o /dev/null http://127.0.0.1:8080/t-${t}/ && echo OK`;
      await s.exec("bash", { args: ["-lc", start], timeoutMs: 15_000 });
      const ttl = Math.max(60_000, r.deadline - Date.now());
      const exposed = await s.exposePort(8080, { ttlMs: ttl });
      seat.terminalUrl = `${exposed.previewUrl.replace(/\/$/, "")}/t-${t}/`;
      seat.watchExpires = exposed.expiresAt ? new Date(exposed.expiresAt).getTime() : Date.now() + ttl;
      save();
      log("maxx_watch", { runId, team: body.team, role: body.role });
      return json(res, 200, { url: seat.terminalUrl });
    } catch (e) {
      // exposePort throws when the 20-preview-URL cap is hit — surface it kindly.
      if (/preview|quota|limit/i.test(e.message || "")) return json(res, 503, { error: "preview_limit" });
      log("maxx_watch_failed", { runId, role: body.role, message: e.message });
      return json(res, 502, { error: "watch_failed" });
    }
  }

  const templates = (res) => json(res, 200, { templates: listTemplates() });

  // Called by the broker when a sandbox exposes a port: record the shipped app
  // as its team's deliverable, then judge once both teams are in.
  function notifyExpose(sessionId, port, url) {
    if (port === 8080) return;   // ttyd viewer, not the app
    for (const r of Object.values(runs)) {
      for (const team of r.teams || []) {
        const seat = team.seats.find((s) => s.id === sessionId);
        if (seat) {
          team.publishedUrl = url;
          seat.published = true;
          // The shipped app is the deliverable — keep this sandbox alive past
          // the run deadline and exempt it from the reaper, so the end product
          // doesn't turn to sand. Worker seats still expire normally.
          if (tracked[sessionId]) { tracked[sessionId].keep = true; saveState(); }
          client.updateSession(sessionId, { sticky: true })
            .catch((e) => log("maxx_keep_failed", { id: sessionId, message: e.message }));
          save();
          log("maxx_published", { runId: r.id, team: team.tag, url, kept: true });
          if (r.compete) judge(r, false).catch(() => {});
          return;
        }
      }
    }
  }

  return { start, get, stop, templates, watch, notifyExpose };
}
