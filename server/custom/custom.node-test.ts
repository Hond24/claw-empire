/**
 * Solo-company customization tests. Uses node:test so it runs without node_modules:
 *   npx tsx --test server/custom/custom.node-test.ts     (or: pnpm test:custom)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  applyPermissionMode,
  resolveAgentPermissionMode,
  SAFE_MODE_PROMPT_NOTE,
} from "./safe-mode.ts";
import {
  ensureUsageLedgerSchema,
  parseUsageLine,
  createUsageAccumulator,
  recordUsageFromOutput,
  summarizeAgentCosts,
  estimateCostUsd,
} from "./usage-ledger.ts";
import {
  ensureApprovalSchema,
  extractApprovalRequests,
  extractApprovalRequestsFromLine,
  createApprovalStreamScanner,
  buildApprovalDecisionItems,
  handleApprovalDecisionReply,
  listApprovalRequests,
  decideApprovalRequest,
} from "./approval-requests.ts";
import { detectPii, checkDirectivePii, createPiiGuardMiddleware } from "./pii-guard.ts";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, name_ko TEXT, name_ja TEXT, avatar_emoji TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, project_path TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assigned_agent_id TEXT, project_id TEXT);
    INSERT INTO agents VALUES ('a-res','Researcher','','リサーチャー','🔎');
    INSERT INTO agents VALUES ('a-coo','COO','','COO','🧭');
    INSERT INTO projects VALUES ('p1','セルフケア講座','/tmp/ai-office');
    INSERT INTO tasks VALUES ('t1','市場調査','a-res','p1');
  `);
  ensureUsageLedgerSchema(db as any);
  ensureApprovalSchema(db as any);
  return db;
}

// ---------------------------------------------------------------- safe mode
const UPSTREAM_CLAUDE = [
  "claude",
  "--dangerously-skip-permissions",
  "--print",
  "--verbose",
  "--output-format=stream-json",
  "--include-partial-messages",
  "--max-turns",
  "200",
];

test("safe mode is the default", () => {
  assert.equal(resolveAgentPermissionMode(undefined), "safe");
  assert.equal(resolveAgentPermissionMode("legacy"), "legacy");
});

test("claude: removes --dangerously-skip-permissions and denies Bash", () => {
  const args = applyPermissionMode("claude", UPSTREAM_CLAUDE, "safe");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "acceptEdits",
  ]);
  const allowed = args.find((a) => a.startsWith("--allowedTools="))!;
  assert.ok(allowed.includes("WebSearch") && !allowed.includes("Bash"));
  assert.ok(args.includes("--disallowedTools=Bash,NotebookEdit,KillShell"));
  assert.equal(args.find((a) => a.startsWith("--tools=")), allowed.replace("--allowedTools=", "--tools="));
});

test("usage parser handles a real Claude Code stream (captured from CLI 2.1.x)", () => {
  // Captured locally with the exact safe-mode flags (run failed at auth, but stream format is real).
  const db = makeDb();
  const fixture = [
    '{"type":"system","subtype":"init","cwd":"/tmp","tools":["Edit","Glob","Grep","Read","Skill","WebFetch","WebSearch","Write"],"model":"claude-sonnet-5-5","permissionMode":"acceptEdits"}',
    '{"type":"result","subtype":"success","is_error":true,"total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"modelUsage":{},"result":"Authentication error"}',
  ].join("\n");
  assert.equal(recordUsageFromOutput(db as any, "claude", { taskId: "t1", source: "task_run" }, fixture), 1);
  const row = db.prepare("SELECT * FROM agent_usage_events").get() as any;
  assert.equal(row.model, "claude-sonnet-5-5");
  assert.equal(row.cost_usd, 0);
  assert.equal(row.cost_source, "reported");
});

test("claude: CLAW_SAFE_ALLOWED_TOOLS cannot re-enable Bash", () => {
  process.env.CLAW_SAFE_ALLOWED_TOOLS = "Read,Bash,Bash(curl:*),WebFetch";
  try {
    const args = applyPermissionMode("claude", UPSTREAM_CLAUDE, "safe");
    assert.ok(args.includes("--allowedTools=Read,WebFetch"));
  } finally {
    delete process.env.CLAW_SAFE_ALLOWED_TOOLS;
  }
});

test("claude: no-tools meeting runs stay tool-less", () => {
  const args = applyPermissionMode("claude", [...UPSTREAM_CLAUDE, "--tools="], "safe");
  assert.ok(args.includes("--tools="));
  assert.ok(!args.some((a) => a.startsWith("--allowedTools")));
});

test("codex / gemini: --yolo is replaced", () => {
  const codex = applyPermissionMode("codex", ["codex", "--enable", "multi_agent", "--yolo", "exec", "--json"], "safe");
  assert.deepEqual(codex, ["codex", "--enable", "multi_agent", "--sandbox", "workspace-write", "exec", "--json"]);
  const gemini = applyPermissionMode("gemini", ["gemini", "--yolo", "--output-format=stream-json"], "safe");
  assert.deepEqual(gemini, ["gemini", "--approval-mode", "auto_edit", "--output-format=stream-json"]);
});

test("legacy mode leaves upstream args untouched", () => {
  assert.deepEqual(applyPermissionMode("claude", UPSTREAM_CLAUDE, "legacy"), UPSTREAM_CLAUDE);
});

test("prompt note example never parses as a real approval request", () => {
  assert.equal(extractApprovalRequests(SAFE_MODE_PROMPT_NOTE).length, 0);
});

// ---------------------------------------------------------------- usage ledger
const CLAUDE_INIT = JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-5" });
const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  total_cost_usd: 0.0421,
  usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 },
});

test("parses Claude result line", () => {
  const evt = parseUsageLine("claude", CLAUDE_RESULT, "claude-sonnet-4-5")!;
  assert.equal(evt.costUsd, 0.0421);
  assert.equal(evt.inputTokens, 1200);
  assert.equal(evt.cacheReadTokens, 5000);
  assert.equal(evt.costSource, "reported");
});

test("parses Codex turn.completed and ignores unrelated lines", () => {
  const evt = parseUsageLine(
    "codex",
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
  )!;
  assert.equal(evt.inputTokens, 600);
  assert.equal(evt.cacheReadTokens, 400);
  assert.equal(parseUsageLine("claude", '{"type":"assistant","message":{}}'), null);
  assert.equal(parseUsageLine("claude", "plain text"), null);
});

test("estimates cost only when prices are configured", () => {
  const evt = { provider: "codex", model: "gpt-5-codex", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costSource: "unknown" as const };
  assert.equal(estimateCostUsd(evt, {}), null);
  assert.equal(estimateCostUsd(evt, { "gpt-5": { input: 2, output: 8 } }), 2);
});

test("accumulator handles JSON lines split across chunks and attributes to task agent", () => {
  const db = makeDb();
  const acc = createUsageAccumulator(db as any, "claude", { taskId: "t1", source: "task_run" });
  const blob = `${CLAUDE_INIT}\n${CLAUDE_RESULT}\n`;
  acc.push(blob.slice(0, 50));
  acc.push(blob.slice(50, 120));
  acc.push(blob.slice(120));
  acc.flush();
  assert.equal(acc.recordedCount, 1);
  const row = db.prepare("SELECT * FROM agent_usage_events").get() as any;
  assert.equal(row.agent_id, "a-res");
  assert.equal(row.model, "claude-sonnet-4-5");
  assert.equal(row.cost_usd, 0.0421);
});

test("summary aggregates cost per agent", () => {
  const db = makeDb();
  recordUsageFromOutput(db as any, "claude", { taskId: "t1", source: "task_run" }, CLAUDE_RESULT);
  recordUsageFromOutput(db as any, "claude", { agentId: "a-coo", source: "one_shot" }, CLAUDE_RESULT);
  recordUsageFromOutput(db as any, "claude", { agentId: "a-coo", source: "one_shot" }, CLAUDE_RESULT);
  const rows = summarizeAgentCosts(db as any);
  const coo = rows.find((r) => r.agent_id === "a-coo")!;
  assert.equal(coo.runs, 2);
  assert.equal(coo.agent_name, "COO");
  assert.ok(Math.abs(coo.cost_usd - 0.0842) < 1e-9);
});

// ---------------------------------------------------------------- CEO approvals
const REQ = '[[CEO_APPROVAL_REQUEST]]{"action_type":"sns_post","target":"Instagram","summary":"講座告知を投稿したい","payload":{"text":"..."}}[[/CEO_APPROVAL_REQUEST]]';

test("extracts approval markers from plain text and stream-json lines", () => {
  assert.equal(extractApprovalRequests(`前文\n${REQ}\n後文`)[0].action_type, "sns_post");
  const streamLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `了解です。\n${REQ}` }] } });
  assert.equal(extractApprovalRequestsFromLine(streamLine).length, 1);
  assert.equal(extractApprovalRequests("[[CEO_APPROVAL_REQUEST]]{broken[[/CEO_APPROVAL_REQUEST]]").length, 0);
});

test("scanner stores one pending request even if the stream repeats it", () => {
  const db = makeDb();
  const created: string[] = [];
  const scanner = createApprovalStreamScanner(db as any, { taskId: "t1" }, (row) => created.push(row.id));
  const assistant = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: REQ }] } });
  const result = JSON.stringify({ type: "result", result: `完了\n${REQ}` });
  scanner.push(`${assistant}\n${result}\n`);
  scanner.flush();
  assert.equal(created.length, 1);
  const [row] = listApprovalRequests(db as any, "pending");
  assert.equal(row.agent_id, "a-res");
});

test("approval appears in Decision Inbox and CEO can approve; execution needs approval first", () => {
  const db = makeDb();
  const scanner = createApprovalStreamScanner(db as any, { taskId: "t1" });
  scanner.push(`${REQ}\n`);
  const items = buildApprovalDecisionItems(db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "ceo_approval_request");
  assert.equal(items[0].project_name, "セルフケア講座");
  assert.equal(items[0].agent_name, "リサーチャー");
  assert.deepEqual(items[0].options.map((o) => o.action), ["approve_external_action", "reject_external_action"]);

  const requestId = items[0].id.split(":")[1];
  assert.equal(decideApprovalRequest(db as any, requestId, "executed").error, "not_approved");

  const logs: string[] = [];
  const res = handleApprovalDecisionReply(db as any, items[0].id, 1, {}, { appendTaskLog: (_t, _k, m) => logs.push(m) })!;
  assert.equal(res.status, 200);
  assert.equal(res.payload.resolved, true);
  assert.equal(buildApprovalDecisionItems(db as any).length, 0);
  assert.ok(logs[0].startsWith("CEO approval approved"));
  // second reply is a conflict
  assert.equal(handleApprovalDecisionReply(db as any, items[0].id, 2, {})!.status, 409);
  assert.equal(decideApprovalRequest(db as any, requestId, "executed").ok, true);
  // unrelated decision ids are not handled
  assert.equal(handleApprovalDecisionReply(db as any, "project-review:p1", 1, {}), null);
});

// ---------------------------------------------------------------- PII guard
test("PII guard detects identifiers but not ordinary business text", () => {
  assert.equal(detectPii("デスクワーカー向けセルフケア講座を企画して。目標は月200万円、2026-11-15まで").length, 0);
  assert.equal(detectPii("顧客 hanako@example.com に連絡")[0].type, "email");
  assert.equal(detectPii("電話 090-1234-5678")[0].type, "phone_jp");
  assert.equal(detectPii("番号 1234 5678 9012")[0].type, "my_number");
  assert.equal(detectPii("card 4242424242424242")[0].type, "card_number");
  assert.equal(checkDirectivePii("ok text"), null);
});

test("PII middleware returns 422 on guarded POST paths only", () => {
  const mw = createPiiGuardMiddleware();
  const run = (req: any) => {
    let status = 0;
    let nextCalled = false;
    const res = { status(c: number) { status = c; return this; }, json() { return this; } };
    mw(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
  };
  assert.equal(run({ method: "POST", path: "/api/directives", body: { content: "連絡先 taro@example.com" } }).status, 422);
  assert.equal(run({ method: "POST", path: "/api/directives", body: { content: "講座を企画して" } }).nextCalled, true);
  assert.equal(run({ method: "POST", path: "/api/settings", body: { content: "taro@example.com" } }).nextCalled, true);
});
