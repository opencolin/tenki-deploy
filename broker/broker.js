/* Demo-session broker (PRD Phase 1).
 * Serves the static site and three API routes that let anonymous visitors
 * mint short-lived demo sandboxes and open a browser terminal into them.
 * Holds the workspace API key; the served pages never see it.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  TenkiSandbox,
  QuotaExceededError,
  CapacityUnavailableError,
  RateLimitedError,
  SessionNotFoundError,
  isTerminal,
  stdoutText,
} from "@tenkicloud/sandbox";

const BROKER_DIR = path.dirname(new URL(import.meta.url).pathname);
// .env: KEY=VALUE lines; kept out of the static tree so it can never be served
for (const line of fs.readFileSync(path.join(BROKER_DIR, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const PORT = Number(process.env.PORT || 8080);
const SITE_DIR = process.env.SITE_DIR || "/home/tenki/site";
const STATE_FILE = path.join(BROKER_DIR, "state.json");
const MAX_DEMO = Number(process.env.MAX_DEMO_SANDBOXES || 4);
const DEMO_ENABLED = process.env.DEMO_ENABLED !== "false";
const MAX_PER_IP = 1;
const MAX_CREATES_PER_IP_PER_HOUR = 5;
const DEMO_DURATION_MS = 60 * 60 * 1000;
const IDLE_TIMEOUT_MINUTES = 10;
// must be a platform-allowed preview port; 7681 (ttyd default) is rejected
const TTYD_PORT = Number(process.env.TTYD_PORT || 8080);
// ships in the base image; the terminal launches one of these instead of bash
const AGENTS = new Set(["claude", "codex", "opencode"]);
// Public URL of THIS broker/site, so a sandbox can call back to publish a port.
// Required for the deploy feature; without it, `tenki-publish` is unavailable.
const BROKER_PUBLIC_URL = (process.env.BROKER_PUBLIC_URL || "").replace(/\/$/, "");
// Ports the platform allows a preview on (8080 = ttyd, 7681 = base-image ttyd).
const EXPOSABLE_PORTS = new Set([3000, 5000, 8000, 8081, 9000]);
const MAX_EXPOSES_PER_SESSION = 20;
// Constant-time token compare (avoids leaking the token via timing).
const tokenEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* Dropped into the sandbox as AGENTS.md + CLAUDE.md. Without it agents reach
 * for GitHub Pages / Vercel / a tunnel and stall on credentials, when the
 * sandbox they are already inside can serve the public internet. */
const DEPLOY_GUIDE = `# You are inside a Tenki sandbox

This machine is a disposable Tenki Cloud microVM. It is yours alone, and it
turns to sand when the session ends.

## Publishing a site or app — use this sandbox, not an external host

Do **not** reach for GitHub Pages, Vercel, Netlify, surge, or a tunnel
service, and do not ask the user to log in anywhere. This sandbox can serve
the public internet directly, in two steps:

1. Serve on a port. 3000, 5000, 8000, 8081 and 9000 all work (8080 and 7681
   are already taken):

       nohup python3 -m http.server 3000 --bind 0.0.0.0 --directory /path/to/app >/tmp/app.log 2>&1 &

   Anything listening on 0.0.0.0 works — \`npm start\`, \`node server.js\`, etc.

2. Publish it and read back the URL:

       tenki-publish 3000

   It prints JSON like \`{"url":"https://…"}\` — a public HTTPS address. Give
   that URL to the user; that is the deployed site. \`tenki-publish\` asks this
   sandbox's own host to expose the port; there is no login or API key to set up,
   and it can only ever publish ports on *this* sandbox.

## Rules

- Only ever act on \`$TENKI_SESSION_ID\`, which is this sandbox. Never
  terminate, pause, or modify any other sandbox in the workspace — other
  people's work is running there.
- The published URL lives as long as this sandbox does.
`;

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) return {};
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

const client = new TenkiSandbox({ authToken: process.env.TENKI_API_KEY });

/* Tracked demo sessions, persisted so a broker restart can't orphan or
 * (worse) lose sight of live VMs. Only ids in this map are ever returned
 * to or accepted from browsers — the hosting sandbox is unreachable here. */
let tracked = {}; // id -> {createdAt, ipHash, terminal: {url, expiresAt} | null}
try { tracked = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(tracked));

const createTimes = new Map(); // ipHash -> [epochMs]

const ipOf = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.socket.remoteAddress || "unknown";
const hashIp = (ip) => crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

const publicSession = (s) => ({
  id: s.id,
  state: s.state,
  timeoutAt: s.timeoutAt ?? null,
  cpuCores: 1,
  memoryMb: 1024,
});

async function createDemoSession(req, res) {
  if (!DEMO_ENABLED) return json(res, 503, { error: "disabled" });
  const ipHash = hashIp(ipOf(req));

  const now = Date.now();
  const recent = (createTimes.get(ipHash) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= MAX_CREATES_PER_IP_PER_HOUR)
    return json(res, 429, { error: "rate_limited" });

  const mine = Object.entries(tracked).filter(([, v]) => v.ipHash === ipHash);
  if (mine.length >= MAX_PER_IP) {
    // steer the visitor back to their existing sandbox instead of refusing
    const [id] = mine[0];
    try {
      const s = await client.get(id);
      if (!isTerminal(s.state)) return json(res, 200, { ...publicSession(s), reused: true });
    } catch {}
    delete tracked[id];
    saveState();
  }

  if (Object.keys(tracked).length >= MAX_DEMO)
    return json(res, 503, { error: "capacity" });
  try {
    const usage = (await client.getUsage()).find((u) => u.key === "active_sessions");
    if (usage?.max !== undefined && usage.current >= usage.max)
      return json(res, 503, { error: "capacity" });
  } catch (e) {
    log("usage_check_failed", { message: e.message });
  }

  try {
    const session = await client.create({
      name: `demo-${crypto.randomBytes(4).toString("hex")}`,
      cpuCores: 1,
      memoryMb: 1024,
      allowInbound: true,
      allowOutbound: true,
      maxDurationMs: DEMO_DURATION_MS,
      idleTimeoutMinutes: IDLE_TIMEOUT_MINUTES,
      metadata: { demo: "true", source: "landing-page", ip_hash: ipHash },
      waitReady: false,
    });
    tracked[session.id] = {
      createdAt: now, ipHash, terminal: null,
      // Per-session secret: lets the sandbox publish its OWN ports via the broker
      // without ever holding the workspace key. Never sent to the browser.
      exposeToken: crypto.randomBytes(24).toString("base64url"),
      exposeCount: 0,
    };
    saveState();
    recent.push(now);
    createTimes.set(ipHash, recent);
    log("demo_created", { id: session.id, ipHash });
    warmKimi(session.id);
    return json(res, 201, publicSession(session));
  } catch (e) {
    if (e instanceof QuotaExceededError || e instanceof CapacityUnavailableError)
      return json(res, 503, { error: "capacity" });
    if (e instanceof RateLimitedError) return json(res, 429, { error: "rate_limited" });
    log("demo_create_failed", { message: e.message });
    return json(res, 502, { error: "create_failed" });
  }
}

async function getDemoSession(res, id) {
  if (!tracked[id]) return json(res, 404, { error: "not_found" });
  try {
    const s = await client.get(id);
    if (isTerminal(s.state)) {
      delete tracked[id];
      saveState();
      return json(res, 410, { error: "expired" });
    }
    return json(res, 200, publicSession(s));
  } catch (e) {
    if (e instanceof SessionNotFoundError) {
      delete tracked[id];
      saveState();
      return json(res, 410, { error: "expired" });
    }
    log("demo_get_failed", { id, message: e.message });
    return json(res, 502, { error: "status_failed" });
  }
}

async function openTerminal(req, res, id) {
  const entry = tracked[id];
  if (!entry) return json(res, 404, { error: "not_found" });
  // Backfill a token for sessions created before this field existed.
  if (!entry.exposeToken) { entry.exposeToken = crypto.randomBytes(24).toString("base64url"); saveState(); }
  const body = await readJson(req);
  const agent = AGENTS.has(body.agent) ? body.agent : null;
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 4000) : "";
  const kimi = body.kimi === true && !!agent;
  const fullAuto = body.fullAuto !== false;
  if (kimi && !process.env.NEBIUS_API_KEY) return json(res, 501, { error: "kimi_unconfigured" });
  // doubles as the terminal-reuse cache key, so every launch-affecting
  // option has to appear in it
  const command = agent
    ? `${kimi ? "kimi-" : ""}${agent}${fullAuto ? "" : "-manual"}${prompt ? "-prompted" : ""}`
    : "bash";
  // reuse the current terminal only for a same-command, promptless request;
  // a prompt always relaunches so the agent starts with the new prompt. The
  // "-prompted" suffix keeps a bare agent launch (the 02 Access pills) from
  // landing in a terminal still running a prompt typed into 01 Build.
  if (!prompt && entry.terminal && entry.terminal.agent === command &&
      new Date(entry.terminal.expiresAt) > new Date(Date.now() + 60_000))
    return json(res, 200, entry.terminal);
  try {
    const s = await client.get(id);
    if (s.state !== "RUNNING") return json(res, 409, { error: "not_running", state: s.state });

    // Unguessable base path is the terminal's access control (plus the random
    // preview host): ttyd serves only under /t-<token>/, 404s everything else.
    // One ttyd at a time: starting a new command retires the previous URL.
    // The prompt and launcher travel base64-encoded — visitor text never
    // touches shell quoting.
    // The VM is disposable and belongs to this one visitor, so skip the
    // trust/approval gates that assume a shared workstation — otherwise the
    // first thing a demo shows is a consent dialog.
    const AGENT_FLAGS = {
      claude: "--dangerously-skip-permissions",
      codex: "--dangerously-bypass-approvals-and-sandbox",
      opencode: "--auto",
    };
    const promptArg =
      agent === "opencode" ? '--prompt "$(cat /tmp/prompt.txt)"' : '"$(cat /tmp/prompt.txt)"';
    const argv = agent
      ? [agent, fullAuto ? AGENT_FLAGS[agent] : "", prompt ? promptArg : ""].filter(Boolean).join(" ")
      : "bash";
    // Deploy path: the sandbox publishes its OWN ports by calling back to the
    // broker with a per-session token. The workspace key (TENKI_API_KEY) stays
    // here and NEVER enters the VM — the visitor is root in it and could read
    // anything on disk or in the env. `tenki-publish <port>` is a tiny wrapper
    // the agent runs; it returns {"url":"https://…"}.
    const publishHelper =
      "mkdir -p $HOME/.local/bin && cat > $HOME/.local/bin/tenki-publish <<'PUBLISH'\n" +
      "#!/bin/bash\n" +
      "port=\"${1:?usage: tenki-publish <port>}\"\n" +
      "curl -fsS -X POST \"$TENKI_BROKER_URL/api/demo-sessions/$TENKI_SESSION_ID/expose\" \\\n" +
      "  -H \"x-expose-token: $TENKI_EXPOSE_TOKEN\" -H 'content-type: application/json' \\\n" +
      "  -d \"{\\\"port\\\":$port}\"\n" +
      "PUBLISH\n" +
      "chmod +x $HOME/.local/bin/tenki-publish";
    const tenkiEnv = [
      `export TENKI_SESSION_ID='${id}'`,
      `export TENKI_EXPOSE_TOKEN='${entry.exposeToken}'`,
      `export TENKI_BROKER_URL='${BROKER_PUBLIC_URL}'`,
      'export PATH="$HOME/.local/bin:$PATH"',
      publishHelper,
    ];
    let launch;
    if (kimi) {
      // kimirelay fronts the agent with Kimi K3 on Nebius — no agent login.
      // kimirelay passes extra args through to the underlying agent.
      launch = [
        ...tenkiEnv,
        `export NEBIUS_API_KEY='${process.env.NEBIUS_API_KEY}'`,
        ...(process.env.TAVILY_API_KEY ? [`export TAVILY_API_KEY='${process.env.TAVILY_API_KEY}'`] : []),
        'export PATH="$HOME/.kimirelay/bin:$PATH"',
        'command -v kimirelay >/dev/null 2>&1 || { echo "installing kimi-relay…"; curl -fsSL https://kimirelay.com/install.sh | sh >/tmp/kimirelay-install.log 2>&1 || echo "kimi-relay install failed — see /tmp/kimirelay-install.log"; }',
        `exec kimirelay ${argv}`,
      ].join("\n");
    } else launch = [...tenkiEnv, `exec ${argv}`].join("\n");
    const scriptB64 = Buffer.from(`#!/bin/bash\n${launch}\n`).toString("base64");
    const promptB64 = Buffer.from(prompt).toString("base64");
    const guideB64 = Buffer.from(DEPLOY_GUIDE).toString("base64");
    const token = crypto.randomBytes(16).toString("base64url");
    const start =
      `echo ${promptB64} | base64 -d > /tmp/prompt.txt; ` +
      `echo ${guideB64} | base64 -d > /home/tenki/AGENTS.md; cp /home/tenki/AGENTS.md /home/tenki/CLAUDE.md; ` +
      `echo ${scriptB64} | base64 -d > /tmp/launch.sh; chmod +x /tmp/launch.sh; ` +
      `pkill -x ttyd 2>/dev/null; ` +
      `nohup ttyd -p ${TTYD_PORT} -W -b /t-${token} bash /tmp/launch.sh >/tmp/ttyd.log 2>&1 </dev/null & ` +
      `sleep 0.4; curl -sf -o /dev/null http://127.0.0.1:${TTYD_PORT}/t-${token}/ && echo OK`;
    const result = await s.exec("bash", { args: ["-lc", start], timeoutMs: 15_000 });
    if (!stdoutText(result).includes("OK")) {
      log("ttyd_start_failed", { id, exit: result.exitCode });
      return json(res, 502, { error: "terminal_failed" });
    }

    const remainingMs = Math.max(60_000, new Date(s.timeoutAt) - Date.now());
    const exposed = await s.exposePort(TTYD_PORT, { ttlMs: remainingMs });
    entry.terminal = {
      url: `${exposed.previewUrl.replace(/\/$/, "")}/t-${token}/`,
      expiresAt: exposed.expiresAt ?? new Date(Date.now() + remainingMs).toISOString(),
      agent: command,
    };
    saveState();
    log("terminal_opened", { id, agent: command });
    return json(res, 200, entry.terminal);
  } catch (e) {
    if (e instanceof SessionNotFoundError) {
      delete tracked[id];
      saveState();
      return json(res, 410, { error: "expired" });
    }
    log("terminal_failed", { id, message: e.message });
    return json(res, 502, { error: "terminal_failed" });
  }
}

/* The sandbox publishes one of its OWN ports, authenticated by its per-session
 * expose token. This is what lets the workspace key stay in the broker and never
 * enter the visitor-controlled VM. Scoped hard: only this session, only an
 * allow-listed port, and capped per session. */
async function exposePort(req, res, id) {
  const entry = tracked[id];
  if (!entry) return json(res, 404, { error: "not_found" });
  const supplied = req.headers["x-expose-token"] || "";
  if (!entry.exposeToken || !tokenEq(supplied, entry.exposeToken))
    return json(res, 403, { error: "forbidden" });
  if ((entry.exposeCount || 0) >= MAX_EXPOSES_PER_SESSION)
    return json(res, 429, { error: "expose_limit" });
  const body = await readJson(req);
  const port = Number(body.port);
  if (!EXPOSABLE_PORTS.has(port))
    return json(res, 400, { error: "bad_port", allowed: [...EXPOSABLE_PORTS] });
  try {
    const s = await client.get(id);
    if (s.state !== "RUNNING") return json(res, 409, { error: "not_running", state: s.state });
    const remainingMs = Math.max(60_000, new Date(s.timeoutAt) - Date.now());
    const exposed = await s.exposePort(port, { ttlMs: remainingMs });
    entry.exposeCount = (entry.exposeCount || 0) + 1;
    saveState();
    log("port_exposed", { id, port });
    return json(res, 200, {
      url: exposed.previewUrl,
      expiresAt: exposed.expiresAt ?? new Date(Date.now() + remainingMs).toISOString(),
    });
  } catch (e) {
    if (e instanceof SessionNotFoundError) {
      delete tracked[id]; saveState();
      return json(res, 410, { error: "expired" });
    }
    log("expose_failed", { id, port, message: e.message });
    return json(res, 502, { error: "expose_failed" });
  }
}

/* Preinstall kimi-relay and the Tenki CLI while the visitor is still reading
 * the page, so the terminal opens without an install pause. Fire-and-forget. */
function warmKimi(id) {
  (async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await client.get(id);
      if (isTerminal(s.state)) return;
      if (s.state === "RUNNING") {
        const installs = [
          "curl -fsSL https://tenki.cloud/install.sh | bash",
          ...(process.env.NEBIUS_API_KEY ? ["curl -fsSL https://kimirelay.com/install.sh | sh"] : []),
        ].join("; ");
        await s.exec("bash", {
          args: ["-lc", `nohup sh -c '${installs}' >/tmp/warmup.log 2>&1 </dev/null &`],
          timeoutMs: 10_000,
        });
        return;
      }
    }
  })().catch((e) => log("kimi_warmup_failed", { id, message: e.message }));
}

async function destroyDemoSession(res, id) {
  if (!tracked[id]) return json(res, 404, { error: "not_found" });
  try {
    const s = await client.get(id);
    await s.closeIfOpen();
  } catch (e) {
    if (!(e instanceof SessionNotFoundError)) log("destroy_close_failed", { id, message: e.message });
  }
  delete tracked[id];
  saveState();
  log("demo_destroyed", { id });
  return json(res, 200, { ok: true });
}

/* Reaper: platform maxDuration is the real guarantee; this promptly frees
 * slots (4 total) and prunes local tracking of sessions that ended early. */
async function reap() {
  for (const [id, entry] of Object.entries(tracked)) {
    const past = Date.now() - entry.createdAt > DEMO_DURATION_MS + 5 * 60_000;
    try {
      const s = await client.get(id);
      if (isTerminal(s.state)) delete tracked[id];
      else if (past) { await s.closeIfOpen(); delete tracked[id]; log("demo_reaped", { id }); }
    } catch (e) {
      if (e instanceof SessionNotFoundError || past) delete tracked[id];
    }
  }
  saveState();
  for (const [k, v] of createTimes) {
    const kept = v.filter((t) => Date.now() - t < 3600_000);
    kept.length ? createTimes.set(k, kept) : createTimes.delete(k);
  }
}
setInterval(() => reap().catch((e) => log("reap_failed", { message: e.message })), 60_000);

const MIME = { ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  const clean = path.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = path.join(SITE_DIR, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(SITE_DIR + path.sep) && file !== path.join(SITE_DIR, "index.html"))
    return json(res, 404, { error: "not_found" });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "content-length": data.length });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://x");
    const seg = pathname.split("/").filter(Boolean);
    if (seg[0] === "api" && seg[1] === "demo-sessions") {
      if (req.method === "POST" && seg.length === 2) return await createDemoSession(req, res);
      if (req.method === "GET" && seg.length === 3) return await getDemoSession(res, seg[2]);
      if (req.method === "DELETE" && seg.length === 3) return await destroyDemoSession(res, seg[2]);
      if (req.method === "POST" && seg.length === 4 && seg[3] === "terminal") return await openTerminal(req, res, seg[2]);
      if (req.method === "POST" && seg.length === 4 && seg[3] === "expose") return await exposePort(req, res, seg[2]);
      return json(res, 404, { error: "not_found" });
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    return json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    log("unhandled", { message: e.message });
    return json(res, 500, { error: "internal" });
  }
}).listen(PORT, () => log("broker_listening", { port: PORT, demoEnabled: DEMO_ENABLED, maxDemo: MAX_DEMO }));
