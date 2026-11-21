// "Fix with AI": agent prompts, the patch check behind /fix, and /fix itself with the model, store, forge and posting
// stubbed. The pure parts run from core/fix.ts in a temp CODEOTTER_HOME; /fix runs its real <fix-command> block.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serverBlocks } from "./helpers/server-blocks.ts";
import type { Finding } from "../core/engines.ts";

test("Fix with AI: prompts, patch check, /fix", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-fix-"));
  process.env.CODEOTTER_HOME = home;
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });
  const fix = await import("../core/fix.ts");
  const { deriveSuggestionFromDetail } = await import("../core/engines.ts");

  const diff = [
    "diff --git a/src/cart.js b/src/cart.js",
    "--- a/src/cart.js",
    "+++ b/src/cart.js",
    "@@ -1,4 +1,5 @@",
    " export function total(items) {",
    "-  return sum(items);",
    "+  const t = sum(items);",
    "+  return t * 1.15;",
    " }",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const hunk = fix.hunkAt(diff, "src/cart.js", 3);
  assert.ok(hunk.startsWith("@@ -1,4 +1,5 @@") && hunk.includes("+  return t * 1.15;") && !hunk.includes("README"), hunk);
  assert.equal(fix.hunkAt(diff, "nope.js", 1), "");
  ctx.diagnostic("hunkAt picks the file's hunk");

  // Prompts: repo without provider prefix, PR, branch, file:line, finding, hunk, suggested fix, guide note.
  const f: Finding = { file: "src/cart.js", line: 3, severity: "high", title: "Tax applied twice", detail: "total() multiplies by 1.15 after sum() already adds tax.", suggestion: "  return t;", hunk };
  const pctx = { repo: "forgejo~acme/shop", pr: { url: "https://git.example/acme/shop/pulls/7", number: 7, title: "fix totals", headRefName: "fix-tax", baseRefName: "main" }, guide: "AGENTS.md + CLAUDE.md" };
  const one = fix.findingPrompt(pctx, f);
  for (const part of ["pull request #7", "in acme/shop.", "https://git.example/acme/shop/pulls/7", "Branch: fix-tax (merging into main)", "[HIGH] src/cart.js:L3: Tax applied twice", "multiplies by 1.15", "```diff\n@@ -1,4 +1,5 @@", "Suggested replacement for line 3:\n```\n  return t;\n```", "read AGENTS.md + CLAUDE.md at the repository root"]) {
    assert.ok(one.includes(part), `prompt has ${part}\n${one}`);
  }
  assert.ok(!one.includes("forgejo~"), "no internal provider prefix");
  const all = fix.allFindingsPrompt(pctx, [f, { file: "README.md", severity: "low", title: "Typo", detail: "" }]);
  assert.ok(all.includes("Fix 2 findings") && all.includes("1. [HIGH] src/cart.js:L3") && all.includes("2. [LOW] README.md: Typo"), all);
  assert.equal(fix.allFindingsPrompt(pctx, []), "");
  const prompts = fix.reviewPrompts({ pr: pctx.pr, guide: null, review: { findings: [f, { ...f, dismissed: true }] } }, "acme/shop");
  assert.equal(prompts.findings.length, 2);
  assert.equal(prompts.findings[1], "", "dismissed findings get no prompt");
  assert.ok(prompts.all.includes("Fix 1 finding ") && !prompts.all.includes("Repository instructions"));
  ctx.diagnostic("finding and all-findings prompts");

  // Posted block: collapsed, fenced longer than any backtick run inside, comment markers broken up.
  const details = fix.promptDetails("x ```` y <!-- codeotter:review -->");
  assert.ok(details.startsWith("<details>\n<summary>🤖 Prompt for AI agents</summary>") && details.endsWith("</details>"));
  assert.ok(details.includes("`````text\n") && !details.includes("<!-- codeotter:review -->"), details);
  assert.equal(fix.promptDetails(""), "");
  ctx.diagnostic("collapsed prompt block is safe to post");

  // Suggestions keep the first line's indentation (committed as is).
  assert.equal(deriveSuggestionFromDetail({ file: "a.js", line: 2, title: "t", suggestion: "\n    return 1;\n  }\n" }).suggestion, "    return 1;\n  }");
  assert.equal(deriveSuggestionFromDetail({ file: "a.js", line: 2, title: "t", suggestion: "```js\n  x();\n```" }).suggestion, "  x();");
  ctx.diagnostic("suggestions keep indentation");

  // Patch check: applies in memory against the head, with offset; mismatches, other files and overlaps are rejected.
  const head = "export function total(items) {\n  const t = sum(items);\n  return t * 1.15;\n}\n";
  const files = new Map([["src/cart.js", head]]);
  const good = "Here you go:\n```diff\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ -2,3 +2,3 @@\n   const t = sum(items);\n-  return t * 1.15;\n+  return t;\n }\n```";
  assert.deepEqual(fix.patchReplacements(fix.extractPatch(good), files), { ok: [{ file: "src/cart.js", startLine: 3, endLine: 3, text: "  return t;" }], rejected: [] });
  const offset = "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -40,2 +40,2 @@\n-  return t * 1.15;\n+  return t;\n }";
  assert.deepEqual(fix.patchReplacements(offset, files).ok, [{ file: "src/cart.js", startLine: 3, endLine: 3, text: "  return t;" }], "a wrong line number within reach still applies");
  const stale = "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -2,1 +2,1 @@\n-  return sum(items) * 2;\n+  return 0;";
  assert.deepEqual(fix.patchReplacements(stale, files).ok, []);
  assert.match(fix.patchReplacements(stale, files).rejected[0], /does not match the head/);
  assert.match(fix.patchReplacements("--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b", files).rejected[0], /not a file of the findings/);
  assert.match(fix.patchReplacements("no diff here", files).rejected[0], /no unified diff/);
  const overlap = "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -3 +3 @@\n-  return t * 1.15;\n+  return t;\n@@ -3 +3 @@\n-  return t * 1.15;\n+  return t + 0;";
  assert.equal(fix.patchReplacements(overlap, files).ok.length, 1);
  assert.match(fix.patchReplacements(overlap, files).rejected[0], /overlaps/);
  // a pure insertion takes in the context line above it; a pure deletion too
  const insert = "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -2,2 +2,3 @@\n   const t = sum(items);\n+  if (!t) return 0;\n   return t * 1.15;";
  assert.deepEqual(fix.patchReplacements(insert, files).ok, [{ file: "src/cart.js", startLine: 2, endLine: 2, text: "  const t = sum(items);\n  if (!t) return 0;" }]);
  const del = "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1,3 +1,2 @@\n export function total(items) {\n-  const t = sum(items);\n   return t * 1.15;";
  assert.deepEqual(fix.patchReplacements(del, files).ok, [{ file: "src/cart.js", startLine: 1, endLine: 2, text: "export function total(items) {" }]);
  // a removed SQL-style "-- " line is not a file header
  assert.equal(fix.parsePatch("--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- old comment\n select 1;")[0].lines[0], "--- old comment");
  assert.match(fix.patchReplacements("--- a/src/cart.js\n+++ b/src/cart.js\n@@ -3 +3 @@\n-  return t * 1.15;\n+  x = ```", files).rejected[0], /code fence/);
  ctx.diagnostic("patches are checked against the head before posting");

  // /fix: real <fix-command> block, stubbed model, store and posting.
  const pr = { url: "https://github.com/acme/shop/pull/7", number: 7, title: "fix totals", headRefName: "fix-tax", headRefOid: "abc1234def", files: [] };
  function load({ answer = good, findings = [f, { file: "README.md", severity: "nit", title: "nit", detail: "" }, { file: "src/cart.js", line: 1, severity: "low", title: "Name", detail: "" }] as Finding[], model = "stub", api = "" } = {}) {
    const calls: { prompts: string[]; posted: { findings: Finding[]; opts: unknown }[] } = { prompts: [], posted: [] };
    const stubs: Record<string, unknown> = {
      store: { get: async (url: string) => (url === pr.url ? { review: { findings } } : null) },
      resolvePr: async (url: string) => ({ urlGuess: url, spec: [url] }),
      readPr: async () => JSON.stringify(pr),
      llmConfig: async () => ({ provider: "test", model, api }),
      headFileTexts: async (_pr: unknown, paths: string[]) => new Map(paths.filter((p) => files.has(p)).map((p) => [p, files.get(p)!])),
      prGuide: async () => ({ guide: { file: "AGENTS.md", text: "Never use var." }, fromHead: [] }),
      isForgeRepo: () => false,
      askModel: async (text: string) => { calls.prompts.push(text); return answer; },
      deriveSuggestionFromDetail,
      postInlineSuggestionsOnPr: async (r: { review: { findings: Finding[] } }, _repo: string, opts: unknown) => { calls.posted.push({ findings: r.review.findings, opts }); return { posted: r.review.findings.length, mode: "inline_review" }; },
    };
    const names = Object.keys(stubs);
    const api_ = new Function(...names, `${serverBlocks("agent-prompts", "fix-patch", "fix-command")}; return { fixFindings, openFindings };`)(...names.map((n) => stubs[n])) as Pick<typeof fix, "fixFindings" | "openFindings">;
    return { ...api_, calls };
  }
  {
    const t = load();
    const msg = await t.fixFindings(pr.url, "acme/shop");
    assert.match(msg, /^posted 1 suggestion checked against `abc1234`.*Nothing was pushed\.$/);
    assert.ok(t.calls.prompts[0].includes("### Finding 1 [HIGH] src/cart.js:L3: Tax applied twice") && t.calls.prompts[0].includes("### Finding 2 [LOW] src/cart.js:L1: Name"), "nits are left out and numbering follows the posted review");
    assert.ok(t.calls.prompts[0].includes("    3|   return t * 1.15;") && t.calls.prompts[0].includes("Never use var."));
    assert.deepEqual(t.calls.posted[0].opts, { agentPrompts: false });
    assert.deepEqual(t.calls.posted[0].findings, [{ file: "src/cart.js", line: 3, severity: "high", title: "Fix for finding 1: Tax applied twice", detail: "", suggestion: "  return t;" }]);
  }
  {
    const t = load();
    await t.fixFindings(pr.url, "acme/shop", "2");
    assert.ok(!t.calls.prompts[0].includes("Finding 1 ") && t.calls.prompts[0].includes("### Finding 2 "), "/fix 2 sends one finding");
    await assert.rejects(load().fixFindings(pr.url, "acme/shop", "3"), /No finding 3: pick 1-2/);
    await assert.rejects(load().fixFindings(pr.url, "acme/shop", "x"), /No finding x/);
  }
  await assert.rejects(load({ findings: [] }).fixFindings(pr.url, "acme/shop"), /run \/review first/);
  await assert.rejects(load({ model: "" }).fixFindings(pr.url, "acme/shop"), /needs a language model/);
  await assert.rejects(load({ api: "codereviewer" }).fixFindings(pr.url, "acme/shop"), /CodeReviewer cannot write patches/);
  {
    const t = load({ answer: "```diff\n" + stale + "\n```" });
    await assert.rejects(t.fixFindings(pr.url, "acme/shop"), /did not apply to abc1234 \(src\/cart\.js: hunk at line 2 does not match the head\)/);
    assert.equal(t.calls.posted.length, 0, "nothing posted when no hunk applies");
  }
  ctx.diagnostic("/fix posts only patches that apply, never pushes");
});
