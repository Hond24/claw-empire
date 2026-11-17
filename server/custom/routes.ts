/**
 * Solo-company customization: REST endpoints + a tiny CEO cost page.
 *
 *   GET  /api/custom/agent-costs?from=<ms>&to=<ms>   per-agent cost summary
 *   GET  /api/custom/agent-costs/events?limit=100     raw usage events
 *   GET  /api/custom/ceo-approvals?status=pending     approval requests
 *   POST /api/custom/ceo-approvals                    create request manually
 *   POST /api/custom/ceo-approvals/:id/executed       mark an approved request as executed
 *   GET  /ceo/costs                                   HTML cost dashboard
 */
import { ensureUsageLedgerSchema, summarizeAgentCosts } from "./usage-ledger.ts";
import {
  ensureApprovalSchema,
  listApprovalRequests,
  createApprovalRequest,
  decideApprovalRequest,
} from "./approval-requests.ts";
import { resolveAgentPermissionMode } from "./safe-mode.ts";
import { isPiiGuardEnabled } from "./pii-guard.ts";
import { hardenProcessGitEnvironment } from "./governance/git-safe.ts";
import { readJsonl } from "./governance/merge-gate.ts";
import { governanceLogDir, isGovernanceEnabled } from "./governance/trusted.ts";

type MinimalCtx = {
  app: any;
  db: any;
  broadcast?: (event: string, payload: unknown) => void;
};

export function ensureCustomSchemas(db: any): void {
  ensureUsageLedgerSchema(db);
  ensureApprovalSchema(db);
}

function toMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function registerCustomRoutes(ctx: MinimalCtx): void {
  const { app, db, broadcast } = ctx;
  ensureCustomSchemas(db);
  // [M1] every git call made by this server runs without hooks / fsmonitor / ext transports
  hardenProcessGitEnvironment();

  console.log(
    `[solo-company] permission mode=${resolveAgentPermissionMode()} governance=${isGovernanceEnabled() ? "on" : "off"} pii_guard=${isPiiGuardEnabled() ? "on" : "off"} yolo_allowed=${process.env.CLAW_ALLOW_YOLO === "1"}`,
  );

  app.get("/api/custom/governance/violations", (req: any, res: any) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query?.limit ?? 200) || 200));
    res.json({ ok: true, enabled: isGovernanceEnabled(), log_dir: governanceLogDir(), violations: readJsonl("violations.jsonl", limit) });
  });

  app.get("/api/custom/governance/web-access", (req: any, res: any) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query?.limit ?? 200) || 200));
    res.json({ ok: true, entries: readJsonl("web-access.jsonl", limit) });
  });

  app.get("/api/custom/agent-costs", (req: any, res: any) => {
    const rows = summarizeAgentCosts(db, { fromMs: toMs(req.query?.from), toMs: toMs(req.query?.to) });
    const total = rows.reduce((acc, r) => acc + Number(r.cost_usd || 0), 0);
    res.json({ ok: true, total_cost_usd: total, agents: rows });
  });

  app.get("/api/custom/agent-costs/events", (req: any, res: any) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query?.limit ?? 100) || 100));
    const rows = db.prepare("SELECT * FROM agent_usage_events ORDER BY created_at DESC LIMIT ?").all(limit);
    res.json({ ok: true, events: rows });
  });

  app.get("/api/custom/ceo-approvals", (req: any, res: any) => {
    const status = typeof req.query?.status === "string" ? req.query.status : undefined;
    res.json({ ok: true, requests: listApprovalRequests(db, status) });
  });

  app.post("/api/custom/ceo-approvals", (req: any, res: any) => {
    const body = req.body ?? {};
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (!summary) return res.status(400).json({ error: "summary_required" });
    const row = createApprovalRequest(
      db,
      { taskId: body.task_id ?? null, agentId: body.agent_id ?? null },
      { action_type: String(body.action_type ?? "other"), target: body.target, summary, payload: body.payload },
    );
    if (!row) return res.status(409).json({ error: "duplicate_request" });
    broadcast?.("ceo_approval_request", row);
    res.status(201).json({ ok: true, request: row });
  });

  app.post("/api/custom/ceo-approvals/:id/executed", (req: any, res: any) => {
    const result = decideApprovalRequest(db, String(req.params.id), "executed", req.body?.note ?? null);
    if (!result.ok) return res.status(result.error === "not_found" ? 404 : 409).json({ error: result.error });
    res.json({ ok: true, request: result.row });
  });

  app.get("/ceo/costs", (_req: any, res: any) => {
    res.type("html").send(COST_PAGE_HTML);
  });
}

const COST_PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AI社員コスト</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;margin:24px;color:#1f2937;background:#f9fafb}
h1{font-size:20px;margin:0 0 4px} .muted{color:#6b7280;font-size:13px}
table{border-collapse:collapse;width:100%;margin-top:16px;background:#fff}
th,td{border-bottom:1px solid #e5e7eb;padding:8px 10px;text-align:right;font-size:14px}
th:first-child,td:first-child{text-align:left} th{background:#f3f4f6;font-weight:600}
.total{font-size:28px;font-weight:700;margin-top:12px} select{font-size:14px;padding:4px}
</style></head><body>
<h1>AI社員ごとのAPI使用コスト</h1>
<div class="muted">CLIが報告した値（Claude）または CLAW_MODEL_PRICES_JSON による推定値。サブスク利用時はAPI換算額です。</div>
<div style="margin-top:12px">期間: <select id="range"><option value="1">今日</option><option value="7">7日</option><option value="30" selected>30日</option><option value="0">全期間</option></select></div>
<div class="total" id="total">-</div>
<table><thead><tr><th>AI社員</th><th>実行回数</th><th>入力tok</th><th>出力tok</th><th>キャッシュ読込</th><th>費用(USD)</th><th>単価未設定</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const fmt=n=>Number(n||0).toLocaleString('ja-JP');
let authed=false;
async function load(){
  if(!authed){await fetch('/api/auth/session',{credentials:'same-origin'});authed=true;}
  const days=Number(document.getElementById('range').value);
  const from=days>0?Date.now()-days*86400000:0;
  const r=await fetch('/api/custom/agent-costs?from='+from,{credentials:'same-origin'});
  const j=await r.json();
  document.getElementById('total').textContent='$'+Number(j.total_cost_usd||0).toFixed(4);
  const tb=document.getElementById('rows'); tb.innerHTML='';
  for(const a of j.agents){
    const tr=document.createElement('tr');
    const cells=[a.agent_name||a.agent_id||'(未割当)',fmt(a.runs),fmt(a.input_tokens),fmt(a.output_tokens),fmt(a.cache_read_tokens),'$'+Number(a.cost_usd||0).toFixed(4),fmt(a.unpriced_runs)];
    for(const c of cells){const td=document.createElement('td');td.textContent=c;tr.appendChild(td);}
    tb.appendChild(tr);
  }
}
document.getElementById('range').onchange=load; load(); setInterval(load,15000);
</script></body></html>`;
