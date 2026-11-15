/**
 * Solo-company customization: per-agent API usage / cost ledger.
 *
 * Claw-Empire upstream only caches provider rate-limit windows (cli_usage_cache).
 * This module records token usage and cost for every CLI run, per agent, so the
 * CEO can see what each AI employee costs.
 *
 * Sources:
 *  - Claude Code  (--output-format=stream-json): {"type":"result", total_cost_usd, usage{...}}
 *  - Codex exec   (--json):                       {"type":"turn.completed", usage{...}}
 *  - Gemini CLI   (stream-json):                  {"type":"result", stats{...}}
 *
 * When a provider reports no cost (Codex/Gemini), cost is estimated only if the CEO
 * configured prices in CLAW_MODEL_PRICES_JSON (USD per 1M tokens). No prices are
 * hard-coded, so estimates never silently go stale.
 *
 * NOTE: on subscription plans (e.g. Claude Max), Claude's total_cost_usd is an
 * API-equivalent figure, not an actual charge.
 */
import { randomUUID } from "node:crypto";

type Db = { exec: (sql: string) => void; prepare: (sql: string) => any };

export type UsageEvent = {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costSource: "reported" | "estimated" | "unknown";
};

export type UsageContext = {
  taskId?: string | null;
  agentId?: string | null;
  source: "task_run" | "one_shot" | "manual";
  runId?: string | null;
};

export function ensureUsageLedgerSchema(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_usage_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  task_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cost_source TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_usage_events_agent ON agent_usage_events(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_usage_events_task ON agent_usage_events(task_id);
`);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type PriceTable = Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;

export function loadPriceTable(raw: string | undefined = process.env.CLAW_MODEL_PRICES_JSON): PriceTable {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as PriceTable;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn("[usage-ledger] CLAW_MODEL_PRICES_JSON is not valid JSON; cost estimation disabled");
    return {};
  }
}

export function estimateCostUsd(evt: UsageEvent, prices: PriceTable = loadPriceTable()): number | null {
  if (!evt.model) return null;
  // exact match first, then longest prefix match (e.g. "gpt-5" matches "gpt-5-codex")
  let price = prices[evt.model];
  if (!price) {
    const key = Object.keys(prices)
      .filter((k) => evt.model!.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    price = key ? prices[key] : undefined;
  }
  if (!price) return null;
  const perTok = (usdPerMillion: number | undefined) => (usdPerMillion ?? 0) / 1_000_000;
  return (
    evt.inputTokens * perTok(price.input) +
    evt.outputTokens * perTok(price.output) +
    evt.cacheReadTokens * perTok(price.cacheRead ?? price.input) +
    evt.cacheWriteTokens * perTok(price.cacheWrite ?? price.input)
  );
}

/** Parse a single JSON stream line. Returns a usage event when the line is a terminal usage report. */
export function parseUsageLine(provider: string, line: string, modelHint: string | null = null): UsageEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let j: any;
  try {
    j = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;

  // Claude Code final result
  if (j.type === "result" && (j.usage || j.total_cost_usd !== undefined)) {
    const u = j.usage ?? {};
    let model = modelHint;
    if (j.modelUsage && typeof j.modelUsage === "object") {
      const keys = Object.keys(j.modelUsage);
      if (keys.length > 0) model = keys.join("+");
    }
    const reported = typeof j.total_cost_usd === "number" ? j.total_cost_usd : null;
    return {
      provider,
      model,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      costUsd: reported,
      costSource: reported !== null ? "reported" : "unknown",
    };
  }

  // Codex exec --json
  if (j.type === "turn.completed" && j.usage) {
    const u = j.usage;
    const cached = num(u.cached_input_tokens);
    return {
      provider,
      model: modelHint,
      inputTokens: Math.max(0, num(u.input_tokens) - cached),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      costUsd: null,
      costSource: "unknown",
    };
  }

  // Gemini CLI stream-json result
  if (j.type === "result" && j.stats) {
    const s = j.stats;
    return {
      provider,
      model: modelHint ?? (typeof j.model === "string" ? j.model : null),
      inputTokens: num(s.input_tokens ?? s.prompt_tokens),
      outputTokens: num(s.output_tokens ?? s.candidates_tokens),
      cacheReadTokens: num(s.cached_tokens ?? s.cached),
      cacheWriteTokens: 0,
      costUsd: null,
      costSource: "unknown",
    };
  }
  return null;
}

/** Extract model name from Claude's init line, if present. */
export function parseModelHint(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"model"')) return null;
  try {
    const j = JSON.parse(trimmed);
    if (j?.type === "system" && typeof j.model === "string") return j.model;
    if (j?.type === "thread.started" && typeof j.model === "string") return j.model;
  } catch {
    /* ignore */
  }
  return null;
}

export function recordUsageEvent(db: Db, ctx: UsageContext, evt: UsageEvent): string {
  let costUsd = evt.costUsd;
  let costSource = evt.costSource;
  if (costUsd === null) {
    const est = estimateCostUsd(evt);
    if (est !== null) {
      costUsd = est;
      costSource = "estimated";
    }
  }
  let agentId = ctx.agentId ?? null;
  if (!agentId && ctx.taskId) {
    try {
      const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(ctx.taskId) as
        | { assigned_agent_id?: string | null }
        | undefined;
      agentId = row?.assigned_agent_id ?? null;
    } catch {
      /* tasks table may not exist in isolated tests */
    }
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agent_usage_events
      (id, agent_id, task_id, run_id, source, provider, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, cost_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agentId,
    ctx.taskId ?? null,
    ctx.runId ?? null,
    ctx.source,
    evt.provider,
    evt.model,
    evt.inputTokens,
    evt.outputTokens,
    evt.cacheReadTokens,
    evt.cacheWriteTokens,
    costUsd,
    costSource,
    Date.now(),
  );
  return id;
}

/**
 * Line-buffered accumulator for streamed CLI output. Feed raw chunks; complete lines
 * are parsed. Usage events are recorded immediately (a run normally emits exactly one).
 */
export function createUsageAccumulator(db: Db, provider: string, ctx: UsageContext) {
  let buffer = "";
  let modelHint: string | null = null;
  let recorded = 0;
  const handleLine = (line: string) => {
    const hint = parseModelHint(line);
    if (hint) modelHint = hint;
    const evt = parseUsageLine(provider, line, modelHint);
    if (!evt) return;
    try {
      recordUsageEvent(db, ctx, evt);
      recorded += 1;
    } catch (err) {
      console.warn(`[usage-ledger] failed to record usage: ${String(err)}`);
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
      // guard against unbounded growth from non-line output
      if (buffer.length > 4_000_000) buffer = buffer.slice(-1_000_000);
    },
    flush() {
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
    },
    get recordedCount() {
      return recorded;
    },
  };
}

/** Record usage from a complete output blob (used by one-shot runs). */
export function recordUsageFromOutput(db: Db, provider: string, ctx: UsageContext, output: string): number {
  const acc = createUsageAccumulator(db, provider, ctx);
  acc.push(output);
  acc.flush();
  return acc.recordedCount;
}

export type AgentCostSummaryRow = {
  agent_id: string | null;
  agent_name: string | null;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  unpriced_runs: number;
};

export function summarizeAgentCosts(db: Db, opts: { fromMs?: number; toMs?: number } = {}): AgentCostSummaryRow[] {
  const from = opts.fromMs ?? 0;
  const to = opts.toMs ?? Number.MAX_SAFE_INTEGER;
  let hasAgents = true;
  try {
    db.prepare("SELECT 1 FROM agents LIMIT 1").get();
  } catch {
    hasAgents = false;
  }
  const nameExpr = hasAgents ? "COALESCE(NULLIF(a.name_ja, ''), a.name)" : "NULL";
  const join = hasAgents ? "LEFT JOIN agents a ON a.id = e.agent_id" : "";
  return db
    .prepare(
      `SELECT e.agent_id AS agent_id, ${nameExpr} AS agent_name,
              COUNT(*) AS runs,
              SUM(e.input_tokens) AS input_tokens,
              SUM(e.output_tokens) AS output_tokens,
              SUM(e.cache_read_tokens) AS cache_read_tokens,
              SUM(e.cache_write_tokens) AS cache_write_tokens,
              COALESCE(SUM(e.cost_usd), 0) AS cost_usd,
              SUM(CASE WHEN e.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_runs
         FROM agent_usage_events e ${join}
        WHERE e.created_at >= ? AND e.created_at <= ?
        GROUP BY e.agent_id
        ORDER BY cost_usd DESC`,
    )
    .all(from, to) as AgentCostSummaryRow[];
}
