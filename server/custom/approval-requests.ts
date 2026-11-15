/**
 * Solo-company customization: CEO approval for important external operations.
 *
 * AI employees run in safe mode (no shell / no external side effects). When work
 * needs an external action (SNS post, email, publish, payment, git push ...), the
 * agent emits a marker in its output:
 *
 *   [[CEO_APPROVAL_REQUEST]]{"action_type":"sns_post","target":"Instagram","summary":"...","payload":{}}[[/CEO_APPROVAL_REQUEST]]
 *
 * The request is stored here and shown in the existing Decision Inbox as
 * kind "ceo_approval_request" (options: approve / reject). Approval only records
 * the decision; execution stays a deliberate human (or future, separately
 * reviewed automation) step. YOLO autopilot never auto-answers these items.
 */
import { createHash, randomUUID } from "node:crypto";

type Db = { exec: (sql: string) => void; prepare: (sql: string) => any };

export const APPROVAL_DECISION_KIND = "ceo_approval_request" as const;
export const APPROVAL_DECISION_PREFIX = "ceo-approval:";

export const ACTION_TYPES = ["sns_post", "email", "publish", "payment", "git_push", "external_api", "other"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type ApprovalRequestInput = {
  action_type: string;
  target?: string;
  summary: string;
  payload?: unknown;
};

export type ApprovalRequestRow = {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  action_type: ActionType;
  target: string | null;
  summary: string;
  payload_json: string | null;
  status: "pending" | "approved" | "rejected" | "executed";
  dedupe_key: string;
  decision_note: string | null;
  decided_at: number | null;
  created_at: number;
};

export function ensureApprovalSchema(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS ceo_approval_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent_id TEXT,
  action_type TEXT NOT NULL,
  target TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','executed')),
  dedupe_key TEXT NOT NULL UNIQUE,
  decision_note TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ceo_approval_requests_status ON ceo_approval_requests(status, created_at);
`);
}

const MARKER_RE = /\[\[CEO_APPROVAL_REQUEST\]\]([\s\S]*?)\[\[\/CEO_APPROVAL_REQUEST\]\]/g;

function normalizeActionType(raw: unknown): ActionType {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (ACTION_TYPES as readonly string[]).includes(v) ? (v as ActionType) : "other";
}

/** Find approval markers in plain text. Invalid JSON blocks are ignored. */
export function extractApprovalRequests(text: string): ApprovalRequestInput[] {
  const out: ApprovalRequestInput[] = [];
  if (!text || !text.includes("[[CEO_APPROVAL_REQUEST]]")) return out;
  for (const match of text.matchAll(MARKER_RE)) {
    const body = (match[1] ?? "").trim();
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const summary = String(parsed.summary ?? "").trim();
      if (!summary) continue;
      out.push({
        action_type: normalizeActionType(parsed.action_type),
        target: parsed.target ? String(parsed.target).slice(0, 300) : undefined,
        summary: summary.slice(0, 2000),
        payload: parsed.payload ?? null,
      });
    } catch {
      // ignore malformed request (agent will be visible in logs)
    }
  }
  return out;
}

/** Collect every string value inside a parsed JSON stream line (assistant text, result text ...). */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (value.includes("[[CEO_APPROVAL_REQUEST]]")) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
}

/** Extract markers from one CLI output line (JSON stream line or plain text). */
export function extractApprovalRequestsFromLine(line: string): ApprovalRequestInput[] {
  if (!line.includes("CEO_APPROVAL_REQUEST")) return [];
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const strings: string[] = [];
      collectStrings(parsed, strings);
      return strings.flatMap((s) => extractApprovalRequests(s));
    } catch {
      /* fall through to plain text */
    }
  }
  return extractApprovalRequests(line);
}

function dedupeKey(taskId: string | null, req: ApprovalRequestInput): string {
  return createHash("sha256")
    .update(JSON.stringify([taskId ?? "", req.action_type, req.target ?? "", req.summary]))
    .digest("hex")
    .slice(0, 32);
}

/** Insert a request. Returns null if an identical request already exists (streams repeat text). */
export function createApprovalRequest(
  db: Db,
  ctx: { taskId?: string | null; agentId?: string | null },
  req: ApprovalRequestInput,
): ApprovalRequestRow | null {
  const taskId = ctx.taskId ?? null;
  let agentId = ctx.agentId ?? null;
  if (!agentId && taskId) {
    try {
      const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | { assigned_agent_id?: string | null }
        | undefined;
      agentId = row?.assigned_agent_id ?? null;
    } catch {
      /* ignore */
    }
  }
  const key = dedupeKey(taskId, req);
  const existing = db.prepare("SELECT id FROM ceo_approval_requests WHERE dedupe_key = ?").get(key);
  if (existing) return null;
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO ceo_approval_requests
      (id, task_id, agent_id, action_type, target, summary, payload_json, status, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    taskId,
    agentId,
    normalizeActionType(req.action_type),
    req.target ?? null,
    req.summary,
    req.payload === undefined || req.payload === null ? null : JSON.stringify(req.payload),
    key,
    now,
  );
  return db.prepare("SELECT * FROM ceo_approval_requests WHERE id = ?").get(id) as ApprovalRequestRow;
}

export function listApprovalRequests(db: Db, status?: string): ApprovalRequestRow[] {
  if (status) {
    return db
      .prepare("SELECT * FROM ceo_approval_requests WHERE status = ? ORDER BY created_at DESC LIMIT 500")
      .all(status) as ApprovalRequestRow[];
  }
  return db
    .prepare("SELECT * FROM ceo_approval_requests ORDER BY created_at DESC LIMIT 500")
    .all() as ApprovalRequestRow[];
}

export function decideApprovalRequest(
  db: Db,
  id: string,
  decision: "approved" | "rejected" | "executed",
  note: string | null = null,
): { ok: boolean; error?: string; row?: ApprovalRequestRow } {
  const row = db.prepare("SELECT * FROM ceo_approval_requests WHERE id = ?").get(id) as ApprovalRequestRow | undefined;
  if (!row) return { ok: false, error: "not_found" };
  if (decision === "executed") {
    if (row.status !== "approved") return { ok: false, error: "not_approved" };
  } else if (row.status !== "pending") {
    return { ok: false, error: "already_decided" };
  }
  db.prepare("UPDATE ceo_approval_requests SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?").run(
    decision,
    note,
    Date.now(),
    id,
  );
  return { ok: true, row: db.prepare("SELECT * FROM ceo_approval_requests WHERE id = ?").get(id) as ApprovalRequestRow };
}

const ACTION_LABEL_JA: Record<ActionType, string> = {
  sns_post: "SNS投稿",
  email: "メール送信",
  publish: "公開・販売開始",
  payment: "支払い",
  git_push: "コード公開(git push)",
  external_api: "外部API操作",
  other: "外部操作",
};

/** Build Decision Inbox items (shape matches DecisionInboxRouteItem). */
export function buildApprovalDecisionItems(db: Db) {
  const rows = listApprovalRequests(db, "pending");
  return rows.map((row) => {
    let agent: any = null;
    let task: any = null;
    let project: any = null;
    try {
      if (row.agent_id) agent = db.prepare("SELECT id, name, name_ko, name_ja, avatar_emoji FROM agents WHERE id = ?").get(row.agent_id);
      if (row.task_id) task = db.prepare("SELECT id, title, project_id FROM tasks WHERE id = ?").get(row.task_id);
      if (task?.project_id) project = db.prepare("SELECT id, name, project_path FROM projects WHERE id = ?").get(task.project_id);
    } catch {
      /* best effort enrichment */
    }
    const label = ACTION_LABEL_JA[row.action_type] ?? "外部操作";
    const summary = [
      `【CEO承認申請】${label}${row.target ? `（${row.target}）` : ""}`,
      row.summary,
      row.payload_json ? `\n詳細: ${row.payload_json.slice(0, 800)}` : "",
      "\n※承認は記録のみです。実行はCEOが手動で行い、完了後 /api/custom/ceo-approvals/:id/executed で記録します。",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      id: `${APPROVAL_DECISION_PREFIX}${row.id}`,
      kind: APPROVAL_DECISION_KIND,
      created_at: row.created_at,
      summary,
      agent_id: agent?.id ?? null,
      agent_name: agent?.name_ja || agent?.name || null,
      agent_name_ko: agent?.name_ko || null,
      agent_avatar: agent?.avatar_emoji ?? "🛡️",
      project_id: project?.id ?? null,
      project_name: project?.name ?? null,
      project_path: project?.project_path ?? null,
      task_id: row.task_id,
      task_title: task?.title ?? null,
      options: [
        { number: 1, action: "approve_external_action", label: "承認する" },
        { number: 2, action: "reject_external_action", label: "却下する" },
      ],
    };
  });
}

/** Handle Decision Inbox reply for approval items. Returns null if the item is not ours. */
export function handleApprovalDecisionReply(
  db: Db,
  decisionId: string,
  optionNumber: number,
  body: Record<string, unknown>,
  hooks: { appendTaskLog?: (taskId: string | null, kind: string, message: string) => void } = {},
): { status: number; payload: Record<string, unknown> } | null {
  if (!decisionId.startsWith(APPROVAL_DECISION_PREFIX)) return null;
  const id = decisionId.slice(APPROVAL_DECISION_PREFIX.length);
  const decision = optionNumber === 1 ? "approved" : optionNumber === 2 ? "rejected" : null;
  if (!decision) return { status: 400, payload: { error: "option_not_found", option_number: optionNumber } };
  const note = typeof body.note === "string" ? body.note.slice(0, 2000) : null;
  const result = decideApprovalRequest(db, id, decision, note);
  if (!result.ok) return { status: result.error === "not_found" ? 404 : 409, payload: { error: result.error } };
  hooks.appendTaskLog?.(
    result.row?.task_id ?? null,
    "system",
    `CEO approval ${decision}: [${result.row?.action_type}] ${result.row?.summary?.slice(0, 200)}`,
  );
  return { status: 200, payload: { ok: true, resolved: true, action: `${decision}_external_action`, request: result.row } };
}

/** Stream helper: scan CLI output and persist any approval requests. */
export function createApprovalStreamScanner(
  db: Db,
  ctx: { taskId?: string | null },
  onCreated?: (row: ApprovalRequestRow) => void,
) {
  let buffer = "";
  const handle = (line: string) => {
    for (const req of extractApprovalRequestsFromLine(line)) {
      try {
        const row = createApprovalRequest(db, ctx, req);
        if (row) onCreated?.(row);
      } catch (err) {
        console.warn(`[ceo-approval] failed to store request: ${String(err)}`);
      }
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        handle(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
      if (buffer.length > 4_000_000) buffer = buffer.slice(-1_000_000);
    },
    flush() {
      if (buffer.trim()) handle(buffer);
      buffer = "";
    },
  };
}
