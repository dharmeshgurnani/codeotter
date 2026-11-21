// Learned rules (core/learned.ts): reactions read through each adapter, signal aggregated from a stored review and its
// inline threads, candidate rules drafted by the (stubbed) model and never invented when it fails, auto-promotion, rule
// health switching a rule off (audited) unless locked, and the Learnings row actions. A temp CODEOTTER_HOME with file
// storage; fetch answers for a Gitea server, a GitLab server and an OpenAI-compatible model, and refuses anything else.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("learned rules", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-learned-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), GITEA_URL: "https://git.example", GITEA_TOKEN: "gt-token", CODEOTTER_UPDATE_CHECK: "0" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

  type Sent = { method: string; url: string; auth: string; body?: unknown };
  let sent: Sent[] = [];
  let threads: Record<string, unknown>[] = [];
  let reactions: Record<number, unknown[]> = {};
  let model: () => Response = () => Response.json({ choices: [{ message: { content: '{"rule":"Do not flag any in test helpers"}' } }] });
  const prompts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), method = init.method || "GET";
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, url, auth: String((init.headers as Record<string, string> | undefined)?.authorization || ""), body });
    const u = new URL(url);
    if (u.origin === "https://llm.example") {
      prompts.push(String((body as { messages?: { content?: string }[] }).messages?.at(-1)?.content || ""));
      return model();
    }
    if (u.origin === "https://git.example") {
      const path = u.pathname.replace(/^\/api\/v1\//, "");
      if (/\/pulls\/\d+\/reviews$/.test(path)) return Response.json(u.searchParams.get("page") === "1" ? [{ id: 11, state: "COMMENT" }] : []);
      if (/\/reviews\/11\/comments$/.test(path)) return Response.json(threads);
      const r = /issues\/comments\/(\d+)\/reactions$/.exec(path);
      if (r) return Response.json(reactions[Number(r[1])] || []);
      if (path.startsWith("api/v4/")) return new Response("not found", { status: 404 });
    }
    if (u.origin === "https://gitlab.example") {
      if (u.pathname === "/api/v4/projects/grp%2Fapp/merge_requests/7/notes/55/award_emoji") return Response.json([{ name: "thumbsdown" }, { name: "thumbsup" }, { name: "thumbsdown" }, { name: "eyes" }]);
      return new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const { makeForge, countReactions } = await import("../core/forges.ts");
  const { store, auditStore } = await import("../core/store.ts");
  await store.init();
  const { ruleId, setRepoLearnings, getRepoLearnings } = await import("../core/context.ts");
  const learned = await import("../core/learned.ts");
  type ReviewRecord = import("../core/review.ts").ReviewRecord;

  // <reactions per adapter>
  {
    assert.deepEqual(countReactions({ "+1": 2, "-1": 1, heart: 1, confused: 1, laugh: 4, url: "x", total_count: 9 }), { up: 3, down: 2 }, "GitHub's rollup");
    const gitea = makeForge("gitea", { kind: "gitea", label: "Gitea", url: "https://git.example", token: "gt-token" });
    reactions = { 900: [{ content: "-1" }, { content: "+1" }, { content: "-1" }, { content: "eyes" }] };
    sent = [];
    assert.deepEqual(await gitea.reactions!("gitea~acme/shop", 5, { id: 900, body: "", created_at: "", user: { id: 1, login: "x" }, bot: false, path: "a", line: 1, hunk: "" }), { up: 1, down: 2 });
    assert.equal(sent[0].url, "https://git.example/api/v1/repos/acme/shop/issues/comments/900/reactions");
    assert.equal(sent[0].auth, "token gt-token");
    const gitlab = makeForge("gitlab", { kind: "gitlab", label: "GitLab", url: "https://gitlab.example", token: "gl-token" });
    sent = [];
    assert.deepEqual(await gitlab.reactions!("gitlab~grp/app", 7, { id: 55, body: "", created_at: "", user: { id: 1, login: "x" }, bot: false, path: "a", line: 1, hunk: "" }), { up: 1, down: 2 });
    assert.equal(sent[0].auth, "Bearer gl-token");
    assert.equal(makeForge("bitbucket", { kind: "bitbucket", label: "Bitbucket", url: "https://api.bitbucket.org", token: "b" }).reactions, undefined, "no reactions API: skipped");
    // an id that is not a number never reaches a path
    sent = [];
    assert.deepEqual(await gitea.reactions!("gitea~acme/shop", 5, { id: "../x", body: "", created_at: "", user: { id: 1, login: "x" }, bot: false, path: "a", line: 1, hunk: "" }), { up: 0, down: 0 });
    assert.equal(sent.length, 0);
  }
  ctx.diagnostic("reactions: GitHub rollup, Gitea/Forgejo reactions, GitLab award emoji folded to up/down; none where the server has no API");

  // a stored review on a Gitea pull request and its inline threads
  const repo = "gitea~acme/shop";
  const pr = (n: number) => `https://git.example/acme/shop/pulls/${n}`;
  const rule = "Flag every use of any in request handlers";
  await store.setSetting("llm", { provider: "custom", baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" });
  await setRepoLearnings(repo, [rule]);
  const finding = (file: string, title: string, extra: object = {}) => ({ file, line: 3, severity: "medium" as const, title, detail: `${title}: tighten the type.`, ...extra });
  const put = (n: number, findings: object[], resolved: object[] = []) => store.put({
    pr: { url: pr(n), number: n, title: "t" }, review: { findings, summary: "", verdict: "comment", scores: {} },
    ...(resolved.length ? { incremental: { prevSha: "a", headSha: "b", newCommits: [], resolvedFindings: resolved } } : {}),
  } as unknown as ReviewRecord);
  const rootOf = (id: number, f: { file: string; title: string }) => ({ id, body: `<!-- codeotter:suggestion:${f.file}:3 -->\n🦦 **CodeOtter [MEDIUM]** — **${f.title}** (\`${f.file}:L3\`)`, created_at: "2026-11-20T09:00:00Z", user: { id: 1, login: "otter" }, path: f.file, position: 3 });
  const f1 = finding("src/api.ts", "Avoid any in the handler", { rule: ruleId(rule) });
  const f2 = finding("src/parse.ts", "Avoid any in the parser", { dismissed: true });
  const f3 = finding("src/db.ts", "Close the connection on error");
  await put(5, [f1, f2], [f3]);
  threads = [rootOf(900, f1), { id: 901, body: "Handlers here take any by design.", created_at: "2026-11-20T10:00:00Z", user: { id: 7, login: "dev" }, path: f1.file, position: 3 }];
  reactions = { 900: [{ content: "-1" }, { content: "-1" }] };

  // <aggregation and a drafted candidate>
  {
    prompts.length = 0;
    assert.equal(await learned.collectFeedback(repo, pr(5)), 3);
    const st = await learned.loadLearned(repo);
    const s1 = st.signals.find((s) => s.title === f1.title)!;
    assert.deepEqual([s1.up, s1.down, s1.outcome, s1.rule, s1.replies], [0, 2, "open", ruleId(rule), ["Handlers here take any by design."]]);
    assert.equal(st.signals.find((s) => s.title === f2.title)?.outcome, "dismissed");
    assert.equal(st.signals.find((s) => s.title === f3.title)?.outcome, "fixed");
    assert.equal(st.rules[ruleId(rule)].down, 2, "reactions count toward the rule the finding enforces");
    assert.equal(prompts.length, 1, "two similar findings pushed back on: one model call");
    assert.match(prompts[0], /Avoid any in the handler/);
    assert.match(prompts[0], /2 thumbs down/);
    assert.match(prompts[0], /Reply: Handlers here take any by design\./);
    assert.match(prompts[0], /dismissed it/);
    const cand = st.rules[ruleId("Do not flag any in test helpers")];
    assert.deepEqual([cand.status, cand.source, cand.support], ["suggested", "model", 2]);
    assert.deepEqual(await getRepoLearnings(repo), [rule], "a suggestion is not applied (auto-promotion off)");
    // a second collection does not draft the same pushback again, and reactions are set, not added twice
    prompts.length = 0;
    await learned.collectFeedback(repo, pr(5));
    assert.equal(prompts.length, 0);
    assert.equal((await learned.loadLearned(repo)).rules[ruleId(rule)].down, 2);
    // the PR closed: the finding still open counts as ignored, once
    await learned.collectFeedback(repo, pr(5), true);
    await learned.collectFeedback(repo, pr(5), true);
    const closed = await learned.loadLearned(repo);
    assert.equal(closed.signals.find((s) => s.title === f1.title)?.outcome, "ignored");
    assert.deepEqual([closed.rules[ruleId(rule)].ignored, closed.rules[ruleId(rule)].fixed], [1, 0]);
  }
  ctx.diagnostic("signal: reactions, replies, dismissed, fixed by a push, ignored at close; similar pushback drafts one suggested rule through the model");

  // <the model fails: nothing is invented>
  {
    const other = "gitea~acme/other";
    const prO = "https://git.example/acme/other/pulls/9";
    threads = [];
    await store.put({ pr: { url: prO, number: 9, title: "t" }, review: { findings: [finding("a.ts", "Magic number in retry loop", { dismissed: true }), finding("b.ts", "Magic number in backoff loop", { dismissed: true })], summary: "", verdict: "comment", scores: {} } } as unknown as ReviewRecord);
    for (const reply of [() => new Response("overloaded", { status: 503 }), () => Response.json({ choices: [{ message: { content: "Sure! Here is a rule: never flag magic numbers" } }] }), () => Response.json({ choices: [{ message: { content: '{"rule":42}' } }] })]) {
      model = reply;
      await learned.collectFeedback(other, prO);
      const st = await learned.loadLearned(other);
      assert.deepEqual(Object.keys(st.rules), [], "no rule without the model's own text");
      assert.ok(st.error, "the model's failure is kept for the settings page");
      assert.ok(st.signals.every((s) => !s.used), "the pushback is tried again next time");
    }
    model = () => Response.json({ choices: [{ message: { content: '{"rule":""}' } }] });
    await learned.collectFeedback(other, prO);
    const none = await learned.loadLearned(other);
    assert.deepEqual(Object.keys(none.rules), [], "no shared pattern: no rule");
    assert.ok(none.signals.every((s) => s.used === "none") && !none.error, "and the model is not asked again");
  }
  ctx.diagnostic("a failed, non-JSON or non-string model answer suggests nothing and keeps the error; an empty rule is final");

  // <auto-promotion: a per-repository setting, default off>
  {
    const promo = "gitea~acme/promo";
    const prP = "https://git.example/acme/promo/pulls/3";
    await store.setSetting("repoSettings", { ...((await store.getSetting("repoSettings")) || {}), [promo]: { review: { autoLearn: true, promoteAfter: 2 } } });
    model = () => Response.json({ choices: [{ message: { content: '{"rule":"Do not flag missing JSDoc on private helpers"}' } }] });
    await store.put({ pr: { url: prP, number: 3, title: "t" }, review: { findings: [finding("a.ts", "Missing JSDoc on helper", { dismissed: true }), finding("b.ts", "Missing JSDoc on private helper", { dismissed: true })], summary: "", verdict: "comment", scores: {} } } as unknown as ReviewRecord);
    await learned.collectFeedback(promo, prP);
    assert.deepEqual(await getRepoLearnings(promo), ["Do not flag missing JSDoc on private helpers"]);
    const on = (await auditStore.list({ action: "rule.auto-on", page: 1, perPage: 10 })).items;
    assert.deepEqual([on.length, on[0]?.actor, on[0]?.target, on[0]?.org], [1, "auto", promo, "gitea~acme"]);
  }
  ctx.diagnostic("auto-promotion on: a suggestion with enough support switches on by itself, audited");

  // <rule health: switch off below the fix rate, unless locked>
  {
    const rc = { ruleMinSamples: 5, ruleMinFixRate: 20 };
    const h = (fixed: number, ignored: number, extra: object = {}) => ({ text: "r", status: "active" as const, source: "team" as const, fixed, ignored, dismissed: 0, up: 0, down: 0, evidence: [], support: 0, at: "", ...extra });
    assert.equal(learned.shouldSwitchOff(h(0, 4), rc), false, "under the minimum sample");
    assert.equal(learned.shouldSwitchOff(h(0, 5), rc), true);
    assert.equal(learned.shouldSwitchOff(h(1, 4), rc), false, "20% fixed is not below 20%");
    assert.equal(learned.shouldSwitchOff(h(0, 9, { locked: true }), rc), false, "locked");
    assert.equal(learned.shouldSwitchOff(h(0, 9), { ...rc, ruleMinFixRate: 0 }), false, "0: never");

    // the repository's rule has 4 ignored findings; one more ignored at close reaches the sample and switches it off
    const st = await learned.loadLearned(repo);
    st.rules[ruleId(rule)] = { ...st.rules[ruleId(rule)], ignored: 4, fixed: 0 };
    await store.setSetting(`learned:${repo}`, st);
    // a second learning, locked, with the same history
    const kept = "Flag every unchecked cast";
    await setRepoLearnings(repo, [rule, kept]);
    const st2 = await learned.loadLearned(repo);
    st2.rules[ruleId(kept)] = { ...h(0, 4, { locked: true }), text: kept };
    await store.setSetting(`learned:${repo}`, st2);
    const g1 = finding("src/x.ts", "Untyped body in handler", { rule: ruleId(rule) });
    const g2 = finding("src/y.ts", "Unchecked cast of the body", { rule: ruleId(kept) });
    await put(6, [g1, g2]);
    threads = [];
    await learned.collectFeedback(repo, pr(6), true);
    assert.deepEqual(await getRepoLearnings(repo), [kept], "switched off; the locked rule stays");
    const after = await learned.loadLearned(repo);
    assert.deepEqual([after.rules[ruleId(rule)].status, after.rules[ruleId(kept)].status, after.rules[ruleId(kept)].ignored], ["off", "active", 5]);
    const off = (await auditStore.list({ action: "rule.auto-off", page: 1, perPage: 10 })).items;
    assert.deepEqual([off.length, off[0]?.actor, off[0]?.target, off[0]?.detail.ignored], [1, "auto", repo, 5]);

    // the table: status badges and counts
    const { rows } = await learned.repoRules(repo);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[ruleId(kept)].status, "locked");
    assert.equal(byId[ruleId(rule)].status, "off");
    assert.equal(byId[ruleId("Do not flag any in test helpers")].status, "suggested");

    // row actions: locked cannot be switched; an off rule cannot be locked; switch on starts the counts over; accept
    await assert.rejects(learned.ruleAction(repo, ruleId(kept), "switch"), /Unlock/);
    await assert.rejects(learned.ruleAction(repo, ruleId(rule), "lock"), /active/);
    assert.equal(await learned.ruleAction(repo, ruleId(rule), "switch"), "Rule switched on.");
    assert.equal((await learned.loadLearned(repo)).rules[ruleId(rule)].ignored, 0);
    assert.equal(await learned.ruleAction(repo, ruleId("Do not flag any in test helpers"), "accept"), "Rule accepted.");
    assert.deepEqual(await getRepoLearnings(repo), [kept, rule, "Do not flag any in test helpers"]);
    assert.equal(await learned.ruleAction(repo, ruleId(kept), "lock"), "Rule unlocked.");
    await assert.rejects(learned.ruleAction(repo, "000000000000", "accept"), /Unknown rule/);
  }
  ctx.diagnostic("rule health: switched off below the fix rate after the minimum sample, audited; locked rules stay; row actions");

  // <findings tie to a learning only through its number in the prompt>
  {
    const { judge } = await import("../core/engines.ts");
    const { REVIEW_DEFAULTS } = await import("../core/context.ts");
    type PullRequest = import("../core/context.ts").PullRequest;
    const findings = [{ file: "a.ts", line: 1, title: "one", detail: "d", rule: 1 }, { file: "b.ts", line: 1, title: "two", detail: "d", rule: "abcdef123456" }, { file: "c.ts", line: 1, title: "three", detail: "d", rule: 9 }];
    model = () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "s", verdict: "comment", findings, walkthrough: [] }) } }] });
    prompts.length = 0;
    const pr0 = { number: 1, title: "t", body: "", author: { login: "dev" }, baseRefName: "main", headRefName: "f", changedFiles: 1, additions: 1, deletions: 0 } as unknown as PullRequest;
    const j = await judge(pr0, "diff --git a/a.ts b/a.ts\n", { provider: "custom", api: "openai", baseUrl: "https://llm.example/v1", model: "m", apiKey: "k", source: "settings" }, { ...REVIEW_DEFAULTS, reflectMin: 0 }, null, false, null, null, [], ["Rule A", "Rule B"]);
    assert.deepEqual(j.findings.map((f) => f.rule), [ruleId("Rule A"), undefined, undefined], "a number in range only; a forged id or out-of-range number is dropped");
    assert.match(prompts[0], /1\. Rule A\n2\. Rule B/);
  }
  ctx.diagnostic("judge(): a finding's rule is the learning its number names; anything else is dropped");
});
