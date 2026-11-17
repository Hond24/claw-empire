/**
 * [solo-company] Merge gate (M1).
 *
 * Runs on the trusted server before a task branch is merged into the project's main branch.
 * Every changed path between the merge base and the task branch is judged by the trusted
 * manifest (main HEAD). Any violation => the merge is refused and recorded. This is the
 * layer that still holds even if an agent somehow bypassed the hook inside its worktree.
 */
import fs from "node:fs";
import path from "node:path";
// @ts-ignore - plain ESM JS shared with the hook
import { evaluate } from "./policy-engine.mjs";
import { gitSafe } from "./git-safe.ts";
import { governanceLogDir, loadTrustedManifest } from "./trusted.ts";

export type BranchChange = { status: string; oldMode: string; newMode: string; path: string };
export type MergeViolation = { path: string; op: string; reason: string; ruleId: string | null };

/** Parse `git diff --raw -z --no-renames` output. */
export function parseRawDiff(out: string): BranchChange[] {
  const parts = out.split("\0");
  const changes: BranchChange[] = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const meta = parts[i];
    const p = parts[i + 1];
    if (!meta || !meta.startsWith(":")) continue;
    const [oldMode, newMode, , , status] = meta.slice(1).split(" ");
    changes.push({ status: status.charAt(0), oldMode, newMode, path: p });
  }
  return changes;
}

export function listBranchChanges(mainRepo: string, branch: string): { base: string; changes: BranchChange[] } {
  const head = gitSafe(mainRepo, ["rev-parse", "HEAD"]).trim();
  const base = gitSafe(mainRepo, ["merge-base", head, branch]).trim();
  const out = gitSafe(mainRepo, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, branch]);
  return { base, changes: parseRawDiff(out) };
}

export function judgeChanges(manifest: any, changes: BranchChange[], dept: string | null): MergeViolation[] {
  const violations: MergeViolation[] = [];
  for (const c of changes) {
    if (c.newMode === "120000" || c.oldMode === "120000") {
      violations.push({ path: c.path, op: "symlink", reason: "シンボリックリンクは取り込めません", ruleId: null });
      continue;
    }
    if (c.newMode === "160000" || c.oldMode === "160000") {
      violations.push({ path: c.path, op: "submodule", reason: "サブモジュールは取り込めません", ruleId: null });
      continue;
    }
    let op: string;
    let isNew = false;
    switch (c.status) {
      case "A":
        op = "create";
        isNew = true;
        break;
      case "M":
        op = "modify";
        isNew = false; // existed at the merge base
        break;
      case "D":
        op = "delete";
        break;
      default:
        violations.push({ path: c.path, op: c.status, reason: `種類「${c.status}」の変更は取り込めません`, ruleId: null });
        continue;
    }
    if (c.status !== "D" && c.newMode && c.newMode !== "100644" && c.newMode !== "100755") {
      violations.push({ path: c.path, op, reason: `ファイル種別 ${c.newMode} は取り込めません`, ruleId: null });
      continue;
    }
    const res = evaluate(manifest, { op, rel: c.path, dept, isNew });
    if (!res.allow) violations.push({ path: c.path, op, reason: res.reason, ruleId: res.ruleId });
  }
  return violations;
}

export function checkMergeAllowed(mainRepo: string, branch: string, dept: string | null) {
  const { manifest } = loadTrustedManifest(mainRepo);
  const { base, changes } = listBranchChanges(mainRepo, branch);
  const violations = judgeChanges(manifest, changes, dept);
  return { ok: violations.length === 0, base, changes, violations, manifestValid: !manifest.invalid };
}

export function recordViolations(records: Array<Record<string, unknown>>): void {
  if (records.length === 0) return;
  const dir = governanceLogDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = records.map((r) => JSON.stringify({ ts: new Date().toISOString(), ...r })).join("\n") + "\n";
  fs.appendFileSync(path.join(dir, "violations.jsonl"), lines, { mode: 0o600 });
}

export function readJsonl(file: string, limit = 200): unknown[] {
  try {
    const lines = fs.readFileSync(path.join(governanceLogDir(), file), "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unparsable: l.slice(0, 200) };
      }
    });
  } catch {
    return [];
  }
}
