const fs = require("fs");
const { statePath, log } = require("./util");

/*
 * Writes .claude-review/feedback.md, which is delivered into Claude's
 * context on the next prompt (see bin/claude-review.js's `prompt`
 * handler), so a rejection made during review comes with the reason
 * you gave for it.
 */
function writeFeedback(repoRoot, model, selections, reasons) {
  const rejected = [];
  for (const f of model.files) {
    for (const h of f.hunks) {
      const sel = selections[h.id];
      if (sel && sel.lines && sel.lines.length) {
        const changed = h.lines.filter((l) => l[0] === "+" || l[0] === "-").length;
        rejected.push({
          file: f.filePath,
          header: h.header,
          partial: sel.lines.length < changed,
          reason: (reasons && reasons[h.id]) || "",
        });
      }
    }
  }
  if (!rejected.length) return;
  const lines = [
    "# Review feedback for Claude",
    "",
    "The user reviewed your last session's changes and REJECTED the following",
    "(they have been reverted). Do not re-apply them as written.",
    "",
  ];
  for (const r of rejected) {
    lines.push(`- ${r.file} at ${r.header}${r.partial ? " (some lines only)" : ""}`);
    if (r.reason) lines.push(`  Reason: ${r.reason}`);
  }
  fs.writeFileSync(statePath(repoRoot, "feedback.md"), lines.join("\n") + "\n");
  log(repoRoot, `feedback written (${rejected.length} rejected hunks)`);
}

module.exports = { writeFeedback };
