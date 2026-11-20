// Audit log on file storage: settings saves are recorded with secrets masked, the page filters, the CSV export, the
// organization scope and retention. A temp CODEOTTER_HOME, PATH cut to node's directory (no PocketBase, no gh), fetch refused.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

type Page = { sections: { id: string }[]; values: { filter: Record<string, unknown>; entries: { rows: { cells: Record<string, unknown> }[] } } };

test("audit log", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-audit-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), REPO: "acme/api", CODEOTTER_UPDATE_CHECK: "0" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

  const { initializeCore } = await import("../core/server.ts");
  const { app } = await import("../core/app.ts");
  const { audit, MASK, settingsChanges, trimAudit } = await import("../core/audit.ts");
  const { auditStore } = await import("../core/store.ts");
  await initializeCore();
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const raw = () => readFileSync(join(home, "audit.jsonl"), "utf8");

  {
    const fields = settingsChanges({
      llm: { provider: "openai", apiKey: "sk-live-123456", baseUrl: "", temperature: 0.2, nested: { clientSecret: "cs-1", password: "pw", pem: "-----BEGIN" } },
      signin: { rows: [{ id: "github", edited: true, toggle: true, settings: { values: { clientId: "Iv1.abc", clientSecret: "gh-secret", callback: "https://x/auth/callback" } } }, { id: "gitea", edited: false, settings: { values: { clientSecret: "not-sent" } } }] },
      git: { clearToken: true, token: "" },
    });
    assert.deepEqual(fields, {
      "llm.provider": "openai",
      "llm.apiKey": MASK,
      "llm.temperature": 0.2,
      "llm.nested.clientSecret": MASK,
      "llm.nested.password": MASK,
      "llm.nested.pem": MASK,
      "signin.github.enabled": true,
      "signin.github.clientId": "Iv1.abc",
      "signin.github.clientSecret": MASK,
      "git.clearToken": true,
    });
  }
  ctx.diagnostic("settingsChanges masks secrets, drops blanks and echoed fields, and reads only the edited table row");

  {
    const res = await post("/api/settings/git", { providers: { rows: [
      { id: "github", edited: true, settings: { values: { token: "ghp_SuperSecretToken9876", webhookSecret: "whsec-very-secret", forward: false, webhookUrl: "https://x/webhooks/github", webhookStatus: "never" } } },
      { id: "gitea", edited: false, settings: { values: { url: "", token: "gitea-unsent-token" } } },
    ] } });
    assert.equal(res.status, 200);
    const text = raw();
    for (const secret of ["ghp_SuperSecretToken9876", "whsec-very-secret", "gitea-unsent-token", "9876"]) assert.ok(!text.includes(secret), `audit log holds ${secret}`);
    const entries = text.trim().split("\n").map((l) => JSON.parse(l));
    const save = entries.find((e) => e.action === "git-provider.update");
    assert.equal(save.target, "github");
    assert.equal(save.actor, "anonymous-bootstrap", "file storage: the single operator");
    assert.deepEqual(save.detail, { page: "git", fields: { "providers.github.token": MASK, "providers.github.webhookSecret": MASK, "providers.github.forward": false } });
    assert.ok(entries.some((e) => e.action === "webhook-secret.update" && e.target === "github"));
  }
  ctx.diagnostic("a Git providers save is logged with the changed keys, token and webhook secret masked, and a webhook-secret event");

  {
    await audit({ id: "u9", name: "Mallory" }, "invite.add", "=HYPERLINK(\"http://evil\")", { page: "accounts" }, "acme");
    const res = await app.request("/api/audit/export?org=acme");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/csv/);
    assert.match(res.headers.get("content-disposition") || "", /attachment; filename="codeotter-audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    assert.equal(lines[0], '"time","actor_id","actor","action","target","org","detail"');
    assert.match(lines[1], /"invite\.add","'=HYPERLINK\(""http:\/\/evil""\)","acme"/, "newest first; a formula is defused");
    assert.ok(csv.includes("providers.github.token=••••"));
    assert.ok(!csv.includes("ghp_SuperSecretToken9876"));
    const only = await (await app.request("/api/audit/export?action=webhook-secret.update")).text();
    assert.equal(only.trim().split("\r\n").length, 2, "the action filter applies to the export");
  }
  ctx.diagnostic("CSV export: owner route, newest first, filtered, secrets masked, formulas defused");

  {
    const get = (await app.request("/api/settings/audit?org=acme")).json() as Promise<Page>;
    const page = await get;
    assert.deepEqual(page.sections.map((s) => s.id), ["filter", "entries"]);
    assert.equal(page.values.entries.rows.length, 3);
    assert.deepEqual(page.values.entries.rows[0].cells.action, { text: "invite.add", tone: "muted" });
    const before = raw();
    const filtered = (await (await post("/api/settings/audit?org=acme", { filter: { action: "webhook-secret.update", actor: "", page: 1 } })).json()) as Page;
    assert.equal(filtered.values.entries.rows.length, 1);
    assert.equal(filtered.values.filter.action, "webhook-secret.update");
    assert.equal(raw(), before, "applying a filter is not itself logged");
    const byActor = (await (await post("/api/settings/audit", { filter: { actor: "u9" } })).json()) as Page;
    assert.equal(byActor.values.entries.rows.length, 1);
    const bogus = (await (await post("/api/settings/audit", { filter: { action: "nope\"||1", actor: "x\"y", page: 99 } })).json()) as Page;
    assert.deepEqual([bogus.values.filter.action, bogus.values.filter.actor, bogus.values.filter.page], ["", "", 1], "unknown filters are ignored and the page clamped");
  }
  ctx.diagnostic("Audit log page: entries newest first, filter by action and actor, filters never logged");

  {
    await audit(null, "repository.add", "other/app", {}, "other");
    const acme = await auditStore.list({ org: "acme", page: 1, perPage: 50 });
    assert.ok(acme.items.every((e) => e.org === "acme" || e.org === ""));
    assert.ok(!acme.items.some((e) => e.target === "other/app"), "another organization's entries stay out");
    assert.ok((await auditStore.list({ org: "other", page: 1, perPage: 50 })).items.some((e) => e.target === "other/app"));
  }
  ctx.diagnostic("an organization sees its own and instance-wide entries only");

  {
    const now = Date.parse("2026-11-20T00:00:00Z");
    rmSync(join(home, "audit.jsonl"), { force: true });
    const at = (daysAgo: number, i: number) => new Date(now - daysAgo * 86400000 + i).toISOString();
    for (let i = 0; i < 5; i++) await auditStore.add({ at: at(200, i), actor: "system", actorName: "system", action: "settings.update", target: `old${i}`, org: "", detail: {} });
    for (let i = 0; i < 10; i++) await auditStore.add({ at: at(1, i), actor: "system", actorName: "system", action: "settings.update", target: `new${i}`, org: "", detail: {} });
    assert.equal(await trimAudit({ max: 8, days: 180, now }), 7);
    const left = await auditStore.list({ page: 1, perPage: 50 });
    assert.equal(left.total, 8);
    assert.deepEqual(left.items.map((e) => e.target), ["new9", "new8", "new7", "new6", "new5", "new4", "new3", "new2"], "the newest within 180 days are kept");
    assert.equal(await trimAudit({ max: 8, days: 180, now }), 0, "nothing more to drop");
  }
  ctx.diagnostic("retention keeps the newest N entries no older than the retention window");

  {
    // Issue trackers (Jira token, Linear API key) and SSO (OIDC client secret) saves: secrets masked
    const fields = settingsChanges({
      trackers: { rows: [{ id: "jira", edited: true, settings: { values: { url: "https://acme.atlassian.net", email: "a@acme.test", token: "jira-tok-SECRET", projects: "ABC" } } }, { id: "linear", edited: false, settings: { values: { apiKey: "lin_api_UNSENT" } } }] },
      signin: { rows: [{ id: "sso", edited: true, toggle: true, settings: { values: { issuer: "https://login.acme.test", clientId: "co", clientSecret: "oidc-SECRET", domains: "acme.test" } } }] },
    });
    assert.equal(fields["trackers.jira.token"], MASK);
    assert.equal(fields["signin.sso.clientSecret"], MASK);
    assert.ok(!JSON.stringify(fields).includes("SECRET") && !JSON.stringify(fields).includes("UNSENT"));
    const res = await post("/api/settings/trackers", { trackers: { rows: [{ id: "linear", edited: true, settings: { values: { apiKey: "lin_api_SAVED_SECRET", teams: "ENG" } } }] } });
    assert.equal(res.status, 200);
    const text = raw();
    assert.ok(!text.includes("lin_api_SAVED_SECRET"), "the Linear key never reaches the audit log");
    const save = text.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.action === "issue-tracker.update");
    assert.deepEqual(save?.detail, { page: "trackers", fields: { "trackers.linear.apiKey": MASK, "trackers.linear.teams": "ENG" } });
    const del = await post("/api/settings/analyzers/delete", { item: "gitleaks" });
    assert.equal(del.status, 200);
    assert.ok(raw().trim().split("\n").map((l) => JSON.parse(l)).some((e) => e.action === "analyzer.delete" && e.target === "gitleaks"), "analyzer row actions are named as such");
  }
  ctx.diagnostic("Issue trackers, SSO and analyzer actions: secrets masked, actions named per page");
});
