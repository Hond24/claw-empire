/**
 * [solo-company] Trusted governance material (M1).
 *
 * Everything that decides what an AI employee may do is read from the project's MAIN repository
 * at its committed HEAD (`git show HEAD:<path>`), never from the agent's worktree or from
 * uncommitted files. Changes to these files can only reach main through the CEO
 * (the merge gate refuses agent changes to governance/, docs/, .claude/, ...).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// @ts-ignore - plain ESM JS shared with the hook
import { parseManifest } from "./policy-engine.mjs";
import { gitSafe } from "./git-safe.ts";

export const MANIFEST_PATH_IN_REPO = "governance/protection.json";
export const POLICY_FILES_IN_REPO = ["AGENTS.md", "docs/AI_EMPLOYEE_POLICY.md", "docs/FILE_PROTECTION.md"];
export const SKILLS_DIR_IN_REPO = ".claude/skills";

export function isGovernanceEnabled(raw: string | undefined = process.env.CLAW_GOVERNANCE): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

export function governanceRoot(): string {
  return path.resolve(process.env.CLAW_GOVERNANCE_DIR || path.join(process.cwd(), "data", "governance"));
}

export function governanceLogDir(): string {
  return path.join(governanceRoot(), "logs");
}

export function projectKey(mainRepo: string): string {
  return crypto.createHash("sha256").update(path.resolve(mainRepo)).digest("hex").slice(0, 12);
}

/** Committed file content at main HEAD, or null if absent. */
export function showAtHead(mainRepo: string, relPath: string): string | null {
  try {
    return gitSafe(mainRepo, ["show", `HEAD:${relPath}`]);
  } catch {
    return null;
  }
}

export function loadTrustedManifest(mainRepo: string): { manifest: any; raw: string | null; sha: string | null } {
  const raw = showAtHead(mainRepo, MANIFEST_PATH_IN_REPO);
  let sha: string | null = null;
  try {
    sha = gitSafe(mainRepo, ["rev-parse", "HEAD"]).trim();
  } catch {
    /* no commits */
  }
  // missing manifest => parseManifest("") => fail-closed manifest
  return { manifest: parseManifest(raw ?? ""), raw, sha };
}

export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}
