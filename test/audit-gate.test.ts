// Audit log access through app.request() with accounts: PB_URL points at an in-memory fake PocketBase (fetch stub), so
// the owner, an admin and a developer each sign in by token. Only the owner reaches the page and the CSV export, the
// sidebar lists the page for owners only, and a gated save is recorded under the account that made it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

type Rec = Record<string, unknown>;

test("audit log access", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-audit-gate-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), REPO: "acme/api", CODEOTTER_UPDATE_CHECK: "0", PB_URL: "http://pb.test" });
  delete process.env.PR_SCORER_RECOVERY;
  const users: Rec[] = [
    { id: "u1", name: "Olive", role: "owner" },
    { id: "u2", name: "Ada", role: "admin" },
    { id: "u3", name: "Dev", role: "developer" },
  ];
  const tokens: Record<string, string> = { "owner-token": "u1", "admin-token": "u2", "dev-token": "u3" };
  const audit: Rec[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== "http://pb.test") throw new Error(`unexpected fetch ${url}`);
    const path = url.pathname.replace(/^\/api\//, "");
    const method = (init.method || "GET").toUpperCase();
    const auth = new Headers(init.headers).get("authorization") || "";
    if (path === "health") return Response.json({ code: 200 });
    if (path === "collections/_superusers/auth-with-password") return Response.json({ token: "su" });
    if (path === "collections/users/auth-refresh") {
      const u = users.find((x) => x.id === tokens[auth]);
      return u ? Response.json({ token: auth, record: u }) : Response.json({ message: "no" }, { status: 401 });
    }
    if (path === "collections/users/auth-methods") return Response.json({ oauth2: { enabled: false, providers: [] } });
    if (path === "collections/users/records") return Response.json({ items: users, totalItems: users.length, totalPages: 1 });
    if (path === "collections/settings/records") return method === "GET" ? Response.json({ items: [], totalItems: 0 }) : Response.json({});
    if (path === "collections/audit/records") {
      if (method === "POST") { audit.push(JSON.parse(String(init.body))); return Response.json({}); }
      // retention's query for entries past the window: none here
      if (url.searchParams.get("filter")?.startsWith("at<")) return Response.json({ items: [], totalItems: 0, totalPages: 1 });
      return Response.json({ items: [...audit].reverse(), totalItems: audit.length, totalPages: 1 });
    }
    if (path === "collections/reviews/records") return Response.json({ items: [], totalItems: 0, totalPages: 1 });
    throw new Error(`fake PocketBase has no ${method} ${path}`);
  };
  ctx.after(() => { globalThis.fetch = realFetch; delete process.env.PB_URL; rmSync(home, { recursive: true, force: true }); });

  const { app } = await import("../core/app.ts");
  const { settingsPages } = await import("../core/settings-pages.ts");
  const as = (token: string, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...(token ? { cookie: `pr_auth=${token}` } : {}), "content-type": "application/json" } });

  for (const [token, who] of [["admin-token", "admin"], ["dev-token", "developer"], ["", "signed out"]]) {
    const page = await as(token, "/api/settings/audit");
    assert.equal(page.status, 403, `${who}: page`);
    assert.deepEqual(await page.json(), token ? { error: "This needs the owner role", login: false } : { error: "Sign in to continue", login: true });
    assert.equal((await as(token, "/api/settings/audit", { method: "POST", body: JSON.stringify({ filter: {} }) })).status, 403, `${who}: apply`);
    assert.equal((await as(token, "/api/audit/export")).status, 403, `${who}: export`);
  }
  ctx.diagnostic("admins, developers and signed-out visitors are refused the page, its filter and the export");

  {
    const page = await as("owner-token", "/api/settings/audit");
    assert.equal(page.status, 200);
    assert.ok(Array.isArray(((await page.json()) as { sections?: unknown }).sections));
    const csv = await as("owner-token", "/api/audit/export");
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /^"time","actor_id","actor","action","target","org","detail"\r\n/);
  }
  ctx.diagnostic("the owner gets the page and the CSV");

  {
    assert.ok((await settingsPages({ role: "owner" })).some((p) => p.id === "audit"));
    assert.ok(!(await settingsPages({ role: "admin" })).some((p) => p.id === "audit"));
    assert.equal((await settingsPages({ role: "owner" })).find((p) => p.id === "audit")?.group, "workspace");
  }
  ctx.diagnostic("the sidebar lists Audit log under Workspace for owners only");

  {
    const res = await as("owner-token", "/api/settings/accounts", { method: "POST", body: JSON.stringify({ accounts: { rows: [{ id: "u3", edited: true, settings: { values: { role: "developer", repos: ["acme/api"] } } }] } }) });
    assert.equal(res.status, 200);
    const e = audit.find((x) => x.action === "account.update");
    assert.ok(e, "account change recorded");
    assert.deepEqual([e.actor, e.actorName, e.target], ["u1", "Olive", "u3"]);
    assert.deepEqual(e.detail, { page: "accounts", fields: { "accounts.u3.role": "developer", "accounts.u3.repos": "acme/api" } });
  }
  ctx.diagnostic("a gated save is recorded under the signed-in account");
});
