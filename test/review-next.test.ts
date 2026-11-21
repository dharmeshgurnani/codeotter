// Review next: the ranking and grouping arithmetic (rankQueue, pure), then /api/review-next, Home and the Review queue
// settings page through app.request(). A temp CODEOTTER_HOME, a PocketBase and a Gitea server faked inside fetch (so a
// developer session exists), gh off PATH; nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const GITEA = "https://gitea.test";
const PB = "http://pb.test";

test("review next: ranking, groups, SLA, org scope and developer filtering", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-next-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, PR_SCORER_DATA: join(home, ".local"), PATH: dirname(process.execPath), REPO: "acme/api", CODEOTTER_UPDATE_CHECK: "0", PB_URL: PB, GITEA_URL: GITEA, GITEA_TOKEN: "t" });
  delete process.env.PR_SCORER_RECOVERY;
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 36e5).toISOString();

  // ---- the fakes ----
  type Pull = { number: number; title: string; body?: string; head: { ref: string; sha: string }; base: { ref: string }; additions: number; deletions: number; changed_files: number; draft?: boolean; created_at: string; updated_at: string };
  const pull = (number: number, head: string, extra: Partial<Pull> = {}): Pull => ({ number, title: `pr ${number}`, head: { ref: head, sha: `sha${number}` }, base: { ref: "main" }, additions: 100, deletions: 20, changed_files: 3, created_at: ago(10), updated_at: ago(10), ...extra });
  const pulls: Record<string, Pull[]> = {
    "acme/api": [
      pull(1, "feat/auth-1", { additions: 400, updated_at: ago(2) }),
      pull(2, "feat/auth-2", { base: { ref: "feat/auth-1" }, updated_at: ago(1) }),
      pull(3, "chore/deps", { created_at: ago(100), updated_at: ago(100) }),
      pull(4, "wip/spike", { draft: true, updated_at: ago(200), created_at: ago(200) }),
      pull(6, "fix/login", { body: "Fixes #40", additions: 10, deletions: 2 }),
      pull(7, "fix/login-copy", { title: "Copy for #40", additions: 5, deletions: 0 }),
    ],
    "acme/secret": [pull(9, "secret/thing")],
    "other/tool": [pull(5, "tool/x")],
  };
  const url = (repo: string, n: number) => `${GITEA}/${repo}/pulls/${n}`;
  const db = {
    users: [{ id: "u-owner", role: "owner", name: "olive" }, { id: "u-dev", role: "developer", name: "devon" }],
    tokens: { towner: "u-owner", tdev: "u-dev" } as Record<string, string>,
    settings: {
      repos: ["gitea~acme/api", "gitea~acme/secret", "gitea~other/tool"],
      onboardingComplete: true,
      access: { "u-dev": ["gitea~acme/api"] },
      triageResults: { [url("acme/api", 1)]: { url: url("acme/api", 1), repo: "gitea~acme/api", number: 1, title: "pr 1", headSha: "sha1", at: ago(1), risk: 90, blast: 60, verdict: "attention", stopAt: 75, model: "s1", seconds: 1 } },
    } as Record<string, unknown>,
    reviews: [] as { pr: { url: string } }[],
  };
  const realFetch = globalThis.fetch;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const method = (init.method || "GET").toUpperCase();
    if (u.origin === PB) {
      const p = u.pathname;
      const f = /^(\w+)="(.*)"$/.exec(u.searchParams.get("filter") || "");
      const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) as { key?: string; value?: unknown } : {};
      if (p === "/api/health") return json({ code: 200 });
      if (p === "/api/collections/_superusers/auth-with-password") return json({ token: "su" });
      if (p === "/api/collections/users/auth-refresh") {
        const auth = new Headers(init.headers).get("authorization") || "";
        const rec = db.users.find((x) => x.id === db.tokens[auth]);
        return rec ? json({ token: auth, record: rec }) : json({ message: "invalid" }, 401);
      }
      if (p === "/api/collections/users/records") return json({ items: db.users, totalPages: 1 });
      if (p === "/api/collections/users/auth-methods" || p === "/api/collections/users") return json({ oauth2: { enabled: true, providers: [{ name: "github" }] } });
      if (p.startsWith("/api/collections/_externalAuths/records")) return json({ items: [], totalPages: 1 });
      if (p.startsWith("/api/collections/reviews/records")) return json({ items: db.reviews.filter((r) => !f || r.pr.url === f[2]).map((r, i) => ({ id: String(i), data: r })), totalPages: 1 });
      if (p.startsWith("/api/collections/audit/records") || p.startsWith("/api/collections/analytics/records")) return json({ items: [], totalPages: 1 });
      if (p === "/api/collections/settings/records" && method === "GET") return json({ items: f && f[2] in db.settings ? [{ id: f[2], key: f[2], value: db.settings[f[2]] }] : [] });
      if (p.startsWith("/api/collections/settings/records")) { db.settings[String(body.key)] = body.value; return json({}); }
      return json({ message: `fake pb: ${method} ${p}` }, 404);
    }
    if (u.origin === GITEA) {
      const m = /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname);
      if (m && method === "GET") return json(u.searchParams.get("page") === "1" ? pulls[m[1]] || [] : []);
      return json({ message: "not found" }, 404);
    }
    throw new Error(`unexpected fetch ${u.href}`);
  };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

  const { rankQueue, branchPrefix, duration } = await import("../core/review-next.ts");
  const { initializeCore } = await import("../core/server.ts");
  const { app } = await import("../core/app.ts");
  await initializeCore();

  // ---- rankQueue, pure ----
  assert.equal(branchPrefix("feat/auth-1"), "feat/auth");
  assert.equal(branchPrefix("feat/auth-12"), "feat/auth");
  assert.equal(branchPrefix("fix-12"), "", "no slash: an issue number, not a series");
  assert.equal(branchPrefix("release/1.2"), "");
  assert.equal(branchPrefix("team/auth/api"), "team/auth");
  assert.equal(branchPrefix("main"), "");
  assert.deepEqual([duration(0.5), duration(5), duration(50), duration(72)], ["<1h", "5h", "2d 2h", "3d"]);
  ctx.diagnostic("branch prefixes and durations");

  type Open = Parameters<typeof rankQueue>[0][number];
  const pr = (n: number, o: Partial<Open> = {}): Open => ({ url: `https://github.com/acme/api/pull/${n}`, number: n, title: `t${n}`, body: "", updatedAt: ago(1), createdAt: ago(1), additions: 100, deletions: 0, changedFiles: 2, isDraft: false, baseRefName: "main", headRefName: `b${n}`, headRefOid: `s${n}`, ...o });
  const reviewed = (n: number, o: { risk?: number; blast?: number; verdict?: string; gates?: { id: string; label: string; yes: number; pass: boolean; mode?: "warn" | "block" }[]; sha?: string; at?: string }) => ({
    pr: { url: `https://github.com/acme/api/pull/${n}` }, headSha: o.sha ?? `s${n}`, at: o.at ?? ago(0.5),
    review: { verdict: o.verdict ?? "comment", scores: { quality: 50, correctness_risk: o.risk ?? 0, test_coverage: 50, readability: 50, pr_hygiene: 50 }, findings: [], summary: "", walkthrough: [] },
    blast: { score: o.blast ?? 0 }, gates: o.gates ?? [], linkedIssues: [],
  }) as unknown as Parameters<typeof rankQueue>[1]["reviews"][number];
  {
    const items = rankQueue([pr(1), pr(2, { updatedAt: ago(240), createdAt: ago(240) }), pr(3), pr(4, { isDraft: true }), pr(5, { headRefOid: "new" })], {
      reviews: [
        reviewed(1, { risk: 20, blast: 10, verdict: "approve" }),
        reviewed(3, { risk: 80, blast: 70, verdict: "request_changes", gates: [{ id: "a", label: "A", yes: 0.1, pass: false, mode: "block" }, { id: "b", label: "B", yes: 0.2, pass: false }, { id: "c", label: "C", yes: 0.9, pass: true }] }),
        reviewed(4, { risk: 50, blast: 50 }),
        reviewed(5, { risk: 50, blast: 50 }),
      ],
      triage: {}, sla: {}, now,
    });
    const by = (n: number) => items.find((i) => i.pr.number === n)!;
    assert.deepEqual(items.map((i) => i.pr.number), [3, 2, 5, 1, 4], JSON.stringify(items.map((i) => [i.pr.number, i.priority, i.parts])));
    // #3: 0.4×80 + 0.2×70 + 12 (block) + 8 (warn) + 10 (changes requested) + waiting 1h
    assert.equal(by(3).priority, Math.round(32 + 14 + 12 + 8 + 10 + 0.3));
    assert.deepEqual(by(3).gates, { total: 3, failed: 2, blocked: 1 });
    assert.equal(by(2).scored, false, "no review, no triage: unscored, never a made-up score");
    assert.equal(by(2).risk, null);
    assert.equal(by(2).priority, 30, "unscored ranks by waiting time only (capped)");
    assert.equal(by(5).outdated, true, "scores from another head commit are marked");
    assert.equal(by(4).priority < 0, true, "a draft sinks");
    assert.deepEqual(items.map((i) => i.rank), [1, 2, 3, 4, 5]);
  }
  ctx.diagnostic("priority: model scores, gates and verdict plus waiting time, size and draft; unscored ranks by wait");

  {
    const items = rankQueue([
      pr(1, { headRefName: "feat/a-1" }), pr(2, { headRefName: "feat/a-2", baseRefName: "feat/a-1" }), pr(3, { headRefName: "other", baseRefName: "feat/a-2" }),
      pr(4, { body: "Closes #12", headRefName: "x" }), pr(5, { title: "Docs for #12", headRefName: "y" }),
      pr(6, { headRefName: "team/ui/one" }), pr(7, { headRefName: "team/ui/two" }), pr(8, { headRefName: "solo" }),
    ], { reviews: [reviewed(5, { risk: 90, blast: 90 })], triage: {}, sla: {}, now });
    const g = (n: number) => items.find((i) => i.pr.number === n)!.group;
    assert.equal(g(1)?.id, g(2)?.id);
    assert.equal(g(2)?.id, g(3)?.id, "a PR based on another open PR's head joins its stack");
    assert.equal(g(1)?.size, 3);
    assert.equal(g(1)?.label, "stack on feat/a-1", "a stack names the group before a shared prefix");
    assert.equal(g(4)?.label, "#12");
    assert.equal(g(4)?.id, g(5)?.id);
    assert.equal(g(6)?.label, "team/ui/*");
    assert.equal(g(8), null);
    const order = items.map((i) => i.pr.number);
    assert.deepEqual(order.slice(0, 2), [5, 4], "a group follows its top member");
    assert.equal(Math.abs(order.indexOf(6) - order.indexOf(7)), 1, "group members sit together");
  }
  ctx.diagnostic("groups: linked issue, stacked bases, branch prefix; members adjacent");

  {
    const items = rankQueue([pr(1, { createdAt: ago(30), updatedAt: ago(1) }), pr(2, { createdAt: ago(5) }), pr(3, { createdAt: ago(30), isDraft: true }), pr(4, { url: "https://github.com/beta/x/pull/4", createdAt: ago(30) })], { reviews: [], triage: {}, sla: { acme: 24 }, now });
    const by = (n: number) => items.find((i) => i.pr.number === n)!;
    assert.equal(by(1).overdue, true, "SLA counts from when the PR was opened");
    assert.equal(by(2).overdue, false);
    assert.equal(by(3).overdue, false, "drafts are never overdue");
    assert.equal(by(4).overdue, false, "another organization's SLA");
    assert.equal(items[0].pr.number, 1);
  }
  ctx.diagnostic("SLA per organization: overdue from the opening time, drafts exempt");

  // ---- the routes ----
  type Item = { repo: string; pr: { number: number }; scored: boolean; risk: number | null; overdue: boolean; group: { label: string } | null };
  type Reply = { sections: { id: string; title: string; rows: unknown[][] }[]; items: Item[] };
  const get = async (path: string, token?: string) => {
    const res = await app.request(path, { headers: token ? { cookie: `pr_auth=${token}` } : {} });
    return { status: res.status, body: (await res.json()) as Reply };
  };
  {
    const r = await get("/api/review-next?org=gitea~acme", "towner");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([...new Set(r.body.items.map((i) => i.repo))].sort(), ["gitea~acme/api", "gitea~acme/secret"]);
    assert.equal(r.body.items[0].pr.number, 1, "triage risk 90 puts #1 first");
    assert.equal(r.body.items[0].risk, 90);
    assert.equal(r.body.items[1].pr.number, 2, "its stacked PR follows");
    assert.equal(r.body.items.find((i) => i.pr.number === 3)?.scored, false);
    assert.equal(r.body.items.find((i) => i.pr.number === 6)?.group?.label, "#40");
    assert.equal(r.body.sections[0].title, "Review next");
    const other = await get("/api/review-next?org=gitea~other", "towner");
    assert.deepEqual(other.body.items.map((i) => i.repo), ["gitea~other/tool"]);
    assert.equal((await get("/api/review-next?org=bad%20org", "towner")).status >= 400, true);
  }
  ctx.diagnostic("/api/review-next ranks only the active organization's open pull requests");

  {
    const r = await get("/api/review-next?org=gitea~acme", "tdev");
    assert.equal(r.status, 200);
    assert.deepEqual([...new Set(r.body.items.map((i) => i.repo))], ["gitea~acme/api"]);
    assert.ok(!JSON.stringify(r.body).includes("secret"));
    assert.deepEqual((await get("/api/review-next", "tdev")).body.items.map((i) => i.repo).filter((x) => x !== "gitea~acme/api"), [], "no org: still only assigned repositories");
    assert.equal((await get("/api/review-next")).status, 403, "signed out");
    const h = await get("/api/home?org=gitea~acme", "tdev");
    const next = h.body.sections.find((s) => s.id === "next");
    assert.ok(next && next.rows.length === 6, JSON.stringify(next));
    assert.ok(!JSON.stringify(h.body).includes("secret"));
  }
  ctx.diagnostic("developers see only assigned repositories, on the endpoint and on Home");

  {
    assert.equal((await app.request("/api/settings/queue?org=gitea~acme", { headers: { cookie: "pr_auth=tdev" } })).status, 403);
    const save = await app.request("/api/settings/queue?org=gitea~acme", { method: "POST", headers: { cookie: "pr_auth=towner", "content-type": "application/json" }, body: JSON.stringify({ queue: { slaHours: 48 } }) });
    assert.equal(save.status, 200, await save.text());
    assert.deepEqual(db.settings.reviewSla, { "gitea~acme": 48 });
    const page = (await (await app.request("/api/settings/queue?org=gitea~acme", { headers: { cookie: "pr_auth=towner" } })).json()) as { values: { queue: { slaHours: number } } };
    assert.equal(page.values.queue.slaHours, 48);
    const r = await get("/api/review-next?org=gitea~acme", "towner");
    assert.deepEqual(r.body.items.filter((i) => i.overdue).map((i) => i.pr.number), [3], "opened 100h ago; the 200h draft is exempt");
    const bad = await app.request("/api/settings/queue?org=gitea~acme", { method: "POST", headers: { cookie: "pr_auth=towner", "content-type": "application/json" }, body: JSON.stringify({ queue: { slaHours: -1 } }) });
    assert.equal(bad.status >= 400, true);
    await app.request("/api/settings/queue?org=gitea~acme", { method: "POST", headers: { cookie: "pr_auth=towner", "content-type": "application/json" }, body: JSON.stringify({ queue: { slaHours: 0 } }) });
    assert.deepEqual(db.settings.reviewSla, {});
  }
  ctx.diagnostic("Review queue settings: admin only, per organization, 0 turns the SLA off");
});
