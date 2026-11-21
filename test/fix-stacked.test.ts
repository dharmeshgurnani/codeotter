// /fix stacked: the command, the plan that applies a stored review's suggested changes to the head, the fix branch and
// pull request (fork and unsupported-forge refusals, skipped patches, idempotent re-runs), and each adapter's API calls.
// Runs core/fix.ts and core/pr-tools.ts blocks with stubs; the forge adapters run against a stubbed fetch, GitHub's
// against a stubbed gh. Nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serverBlocks } from "./helpers/server-blocks.ts";
import type { Finding } from "../core/engines.ts";
import type { FixPr, StackedOps } from "../core/forges.ts";
import type { StackedResult } from "../core/fix.ts";

test("/fix stacked", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-fix-stacked-"));
  process.env.CODEOTTER_HOME = home;
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });
  const fix = await import("../core/fix.ts");
  const { deriveSuggestionFromDetail } = await import("../core/engines.ts");
  const { makeForge, FIX_BRANCH_RE } = await import("../core/forges.ts");
  const { parseCommand } = await import("../core/pr-tools.ts");

  // ---------------------------------------------------------------------------------------------------------------
  assert.deepEqual(parseCommand("/fix stacked"), { cmd: "fix", arg: "stacked" });
  assert.deepEqual(parseCommand("  /FIX   Stacked \nplease"), { cmd: "fix", arg: "Stacked" });
  assert.deepEqual(parseCommand("/fix 2"), { cmd: "fix", arg: "2" });
  assert.ok(FIX_BRANCH_RE.test("codeotter/fix-7-abc1234") && !FIX_BRANCH_RE.test("codeotter/fix-7-abc1234/x") && !FIX_BRANCH_RE.test("feature/fix-7-abc1234"));
  ctx.diagnostic("command parsing and the fix branch name");

  // ---------------------------------------------------------------------------------------------------------------
  // The plan: suggestions are located in the head by their reviewed lines plus context.
  const reviewedText = ["export function total(items) {", "  const t = sum(items);", "  return t * 1.15;", "}", "", "export const name = 'cart';", ""].join("\n");
  const fTax: Finding = { file: "src/cart.js", line: 3, severity: "high", title: "Tax applied twice", detail: "", suggestion: "  return t;" };
  const fName: Finding = { file: "src/cart.js", line: 6, severity: "low", title: "Name", detail: "", suggestion: "export const name = \"cart\";" };
  const fBody: Finding = { file: "src/cart.js", startLine: 2, line: 3, severity: "medium", title: "Inline", detail: "", suggestion: "  return sum(items);" };
  const same = new Map([["src/cart.js", reviewedText]]);
  {
    const plan = fix.planStackedFix([{ n: 1, f: fTax }, { n: 2, f: fName }], same, same);
    assert.deepEqual(plan.applied.map((t) => t.n), [1, 2]);
    assert.deepEqual(plan.files, [{ path: "src/cart.js", content: reviewedText.replace("  return t * 1.15;", "  return t;").replace("'cart'", "\"cart\"") }]);
  }
  {
    // lines moved down by two in the head: still found by content
    const head = new Map([["src/cart.js", `// header\n// more\n${reviewedText}`]]);
    const plan = fix.planStackedFix([{ n: 1, f: fTax }], same, head);
    assert.equal(plan.files[0].content, `// header\n// more\n${reviewedText.replace("  return t * 1.15;", "  return t;")}`);
  }
  {
    // the head changed the line: skipped and named; an already-made change is told apart
    const stale = new Map([["src/cart.js", reviewedText.replace("  return t * 1.15;", "  return t * 1.2;")]]);
    const done = new Map([["src/cart.js", reviewedText.replace("  return t * 1.15;", "  return t;")]]);
    assert.deepEqual(fix.planStackedFix([{ n: 1, f: fTax }], same, stale).skipped.map((s) => s.why), ["no longer applies to the head"]);
    assert.deepEqual(fix.planStackedFix([{ n: 1, f: fTax }], same, done).skipped.map((s) => s.why), ["already applied"]);
    assert.deepEqual(fix.planStackedFix([{ n: 1, f: fTax }], same, new Map()).skipped.map((s) => s.why), ["file not readable at the head"]);
    assert.deepEqual(fix.planStackedFix([{ n: 1, f: { ...fTax, line: 99 } }], same, same).skipped.map((s) => s.why), ["lines outside the reviewed file"]);
  }
  {
    // a multi-line replacement, and a later one overlapping it
    const plan = fix.planStackedFix([{ n: 1, f: fBody }, { n: 2, f: fTax }], same, same);
    assert.deepEqual(plan.applied.map((t) => t.n), [1]);
    assert.deepEqual(plan.skipped.map((s) => [s.n, s.why]), [[2, "overlaps finding 1"]]);
    assert.equal(plan.files[0].content, reviewedText.replace("  const t = sum(items);\n  return t * 1.15;", "  return sum(items);"));
  }
  {
    // CRLF files stay CRLF
    const crlf = new Map([["src/cart.js", reviewedText.replace(/\n/g, "\r\n")]]);
    assert.equal(fix.planStackedFix([{ n: 1, f: fTax }], crlf, crlf).files[0].content, reviewedText.replace("  return t * 1.15;", "  return t;").replace(/\n/g, "\r\n"));
  }
  ctx.diagnostic("suggestions apply to the head or are skipped with a reason");

  // ---------------------------------------------------------------------------------------------------------------
  // fixStacked: real blocks, stubbed store, PR read, files, ops, comment and audit.
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  const REVIEWED = "9999999def5678abc1234def5678abc1234def56";
  type Call = [string, ...unknown[]];
  function load({ repo = "acme/shop", headRepo = "", fork = false, existing = null as FixPr | null, findings = [fTax, fName, { file: "README.md", severity: "low", title: "No suggestion", detail: "" }] as Finding[], headText = reviewedText, reviewSha = HEAD, ops = "github" as "github" | "forge" | "none" } = {}) {
    const calls: Call[] = [];
    const pr = { url: `https://github.com/${repo}/pull/7`, number: 7, title: "fix totals", state: "OPEN", headRefName: "fix-tax", headRefOid: HEAD, headRepo: headRepo || repo };
    const stackedOps: StackedOps = {
      ...(ops === "github" ? { fork: async (r: string, n: number) => { calls.push(["fork", r, n]); return fork; } } : {}),
      findFixPr: async (r, base, prefix) => { calls.push(["find", r, base, prefix]); return existing; },
      commit: async (r, c) => { calls.push(["commit", r, c]); },
      openPr: async (r, o) => { calls.push(["open", r, o]); return { number: 8, url: `https://github.com/${r}/pull/8`, branch: o.branch }; },
      editPr: async (r, n, o) => { calls.push(["edit", r, n, o]); },
    };
    const stubs: Record<string, unknown> = {
      store: { get: async (url: string) => (url === pr.url ? { headSha: reviewSha, pr: { headRefOid: reviewSha }, review: { findings } } : null) },
      resolvePr: async (url: string) => ({ urlGuess: url, spec: [url] }),
      readPr: async () => JSON.stringify(pr),
      headFileTexts: async (_pr: unknown, paths: string[], _max: number, _chars: number, ref: string) => { calls.push(["read", ref]); return new Map(paths.filter((p) => p === "src/cart.js").map((p) => [p, ref === HEAD ? headText : reviewedText])); },
      deriveSuggestionFromDetail,
      isForgeRepo: (r: string) => r.includes("~"),
      forgeOf: () => ({ stacked: ops === "none" ? undefined : stackedOps }),
      githubStacked: stackedOps,
      repoLabel: (r: string) => `${r.split("~")[1]} · Bitbucket`,
      createPrComment: async (url: string, _r: string, n: number, body: string) => { calls.push(["comment", url, n, body]); },
      audit: async (_a: unknown, action: string, target: string, detail: unknown) => { calls.push(["audit", action, target, detail]); },
      orgOfRepo: (r: string) => r.split("/")[0],
    };
    const names = Object.keys(stubs);
    const api = new Function(...names, `${serverBlocks("agent-prompts", "fix-patch", "fix-command", "fix-stacked-plan", "fix-stacked")}; return { fixStacked };`)(...names.map((n) => stubs[n])) as { fixStacked: (url: string, repo: string) => Promise<StackedResult> };
    return { fixStacked: (r = repo) => api.fixStacked(pr.url, r), calls, pr };
  }
  const of = (calls: Call[], kind: string) => calls.filter((c) => c[0] === kind);
  {
    const t = load();
    const res = await t.fixStacked();
    assert.deepEqual(res, { message: res.message, url: "https://github.com/acme/shop/pull/8", updated: false, applied: 2, skipped: 0 });
    assert.deepEqual(of(t.calls, "find")[0], ["find", "acme/shop", "fix-tax", "codeotter/fix-7-"]);
    const [, , c] = of(t.calls, "commit")[0] as [string, string, { branch: string; headSha: string; files: { path: string; content: string }[]; message: string }];
    assert.equal(c.branch, "codeotter/fix-7-abc1234");
    assert.equal(c.headSha, HEAD);
    assert.equal(c.files[0].content, reviewedText.replace("  return t * 1.15;", "  return t;").replace("'cart'", "\"cart\""));
    assert.match(c.message, /^fix: CodeOtter suggestions for #7\n\n- finding 1: Tax applied twice\n- finding 2: Name/);
    const [, , o] = of(t.calls, "open")[0] as [string, string, { branch: string; base: string; title: string; body: string }];
    assert.equal(o.base, "fix-tax", "the fix PR merges into the PR's head branch");
    assert.equal(o.title, "CodeOtter fixes for #7: fix totals");
    assert.ok(o.body.includes("[#7](https://github.com/acme/shop/pull/7)") && o.body.includes("- finding 1 [HIGH] `src/cart.js:L3`: Tax applied twice") && !o.body.includes("No suggestion"), o.body);
    const [, , n, comment] = of(t.calls, "comment")[0];
    assert.equal(n, 7);
    assert.match(String(comment), /^🦦 CodeOtter `\/fix stacked`: opened \[fix pull request #8\]\(https:\/\/github\.com\/acme\/shop\/pull\/8\) with 2 fixes on `abc1234`\.$/);
    assert.deepEqual(of(t.calls, "audit")[0], ["audit", "fix.stacked", t.pr.url, { fixPr: "https://github.com/acme/shop/pull/8", branch: "codeotter/fix-7-abc1234", head: "abc1234", applied: 2, skipped: 0, updated: false }]);
    assert.deepEqual(of(t.calls, "read").map((c) => c[1]), [HEAD], "head reviewed: one read");
  }
  ctx.diagnostic("opens a fix PR into the head branch, comments the link, audits");

  {
    // re-run: the open fix PR and its branch are reused, nothing new is opened
    const t = load({ existing: { number: 8, url: "https://github.com/acme/shop/pull/8", branch: "codeotter/fix-7-1111111" } });
    const res = await t.fixStacked();
    assert.equal(res.updated, true);
    assert.equal((of(t.calls, "commit")[0][2] as { branch: string }).branch, "codeotter/fix-7-1111111");
    assert.equal(of(t.calls, "open").length, 0);
    assert.equal(of(t.calls, "edit")[0][2], 8);
    assert.match(String(of(t.calls, "comment")[0][3]), /: updated \[fix pull request #8\]/);
  }
  ctx.diagnostic("re-running updates the existing fix branch and PR");

  {
    // reviewed at an older commit; one finding's lines changed since: applied one, skipped one, both listed
    const headText = reviewedText.replace("export const name = 'cart';", "export const name = 'basket';");
    const t = load({ reviewSha: REVIEWED, headText });
    const res = await t.fixStacked();
    assert.deepEqual([res.applied, res.skipped], [1, 1]);
    assert.deepEqual(of(t.calls, "read").map((c) => c[1]), [HEAD, REVIEWED]);
    const body = (of(t.calls, "open")[0][2] as { body: string }).body;
    assert.ok(body.includes("**Skipped**\n- finding 2 [LOW] `src/cart.js:L6`: Name (no longer applies to the head)"), body);
    assert.match(String(of(t.calls, "comment")[0][3]), /with 1 fix on `abc1234`\. Skipped:\n- finding 2/);
  }
  {
    const t = load({ reviewSha: REVIEWED, headText: "rewritten\n" });
    await assert.rejects(t.fixStacked(), /none of the 2 suggested changes apply to `abc1234`/);
    assert.equal(of(t.calls, "commit").length + of(t.calls, "open").length, 0, "nothing pushed when nothing applies");
  }
  ctx.diagnostic("patches that no longer apply are skipped and listed");

  {
    const t = load({ fork: true });
    await assert.rejects(t.fixStacked(), /lives in a fork/);
    assert.equal(of(t.calls, "commit").length + of(t.calls, "find").length, 0);
    const g = load({ repo: "forgejo~acme/shop", headRepo: "forgejo~someone/shop", ops: "forge" });
    await assert.rejects(g.fixStacked(), /lives in a fork/, "forges without fork(): the PR's headRepo decides");
    await assert.rejects(load({ repo: "bitbucket~acme/shop", ops: "none" }).fixStacked(), /acme\/shop · Bitbucket: fix pull requests need a git server whose API commits files as JSON/);
    await assert.rejects(load({ findings: [{ ...fTax, suggestion: "" }] }).fixStacked(), /No open findings with a suggested change/);
    await assert.rejects(load({ findings: [{ ...fTax, dismissed: true }] }).fixStacked(), /No open findings with a suggested change/);
  }
  ctx.diagnostic("fork PRs and forges without commit APIs are refused");

  // ---------------------------------------------------------------------------------------------------------------
  // The comment command: /fix stacked runs fixStacked; a refusal is commented on the PR.
  {
    const calls: Call[] = [];
    const stubs: Record<string, unknown> = {
      isForgeRepo: () => false,
      prUrlFor: (r: string, n: number) => `https://github.com/${r}/pull/${n}`,
      oneLine: (x: unknown, max: number) => String(x).replace(/\s+/g, " ").slice(0, max),
      ghAsApp: async () => "",
      createPrComment: async (_u: string, _r: string, _n: number, body: string) => { calls.push(["comment", body]); },
      fixStacked: async (url: string, repo: string) => { calls.push(["stacked", url, repo]); if (repo === "acme/fork") throw new Error("this pull request's branch lives in a fork."); return { message: "" }; },
      fixFindings: async () => { calls.push(["fix"]); return ""; },
      audit: async () => {},
      orgOfRepo: (r: string) => r.split("/")[0],
      withActor: (_a: unknown, fn: () => unknown) => fn(),
    };
    const names = Object.keys(stubs);
    const { runCommand } = new Function(...names, `${serverBlocks("pr-commands")}; return { runCommand };`)(...names.map((n) => stubs[n])) as { runCommand: (repo: string, c: object, cmd: { cmd: string; arg: string }) => Promise<void> };
    await runCommand("acme/shop", { id: 1, prNumber: 7, user: { login: "dev" } }, { cmd: "fix", arg: "stacked" });
    assert.deepEqual(calls, [["stacked", "https://github.com/acme/shop/pull/7", "acme/shop"]], "fixStacked comments itself; /fix is not run");
    calls.length = 0;
    await assert.rejects(runCommand("acme/fork", { id: 1, prNumber: 7, user: { login: "dev" } }, { cmd: "fix", arg: "stacked" }), /fork/);
    assert.deepEqual(calls.at(-1), ["comment", "🦦 CodeOtter `/fix stacked` failed: this pull request's branch lives in a fork."]);
  }
  ctx.diagnostic("/fix stacked comment command and its refusal comment");

  // ---------------------------------------------------------------------------------------------------------------
  // Adapters: the calls each one makes, built in core/forges.ts (and git.ts for GitHub).
  type Sent = { method: string; url: string; body?: Record<string, unknown> };
  let sent: Sent[] = [];
  let reply: (s: Sent) => unknown = () => ({});
  globalThis.fetch = async (url, init = {}) => {
    const s: Sent = { method: init.method || "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(s);
    const out = reply(s);
    return out instanceof Response ? out : Response.json(out);
  };
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const files = [{ path: "src/cart.js", content: "fixed\n" }];
  const commit = { branch: "codeotter/fix-7-abc1234", headSha: HEAD, headBranch: "fix-tax", files, message: "fix: m" };
  const brief = () => sent.map((s) => `${s.method} ${s.url}`);
  {
    const gt = makeForge("forgejo", { kind: "gitea", label: "Forgejo", url: "https://git.example", token: "t" }).stacked!;
    sent = [];
    reply = (s) => s.url.includes("/pulls?state=open") ? (s.url.endsWith("page=1") ? [
      { number: 3, base: { ref: "fix-tax" }, head: { ref: "codeotter/fix-7-abc1234", repo: { full_name: "someone/shop" } } },
      { number: 9, html_url: "https://git.example/acme/shop/pulls/9", base: { ref: "fix-tax" }, head: { ref: "codeotter/fix-7-1111111", repo: { full_name: "acme/shop" } } },
    ] : []) : {};
    assert.deepEqual(await gt.findFixPr("forgejo~acme/shop", "fix-tax", "codeotter/fix-7-"), { number: 9, url: "https://git.example/acme/shop/pulls/9", branch: "codeotter/fix-7-1111111" }, "a fork's branch of the same name is not ours");
    sent = [];
    reply = (s) => s.method === "GET" && s.url.includes("/branches/") ? new Response("", { status: 404 }) : s.url.endsWith("/branches") ? { commit: { id: HEAD } } : s.url.includes("/contents/src/cart.js") ? { sha: "blob1" } : {};
    await gt.commit("forgejo~acme/shop", commit);
    assert.deepEqual(brief(), [
      "GET https://git.example/api/v1/repos/acme/shop/branches/codeotter/fix-7-abc1234",
      "POST https://git.example/api/v1/repos/acme/shop/branches",
      "GET https://git.example/api/v1/repos/acme/shop/contents/src/cart.js?ref=codeotter%2Ffix-7-abc1234",
      "POST https://git.example/api/v1/repos/acme/shop/contents",
    ]);
    assert.deepEqual(sent[1].body, { new_branch_name: "codeotter/fix-7-abc1234", old_ref_name: HEAD, old_branch_name: "fix-tax" });
    assert.deepEqual(sent[3].body, { branch: "codeotter/fix-7-abc1234", message: "fix: m", files: [{ operation: "update", path: "src/cart.js", content: b64("fixed\n"), sha: "blob1" }] });
    // an old server that branched from the moved head branch: the branch is removed and the run refused
    sent = [];
    reply = (s) => s.method === "GET" && s.url.includes("/branches/") ? new Response("", { status: 404 }) : s.url.endsWith("/branches") ? { commit: { id: "f".repeat(40) } } : {};
    await assert.rejects(gt.commit("forgejo~acme/shop", commit), /fix-tax moved past abc1234/);
    assert.equal(sent.at(-1)!.method, "DELETE");
    sent = [];
    reply = () => ({ number: 10, html_url: "https://git.example/acme/shop/pulls/10" });
    assert.deepEqual(await gt.openPr("forgejo~acme/shop", { branch: commit.branch, base: "fix-tax", title: "T", body: "B" }), { number: 10, url: "https://git.example/acme/shop/pulls/10", branch: commit.branch });
    await gt.editPr("forgejo~acme/shop", 10, { title: "T2", body: "B2" });
    assert.deepEqual(sent.map((s) => [s.method, s.url, s.body]), [
      ["POST", "https://git.example/api/v1/repos/acme/shop/pulls", { head: commit.branch, base: "fix-tax", title: "T", body: "B" }],
      ["PATCH", "https://git.example/api/v1/repos/acme/shop/pulls/10", { title: "T2", body: "B2" }],
    ]);
  }
  ctx.diagnostic("Forgejo/Gitea: branch from the head commit, contents API commit, pulls API");
  {
    const gl = makeForge("gitlab", { kind: "gitlab", label: "GitLab", url: "https://gl.example", token: "t" }).stacked!;
    const P = "https://gl.example/api/v4/projects/grp%2Fshop";
    sent = [];
    reply = (s) => s.url.includes("/merge_requests/7") ? { iid: 7, source_project_id: 2, target_project_id: 1 } : [
      { iid: 4, source_branch: "codeotter/fix-7-abc1234", target_branch: "fix-tax", source_project_id: 2, target_project_id: 1 },
      { iid: 5, web_url: "https://gl.example/grp/shop/-/merge_requests/5", source_branch: "codeotter/fix-7-abc1234", target_branch: "fix-tax", source_project_id: 1, target_project_id: 1 },
    ];
    assert.equal(await gl.fork!("gitlab~grp/shop", 7), true);
    assert.deepEqual(await gl.findFixPr("gitlab~grp/shop", "fix-tax", "codeotter/fix-7-"), { number: 5, url: "https://gl.example/grp/shop/-/merge_requests/5", branch: "codeotter/fix-7-abc1234" });
    assert.deepEqual(brief(), [`GET ${P}/merge_requests/7`, `GET ${P}/merge_requests?state=opened&target_branch=fix-tax&per_page=100&page=1`]);
    sent = [];
    reply = () => ({ iid: 6, web_url: "https://gl.example/grp/shop/-/merge_requests/6" });
    await gl.commit("gitlab~grp/shop", commit);
    await gl.openPr("gitlab~grp/shop", { branch: commit.branch, base: "fix-tax", title: "T", body: "B" });
    await gl.editPr("gitlab~grp/shop", 6, { title: "T2", body: "B2" });
    assert.deepEqual(sent.map((s) => [s.method, s.url, s.body]), [
      ["POST", `${P}/repository/commits`, { branch: commit.branch, start_sha: HEAD, force: true, commit_message: "fix: m", actions: [{ action: "update", file_path: "src/cart.js", content: b64("fixed\n"), encoding: "base64" }] }],
      ["POST", `${P}/merge_requests`, { source_branch: commit.branch, target_branch: "fix-tax", title: "T", description: "B", remove_source_branch: true }],
      ["PUT", `${P}/merge_requests/6`, { title: "T2", description: "B2" }],
    ]);
  }
  ctx.diagnostic("GitLab: forked MRs detected, commits API with force from the head commit");
  {
    const az = makeForge("azure", { kind: "azure", label: "Azure DevOps", url: "https://dev.azure.com", token: "t", fixed: true }).stacked!;
    const G = "https://dev.azure.com/org/Proj%20One/_apis/git/repositories/shop";
    sent = [];
    reply = (s) => s.url.includes("/refs?") ? { value: [{ name: "refs/heads/codeotter/fix-7-abc1234x", objectId: "e".repeat(40) }, { name: "refs/heads/codeotter/fix-7-abc1234", objectId: "d".repeat(40) }] }
      : s.url.includes("/pullrequests?") ? { value: [{ pullRequestId: 12, sourceRefName: "refs/heads/codeotter/fix-7-abc1234", targetRefName: "refs/heads/fix-tax" }] } : { pullRequestId: 13 };
    assert.deepEqual(await az.findFixPr("azure~org/Proj One/shop", "fix-tax", "codeotter/fix-7-"), { number: 12, url: "https://dev.azure.com/org/Proj%20One/_git/shop/pullrequest/12", branch: "codeotter/fix-7-abc1234" });
    await az.commit("azure~org/Proj One/shop", commit);
    await az.openPr("azure~org/Proj One/shop", { branch: commit.branch, base: "fix-tax", title: "T", body: "B" });
    await az.editPr("azure~org/Proj One/shop", 13, { title: "T2", body: "B2" });
    assert.deepEqual(sent.map((s) => [s.method, s.url, s.body]), [
      ["GET", `${G}/pullrequests?searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Ffix-tax&$top=200&api-version=7.1`, undefined],
      ["GET", `${G}/refs?filter=heads%2Fcodeotter%2Ffix-7-abc1234&api-version=7.1`, undefined],
      ["POST", `${G}/pushes?api-version=7.1`, { refUpdates: [{ name: "refs/heads/codeotter/fix-7-abc1234", oldObjectId: "d".repeat(40) }], commits: [{ comment: "fix: m", parents: [HEAD], changes: [{ changeType: "edit", item: { path: "/src/cart.js" }, newContent: { content: b64("fixed\n"), contentType: "base64encoded" } }] }] }],
      ["POST", `${G}/pullrequests?api-version=7.1`, { sourceRefName: "refs/heads/codeotter/fix-7-abc1234", targetRefName: "refs/heads/fix-tax", title: "T", description: "B" }],
      ["PATCH", `${G}/pullrequests/13?api-version=7.1`, { title: "T2", description: "B2" }],
    ]);
  }
  ctx.diagnostic("Azure DevOps: one push parented on the head commit, pullrequests API");
  {
    for (const [id, kind] of [["bitbucket", "bitbucket"], ["bitbucketdc", "bitbucketdc"]] as const) {
      assert.equal(makeForge(id, { kind, label: id, url: "https://bb.example", token: "t" }).stacked, undefined, `${id} has no fix PRs`);
    }
    sent = [];
    const gt = makeForge("forgejo", { kind: "gitea", label: "Forgejo", url: "https://git.example", token: "t" }).stacked!;
    await assert.rejects(gt.commit("forgejo~acme/shop", { ...commit, files: [{ path: "../etc/passwd", content: "" }] }), /Invalid file path/);
  }
  ctx.diagnostic("Bitbucket has no stacked API; unsafe paths are refused");

  // GitHub: the git data API through gh, as the repository's writer.
  {
    const gh: [string, string, unknown][] = [];
    const ghApi = async (_repo: string, method: string, path: string, body?: unknown) => {
      gh.push([method, path, body]);
      if (path.endsWith(`/git/commits/${HEAD}`)) return { tree: { sha: "a".repeat(40) } };
      if (path.includes("/git/trees/")) return { tree: [{ path: "src/cart.js", mode: "100755" }] };
      if (path.endsWith("/git/trees")) return { sha: "b".repeat(40) };
      if (path.endsWith("/git/commits")) return { sha: "c".repeat(40) };
      if (method === "PATCH" && path.includes("/git/refs/")) throw new Error("gh api: Reference does not exist");
      if (path.endsWith("/pulls/7")) return { number: 7, head: { repo: null } };
      if (path.includes("/pulls?")) return [{ number: 9, html_url: "https://github.com/acme/shop/pull/9", base: { ref: "fix-tax" }, head: { ref: "codeotter/fix-7-1111111", repo: { full_name: "acme/shop" } } }];
      return { number: 11, html_url: "https://github.com/acme/shop/pull/11" };
    };
    const { githubStacked } = new Function("ghApi", "FIX_BRANCH_RE", `${serverBlocks("github-stacked")}; return { githubStacked };`)(ghApi, FIX_BRANCH_RE) as { githubStacked: StackedOps };
    assert.equal(await githubStacked.fork!("acme/shop", 7), true, "a deleted fork counts as a fork");
    assert.deepEqual(await githubStacked.findFixPr("acme/shop", "fix-tax", "codeotter/fix-7-"), { number: 9, url: "https://github.com/acme/shop/pull/9", branch: "codeotter/fix-7-1111111" });
    gh.length = 0;
    await githubStacked.commit("acme/shop", commit);
    assert.deepEqual(gh, [
      ["GET", `repos/acme/shop/git/commits/${HEAD}`, undefined],
      ["GET", `repos/acme/shop/git/trees/${"a".repeat(40)}?recursive=1`, undefined],
      ["POST", "repos/acme/shop/git/trees", { base_tree: "a".repeat(40), tree: [{ path: "src/cart.js", mode: "100755", type: "blob", content: "fixed\n" }] }],
      ["POST", "repos/acme/shop/git/commits", { message: "fix: m", tree: "b".repeat(40), parents: [HEAD] }],
      ["PATCH", "repos/acme/shop/git/refs/heads/codeotter/fix-7-abc1234", { sha: "c".repeat(40), force: true }],
      ["POST", "repos/acme/shop/git/refs", { ref: "refs/heads/codeotter/fix-7-abc1234", sha: "c".repeat(40) }],
    ]);
    gh.length = 0;
    assert.deepEqual(await githubStacked.openPr("acme/shop", { branch: commit.branch, base: "fix-tax", title: "T", body: "B" }), { number: 11, url: "https://github.com/acme/shop/pull/11", branch: commit.branch });
    await githubStacked.editPr("acme/shop", 11, { title: "T2", body: "B2" });
    assert.deepEqual(gh, [["POST", "repos/acme/shop/pulls", { title: "T", head: commit.branch, base: "fix-tax", body: "B" }], ["PATCH", "repos/acme/shop/pulls/11", { title: "T2", body: "B2" }]]);
    await assert.rejects(githubStacked.commit("acme/shop", { ...commit, branch: "main" }), /Invalid head commit or branch/);
  }
  ctx.diagnostic("GitHub: tree + commit + forced ref on the head commit, pulls API");
});
