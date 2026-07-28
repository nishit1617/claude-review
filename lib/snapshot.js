const fs = require("fs");
const { git, statePath, readJson, writeJson, log } = require("./util");

/*
 * Record a baseline of the working tree at session start, without
 * modifying the tree, the index, or HEAD.
 *
 * Trick: build a temporary index, `git add -A` into it, write a tree,
 * and create a dangling commit object pointing at it. The commit hash
 * is our baseline — later diffs run `git diff <baseline> -- <files>`,
 * so the user's own pre-session uncommitted edits are part of the
 * baseline and never show up in the per-request review. (Accumulate
 * mode doesn't use this baseline at all — it diffs live against HEAD,
 * see lib/diff.js.)
 */
// reset:true is passed by the SessionStart hook to begin a fresh session.
// Mid-session calls (UserPromptSubmit, post-submit) pass reset:false so
// that sessionStart — the accumulate-mode baseline — is preserved across
// per-request snapshots and survives for the lifetime of the session.
function snapshot(repoRoot, { reset = false } = {}) {
  ensureExcluded(repoRoot);
  const tmpIndex = statePath(repoRoot, "tmp-index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

  // Seed temp index from HEAD if it exists (empty repo is fine too).
  let head = null;
  try {
    head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    git(repoRoot, ["read-tree", "HEAD"], { env });
  } catch (_) {
    /* unborn branch — start from empty index */
  }

  git(repoRoot, ["add", "-A", "--", "."], { env });
  const tree = git(repoRoot, ["write-tree"], { env }).trim();
  const parentArgs = head ? ["-p", head] : [];
  const commit = git(
    repoRoot,
    ["commit-tree", tree, ...parentArgs, "-m", "claude-review baseline"],
    { env }
  ).trim();

  const existing = reset ? {} : (readJson(statePath(repoRoot, "session.json"), {}));
  writeJson(statePath(repoRoot, "session.json"), {
    baseline: commit,
    sessionStart: existing.sessionStart || commit,
    startedAt: existing.startedAt || new Date().toISOString(),
    files: [],
  });

  try { fs.unlinkSync(statePath(repoRoot, "opened.sig")); } catch (_) {}
  log(repoRoot, `snapshot baseline=${commit}${reset ? " (session reset)" : ""}`);
}

/*
 * Keep .claude-review/ from showing up as untracked, without touching
 * the user's tracked .gitignore: .git/info/exclude is git's repo-local,
 * untracked ignore file.
 */
function ensureExcluded(repoRoot) {  try {
    const path = require("path");
    const gitDir = git(repoRoot, ["rev-parse", "--git-dir"]).trim();
    const abs = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
    const excl = path.join(abs, "info", "exclude");
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    let cur = "";
    try { cur = fs.readFileSync(excl, "utf8"); } catch (_) {}
    if (!cur.split(/\r?\n/).includes(".claude-review/")) {
      fs.appendFileSync(excl, (cur.endsWith("\n") || !cur ? "" : "\n") + ".claude-review/\n");
    }
  } catch (_) {}
}

module.exports = { snapshot };
