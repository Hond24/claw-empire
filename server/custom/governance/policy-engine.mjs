// [solo-company] Governance policy engine (M1).
//
// Single source of truth for "may this AI employee do OP on PATH?", shared by:
//   - the Claude Code PreToolUse hook (hook-pretooluse.mjs, plain `node`)
//   - the server-side merge gate (merge-gate.ts)
//
// Design rules (docs/FILE_PROTECTION.md in ai-office):
//   * allow-list, first matching rule wins, anything unmatched is DENIED
//   * paths are normalized (NFC, case-insensitive like APFS, no "..", symlinks resolved)
//   * anything outside the project root is denied
//   * an invalid / missing manifest fails CLOSED (everything denied)
//
// Plain ESM JavaScript on purpose: runs under `node` without a build step.

import fs from "node:fs";
import path from "node:path";

export const OPS = /** @type {const} */ (["read", "create", "modify", "delete"]);

/** @typedef {{id:string, level:string|number, patterns:string[], read:boolean, create:boolean, modify:boolean|"if_new", delete:boolean, note?:string, doc_row?:number}} Rule */
/** @typedef {{version:number, departments:Record<string,string>, rules:Rule[]}} Manifest */

const FAIL_CLOSED = Object.freeze({ version: 0, departments: {}, rules: [], invalid: true });

/** Validate a parsed manifest. Returns list of problems (empty = valid). */
export function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  if (m.version !== 1) errs.push("version must be 1");
  if (!m.departments || typeof m.departments !== "object") errs.push("departments missing");
  else
    for (const [k, v] of Object.entries(m.departments))
      if (typeof v !== "string" || !/^[a-z0-9_-]+$/.test(v)) errs.push(`department folder for ${k} invalid`);
  if (!Array.isArray(m.rules) || m.rules.length === 0) errs.push("rules missing");
  else {
    const ids = new Set();
    for (const r of m.rules) {
      if (!r || typeof r.id !== "string") {
        errs.push("rule without id");
        continue;
      }
      if (ids.has(r.id)) errs.push(`duplicate rule id ${r.id}`);
      ids.add(r.id);
      if (!Array.isArray(r.patterns) || r.patterns.length === 0) errs.push(`rule ${r.id}: patterns missing`);
      else for (const p of r.patterns) if (typeof p !== "string" || p.startsWith("/") || p.includes("..")) errs.push(`rule ${r.id}: bad pattern ${p}`);
      for (const op of OPS) {
        const v = r[op];
        const ok = typeof v === "boolean" || (op === "modify" && v === "if_new");
        if (!ok) errs.push(`rule ${r.id}: ${op} must be boolean${op === "modify" ? ' or "if_new"' : ""}`);
      }
    }
  }
  return errs;
}

/** Load a manifest file; on any problem return a fail-closed manifest (denies everything). */
export function loadManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const errs = validateManifest(parsed);
    if (errs.length) return { ...FAIL_CLOSED, errors: errs };
    return parsed;
  } catch (err) {
    return { ...FAIL_CLOSED, errors: [String(err && err.message ? err.message : err)] };
  }
}

export function parseManifest(text) {
  try {
    const parsed = JSON.parse(text);
    const errs = validateManifest(parsed);
    return errs.length ? { ...FAIL_CLOSED, errors: errs } : parsed;
  } catch (err) {
    return { ...FAIL_CLOSED, errors: [String(err)] };
  }
}

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile a glob (with {self}) to a RegExp over lower-cased, NFC, "/"-separated relative paths. */
export function globToRegExp(glob, selfFolder) {
  // {self} without a department folder must never match
  const g = glob.normalize("NFC").toLowerCase();
  let re = "";
  for (let i = 0; i < g.length; ) {
    if (g.startsWith("{self}", i)) {
      re += selfFolder ? escapeRe(selfFolder.toLowerCase()) : "(?!)";
      i += 6;
    } else if (g.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (g.startsWith("/**", i) && i + 3 === g.length) {
      re += "(?:/.*)?";
      i += 3;
    } else if (g.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (g[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (g[i] === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRe(g[i]);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Normalize a relative path for matching (forward slashes, NFC, lower-case). */
export function normalizeRel(rel) {
  return rel.split(path.sep).join("/").normalize("NFC").toLowerCase();
}

/**
 * Resolve a user/tool supplied path against the project root.
 * Returns { inside, rel, abs, isSymlink, hardlinked, exists, reason }.
 * Symlinks are resolved via realpath of the nearest existing ancestor, so a link
 * that points outside the root (or at a protected file) is judged by its target.
 */
export function resolveProjectPath(root, input, cwd = root) {
  if (typeof input !== "string" || input.length === 0) return { inside: false, reason: "empty path" };
  if (input.includes("\0")) return { inside: false, reason: "NUL byte in path" };
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { inside: false, reason: "project root missing" };
  }
  const abs = path.resolve(cwd || root, input);
  // walk up to the nearest existing ancestor and realpath it
  let existing = abs;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try {
    real = path.join(fs.realpathSync(existing), ...tail);
  } catch {
    return { inside: false, reason: "unresolvable path" };
  }
  let isSymlink = false;
  let hardlinked = false;
  let exists = false;
  try {
    const st = fs.lstatSync(abs);
    exists = true;
    isSymlink = st.isSymbolicLink();
    hardlinked = st.isFile() && st.nlink > 1;
    if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) return { inside: false, reason: "special file" };
  } catch {
    /* does not exist yet */
  }
  const rel = path.relative(realRoot, real);
  if (rel === "" ) return { inside: true, rel: ".", abs: real, isSymlink, hardlinked, exists };
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { inside: false, reason: "outside project root", abs: real };
  return { inside: true, rel: rel.split(path.sep).join("/"), abs: real, isSymlink, hardlinked, exists };
}

/**
 * Decide an operation on a project-relative path.
 * @param {Manifest} manifest
 * @param {{op:"read"|"create"|"modify"|"delete", rel:string, dept?:string|null, isNew?:boolean}} q
 * @returns {{allow:boolean, ruleId:string|null, level:string|number|null, reason:string}}
 */
export function evaluate(manifest, q) {
  if (!manifest || manifest.invalid) {
    return { allow: false, ruleId: null, level: null, reason: "保護設定が読み込めないため、すべて拒否しています（fail-closed）" };
  }
  if (!OPS.includes(q.op)) return { allow: false, ruleId: null, level: null, reason: `unknown operation ${q.op}` };
  const rel = normalizeRel(q.rel);
  if (rel === "" || rel.startsWith("../") || rel === "..") {
    return { allow: false, ruleId: null, level: null, reason: "プロジェクトの外は操作できません" };
  }
  const selfFolder = q.dept ? manifest.departments?.[q.dept] ?? null : null;
  for (const rule of manifest.rules) {
    const hit = rule.patterns.some((p) => globToRegExp(p, selfFolder).test(rel));
    if (!hit) continue;
    let allowed = rule[q.op];
    if (allowed === "if_new") allowed = q.isNew === true;
    return {
      allow: allowed === true,
      ruleId: rule.id,
      level: rule.level,
      reason: allowed === true
        ? `allowed by ${rule.id}`
        : `「${rel}」への${opLabel(q.op)}は禁止されています（規則 ${rule.id}・LEVEL ${rule.level}）。${rule.note ?? ""}`.trim(),
    };
  }
  return { allow: false, ruleId: null, level: null, reason: `「${rel}」はどの許可規則にも当てはまらないため拒否しました` };
}

function opLabel(op) {
  return { read: "閲覧", create: "新規作成", modify: "編集・上書き", delete: "削除" }[op] ?? op;
}

/** Full check for a concrete path (resolve + evaluate), used by the hook. */
export function checkPath(manifest, root, input, { op, dept, cwd, isNew } = {}) {
  const r = resolveProjectPath(root, input, cwd);
  if (!r.inside) return { allow: false, ruleId: null, level: null, reason: `プロジェクトの外、または不正なパスです（${r.reason}）`, rel: null };
  if (r.hardlinked) return { allow: false, ruleId: null, level: null, reason: "ハードリンクされたファイルは操作できません", rel: r.rel };
  if (r.isSymlink && op !== "read") return { allow: false, ruleId: null, level: null, reason: "シンボリックリンクへの書き込みはできません", rel: r.rel };
  const res = evaluate(manifest, { op, rel: r.rel, dept, isNew });
  return { ...res, rel: r.rel };
}
