// Merge checks: the review result published on the pull request's head commit as codeotter/checks, and reviewer overrides
// of failing custom pre-merge checks.
//
// GitHub with the App installed on the repository: one check run (Checks API; only an App may write one) named
// codeotter/checks, in_progress while the review runs, then completed with a conclusion, a summary of scores and gates
// and an annotation per finding with a file and line (at most 50 per request: the rest follow in further updates).
// A failed review completes it as failure with the model's error, never with made-up results. Anywhere else (no App on
// the repository, or another git server) the codeotter/checks commit status stands in, posted only when custom checks
// ran, as before. One commit never gets both: the target is decided per repository, App first.
//
// Conclusion: failure when a blocking custom check failed and was not overridden; neutral when the verdict is "changes
// requested" or another gate or check failed; success otherwise. Only failure stops a branch protection rule.
//
// Overrides: `/override <check name|all> <reason>` in a PR comment, when the repository's Check overrides setting is on
// (default off). Only a requested reviewer of the pull request (a user, or a member of a requested team where the git
// server can tell) may override, and never the pull request's author. An override names the head commit it was given
// on: a review of a later commit starts without it. Each one is stored in the review, audited, and republished.
import { APP_URL } from "./config.ts";
import { store } from "./store.ts";
import { appApi, appInstallationToken, forgeOf, ghAsApp, githubGet, isForgeRepo, parsePrUrl, prUrlFor } from "./git.ts";
import { reviewConfig } from "./context.ts";
import { audit, currentActor, orgOfRepo } from "./audit.ts";
import type { Finding, Gate } from "./engines.ts";
import type { ForgeComment } from "./forges.ts";
import type { ReviewRecord } from "./review.ts";

export const CHECKS_CONTEXT = "codeotter/checks";
export const SHA_RE = /^[0-9a-f]{7,40}$/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;
export type StatusState = "pending" | "success" | "failure" | "error";
export interface CheckOverride { check: string; label: string; by: string; reason: string; at: string; sha: string }
export type CheckConclusion = "success" | "neutral" | "failure";
export interface CheckAnnotation { path: string; start_line: number; end_line: number; annotation_level: "notice" | "warning" | "failure"; title: string; message: string }
export interface CheckOutput { title: string; summary: string; annotations?: CheckAnnotation[] }
export interface CheckRunBody { status?: "in_progress" | "completed"; conclusion?: CheckConclusion; started_at?: string; completed_at?: string; details_url?: string; output: CheckOutput }
// What a review needs to be published (a stored or freshly built ReviewRecord).
export type Publishable = Pick<ReviewRecord, "pr" | "gates" | "review" | "blast" | "model"> & Partial<Pick<ReviewRecord, "headSha" | "overrides">>;

const clip = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Text from a model, a settings page or a comment, made safe for a markdown table cell.
const cell = (s: unknown) => String(s ?? "").replace(/[|<>`\s]+/g, " ").trim();
const detailsUrl = (prUrl: string) => `${APP_URL}/review?pr=${encodeURIComponent(prUrl)}`;
const isOverridden = (g: Pick<Gate, "id">, overrides: CheckOverride[] = []) => overrides.some((o) => o.check === g.id);
const failing = (g: Gate, overrides?: CheckOverride[]) => !g.pass && !isOverridden(g, overrides);

// <checks-status>
// The codeotter/checks commit status: failure when a "block" check fails (and is not overridden), success otherwise
// (warn-only failures and overrides are named in the description). No custom check answered, no status.
export function checksStatus(gates: Gate[], overrides: CheckOverride[] = []): { state: "success" | "failure"; description: string } | null {
  const custom = gates.filter((g) => g.mode);
  if (!custom.length) return null;
  const names = (list: Gate[]) => list.map((g) => g.label).join(", ");
  const over = custom.filter((g) => !g.pass && isOverridden(g, overrides));
  const blocked = custom.filter((g) => failing(g, overrides) && g.mode === "block");
  const warned = custom.filter((g) => failing(g, overrides) && g.mode === "warn");
  const note = over.length ? `; overridden: ${names(over)}` : "";
  if (blocked.length) return { state: "failure", description: `Failed: ${names(blocked)}${warned.length ? `; warning: ${names(warned)}` : ""}${note}` };
  if (warned.length) return { state: "success", description: `${custom.length - warned.length - over.length}/${custom.length} passed; warning: ${names(warned)}${note}` };
  if (over.length) return { state: "success", description: `${custom.length - over.length}/${custom.length} passed${note}` };
  return { state: "success", description: `All ${custom.length} check${custom.length === 1 ? "" : "s"} passed` };
}
// </checks-status>

export async function postCommitStatus(repo: string, sha: string, context: string, state: StatusState, description: string, url: string): Promise<unknown> {
  if (!SHA_RE.test(sha || "")) return;
  const fields = { state, context, description: description.slice(0, 140), target_url: detailsUrl(url) };
  if (isForgeRepo(repo)) return forgeOf(repo).status(repo, sha, fields, parsePrUrl(url)?.number);
  return ghAsApp(repo, ["api", "--method", "POST", `repos/${repo}/statuses/${sha}`, ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
}

// <check-run-payloads>
export function checkConclusion(r: Pick<Publishable, "gates" | "review" | "overrides">): CheckConclusion {
  const gates = r.gates || [];
  if (gates.some((g) => g.mode === "block" && failing(g, r.overrides))) return "failure";
  if (r.review?.verdict === "request_changes" || gates.some((g) => failing(g, r.overrides))) return "neutral";
  return "success";
}
const LEVEL: Record<string, CheckAnnotation["annotation_level"]> = { high: "failure", medium: "warning", low: "notice", nit: "notice" };
const safePath = (p: unknown): p is string => typeof p === "string" && !!p && p.length <= 1000 && !/[\0\r\n]/.test(p) && !p.replace(/^\/+/, "").split("/").some((s) => !s || s === "." || s === "..");
// One annotation per open finding that names a file and a line; findings without a line stay in the summary count.
export function checkAnnotations(findings: Finding[] = []): CheckAnnotation[] {
  return findings.flatMap((f): CheckAnnotation[] => {
    const end = Math.round(Number(f.line));
    if (f.dismissed || !safePath(f.file) || !Number.isSafeInteger(end) || end <= 0) return [];
    const start = Math.round(Number(f.startLine));
    return [{
      path: f.file.replace(/^\/+/, ""),
      start_line: Number.isSafeInteger(start) && start > 0 && start <= end ? start : end,
      end_line: end,
      annotation_level: LEVEL[f.severity] || "notice",
      title: clip(String(f.title || "Finding").replace(/\s+/g, " "), 255),
      message: clip(f.detail || f.title || "", 4000),
    }];
  });
}
// The Checks API takes at most 50 annotations per request; later batches are appended by further updates.
export const ANNOTATIONS_PER_REQUEST = 50;
export function annotationBatches<T>(list: T[], size = ANNOTATIONS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
const SCORE_ROWS = [["quality", "Quality"], ["correctness_risk", "Correctness risk"], ["test_coverage", "Test coverage"], ["readability", "Readability"], ["pr_hygiene", "PR hygiene"]] as const;
const VERDICT_TEXT: Record<string, string> = { approve: "Approved", comment: "Commented", request_changes: "Changes requested" };
export function checkSummary(r: Publishable, annotated: number): CheckOutput {
  const conclusion = checkConclusion(r);
  const gates = r.gates || [];
  const blocked = gates.filter((g) => g.mode === "block" && failing(g, r.overrides));
  const overrides = (r.overrides || []).filter((o) => gates.some((g) => g.id === o.check && !g.pass));
  const verdict = VERDICT_TEXT[r.review?.verdict] || "Reviewed";
  const title = clip(conclusion === "failure" ? `Failed: ${blocked.map((g) => g.label).join(", ")}` : `${verdict}${overrides.length ? ` · ${overrides.length} overridden` : ""}`, 200);
  const findings = (r.review?.findings || []).filter((f) => !f.dismissed).length;
  const gateRow = (g: Gate) => {
    const o = (r.overrides || []).find((x) => x.check === g.id);
    const status = g.pass ? "Passed" : o ? `Overridden by ${cell(o.by)}` : g.mode === "block" ? "Failed" : "Warning";
    return `| ${cell(g.label)}${g.mode === "block" ? " (blocking)" : ""} | ${status} |`;
  };
  const summary = [
    `**${verdict}** · ${cell(r.model) || "CodeOtter"}`,
    "",
    "| Score | Value |",
    "| :--- | ---: |",
    ...SCORE_ROWS.map(([k, label]) => `| ${label} | ${Math.round(Number(r.review?.scores?.[k]) || 0)}/100 |`),
    `| Blast radius | ${Math.round(Number(r.blast?.score) || 0)}/100 |`,
    ...(gates.length ? ["", "| Gate | Status |", "| :--- | :--- |", ...gates.map(gateRow)] : []),
    ...(overrides.length ? ["", "**Overrides**", ...overrides.map((o) => `- ${cell(o.label)}: ${cell(o.by)}, ${cell(o.reason)}`)] : []),
    "",
    `${findings} finding${findings === 1 ? "" : "s"}${annotated ? `, ${annotated} annotated` : ""} · [Full review](${detailsUrl(r.pr.url)})`,
  ].join("\n");
  return { title, summary: clip(summary, 60000) };
}
// The requests that complete a check run: the first sets the conclusion with up to 50 annotations, each later one appends
// the next 50 (title and summary are required on every output).
export function completedRunBodies(r: Publishable, now = new Date().toISOString()): CheckRunBody[] {
  const annotations = checkAnnotations(r.review?.findings);
  const output = checkSummary(r, annotations.length);
  const batches = annotationBatches(annotations);
  return (batches.length ? batches : [[]]).map((batch, i) => ({
    ...(i ? {} : { status: "completed" as const, conclusion: checkConclusion(r), completed_at: now, details_url: detailsUrl(r.pr.url) }),
    output: { ...output, ...(batch.length ? { annotations: batch } : {}) },
  }));
}
export const inProgressRunBody = (prUrl: string, now = new Date().toISOString()): CheckRunBody =>
  ({ status: "in_progress", started_at: now, details_url: detailsUrl(prUrl), output: { title: "Review running", summary: `CodeOtter is reviewing this commit. [Open](${detailsUrl(prUrl)})` } });
export const failedRunBody = (prUrl: string, error: string, now = new Date().toISOString()): CheckRunBody =>
  ({ status: "completed", conclusion: "failure", completed_at: now, details_url: detailsUrl(prUrl), output: { title: "Review failed", summary: clip(`The review did not finish:\n\n${String(error || "unknown error").replace(/<!--[\s\S]*?(-->|$)/g, "")}`, 60000) } });
// </check-run-payloads>

// <check-run-publish>
// Where codeotter/checks goes for a repository: a check run when the App is installed on it, else the commit status.
export async function checkRunsAvailable(repo: string): Promise<boolean> {
  if (isForgeRepo(repo)) return false;
  return !!(await appInstallationToken(repo).catch((e: Error) => { console.warn(`[checks] ${repo}: ${e.message}`); return ""; }));
}
const runIds = new Map<string, number>(); // `${repo}@${sha}` -> check run id
const idOf = (x: unknown): number => { const id = x && typeof x === "object" && "id" in x ? Number(x.id) : 0; return Number.isSafeInteger(id) && id > 0 ? id : 0; };
async function findRun(repo: string, sha: string): Promise<number> {
  const key = `${repo}@${sha}`;
  const known = runIds.get(key);
  if (known) return known;
  const list = await appApi(repo, "GET", `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECKS_CONTEXT)}&filter=latest&per_page=1`);
  const runs = list && typeof list === "object" && "check_runs" in list && Array.isArray(list.check_runs) ? list.check_runs : [];
  const id = idOf(runs[0]);
  if (id) runIds.set(key, id);
  return id;
}
// Creates the run on the commit (or reuses the one already there) and applies each body in turn.
export async function publishCheckRun(repo: string, sha: string, bodies: CheckRunBody[], fresh = false): Promise<number> {
  if (!FULL_SHA.test(sha)) throw new Error(`No head commit to publish ${CHECKS_CONTEXT} on`);
  let id = fresh ? 0 : await findRun(repo, sha);
  for (const body of bodies) {
    if (id) await appApi(repo, "PATCH", `repos/${repo}/check-runs/${id}`, body);
    else {
      id = idOf(await appApi(repo, "POST", `repos/${repo}/check-runs`, { name: CHECKS_CONTEXT, head_sha: sha, ...body }));
      if (!id) throw new Error("GitHub created no check run");
      runIds.set(`${repo}@${sha}`, id);
      if (runIds.size > 2000) runIds.delete(runIds.keys().next().value!);
    }
  }
  return id;
}
const headOf = (r: Pick<Publishable, "pr" | "headSha">) => String(r.pr?.headRefOid || r.headSha || "");
// An App created before it asked for "checks: write" is refused (403) by the Checks API: that repository falls back to
// the commit status for ten minutes, so the run and the status never both land on one commit.
const NO_CHECKS_TTL = 10 * 60_000;
const noChecks = new Map<string, number>(); // repository -> retry the Checks API after (ms)
const statusOf = (e: unknown) => (e && typeof e === "object" && "status" in e ? Number(e.status) : 0);
async function viaRunOrStatus(repo: string, run: () => Promise<unknown>, status: () => Promise<unknown>): Promise<void> {
  if ((noChecks.get(repo) || 0) <= Date.now() && await checkRunsAvailable(repo)) {
    try {
      await run();
      return;
    } catch (e) {
      if (statusOf(e) !== 403) throw e;
      noChecks.set(repo, Date.now() + NO_CHECKS_TTL);
      console.warn(`[checks] ${repo}: the GitHub App may not write check runs (grant it "Checks: write"); posting the commit status`);
    }
  }
  await status();
}
// A review began. `checks`: custom checks this run asks (the status fallback is posted only for those).
export async function checksStarted(repo: string, sha: string, prUrl: string, checks: number): Promise<void> {
  await viaRunOrStatus(repo, () => publishCheckRun(repo, sha, [inProgressRunBody(prUrl)], true),
    async () => { if (checks) await postCommitStatus(repo, sha, CHECKS_CONTEXT, "pending", `Running ${checks} check(s)`, prUrl); });
}
// A review finished, or an override changed its result. `checksRan`: custom checks answered in this result.
export async function checksFinished(repo: string, r: Publishable, checksRan: boolean): Promise<void> {
  const sha = headOf(r);
  await viaRunOrStatus(repo, () => publishCheckRun(repo, sha, completedRunBodies(r)), async () => {
    const st = checksRan ? checksStatus(r.gates || [], r.overrides) : null;
    if (st) await postCommitStatus(repo, sha, CHECKS_CONTEXT, st.state, st.description, r.pr.url);
  });
}
// A review failed: the run completes as failure with the error; the status fallback reports "error" when checks were due.
export async function checksFailed(repo: string, sha: string, prUrl: string, error: string, checks: boolean): Promise<void> {
  await viaRunOrStatus(repo, () => publishCheckRun(repo, sha, [failedRunBody(prUrl, error)]),
    async () => { if (checks) await postCommitStatus(repo, sha, CHECKS_CONTEXT, "error", `Checks not run: ${error}`, prUrl); });
}
// </check-run-publish>

// <check-overrides>
export interface Commenter { id?: number | string; login?: string }
const LOGIN_RE = /^[\w][\w.@+-]*(\[bot\])?$/;
const SLUG_RE = /^[\w][\w.-]*$/;
// Comment text in the reason: one line, no HTML comments (they could forge CodeOtter's markers), no live @mentions.
export const overrideReason = (s: string) => String(s || "").replace(/<!--[\s\S]*?(-->|$)/g, " ").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/(^|[^\w`])@(?=[\w-])/g, "$1@​").replace(/\s+/g, " ").trim().slice(0, 500);
// `<check name|all> <reason>` against the checks that fail now. A name may be "quoted"; unquoted, the longest failing
// check name the argument starts with wins (names may hold spaces).
export function parseOverride(arg: string, open: Gate[]): { gates: Gate[]; reason: string } | { error: string } {
  const text = String(arg || "").replace(/\s+/g, " ").trim();
  const names = open.map((g) => g.label).join(", ");
  if (!text) return { error: `Usage: /override <check name|all> <reason>. Failing: ${names}` };
  let gates: Gate[] = [];
  let rest = "";
  const quoted = /^"([^"]{1,200})"(?:\s+(.*))?$/.exec(text);
  if (quoted) {
    gates = open.filter((g) => g.label.toLowerCase() === quoted[1].trim().toLowerCase());
    rest = quoted[2] || "";
    if (!gates.length) return { error: `No failing check named "${quoted[1].trim()}". Failing: ${names}` };
  } else if (/^all(\s|$)/i.test(text)) {
    gates = open;
    rest = text.slice(3);
  } else {
    const lower = text.toLowerCase();
    const hit = [...open].sort((a, b) => b.label.length - a.label.length).find((g) => lower === g.label.toLowerCase() || lower.startsWith(`${g.label.toLowerCase()} `));
    if (!hit) return { error: `No failing check named "${text.split(" ")[0]}". Failing: ${names}` };
    gates = [hit];
    rest = text.slice(hit.label.length);
  }
  const reason = overrideReason(rest);
  if (!reason) return { error: "Give a reason: /override <check name|all> <reason>" };
  return { gates, reason };
}
// "" when `who` may override checks on pull request `n` of `repo` (authored by `author`), else why not.
export async function overrideRefusal(repo: string, n: number, author: string, who: Commenter): Promise<string> {
  if (!(await reviewConfig(repo)).overrides) return "Check overrides are off for this repository";
  const login = String(who.login || "");
  if (!login || !LOGIN_RE.test(login)) return "Unknown commenter";
  if (author && login.toLowerCase() === author.toLowerCase()) return "The pull request's author cannot override its checks";
  const notReviewer = `${login} is not a requested reviewer of this pull request`;
  if (isForgeRepo(repo)) {
    const forge = forgeOf(repo);
    if (!forge.requestedReviewer) return "This git server has no reviewer list to check";
    const c: ForgeComment = { id: "", body: "", created_at: "", prNumber: n, user: { id: who.id ?? "", login } };
    return (await forge.requestedReviewer(repo, n, c)) ? "" : notReviewer;
  }
  const raw = await githubGet(repo, `repos/${repo}/pulls/${n}/requested_reviewers`);
  const o = raw && typeof raw === "object" ? (raw as { users?: unknown; teams?: unknown }) : {};
  const users = (Array.isArray(o.users) ? o.users : []).map((u: unknown) => String(u && typeof u === "object" && "login" in u ? u.login : "").toLowerCase());
  if (users.includes(login.toLowerCase())) return "";
  const org = repo.split("/")[0];
  for (const t of Array.isArray(o.teams) ? o.teams : []) {
    const slug = String(t && typeof t === "object" && "slug" in t ? t.slug : "");
    if (!SLUG_RE.test(slug)) continue;
    const m = await githubGet(repo, `orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(login)}`).catch(() => null); // 404: not a member
    if (m && typeof m === "object" && "state" in m && m.state === "active") return "";
  }
  return notReviewer;
}
// `/override` from a comment on pull request `n`: authorise, record on the stored review, audit, republish. Returns the
// reply; a refusal is audited and thrown (the command runner posts it).
export async function overrideChecks(repo: string, n: number, who: Commenter, arg: string): Promise<string> {
  const prUrl = prUrlFor(repo, n);
  const org = orgOfRepo(repo);
  const actor = currentActor({ id: `comment:${who.login || "unknown"}`, name: String(who.login || "unknown") });
  const record = (await store.get(prUrl)) as ReviewRecord | null;
  if (!record?.pr) throw new Error("No CodeOtter review of this pull request yet");
  const refusal = await overrideRefusal(repo, n, String(record.pr.author?.login || ""), who);
  if (refusal) {
    await audit(actor, "check.override.refused", prUrl, { reason: refusal }, org);
    throw new Error(refusal);
  }
  const open = (record.gates || []).filter((g) => g.mode && failing(g, record.overrides));
  if (!open.length) throw new Error("No failing pre-merge checks to override");
  const parsed = parseOverride(arg, open);
  if ("error" in parsed) throw new Error(parsed.error);
  const at = new Date().toISOString();
  const sha = headOf(record);
  const added = parsed.gates.map((g): CheckOverride => ({ check: g.id, label: g.label, by: String(who.login), reason: parsed.reason, at, sha }));
  record.overrides = [...(record.overrides || []), ...added];
  await store.put(record);
  await audit(actor, "check.override", prUrl, { checks: added.map((o) => o.label).join(", "), reason: parsed.reason, sha }, org);
  let note = "";
  await checksFinished(repo, record, true).catch((e: Error) => { note = ` Publishing ${CHECKS_CONTEXT} failed: ${e.message}`; });
  return `${added.map((o) => `**${cell(o.label)}**`).join(", ")} overridden by \`${cell(who.login)}\`: ${parsed.reason}.${note}`;
}
// Overrides a new result keeps: those given on the commit it reviewed.
export const keptOverrides = (prev: CheckOverride[] | undefined, sha: string): CheckOverride[] | undefined => {
  const kept = (prev || []).filter((o) => !!sha && o.sha === sha);
  return kept.length ? kept : undefined;
};
// </check-overrides>
