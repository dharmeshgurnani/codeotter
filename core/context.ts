// Review context: settings, guides, learnings, accepted suggestions, history, linked issues, head files.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OWNER_RE, REPO, REPO_RE, ROOT } from "./config.ts";
import { store } from "./store.ts";
import { forgeId, forgeOf, ghAsync, isForgeRepo } from "./git.ts";
import { capMap } from "./pr-tools.ts";
import { linkedTickets } from "./trackers.ts";
import { repoOf } from "./views.ts";
import type { ChangedFile } from "./diff.ts";
import type { PrCommit as ForgePrCommit, PullRequest as ForgePullRequest } from "./forges.ts";
import type { GuideSetting, RepoSetting } from "./store.ts";
import type { Severity } from "./engines.ts";
import { CONFIG_FILE, normalizeRules, parseRepoConfig, RULE_DEFAULTS } from "./repo-rules.ts";
import type { RepoRules } from "./repo-rules.ts";

// A pull request in gh's JSON shape (`gh pr view --json`); the forge adapters normalise theirs to the same fields.
export type PrCommit = Partial<Omit<ForgePrCommit, "authors">> & { authors?: { login?: string; name?: string }[] };
// The reviewed pull request: the forge's PullRequest (forges.ts) as far as a review needs it, plus the head it reviewed.
// gh's JSON may omit the optional fields, and its commits can be partial.
export type PullRequest = Pick<ForgePullRequest, "url" | "number" | "title" | "author" | "baseRefName" | "headRefName" | "changedFiles" | "additions" | "deletions">
  & Partial<Pick<ForgePullRequest, "body" | "headRefOid" | "headRepo" | "state" | "isDraft" | "updatedAt" | "labels">>
  & { files: ChangedFile[]; commits?: PrCommit[]; headSha?: string; isCrossRepository?: boolean };
// Path filters, path instructions and skip rules (repo-rules.ts) are review settings too.
export interface ReviewSettings extends RepoRules {
  maxFindings: number;
  diffChars: number;
  contextLines: number;
  reflectMin: number;
  temperature: number;
  postScores: boolean;
  postReview: boolean;
  postInlineSuggestions: boolean;
  resolveFixed: boolean; // resolve our inline comments a later push fixed (only while inline suggestions are posted)
  commands: boolean;
  auto: boolean;
  profile: ReviewProfile;
  minSeverity: Severity;
  checks: CustomCheck[];
  agentPrompts: boolean; // a collapsed "Prompt for AI agents" block in posted review and inline comments
  // static analyzers run on the changed files (core/analyzers.ts)
  gitleaks: boolean;
  semgrep: boolean;
  trivy: boolean;
  rulesSource: RulesSource; // where AGENTS.md / CLAUDE.md / .codeotter.json are read from (see "Rules source" below)
}
// A custom pre-merge check: a yes/no question (yes = pass) asked of the model owning the gates. "block" failures fail the
// codeotter/checks commit status; "warn" failures only show; "off" is kept but not asked.
export type CheckMode = "off" | "warn" | "block";
export interface CustomCheck { name: string; instructions: string; mode: CheckMode; }
export interface Guide { file: string; text: string; }
// Per-repository posting toggles older installs kept in "guides" / "repoSettings" before repoSettings[repo].review.
type LegacyPosting = { postScores?: boolean; postReview?: boolean; postInlineSuggestions?: boolean };
export interface GitCommit { sha: string; fullSha?: string; message: string; body?: string; author?: string; date?: string; }
export interface BaseCommit { sha: string; message: string; author: string; }
export interface GitHistory { prCommits: GitCommit[]; baseCommits: BaseCommit[]; formatted?: string; }
// A linked issue; Jira and Linear tickets (core/trackers.ts) carry their key ("ABC-123") and repo "jira" / "linear".
export interface LinkedIssue { number: number; key?: string; repo: string; title: string; body: string; state: string; url: string; labels: string[]; }
export const issueLabel = (i: Pick<LinkedIssue, "number" | "key">): string => i.key || `#${i.number}`;

export const REVIEW_DEFAULTS: ReviewSettings = { maxFindings: 8, diffChars: 90000, contextLines: 16, reflectMin: 5, temperature: 0.2, postScores: true, postReview: true, postInlineSuggestions: true, resolveFixed: true, commands: true, auto: true, agentPrompts: true, gitleaks: false, semgrep: false, trivy: false, profile: "balanced", minSeverity: "nit", checks: [], rulesSource: "base", ...RULE_DEFAULTS };
// Review strictness: a profile supplies the defaults for maxFindings and reflectMin (values set explicitly still win)
// and the tone of the language-model instructions (engines.ts).
export type ReviewProfile = "chill" | "balanced" | "assertive";
export const PROFILES: Record<ReviewProfile, Pick<ReviewSettings, "maxFindings" | "reflectMin">> = {
  chill: { maxFindings: 5, reflectMin: 7 },
  balanced: { maxFindings: REVIEW_DEFAULTS.maxFindings, reflectMin: REVIEW_DEFAULTS.reflectMin },
  assertive: { maxFindings: 12, reflectMin: 3 },
};
const PROFILE_KEYS = ["maxFindings", "reflectMin"] as const;
const isProfile = (v: unknown): v is ReviewProfile => typeof v === "string" && Object.hasOwn(PROFILES, v);
const SEVERITY_ORDER: readonly Severity[] = ["nit", "low", "medium", "high"];
const isSeverity = (v: unknown): v is Severity => SEVERITY_ORDER.includes(v as Severity);
// Findings at or above the minimum severity: what gets posted to the pull request (the review page shows all).
export const postable = <F extends { severity?: unknown }>(findings: F[], min: Severity = "nit"): F[] =>
  findings.filter((f) => SEVERITY_ORDER.indexOf(isSeverity(f.severity) ? f.severity : "low") >= SEVERITY_ORDER.indexOf(min));
// Effective settings: defaults, then the profile's defaults, then whatever was set explicitly.
export const resolveReview = (set: Partial<ReviewSettings>): ReviewSettings => {
  const profile = isProfile(set.profile) ? set.profile : REVIEW_DEFAULTS.profile;
  return { ...REVIEW_DEFAULTS, ...PROFILES[profile], ...set, profile };
};
// What a Repository settings save stores. maxFindings / reflectMin are kept only when they differ from both the profile
// the page was loaded with and the profile being saved: an untouched value follows the profile, a moved one is explicit.
export const storedReview = (current: ReviewSettings, sent: { [K in keyof ReviewSettings]?: unknown }): Partial<ReviewSettings> => {
  const next: Partial<ReviewSettings> = normalizeReview({ ...current, ...sent });
  for (const k of PROFILE_KEYS) {
    if (next[k] === PROFILES[current.profile][k] || next[k] === PROFILES[next.profile!][k]) delete next[k];
  }
  return next;
};
// Review settings are per repository (repoSettings[repo].review, from Repository settings). Repositories not yet saved
// there fall back to the old install-wide "review" setting and the per-repository posting toggles kept in "guides".
export const reviewConfig = async (repo = ""): Promise<ReviewSettings> => {
  const [global, guides, rs] = await Promise.all([store.getSetting("review"), repo ? store.getSetting("guides") : null, repo ? store.getSetting("repoSettings") : null]);
  if (!repo) return resolveReview(global || {});
  const g: GuideSetting & LegacyPosting = guides?.[repo] || {};
  const r: RepoSetting & LegacyPosting = rs?.[repo] || {};
  const legacy = Object.fromEntries((["postScores", "postReview", "postInlineSuggestions"] as const).map((k) => [k, g[k] ?? r[k]]).filter(([, v]) => v !== undefined)) as Partial<ReviewSettings>;
  // A repository saved on Repository settings stores only explicit maxFindings / reflectMin: the old install-wide
  // values must not pin them over its profile.
  const inherited: Partial<ReviewSettings> = { ...(global || {}) };
  if (r.review) for (const k of PROFILE_KEYS) delete inherited[k];
  return resolveReview({ ...inherited, ...legacy, ...r.review });
};
export const normalizeReview = (v: { [K in keyof ReviewSettings]?: unknown }): ReviewSettings => ({
  maxFindings: Math.min(12, Math.max(3, Number(v.maxFindings) || REVIEW_DEFAULTS.maxFindings)),
  diffChars: [30000, 60000, 90000, 150000, 300000].includes(Number(v.diffChars)) ? Number(v.diffChars) : REVIEW_DEFAULTS.diffChars,
  reflectMin: [0, 3, 5, 7].includes(Number(v.reflectMin)) ? Number(v.reflectMin) : REVIEW_DEFAULTS.reflectMin,
  contextLines: [0, 8, 16, 32].includes(Number(v.contextLines)) ? Number(v.contextLines) : REVIEW_DEFAULTS.contextLines,
  temperature: Math.min(1, Math.max(0, Number(v.temperature) || 0)),
  postScores: !!v.postScores,
  postReview: !!v.postReview,
  postInlineSuggestions: !!v.postInlineSuggestions,
  resolveFixed: v.resolveFixed === undefined ? REVIEW_DEFAULTS.resolveFixed : !!v.resolveFixed,
  auto: !!v.auto,
  commands: !!v.commands,
  profile: isProfile(v.profile) ? v.profile : REVIEW_DEFAULTS.profile,
  minSeverity: isSeverity(v.minSeverity) ? v.minSeverity : REVIEW_DEFAULTS.minSeverity,
  ...normalizeRules(v),
  checks: normalizeChecks(v.checks),
  agentPrompts: v.agentPrompts === undefined ? REVIEW_DEFAULTS.agentPrompts : !!v.agentPrompts,
  gitleaks: !!v.gitleaks,
  semgrep: !!v.semgrep,
  trivy: !!v.trivy,
  rulesSource: v.rulesSource === "head" ? "head" : "base",
});
// Untrusted (settings body, later a repository config file): at most 20 checks, each with instructions.
export const normalizeChecks = (v: unknown): CustomCheck[] =>
  (Array.isArray(v) ? (v as unknown[]) : [])
    .map((x): CustomCheck | null => {
      if (!x || typeof x !== "object") return null;
      const o = x as Record<string, unknown>;
      const instructions = String(o.instructions ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (!instructions) return null;
      const mode: CheckMode = o.mode === "off" || o.mode === "block" ? o.mode : "warn";
      return { name: String(o.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80), instructions, mode };
    })
    .filter((x): x is CustomCheck => !!x)
    .slice(0, 20)
    .map((x, i) => ({ ...x, name: x.name || `Check ${i + 1}` }));

// Rules source: where a review reads its repository rules, the guides (AGENTS.md / CLAUDE.md) and `.codeotter.json`.
// A per-repository setting (repoSettings[repo].review.rulesSource):
//   "base" (default): every rule file is read from the base repository at the pull request's base branch.
//   "head": a same-repository pull request also reads them at its head commit (by SHA), so a team can try a rule
//           change on a branch before merging it. Fork pull requests always use "base": a fork is never read.
// Even in head mode a pull request cannot loosen the rules it is reviewed under. What the head may change:
//   guides            AGENTS.md / CLAUDE.md text: the head's copy of a file replaces the base's; a guide the head
//                     deletes is still read from the base.
//   pathInstructions  head entries are appended to the base's (base file, else Repository settings); none is removed.
//   checks            head checks with a new name (case-insensitive) and mode warn/block are appended to the base's
//                     (base file, else Repository settings); a head entry reusing a base name (to switch it off,
//                     soften block to warn, or reword it) is ignored, and a check the head leaves out stays.
// Every other `.codeotter.json` key (pathInclude, pathExclude, reviewDrafts and every skip rule, and any key added
// later) is taken from the base only; the head's differing values are reported as `ignored`. Auto-review skip
// decisions (queue.ts) never read the head.
export type RulesSource = "base" | "head";
// What a review took from the head: the commit, the rule files whose head copy differs from the base's, and the
// `.codeotter.json` keys the head changed but the merge refused.
export interface RulesFromHead { ref: string; files: string[]; ignored: string[] }
const REF_SHA = /^[0-9a-f]{7,64}$/i;
// The head commit a review may read rules at, or "" when it must use the base: head mode only, same repository only
// (forge adapters name a fork's head repository in headRepo; gh says isCrossRepository, unknown counts as a fork),
// and only by commit SHA so a cached file never changes under a push.
export function headRulesRef(repo: string, pr: { headRepo?: string; isCrossRepository?: boolean; headRefOid?: string }, source: RulesSource = "base"): string {
  if (source !== "head") return "";
  const same = isForgeRepo(repo) ? pr.headRepo === repo : pr.isCrossRepository === false;
  return same && REF_SHA.test(pr.headRefOid || "") ? String(pr.headRefOid) : "";
}

// A repository file at one ref, exactly (null when missing), cached by repo + ref + path for ten minutes.
const fileCache = new Map<string, { text: string | null; at: number }>();
async function fileAt(repo: string, file: string, ref: string): Promise<string | null> {
  const key = `${repo}@${ref}:${file}`;
  const hit = fileCache.get(key);
  if (hit && Date.now() - hit.at < 600e3) return hit.text;
  const text = isForgeRepo(repo)
    ? await forgeOf(repo).file(repo, file, ref)
    : await ghAsync("api", `repos/${repo}/contents/${file}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, "-H", "Accept: application/vnd.github.raw").catch(() => null);
  if (fileCache.size > 1000) fileCache.clear();
  fileCache.set(key, { text, at: Date.now() });
  return text;
}

// Repository review guides: AGENTS.md and/or CLAUDE.md at the repo root (both are used when both exist, since one is
// often a stub pointing at the other). Detection is cached for 10 minutes; whether guides are used is a per-repository
// setting ("guides": { "owner/name": { use: bool } }), defaulting to on when found.
const GUIDE_FILES = ["AGENTS.md", "CLAUDE.md"];
const GUIDE_CHARS = 20000;
export const guideCache = new Map<string, { files: string[]; at: number }>();
export async function guideFiles(repo: string, ref = ""): Promise<string[]> {
  const cacheKey = `${repo}@${ref}`;
  const hit = guideCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 600e3) return hit.files;
  if (isForgeRepo(repo)) {
    const files: string[] = [];
    for (const file of GUIDE_FILES) if ((await fileAt(repo, file, ref)) !== null) files.push(file);
    guideCache.set(cacheKey, { files, at: Date.now() });
    capMap(guideCache, 500);
    return files;
  }
  const files: string[] = [];
  for (const f of GUIDE_FILES) {
    const exists = await ghAsync("api", `repos/${repo}/contents/${f}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, "--jq", ".name").then(() => true)
      .catch(() => (ref ? ghAsync("api", `repos/${repo}/contents/${f}`, "--jq", ".name").then(() => true) : false))
      .catch(() => repo === REPO && existsSync(join(ROOT, f)));
    if (exists) files.push(f);
  }
  guideCache.set(cacheKey, { files, at: Date.now() });
  return files;
}
const guideText = async (repo: string, file: string, ref = ""): Promise<string> => {
  if (isForgeRepo(repo)) return (await fileAt(repo, file, ref)) ?? "";
  if (ref) {
    const text = await fileAt(repo, file, ref);
    if (text !== null) return text;
  }
  try {
    return await ghAsync("api", `repos/${repo}/contents/${file}`, "-H", "Accept: application/vnd.github.raw");
  } catch {
    return repo === REPO && existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : "";
  }
};
const joinGuides = (parts: [string, string][]): Guide => {
  const per = Math.floor(GUIDE_CHARS / parts.length);
  return { file: parts.map(([f]) => f).join(" + "), text: parts.map(([f, t]) => `--- ${f} ---\n${t.slice(0, per)}`).join("\n\n") };
};
export async function guideFor(repo: string, ref = "", contentRepo = repo): Promise<Guide | null> {
  if (!REPO_RE.test(contentRepo)) throw new Error("Invalid guide repository");
  const files = await guideFiles(contentRepo, ref);
  if (!files.length) return null;
  const use = (await store.getSetting("guides"))?.[repo]?.use ?? true;
  if (!use) return null;
  return joinGuides(await Promise.all(files.map(async (f): Promise<[string, string]> => [f, await guideText(contentRepo, f, ref)])));
}
type RulesPr = { baseRefName?: string; headRepo?: string; isCrossRepository?: boolean; headRefOid?: string };
// The guides a review of `pr` follows: the base branch's or, in head mode for a same-repository pull request, the
// head's copies over them (see "Rules source" above). `fromHead` lists the guide files whose head copy is used.
// `source` defaults to the repository's setting.
export async function prGuide(repo: string, pr: RulesPr, source?: RulesSource): Promise<{ guide: Guide | null; fromHead: string[] }> {
  const base = pr.baseRefName || "";
  const head = headRulesRef(repo, pr, source ?? (await reviewConfig(repo)).rulesSource);
  const baseGuide = await guideFor(repo, base);
  if (!head || !((await store.getSetting("guides"))?.[repo]?.use ?? true)) return { guide: baseGuide, fromHead: [] };
  const texts = await Promise.all(GUIDE_FILES.map((f) => Promise.all([fileAt(repo, f, base), fileAt(repo, f, head)])));
  const fromHead = GUIDE_FILES.filter((_, i) => texts[i][1] !== null && texts[i][1] !== texts[i][0]);
  if (!fromHead.length) return { guide: baseGuide, fromHead };
  const parts = GUIDE_FILES.map((f, i): [string, string | null] => [f, texts[i][1] ?? texts[i][0]]).filter((p): p is [string, string] => p[1] !== null);
  return { guide: joinGuides(parts), fromHead };
}

// `.codeotter.json` (schema in repo-rules.ts), read like the guides from the base repository at the base branch and,
// in head mode, at a same-repository head (merged by mergeHeadConfig).
// The file may also carry "checks" (custom pre-merge checks, CustomCheck[]), normalised by normalizeChecks.
export type RepoConfig = Partial<RepoRules> & { checks?: CustomCheck[] };
export const clearRepoConfigCache = () => fileCache.clear();
// The repository's `.codeotter.json` at `ref` (the default branch when empty), cached with the other rule files.
// `side` names the ref in a parse error ("head branch").
export async function repoConfigFile(repo: string, ref = "", side = ""): Promise<RepoConfig | null> {
  if (!REPO_RE.test(repo)) throw new Error("Invalid repository");
  const text = await fileAt(repo, CONFIG_FILE, ref);
  return text === null || !text.trim() ? null : parseConfigFile(text.slice(0, 65536), side);
}
const parseConfigFile = (text: string, side = ""): RepoConfig => {
  let rules: RepoConfig;
  try {
    rules = parseRepoConfig(text); // throws on invalid JSON or a non-object
  } catch (e) {
    throw side ? new Error(`${(e as Error).message} (${side})`) : e;
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  if ("checks" in raw) rules.checks = normalizeChecks(raw.checks);
  return rules;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// The base file with the head file's additive keys merged in, per "Rules source" above. `ui` supplies the base's path
// instructions and checks when the base file does not set them, so a head entry never drops a Repository settings one.
export function mergeHeadConfig(base: RepoConfig | null, head: RepoConfig | null, ui: { pathInstructions?: RepoRules["pathInstructions"]; checks?: CustomCheck[] } = {}): { config: RepoConfig | null; ignored: string[] } {
  if (!head) return { config: base, ignored: [] };
  const out: RepoConfig = { ...(base || {}) };
  const ignored: string[] = (Object.keys(head) as (keyof RepoConfig)[]).filter((k) => k !== "pathInstructions" && k !== "checks" && !same(head[k], base?.[k]));
  if (head.pathInstructions?.length) {
    const own = base?.pathInstructions ?? ui.pathInstructions ?? [];
    const added = head.pathInstructions.filter((p) => !own.some((o) => same(o, p)));
    if (added.length) out.pathInstructions = [...own, ...added].slice(0, 50);
  }
  if (head.checks?.length) {
    const own = base?.checks ?? ui.checks ?? [];
    const names = new Set(own.map((c) => c.name.toLowerCase()));
    if (head.checks.some((c) => names.has(c.name.toLowerCase()) && !own.some((o) => same(o, c)))) ignored.push("checks");
    const added = head.checks.filter((c) => c.mode !== "off" && !names.has(c.name.toLowerCase()));
    if (added.length) out.checks = [...own, ...added].slice(0, 20);
  }
  return { config: Object.keys(out).length ? out : null, ignored };
}
// Repository settings with the file's keys over them. `pr` names the base branch and, in head mode (`ui.rulesSource`),
// a same-repository head commit; `fromHead` is set when the head's `.codeotter.json` differs from the base's.
export async function effectiveRules(repo: string, ui: Partial<RepoRules> & { checks?: CustomCheck[]; rulesSource?: RulesSource }, pr: RulesPr = {}): Promise<RepoRules & { checks?: CustomCheck[]; configFile: string[] | null; fromHead: RulesFromHead | null }> {
  const baseRef = pr.baseRefName || "";
  let file = await repoConfigFile(repo, baseRef);
  let fromHead: RulesFromHead | null = null;
  const head = headRulesRef(repo, pr, ui.rulesSource);
  if (head && (await fileAt(repo, CONFIG_FILE, head)) !== (await fileAt(repo, CONFIG_FILE, baseRef))) {
    const merged = mergeHeadConfig(file, await repoConfigFile(repo, head, "head branch"), ui);
    file = merged.config;
    fromHead = { ref: head, files: [CONFIG_FILE], ignored: merged.ignored };
  }
  return { ...normalizeRules({ ...ui, ...(file || {}) }), ...(file?.checks ? { checks: file.checks } : {}), configFile: file ? Object.keys(file) : null, fromHead };
}

export function normalizeLearningList(list: unknown): string[] {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((x: unknown) => String(typeof x === "object" && x !== null ? (x as { id?: unknown; label?: unknown }).id || (x as { id?: unknown; label?: unknown }).label || "" : x).trim())
        .filter(Boolean),
    ),
  ].slice(-50);
}

export async function getRepoLearnings(repo: string): Promise<string[]> {
  if (!repo) return [];
  const [rs, guides] = await Promise.all([store.getSetting("repoSettings"), store.getSetting("guides")]);
  return normalizeLearningList(rs?.[repo]?.learnings ?? guides?.[repo]?.learnings ?? []);
}

export async function setRepoLearnings(repo: string, list: unknown): Promise<string[]> {
  const normalized = normalizeLearningList(list);
  const [rs0, guides0] = await Promise.all([store.getSetting("repoSettings"), store.getSetting("guides")]);
  const repoSettings: Record<string, RepoSetting> = { ...(rs0 || {}) };
  repoSettings[repo] = { ...(repoSettings[repo] || {}), learnings: normalized };
  const guides: Record<string, GuideSetting> = { ...(guides0 || {}) };
  guides[repo] = { ...(guides[repo] || {}), learnings: normalized };
  await Promise.all([store.setSetting("repoSettings", repoSettings), store.setSetting("guides", guides)]);
  return normalized;
}

// Fixes this repository's authors applied from CodeOtter suggestions ("[file] title"), most recent last, capped at 30.
export async function getRepoAccepted(repo: string): Promise<string[]> {
  return repo ? normalizeLearningList((await store.getSetting("repoSettings"))?.[repo]?.accepted ?? []) : [];
}
export async function addRepoAccepted(repo: string, items: string[]): Promise<string[]> {
  const rs: Record<string, RepoSetting> = { ...((await store.getSetting("repoSettings")) || {}) };
  const accepted = normalizeLearningList([...(rs[repo]?.accepted || []), ...items]).slice(-30);
  rs[repo] = { ...(rs[repo] || {}), accepted };
  await store.setSetting("repoSettings", rs);
  return accepted;
}

export function extractHeadSha(pr: Pick<PullRequest, "headRefOid" | "headSha" | "commits"> | null | undefined, gitHistory: Pick<GitHistory, "prCommits"> | null | undefined = null): string {
  return String(
    pr?.headRefOid ||
    pr?.headSha ||
    pr?.commits?.at(-1)?.oid ||
    gitHistory?.prCommits?.at(-1)?.sha ||
    "",
  ).trim();
}

export function shaMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = String(a || "").trim().toLowerCase();
  const sb = String(b || "").trim().toLowerCase();
  if (!sa || !sb || sa.length < 7 || sb.length < 7) return false;
  return sa.startsWith(sb) || sb.startsWith(sa);
}

export async function fetchGitHistory(repo: string, pr: PullRequest): Promise<Required<GitHistory> & { prCommits: Required<GitCommit>[] }> {
  const prCommits = Array.isArray(pr.commits)
    ? pr.commits.map((c) => ({
        sha: String(c.oid || "").slice(0, 7),
        fullSha: String(c.oid || ""),
        message: String(c.messageHeadline || c.messageBody || "").trim(),
        body: String(c.messageBody || "").trim(),
        author: c.authors?.[0]?.login || c.authors?.[0]?.name || pr.author?.login || "",
        date: c.committedDate || "",
      }))
    : [];
  let baseCommits: BaseCommit[] = [];
  try {
    if (isForgeRepo(repo)) baseCommits = await forgeOf(repo).baseCommits(repo, pr.baseRefName, 8);
    const list = isForgeRepo(repo) ? null : (JSON.parse(await ghAsync("api", `repos/${repo}/commits?sha=${encodeURIComponent(pr.baseRefName)}&per_page=8`)) as unknown);
    if (Array.isArray(list)) {
      baseCommits = (list as { sha?: string; commit?: { message?: string; author?: { name?: string } }; author?: { login?: string } | null }[]).map((c) => ({
        sha: String(c.sha || "").slice(0, 7),
        message: String(c.commit?.message || "").split("\n")[0].trim(),
        author: c.author?.login || c.commit?.author?.name || "",
      }));
    }
  } catch {}
  const formatted = [
    prCommits.length
      ? `PR Commits (${prCommits.length}):\n` + prCommits.map((c) => `- ${c.sha} ${c.message}${c.body ? ` (${c.body.slice(0, 160).replace(/\s+/g, " ")})` : ""}`).join("\n")
      : "",
    baseCommits.length
      ? `Recent ${pr.baseRefName} branch history:\n` + baseCommits.map((c) => `- ${c.sha} ${c.message}`).join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { prCommits, baseCommits, formatted };
}

const ISSUE_REF_RE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|#)\s*(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)/gi;
const STANDALONE_ISSUE_RE = /(?:^|[^\w/])(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)\b/g;
const BRANCH_ISSUE_RE = /(?:^|[/_-])(?:issue|fix|bug|feat|closes|resolves|gh)[/_-]?(\d+)\b|^(\d+)[/_-]/gi;

function parseLinkedIssueRefs(baseRepo: string, pr: Partial<Pick<PullRequest, "number" | "title" | "body" | "headRefName">> | null | undefined): { repo: string; number: number }[] {
  if (!baseRepo || !REPO_RE.test(baseRepo)) return [];
  const seen = new Set<string>();
  const out: { repo: string; number: number }[] = [];
  const addRef = (repoCandidate: string | undefined, numStr: string | undefined) => {
    const num = Number(numStr);
    if (!Number.isInteger(num) || num <= 0) return;
    let issueRepo = repoCandidate ? String(repoCandidate).trim() : baseRepo;
    if (isForgeRepo(baseRepo) && !isForgeRepo(issueRepo)) issueRepo = `${forgeId(baseRepo)}~${issueRepo}`;
    const [ownerPart, namePart] = issueRepo.split("/");
    if (!REPO_RE.test(issueRepo) || !OWNER_RE.test(ownerPart || "") || !OWNER_RE.test(namePart || "")) return;
    if (issueRepo === baseRepo && num === Number(pr?.number)) return;
    const key = `${issueRepo}#${num}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ repo: issueRepo, number: num });
  };

  const textSources = [String(pr?.title || ""), String(pr?.body || "")];
  for (const src of textSources) {
    for (const m of src.matchAll(ISSUE_REF_RE)) addRef(m[1], m[2]);
    for (const m of src.matchAll(STANDALONE_ISSUE_RE)) addRef(m[1], m[2]);
  }
  const branch = String(pr?.headRefName || "");
  if (branch) {
    for (const m of branch.matchAll(BRANCH_ISSUE_RE)) addRef(baseRepo, m[1] || m[2]);
  }
  return out.slice(0, 3);
}

// Forge issues ("Closes #123") and Jira / Linear tickets named in the title, branch or description.
export async function fetchLinkedIssues(baseRepo: string, pr: Partial<Pick<PullRequest, "number" | "title" | "body" | "headRefName">> | null | undefined): Promise<LinkedIssue[]> {
  const [issues, tickets] = await Promise.all([fetchForgeIssues(baseRepo, pr), linkedTickets(pr).catch(() => [])]);
  return [...issues, ...tickets];
}
async function fetchForgeIssues(baseRepo: string, pr: Partial<Pick<PullRequest, "number" | "title" | "body" | "headRefName">> | null | undefined): Promise<LinkedIssue[]> {
  const refs = parseLinkedIssueRefs(baseRepo, pr);
  if (!refs.length) return [];
  const list = await Promise.all(
    refs.slice(0, 3).map(async ({ repo: issueRepo, number: num }): Promise<LinkedIssue | null> => {
      if (!REPO_RE.test(issueRepo)) return null;
      try {
        const iss = (isForgeRepo(issueRepo) ? await forgeOf(issueRepo).issue(issueRepo, num) : JSON.parse(await ghAsync(["issue", "view", String(num), "-R", issueRepo, "--json", "number,title,body,state,url,labels"]))) as RawIssue | null;
        if (!iss || !iss.number) return null;
        return {
          number: Number(iss.number) || num,
          repo: issueRepo,
          title: String(iss.title || "").trim().slice(0, 300),
          body: String(iss.body || "").trim().slice(0, 1200),
          state: String(iss.state || "OPEN").toUpperCase(),
          url: String(iss.url || `https://github.com/${issueRepo}/issues/${num}`),
          labels: Array.isArray(iss.labels)
            ? iss.labels.map((l: string | { name?: string } | null) => (typeof l === "string" ? l : String(l?.name || ""))).filter(Boolean).slice(0, 12)
            : [],
        };
      } catch {
        return null;
      }
    }),
  );
  return list.filter((x): x is LinkedIssue => !!x);
}
interface RawIssue { number?: number | string; title?: string; body?: string | null; state?: string; url?: string; labels?: unknown; }

// Head-revision text of changed files, for dynamic context. Capped in count and size; a file that fails is skipped.
export async function headFileTexts(pr: PullRequest, paths: string[], max = 25, maxChars = 400000, ref = pr.headRefOid || pr.headRefName): Promise<Map<string, string>> {
  const repo = pr.headRepo || repoOf(pr);
  const texts = new Map<string, string>();
  if (!ref || !REPO_RE.test(repo)) return texts;
  const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");
  await Promise.all(paths.slice(0, max).map(async (p) => {
    if (p.split("/").some((s) => !s || s === "." || s === "..")) return;
    try {
      let text: string | null | undefined;
      if (isForgeRepo(repo)) {
        text = await forgeOf(repo).file(repo, p, ref);
        if (typeof text !== "string") return;
      } else {
        text = await ghAsync("api", `repos/${repoOf(pr)}/contents/${enc(p)}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw");
      }
      if (text.length <= maxChars) texts.set(p, text);
    } catch {}
  }));
  return texts;
}
