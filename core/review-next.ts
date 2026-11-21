// Review next: the open pull requests of the viewer's repositories in the active organization, ranked. The priority is
// plain arithmetic over what the engines already stored (fast triage, the last review) and the pull request's own
// timestamps, size and draft flag. Nothing here scores a pull request: one without a triage or review ranks by waiting
// time only and shows "unscored". Related pull requests (same linked issue or ticket, stacked branches, a shared branch
// prefix) form a group and sit together, ordered by the group's top priority.
import { openPrs, parsePrUrl, repoLabel } from "./git.ts";
import { store } from "./store.ts";
import { parseLinkedIssueRefs } from "./context.ts";
import { ticketRefs, trackerSettings } from "./trackers.ts";
import { visibleRepos } from "./access.ts";
import type { Viewer } from "./access.ts";
import type { PullRequest } from "./forges.ts";
import type { ReviewRecord } from "./review.ts";
import type { TriageResult } from "./store.ts";
import type { TrackerSettings } from "./trackers.ts";
import type { Cell, ReportSection, Tone } from "./views.ts";

// What the queue reads of an open pull request (openPrs() rows; GitHub's lack files and commits).
export type OpenPr = Pick<PullRequest, "url" | "number" | "title" | "updatedAt" | "additions" | "deletions" | "changedFiles" | "isDraft" | "baseRefName" | "headRefName" | "headRefOid" | "body"> & { createdAt?: string };
export interface QueueInputs { reviews: ReviewRecord[]; triage: Record<string, TriageResult>; sla: Record<string, number>; tickets?: TrackerSettings; now?: number }
export interface QueueItem {
  pr: OpenPr;
  repo: string;
  rank: number;
  priority: number;
  // the terms that add up to the priority, shown in the Priority cell's tooltip
  parts: [string, number][];
  scored: boolean;
  risk: number | null;
  blast: number | null;
  gates: { total: number; failed: number; blocked: number } | null;
  verdict: string;
  // scores from a commit other than the current head
  outdated: boolean;
  waitingHours: number;
  ageHours: number;
  overdue: boolean;
  group: { id: string; label: string; size: number } | null;
}

// The weights, in one place so the tooltip and the docs can say exactly how the order is made.
export const WEIGHTS = {
  risk: 0.4, // × correctness risk 0-100
  blast: 0.2, // × blast radius 0-100
  failedGate: 8, // per failed warn gate, at most maxGates counted
  blockedGate: 12, // per failed block gate
  maxGates: 3,
  verdict: { request_changes: 10, comment: 0, approve: -10 } as Record<string, number>,
  waitPerDay: 6, // since the last update, capped at maxWait
  maxWait: 30,
  overdue: 15,
  small: 5, // ≤ smallLines changed lines: a quick one
  smallLines: 50,
  large: -5, // > largeLines changed lines
  largeLines: 1000,
  draft: -40,
};

const HOUR = 36e5;
const orgOf = (repo: string) => repo.split("/")[0] || "";
const time = (s: string | undefined) => { const t = Date.parse(s || ""); return Number.isFinite(t) ? t : NaN; };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

// The branch a stack or a series shares: feat/auth-1 and feat/auth-2 → feat/auth; a/b/c → a/b. "" when there is none.
export function branchPrefix(branch: string): string {
  const b = String(branch || "");
  const series = /^(.+\/[^/]*[a-z])[-_.]\d{1,2}$/i.exec(b);
  if (series) return series[1];
  const parts = b.split("/");
  return parts.length >= 3 ? parts.slice(0, -1).join("/") : "";
}

// Every key that ties a pull request to others: linked issues and tickets, its own head and base branch (stacks) and
// its branch prefix. Kinds rank the group label: an issue names the group before a stack, a stack before a prefix.
type Key = { kind: 0 | 1 | 2; id: string; label: string };
function keysOf(pr: OpenPr, repo: string, review: ReviewRecord | undefined, tickets: TrackerSettings): { links: Key[]; head: string; base: string } {
  const links: Key[] = [];
  for (const r of parseLinkedIssueRefs(repo, pr)) links.push({ kind: 0, id: `issue:${r.repo}#${r.number}`, label: r.repo === repo ? `#${r.number}` : `${repoLabel(r.repo)}#${r.number}` });
  for (const i of review?.linkedIssues || []) {
    if (i.key) links.push({ kind: 0, id: `ticket:${i.key}`, label: i.key });
    else if (i.repo && i.number) links.push({ kind: 0, id: `issue:${i.repo}#${i.number}`, label: i.repo === repo ? `#${i.number}` : `${repoLabel(i.repo)}#${i.number}` });
  }
  for (const t of ticketRefs(pr, tickets)) links.push({ kind: 0, id: `ticket:${t.key}`, label: t.key });
  const prefix = branchPrefix(pr.headRefName);
  if (prefix) links.push({ kind: 2, id: `prefix:${repo}:${prefix}`, label: `${prefix}/*` });
  return { links, head: pr.headRefName ? `${repo}:${pr.headRefName}` : "", base: pr.baseRefName ? `${repo}:${pr.baseRefName}` : "" };
}

// The latest finished review per pull request URL.
function latestReviews(reviews: ReviewRecord[]): Map<string, ReviewRecord> {
  const m = new Map<string, ReviewRecord>();
  for (const r of reviews) {
    if (r.pending || !r.pr?.url) continue;
    const prev = m.get(r.pr.url);
    if (!prev || time(r.at) > time(prev.at)) m.set(r.pr.url, r);
  }
  return m;
}

export function rankQueue(open: OpenPr[], { reviews, triage, sla, tickets = {}, now = Date.now() }: QueueInputs): QueueItem[] {
  const byUrl = latestReviews(reviews);
  const items = open.map((pr): QueueItem & { keys: ReturnType<typeof keysOf> } => {
    const repo = parsePrUrl(pr.url)?.repo || "";
    const rv = byUrl.get(pr.url);
    const tr = triage[pr.url];
    const t = tr && !tr.error && num(tr.risk) !== null ? tr : undefined;
    // the newer of the triage and the review supplies risk and blast radius; gates and verdict only come from a review
    const fromTriage = !!t && (!rv || time(t.at) >= time(rv.at));
    const risk = fromTriage ? num(t?.risk) : num(rv?.review?.scores?.correctness_risk);
    const blast = fromTriage ? num(t?.blast) : num(rv?.blast?.score);
    const scored = risk !== null || blast !== null;
    const gs = rv?.gates || [];
    const gates = rv ? { total: gs.length, failed: gs.filter((g) => !g.pass).length, blocked: gs.filter((g) => !g.pass && g.mode === "block").length } : null;
    const verdict = rv?.review?.verdict || "";
    const sha = fromTriage ? t?.headSha : rv?.headSha;
    const outdated = scored && !!sha && !!pr.headRefOid && sha !== pr.headRefOid;
    const updated = time(pr.updatedAt);
    const opened = time(pr.createdAt) || updated;
    const waitingHours = Number.isFinite(updated) ? Math.max(0, (now - updated) / HOUR) : 0;
    const ageHours = Number.isFinite(opened) ? Math.max(0, (now - opened) / HOUR) : waitingHours;
    const slaHours = Number(sla[orgOf(repo)] ?? sla[""] ?? 0) || 0;
    const overdue = !pr.isDraft && slaHours > 0 && ageHours >= slaHours;
    const lines = (Number(pr.additions) || 0) + (Number(pr.deletions) || 0);
    const parts: [string, number][] = [];
    if (risk !== null) parts.push([`risk ${risk} × ${WEIGHTS.risk}`, round1(risk * WEIGHTS.risk)]);
    if (blast !== null) parts.push([`blast ${blast} × ${WEIGHTS.blast}`, round1(blast * WEIGHTS.blast)]);
    if (gates?.failed) {
      const warn = Math.min(WEIGHTS.maxGates, gates.failed - gates.blocked);
      const block = Math.min(WEIGHTS.maxGates, gates.blocked);
      if (block) parts.push([`${block} blocking gate${block === 1 ? "" : "s"} failed`, block * WEIGHTS.blockedGate]);
      if (warn > 0) parts.push([`${warn} gate${warn === 1 ? "" : "s"} failed`, warn * WEIGHTS.failedGate]);
    }
    if (verdict && WEIGHTS.verdict[verdict]) parts.push([verdict.replace("_", " "), WEIGHTS.verdict[verdict]]);
    parts.push([`waiting ${duration(waitingHours)}`, round1(Math.min(WEIGHTS.maxWait, (waitingHours / 24) * WEIGHTS.waitPerDay))]);
    if (overdue) parts.push([`over the ${slaHours}h SLA`, WEIGHTS.overdue]);
    if (lines <= WEIGHTS.smallLines) parts.push([`${lines} lines`, WEIGHTS.small]);
    else if (lines > WEIGHTS.largeLines) parts.push([`${lines} lines`, WEIGHTS.large]);
    if (pr.isDraft) parts.push(["draft", WEIGHTS.draft]);
    const priority = Math.round(parts.reduce((n, [, v]) => n + v, 0));
    return { pr, repo, rank: 0, priority, parts, scored, risk, blast, gates, verdict, outdated, waitingHours, ageHours, overdue, group: null, keys: keysOf(pr, repo, rv, tickets) };
  });

  // Union-find over shared keys, plus stacks: a pull request whose base is another open one's head.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
  const seen = new Map<string, number>();
  items.forEach((it, i) => {
    for (const k of it.keys.links) { const j = seen.get(k.id); if (j === undefined) seen.set(k.id, i); else union(i, j); }
  });
  const heads = new Map(items.map((it, i) => [it.keys.head, i] as const).filter(([h]) => h));
  const stacked = new Set<number>();
  items.forEach((it, i) => { const j = heads.get(it.keys.base); if (j !== undefined && j !== i) { union(i, j); stacked.add(i).add(j); } });

  const members = new Map<number, number[]>();
  items.forEach((_, i) => { const r = find(i); members.set(r, [...(members.get(r) || []), i]); });
  for (const [root, ids] of members) {
    if (ids.length < 2) continue;
    // the label: the most specific key at least two members share (issue/ticket, then stack, then prefix)
    const count = new Map<string, { key: Key; n: number }>();
    for (const i of ids) for (const k of items[i].keys.links) { const c = count.get(k.id); if (c) c.n++; else count.set(k.id, { key: k, n: 1 }); }
    const shared = [...count.values()].filter((c) => c.n >= 2).sort((a, b) => a.key.kind - b.key.kind || b.n - a.n);
    const stack = ids.filter((i) => stacked.has(i));
    const best = shared[0] && (shared[0].key.kind === 0 || !stack.length) ? shared[0].key.label : stack.length ? `stack on ${items[stack.sort((a, b) => a - b)[0]].pr.headRefName}` : shared[0]?.key.label || "related";
    for (const i of ids) items[i].group = { id: `g${root}`, label: best, size: ids.length };
  }

  // Order: groups by their best priority, members together by priority; then most waiting first, then newest number.
  const cmp = (a: QueueItem, b: QueueItem) => b.priority - a.priority || b.waitingHours - a.waitingHours || a.pr.number - b.pr.number;
  const top = new Map<number, QueueItem>();
  items.forEach((it, i) => { const r = find(i); const t = top.get(r); if (!t || cmp(it, t) < 0) top.set(r, it); });
  const order = items.map((it, i) => ({ it, head: top.get(find(i)) as QueueItem, root: find(i) }))
    .sort((a, b) => cmp(a.head, b.head) || a.root - b.root || cmp(a.it, b.it));
  return order.map(({ it }, n) => {
    const { keys: _keys, ...item } = it;
    return { ...item, rank: n + 1 };
  });
}

// 3h, 2d 4h; under an hour reads "<1h".
export function duration(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.floor(hours)}h`;
  const d = Math.floor(hours / 24), h = Math.floor(hours % 24);
  return h ? `${d}d ${h}h` : `${d}d`;
}
const scoreTone = (n: number): Tone => (n >= 70 ? "bad" : n >= 40 ? "warn" : "ok");

export function queueSection(items: QueueItem[]): ReportSection {
  const rows = items.map((it): Cell[] => {
    const note = it.outdated ? " (scored on an older commit)" : "";
    const size = `+${Number(it.pr.additions) || 0} −${Number(it.pr.deletions) || 0} · ${Number(it.pr.changedFiles) || 0} file${it.pr.changedFiles === 1 ? "" : "s"}`;
    return [
      it.rank,
      { text: `#${it.pr.number} ${it.pr.title}${it.pr.isDraft ? " · draft" : ""}`, path: `/review?pr=${encodeURIComponent(it.pr.url)}` },
      repoLabel(it.repo),
      { text: String(it.priority), mono: true, info: `${it.parts.map(([l, v]) => `${l}: ${v > 0 ? "+" : ""}${v}`).join(" · ")}${note}` },
      it.risk !== null ? { text: `${it.risk}${it.outdated ? "*" : ""}`, tone: scoreTone(it.risk) } : { text: "unscored", tone: "muted" },
      it.blast !== null ? { text: `${it.blast}${it.outdated ? "*" : ""}`, tone: scoreTone(it.blast) } : "",
      !it.gates || !it.gates.total ? "" : it.gates.failed ? { text: `${it.gates.failed}/${it.gates.total} failed`, tone: it.gates.blocked ? "bad" : "warn" } : { text: `${it.gates.total} passed`, tone: "ok" },
      it.overdue ? { text: `overdue · ${duration(it.ageHours)}`, tone: "bad" } : duration(it.waitingHours),
      size,
      it.group ? { text: it.group.label, tone: "info", info: `${it.group.size} related pull requests` } : "",
    ];
  });
  return { id: "next", kind: "table", title: "Review next", columns: ["#", "Pull request", "Repository", "Priority", "Risk", "Blast radius", "Gates", "Waiting", "Size", "Group"], rows, empty: "Nothing waiting for review." };
}

// The stored inputs: reviews (unless the caller already read them), fast-triage results, the SLA and the issue-tracker
// projects. No network.
export async function queueInputs(loaded?: ReviewRecord[]): Promise<QueueInputs> {
  const [reviews, triage, sla, tickets] = await Promise.all([loaded || store.all(), store.getSetting("triageResults"), store.getSetting("reviewSla"), trackerSettings()]);
  return { reviews, triage: triage || {}, sla: sla || {}, tickets };
}

// The endpoint: the viewer's repositories in `org`, their open pull requests (the same openPrs() Home reads), ranked.
export async function reviewNext(org: string, g: Viewer): Promise<{ sections: ReportSection[]; items: QueueItem[] }> {
  const rs = (await visibleRepos(g)).filter((r) => !org || r.startsWith(`${org}/`));
  const open = (await Promise.all(rs.map((r) => openPrs(r)))).flat();
  const items = rankQueue(open, await queueInputs());
  return { sections: [queueSection(items)], items };
}
