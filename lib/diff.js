const { git, statePath, readJson } = require("./util");

/*
 * Builds the review model shown in the browser: runs `git diff`
 * between the session baseline and the current working tree, and
 * parses the result into files -> hunks -> lines for the UI to render
 * and for lib/revert.js to act on.
 */

function getSession(repoRoot) {
  return readJson(statePath(repoRoot, "session.json"), null);
}

function rawDiff(repoRoot, baseline, files) {
  // Snapshot the current working tree the same way SessionStart did,
  // then diff commit-to-commit. Unlike `git diff <commit>` against the
  // worktree directly, this also picks up files Claude newly created
  // (untracked files are invisible to a commit-vs-worktree diff).
  const tmpIndex = statePath(repoRoot, "tmp-index-now");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(repoRoot, ["read-tree", "HEAD"], { env });
  } catch (_) {}
  git(repoRoot, ["add", "-A", "--", "."], { env });
  const tree = git(repoRoot, ["write-tree"], { env }).trim();
  const current = git(repoRoot, ["commit-tree", tree, "-m", "claude-review current"], {
    env,
  }).trim();
  const pathFilter = files && files.length ? ["--", ...files] : [];
  return git(repoRoot, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    baseline,
    current,
    ...pathFilter,
  ]);
}

function parseDiff(diffText) {
  const files = [];
  let current = null;
  let hunk = null;
  let hunkId = 0;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { header: [line], filePath: null, hunks: [], binary: false };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = {
        id: `h${hunkId++}`,
        header: line,
        oldStart: m ? parseInt(m[1], 10) : 0,
        newStart: m ? parseInt(m[3], 10) : 0,
        lines: [],
        additions: 0,
        deletions: 0,
      };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      // Hunk body: context (' '), add ('+'), del ('-'), or '\ No newline'
      if (/^[ +\-\\]/.test(line) || line === "") {
        hunk.lines.push(line);
        if (line.startsWith("+")) hunk.additions++;
        if (line.startsWith("-")) hunk.deletions++;
        continue;
      }
      hunk = null; // fell out of hunk body into next file header line
    }

    current.header.push(line);
    if (line.includes("Binary files")) current.binary = true;
    const plus = /^\+\+\+ b\/(.*)$/.exec(line);
    if (plus) current.filePath = plus[1];
    const minusOnly = /^--- a\/(.*)$/.exec(line);
    if (minusOnly && !current.filePath) current.filePath = minusOnly[1];
    if (line === "+++ /dev/null") current.deleted = true;
    if (line === "--- /dev/null") current.created = true;
  }

  // Fallback file path from the "diff --git a/x b/x" line (renames, /dev/null)
  for (const f of files) {
    if (!f.filePath) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(f.header[0]);
      if (m) f.filePath = m[2];
    }
  }
  return files.filter((f) => f.filePath);
}

function buildReviewModel(repoRoot) {
  const session = getSession(repoRoot);
  if (!session || !session.baseline) {
    return { error: "No session found. Did the SessionStart hook run?" };
  }
  const files = session.files || [];
  const diffText = rawDiff(repoRoot, session.baseline, files);
  const parsed = parseDiff(diffText);
  return {
    repoRoot,
    baseline: session.baseline,
    startedAt: session.startedAt,
    trackedFiles: files,
    files: parsed.map((f) => ({
      filePath: f.filePath,
      binary: !!f.binary,
      created: !!f.created,
      deleted: !!f.deleted,
      additions: f.hunks.reduce((n, h) => n + h.additions, 0),
      deletions: f.hunks.reduce((n, h) => n + h.deletions, 0),
      hunks: f.hunks.map((h) => ({
        id: h.id,
        header: h.header,
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines,
        additions: h.additions,
        deletions: h.deletions,
      })),
    })),
  };
}

module.exports = { buildReviewModel };
