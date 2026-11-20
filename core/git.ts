// Repository ids, pull request URLs, the gh CLI and the GitHub App; other providers route to forges.ts.
import { execFileSync, spawn } from "node:child_process";
import { createSign } from "node:crypto";
import { FORGE_API, FORGE_IDS, FORGES, OWNER_RE, REPO, REPO_RE } from "./config.ts";
import { PB_URL, store } from "./store.ts";
import type { ApiOptions, PullRequest } from "./forges.ts";

// A pull request URL's repository and number; selfHosted: a git server other than github.com.
export interface ParsedPr { repo: string; number: number; selfHosted: boolean }
// The GitHub App saved under Settings (settings key `githubApp`).
export interface GitHubAppConfig { id?: string | number; pem?: string; owner?: string }
interface GhRepo { full_name?: string } // GitHub REST repository (the one field read)

// GitHub CLI, always async: a synchronous gh call would stall every other request and poll loop for a network round trip.
// stderr is captured so "gh auth login" / "Not Found" reach the UI instead of the terminal.
export const ghAsync = (...rawArgs: string[] | [string[]]): Promise<string> => runGh(Array.isArray(rawArgs[0]) ? rawArgs[0] : (rawArgs as string[]), ghEnv());
// gh for a write on a GitHub repository: as the GitHub App bot when the app is installed on the repository's owner,
// else as the operator (saved token or gh login).
export const ghAsApp = async (repo: string, ...rawArgs: string[] | [string[]]): Promise<string> => {
  const token = await appInstallationToken(repo).catch((e: Error) => { console.warn(`[github-app] ${repo}: ${e.message}`); return ""; });
  return runGh(Array.isArray(rawArgs[0]) ? rawArgs[0] : (rawArgs as string[]), token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : ghEnv());
};
function runGh(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    // Two minutes covers a slow diff; a hung gh (proxy, credential helper) would otherwise pin the poll loops forever.
    // Own timer rather than spawn's timeout option: Node leaves that one armed when the binary is missing.
    const p = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { p.kill("SIGKILL"); } catch {} }, 120000);
    timer.unref?.();
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${e.code === "ENOENT" ? "GitHub CLI (gh) not found on PATH" : e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else if (timedOut) reject(new Error(`gh ${args.slice(0, 2).join(" ")}: timed out after 120 s`));
      else reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${String(err).trim().split("\n")[0] || "failed"}`));
    });
  });
}
// <pr-url>
const FORGE_PREFIX = /^(forgejo|gitea|bitbucket|bitbucketdc|azure)~/;
export const forgeId = (repo: string) => FORGE_PREFIX.exec(String(repo))?.[1] || "";
export const isForgeRepo = (repo: string) => !!forgeId(repo);
export const nativeRepo = (repo: string) => String(repo).replace(FORGE_PREFIX, "");
export const forgeOf = (repo: string) => FORGE_API[forgeId(repo)];
export const repoLabel = (repo: string) => isForgeRepo(repo) ? `${nativeRepo(repo)} · ${FORGES[forgeId(repo)].label}` : repo;
export const forgeUrl = (repo: string) => isForgeRepo(repo) ? FORGES[forgeId(repo)].url : "https://github.com";
export const prUrlFor = (repo: string, number: number) => isForgeRepo(repo) ? forgeOf(repo).prUrl(repo, number) : `https://github.com/${repo}/pull/${number}`;
// A pull request's web URL is its identity: it maps back to exactly one repository id and number, or to nothing.
export function parsePrUrl(value: string): ParsedPr | null {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || value !== `${u.origin}${u.pathname}`) return null;
    const source = FORGE_IDS.find((id) => FORGES[id].url && u.origin === FORGES[id].url);
    if (!source && u.origin !== "https://github.com") return null;
    if (!source) {
      const m = u.pathname.match(/^\/([\w][\w.-]*\/[\w][\w.-]*)\/pull\/([1-9]\d*)$/);
      return m ? { repo: m[1], number: Number(m[2]), selfHosted: false } : null;
    }
    const hit = FORGE_API[source].parsePr(u);
    const repo = hit && `${source}~${hit.native}`;
    return hit && repo && REPO_RE.test(repo) ? { repo, number: hit.number, selfHosted: true } : null;
  } catch { return null; }
}
export const validPrUrl = (value: string) => !!parsePrUrl(value);
// A pasted repository: an id, owner/name (under the active organization's provider), or the repository's web URL.
export function cleanRepo(value: string, org = ""): string {
  const s = String(value).trim().replace(/\/+$/, "");
  for (const [id, f] of Object.entries(FORGES)) {
    if (f.url && s.startsWith(`${f.url}/`)) {
      const n = FORGE_API[id].parseRepo(s.slice(f.url.length + 1));
      return n ? `${id}~${n}` : s;
    }
  }
  if (isForgeRepo(org) && !isForgeRepo(s) && REPO_RE.test(`${forgeId(org)}~${s}`)) return `${forgeId(org)}~${s}`;
  // a name under the active organization: "shop" for owner/shop, "Project/repo" for an Azure DevOps organization
  if (isForgeRepo(org) && !isForgeRepo(s) && REPO_RE.test(`${org}/${s}`)) return `${org}/${s}`;
  return s.replace(/^https:\/\/github\.com\//, "");
}

// </pr-url>
// Only operator-configured origins receive the token. Never follow upstream redirects (forges.ts).
// Kept for the Forgejo/Gitea-only calls (OAuth app creation): `source` is the provider id.
export const forgeApi = (path: string, { source, ...opts }: ApiOptions & { source?: string } = {}) => FORGE_API[source || forgeId(path.replace(/^repos\//, ""))].api(path.replace(/^repos\/[a-z]+~/, "repos/"), opts);
export const normalizeForgePr = (p: unknown, repo: string): PullRequest => forgeOf(repo).normalize(p, repo);

export async function readPr(url: string, spec: string[], diff = false): Promise<string> {
  const parsed = parsePrUrl(url);
  if (!parsed) throw new Error("Invalid pull request URL");
  if (!parsed.selfHosted) return ghAsync("pr", diff ? "diff" : "view", ...spec, ...(diff ? [] : ["--json", "number,title,body,author,url,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,files,commits,state"]));
  const { repo, number } = parsed;
  const forge = forgeOf(repo);
  return diff ? forge.diff(repo, number) : JSON.stringify(await forge.pr(repo, number));
}

export const createPrComment = (url: string, repo: string, number: number, body: string): Promise<unknown> => isForgeRepo(repo)
  ? forgeOf(repo).comment(repo, number, body)
  : ghAsApp(repo, "pr", "comment", url, "--body", body);

function base64url(input: string | Buffer) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function createGitHubAppJwt(appId: string | number, pem: string): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: String(appId),
    }),
  );
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  sign.end();
  const signature = base64url(sign.sign(pem));
  return `${header}.${payload}.${signature}`;
}

// Installation access tokens: the installation is looked up per repository owner and its token cached until five
// minutes before it expires. A repository the app is not installed on is remembered for ten minutes and written as the
// operator. Writes go out as the bot only when an app with its private key is stored (Create app saves both).
const APP_TOKEN_MARGIN = 5 * 60_000;
const APP_MISS_TTL = 10 * 60_000;
let appTokenKey = "";
const appInstallations = new Map<string, number>(); // lower-case owner -> installation id
const appTokens = new Map<number, { token: string; expires: number }>(); // installation id -> token
const appMisses = new Map<string, number>(); // repository -> retry after (ms)
export function forgetAppTokens(): void {
  appInstallations.clear();
  appTokens.clear();
  appMisses.clear();
}
const appHeaders = (bearer: string) => ({ authorization: `Bearer ${bearer}`, accept: "application/vnd.github+json", "user-agent": "CodeOtter", "x-github-api-version": "2022-11-28" });
export const appPostingActive = (app: GitHubAppConfig | null | undefined): boolean => !!(app?.id && app.pem);
export async function appInstallationToken(repo: string): Promise<string> {
  if (isForgeRepo(repo) || !repo.includes("/") || !REPO_RE.test(repo)) return "";
  const app = (await store.getSetting("githubApp")) as GitHubAppConfig | null | undefined;
  if (!app?.id || !app.pem) return "";
  const key = `${app.id}:${app.pem.length}:${app.pem.slice(-64)}`; // a new or replaced app starts a fresh cache
  if (key !== appTokenKey) { forgetAppTokens(); appTokenKey = key; }
  const now = Date.now();
  if ((appMisses.get(repo) || 0) > now) return "";
  const owner = repo.split("/")[0].toLowerCase();
  let installation = appInstallations.get(owner);
  const cached = installation ? appTokens.get(installation) : undefined;
  if (cached && cached.expires - APP_TOKEN_MARGIN > now) return cached.token;
  const jwt = createGitHubAppJwt(app.id, app.pem);
  if (!installation) {
    const res = await fetch(`https://api.github.com/repos/${repo}/installation`, { headers: appHeaders(jwt), redirect: "error", signal: AbortSignal.timeout(10000) });
    if (res.status === 404) { appMisses.set(repo, now + APP_MISS_TTL); return ""; }
    if (!res.ok) throw new Error(`installation lookup answered ${res.status}`);
    const body: unknown = await res.json();
    const id = body && typeof body === "object" && "id" in body ? body.id : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("installation lookup returned no id");
    installation = id;
    appInstallations.set(owner, id);
  }
  const res = await fetch(`https://api.github.com/app/installations/${installation}/access_tokens`, { method: "POST", headers: appHeaders(jwt), redirect: "error", signal: AbortSignal.timeout(10000) });
  if (res.status === 404) { appInstallations.delete(owner); appMisses.set(repo, now + APP_MISS_TTL); return ""; } // uninstalled since
  if (!res.ok) throw new Error(`installation token answered ${res.status}`);
  const data: unknown = await res.json();
  const field = (k: string): unknown => (data && typeof data === "object" && k in data ? (data as Record<string, unknown>)[k] : undefined);
  const token = field("token");
  if (typeof token !== "string" || !token) throw new Error("installation token missing from GitHub's reply");
  const expiresAt = field("expires_at");
  const expires = (typeof expiresAt === "string" && Date.parse(expiresAt)) || now + 60 * 60_000;
  appTokens.set(installation, { token, expires });
  return token;
}

async function getGitHubAppRepos(appConfig: GitHubAppConfig | null | undefined): Promise<string[]> {
  if (!appConfig?.id || !appConfig?.pem) return [];
  try {
    const jwt = createGitHubAppJwt(appConfig.id, appConfig.pem);
    const instRes = await fetch("https://api.github.com/app/installations?per_page=100", {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "CodeOtter",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!instRes.ok) return [];
    const installations: unknown = await instRes.json();
    if (!Array.isArray(installations)) return [];

    const repoNames: string[] = [];
    for (const inst of installations as { id: number }[]) {
      const tokenRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "user-agent": "CodeOtter",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!tokenRes.ok) continue;
      const tokenData = (await tokenRes.json()) as { token?: string };
      const instToken = tokenData.token;
      if (!instToken) continue;

      let page = 1;
      while (page <= 10) {
        const reposRes = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
          headers: {
            authorization: `Bearer ${instToken}`,
            accept: "application/vnd.github+json",
            "user-agent": "CodeOtter",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!reposRes.ok) break;
        const reposData = (await reposRes.json()) as { repositories?: { full_name?: string }[] };
        const batch = Array.isArray(reposData.repositories) ? reposData.repositories : [];
        if (!batch.length) break;
        for (const r of batch) {
          if (r.full_name) repoNames.push(r.full_name);
        }
        if (batch.length < 100) break;
        page++;
      }
    }
    return repoNames;
  } catch {
    return [];
  }
}

// Onboarded repositories. Saved from the Repositories settings page; falls back to REPO (env or the repo launched from).
export const repos = async (): Promise<string[]> => {
  const saved = await store.getSetting("repos");
  return Array.isArray(saved) ? (saved as string[]) : REPO ? [REPO] : [];
};
let ghReposCache: Map<string, string[]> | null | undefined;
export const forgetGithubRepos = () => { ghReposCache = null; };
// A GitHub token saved in the app (Settings / Git providers, or onboarding) goes to gh calls only, as GH_TOKEN in that
// child's environment, and takes precedence over one from the server's environment; without one, gh uses its own login.
// It is never written to process.env, so model sidecars, pip and other children do not inherit it.
let savedGithubToken = "";
export const ghEnv = (): NodeJS.ProcessEnv => (savedGithubToken ? { ...process.env, GH_TOKEN: savedGithubToken, GITHUB_TOKEN: savedGithubToken } : process.env);
export function applyGithubToken(token: string | null | undefined): void {
  savedGithubToken = token || "";
  ghReposCache = null;
}
export async function repositoryChoices(owner = ""): Promise<string[]> {
  if (owner && !OWNER_RE.test(owner)) return [];
  if (isForgeRepo(owner)) return (await forgeOf(owner).listRepos()).filter((r) => REPO_RE.test(r) && r.startsWith(`${owner}/`));

  let savedGhToken = savedGithubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!savedGhToken) {
    try {
      savedGhToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    } catch {}
  }

  const githubApp = (await store.getSetting("githubApp")) as GitHubAppConfig | null | undefined;
  const githubOwner = ((await store.getSetting("githubOwner")) || "") as string;

  ghReposCache ||= new Map();
  if (!ghReposCache.has(owner)) {
    const listSet = new Set<string>();

    // 1. Try GitHub App installation repositories (public & private)
    if (githubApp?.id && githubApp?.pem) {
      try {
        const appRepos = await getGitHubAppRepos(githubApp);
        for (const r of appRepos) {
          if (!owner || r.startsWith(`${owner}/`)) listSet.add(r);
        }
      } catch {}
    }

    // 2. Try User Personal Access Token / env token (public & private across all user affiliations)
    if (savedGhToken) {
      try {
        let page = 1;
        while (page <= 10) {
          const ghUrl = `https://api.github.com/user/repos?per_page=100&page=${page}&visibility=all&affiliation=owner,collaborator,organization_member&sort=updated`;
          const res = await fetch(ghUrl, {
            headers: {
              authorization: `Bearer ${savedGhToken}`,
              accept: "application/vnd.github+json",
              "user-agent": "CodeOtter",
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) break;
          const items: unknown = await res.json();
          if (!Array.isArray(items) || !items.length) break;
          for (const r of items as GhRepo[]) {
            if (r.full_name && (!owner || r.full_name.startsWith(`${owner}/`))) {
              listSet.add(r.full_name);
            }
          }
          if (items.length < 100) break;
          page++;
        }
      } catch {}

      // Query user's organizations
      try {
        const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", {
          headers: {
            authorization: `Bearer ${savedGhToken}`,
            accept: "application/vnd.github+json",
            "user-agent": "CodeOtter",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (orgsRes.ok) {
          const orgs: unknown = await orgsRes.json();
          if (Array.isArray(orgs)) {
            for (const org of orgs as { login?: string }[]) {
              if (org.login) {
                let page = 1;
                while (page <= 5) {
                  const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org.login)}/repos?per_page=100&page=${page}&type=all&sort=updated`, {
                    headers: {
                      authorization: `Bearer ${savedGhToken}`,
                      accept: "application/vnd.github+json",
                      "user-agent": "CodeOtter",
                    },
                    signal: AbortSignal.timeout(8000),
                  });
                  if (!res.ok) break;
                  const items: unknown = await res.json();
                  if (!Array.isArray(items) || !items.length) break;
                  for (const r of items as GhRepo[]) {
                    if (r.full_name && (!owner || r.full_name.startsWith(`${owner}/`))) {
                      listSet.add(r.full_name);
                    }
                  }
                  if (items.length < 100) break;
                  page++;
                }
              }
            }
          }
        }
      } catch {}
    }

    // 3. Try GitHub Owner public/org endpoints
    const ownersToTry = new Set([
      owner,
      githubOwner,
      githubApp?.owner,
      REPO ? REPO.split("/")[0] : "",
      "dharmeshgurnani",
    ].filter(Boolean));

    if (PB_URL) {
      try {
        const users = await store.users();
        for (const u of users) {
          if (u.username && OWNER_RE.test(u.username)) ownersToTry.add(u.username);
          const namePart = u.name?.trim().split(/\s+/)[0];
          if (namePart && OWNER_RE.test(namePart)) ownersToTry.add(namePart);
        }
      } catch {}
    }
    for (const o of ownersToTry) {
      for (const ep of ["users", "orgs"]) {
        try {
          const res = await fetch(`https://api.github.com/${ep}/${o}/repos?per_page=100&sort=updated`, {
            headers: {
              ...(savedGhToken ? { authorization: `Bearer ${savedGhToken}` } : {}),
              accept: "application/vnd.github+json",
              "user-agent": "CodeOtter",
            },
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            const items: unknown = await res.json();
            if (Array.isArray(items)) {
              for (const r of items as GhRepo[]) {
                if (r.full_name && (!owner || r.full_name.startsWith(`${owner}/`))) {
                  listSet.add(r.full_name);
                }
              }
            }
          }
        } catch {}
      }
    }

    // 4. Try gh CLI
    if (!listSet.size) {
      try {
        const ghItems: unknown = JSON.parse(await ghAsync("repo", "list", ...(owner ? [owner] : []), "--limit", "100", "--json", "nameWithOwner"));
        if (Array.isArray(ghItems)) {
          for (const r of ghItems as { nameWithOwner?: string }[]) {
            if (r.nameWithOwner) listSet.add(r.nameWithOwner);
          }
        }
      } catch {}
    }

    ghReposCache.set(owner, [...listSet]);
  }
  const github = ghReposCache.get(owner) || [];
  const allChoices = new Set(github);
  if (REPO && (!owner || REPO.startsWith(`${owner}/`))) allChoices.add(REPO);
  const currentSaved: unknown = await store.getSetting("repos");
  if (Array.isArray(currentSaved)) {
    for (const r of currentSaved as string[]) if (!owner || r.startsWith(`${owner}/`)) allChoices.add(r);
  }

  if (!owner) {
    // one provider that cannot list its repositories must not hide the others'
    const remote = await Promise.all(FORGE_IDS.filter((id) => FORGES[id].url && FORGES[id].token).map(async (id) =>
      (await FORGE_API[id].listRepos().catch((e) => { console.warn(`[repos] ${FORGES[id].label}: ${e.message}`); return []; })).filter((r) => REPO_RE.test(r))));
    for (const r of remote.flat()) allChoices.add(r);
  }
  return [...allChoices];
}

// Open pull requests. Pages render an empty list when GitHub cannot be reached; the poll passes { strict } and gets the error.
// (an options object, not a flag: callers also use repos.map(openPrs), whose index must not turn strict on)
export async function openPrs(repo: string, { strict = false } = {}): Promise<PullRequest[]> {
  // a git server's error (bad token, server down) reaches the page instead of looking like "no pull requests"
  if (isForgeRepo(repo)) return forgeOf(repo).openPrs(repo);
  try {
    return JSON.parse(await ghAsync("pr", "list", "-R", repo, "--json", "number,title,author,url,updatedAt,additions,deletions,changedFiles,headRefOid,isDraft,labels", "--limit", "200"));
  } catch (e) {
    if (strict) throw e;
    return [];
  }
}
