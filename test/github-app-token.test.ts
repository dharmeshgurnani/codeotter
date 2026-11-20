// The GitHub App's installation tokens, one cache for two uses: posting as the app bot (per repository, falling back to
// the operator's credential) and gh calls on an install whose only GitHub credential is the App (per owner the call
// names, never guessed between installations). A temp CODEOTTER_HOME with file storage and a stubbed fetch.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("GitHub App installation tokens", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-app-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, CODEOTTER_UPDATE_CHECK: "0" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  ctx.after(() => { globalThis.fetch = realFetch; Date.now = realNow; rmSync(home, { recursive: true, force: true }); });

  const { createGitHubAppJwt, appInstallationToken, appPostingActive, ghOwnerOf, forgetGithubRepos } = await import("../core/git.ts");
  const { store } = await import("../core/store.ts");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  {
    const jwt = createGitHubAppJwt(4242, pem);
    const [h, p, sig] = jwt.split(".");
    const decode = (s: string): unknown => JSON.parse(Buffer.from(s, "base64url").toString());
    assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
    const claims = decode(p) as { iss: string; iat: number; exp: number };
    const now = Math.floor(Date.now() / 1000);
    assert.equal(claims.iss, "4242");
    assert.ok(claims.iat <= now - 30 && claims.exp > now && claims.exp - claims.iat <= 660, "backdated iat, at most ten minutes ahead");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    assert.ok(v.verify(publicKey, Buffer.from(sig, "base64url")), "RS256 signature verifies with the app's public key");
  }
  ctx.diagnostic("app JWT is RS256 over iss/iat/exp");

  const calls: { url: string; method: string; auth: string; redirect?: string }[] = [];
  let expiresIn = 60 * 60_000;
  let tokenN = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const auth = String((init.headers as Record<string, string>).authorization || "");
    calls.push({ url, method: init.method || "GET", auth, redirect: init.redirect });
    assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "app endpoints get the JWT");
    if (url === "https://api.github.com/repos/acme/shop/installation" || url === "https://api.github.com/repos/acme/api/installation") return Response.json({ id: 77 });
    if (url === "https://api.github.com/repos/other/repo/installation") return new Response("{}", { status: 404 });
    if (url === "https://api.github.com/repos/broken/repo/installation") return new Response("{}", { status: 500 });
    if (url === "https://api.github.com/app/installations/77/access_tokens" && init.method === "POST") {
      tokenN++;
      return Response.json({ token: `ghs_token${tokenN}`, expires_at: new Date(Date.now() + expiresIn).toISOString() });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  assert.equal(appPostingActive(await store.getSetting("githubApp")), false);
  assert.equal(await appInstallationToken("acme/shop"), "", "no app: the operator's login is used");
  await store.setSetting("githubApp", { id: 4242, slug: "codeotter-acme" });
  assert.equal(await appInstallationToken("acme/shop"), "", "an app without its private key cannot post");
  assert.equal(calls.length, 0);
  ctx.diagnostic("without an app and its key, no token and no request");

  await store.setSetting("githubApp", { id: 4242, slug: "codeotter-acme", pem });
  assert.equal(appPostingActive(await store.getSetting("githubApp")), true);
  assert.equal(await appInstallationToken("forgejo~acme/shop"), "", "forge repositories never ask GitHub");
  assert.equal(await appInstallationToken("acme/shop"), "ghs_token1");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET https://api.github.com/repos/acme/shop/installation", "POST https://api.github.com/app/installations/77/access_tokens"]);
  assert.ok(calls.every((c) => c.redirect === "error"), "redirects are not followed");
  assert.equal(await appInstallationToken("acme/shop"), "ghs_token1");
  assert.equal(await appInstallationToken("acme/api"), "ghs_token1", "one installation per owner");
  assert.equal(calls.length, 2, "cached: no further requests");
  ctx.diagnostic("token minted once per owner and reused");

  const start = Date.now();
  Date.now = () => start + 54 * 60_000;
  assert.equal(await appInstallationToken("acme/shop"), "ghs_token1", "54 minutes in: still valid");
  Date.now = () => start + 56 * 60_000;
  assert.equal(await appInstallationToken("acme/shop"), "ghs_token2", "within five minutes of expiry: renewed");
  assert.deepEqual(calls.slice(2).map((c) => c.method), ["POST"], "renewal skips the installation lookup");
  Date.now = realNow;
  ctx.diagnostic("token renewed five minutes before it expires");

  const before = calls.length;
  assert.equal(await appInstallationToken("other/repo"), "", "not installed: the operator posts");
  assert.equal(await appInstallationToken("other/repo"), "");
  assert.equal(calls.length, before + 1, "a miss is remembered");
  await assert.rejects(appInstallationToken("broken/repo"), /installation lookup answered 500/);
  ctx.diagnostic("not installed or failing: falls back (ghAsApp catches the error)");

  await store.setSetting("githubApp", { id: 9999, slug: "replaced", pem });
  const n = calls.length;
  assert.equal(await appInstallationToken("acme/shop"), "ghs_token3", "a replaced app starts a fresh cache");
  assert.equal(calls.length, n + 2);
  ctx.diagnostic("cache is per app");

  assert.equal(ghOwnerOf(["pr", "list", "-R", "acme/web", "--json", "number"]), "acme");
  assert.equal(ghOwnerOf(["pr", "view", "https://github.com/acme/web/pull/7", "--json", "title"]), "acme");
  assert.equal(ghOwnerOf(["api", "--method", "POST", "repos/Acme-Co/web/statuses/abc", "-f", "state=success"]), "Acme-Co");
  assert.equal(ghOwnerOf(["api", "search/code?q=repo:acme/web+parseThing&per_page=5"]), "acme");
  assert.equal(ghOwnerOf(["repo", "view", "acme/web", "--json", "nameWithOwner"]), "acme");
  assert.equal(ghOwnerOf(["repo", "list", "acme", "--limit", "100"]), "acme");
  assert.equal(ghOwnerOf(["api", "user", "--jq", ".login"]), "");
  assert.equal(ghOwnerOf(["repo", "list", "--limit", "1"]), "");
  ctx.diagnostic("the owner comes from -R, a PR URL, an api path, a search qualifier or gh repo view|list");

  await store.setSetting("githubApp", { id: 42, pem });
  const listed: string[] = [];
  let installs = [{ id: 1, account: { login: "Acme" } }, { id: 2, account: { login: "other" } }];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    listed.push(`${init.method || "GET"} ${url}`);
    assert.match(String((init.headers as Record<string, string>).authorization), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "App JWT");
    assert.equal(init.redirect, "error");
    if (url.endsWith("/app/installations?per_page=100")) return Response.json(installs);
    const m = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (m) return Response.json({ token: `ghs_inst${m[1]}`, expires_at: new Date(Date.now() + 3600000).toISOString() }, { status: 201 });
    return new Response("{}", { status: 404 });
  };
  assert.equal(await appInstallationToken("gitea~acme"), "", "forge owners never ask GitHub");
  assert.equal(await appInstallationToken("acme"), "ghs_inst1", "owner matched case-insensitively");
  assert.equal(await appInstallationToken("ACME"), "ghs_inst1");
  assert.equal(listed.length, 2, "second call is served from the cache");
  assert.equal(await appInstallationToken("acme/web"), "ghs_inst1", "a repository write reuses the owner's installation and token");
  assert.equal(listed.length, 2);
  assert.equal(await appInstallationToken("other"), "ghs_inst2");
  assert.equal(await appInstallationToken("stranger"), "", "an owner without an installation gets nothing");
  assert.equal(await appInstallationToken(""), "", "no owner and several installations: never guess");
  installs = [{ id: 9, account: { login: "solo" } }];
  assert.equal(await appInstallationToken(""), "ghs_inst9", "no owner and one installation: that one");
  ctx.diagnostic("installation tokens per owner, cached, and never guessed between installations");

  const before = listed.length;
  forgetGithubRepos();
  assert.equal(await appInstallationToken("solo"), "ghs_inst9");
  assert.ok(listed.length > before, "forgetGithubRepos (new App or install) drops cached tokens");
  ctx.diagnostic("a new App or installation drops the cached tokens");
});
