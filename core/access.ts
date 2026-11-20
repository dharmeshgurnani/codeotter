// Organization scope, account roles, gate() and repository visibility. No HTTP objects: callers pass the session token
// (the pr_auth cookie) and turn a refused gate into a response (core/routes/middleware.ts).
import { OWNER_RE, REPO_RE } from "./config.ts";
import { PB_URL, store } from "./store.ts";
import { forgeUrl, isForgeRepo, repos } from "./git.ts";
import type { Invite, UserRecord } from "./store.ts";

export type Role = "owner" | "admin" | "developer";
// Endpoint access levels for gate(): see allowed().
export type Access = "owner" | "admin" | "review";
export interface UserView { id: string; name: string; email: string; role: Role | ""; avatar: string }
// The signed-in account: its view plus the refreshed PocketBase token.
export interface SessionUser extends UserView { token: string }
// Who is asking: the account (null when signed out) and the effective role ("" when refused).
export interface Viewer { user?: SessionUser | null; role: Role | "" }
export interface Refusal { error: string; login: boolean }
export type GateResult = (Viewer & { user: SessionUser | null; ok: true }) | (Viewer & { user: SessionUser | null; ok: false; refusal: Refusal });

// <scope>
// The ?org= scope of a request, validated.
export function requestOrg(org = "") {
  org = org || "";
  if (org && !OWNER_RE.test(org)) throw new Error("Bad organization");
  return org;
}
export function checkRepoScope(repo: string, org: string) {
  if (!REPO_RE.test(repo) || (isForgeRepo(repo) && !forgeUrl(repo))) throw new Error("Invalid repository");
  if (org && !repo.startsWith(`${org}/`)) throw new Error("Repository is outside the active organization");
}
export async function onboardedRepo(repo = "", org = "") {
  checkRepoScope(String(repo || ""), org);
  if (!(await repos()).includes(repo)) throw new Error("Repository is not onboarded");
}
// </scope>
// Account types. owner: everything. admin: everything except Accounts. developer: Home and the repositories assigned on
// Manage accounts (reviews, open pull requests, running reviews and PR tools); no Settings or Admin pages.
// The first account to sign in becomes owner. After that a sign-in needs an invite: matched by provider + username, or
// for GitHub by the verified primary email PocketBase takes from GitHub; anything else is refused and its account deleted.
// Until any account exists, an anonymous visitor is treated as owner so the instance can be set up (bootstrap).
// <roles>
export const ROLES: readonly Role[] = ["owner", "admin", "developer"];
export const isRole = (x: unknown): x is Role => ROLES.some((r) => r === x);
export const NOT_INVITED = "Not invited: ask an owner for an invite";
export const userView = (rec: UserRecord): UserView => ({ id: rec.id, name: rec.name || rec.username || rec.email?.split("@")[0] || "User", email: rec.email || "", role: rec.role || "", avatar: rec.avatar ? `/api/me/avatar?id=${rec.id}&f=${encodeURIComponent(rec.avatar)}` : "" });
// Role for an account signing in without one: owner while no owner exists; else the matching invite's role (its
// repositories are assigned and the invite is used up); else "" (refused). `providers` are PocketBase provider names.
// Called only from /auth/callback, where `username` is the provider's own login (never the display name, which the user
// controls). Admissions run one at a time so two first sign-ins cannot both become owner or both use one invite.
let admitting: Promise<unknown> = Promise.resolve();
// The same queue serializes every other read-modify-write of "invites" and "access" (repository saves, Manage accounts).
export function accessQueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = admitting.then(fn);
  admitting = run.catch(() => {});
  return run;
}
// Generic OpenID Connect sign-in (enterprise SSO) runs on PocketBase's second OIDC slot: `oidc` is Forgejo's.
export const SSO_PB = "oidc2";
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const isEmailDomain = (d: string) => DOMAIN_RE.test(d);
// An address whose domain is one of the SSO page's "Allowed email domains" (none set: no address is trusted).
export const emailDomainAllowed = (email: string, domains: string[] | undefined) => { const d = String(email || "").toLowerCase().split("@"); return d.length === 2 && !!d[0] && (domains || []).includes(d[1]); };
// The email an SSO identity is trusted with: verified by PocketBase (it keeps an OIDC email only when the IdP says
// email_verified) and by the IdP's own claim, and in an allowed domain, i.e. an address the admin's directory assigns.
export async function ssoEmail(record: UserRecord, rawUser: Record<string, unknown> | undefined): Promise<string> {
  const email = String(record.email || "").toLowerCase();
  const claim = rawUser?.email_verified;
  if (record.verified !== true || !email || (claim !== true && claim !== "true")) return "";
  return emailDomainAllowed(email, (await store.getSetting("sso"))?.domains) ? email : "";
}
// `directoryEmail` is set only for a Microsoft sign-in through a single-tenant app (the caller checks the tenant), or for
// an SSO sign-in with a verified email in an allowed domain (ssoEmail).
export const admit = (record: UserRecord, providers: string[], username = "", directoryEmail = ""): Promise<Role | ""> => accessQueue(() => admitOne(record, providers, username, directoryEmail));
async function admitOne(record: UserRecord, providers: string[], username: string, directoryEmail = ""): Promise<Role | ""> {
  if (record.role) return record.role;
  let role: Role = "owner";
  if ((await store.users()).some((u) => u.role === "owner")) {
    const login = String(username || "").toLowerCase();
    // Email matches GitHub identities (PocketBase keeps GitHub's verified primary email), Microsoft identities from the
    // one configured tenant, and SSO identities in an allowed domain: addresses their admins assign. Other providers
    // may not verify an email.
    const email = record.verified === true && record.email ? String(record.email).toLowerCase() : "";
    const sso = providers.includes(SSO_PB) ? (await store.getSetting("sso")) || {} : null;
    const directory = String(directoryEmail || "").toLowerCase();
    const entra = providers.includes("microsoft") || (sso && emailDomainAllowed(directory, sso.domains)) ? directory : "";
    const emailMatch = (i: Invite) => (i.pb === "github" ? !!email && i.login === email : i.pb === "microsoft" || i.pb === SSO_PB ? !!entra && i.login === entra : false);
    const hit = ((await store.getSetting("invites")) || []).find((i) => providers.includes(i.pb) && (i.login.includes("@") ? emailMatch(i) : !!login && i.login === login));
    // SSO may admit its allowed domains without an invite, as developers with no repositories (off by default).
    if (!hit && !(sso?.autoAdmit && entra)) return "";
    role = hit ? hit.role : "developer";
    if (role === "developer") await store.setSetting("access", { ...((await store.getSetting("access")) || {}), [record.id]: hit?.repos || [] });
    if (hit) await store.setSetting("invites", ((await store.getSetting("invites")) || []).filter((i) => i.id !== hit.id));
  }
  await store.setRole(record.id, role);
  record.role = role;
  return role;
}
// `token` is the pr_auth cookie: the PocketBase user token.
export async function currentUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token || !PB_URL) return null;
  const r = await store.authRefresh(token);
  if (!r) return null;
  // An account gets its role at sign-in (admit in /auth/callback); one without a role was refused and stays out.
  if (!r.record.role) return null;
  return { ...userView(r.record), token: r.token };
}
const hasUsers = async () => (PB_URL ? (await store.users()).length > 0 : false);
// effective role for access checks: the real role; an anonymous visitor counts as owner only while no account exists
// yet (bootstrap) or when the operator sets PR_SCORER_RECOVERY=1 (locked out: restart with it, fix sign-in, unset it).
export const RECOVERY = process.env.PR_SCORER_RECOVERY === "1";
export const effectiveRole = async (user: { role?: Role | "" } | null | undefined): Promise<Role | ""> => user?.role || (RECOVERY || !PB_URL || !(await hasUsers()) ? "owner" : "");
// Access levels: "owner" (owner), "admin" (owner, admin), "review" (any role; developers then pass canSeeRepo per repository).
export const allowed = (role: Role | "", access: Access | string): boolean => (access === "owner" ? role === "owner" : access === "admin" ? role === "owner" || role === "admin" : access === "review" ? isRole(role) : true);
// Gate: every data endpoint needs at least the admin role (owner during bootstrap). A refusal carries the 403 body,
// with login:true when signed out.
export async function gate(token: string | undefined, access: Access = "admin"): Promise<GateResult> {
  const user = await currentUser(token);
  const role = await effectiveRole(user);
  if (allowed(role, access)) return { user, role, ok: true };
  return { user, role, ok: false, refusal: { error: user ? `This needs the ${access} role` : "Sign in to continue", login: !user } };
}
// "Require SSO": while SSO sign-in is on, the other providers are hidden and refused, except in recovery mode
// (PR_SCORER_RECOVERY=1), which is how an owner signs in another way.
export async function ssoRequired(): Promise<boolean> {
  if (RECOVERY || !PB_URL || !(await store.getSetting("sso"))?.require) return false;
  const m = await store.authMethods();
  return !!m.oauth2?.enabled && m.oauth2.providers.some((p) => p.name === SSO_PB);
}
// </roles>
// What a viewer ({ user, role } from gate) may see: owners and admins every repository, a developer only the repositories
// assigned to the account (settings key "access": user id -> repository ids). Every developer-reachable endpoint uses these.
// <visibility>
export const seesAll = (g: Viewer) => g.role === "owner" || g.role === "admin";
const forbidden = (msg: string) => Object.assign(new Error(msg), { status: 403 });
export async function visibleRepos(g: Viewer): Promise<string[]> {
  const rs = await repos();
  if (seesAll(g)) return rs;
  if (g.role !== "developer" || !g.user) return [];
  const mine = ((await store.getSetting("access")) || {})[g.user.id] || [];
  return rs.filter((r) => mine.includes(r));
}
const canSeeRepo = async (g: Viewer, repo: string) => seesAll(g) || (await visibleRepos(g)).includes(repo);
export async function assertRepo(g: Viewer, repo: string) {
  if (!(await canSeeRepo(g, repo))) throw forbidden("Repository is not assigned to your account");
}
// Link previews (og image, page meta) are public as before; a signed-in developer gets none for an unassigned repository.
export async function developerBlocked(token: string | undefined, repo: string) {
  const user = await currentUser(token);
  return user?.role === "developer" && !(await canSeeRepo({ user, role: user.role }, repo));
}
// </visibility>
