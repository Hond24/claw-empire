#!/usr/bin/env node
// [solo-company] Claude Code PreToolUse hook (M1).
//
// Wired by the server through `--settings <data/governance/.../settings.json>` (never through
// files inside the agent's worktree). Reads the hook JSON from stdin and answers with a
// PreToolUse permission decision. Every deny is appended to the violations log; every web
// access is appended to the web-access log. Any internal error => deny (fail closed).
//
// Environment (set by the server at spawn time; the agent has no shell to change it):
//   CLAW_GOV_ROOT       absolute path of the agent's working copy (worktree)
//   CLAW_GOV_MANIFEST   trusted protection.json (copied from the project's main branch)
//   CLAW_GOV_LOG_DIR    directory for violations.jsonl / web-access.jsonl (outside the root)
//   CLAW_GOV_DEPT       department id of the agent (planning|research|content|...)
//   CLAW_GOV_AGENT_ID   agent id (for logs)
//   CLAW_GOV_TASK_ID    task id (for logs)
//   CLAW_GOV_BASE_FILES newline-separated list of paths that existed at the task's base
//                       commit (file path). Used for "modify only if new" rules.

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { loadManifest, checkPath, resolveProjectPath, evaluate } from "./policy-engine.mjs";

const ALLOW_ALWAYS = new Set(["TodoWrite", "Skill", "WebSearch"]);
const MAX_SCAN_ENTRIES = 20000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function env(name) {
  return process.env[name] && process.env[name].trim() ? process.env[name].trim() : null;
}

function appendLog(file, record) {
  const dir = env("CLAW_GOV_LOG_DIR");
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, file), JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {
    /* logging must never turn a deny into an allow */
  }
}

function baseFiles() {
  const f = env("CLAW_GOV_BASE_FILES");
  if (!f) return null;
  try {
    return new Set(
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .map((s) => s.trim().normalize("NFC").toLowerCase())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- network checks
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v.startsWith("ff");
  }
  return true; // not an IP => treat as unsafe
}

export async function checkUrl(raw, { resolve = true } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { allow: false, reason: "URLとして解釈できません" };
  }
  if (!["http:", "https:"].includes(u.protocol)) return { allow: false, reason: `許可されていないスキーム ${u.protocol}` };
  if (u.username || u.password) return { allow: false, reason: "認証情報を含むURLは禁止です" };
  if (raw.length > 2000) return { allow: false, reason: "URLが長すぎます（情報の持ち出し防止）" };
  if (u.port && !["80", "443"].includes(u.port)) return { allow: false, reason: `ポート ${u.port} は禁止です` };
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") && !net.isIP(host)) return { allow: false, reason: "社内・ローカルの名前にはアクセスできません" };
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host) || host === "host.docker.internal" || host === "metadata.google.internal") {
    return { allow: false, reason: "ローカル・社内のサービスにはアクセスできません" };
  }
  if (net.isIP(host)) return isPrivateAddress(host) ? { allow: false, reason: "プライベートIPにはアクセスできません" } : { allow: true, host };
  if (resolve) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      if (addrs.some((a) => isPrivateAddress(a.address))) return { allow: false, reason: "名前解決の結果がプライベートIPです" };
    } catch {
      return { allow: false, reason: "名前解決できませんでした" };
    }
  }
  return { allow: true, host };
}

// ---------------------------------------------------------------- file checks
function scanForDeniedReads(manifest, root, startAbs, dept) {
  const stack = [startAbs];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_SCAN_ENTRIES) return { allow: false, reason: "検索範囲が広すぎます。workspace/ などに絞ってください" };
      const abs = path.join(dir, e.name);
      const r = resolveProjectPath(root, abs);
      if (!r.inside) return { allow: false, reason: `検索範囲にプロジェクト外を指すリンクがあります（${e.name}）` };
      const res = evaluate(manifest, { op: "read", rel: r.rel, dept });
      if (!res.allow) return { allow: false, reason: `検索範囲に閲覧禁止のファイルがあります（${r.rel}）。範囲を workspace/ や docs/ などに絞ってください` };
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(abs);
    }
  }
  return { allow: true };
}

/** Core decision. Exported for tests. */
export async function decide(input, ctx) {
  const { manifest, root, dept, base } = ctx;
  const tool = String(input.tool_name || "");
  const ti = input.tool_input || {};
  const cwd = input.cwd || root;
  if (ALLOW_ALWAYS.has(tool)) return { allow: true, reason: "allowed tool" };

  const fileOp = (p, op) => {
    if (typeof p !== "string") return { allow: false, reason: "パスが指定されていません" };
    let isNew = false;
    if (op === "modify" || op === "create") {
      const r = resolveProjectPath(root, p, cwd);
      if (r.inside && r.exists) op = "modify";
      if (r.inside) isNew = base ? !base.has(r.rel.normalize("NFC").toLowerCase()) : false;
    }
    return { ...checkPath(manifest, root, p, { op, dept, cwd, isNew }), op };
  };

  switch (tool) {
    case "Read":
      return fileOp(ti.file_path, "read");
    case "Write":
      return fileOp(ti.file_path, "create"); // becomes "modify" when the file exists
    case "Edit":
    case "MultiEdit":
      return fileOp(ti.file_path, "modify");
    case "NotebookEdit":
      return fileOp(ti.notebook_path, "modify");
    case "Glob":
    case "Grep":
    case "LS": {
      const p = ti.path || cwd;
      const pat = String(ti.pattern ?? "") + String(ti.glob ?? "");
      if (tool === "Glob" && (pat.includes("..") || pat.startsWith("/"))) return { allow: false, reason: "検索パターンにプロジェクト外への指定があります" };
      if (tool === "Grep" && String(ti.glob ?? "").includes("..")) return { allow: false, reason: "検索パターンにプロジェクト外への指定があります" };
      const r = resolveProjectPath(root, p, cwd);
      if (!r.inside) return { allow: false, reason: `プロジェクトの外は検索できません（${r.reason}）` };
      const self = evaluate(manifest, { op: "read", rel: r.rel, dept });
      if (!self.allow) return self;
      let st;
      try {
        st = fs.statSync(r.abs);
      } catch {
        return { allow: true, reason: "path does not exist" };
      }
      return st.isDirectory() ? scanForDeniedReads(manifest, root, r.abs, dept) : { allow: true, reason: "single file" };
    }
    case "WebFetch":
      return { ...(await checkUrl(String(ti.url ?? ""), { resolve: ctx.resolveDns !== false })), web: true };
    default:
      return { allow: false, reason: `ツール「${tool}」は使用が許可されていません` };
  }
}

async function main() {
  let input = {};
  let result;
  const root = env("CLAW_GOV_ROOT");
  const manifestPath = env("CLAW_GOV_MANIFEST");
  try {
    input = JSON.parse((await readStdin()) || "{}");
    if (!root || !manifestPath) throw new Error("governance environment is not configured");
    const manifest = loadManifest(manifestPath);
    result = await decide(input, { manifest, root, dept: env("CLAW_GOV_DEPT"), base: baseFiles() });
  } catch (err) {
    result = { allow: false, reason: `ガバナンス検査でエラーが発生したため拒否しました（${String(err && err.message ? err.message : err)}）` };
  }
  const meta = { ts: new Date().toISOString(), agent: env("CLAW_GOV_AGENT_ID"), task: env("CLAW_GOV_TASK_ID"), dept: env("CLAW_GOV_DEPT"), tool: input.tool_name ?? null };
  if (input.tool_name === "WebFetch" || input.tool_name === "WebSearch") {
    appendLog("web-access.jsonl", { ...meta, url: input.tool_input?.url ?? null, query: input.tool_input?.query ?? null, decision: result.allow ? "allow" : "deny", reason: result.allow ? null : result.reason });
  }
  if (!result.allow) {
    appendLog("violations.jsonl", { ...meta, source: "hook", op: result.op ?? null, path: result.rel ?? input.tool_input?.file_path ?? input.tool_input?.path ?? null, rule: result.ruleId ?? null, reason: result.reason });
  }
  if (result.allow) {
    // Allowed: emit NO decision, so Claude Code's own permission rules (permissions.deny in the
    // governance settings) still apply. Returning "allow" here would bypass them.
    process.exit(0);
  }
  // Denied: exit code 2 blocks the tool call; stderr is shown to the agent as the reason.
  process.stderr.write(`[ガバナンス] ${result.reason}\n`);
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
