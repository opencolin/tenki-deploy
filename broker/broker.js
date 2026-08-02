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
    tracked[session.id] = { createdAt: now, ipHash, terminal: null };
    saveState();
    recent.push(now);
    createTimes.set(ipHash, recent);
    log("demo_created", { id: session.id, ipHash });
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

async function openTerminal(res, id) {
  const entry = tracked[id];
  if (!entry) return json(res, 404, { error: "not_found" });
  if (entry.terminal && new Date(entry.terminal.expiresAt) > new Date(Date.now() + 60_000))
    return json(res, 200, entry.terminal);
  try {
    const s = await client.get(id);
    if (s.state !== "RUNNING") return json(res, 409, { error: "not_running", state: s.state });

    // Unguessable base path is the terminal's access control (plus the random
    // preview host): ttyd serves only under /t-<token>/, 404s everything else.
    const token = crypto.randomBytes(16).toString("base64url");
    const start =
      `pkill -x ttyd 2>/dev/null; ` +
      `nohup ttyd -p ${TTYD_PORT} -W -b /t-${token} bash >/tmp/ttyd.log 2>&1 </dev/null & ` +
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
    };
    saveState();
    log("terminal_opened", { id });
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
      if (req.method === "POST" && seg.length === 4 && seg[3] === "terminal") return await openTerminal(res, seg[2]);
      return json(res, 404, { error: "not_found" });
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    return json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    log("unhandled", { message: e.message });
    return json(res, 500, { error: "internal" });
  }
}).listen(PORT, () => log("broker_listening", { port: PORT, demoEnabled: DEMO_ENABLED, maxDemo: MAX_DEMO }));
