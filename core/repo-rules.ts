// Repository rules: path filters, path instructions and auto-review skip rules. Set per repository in Repository settings
// (repoSettings[repo].review, read through reviewConfig) and overridden by a `.codeotter.json` at the repository root.
//
// `.codeotter.json` (JSON, every key optional; a key present in the file wins over the Repository settings value;
// "checks", custom pre-merge checks as [{ "name", "instructions", "mode": "off" | "warn" | "block" }], is read by context.ts):
// {
//   "pathInclude":       string[]   globs; when set, only matching files reach the models
//   "pathExclude":       string[]   globs; matching files are dropped from the diff sent to the models
//   "pathInstructions":  { "path": string, "instructions": string }[]
//                                   added to the language model prompt when a changed file matches `path`
//   "reviewDrafts":      boolean    auto-review draft pull requests (default false)
//   "skipAuthors":       string[]   author logins, `*` wildcard, case-insensitive (e.g. "dependabot[bot]", "*[bot]")
//   "skipBaseBranches":  string[]   base branches never auto-reviewed, `*` wildcard
//   "onlyBaseBranches":  string[]   when set, only pull requests into these base branches are auto-reviewed
//   "skipTitleKeywords": string[]   case-insensitive title substrings (e.g. "WIP", "[skip review]")
//   "skipLabels":        string[]   labels that skip auto-review; `codeotter:skip` always does
// }
// Globs: `*` and `?` stay inside one path segment, `**` crosses segments, a trailing `/` means everything below, a
// leading `/` anchors at the root, and a glob without `/` matches the file name at any depth.
//
// Trust: the file is read from the base repository at the pull request's base branch, so a pull request cannot loosen
// the rules it is reviewed under. With Rules source = head branch (context.ts, "Rules source"), a same-repository pull
// request's head copy is merged in for additive keys only (pathInstructions, new checks); every key above that can
// loosen a review stays the base's, and a fork's head is never read.
// Pure: no I/O and no core imports (context.ts imports it). Reading the file is repoConfigFile() in context.ts.

export interface PathInstruction { path: string; instructions: string }
export interface RepoRules {
  pathInclude: string[];
  pathExclude: string[];
  pathInstructions: PathInstruction[];
  reviewDrafts: boolean;
  skipAuthors: string[];
  skipBaseBranches: string[];
  onlyBaseBranches: string[];
  skipTitleKeywords: string[];
  skipLabels: string[];
}
export const RULE_DEFAULTS: RepoRules = { pathInclude: [], pathExclude: [], pathInstructions: [], reviewDrafts: false, skipAuthors: [], skipBaseBranches: [], onlyBaseBranches: [], skipTitleKeywords: [], skipLabels: [] };
const LIST_KEYS = ["pathInclude", "pathExclude", "skipAuthors", "skipBaseBranches", "onlyBaseBranches", "skipTitleKeywords", "skipLabels"] as const;
export const CONFIG_FILE = ".codeotter.json";
const MAX_ITEMS = 50;

// A list from an array or from text (one item per line, as the settings page sends it).
const strList = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [])
  .filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 200)).filter(Boolean))].slice(0, MAX_ITEMS);
// Path instructions from [{ path, instructions }] or text lines `glob: instructions`.
const instructionList = (v: unknown): PathInstruction[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [])
  .map((x: unknown): PathInstruction | null => {
    if (typeof x === "string") {
      const i = x.indexOf(":");
      return i > 0 ? { path: x.slice(0, i).trim(), instructions: x.slice(i + 1).trim() } : null;
    }
    if (typeof x !== "object" || x === null) return null;
    const o = x as { path?: unknown; instructions?: unknown };
    return typeof o.path === "string" && typeof o.instructions === "string" ? { path: o.path.trim(), instructions: o.instructions.trim() } : null;
  })
  .filter((x): x is PathInstruction => !!x && !!x.path && !!x.instructions)
  .map((x) => ({ path: x.path.slice(0, 200), instructions: x.instructions.slice(0, 2000) }))
  .slice(0, MAX_ITEMS);

export const normalizeRules = (v: { [K in keyof RepoRules]?: unknown }): RepoRules => ({
  ...(Object.fromEntries(LIST_KEYS.map((k) => [k, strList(v[k])])) as Pick<RepoRules, (typeof LIST_KEYS)[number]>),
  pathInstructions: instructionList(v.pathInstructions),
  reviewDrafts: !!v.reviewDrafts,
});
// The settings page draws the lists as text, one item per line.
export const rulesAsText = (r: RepoRules): Record<keyof RepoRules, string | boolean> => ({
  ...(Object.fromEntries(LIST_KEYS.map((k) => [k, r[k].join("\n")])) as Record<(typeof LIST_KEYS)[number], string>),
  pathInstructions: r.pathInstructions.map((p) => `${p.path}: ${p.instructions}`).join("\n"),
  reviewDrafts: r.reviewDrafts,
});

const globCache = new Map<string, RegExp>();
export function globRegex(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let g = glob.trim().replace(/\\/g, "/");
  if (g.endsWith("/")) g += "**";
  if (g.startsWith("/")) g = g.replace(/^\/+/, "");
  else if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const segStart = i === 0 || g[i - 1] === "/";
      if (segStart && g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; continue; } // `**/`: zero or more directories
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  if (globCache.size > 1000) globCache.clear();
  globCache.set(glob, out);
  return out;
}
export const globMatch = (path: string, glob: string): boolean => globRegex(glob).test(path.replace(/^\/+/, ""));
const anyGlob = (path: string, globs: string[]) => globs.some((g) => globMatch(path, g));
export const pathAllowed = (path: string, r: Pick<RepoRules, "pathInclude" | "pathExclude">): boolean =>
  (!r.pathInclude?.length || anyGlob(path, r.pathInclude)) && !anyGlob(path, r.pathExclude || []);

// The file a `diff --git` block changes: the new path, or the old one for a deletion.
const blockPath = (block: string): string =>
  (block.match(/^\+\+\+ b\/(.+)$/m) || block.match(/^--- a\/(.+)$/m) || block.match(/^diff --git a\/.+? b\/(.+)$/m) || [])[1]?.trim() || "";
export const diffFiles = (diff: string): string[] => [...new Set(String(diff || "").split(/^(?=diff --git )/m).map(blockPath).filter(Boolean))];
// Drops the files the path filters exclude from a unified diff.
export function filterDiff(diff: string, r: Pick<RepoRules, "pathInclude" | "pathExclude">): { diff: string; excluded: string[] } {
  if (!r.pathInclude?.length && !r.pathExclude?.length) return { diff, excluded: [] };
  const excluded: string[] = [];
  const kept = String(diff || "").split(/^(?=diff --git )/m).filter((block) => {
    const path = blockPath(block);
    if (!path || pathAllowed(path, r)) return true;
    excluded.push(path);
    return false;
  });
  return { diff: kept.join(""), excluded };
}
// The prompt block for path instructions whose glob matches a file in the diff; "" when none does.
export function pathInstructionBlock(list: PathInstruction[] | undefined, files: string[]): string {
  const hits = (list || []).filter((p) => files.some((f) => globMatch(f, p.path)));
  return hits.length ? `\nPath instructions (apply each to the changed files its glob matches):\n${hits.map((p) => `- ${p.path}: ${p.instructions}`).join("\n")}\n` : "";
}

// What the auto-review skip rules read from a queued pull request (openPrs rows, forge and webhook payloads).
export interface SkipInput { isDraft?: boolean; labels?: ({ name?: string } | string | null)[]; title?: string; author?: { login?: string } | string; baseRefName?: string }
const wildcard = (pattern: string, value: string) => new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(value);
// Why auto-review leaves this pull request alone, or "" to review it.
export function skipReason(p: SkipInput, r: Partial<RepoRules>): string {
  if (p.isDraft && !r.reviewDrafts) return "draft";
  const labels = (p.labels || []).map((l) => String((typeof l === "object" ? l?.name : l) || "").toLowerCase()).filter(Boolean);
  const skipLabels = ["codeotter:skip", ...(r.skipLabels || [])].map((l) => l.toLowerCase());
  const label = labels.find((l) => skipLabels.includes(l));
  if (label) return `label ${label}`;
  const author = String((typeof p.author === "object" ? p.author?.login : p.author) || "");
  if (author && (r.skipAuthors || []).some((a) => wildcard(a, author))) return `author ${author}`;
  const base = String(p.baseRefName || "");
  if (base && r.onlyBaseBranches?.length && !r.onlyBaseBranches.some((b) => wildcard(b, base))) return `base ${base}`;
  if (base && (r.skipBaseBranches || []).some((b) => wildcard(b, base))) return `base ${base}`;
  const title = String(p.title || "").toLowerCase();
  const kw = (r.skipTitleKeywords || []).find((k) => title.includes(k.toLowerCase()));
  if (kw) return `title ${kw}`;
  return "";
}

// `.codeotter.json` parsed into the keys it sets (only those). Unknown keys are ignored; invalid JSON is an error.
export function parseRepoConfig(text: string): Partial<RepoRules> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: expected a JSON object`);
  const o = raw as Record<string, unknown>;
  const all = normalizeRules(o);
  return Object.fromEntries((Object.keys(RULE_DEFAULTS) as (keyof RepoRules)[]).filter((k) => k in o).map((k) => [k, all[k]])) as Partial<RepoRules>;
}
