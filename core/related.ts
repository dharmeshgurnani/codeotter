// Context from related repositories: up to RELATED_MAX onboarded repositories in the same organization and on the same
// provider (Repository settings, repoSettings[repo].review.related) are searched for usages of the symbols a pull
// request changes. Each provider's own credentials search only its own repositories, so a related repository is never
// on another provider. Bounded in symbols, hits, snippet size and time, per repository and in total; results are
// cached by related repository + reviewed head SHA; a related repository that fails or times out is reported, never
// fails the review. What a viewer sees of the results is filtered at render time (forViewer).
import { REPO_RE } from "./config.ts";
import { forgeId, forgeOf, ghAsync, isForgeRepo } from "./git.ts";
import type { CodeHit } from "./forges.ts";
import type { OutsideCaller, OutsideImpact, RelatedRepoResult } from "./diff.ts";

export const RELATED_MAX = 7;
export interface RelatedBudget {
  symbols: number; // symbols searched per repository
  perRepoHits: number; // callers kept per repository
  totalHits: number; // callers kept over all repositories
  perRepoMs: number; // time for one repository's searches
  totalMs: number; // time for the whole related search
  snippetChars: number;
}
export const RELATED_BUDGET: RelatedBudget = { symbols: 5, perRepoHits: 6, totalHits: 24, perRepoMs: 8000, totalMs: 20000, snippetChars: 160 };

// <scope>
// The organization part of a repository id, provider prefix included ("gitea~acme" for "gitea~acme/api").
const orgOf = (repo: string) => String(repo).split("/")[0] || "";
// Same organization and same provider, and not the repository itself.
export const sameScope = (repo: string, other: string) => other !== repo && REPO_RE.test(other) && orgOf(other) === orgOf(repo) && forgeId(other) === forgeId(repo);
// What Repository settings offers: the other onboarded repositories in scope.
export const relatedChoices = (repo: string, onboarded: string[]): string[] => onboarded.filter((r) => sameScope(repo, r));
// A Repository settings save: refuses more than RELATED_MAX or any repository out of scope (not onboarded, another
// organization, another provider).
export function validateRelated(repo: string, list: unknown, onboarded: string[]): string[] {
  if (list !== undefined && list !== null && !Array.isArray(list)) throw new Error("Related repositories must be a list");
  const picked = [...new Set((Array.isArray(list) ? list : []).map(String))];
  if (picked.length > RELATED_MAX) throw new Error(`At most ${RELATED_MAX} related repositories`);
  const ok = new Set(relatedChoices(repo, onboarded));
  const bad = picked.find((r) => !ok.has(r));
  if (bad) throw new Error(`${bad} is not an onboarded repository in the same organization and provider`);
  return picked;
}
// At review time: the stored list, minus anything no longer in scope (offboarded since it was saved).
export const usableRelated = (repo: string, list: string[], onboarded: string[]): string[] => {
  const ok = new Set(relatedChoices(repo, onboarded));
  return [...new Set(list)].filter((r) => ok.has(r)).slice(0, RELATED_MAX);
};
// </scope>

// <search>
interface Cached { at: number; callers: OutsideCaller[]; status: "ok" | "unsupported" }
const cache = new Map<string, Cached>();
const CACHE_MS = 30 * 60e3;
export const clearRelatedCache = () => cache.clear();
const SKIP_FILE = /\.(lock|map|min\.js|svg|png|jpe?g|gif|json)$/i;
const wordRe = (sym: string) => new RegExp(`(^|[^\\w$])${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`);

// One symbol in one repository: the provider's code search (GitHub through gh, the others through forges.ts).
// null: the provider has no code search API.
async function searchRepo(repo: string, sym: string, limit: number): Promise<CodeHit[] | null> {
  if (isForgeRepo(repo)) return forgeOf(repo).searchCode(repo, sym, limit);
  const raw = await ghAsync("api", "-H", "Accept: application/vnd.github.text-match+json", `search/code?q=${encodeURIComponent(sym)}+repo:${repo}&per_page=${limit}`);
  const data = JSON.parse(raw) as { items?: { path?: unknown; text_matches?: { fragment?: unknown }[] }[] };
  return (Array.isArray(data.items) ? data.items : []).map((it): CodeHit => {
    const frag = String(it.text_matches?.[0]?.fragment ?? "");
    return { path: String(it.path ?? ""), line: 0, snippet: frag.split("\n").find((l) => l.includes(sym)) || "" };
  });
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
});

async function oneRepo(repo: string, symbols: string[], sha: string, b: RelatedBudget, deadline: number): Promise<{ result: RelatedRepoResult; callers: OutsideCaller[] }> {
  const key = `${repo}@${sha}#${symbols.join(",")}`;
  const hit = sha ? cache.get(key) : undefined;
  const done = (status: RelatedRepoResult["status"], callers: OutsideCaller[], extra: Partial<RelatedRepoResult> = {}) =>
    ({ result: { repo, status, callers: callers.length, files: new Set(callers.map((c) => c.file)).size, ...extra }, callers });
  if (hit && Date.now() - hit.at < CACHE_MS) return done(hit.status, hit.callers, { cached: true });
  const until = Math.min(deadline, Date.now() + b.perRepoMs);
  const callers: OutsideCaller[] = [];
  const seen = new Set<string>();
  try {
    for (const sym of symbols) {
      if (callers.length >= b.perRepoHits) break;
      const left = until - Date.now();
      if (left <= 0) return done("timeout", callers);
      const hits = await timeout(searchRepo(repo, sym, b.perRepoHits), left);
      if (hits === "timeout") return done("timeout", callers);
      if (hits === null) return (cache.set(key, { at: Date.now(), callers: [], status: "unsupported" }), done("unsupported", []));
      for (const h of hits) {
        const file = String(h.path || "").replace(/\\/g, "/");
        if (!file || file.split("/").some((s) => s === "..") || SKIP_FILE.test(file)) continue;
        const snippet = String(h.snippet || "").replace(/\s+/g, " ").trim();
        // code search matches tokens loosely; keep a hit only when its snippet names the symbol (or has no snippet)
        if (snippet && !wordRe(sym).test(snippet)) continue;
        const id = `${file}:${h.line}:${sym}`;
        if (seen.has(id)) continue;
        seen.add(id);
        callers.push({ repo, symbol: sym, file, line: Math.max(0, Math.floor(Number(h.line) || 0)), snippet: (snippet || `reference to ${sym}`).slice(0, b.snippetChars) });
        if (callers.length >= b.perRepoHits) break;
      }
    }
  } catch (e) {
    return done("failed", callers, { error: String((e as Error)?.message || e).split("\n")[0].slice(0, 200) });
  }
  if (sha) {
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), callers, status: "ok" });
  }
  return done("ok", callers);
}

// Search every related repository in parallel for the changed symbols. `sha` is the reviewed head (the cache key).
export async function relatedImpact(related: string[], symbols: string[], sha: string, b: RelatedBudget = RELATED_BUDGET): Promise<Pick<Required<OutsideImpact>, "related" | "relatedCallers" | "relatedFormatted">> {
  const syms = symbols.slice(0, b.symbols);
  const list = related.slice(0, RELATED_MAX);
  if (!syms.length || !list.length) return { related: list.map((repo) => ({ repo, status: "skipped", callers: 0, files: 0 })), relatedCallers: [], relatedFormatted: "" };
  const deadline = Date.now() + b.totalMs;
  const runs = await Promise.all(list.map((repo) => oneRepo(repo, syms, sha, b, deadline).catch((e: Error) => ({ result: { repo, status: "failed" as const, callers: 0, files: 0, error: e.message }, callers: [] }))));
  const callers: OutsideCaller[] = [];
  for (const r of runs) for (const c of r.callers) if (callers.length < b.totalHits) callers.push(c);
  return { related: runs.map((r) => r.result), relatedCallers: callers, relatedFormatted: formatRelated(callers) };
}

// The prompt block. Sized by the caller (engines.ts) to the model's context.
export function formatRelated(callers: OutsideCaller[]): string {
  if (!callers.length) return "";
  const repos = [...new Set(callers.map((c) => c.repo || ""))];
  return `Cross-Repository Context (${callers.length} usage(s) in ${repos.length} related repositor${repos.length === 1 ? "y" : "ies"}, default branch):\n` +
    "These repositories depend on symbols this pull request changes. Flag changes that break them (signatures, return shapes, removed exports, thrown errors):\n" +
    callers.map((c) => `- [${c.repo}] ${c.file}${c.line ? `:${c.line}` : ""} uses '${c.symbol}': \`${c.snippet}\``).join("\n");
}
// </search>

// <render>
// What one viewer sees of a review's related-repository context. `visible` is the viewer's repositories (null: every
// repository). Callers in repositories the viewer cannot see are dropped and counted in relatedHidden; their
// per-repository rows go too. The prompt block never leaves the server.
export function forViewer<R extends { outsideDiffImpact?: OutsideImpact | null }>(record: R, visible: string[] | null): R {
  const o = record?.outsideDiffImpact;
  if (!o || (!o.relatedCallers?.length && !o.related?.length && o.relatedFormatted === undefined)) return record;
  const { relatedFormatted: _prompt, ...rest } = o;
  if (!visible) return { ...record, outsideDiffImpact: rest };
  const can = new Set(visible);
  const shown = (o.relatedCallers || []).filter((c) => !!c.repo && can.has(c.repo));
  const hidden = (o.related || []).filter((r) => !can.has(r.repo)).reduce((n, r) => n + r.callers, 0);
  return { ...record, outsideDiffImpact: { ...rest, relatedCallers: shown, related: (o.related || []).filter((r) => can.has(r.repo)), relatedHidden: hidden } };
}
// A PR comment's audience is whoever can read the pull request, not CodeOtter's accounts: totals only, no names.
export const relatedCount = (o: OutsideImpact | null | undefined): { usages: number; repos: number } => {
  const hit = (o?.related || []).filter((r) => r.callers > 0);
  return { usages: hit.reduce((n, r) => n + r.callers, 0), repos: hit.length };
};
// </render>
