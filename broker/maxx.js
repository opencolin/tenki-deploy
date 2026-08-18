/* Sandboxmaxxing — P0: one configurable team of agents, each in its own live
 * sandbox, all building the same prompt on keyless opencode-native free models.
 * The architect seat publishes a live URL at the end.
 *
 * Scope note: P0 proves the orchestration machinery end-to-end — a named run
 * fans a prompt across role-assigned sandboxes, every seat is watchable live,
 * one publishes, the run tears down. Cross-sandbox coordination (a shared team
 * repo / blackboard) is the next increment and lands as its own tested piece;
 * it is deliberately not hand-rolled in blind here.
 *
 * Kept out of broker.js and handed only the primitives it needs, so teams stay
 * data (broker/teams/*.json) and the broker core stays readable.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Keyless opencode-native free models (verified working unauthenticated). P0
// draws seat models from here only — no API key, no rate relay.
// north-mini-code-free is excluded: it errors.
const NATIVE_FREE = [
  "opencode/nemotron-3-ultra-free",   // strongest — 'strongest' seats get this
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/hy3-free",
];
const APP_PORT = 3000;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
const SEAT_STAGGER_MS = 2_000;

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

  // Distinct native-free models across seats. Seat 0 is the lead/architect —
  // the seat that decomposes the work and (in P0) publishes — so it always gets
  // the single strongest model, whatever the template says. Other 'strongest'
  // hints also get the top model; everyone else round-robins the rest.
  function assignModels(seats) {
    const [strong, ...rest] = NATIVE_FREE;
    let i = 0;
    return seats.map((s, idx) =>
      s.model ? s.model
      : idx === 0 || s.modelHint === "strongest" ? strong
      : rest[i++ % rest.length]);
  }

  const token = () => crypto.randomBytes(24).toString("base64url");

  // Register in the broker's tracked map so expose + reaper keep working.
  function trackSeat(id) {
    tracked[id] = {
      createdAt: Date.now(), ipHash: "maxx", terminal: null,
      exposeToken: token(), exposeCount: 0,
      relayToken: token(), relayCalls: 0, relayInFlight: 0, maxx: true,
    };
    saveState(); indexRelay();
    return tracked[id];
  }

  // Publish helper (same as the demo flow) so the architect can expose its app.
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

  // Run a seat's command under ttyd on a fresh unguessable path — watchable live.
  async function runUnderTtyd(session, bodyLines, ttlMs) {
    const t = crypto.randomBytes(16).toString("base64url");
    const scriptB64 = Buffer.from(`#!/bin/bash\n${bodyLines.join("\n")}\n`).toString("base64");
    const start =
      `echo ${scriptB64} | base64 -d > /tmp/launch.sh; chmod +x /tmp/launch.sh; ` +
      `pkill -x ttyd 2>/dev/null; ` +
      `nohup ttyd -p 8080 -W -b /t-${t} bash /tmp/launch.sh >/tmp/ttyd.log 2>&1 </dev/null & ` +
      `sleep 0.4; curl -sf -o /dev/null http://127.0.0.1:8080/t-${t}/ && echo OK`;
    await session.exec("bash", { args: ["-lc", start], timeoutMs: 15_000 });
    const exposed = await session.exposePort(8080, { ttlMs });
    return `${exposed.previewUrl.replace(/\/$/, "")}/t-${t}/`;
  }

  async function launchSeat(run, seat, isArchitect) {
    const ttl = Math.max(60_000, run.deadline - Date.now());
    const session = await client.create({
      name: `maxx-${seat.role}-${crypto.randomBytes(3).toString("hex")}`,
      cpuCores: 1, memoryMb: 1024, allowInbound: true, allowOutbound: true,
      maxDurationMs: ttl, idleTimeoutMinutes: 0,
      metadata: { demo: "true", source: "maxx", maxx: run.id, role: seat.role },
      waitReady: true,
    });
    const entry = trackSeat(session.id);
    seat.id = session.id;

    // The architect additionally serves its app and publishes the URL; the
    // publish instruction is appended so the run yields one live link.
    const publishNote = isArchitect
      ? `\n\nWhen the app is ready, serve it on port ${APP_PORT} bound to 0.0.0.0 in the background, then run: tenki-publish ${APP_PORT} — and print the resulting URL.`
      : "";
    const body = [
      ...seatEnv(session.id, entry),
      "mkdir -p /home/tenki/work && cd /home/tenki/work",
      `cat > /tmp/prompt.txt <<'PROMPT'\n${seat.duty}\n\nBUILD REQUEST:\n${run.prompt}${publishNote}\nPROMPT`,
      `exec opencode run --auto --model ${seat.model} "$(cat /tmp/prompt.txt)"`,
    ];
    seat.terminalUrl = await runUnderTtyd(session, body, ttl);
    seat.state = "running";
    save();
  }

  async function launchRun(run) {
    try {
      for (let k = 0; k < run.seats.length; k++) {
        // Provisioning is staggered and async; a DELETE mid-launch must stop it
        // creating the rest of the roster (else it races past the teardown).
        if (run.aborted) { log("maxx_launch_aborted", { runId: run.id, at: k }); return; }
        try { await launchSeat(run, run.seats[k], k === 0); }
        catch (e) {
          run.seats[k].state = "failed"; run.seats[k].error = e.message; save();
          log("maxx_seat_failed", { runId: run.id, role: run.seats[k].role, message: e.message });
        }
        if (k < run.seats.length - 1) await new Promise((r) => setTimeout(r, SEAT_STAGGER_MS));
      }
      if (!run.aborted) { run.state = "running"; save(); log("maxx_launched", { runId: run.id, seats: run.seats.length }); }
    } catch (e) {
      run.state = "failed"; run.error = e.message; save();
      log("maxx_launch_failed", { runId: run.id, message: e.message });
    }
  }

  const publicRun = (r) => ({
    id: r.id, template: r.template, state: r.state, deadline: r.deadline,
    prompt: r.prompt, error: r.error ?? null,
    seats: r.seats.map((s) => ({ role: s.role, model: s.model, state: s.state, terminalUrl: s.terminalUrl })),
  });

  async function start(req, res) {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 4000) : "";
    if (!prompt) return json(res, 400, { error: "prompt_required" });
    const template = loadTemplate(body.team || "lean-four");
    if (!template) return json(res, 400, { error: "unknown_team", have: listTemplates().map((t) => t.name) });

    // The binding limit is preview URLs, not VMs: every watchable seat exposes
    // one (its ttyd viewer). The usage API reports this — there is NO
    // active-sessions/VM key — so it's the ceiling we can actually read. Leave
    // headroom (RESERVED) for the host site + any live demo sessions.
    const RESERVED = Number(process.env.MAXX_RESERVED_PREVIEWS || 3);
    let previewMax = 20, previewUsed = 0;
    try {
      const u = (await client.getUsage()).find((x) => x.key === "preview_urls_per_workspace");
      if (u) { previewMax = u.max ?? previewMax; previewUsed = u.current ?? 0; }
    } catch {}
    const freePreviews = previewMax - previewUsed - RESERVED;
    if (template.seats.length > freePreviews)
      return json(res, 503, {
        error: "capacity", need: template.seats.length,
        freePreviews, previewMax, previewUsed,
        note: "limited by preview_urls_per_workspace, not VM count",
      });

    const models = assignModels(template.seats);
    const runId = crypto.randomBytes(6).toString("hex");
    runs[runId] = {
      id: runId, template: template.name, prompt,
      state: "launching", createdAt: Date.now(), deadline: Date.now() + DEFAULT_DEADLINE_MS,
      seats: template.seats.map((s, i) => ({
        role: s.role, duty: s.duty, model: models[i], state: "pending", id: null, terminalUrl: null,
      })),
    };
    save();
    launchRun(runs[runId]).catch((e) => log("maxx_bg_failed", { runId, message: e.message }));
    return json(res, 201, publicRun(runs[runId]));
  }

  async function get(res, runId) {
    const r = runs[runId];
    return r ? json(res, 200, publicRun(r)) : json(res, 404, { error: "not_found" });
  }

  async function stop(res, runId) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    r.aborted = true; save();      // halt an in-flight launchRun before closing seats
    for (const s of r.seats) {
      if (!s.id) continue;
      try { const sess = await client.get(s.id); await sess.closeIfOpen(); } catch {}
      delete tracked[s.id];
    }
    saveState(); indexRelay();
    r.state = "stopped"; save();
    log("maxx_stopped", { runId });
    return json(res, 200, { ok: true });
  }

  const templates = (res) => json(res, 200, { templates: listTemplates() });

  // Called by the broker when a sandbox exposes a port. If that sandbox belongs
  // to a maxx run, the exposed app URL is the run's deliverable — record it.
  // (ttyd's own port 8080 is the live viewer, not the app, so ignore it.)
  function notifyExpose(sessionId, port, url) {
    if (port === 8080) return;
    for (const r of Object.values(runs)) {
      const seat = r.seats.find((s) => s.id === sessionId);
      if (seat) { r.publishedUrl = url; save(); log("maxx_published", { runId: r.id, role: seat.role, url }); return; }
    }
  }

  return { start, get, stop, templates, notifyExpose };
}
