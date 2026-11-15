/**
 * Solo-company customization: safe permission mode for AI employees.
 *
 * Upstream launches agents with full autonomy:
 *   claude  --dangerously-skip-permissions
 *   codex   --yolo
 *   gemini  --yolo
 *
 * In safe mode (default for this fork) agents may read, edit files inside their
 * working directory and research the web, but cannot run shell commands. That
 * blocks git push, curl POSTs, deploys, SNS posting scripts, payments, etc.
 * Anything external must go through a CEO approval request instead
 * (see approval-requests.ts).
 *
 * Env:
 *   CLAW_AGENT_PERMISSION_MODE = safe (default) | legacy
 *   CLAW_SAFE_ALLOWED_TOOLS    = override Claude allowed tool list (comma separated)
 */

export type AgentPermissionMode = "safe" | "legacy";

export const DEFAULT_SAFE_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

// Tools explicitly denied even if a provider/version would otherwise allow them.
export const SAFE_DISALLOWED_TOOLS = ["Bash", "NotebookEdit", "KillShell"];

export function resolveAgentPermissionMode(raw: string | undefined = process.env.CLAW_AGENT_PERMISSION_MODE): AgentPermissionMode {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "legacy" || value === "unsafe" || value === "yolo") return "legacy";
  return "safe";
}

function resolveAllowedTools(): string[] {
  const raw = process.env.CLAW_SAFE_ALLOWED_TOOLS;
  if (!raw || !raw.trim()) return DEFAULT_SAFE_ALLOWED_TOOLS;
  const tools = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    // Never let the override re-enable unrestricted shell
    .filter((t) => t !== "Bash" && !t.startsWith("Bash("));
  return tools.length > 0 ? tools : DEFAULT_SAFE_ALLOWED_TOOLS;
}

/**
 * Rewrite upstream CLI args into safe-mode args. Pure function (unit tested).
 * Returns args unchanged in legacy mode.
 */
export function applyPermissionMode(
  provider: string,
  args: string[],
  mode: AgentPermissionMode = resolveAgentPermissionMode(),
): string[] {
  if (mode === "legacy") return args;
  const out = [...args];
  switch (provider) {
    case "claude": {
      const idx = out.indexOf("--dangerously-skip-permissions");
      if (idx >= 0) out.splice(idx, 1);
      // no-tools runs (meetings) already pass --tools= ; keep them tool-less
      if (out.includes("--tools=")) {
        out.push("--permission-mode", "default");
        return out;
      }
      out.push(
        "--permission-mode",
        "acceptEdits",
        `--allowedTools=${resolveAllowedTools().join(",")}`,
        `--disallowedTools=${SAFE_DISALLOWED_TOOLS.join(",")}`,
      );
      return out;
    }
    case "codex": {
      const idx = out.indexOf("--yolo");
      if (idx >= 0) out.splice(idx, 1);
      // workspace-write sandbox: edits inside cwd only, no network for commands
      const execIdx = out.indexOf("exec");
      const sandboxIdx = out.indexOf("--sandbox");
      if (sandboxIdx < 0) {
        const insertAt = execIdx >= 0 ? execIdx : out.length;
        out.splice(insertAt, 0, "--sandbox", "workspace-write");
      }
      return out;
    }
    case "gemini": {
      const idx = out.indexOf("--yolo");
      if (idx >= 0) {
        out.splice(idx, 1, "--approval-mode", "auto_edit");
      }
      return out;
    }
    default:
      // opencode / kimi have no equivalent flag wired yet: warn loudly.
      if (!warnedProviders.has(provider)) {
        warnedProviders.add(provider);
        console.warn(
          `[safe-mode] provider '${provider}' has no safe-mode mapping; it runs with its own defaults. ` +
            `Prefer claude/codex/gemini for AI employees.`,
        );
      }
      return out;
  }
}

const warnedProviders = new Set<string>();

/** Text appended to every task prompt so agents know how to request external actions. */
export const SAFE_MODE_PROMPT_NOTE = [
  "",
  "[Company policy / 会社方針]",
  "- You cannot run shell commands or perform external actions (posting to SNS, sending email, payments, publishing, pushing code, contacting customers).",
  "- If such an action is needed, do NOT attempt it. Output exactly one line per request in this format and continue with the rest of your work:",
  // NOTE: the example below is intentionally NOT valid JSON ({...}) so an echoed prompt never creates a request.
  '  [[CEO_APPROVAL_REQUEST]]{"action_type":"sns_post|email|publish|payment|git_push|external_api|other","target":"<where>","summary":"<what and why, in Japanese>","payload":{...}}[[/CEO_APPROVAL_REQUEST]]',
  "- Never include customer personal or health information in outputs.",
].join("\n");
