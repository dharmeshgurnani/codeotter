// Analytics: token metering of model calls, cost estimates, and the /api/analytics report through app.request() against an
// in-process fake PocketBase (fetch is stubbed; nothing leaves the process): aggregation over a period, the ?org= scope,
// and a developer seeing only assigned repositories.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

type Json = Record<string, unknown>;
type Section = { id: string; kind: string; items?: { label: string; value: string | number; hint?: string }[]; rows?: unknown[][] };
type Report = { period: { value: number; options: { value: number }[] }; sections: Section[] };

test("analytics: metering, cost and the scoped report", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-analytics-"));
  const PB = "http://pb.test";
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), REPO: "acme/api", CODEOTTER_UPDATE_CHECK: "0", PB_URL: PB });

  // ---- fake PocketBase and model endpoints ----
  const users = [{ id: "o1", role: "owner", name: "Owner" }, { id: "a1", role: "admin", name: "Admin" }, { id: "d1", role: "developer", name: "Dev" }];
  const tokens: Record<string, string> = { towner: "o1", tadmin: "a1", tdev: "d1" };
  const settings: Json = { repos: ["acme/api", "acme/secret", "other/tool"], access: { d1: ["acme/api"] } };
  const events: Json[] = [];
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Json) : {};
    const filter = url.searchParams.get("filter") || "";
    const auth = new Headers(init.headers).get("authorization") || "";
    if (url.host === "api.anthropic.test") return ok({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 } });
    if (url.host === "router.test") return ok({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0042 } });
    if (url.origin !== PB) throw new Error(`unexpected fetch ${url}`);
    const p = url.pathname;
    if (p === "/api/health") return ok({});
    if (p === "/api/collections/_superusers/auth-with-password") return ok({ token: "su" });
    if (p === "/api/collections/users/auth-refresh") { const rec = users.find((u) => u.id === tokens[auth]); return rec ? ok({ token: auth, record: rec }) : ok({ message: "invalid" }, 401); }
    if (p === "/api/collections/users/records") return ok({ items: users, totalPages: 1 });
    if (p === "/api/collections/users") return ok({ oauth2: { enabled: true, providers: [] } });
    if (p === "/api/collections/_externalAuths/records") return ok({ items: [], totalPages: 1 });
    if (p === "/api/collections/reviews/records") return ok({ items: [], totalPages: 1 });
    if (p === "/api/collections/settings/records" && method === "GET") { const k = /key="([^"]+)"/.exec(filter)?.[1] || ""; return ok({ items: k in settings ? [{ id: k, key: k, value: settings[k] }] : [] }); }
    if (p.startsWith("/api/collections/settings/records")) { settings[String(body.key)] = body.value; return ok({}); }
    if (p === "/api/collections/analytics/records" && method === "POST") { events.push(body); return ok({}); }
    if (p === "/api/collections/analytics/records") {
      const since = /at>="([^"]+)"/.exec(filter)?.[1] || "";
      const items = events.filter((e) => String(e.at).replace("T", " ") >= since).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return ok({ items, totalPages: 1 });
    }
    return ok({ message: `fake pb: ${method} ${p}` }, 404);
  };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

  // ---- metering and cost ----
  const { askModel, metered, newUsage } = await import("../core/models.ts");
  const { estimateCost, priceOf, totals } = await import("../core/analytics.ts");
  {
    const u = newUsage();
    await metered(u, async () => {
      await askModel("x", { provider: "anthropic", api: "anthropic", baseUrl: "https://api.anthropic.test", model: "claude-sonnet-5-5", apiKey: "k", source: "settings" });
      await askModel("x", { provider: "anthropic", api: "anthropic", baseUrl: "https://api.anthropic.test", model: "claude-sonnet-5-5", apiKey: "k", source: "settings" });
    });
    assert.deepEqual(u, { calls: 2, input: 240, output: 60, cost: null });
    assert.equal(estimateCost({ provider: "anthropic", model: "claude-sonnet-5-5", local: false }, null, u), (240 * 2 + 60 * 10) / 1e6);
    const r = newUsage();
    await metered(r, () => askModel("x", { provider: "openrouter", api: "openai", baseUrl: "https://router.test/api/v1", model: "acme/unknown", apiKey: "k", source: "settings" }));
    assert.deepEqual(r, { calls: 1, input: 50, output: 5, cost: 0.0042 });
    assert.equal(estimateCost({ provider: "openrouter", model: "acme/unknown", local: false }, null, r), 0.0042, "provider-reported cost wins");
    await askModel("x", { provider: "anthropic", api: "anthropic", baseUrl: "https://api.anthropic.test", model: "claude-sonnet-5-5", apiKey: "k", source: "settings" });
    assert.equal(r.calls, 1, "calls outside metered() are not counted");
  }
  assert.deepEqual(priceOf("anthropic/claude-opus-5-5"), [4, 20]);
  assert.equal(estimateCost({ provider: "custom", model: "mystery", local: false }, null, { calls: 1, input: 10, output: 10, cost: null }), null, "unknown hosted price");
  assert.equal(estimateCost({ provider: "local_x", model: "q", local: true }, { provider: "laya", model: "l", local: true }, { calls: 3, input: 900, output: 90, cost: null }), 0, "local models cost nothing");
  assert.equal(estimateCost(null, { provider: "jev", model: "jev-latest", local: false }, newUsage()), null, "hosted System One reports no usage");
  ctx.diagnostic("model calls are metered per run; cost comes from the provider, the price table, or is unknown; local is $0");

  // ---- events ----
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3600e3).toISOString();
  const run = (repo: string, n: number, at: string, x: Partial<Json> = {}): Json => ({
    kind: "review", url: `https://github.com/${repo}/pull/${n}`, repo, at, durationMs: 60000, llm: "anthropic/claude-sonnet-5-5", s1: null,
    calls: 1, input: 1000, output: 200, cost: 0.004, findings: { high: 1, medium: 2, low: 0, nit: 1 },
    gates: [{ id: "security", label: "Security", pass: false }, { id: "tests", label: "Tests", pass: true }], posted: 4, accepted: 1, ...x,
  });
  const seed = [
    run("acme/api", 1, ago(2)),
    run("acme/api", 1, ago(30), { cost: null, posted: 0, accepted: 2, gates: [{ id: "security", label: "Security", pass: true }] }),
    run("acme/secret", 2, ago(5), { findings: { high: 3, medium: 0, low: 0, nit: 0 } }),
    run("other/tool", 3, ago(1)),
    run("acme/api", 9, ago(24 * 40)),
    { kind: "posted", url: "https://github.com/acme/api/pull/1", repo: "acme/api", at: ago(3), count: 2 },
    { kind: "dismissed", url: "https://github.com/acme/secret/pull/2", repo: "acme/secret", at: ago(4), count: 1 },
  ];
  // stored as the store writes them: copies of kind, repo, url and at, and the event in `data`
  events.push(...seed.map((e) => ({ kind: e.kind, repo: e.repo, url: e.url, at: e.at, data: e })));

  const { initializeCore } = await import("../core/server.ts");
  const { app } = await import("../core/app.ts");
  await initializeCore();
  const get = async (path: string, token: string) => { const res = await app.request(path, { headers: { cookie: `pr_auth=${token}` } }); return { status: res.status, body: (await res.json()) as Report & Json }; };
  const stat = (r: Report, label: string) => r.sections.find((s) => s.id === "totals")?.items?.find((i) => i.label === label);
  const repoCells = (r: Report) => (r.sections.find((s) => s.id === "repos")?.rows || []).map((row) => (row[0] as { text: string }).text);

  {
    const { status, body } = await get("/api/analytics?org=acme&days=7", "towner");
    assert.equal(status, 200);
    assert.equal(body.period.value, 7);
    assert.deepEqual(body.period.options.map((o) => o.value), [7, 30, 90]);
    assert.equal(stat(body, "Reviews")?.value, 3, "acme only, inside 7 days");
    assert.match(String(stat(body, "Reviews")?.hint), /^2 pull requests/);
    assert.equal(stat(body, "Findings")?.value, 4 + 4 + 3);
    // posted 4 + 0 + 4 (runs) + 2 (by hand); applied 1 + 2 + 1
    assert.equal(stat(body, "Acceptance rate")?.value, "40%");
    assert.equal(stat(body, "Acceptance rate")?.hint, "4 applied · 10 posted · 1 dismissed");
    assert.equal(stat(body, "Tokens")?.value, "3,600");
    assert.equal(stat(body, "Cost")?.value, "<$0.01");
    assert.match(String(stat(body, "Cost")?.hint), /^1 review with an unpriced/);
    assert.deepEqual(repoCells(body), ["acme/api", "acme/secret"]);
    const sev = body.sections.find((s) => s.id === "severity")?.rows || [];
    assert.deepEqual(sev.map((r) => [(r[0] as { text: string }).text, r[1]]), [["High", 5], ["Medium", 4], ["Low", 0], ["Nit", 2]]);
    const gates = body.sections.find((s) => s.id === "gates")?.rows || [];
    assert.deepEqual(gates.map((r) => [r[0], r[1], (r[2] as { text: string }).text]), [["Security", 3, "2"], ["Tests", 2, "0"]]);
    const bars = body.sections.find((s) => s.id === "volume")?.items || [];
    assert.equal(bars.length, 8);
    assert.equal(bars.reduce((n, b) => n + Number(b.value), 0), 3);
  }
  ctx.diagnostic("totals, per-repository rows, severities, gate failures and daily volume for the active organization");

  {
    const { body } = await get("/api/analytics?org=acme&days=90", "towner");
    assert.equal(stat(body, "Reviews")?.value, 4, "the 40-day-old review is inside 90 days");
    assert.equal(body.sections.find((s) => s.id === "volume")?.items?.length, 13, "weekly bars");
    assert.equal((await get("/api/analytics?org=acme&days=12", "towner")).body.period.value, 30, "unknown period falls back to 30");
    const all = (await get("/api/analytics?days=7", "tadmin")).body;
    assert.equal(stat(all, "Reviews")?.value, 4, "no org: every organization for an admin");
    assert.deepEqual(repoCells(all), ["acme/api", "acme/secret", "other/tool"]);
    assert.equal((await get("/api/analytics?org=other&days=7", "towner")).body.sections.find((s) => s.id === "totals")?.items?.[0]?.value, 1);
    assert.equal((await get("/api/analytics?org=acme/api", "towner")).status, 500, "bad organization");
  }
  ctx.diagnostic("period choices, 90-day weekly buckets, and the ?org= scope");

  {
    const { status, body } = await get("/api/analytics?org=acme&days=7", "tdev");
    assert.equal(status, 200);
    assert.deepEqual(repoCells(body), ["acme/api"]);
    assert.equal(stat(body, "Reviews")?.value, 2);
    assert.equal(stat(body, "Acceptance rate")?.hint, "3 applied · 6 posted · 0 dismissed");
    const text = JSON.stringify(body);
    assert.ok(!text.includes("acme/secret") && !text.includes("other/tool"), text);
    assert.deepEqual(repoCells((await get("/api/analytics?days=7", "tdev")).body), ["acme/api"], "no org: still only assigned");
    assert.equal(stat((await get("/api/analytics?org=other&days=7", "tdev")).body, "Reviews")?.value, 0);
    assert.equal((await get("/api/analytics", "nobody")).status, 403, "signed out");
  }
  ctx.diagnostic("a developer sees only assigned repositories; signed-out requests are refused");

  {
    const res = await app.request("/api/learnings?org=acme", { method: "POST", headers: { cookie: "pr_auth=tdev", "content-type": "application/json" }, body: JSON.stringify({ prUrl: "https://github.com/acme/api/pull/1", file: "a.ts", title: "noise" }) });
    assert.equal(res.status, 200);
    const last = events.at(-1) as Json;
    assert.equal(last.kind, "dismissed");
    assert.equal(last.repo, "acme/api");
    assert.equal(stat((await get("/api/analytics?org=acme&days=7", "tdev")).body, "Acceptance rate")?.hint, "3 applied · 6 posted · 1 dismissed");
    assert.deepEqual(totals([]), { reviews: 0, prs: 0, findings: 0, posted: 0, accepted: 0, dismissed: 0, tokens: 0, cost: 0, unpriced: 0, durationMs: 0 });
  }
  ctx.diagnostic("dismissing a finding into a learning records a dismissed outcome");
});
