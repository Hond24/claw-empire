/**
 * [solo-company] Hardened git execution (M1).
 *
 * Every git command the server runs inherits these settings through the GIT_CONFIG_* env
 * protocol, so a repository can never make the trusted server execute code:
 *   core.hooksPath=/dev/null   no hooks (pre-commit, post-merge, ...)
 *   core.fsmonitor=false       no fsmonitor command
 *   protocol.ext.allow=never   no ext:: transport commands
 * (SSH/askpass settings are left alone so existing push features keep working.)
 *   GIT_CONFIG_NOSYSTEM=1      ignore /etc/gitconfig
 * Agents never get git access themselves (no shell); this protects the merge path.
 */
import { execFileSync } from "node:child_process";

export const HARDENED_GIT_CONFIG: Array<[string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
];

/** Return env with the hardened config appended to any existing GIT_CONFIG_COUNT entries. */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // drop anything that could redirect git to attacker-controlled config or dirs
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF"]) {
    delete env[k];
  }
  let count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isInteger(count) || count < 0) count = 0;
  for (const [key, value] of HARDENED_GIT_CONFIG) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

let processHardened = false;
/** Apply to the server process once at startup, so upstream git calls inherit it too. */
export function hardenProcessGitEnvironment(): void {
  if (processHardened) return;
  const env = hardenedGitEnv(process.env);
  for (const [k, v] of Object.entries(env)) if (k.startsWith("GIT_") && v !== undefined) process.env[k] = v;
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF"]) delete process.env[k];
  processHardened = true;
}

export function gitSafe(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number; binary?: boolean } = {}): string {
  return execFileSync("git", args, {
    cwd,
    env: hardenedGitEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? 15000,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
}

/** Absolute path of the main repository for a worktree (or the repo itself). */
export function mainRepoOf(worktreeOrRepo: string): string {
  const common = gitSafe(worktreeOrRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return common.endsWith("/.git") ? common.slice(0, -5) : common.replace(/\/\.git\/?$/, "");
}
