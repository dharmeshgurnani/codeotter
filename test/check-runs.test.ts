// codeotter/checks as a GitHub check run (in progress, completed with scores, gates and annotations in batches of 50,
// failed with the model's error), the commit status fallback (no App on the repository, other git servers), and
// /override: requested reviewers (users and team members) only, never the author, only with the setting on; recorded,
// audited and republished. A temp CODEOTTER_HOME with file storage, PATH cut to node's directory (no gh), fetch stubbed.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("check runs and check overrides", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-check-runs-"));
  mkdirSync(join(home, "scores")); // the server creates it at startup
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), CODEOTTER_UPDATE_CHECK: "0", GITEA_URL: "https://gitea.example", GITEA_TOKEN: "gt" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

  type Call = { method: string; url: string; body: Record<string, unknown> | null; auth: string };
  const calls: Call[] = [];
  let routes: (c: Call) => Response | null = () => null;
  globalThis.fetch = async (input, init = {}) => {
    const c: Call = { method: init.method || "GET", url: String(input), body: init.body ? JSON.parse(String(init.body)) : null, auth: String(new Headers(init.headers).get("authorization") || "") };
    calls.push(c);
    return routes(c) || new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

  const mc = await import("../core/merge-checks.ts");
  const { store, auditStore } = await import("../core/store.ts");
  const { forgetAppTokens } = await import("../core/git.ts");
  const { parseCommand } = await import("../core/pr-tools.ts");
  type Gate = import("../core/engines.ts").Gate;
  type Finding = import("../core/engines.ts").Finding;
  type ReviewRecord = import("../core/review.ts").ReviewRecord;

  const SHA = "a".repeat(40);
  const gates: Gate[] = [
    { id: "security", label: "Security", yes: 0.9, pass: true },
    { id: "check_0", label: "Changelog entry", yes: 0.1, pass: false, mode: "block" },
    { id: "check_1", label: "Docs", yes: 0.2, pass: false, mode: "warn" },
  ];
  const finding = (i: number, extra: Partial<Finding> = {}): Finding => ({ file: `src/f${i}.ts`, line: i + 1, severity: (["high", "medium", "low", "nit"] as const)[i % 4], title: `Finding ${i}`, detail: `Detail ${i}`, ...extra });
  const record = (url: string, findings: Finding[], over: Partial<ReviewRecord> = {}): ReviewRecord => ({
    pr: { url, number: Number(url.split("/").pop()), title: "t", author: { login: "dev" }, baseRefName: "main", headRefName: "f", changedFiles: 1, additions: 1, deletions: 0, files: [], headRefOid: SHA },
    headSha: SHA,
    blast: { score: 30 } as ReviewRecord["blast"],
    review: { summary: "s", verdict: "comment", scores: { quality: 80, correctness_risk: 20, test_coverage: 50, readability: 70, pr_hygiene: 60 }, findings, walkthrough: [] },
    gates, engines: { llm: "x/y", s1: null }, model: "x/y", guide: null, learnings: [], linkedIssues: [], gitHistory: { prCommits: [], baseCommits: [] }, at: new Date().toISOString(),
    ...over,
  });

  // --- payloads
  assert.equal(mc.checkConclusion({ gates, review: { verdict: "approve" } as ReviewRecord["review"] }), "failure");
  assert.equal(mc.checkConclusion({ gates: gates.filter((g) => g.mode !== "block"), review: { verdict: "approve" } as ReviewRecord["review"] }), "neutral");
  assert.equal(mc.checkConclusion({ gates: [gates[0]], review: { verdict: "request_changes" } as ReviewRecord["review"] }), "neutral");
  assert.equal(mc.checkConclusion({ gates: [gates[0]], review: { verdict: "approve" } as ReviewRecord["review"] }), "success");
  const overAll = ["check_0", "check_1"].map((check) => ({ check, label: check, by: "rev", reason: "r", at: "", sha: SHA }));
  assert.equal(mc.checkConclusion({ gates, review: { verdict: "comment" } as ReviewRecord["review"], overrides: overAll }), "success");
  ctx.diagnostic("conclusion: blocking failure fails; changes requested or other failures are neutral; overrides pass");

  const ann = mc.checkAnnotations([
    finding(0, { startLine: 1, line: 4 }),
    finding(1, { dismissed: true }),
    finding(2, { line: undefined }),
    finding(3, { file: "../etc/passwd" }),
    finding(4, { file: "/src/abs.ts", startLine: 9, line: 5 }),
  ]);
  assert.deepEqual(ann.map((a) => [a.path, a.start_line, a.end_line, a.annotation_level]), [["src/f0.ts", 1, 4, "failure"], ["src/abs.ts", 5, 5, "failure"]]);
  ctx.diagnostic("annotations: only open findings with a safe path and a line; start never after end");

  const many = Array.from({ length: 120 }, (_, i) => finding(i));
  assert.deepEqual(mc.annotationBatches(many).map((b) => b.length), [50, 50, 20]);
  const bodies = mc.completedRunBodies(record("https://github.com/acme/app/pull/5", many), "2026-11-21T00:00:00.000Z");
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((b) => b.output.annotations?.length), [50, 50, 20]);
  assert.deepEqual([bodies[0].status, bodies[0].conclusion, bodies[1].status, bodies[1].conclusion], ["completed", "failure", undefined, undefined]);
  assert.ok(bodies.every((b) => b.output.title === "Failed: Changelog entry" && b.output.summary === bodies[0].output.summary));
  for (const s of ["| Quality | 80/100 |", "| Blast radius | 30/100 |", "| Changelog entry (blocking) | Failed |", "| Docs | Warning |", "120 findings, 120 annotated"]) assert.ok(bodies[0].output.summary.includes(s), s);
  assert.equal(mc.completedRunBodies(record("https://github.com/acme/app/pull/5", [])).length, 1, "no findings: one request, no annotations");
  ctx.diagnostic("completed run: 120 annotations go out as 50 + 50 + 20, conclusion and summary on the first");

  // --- the commit status stands in on other git servers, only when custom checks ran
  routes = (c) => (c.url.startsWith("https://gitea.example/api/v1/repos/acme/app/statuses/") ? json({}) : null);
  const forgeRec = record("https://gitea.example/acme/app/pulls/5", many);
  await mc.checksFinished("gitea~acme/app", forgeRec, true);
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace(/\?.*$/, "")]), [["POST", `https://gitea.example/api/v1/repos/acme/app/statuses/${SHA}`]]);
  assert.deepEqual([calls[0].body?.context, calls[0].body?.state], ["codeotter/checks", "failure"]);
  calls.length = 0;
  await mc.checksFinished("gitea~acme/app", { ...forgeRec, gates: [gates[0]] }, false);
  await mc.checksStarted("gitea~acme/app", SHA, forgeRec.pr.url, 0);
  assert.equal(calls.length, 0, "no custom checks: no status");
  ctx.diagnostic("other git servers: the codeotter/checks status, no check run");

  // --- GitHub without the App: the status through gh (cut from PATH here), never the Checks API
  await assert.rejects(mc.checksFinished("acme/app", record("https://github.com/acme/app/pull/5", []), true), /gh api/);
  assert.equal(calls.filter((c) => c.url.includes("check-runs")).length, 0);
  ctx.diagnostic("GitHub without an App: falls back to the commit status");

  // --- GitHub with the App installed: one check run, in progress then completed
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  await store.setSetting("githubApp", { id: 77, pem });
  forgetAppTokens();
  let installed = false;
  const reviewers = { users: [{ login: "rev" }], teams: [{ slug: "core" }] };
  routes = (c) => {
    const u = new URL(c.url);
    if (u.pathname === "/repos/acme/app/installation") return installed ? json({ id: 9 }) : null;
    if (u.pathname === "/app/installations/9/access_tokens") return json({ token: "inst-token", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (u.pathname === `/repos/acme/app/commits/${SHA}/check-runs`) return json({ check_runs: [] });
    if (u.pathname === "/repos/acme/app/check-runs" && c.method === "POST") return json({ id: 501 }, 201);
    if (u.pathname === "/repos/acme/app/check-runs/501" && c.method === "PATCH") return json({ id: 501 });
    if (u.pathname === "/repos/acme/app/pulls/5/requested_reviewers") return json(reviewers);
    if (u.pathname === "/orgs/acme/teams/core/memberships/teamie") return json({ state: "active" });
    if (u.pathname.startsWith("/api/v1/")) return null;
    return null;
  };
  assert.equal(await mc.checkRunsAvailable("acme/app"), false, "App configured, not installed on the repository");
  installed = true;
  forgetAppTokens();
  calls.length = 0;
  const url = "https://github.com/acme/app/pull/5";
  await mc.checksStarted("acme/app", SHA, url, 2);
  const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
  assert.ok(created);
  assert.deepEqual([created.body?.name, created.body?.head_sha, created.body?.status, created.auth], ["codeotter/checks", SHA, "in_progress", "Bearer inst-token"]);
  calls.length = 0;
  await mc.checksFinished("acme/app", record(url, many), true);
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 3);
  assert.ok(patches.every((p) => p.url.endsWith("/repos/acme/app/check-runs/501")));
  assert.deepEqual(patches.map((p) => (p.body?.output as { annotations?: unknown[] }).annotations?.length), [50, 50, 20]);
  assert.equal(patches[0].body?.conclusion, "failure");
  assert.equal(calls.filter((c) => c.url.includes("/statuses/")).length, 0, "no commit status next to the check run");
  calls.length = 0;
  await mc.checksFailed("acme/app", SHA, url, "Model provider answered 500: overloaded", true);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  const failed = calls.find((c) => c.method === "PATCH")!.body!;
  assert.equal(failed.conclusion, "failure");
  assert.match(String((failed.output as { summary: string }).summary), /Model provider answered 500: overloaded/);
  ctx.diagnostic("App installed: check run created in progress, completed in 3 requests, failure carries the error");

  // an App without "Checks: write" (created before it was asked for): 403, then the status, then no retry for a while
  const permitted = routes;
  routes = (c) => (new URL(c.url).pathname.startsWith("/repos/acme/old/check-runs") ? json({ message: "Resource not accessible by integration" }, 403) : new URL(c.url).pathname === "/repos/acme/old/installation" ? json({ id: 9 }) : permitted(c));
  calls.length = 0;
  await assert.rejects(mc.checksStarted("acme/old", SHA, "https://github.com/acme/old/pull/1", 1), /gh api/);
  await assert.rejects(mc.checksStarted("acme/old", SHA, "https://github.com/acme/old/pull/1", 1), /gh api/);
  assert.equal(calls.filter((c) => c.url.includes("check-runs")).length, 1, "refused once, then the status only");
  routes = permitted;
  ctx.diagnostic("Checks API refused (403): falls back to the commit status");

  // --- /override
  assert.deepEqual(parseCommand("/override all shipped separately"), { cmd: "override", arg: "all shipped separately" });
  const open = gates.filter((g) => !g.pass);
  assert.deepEqual(mc.parseOverride("changelog entry docs live in the wiki", open), { gates: [gates[1]], reason: "docs live in the wiki" });
  assert.deepEqual(mc.parseOverride('"Docs" later', open), { gates: [gates[2]], reason: "later" });
  assert.deepEqual(mc.parseOverride("all  <!-- codeotter:x --> ping @alice", open), { gates: open, reason: "ping @​alice" });
  assert.match((mc.parseOverride("Changelog entry", open) as { error: string }).error, /Give a reason/);
  assert.match((mc.parseOverride("Tests yes", open) as { error: string }).error, /No failing check named "Tests"\. Failing: Changelog entry, Docs/);
  ctx.diagnostic("override arguments: longest name, quoted name, all; reason required and sanitised");

  await store.put(record(url, many));
  // setting off (the default)
  assert.equal(await mc.overrideRefusal("acme/app", 5, "dev", { login: "rev" }), "Check overrides are off for this repository");
  await store.setSetting("repoSettings", { "acme/app": { review: { overrides: true } }, "gitea~acme/app": { review: { overrides: true } } });
  assert.equal(await mc.overrideRefusal("acme/app", 5, "dev", { login: "rev" }), "", "requested reviewer");
  assert.equal(await mc.overrideRefusal("acme/app", 5, "dev", { login: "teamie" }), "", "member of a requested team");
  assert.equal(await mc.overrideRefusal("acme/app", 5, "dev", { login: "DEV" }), "The pull request's author cannot override its checks");
  reviewers.users.push({ login: "dev" });
  assert.equal(await mc.overrideRefusal("acme/app", 5, "dev", { login: "dev" }), "The pull request's author cannot override its checks", "even when requested");
  assert.equal(await mc.overrideRefusal("acme/app", 5, "dev", { login: "other" }), "other is not a requested reviewer of this pull request");
  ctx.diagnostic("authorisation: requested reviewer and team member allowed; author and others refused");

  await assert.rejects(mc.overrideChecks("acme/app", 5, { login: "other" }, "all because"), /not a requested reviewer/);
  calls.length = 0;
  const reply = await mc.overrideChecks("acme/app", 5, { login: "rev" }, "Changelog entry added in #12 @alice");
  assert.match(reply, /\*\*Changelog entry\*\* overridden by `rev`: added in #12 @​alice\./);
  const stored = (await store.get(url)) as ReviewRecord;
  assert.deepEqual(stored.overrides?.map((o) => [o.check, o.by, o.sha]), [["check_0", "rev", SHA]]);
  const republished = calls.find((c) => c.method === "PATCH")!.body!;
  assert.equal(republished.conclusion, "neutral", "the warn check still fails");
  assert.match(String((republished.output as { summary: string }).summary), /\| Changelog entry \(blocking\) \| Overridden by rev \|/);
  calls.length = 0;
  await mc.overrideChecks("acme/app", 5, { login: "teamie" }, "all docs follow");
  assert.equal(calls.find((c) => c.method === "PATCH")!.body!.conclusion, "success");
  await assert.rejects(mc.overrideChecks("acme/app", 5, { login: "rev" }, "all again"), /No failing pre-merge checks/);
  const log = (await auditStore.list({ page: 1, perPage: 50 })).items;
  assert.deepEqual(log.filter((e) => e.action.startsWith("check.override")).map((e) => [e.action, e.actorName]).reverse(), [["check.override.refused", "other"], ["check.override", "rev"], ["check.override", "teamie"]]);
  assert.deepEqual(mc.keptOverrides(stored.overrides, SHA)?.length, 1);
  assert.equal(mc.keptOverrides(stored.overrides, "b".repeat(40)), undefined, "a review of a later commit starts without them");
  assert.deepEqual(mc.checksStatus(gates, overAll), { state: "success", description: "0/2 passed; overridden: Changelog entry, Docs" });
  ctx.diagnostic("overrides: stored per head commit, audited (refusals too), republished; status description names them");

  // --- the forge equivalent: Gitea's requested reviewers and teams
  routes = (c) => {
    const u = new URL(c.url);
    if (u.pathname === "/api/v1/repos/acme/app/pulls/5") return json({ number: 5, requested_reviewers: [{ login: "gr" }], requested_reviewers_teams: [{ id: 3 }] });
    if (u.pathname === "/api/v1/teams/3/members/gt") return json({ login: "gt" });
    return null;
  };
  assert.equal(await mc.overrideRefusal("gitea~acme/app", 5, "dev", { login: "gr" }), "");
  assert.equal(await mc.overrideRefusal("gitea~acme/app", 5, "dev", { login: "gt" }), "");
  assert.equal(await mc.overrideRefusal("gitea~acme/app", 5, "dev", { login: "nobody" }), "nobody is not a requested reviewer of this pull request");
  assert.equal(await mc.overrideRefusal("gitea~acme/app", 5, "gr", { login: "gr" }), "The pull request's author cannot override its checks");
  ctx.diagnostic("Gitea: requested reviewers and requested team members allowed, others and the author refused");
});
