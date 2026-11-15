/**
 * Solo-company customization: personal-information guard for CEO directives.
 *
 * Policy: customer personal / health information must not be fed to AI employees
 * during the initial phase. Regexes catch obvious identifiers (email, phone,
 * My Number-like 12 digits, card numbers). Health information cannot be detected
 * reliably by regex; it is covered by the written policy (ai-office/AGENTS.md).
 *
 * Env: CLAW_PII_GUARD = on (default) | off
 */

export type PiiFinding = { type: "email" | "phone_jp" | "my_number" | "card_number"; sample: string };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// JP phone numbers: 0X0-XXXX-XXXX, 03-XXXX-XXXX, +81 ...
const PHONE_JP_RE = /(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}(?!\d)/g;
const DIGIT_RUN_RE = /(?<!\d)(?:\d[ -]?){12,19}(?!\d)/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function mask(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

export function detectPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  if (!text) return findings;
  for (const m of text.matchAll(EMAIL_RE)) findings.push({ type: "email", sample: mask(m[0]) });
  for (const m of text.matchAll(PHONE_JP_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 13) findings.push({ type: "phone_jp", sample: mask(m[0]) });
  }
  for (const m of text.matchAll(DIGIT_RUN_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length === 12) findings.push({ type: "my_number", sample: mask(digits) });
    else if (digits.length >= 13 && luhnValid(digits)) findings.push({ type: "card_number", sample: mask(digits) });
  }
  return findings;
}

export function isPiiGuardEnabled(raw: string | undefined = process.env.CLAW_PII_GUARD): boolean {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

/** Returns an error payload when the text must be rejected, otherwise null. */
export function checkDirectivePii(text: unknown): { error: string; findings: PiiFinding[]; message: string } | null {
  if (!isPiiGuardEnabled()) return null;
  if (typeof text !== "string") return null;
  const findings = detectPii(text);
  if (findings.length === 0) return null;
  return {
    error: "pii_detected",
    findings,
    message:
      "指示に個人情報らしき文字列（メール・電話番号・番号類）が含まれています。社内規程により、顧客の個人情報・健康情報はAI社員に渡せません。匿名化してから再送してください。",
  };
}

/** Paths where CEO-authored free text enters the agent workflow. */
export const PII_GUARDED_PATHS = new Set(["/api/directives", "/api/inbox", "/api/messages", "/api/announcements", "/api/tasks"]);

/** Express middleware: rejects POSTs with obvious personal identifiers (HTTP 422). */
export function createPiiGuardMiddleware() {
  return (req: any, res: any, next: () => void) => {
    if (req.method !== "POST" || !PII_GUARDED_PATHS.has(req.path)) return next();
    const body = req.body ?? {};
    const text = [body.content, body.text, body.title, body.description].filter((v) => typeof v === "string").join("\n");
    const blocked = checkDirectivePii(text);
    if (!blocked) return next();
    return res.status(422).json(blocked);
  };
}
