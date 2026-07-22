const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { buildReviewModel } = require("./diff");
const { revertSelection } = require("./revert");
const { statePath, readJson, log } = require("./util");
const { writeFeedback } = require("./feedback");

const VERSION = require("../package.json").version;

/*
 * A single fixed port would let different projects collide and
 * silently answer for each other (stale diffs, wrong "still open"
 * detection). Deriving a port from the project's own path avoids
 * this entirely: every repo gets its own, so two projects can even
 * have review tabs open at the same time without conflict.
 */
function portFor(repoRoot) {
  const h = crypto.createHash("sha1").update(path.resolve(repoRoot)).digest();
  return 4600 + (h.readUInt16BE(0) % 400); // 4600–4999
}

function reviewSig(repoRoot) {
  try {
    const st = fs.statSync(statePath(repoRoot, "review.json"));
    return st.mtimeMs + "-" + st.size;
  } catch (_) {
    return "none";
  }
}

/*
 * Called from the Stop hook. Hooks must return fast, so we spawn a
 * detached copy of ourselves running `serve` and exit immediately.
 * Skips silently when Claude made no edits this session.
 */
async function openReview(repoRoot, { manual, hookInput } = {}) {
  const port = portFor(repoRoot);

  // Scope to exactly what Claude edited this turn, read from the
  // session transcript. No edits recorded -> exit before ANY git work.
  // transcriptFilter is a safety valve in case transcript parsing ever
  // misbehaves on a future Claude Code version; set { "transcriptFilter":
  // false } in .claude-review/config.json to fall back to showing every
  // change since the session baseline.
  const transcriptFilterEnabled =
    readJson(statePath(repoRoot, "config.json"), {}).transcriptFilter !== false;
  if (!manual && hookInput && hookInput.transcript_path && transcriptFilterEnabled) {
    const { editedFiles } = require("./transcript");
    const edited = editedFiles(hookInput.transcript_path);
    if (edited !== null) {
      const rel = edited
        .map((p) => (path.isAbsolute(p) ? path.relative(repoRoot, p) : p))
        .filter((p) => p && !p.startsWith(".."));
      if (!rel.length) {
        log(repoRoot, "transcript shows no file edits — skipping (fast path)");
        return;
      }
      const sessionFile = statePath(repoRoot, "session.json");
      const session = readJson(sessionFile, null);
      if (session) {
        const merged = new Set([...(session.files || []), ...rel]);
        session.files = [...merged];
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
      }
    }
  }

  const model = buildReviewModel(repoRoot);
  if (model.error || !model.files.length) {
    if (manual) console.log(model.error || "No changes to review.");
    return;
  }

  // Fire only when there is something NEW. Claude Code runs the Stop
  // hook at the end of every turn — without this the browser would
  // re-open for the same unreviewed diff again and again.
  const sig = crypto.createHash("sha1").update(JSON.stringify(model.files)).digest("hex");
  const sigFile = statePath(repoRoot, "opened.sig");
  let lastSig = "";
  try { lastSig = fs.readFileSync(sigFile, "utf8"); } catch (_) {}
  if (sig === lastSig && !manual) {
    log(repoRoot, "diff unchanged since last offer — not reopening");
    return;
  }
  fs.writeFileSync(sigFile, sig);
  // Freeze this review. In per-request mode the baseline moves on every
  // prompt, so a live-computed diff would evaporate the moment the user
  // sends their next message. The UI serves this frozen model instead.
  fs.writeFileSync(statePath(repoRoot, "review.json"), JSON.stringify(model));

  // A server for THIS repo may already be running (same deterministic
  // port). Don't spawn a duplicate — but do (re)open the tab unless a
  // viewer is actively there, and always replace a server from an
  // older plugin version so an update never silently keeps serving
  // stale code.
  let alive = await serverAlive(port);
  let hadViewerBeforeKill = false;
  if (alive && alive.version !== VERSION) {
    log(repoRoot, `stale server v${alive.version || "?"} detected (current v${VERSION}) — replacing`);
    hadViewerBeforeKill = !!alive.viewing;
    killStaleServer(repoRoot);
    await new Promise((r) => setTimeout(r, 300));
    alive = await serverAlive(port);
  }
  if (alive) {
    if (alive.viewing) {
      log(repoRoot, "review tab already open — it will update in place");
    } else {
      log(repoRoot, "server already running — opening tab for new review");
      openBrowser(`http://localhost:${port}`);
    }
    if (manual) console.log(`Review UI: http://localhost:${port}`);
    return;
  }

  // Spawning a brand-new server. Its own startup normally auto-opens a
  // tab, correct for a first launch, but not right after killing a
  // stale-version server that had an active viewer: that tab is still
  // alive and will transparently reconnect once this server is
  // listening on the same port (its poll loop doesn't know or care
  // that the process underneath it changed). Auto-opening a second
  // tab in that case would be redundant, since the existing one is
  // about to reconnect on its own.
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "bin", "claude-review.js"), "serve"],
    {
      cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, CLAUDE_REVIEW_SKIP_AUTOOPEN: hadViewerBeforeKill ? "1" : "" },
    }
  );
  child.unref();
  log(repoRoot, `spawned review server pid=${child.pid} port=${port}${hadViewerBeforeKill ? " (skip-autoopen, existing tab will reconnect)" : ""}`);
  if (manual) console.log(`Review UI: http://localhost:${port}`);
}

function serve(repoRoot) {
  const port = portFor(repoRoot);
  let lastPoll = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      const html = fs
        .readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")
        .replace(/__CR_VERSION__/g, VERSION);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && req.url === "/api/review") {
      const model = readJson(statePath(repoRoot, "review.json"), null) || buildReviewModel(repoRoot);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(model));
      return;
    }
    if (req.method === "GET" && req.url === "/api/sig") {
      lastPoll = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sig: reviewSig(repoRoot), version: VERSION }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/close") {
      lastPoll = 0; // tab gone — next review should open a fresh tab
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Browsers throttle timers in backgrounded (unfocused) tabs, so
      // a tab that's genuinely still open can go quite a while between
      // polls if it's not the active tab. A short window here would
      // wrongly treat that as "closed." Two minutes comfortably
      // tolerates normal throttling while still self-healing if a tab
      // is genuinely gone without firing the close beacon (crash, etc).
      res.end(JSON.stringify({ viewing: Date.now() - lastPoll < 120000, version: VERSION }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { selections = {}, reasons = {} } = JSON.parse(body || "{}");
          const model = readJson(statePath(repoRoot, "review.json"), null) || buildReviewModel(repoRoot);
          const results = revertSelection(repoRoot, model, selections, reasons);
          writeFeedback(repoRoot, model, selections, reasons);
          // Move the baseline forward: everything up to now is reviewed.
          try {
            require("./snapshot").snapshot(repoRoot);
            fs.unlinkSync(statePath(repoRoot, "opened.sig"));
          } catch (_) {}
          try { fs.unlinkSync(statePath(repoRoot, "review.json")); } catch (_) {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results }));
          setTimeout(() => server.close(() => process.exit(0)), 1500);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  // A recently-active server.pid means a server ran here within the
  // last few minutes — the only situation where a tab could plausibly
  // still be mid-reconnect. Checking mere existence isn't enough: this
  // file is never deleted, only overwritten, so that would make every
  // future session for a project pay the delay forever, even days
  // later when the previous tab is long since closed. A genuine first
  // launch, or a session starting well after any previous one ended,
  // has no possible tab to wait for, so it can open immediately.
  const pidPath = statePath(repoRoot, "server.pid");
  let isRecentRestart = false;
  try {
    const ageMs = Date.now() - fs.statSync(pidPath).mtimeMs;
    isRecentRestart = ageMs < 5 * 60 * 1000; // 5 minutes
  } catch (_) {} // no prior server.pid at all — definitely not a restart
  fs.writeFileSync(pidPath, String(process.pid));
  server.listen(port, "127.0.0.1", () => {
    log(repoRoot, `review server v${VERSION} listening on ${port} for ${repoRoot}`);
    if (process.env.CLAUDE_REVIEW_SKIP_AUTOOPEN === "1") {
      log(repoRoot, "skipping auto-open — an existing tab is expected to reconnect to this server");
      return;
    }
    if (!isRecentRestart) {
      log(repoRoot, "no recent prior server for this project — opening immediately, no reconnecting tab is possible");
      openBrowser(`http://localhost:${port}`);
      return;
    }
    // A fresh server process has no memory of a tab that was polling a
    // PREVIOUS incarnation — that tracking is in-memory and dies with
    // the old process, regardless of why it died (version-mismatch
    // restart, a crash, being killed during a reinstall, whatever). If
    // a real tab is still open, its poll loop (every 1s) is still
    // running and will reach this new server soon. Three seconds still
    // gives about three full poll cycles of margin — kept the ratio
    // that fixed the original intermittent duplicate-tab bug, just
    // scaled both numbers down together rather than only shrinking
    // the wait and reintroducing that tight-margin race. Opening a
    // duplicate is a worse outcome than a few seconds' delay — but
    // only paid right after an actual recent restart now, not on
    // every single launch regardless of history.
    const graceStart = Date.now();
    setTimeout(() => {
      if (lastPoll >= graceStart) {
        log(repoRoot, "existing tab reconnected during startup grace period — not opening a duplicate");
      } else {
        openBrowser(`http://localhost:${port}`);
      }
    }, 3000);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") process.exit(0);
    log(repoRoot, `server error: ${err.message}`);
  });

  // Safety: don't linger forever if the tab is never opened.
  setTimeout(() => process.exit(0), 30 * 60 * 1000).unref();
}

function serverAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/status", timeout: 400, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (_) { resolve({ viewing: false, version: null }); }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Kill a running server left over from an older plugin version, so an
// update always takes effect instead of silently talking to stale code.
function killStaleServer(repoRoot) {
  try {
    const pid = parseInt(fs.readFileSync(statePath(repoRoot, "server.pid"), "utf8"), 10);
    if (pid) process.kill(pid, "SIGTERM");
    log(repoRoot, `killed stale server pid=${pid}`);
  } catch (_) {}
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  execFile(cmd[0], cmd[1], { windowsHide: true }, () => {});
}

module.exports = { openReview, serve };
