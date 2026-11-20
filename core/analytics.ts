// Analytics: one event per finished review run (tokens, estimated cost, duration, findings by severity, gates,
// suggestions posted and applied) and per later suggestion outcome (posted by hand, dismissed into a learning). The
// Analytics report aggregates them for a period, scoped like Home: the active organization, and for a developer only the
// assigned repositories.
import { store } from "./store.ts";
import { repoLabel } from "./git.ts";
import { seesAll, visibleRepos } from "./access.ts";
import type { Viewer } from "./access.ts";
import type { Severity } from "./engines.ts";
import type { Usage } from "./models.ts";
import type { ReviewRecord } from "./review.ts";
import type { Cell, ReportSection, Tone } from "./views.ts";

export const SEVERITIES: readonly Severity[] = ["high", "medium", "low", "nit"];
export interface ReviewEvent {
  kind: "review";
  url: string;
  repo: string;
  at: string;
  durationMs: number;
  llm: string | null;
  s1: string | null;
  calls: number;
  input: number;
  output: number;
  // USD; null when a hosted engine ran whose price is unknown (tokens are still counted)
  cost: number | null;
  findings: Record<Severity, number>;
  gates: { id: string; label: string; pass: boolean }[];
  // inline suggestions this run posted, and earlier suggestions the author applied since the previous review
  posted: number;
  accepted: number;
}
// A suggestion outcome outside a review run: posted from the review page, or dismissed into a learning.
export interface OutcomeEvent { kind: "posted" | "dismissed"; url: string; repo: string; at: string; count: number }
export type AnalyticsEvent = ReviewEvent | OutcomeEvent;

// USD per million tokens, [input, output], for hosted models with a published price. Ids are matched without a vendor
// prefix (OpenRouter's "anthropic/claude-sonnet-5" reads as "claude-sonnet-5"). A model missing here is counted in tokens.
export const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-2": [8, 40],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "gpt-5": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-4.1": [2, 8],
};
export const priceOf = (model: string): [number, number] | null => PRICES[model.split("/").pop() || ""] || null;

// The engines a review ran with: the label is provider/model; `local` engines cost nothing.
export interface EngineInfo { provider: string; model: string; local: boolean }
export function estimateCost(llm: EngineInfo | null, s1: EngineInfo | null, u: Usage): number | null {
  const s1Cost = !s1 || s1.local ? 0 : null; // hosted System One endpoints report no usage
  let llmCost: number | null = 0;
  if (llm && !llm.local && u.calls > 0) {
    const price = priceOf(llm.model);
    llmCost = u.cost !== null ? u.cost : price && u.input + u.output > 0 ? (u.input * price[0] + u.output * price[1]) / 1e6 : null;
  }
  return llmCost === null || s1Cost === null ? null : llmCost + s1Cost;
}

const emptyFindings = (): Record<Severity, number> => ({ high: 0, medium: 0, low: 0, nit: 0 });
export function reviewEvent(r: ReviewRecord, repo: string, durationMs: number, u: Usage, cost: number | null, posted: number): ReviewEvent {
  const findings = emptyFindings();
  for (const f of r.review.findings || []) if (!f.dismissed && SEVERITIES.includes(f.severity)) findings[f.severity]++;
  return {
    kind: "review", url: r.pr.url, repo, at: r.at, durationMs: Math.max(0, Math.round(durationMs)),
    llm: r.engines.llm, s1: r.engines.s1, calls: u.calls, input: u.input, output: u.output, cost,
    findings, gates: (r.gates || []).map((g) => ({ id: g.id, label: g.label, pass: !!g.pass })),
    posted, accepted: r.acceptedFixes?.length || 0,
  };
}
// Recording never fails the review or the request that triggered it.
export const recordEvent = (e: AnalyticsEvent): Promise<void> => store.addEvent(e).catch((err: Error) => console.warn(`[analytics] ${err.message}`));
export const recordOutcome = (kind: OutcomeEvent["kind"], url: string, repo: string, count = 1) =>
  recordEvent({ kind, url, repo, at: new Date().toISOString(), count });

// <report>
export const PERIODS = [7, 30, 90] as const;
export const periodOf = (v: unknown): number => PERIODS.find((p) => String(p) === String(v)) ?? 30;
const DAY = 864e5;
const SEV_TONE: Record<Severity, Tone> = { high: "bad", medium: "warn", low: "info", nit: "muted" };
const SEV_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low", nit: "Nit" };
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString("en"));
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const secs = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayLabel = (t: number) => new Date(t).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });

export interface Totals { reviews: number; prs: number; findings: number; posted: number; accepted: number; dismissed: number; tokens: number; cost: number; unpriced: number; durationMs: number }
// Totals of a set of events (already scoped and in the period).
export function totals(events: AnalyticsEvent[]): Totals {
  const runs = events.filter((e): e is ReviewEvent => e.kind === "review");
  const outcomes = events.filter((e): e is OutcomeEvent => e.kind !== "review");
  return {
    reviews: runs.length,
    prs: new Set(runs.map((e) => e.url)).size,
    findings: sum(runs, (e) => sum(SEVERITIES, (s) => e.findings?.[s] || 0)),
    posted: sum(runs, (e) => e.posted || 0) + sum(outcomes.filter((e) => e.kind === "posted"), (e) => e.count || 0),
    accepted: sum(runs, (e) => e.accepted || 0),
    dismissed: sum(outcomes.filter((e) => e.kind === "dismissed"), (e) => e.count || 0),
    tokens: sum(runs, (e) => (e.input || 0) + (e.output || 0)),
    cost: sum(runs, (e) => e.cost || 0),
    unpriced: runs.filter((e) => e.cost === null).length,
    durationMs: runs.length ? Math.round(sum(runs, (e) => e.durationMs || 0) / runs.length) : 0,
  };
}

// The report: `org` is the active organization ("" for every one an owner or admin sees), `days` one of PERIODS, `g` the
// viewer from gate(). `now` is for tests.
export async function analyticsData(org = "", days = 30, g: Viewer = { role: "owner" }, now = Date.now()) {
  days = periodOf(days);
  const admin = seesAll(g);
  const rs = (await visibleRepos(g)).filter((r) => !org || r.startsWith(`${org}/`));
  const inScope = (repo: string) => (admin && !org ? true : rs.includes(repo));
  const since = new Date(now - days * DAY);
  since.setUTCHours(0, 0, 0, 0);
  const events = (await store.events(since.toISOString())).filter((e) => inScope(e.repo));
  const runs = events.filter((e): e is ReviewEvent => e.kind === "review");
  const t = totals(events);

  const repoNames = [...new Set([...rs, ...events.map((e) => e.repo)])].filter(inScope).sort();
  const repoRows: Cell[][] = repoNames.map((repo) => {
    const x = totals(events.filter((e) => e.repo === repo));
    return [
      { text: repoLabel(repo), path: `/repo/${repo}` },
      x.reviews, x.prs, x.findings, x.posted, x.accepted, x.dismissed,
      compact(x.tokens),
      x.unpriced ? { text: `${usd(x.cost)} + ${x.unpriced} unpriced`, tone: "muted" } : usd(x.cost),
      x.reviews ? secs(x.durationMs) : "",
    ];
  });

  const severityRows: Cell[][] = SEVERITIES.map((s) => {
    const n = sum(runs, (e) => e.findings?.[s] || 0);
    return [{ text: SEV_LABEL[s], tone: SEV_TONE[s] }, n, pct(n, t.findings)];
  });

  const gates = new Map<string, { label: string; checked: number; failed: number }>();
  for (const e of runs) for (const gt of e.gates || []) {
    const row = gates.get(gt.id) || { label: gt.label, checked: 0, failed: 0 };
    row.checked++;
    if (!gt.pass) row.failed++;
    gates.set(gt.id, row);
  }
  const gateRows: Cell[][] = [...gates.values()].sort((a, b) => b.failed - a.failed || a.label.localeCompare(b.label)).map((x) => [
    x.label, x.checked, x.failed ? { text: String(x.failed), tone: "bad" } : { text: "0", tone: "ok" }, pct(x.failed, x.checked),
  ]);

  // Volume: a bar per day for 7 and 30 days, per week for 90.
  const step = days > 30 ? 7 : 1;
  const start = since.getTime();
  const buckets = Array.from({ length: Math.ceil((days + 1) / step) }, (_, i) => ({ from: start + i * step * DAY, n: 0 }));
  for (const e of runs) {
    const i = Math.floor((Date.parse(e.at) - start) / (step * DAY));
    if (buckets[i]) buckets[i].n++;
  }
  const byDay = new Set(runs.map((e) => dayKey(Date.parse(e.at))));

  const sections: ReportSection[] = [
    { id: "totals", kind: "stats", items: [
      { label: "Reviews", value: t.reviews, unit: t.reviews === 1 ? "review" : "reviews", hint: `${t.prs} pull ${t.prs === 1 ? "request" : "requests"} · ${byDay.size} active ${byDay.size === 1 ? "day" : "days"}` },
      { label: "Findings", value: t.findings, unit: t.findings === 1 ? "finding" : "findings", hint: t.reviews ? `${(t.findings / t.reviews).toFixed(1)} per review` : "No reviews in this period" },
      { label: "Acceptance rate", value: pct(t.accepted, t.posted), hint: `${t.accepted} applied · ${t.posted} posted · ${t.dismissed} dismissed` },
      { label: "Tokens", value: compact(t.tokens), unit: "tokens", hint: t.reviews ? `${compact(Math.round(t.tokens / t.reviews))} per review` : "No reviews in this period" },
      { label: "Cost", value: usd(t.cost), unit: "estimated", hint: t.unpriced ? `${t.unpriced} ${t.unpriced === 1 ? "review" : "reviews"} with an unpriced hosted model` : "Local models count as $0" },
      { label: "Review time", value: t.reviews ? secs(t.durationMs) : "–", unit: t.reviews ? "average" : "", hint: t.reviews ? `${secs(Math.max(...runs.map((e) => e.durationMs || 0)))} longest` : "No reviews in this period" },
    ] },
    { id: "volume", kind: "bars", title: "Review volume", description: step === 7 ? "Reviews per week" : "Reviews per day", items: buckets.map((b) => ({ label: dayLabel(b.from), value: b.n })) },
    { id: "repos", kind: "table", title: "Repositories", columns: ["Repository", "Reviews", "PRs", "Findings", "Posted", "Applied", "Dismissed", "Tokens", "Cost", "Avg time"], rows: repoRows, empty: admin ? "No repository yet." : "No repository assigned to your account." },
    { id: "severity", kind: "table", title: "Findings by severity", columns: ["Severity", "Findings", "Share"], rows: severityRows },
    { id: "gates", kind: "table", title: "Gate failures", columns: ["Gate", "Checked", "Failed", "Failure rate"], rows: gateRows, empty: "No gates checked in this period." },
  ];
  return { period: { value: days, options: PERIODS.map((p) => ({ value: p, label: `Last ${p} days` })) }, sections };
}
// </report>
