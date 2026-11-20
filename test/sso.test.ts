// Enterprise SSO (generic OpenID Connect on PocketBase's oidc2 slot). The first half runs the real <roles> block with
// stubs: who admit() lets in through SSO. The second imports the settings pages and the HTTP app in a temp CODEOTTER_HOME
// against an in-memory PocketBase behind a stubbed fetch: the Auth providers row, its save, invites and the login page.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { serverBlocks } from "./helpers/server-blocks.ts";

type Account = { id: string; role: string; email?: string; verified?: boolean };
type Invite = { id: string; provider: string; pb: string; login: string; role: string; repos: string[] };
type Roles = {
  admit: (record: Account, providers: string[], username?: string, directoryEmail?: string) => Promise<string>;
  ssoEmail: (record: Account, rawUser?: Record<string, unknown>) => Promise<string>;
};
type Field = { key: string; type: string };
type Row = { id: string; label: string; toggle?: boolean; toggleDisabled?: boolean; cells: Record<string, { text?: string }>; settings: { fields: Field[]; values: Record<string, unknown> } };
type OAuthPage = { sections: { id: string; fields: { key: string; type: string; columns?: { key: string }[] }[] }[]; values: { signin: { rows: Row[] } } };
type Provider = { name: string; clientId?: string; clientSecret?: string; displayName?: string; authURL?: string; tokenURL?: string; userInfoURL?: string; pkce?: boolean; extra?: { jwksURL?: string; issuers?: string[] } };

test("sso: OpenID Connect sign-in, domain-gated email invites, auto-admit and Require SSO", async (ctx) => {

// ---- admit() through SSO, with stubs ----
const load = ({ invites = [], sso = null }: { invites?: Invite[]; sso?: Record<string, unknown> | null } = {}) => {
  const users: Account[] = [{ id: "o", role: "owner" }];
  const settings: Record<string, unknown> = { invites, access: {}, sso };
  const store = {
    users: async () => users,
    setRole: async (id: string, role: string) => { users.push({ id, role }); },
    getSetting: async (k: string) => settings[k] ?? null,
    setSetting: async (k: string, v: unknown) => { settings[k] = v; },
  };
  const out = new Function("PB_URL", "store", `${serverBlocks("roles")}; return { admit, ssoEmail };`)("http://pb", store) as Roles;
  return { ...out, settings };
};
const invite: Invite = { id: "i1", provider: "sso", pb: "oidc2", login: "alice@acme.com", role: "developer", repos: ["acme/api"] };
const alice = { id: "a1", role: "", email: "Alice@Acme.com", verified: true };
const claims = { email_verified: true };

{
  const t = load({ invites: [invite] });
  const email = await t.ssoEmail(alice, claims);
  assert.equal(email, "", "no allowed domains: no SSO email is trusted");
  assert.equal(await t.admit({ ...alice }, ["oidc2"], "alice", email), "");
  assert.equal(await t.admit({ ...alice }, ["oidc2"], "alice", "alice@acme.com"), "", "admit re-checks the domain itself");
  assert.equal((t.settings.invites as Invite[]).length, 1, "the invite stays");
}
ctx.diagnostic("email matching needs Allowed email domains to be set");

{
  const t = load({ invites: [invite], sso: { domains: ["acme.com"] } });
  assert.equal(await t.ssoEmail({ ...alice, verified: false }, claims), "", "PocketBase did not verify the email");
  assert.equal(await t.ssoEmail(alice, { email_verified: false }), "", "the IdP says unverified");
  assert.equal(await t.ssoEmail(alice, {}), "", "no email_verified claim");
  assert.equal(await t.ssoEmail({ ...alice, email: "alice@evil.com" }, claims), "", "outside the allowed domains");
  assert.equal(await t.ssoEmail({ ...alice, email: "alice@sub.acme.com" }, claims), "", "subdomains are not the domain");
  assert.equal(await t.ssoEmail(alice, { email_verified: "true" }), "alice@acme.com", "string claim (some IdPs)");
  assert.equal(await t.admit({ ...alice }, ["github"], "alice", "alice@acme.com"), "", "an SSO invite never matches another provider");
  assert.equal(await t.admit({ id: "e1", role: "" }, ["oidc2"], "alice@acme.com", ""), "", "the IdP username never matches an email invite");
  assert.equal(await t.admit({ ...alice }, ["oidc2"], "alice", await t.ssoEmail(alice, claims)), "developer");
  assert.deepEqual(t.settings.invites, [], "the invite is used up");
  assert.deepEqual(t.settings.access, { a1: ["acme/api"] });
}
ctx.diagnostic("verified, allowed-domain SSO email matches its invite; unverified or foreign-domain email is refused");

{
  const off = load({ sso: { domains: ["acme.com"] } });
  assert.equal(await off.admit({ ...alice }, ["oidc2"], "alice", "alice@acme.com"), "", "auto-admit is off by default");
  const on = load({ sso: { domains: ["acme.com"], autoAdmit: true } });
  assert.equal(await on.admit({ ...alice }, ["oidc2"], "alice", "alice@evil.com"), "", "auto-admit stays inside the domains");
  assert.equal(await on.admit({ ...alice }, ["oidc2"], "alice", ""), "", "auto-admit needs a trusted email");
  assert.equal(await on.admit({ ...alice }, ["github"], "alice", "alice@acme.com"), "", "auto-admit is SSO only");
  assert.equal(await on.admit({ ...alice }, ["oidc2"], "alice", "alice@acme.com"), "developer");
  assert.deepEqual(on.settings.access, { a1: [] }, "auto-admitted developers start with no repositories");
  const admin = load({ invites: [{ ...invite, role: "admin" }], sso: { domains: ["acme.com"], autoAdmit: true } });
  assert.equal(await admin.admit({ ...alice }, ["oidc2"], "alice", "alice@acme.com"), "admin", "an invite wins over auto-admit");
}
ctx.diagnostic("auto-admit is off by default, SSO-only and limited to the allowed domains");

{
  const t = load({ invites: [{ ...invite, provider: "azure", pb: "microsoft", login: "bob@contoso.com" }] });
  assert.equal(await t.admit({ id: "b1", role: "" }, ["microsoft"], "", "bob@contoso.com"), "developer", "Microsoft email invites are unchanged");
}
ctx.diagnostic("Microsoft directory-email invites still match");

// ---- Settings page, save, invites and the login page against a fake PocketBase ----
const home = mkdtempSync(join(tmpdir(), "codeotter-sso-"));
Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), REPO: "acme/api", CODEOTTER_UPDATE_CHECK: "0", PB_URL: "http://pb.test" });
delete process.env.PR_SCORER_RECOVERY;
const PB = "http://pb.test/api/";
const ISSUER = "https://idp.acme.test";
const db = {
  oauth: { enabled: true, providers: [{ name: "github", clientId: "gh" }, { name: "oidc", clientId: "forgejo-app", authURL: "https://git.acme.test/login/oauth/authorize" }] as Provider[] },
  settings: { repos: ["acme/api"], onboardingComplete: true } as Record<string, unknown>,
  identities: [] as { provider: string; recordRef: string }[],
  discovery: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth2/v1/authorize`, token_endpoint: `${ISSUER}/oauth2/v1/token`, userinfo_endpoint: `${ISSUER}/oauth2/v1/userinfo`, jwks_uri: `${ISSUER}/oauth2/v1/keys` } as Record<string, unknown>,
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method || "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const send = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return send(db.discovery);
  if (!url.startsWith(PB)) throw new Error(`network blocked in test: ${url}`);
  const u = new URL(url);
  const path = u.pathname.replace(/^\/api\//, "");
  const filter = /^(\w+)="(.*)"$/.exec(u.searchParams.get("filter") || "");
  if (path === "collections/_superusers/auth-with-password") return send({ token: "su" });
  if (path === "collections/users" && method === "GET") return send({ oauth2: db.oauth });
  if (path === "collections/users" && method === "PATCH") { db.oauth = body.oauth2; return send({}); }
  if (path === "collections/users/auth-methods") return send({ oauth2: { enabled: db.oauth.enabled, providers: db.oauth.providers.map((p) => ({ name: p.name, displayName: p.displayName, state: "st", codeVerifier: "cv", authURL: `${p.authURL}?redirect_uri=` })) } });
  if (path === "collections/users/records") return send({ items: [{ id: "o", role: "owner" }], totalPages: 1 });
  if (path === "collections/_externalAuths/records") return send({ items: db.identities.filter((i) => !filter || i[filter[1] as "provider"] === filter[2]), totalPages: 1 });
  if (path === "collections/settings/records" && method === "GET") return send({ items: filter && filter[2] in db.settings ? [{ id: filter[2], key: filter[2], value: db.settings[filter[2]] }] : [] });
  if (path.startsWith("collections/settings/records")) { db.settings[String(body.key)] = body.value; return send({}); }
  return send({ message: `fake pb: ${method} ${path}` }, 404);
};
ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

const { SETTINGS_PAGES } = await import("../core/settings-pages.ts");
const { app } = await import("../core/app.ts");
const oauthPage = SETTINGS_PAGES.oauth;
const ssoRow = async () => ((await oauthPage.load()) as unknown as OAuthPage).values.signin.rows.find((r) => r.id === "sso");
const save = (values: Record<string, unknown>, toggle = true) => oauthPage.save({ signin: { rows: [{ id: "sso", edited: true, toggle, settings: { values } }] } });
const okta = { issuer: `${ISSUER}/`, displayName: "Acme Okta", clientId: "cid", clientSecret: "sec", domains: "@Acme.com, acme.io", autoAdmit: false, require: false };

{
  const page = (await oauthPage.load()) as unknown as OAuthPage;
  const table = page.sections.find((s) => s.id === "signin")?.fields[0];
  assert.deepEqual(table?.columns?.map((c) => c.key), ["provider", "server", "status"], "Provider · Server · Status");
  const row = page.values.signin.rows.find((r) => r.id === "sso");
  assert.ok(row, "an SSO row");
  assert.equal(row.label, "OpenID Connect (SSO)");
  assert.equal(row.toggle, false);
  assert.equal(row.toggleDisabled, undefined, "the issuer is set in the row's own dialog");
  assert.deepEqual(row.settings.fields.map((f) => [f.key, f.type]), [["issuer", "text"], ["displayName", "text"], ["clientId", "text"], ["clientSecret", "password"], ["domains", "text"], ["autoAdmit", "checkbox"], ["require", "checkbox"], ["callback", "readonly"]]);
  assert.equal(row.settings.values.autoAdmit, false, "auto-admit is off by default");
  assert.equal(row.settings.values.require, false);
  assert.equal(row.settings.values.domains, "");
}
ctx.diagnostic("Auth providers has an OIDC (SSO) row with issuer, client, display name, domains, auto-admit and Require SSO");

{
  await assert.rejects(save({ ...okta, domains: "acme" }), /Not an email domain: acme/);
  await assert.rejects(save({ ...okta, issuer: "http://idp.acme.test" }), /https/);
  db.discovery.issuer = "https://elsewhere.test";
  await assert.rejects(save(okta), /names issuer https:\/\/elsewhere\.test/);
  db.discovery.issuer = ISSUER;
  assert.equal(db.oauth.providers.some((p) => p.name === "oidc2"), false, "a failed save changes nothing");
  await save(okta);
  const p = db.oauth.providers.find((x) => x.name === "oidc2");
  assert.deepEqual(p, { name: "oidc2", clientId: "cid", clientSecret: "sec", displayName: "Acme Okta", pkce: true, authURL: `${ISSUER}/oauth2/v1/authorize`, tokenURL: `${ISSUER}/oauth2/v1/token`, userInfoURL: `${ISSUER}/oauth2/v1/userinfo`, extra: { jwksURL: `${ISSUER}/oauth2/v1/keys`, issuers: [ISSUER] } });
  assert.deepEqual(db.oauth.providers.find((x) => x.name === "oidc"), { name: "oidc", clientId: "forgejo-app", authURL: "https://git.acme.test/login/oauth/authorize" }, "Forgejo's oidc slot is untouched");
  assert.deepEqual(db.settings.sso, { issuer: ISSUER, domains: ["acme.com", "acme.io"], autoAdmit: false, require: false });
  const row = await ssoRow();
  assert.equal(row?.label, "Acme Okta (SSO)");
  assert.equal(row?.toggle, true);
  assert.equal(row?.cells.server.text, "idp.acme.test");
  assert.equal(row?.settings.values.clientSecret, "", "the secret is never sent back");
}
ctx.diagnostic("saving discovers the endpoints, checks the issuer and fills PocketBase's oidc2 slot beside Forgejo's oidc");

{
  // accounts signed in through the old issuer: switching to ISSUER is refused
  db.identities.push({ provider: "oidc2", recordRef: "u1" });
  db.settings.sso = { ...(db.settings.sso as object), issuer: "https://old.acme.test" };
  await assert.rejects(save({ ...okta, clientSecret: "" }), /Cannot change the SSO issuer while accounts are linked/);
  db.settings.sso = { ...(db.settings.sso as object), issuer: ISSUER };
  db.identities = [];
}
ctx.diagnostic("the issuer cannot change while accounts are linked to it");

{
  const invite = (login: string) => SETTINGS_PAGES.accounts.save({ invite: { login, provider: "sso", role: "developer" } });
  await assert.rejects(invite("bob"), /SSO invites match by email address/);
  await assert.rejects(invite("bob@evil.com"), /allowed domain/);
  await invite("Bob@Acme.com");
  assert.deepEqual((db.settings.invites as Invite[]).map((i) => [i.pb, i.login]), [["oidc2", "bob@acme.com"]]);
}
ctx.diagnostic("SSO invites are emails in an allowed domain");

{
  const login = async () => (await (await app.request("/api/login")).json()) as { providers: { id: string; label: string }[] };
  assert.deepEqual((await login()).providers, [{ id: "github", label: "GitHub" }, { id: "forgejo", label: "Forgejo" }, { id: "sso", label: "Acme Okta" }], "the SSO button carries the display name");
  await save({ ...okta, clientSecret: "", require: true });
  assert.equal((db.settings.sso as { require: boolean }).require, true);
  assert.deepEqual((await login()).providers, [{ id: "sso", label: "Acme Okta" }], "Require SSO hides the others");
  const gh = await app.request("/api/auth/start?provider=github");
  assert.equal(gh.status, 500);
  assert.deepEqual(await gh.json(), { error: "Sign in with SSO" });
  const start = await app.request("/api/auth/start?provider=sso");
  assert.equal(start.status, 200);
  assert.match(((await start.json()) as { url: string }).url, /^https:\/\/idp\.acme\.test\/oauth2\/v1\/authorize\?redirect_uri=/);
  await save({}, false);
  assert.equal(db.oauth.providers.some((p) => p.name === "oidc2"), false, "turning SSO off removes its client");
  assert.deepEqual(db.settings.sso, { issuer: ISSUER, domains: ["acme.com", "acme.io"], autoAdmit: false, require: false }, "and Require SSO with it");
  assert.deepEqual((await login()).providers.map((p) => p.id), ["github", "forgejo"]);
}
ctx.diagnostic("the login page shows the SSO button; Require SSO hides and refuses the other providers");
});
