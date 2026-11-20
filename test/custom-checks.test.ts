// Custom pre-merge checks: settings normalisation, System One questions (chunked for local runtimes), the language-model
// path when no System One model is configured, the codeotter/checks status decision and the PR comment rows.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("custom pre-merge checks", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-checks-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, CODEOTTER_UPDATE_CHECK: "0" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  let handler: (url: string, body: Record<string, unknown>) => unknown = (url) => { throw new Error(`unexpected fetch ${url}`); };
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify(handler(String(input), body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

  const { normalizeChecks, normalizeReview, REVIEW_DEFAULTS } = await import("../core/context.ts");
  const { judge, s1Questions, scoreWithSystemOne } = await import("../core/engines.ts");
  const { sidecars } = await import("../core/local-models.ts");
  const { checksStatus } = await import("../core/review.ts");
  const { formatReviewComment, formatScoresComment } = await import("../core/comments.ts");
  type LocalModel = import("../core/local-models.ts").LocalModel;
  type Gate = import("../core/engines.ts").Gate;

  // --- settings: untrusted input in, clean checks out
  const checks = normalizeChecks([
    { name: "Changelog", instructions: "Does a change to a public API come with a CHANGELOG entry?", mode: "block" },
    { name: "Off one", instructions: "Is it Friday?", mode: "off" },
    { name: "", instructions: "  Are new   env vars documented?  ", mode: "bogus" },
    { name: "No question", instructions: "   " },
    null,
    "text",
  ]);
  assert.deepEqual(checks, [
    { name: "Changelog", instructions: "Does a change to a public API come with a CHANGELOG entry?", mode: "block" },
    { name: "Off one", instructions: "Is it Friday?", mode: "off" },
    { name: "Check 3", instructions: "Are new env vars documented?", mode: "warn" },
  ]);
  assert.equal(normalizeChecks(Array.from({ length: 30 }, (_, i) => ({ instructions: `q${i}` }))).length, 20);
  assert.deepEqual(normalizeReview({ ...REVIEW_DEFAULTS, checks: "nope" }).checks, []);
  assert.deepEqual(normalizeReview({ ...REVIEW_DEFAULTS, checks }).checks, checks);
  ctx.diagnostic("checks normalised: empty dropped, mode defaults to warn, at most 20");

  // --- System One: custom checks become noul gates after the built-in ones; "off" is not asked
  const { questions } = s1Questions({}, null, [], checks);
  const keys = Object.keys(questions);
  assert.equal(keys.filter((k) => k.startsWith("score_")).length, 6);
  assert.deepEqual(keys.filter((k) => k.startsWith("gate_check_")), ["gate_check_0", "gate_check_2"]);
  assert.deepEqual(questions.gate_check_0, { type: "noul", instructions: checks[0].instructions });
  assert.equal(keys.length, 6 + 7 + 2);
  ctx.diagnostic("questions: 6 scores, 7 built-in gates, 2 active custom checks");

  // A local runtime answers at most maxQuestions per request: the 15 questions arrive in chunks of 8 or fewer.
  const local = { id: "laya-test", kind: "s1", label: "Laya", maxQuestions: 8, contextChars: 4000 } as unknown as LocalModel;
  Object.assign(sidecars.s1, { id: local.id, starting: Promise.resolve(5999) });
  const sizes: number[] = [];
  handler = (url, body) => {
    assert.equal(url, "http://127.0.0.1:5999/v1/systemone");
    const qs = body.questions as Record<string, { type: string }>;
    sizes.push(Object.keys(qs).length);
    const answers = Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, q.type === "score" ? { score: 2 } : { noul: k === "gate_check_0" ? 0.9 : k === "gate_check_2" ? 0.2 : 0.6 }]));
    return { answers };
  };
  const pr = { url: "https://github.com/acme/api/pull/7", number: 7, title: "Add endpoint", body: "Adds /v2/users", author: { login: "dev" }, baseRefName: "main", headRefName: "feat", changedFiles: 1, additions: 3, deletions: 1, files: [{ path: "src/api.ts", additions: 3, deletions: 1 }] };
  const diff = "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,2 +1,4 @@\n ctx\n+export const v2 = 1;\n";
  const s1 = { provider: "laya", local, model: "laya", baseUrl: "", apiKey: "", contextChars: 4000, enabled: true };
  const typed = await scoreWithSystemOne(pr, diff, s1, null, null, null, [], [], null, null, [], checks);
  assert.ok(sizes.length >= 2 && sizes.every((n) => n <= 8), `chunks of at most 8, got ${sizes.join(",")}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 15);
  const custom = typed.gates.filter((g) => g.mode);
  assert.deepEqual(custom, [
    { id: "check_0", label: "Changelog", yes: 0.9, pass: true, mode: "block" },
    { id: "check_2", label: "Check 3", yes: 0.2, pass: false, mode: "warn" },
  ]);
  assert.equal(typed.gates.length, 9);
  ctx.diagnostic("System One answers custom checks in chunks of at most maxQuestions");

  // --- no System One: the language model answers the checks in its JSON
  let prompt = "";
  const llm = { provider: "openai", api: "openai", baseUrl: "http://llm.test/v1", model: "gpt-test", apiKey: "k", source: "settings" as const };
  const reply = (checksJson: string) => {
    handler = (url, body) => {
      assert.equal(url, "http://llm.test/v1/chat/completions");
      prompt = String((body.messages as { content: string }[])[0].content);
      return { choices: [{ message: { content: `{"summary":"ok","verdict":"comment","scores":{"quality":70,"correctness_risk":20,"test_coverage":50,"readability":80,"pr_hygiene":60,"blast_radius":10},"findings":[],"walkthrough":[]${checksJson}}` } }] };
    };
  };
  const r = { ...REVIEW_DEFAULTS, reflectMin: 0 };
  reply(`,"checks":{"check_0":false,"check_2":true}`);
  const j = await judge(pr, diff, llm, r, null, true, null, null, [], [], null, null, [], checks);
  assert.ok(prompt.includes(`- check_0: ${checks[0].instructions}`) && prompt.includes("- check_2: Are new env vars documented?") && !prompt.includes("Is it Friday?"));
  assert.ok(prompt.includes('"checks":{"check_0":true|false,"check_2":true|false}'));
  assert.deepEqual(j.checks, [
    { id: "check_0", label: "Changelog", yes: 0, pass: false, mode: "block" },
    { id: "check_2", label: "Check 3", yes: 1, pass: true, mode: "warn" },
  ]);
  reply(`,"checks":{"check_0":true}`);
  await assert.rejects(judge(pr, diff, llm, r, null, true, null, null, [], [], null, null, [], checks), /did not answer the pre-merge check\(s\): Check 3/);
  reply("");
  const plain = await judge(pr, diff, llm, r, null, true);
  assert.equal(plain.checks, undefined);
  assert.ok(!prompt.includes('"checks"'));
  ctx.diagnostic("language model answers checks when no System One model is configured; a missing answer fails");

  // --- codeotter/checks: block failures fail, warn failures pass with a note
  const g = (id: string, pass: boolean, mode?: "warn" | "block"): Gate => ({ id, label: id, yes: pass ? 1 : 0, pass, ...(mode ? { mode } : {}) });
  assert.equal(checksStatus([g("security", false)]), null);
  assert.deepEqual(checksStatus([g("security", false), g("A", true, "block"), g("B", true, "warn")]), { state: "success", description: "All 2 checks passed" });
  assert.deepEqual(checksStatus([g("A", true, "block"), g("B", false, "warn")]), { state: "success", description: "1/2 passed; warning: B" });
  assert.deepEqual(checksStatus([g("A", false, "block"), g("B", false, "warn")]), { state: "failure", description: "Failed: A; warning: B" });
  ctx.diagnostic("status: failure only for failed block checks");

  // --- PR comments: blocking failures read Failed, user text cannot break the table
  const record = { pr: { ...pr }, blast: { score: 10, files: 1, lines: 4, dirs: 1, hotspots: [], testFiles: 0, outsideCallers: 0, outsideFiles: 0 }, review: { summary: "s", verdict: "comment" as const, scores: j.scores, findings: [], walkthrough: [] }, gates: [{ ...g("check_0", false, "block"), label: "Change|log <!-- x -->" }, g("Docs", false, "warn")] };
  const scoresBody = formatScoresComment(record);
  assert.ok(scoresBody.includes("| Change log !-- x -- (blocking) | ❌ Failed (0% yes) |"), scoresBody);
  assert.ok(scoresBody.includes("| Docs | ⚠️ Warning (0% yes) |"));
  const reviewBody = formatReviewComment(record);
  assert.ok(reviewBody.includes("#### Pre-merge checks") && reviewBody.includes("| Change log !-- x -- (blocking) | ❌ Failed |"));
  ctx.diagnostic("comments show pass/fail/warn per custom check");
});
