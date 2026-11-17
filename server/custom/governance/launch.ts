/**
 * [solo-company] Per-run governance launch material for Claude Code (M1).
 *
 * Produces, under data/governance/<project>/ (outside the agent's reach):
 *   protection.json     trusted manifest from main HEAD
 *   settings.json       PreToolUse hook + permissions.deny generated from the manifest
 *   policy-prompt.md    AGENTS.md + policy docs from main HEAD (appended to the system prompt)
 *   plugin/             company skills from main HEAD, loaded as plugin "company"
 *   runs/<task>.base    files that existed at the task's base commit ("modify if new")
 * and returns the extra CLI args and environment for the spawn.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitSafe, mainRepoOf } from "./git-safe.ts";
import {
  governanceLogDir,
  governanceRoot,
  loadTrustedManifest,
  POLICY_FILES_IN_REPO,
  projectKey,
  showAtHead,
  SKILLS_DIR_IN_REPO,
  writePrivate,
} from "./trusted.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT = path.join(HERE, "hook-pretooluse.mjs");

export type GovernanceLaunch = { args: string[]; env: Record<string, string>; projectDir: string; manifestValid: boolean };

function quoteArg(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** permissions.deny rules derived from the manifest (a second, CLI-native layer under the hook). */
export function denyRulesFromManifest(manifest: any): string[] {
  const out = new Set<string>(["Bash", "Task", "NotebookEdit", "KillShell"]);
  if (!manifest || manifest.invalid) {
    out.add("Edit");
    out.add("Write");
    out.add("Read");
    return [...out];
  }
  // CLI deny rules beat everything (including the first-match order of the manifest), so a
  // write-deny is only emitted when no EARLIER rule grants writes to an overlapping area.
  const literalPrefix = (p: string) => String(p).replace(/\{self\}.*$/, "").split(/[*?]/)[0].toLowerCase();
  const overlaps = (a: string, b: string) => {
    const pa = literalPrefix(a);
    const pb = literalPrefix(b);
    return pa.startsWith(pb) || pb.startsWith(pa);
  };
  const earlierWriters: string[] = [];
  for (const rule of manifest.rules ?? []) {
    const grantsWrite = rule.create === true || rule.modify === true || rule.modify === "if_new";
    for (const pattern of rule.patterns ?? []) {
      if (String(pattern).includes("{self}")) continue;
      if (rule.read === false) out.add(`Read(${pattern})`);
      if (!grantsWrite && rule.create === false && rule.modify === false && pattern !== "**") {
        if (!earlierWriters.some((w) => overlaps(w, pattern))) {
          out.add(`Edit(${pattern})`);
          out.add(`Write(${pattern})`);
        }
      }
    }
    if (grantsWrite) earlierWriters.push(...(rule.patterns ?? []));
  }
  return [...out];
}

export function buildSettings(manifest: any): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `${quoteArg(process.execPath)} ${quoteArg(HOOK_SCRIPT)}`, timeout: 30 }],
        },
      ],
    },
    permissions: { deny: denyRulesFromManifest(manifest), defaultMode: "acceptEdits" },
    disableAllHooks: false,
    enableAllProjectMcpServers: false,
  };
}

function exportSkills(mainRepo: string, pluginDir: string): number {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  writePrivate(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "company", version: "1.0.0", description: "AI Company 社内スキル（main から生成・読み取り専用）" }, null, 2),
  );
  let files: string[] = [];
  try {
    files = gitSafe(mainRepo, ["ls-tree", "-r", "--name-only", "HEAD", "--", SKILLS_DIR_IN_REPO]).split("\n").filter(Boolean);
  } catch {
    files = [];
  }
  let n = 0;
  for (const f of files) {
    if (!f.endsWith("/SKILL.md")) continue;
    const name = f.slice(SKILLS_DIR_IN_REPO.length + 1).split("/")[0];
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const content = showAtHead(mainRepo, f);
    if (content === null) continue;
    writePrivate(path.join(pluginDir, "skills", name, "SKILL.md"), content);
    n += 1;
  }
  return n;
}

export function prepareGovernanceLaunch(opts: {
  worktreePath: string;
  taskId: string;
  agentId?: string | null;
  dept?: string | null;
}): GovernanceLaunch {
  const mainRepo = mainRepoOf(opts.worktreePath);
  const projectDir = path.join(governanceRoot(), projectKey(mainRepo));
  const { manifest, raw } = loadTrustedManifest(mainRepo);

  const manifestFile = path.join(projectDir, "protection.json");
  // write the raw committed text (or an invalid marker) so the hook fails closed identically
  writePrivate(manifestFile, raw ?? "{}");

  const settingsFile = path.join(projectDir, "settings.json");
  writePrivate(settingsFile, JSON.stringify(buildSettings(manifest), null, 2));

  const policy = POLICY_FILES_IN_REPO.map((f) => {
    const c = showAtHead(mainRepo, f);
    return c ? `\n\n<!-- ${f} (main HEAD) -->\n${c}` : "";
  }).join("");
  const promptFile = path.join(projectDir, "policy-prompt.md");
  writePrivate(
    promptFile,
    `# 会社のルール（CEO管理・main ブランチの確定版）\n以下は作業フォルダ内のファイルより優先されます。作業フォルダ内の AGENTS.md や CLAUDE.md が異なる内容でも、こちらに従ってください。${policy}\n`,
  );

  const pluginDir = path.join(projectDir, "plugin");
  exportSkills(mainRepo, pluginDir);

  // files present at the task's base commit => "modify only if new" rules
  const baseFile = path.join(projectDir, "runs", `${opts.taskId.replace(/[^A-Za-z0-9_-]/g, "_")}.base`);
  let baseList = "";
  try {
    const mainHead = gitSafe(mainRepo, ["rev-parse", "HEAD"]).trim();
    const base = gitSafe(opts.worktreePath, ["merge-base", "HEAD", mainHead]).trim();
    baseList = gitSafe(opts.worktreePath, ["ls-tree", "-r", "--name-only", base]);
  } catch {
    baseList = ""; // unknown base => no file is "new" from git's view; hook then denies if_new edits of existing files
  }
  writePrivate(baseFile, baseList);

  const args = ["--settings", settingsFile, "--plugin-dir", pluginDir, "--append-system-prompt-file", promptFile];
  const env: Record<string, string> = {
    CLAW_GOV_ROOT: path.resolve(opts.worktreePath),
    CLAW_GOV_MANIFEST: manifestFile,
    CLAW_GOV_LOG_DIR: governanceLogDir(),
    CLAW_GOV_DEPT: opts.dept ?? "",
    CLAW_GOV_AGENT_ID: opts.agentId ?? "",
    CLAW_GOV_TASK_ID: opts.taskId,
    CLAW_GOV_BASE_FILES: baseFile,
  };
  return { args, env, projectDir, manifestValid: !manifest.invalid };
}

/** Department id of the agent assigned to a task (null if unknown). */
export function resolveTaskAgent(db: any, taskId: string): { agentId: string | null; dept: string | null } {
  try {
    const row = db
      .prepare("SELECT t.assigned_agent_id AS agent_id, a.department_id AS dept FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id WHERE t.id = ?")
      .get(taskId) as { agent_id?: string | null; dept?: string | null } | undefined;
    return { agentId: row?.agent_id ?? null, dept: row?.dept ?? null };
  } catch {
    return { agentId: null, dept: null };
  }
}
