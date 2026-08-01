#!/usr/bin/env node
/*
 * claude-review — batch diff review for Claude Code.
 *
 * Subcommands (wired to Claude Code hooks):
 *   snapshot   SessionStart hook    — record a git baseline of the working tree
 *   prompt     UserPromptSubmit hook — reset the per-request baseline, deliver feedback
 *   open       Stop hook            — build diff vs baseline, launch review UI in browser
 *   review     manual               — same as open, run by hand any time
 *
 * All state lives in .claude-review/ inside the repo (gitignore it).
 * Hooks must exit 0 quickly and never block Claude, so every command
 * is defensive: any failure logs to .claude-review/log.txt and exits 0.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { log, readStdinJson, findRepoRoot, statePath } = require("../lib/util");

const cmd = process.argv[2];
const USAGE = "Usage: claude-review <snapshot|prompt|open|review>";
// Commands a person types directly (as opposed to hooks Claude Code
// fires silently in the background) should always say SOMETHING when
// they can't find a project, rather than exiting with no output at
// all — that's confusing regardless of which manual command it was.
const MANUAL_CMDS = ["review"];

async function main() {
  if (!cmd) {
    console.log(USAGE);
    process.exit(0);
  }
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    if (MANUAL_CMDS.includes(cmd)) {
      console.log(`claude-review: this folder (${process.cwd()}) isn't inside a git repository. Run this from your project folder instead.`);
    }
    process.exit(0);
  }
  // Safety: a git repo accidentally created at the user's home directory
  // would make us snapshot their entire profile. Refuse.
  if (path.resolve(repoRoot) === path.resolve(os.homedir())) {
    log(repoRoot, `SKIP ${cmd}: repo root is the home directory. Run 'git init' inside your project folder instead.`);
    if (MANUAL_CMDS.includes(cmd)) {
      console.log("claude-review: your project resolved to a git repo at your HOME directory — refusing. Run 'git init' inside the project folder.");
    }
    process.exit(0);
  }

  switch (cmd) {
    case "snapshot": {
      const { snapshot } = require("../lib/snapshot");
      snapshot(repoRoot, { reset: true });
      break;
    }
    case "prompt": {
      // 1) Feedback loop: UserPromptSubmit stdout is added to Claude's
      // context. If the last review rejected anything, deliver the
      // reasons to Claude exactly once, then clear the file.
      const fbPath = path.join(repoRoot, ".claude-review", "feedback.md");
      try {
        const fb = fs.readFileSync(fbPath, "utf8");
        if (fb.trim()) console.log(fb);
        fs.unlinkSync(fbPath);
      } catch (_) {}
      // 2) Always advance the per-request baseline so "This turn" shows
      // only the current prompt's changes. The accumulate baseline
      // (sessionStart in session.json) is preserved separately inside
      // snapshot() and is never affected by this call.
      { const { snapshot } = require("../lib/snapshot"); snapshot(repoRoot); }
      break;
    }
    case "open":
    case "review": {
      const { openReview } = require("../lib/server");
      const hookInput = cmd === "open" ? await readStdinJson() : null;
      await openReview(repoRoot, { manual: cmd === "review", hookInput });
      break;
    }
    case "serve": {
      const { serve } = require("../lib/server");
      serve(repoRoot);
      return; // keep process alive
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  try {
    log(findRepoRoot(process.cwd()) || process.cwd(), `FATAL ${cmd}: ${err.stack}`);
  } catch (_) {}
  // Hooks must not fail Claude's session.
  process.exit(0);
});
