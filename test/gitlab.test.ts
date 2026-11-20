// The GitLab adapter (core/forges.ts): nested-group project ids, merge request and diff reads, inline suggestions,
// commit statuses, the Developer trust check, and its webhooks through the real queue blocks (secret token in constant
// time, delivery de-duplication, routing). fetch is stubbed; nothing leaves the machine.
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { test } from "node:test";
import { makeForge, repoFromUrl, secretMatches } from "../core/forges.ts";
import type { ForgeComment, ForgeConfig } from "../core/forges.ts";
import { serverBlocks } from "./helpers/server-blocks.ts";

type Body = Record<string, unknown> & { body?: string; position?: Record<string, unknown>; state?: string; name?: string; token?: string };
type Sent = { method: string; url: string; auth?: string; redirect?: RequestInit["redirect"]; body?: Body };
type Route = [method: string, url: string | RegExp, reply: (url: string, body: Body) => Response | object | undefined];
const REPO_RE = /^(?:(?:(?:forgejo|gitea|bitbucket|bitbucketdc)~)?[\w][\w.-]*\/[\w][\w.-]*|azure~[\w][\w.-]*\/[\w](?:[\w. -]*[\w.-])?\/[\w](?:[\w. -]*[\w.-])?|gitlab~[\w][\w.-]*(?:\/[\w][\w.-]*){1,19})$/;

test("GitLab adapter and webhooks", async (ctx) => {
  const realFetch = globalThis.fetch;
  let routes: Route[] = [];
  let sent: Sent[] = [];
  globalThis.fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const method = init.method || "GET";
    const body: Body | undefined = init.body ? JSON.parse(init.body as string) : undefined;
    sent.push({ method, url: String(url), auth: (init.headers as Record<string, string> | undefined)?.authorization, redirect: init.redirect, body });
    const hit = routes.find(([m, u]) => m === method && (u instanceof RegExp ? u.test(String(url)) : String(url).startsWith(u)));
    if (!hit) return new Response("not found", { status: 404 });
    const out = await hit[2](String(url), body as Body);
    return out instanceof Response ? out : Response.json(out);
  };
  const reset = (r: Route[]) => { routes = r; sent = []; };
  const ORIGIN = "https://gitlab.example";
  const f: ForgeConfig = { kind: "gitlab", label: "GitLab", url: ORIGIN, token: "glpat" };
  const gl = makeForge("gitlab", f);
  const REPO = "gitlab~acme/platform/api";
  const P = `${ORIGIN}/api/v4/projects/acme%2Fplatform%2Fapi`;
  const head = "b".repeat(40);
  try {
    // repository listing: nested groups kept whole, anything else dropped
    {
      reset([["GET", `${ORIGIN}/api/v4/projects?membership=true&min_access_level=30`, () => [
        { path_with_namespace: "acme/platform/api" }, { path_with_namespace: "acme/web" }, { path_with_namespace: "acme/a/b/c/deep" },
        { path_with_namespace: "solo" }, { path_with_namespace: "acme/../etc" },
      ]]]);
      assert.deepEqual(await gl.listRepos(), ["gitlab~acme/platform/api", "gitlab~acme/web", "gitlab~acme/a/b/c/deep"]);
      assert.equal(sent[0].auth, "Bearer glpat");
      assert.equal(sent[0].redirect, "manual", "redirects are never followed with the token");
      assert.match(sent[0].url, /per_page=100&page=1$/);
      for (const r of await gl.listRepos()) assert.ok(REPO_RE.test(r), r);
      assert.ok(!REPO_RE.test("gitlab~solo") && !REPO_RE.test("gitlab~a/.hidden"));
      ctx.diagnostic("listRepos: nested groups, membership with Developer access, Bearer token, no redirects");
    }

    // URLs, ids and parsing
    {
      assert.equal(gl.prUrl(REPO, 7), `${ORIGIN}/acme/platform/api/-/merge_requests/7`);
      assert.equal(gl.issueUrl(REPO, 3), `${ORIGIN}/acme/platform/api/-/issues/3`);
      assert.deepEqual(gl.parsePr(new URL(`${ORIGIN}/acme/platform/api/-/merge_requests/7`)), { native: "acme/platform/api", number: 7 });
      assert.equal(gl.parsePr(new URL(`${ORIGIN}/acme/-/merge_requests/7`)), null, "a project needs a group");
      assert.equal(gl.parseRepo("acme/platform/api/-/tree/main"), "acme/platform/api");
      assert.equal(gl.parseRepo("acme/platform/api.git"), "acme/platform/api");
      assert.equal(gl.parseRepo("acme"), null);
      assert.equal(repoFromUrl(`${ORIGIN}/acme/platform/api/-/merge_requests/7`, { gitlab: ORIGIN }), REPO);
      assert.equal(repoFromUrl(`${ORIGIN}/acme/-/merge_requests/7`, { gitlab: ORIGIN }), "");
      ctx.diagnostic("merge request and issue URLs, URL parsing for nested groups");
    }

    // a merge request: project path URL-encoded as one :id, diffs to unified text, commits oldest first, fork head
    {
      reset([
        ["GET", `${P}/merge_requests/7/diffs`, () => [
          { old_path: "src/a.ts", new_path: "src/a.ts", diff: "@@ -1,2 +1,3 @@\n a\n-b\n+x\n+y\n" },
          { old_path: "new.md", new_path: "new.md", new_file: true, diff: "@@ -0,0 +1 @@\n+hi\n" },
        ]],
        ["GET", `${P}/merge_requests/7/commits`, () => [
          { id: head, message: "second\n\nbody", author_name: "Dev", committed_date: "2026-11-02T00:00:00Z" },
          { id: "a".repeat(40), message: "first", author_name: "Dev" },
        ]],
        ["GET", `${P}/merge_requests/7`, () => ({ iid: 7, title: "Add cart", description: "Closes #3", state: "opened", draft: false, author: { username: "dev" }, updated_at: "2026-11-02T00:00:00Z", target_branch: "main", source_branch: "feat", sha: head, source_project_id: 9, target_project_id: 5, labels: ["backend"] })],
        ["GET", `${ORIGIN}/api/v4/projects/9`, () => ({ path_with_namespace: "dev/api-fork" })],
      ]);
      const pr = await gl.pr(REPO, 7);
      assert.equal(pr.url, `${ORIGIN}/acme/platform/api/-/merge_requests/7`);
      assert.equal(pr.headRefOid, head);
      assert.equal(pr.headRepo, "gitlab~dev/api-fork", "a fork's content is read from the fork");
      assert.deepEqual(pr.files, [{ path: "src/a.ts", additions: 2, deletions: 1 }, { path: "new.md", additions: 1, deletions: 0 }]);
      assert.deepEqual(pr.commits.map((c) => c.oid), ["a".repeat(40), head], "oldest first");
      assert.deepEqual([pr.state, pr.baseRefName, pr.headRefName, pr.labels[0]?.name, pr.author.login], ["OPEN", "main", "feat", "backend", "dev"]);
      const diff = await gl.diff(REPO, 7);
      assert.match(diff, /^diff --git a\/src\/a.ts b\/src\/a.ts\n--- a\/src\/a.ts\n\+\+\+ b\/src\/a.ts\n@@ -1,2 \+1,3 @@/);
      assert.match(diff, /diff --git a\/new.md b\/new.md\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new.md\n@@ -0,0 \+1 @@\n\+hi/);
      // a head the commit list does not have yet: retry later rather than review a half-updated MR
      routes.unshift(["GET", `${P}/merge_requests/7/commits`, () => [{ id: "c".repeat(40) }]]);
      await assert.rejects(gl.pr(REPO, 7), /updating this merge request/);
      // GitLab before 15.7 has no /diffs: the older /changes answers
      reset([["GET", `${P}/merge_requests/8/changes`, () => ({ changes: [{ old_path: "x", new_path: "x", diff: "@@ -1 +1 @@\n-a\n+b\n" }] })]]);
      assert.match(await gl.diff(REPO, 8), /^diff --git a\/x b\/x\n--- a\/x\n\+\+\+ b\/x\n@@ -1 \+1 @@\n-a\n\+b$/);
      ctx.diagnostic("merge request read, unified diff from /diffs and /changes, fork head, mid-push refusal");
    }

    // repository files (AGENTS.md / CLAUDE.md), nested paths encoded, 404 is null
    {
      reset([
        ["GET", `${P}/repository/files/AGENTS.md/raw?ref=${head}`, () => new Response("# rules")],
        ["GET", `${P}/repository/files/docs%2FREADME.md/raw?ref=main`, () => new Response("docs")],
        ["GET", /\/projects\/acme%2Fplatform%2Fapi$/, () => ({ default_branch: "main" })],
      ]);
      assert.equal(await gl.file(REPO, "AGENTS.md", head), "# rules");
      assert.equal(await gl.file(REPO, "CLAUDE.md", head), null);
      assert.equal(await gl.file(REPO, "docs/README.md"), "docs", "default branch when no ref");
      assert.equal(await gl.file(REPO, "../secret"), null);
      ctx.diagnostic("repository files API: guides by ref, default branch, 404 is null, no traversal");
    }

    // inline suggestions: one discussion per finding against the MR's diff refs; GitLab's multi-line suggestion syntax
    {
      const refs = { base_sha: "1".repeat(40), start_sha: "2".repeat(40), head_sha: head };
      reset([
        ["GET", `${P}/merge_requests/7`, () => ({ iid: 7, diff_refs: refs })],
        ["POST", `${P}/merge_requests/7/discussions`, (_u, b) => (b.position?.new_line === 99 ? new Response("{\"message\":\"line_code can't be blank\"}", { status: 400 }) : { id: "d1" })],
      ]);
      const one = { path: "src/a.ts", line: 12, startLine: 10, body: "<!-- codeotter:suggestion:src/a.ts:12 -->\nfix\n```suggestion\nx\ny\nz\n```" };
      const two = { path: "src/a.ts", line: 99, body: "outside\n```suggestion\nq\n```" };
      const failed = await gl.inline(REPO, 7, [one, two], head);
      assert.deepEqual(failed, [two], "a line GitLab cannot anchor goes to the fallback comment");
      const posts = sent.filter((s) => s.method === "POST");
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[0].body?.position, { position_type: "text", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: head, old_path: "src/a.ts", new_path: "src/a.ts", new_line: 12 });
      assert.match(String(posts[0].body?.body), /```suggestion:-2\+0\nx\ny\nz\n```/);
      assert.match(String(posts[1].body?.body), /```suggestion:-0\+0\nq/);
      assert.ok(gl.multiLineSuggestions);
      // anything but a rejected line (auth, server down) stops before more writes
      reset([["GET", `${P}/merge_requests/7`, () => ({ iid: 7, diff_refs: refs })], ["POST", `${P}/merge_requests/7/discussions`, () => new Response("", { status: 401 })]]);
      await assert.rejects(gl.inline(REPO, 7, [one, two]), /401/);
      assert.equal(sent.filter((s) => s.method === "POST").length, 1);
      ctx.diagnostic("inline discussions with base/start/head SHAs, suggestion:-N+0, 400 falls back, 401 throws");
    }

    // commit status and MR notes (the marker upsert)
    {
      reset([
        ["POST", `${P}/statuses/${head}`, () => ({ id: 1 })],
        ["GET", `${P}/merge_requests/7/notes`, () => [
          { id: 1, body: "<!-- codeotter:review -->", created_at: "2026-11-01T00:00:00Z", author: { id: 5, username: "bot" } },
          { id: 2, body: "added 1 commit", system: true },
          { id: 3, body: "inline", type: "DiffNote", author: { id: 6, username: "dev" } },
        ]],
        ["PUT", `${P}/merge_requests/7/notes/1`, () => ({ id: 1 })],
        ["POST", `${P}/merge_requests/7/notes`, () => ({ id: 4 })],
      ]);
      await gl.status(REPO, head, { state: "failure", context: "codeotter/review", description: "Score 41", target_url: "https://otter.example/r" });
      assert.deepEqual(sent[0].body, { state: "failed", name: "codeotter/review", description: "Score 41", target_url: "https://otter.example/r" });
      await gl.status(REPO, head, { state: "success", context: "codeotter/review" });
      assert.equal(sent[1].body?.state, "success");
      assert.throws(() => gl.status(REPO, "../x", { state: "success", context: "c" }), /Invalid commit SHA/);
      const cs = await gl.comments(REPO, 7);
      assert.deepEqual(cs.map((c) => [c.id, c.prNumber, c.user.login]), [[1, 7, "bot"]], "top-level, non-system notes only");
      await gl.editComment(REPO, 7, 1, "updated");
      await gl.comment(REPO, 7, "new");
      assert.deepEqual(sent.slice(-2).map((s) => [s.method, s.body?.body]), [["PUT", "updated"], ["POST", "new"]]);
      ctx.diagnostic("commit status mapping, notes listed, edited and created");
    }

    // trust: Developer (30) or higher, through any membership; anything else is not trusted
    {
      const c = (id: number | string): ForgeComment => ({ id: 1, body: "/review", created_at: "", prNumber: 7, user: { id, login: "dev" } });
      reset([
        ["GET", `${P}/members/all/42`, () => ({ access_level: 30, state: "active" })],
        ["GET", `${P}/members/all/43`, () => ({ access_level: 20, state: "active" })],
        ["GET", `${P}/members/all/45`, () => ({ access_level: 40, state: "blocked" })],
        ["GET", `${P}/members/all/46`, () => new Response("", { status: 403 })],
      ]);
      assert.equal(await gl.trusted(REPO, c(42)), true);
      assert.equal(await gl.trusted(REPO, c(43)), false, "Reporter");
      assert.equal(await gl.trusted(REPO, c(44)), false, "not a member");
      assert.equal(await gl.trusted(REPO, c(45)), false, "blocked");
      assert.equal(await gl.trusted(REPO, c(46)), false, "token cannot read members");
      const before = sent.length;
      assert.equal(await gl.trusted(REPO, c("../1")), false);
      assert.equal(sent.length, before, "a non-numeric id is refused before any request");
      ctx.diagnostic("trusted(): Developer or higher and active; Reporter, non-members, blocked and unreadable are not");
    }

    // hooks: registered once per project with the secret as its token
    {
      const hooks: { id: number; url: string }[] = [];
      reset([
        ["GET", `${P}/hooks`, () => hooks],
        ["POST", `${P}/hooks`, (_u, b) => { hooks.push({ id: 1, url: String(b.url) }); return hooks[0]; }],
        ["DELETE", `${P}/hooks/1`, () => new Response(null, { status: 204 })],
      ]);
      assert.equal(await gl.ensureHook(REPO, "https://otter.example/webhooks/gitlab", "s3cret"), true);
      assert.equal(await gl.ensureHook(REPO, "https://otter.example/webhooks/gitlab", "s3cret"), false);
      const post = sent.find((s) => s.method === "POST");
      assert.deepEqual(post?.body, { url: "https://otter.example/webhooks/gitlab", token: "s3cret", merge_requests_events: true, note_events: true, push_events: false, enable_ssl_verification: true });
      await gl.removeHook(REPO, "https://otter.example/webhooks/gitlab");
      assert.ok(sent.some((s) => s.method === "DELETE" && s.url === `${P}/hooks/1`));
      ctx.diagnostic("project hook added once with merge request and note events, removed by URL");
    }

    // diff discussions: CodeOtter's fixed ones resolved (answered when the token may not resolve), threads read and replied in
    {
      const ours = "<!-- codeotter:suggestion:src/a.ts:12 -->\n**Null check**";
      const pos = { new_path: "src/a.ts", old_path: "src/a.ts", new_line: 12, old_line: null };
      const d1 = "a".repeat(40), d2 = "c".repeat(40), d3 = "d".repeat(40), d4 = "e".repeat(40);
      reset([
        ["GET", `${ORIGIN}/api/v4/user`, () => ({ id: 5, username: "otter" })],
        ["GET", `${P}/merge_requests/7/discussions`, () => [
          { id: d1, notes: [{ id: 10, type: "DiffNote", body: ours, author: { id: 5 }, resolvable: true, resolved: false, position: pos, created_at: "2026-11-20T10:00:00Z" },
            { id: 11, type: "DiffNote", body: "Why?", author: { id: 42, username: "dev" }, created_at: "2026-11-20T10:05:00Z" }] },
          { id: d2, notes: [{ id: 20, type: "DiffNote", body: ours, author: { id: 5 }, resolvable: true, resolved: true, position: pos }] },
          { id: d3, notes: [{ id: 30, type: "DiffNote", body: ours, author: { id: 77 }, resolvable: true, resolved: false, position: pos }] },
          { id: d4, notes: [{ id: 40, type: null, body: "top-level", author: { id: 5 } }] },
          { id: "../x", notes: [{ id: 50, type: "DiffNote", body: ours, author: { id: 5 }, resolvable: true, resolved: false, position: pos }] },
        ]],
        ["PUT", `${P}/merge_requests/7/discussions/${d1}`, () => new Response("", { status: 403 })],
        ["POST", `${P}/merge_requests/7/discussions/${d1}/notes`, () => ({ id: 12 })],
      ]);
      assert.equal(await gl.resolveInline(REPO, 7, (b) => b.includes("codeotter:suggestion:src/a.ts:12"), "✅ Resolved in `abc1234`"), 1, "only an open discussion CodeOtter started");
      assert.deepEqual(sent.filter((s) => s.method !== "GET").map((s) => [s.method, s.url.slice(P.length), s.body]), [
        ["PUT", `/merge_requests/7/discussions/${d1}`, { resolved: true }],
        ["POST", `/merge_requests/7/discussions/${d1}/notes`, { body: "✅ Resolved in `abc1234`" }],
      ], "a 403 on resolve answers in the discussion instead");
      const threads = await gl.reviewThreads!(REPO, 7);
      assert.deepEqual(threads.map((t) => t.map((c) => [c.id, c.user.login, c.path, c.line, c.thread])), [
        [[10, "", "src/a.ts", 12, d1], [11, "dev", "src/a.ts", 12, d1]],
        [[20, "", "src/a.ts", 12, d2]],
        [[30, "", "src/a.ts", 12, d3]],
      ], "diff discussions only, with their discussion id");
      sent = [];
      await gl.replyInThread!(REPO, 7, threads[0][0], "<!-- codeotter:reply -->\nFair point.");
      assert.deepEqual(sent.map((s) => [s.method, s.url.slice(P.length), s.body?.body]), [["POST", `/merge_requests/7/discussions/${d1}/notes`, "<!-- codeotter:reply -->\nFair point."]]);
      assert.throws(() => gl.replyInThread!(REPO, 7, { ...threads[0][0], thread: "../x" }, "x"), /Invalid discussion id/);
      ctx.diagnostic("resolveInline resolves CodeOtter's open diff discussions; reviewThreads / replyInThread use discussions");
    }

    // a redirect is refused with the token attached
    {
      reset([["GET", `${P}/merge_requests/9`, () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })]]);
      await assert.rejects(gl.api(`projects/${encodeURIComponent("acme/platform/api")}/merge_requests/9`), /302/);
      assert.equal(sent.length, 1);
      assert.throws(() => gl.api("../admin"), /Invalid git server API path/);
      ctx.diagnostic("redirects and paths outside /projects and /user are refused");
    }

    // webhooks through the real queue blocks
    {
      const block = serverBlocks("pr-events", "webhooks", "forwarder", "forge-hooks");
      const settings = new Map<string, unknown>([["review", { auto: true, commands: true }], ["triage", { auto: false }], ["githubApp", {}], ["gitlabWebhook", { secret: "gl-secret" }]]);
      const calls: unknown[][] = [];
      const FORGES = { gitlab: f };
      const FORGE_API = { gitlab: gl };
      globalThis.fetch = async () => Response.json({});
      const stubs: Record<string, unknown> = {
        SHA_RE: /^[0-9a-f]{7,40}$/i, REPO_RE, FORGES, FORGE_API, secretMatches,
        forgeOf: () => gl, APP_URL: "https://otter.example", PORT: 4747, IS_SERVER: false,
        createHmac, timingSafeEqual, randomBytes,
        spawn: () => { throw new Error("no spawn in tests"); },
        fetch: async () => { throw new Error("no network in tests"); },
        createGitHubAppJwt: () => "jwt", forgetGithubRepos: () => {},
        store: { getSetting: async (k: string) => settings.get(k) ?? null, setSetting: async (k: string, v: unknown) => { settings.set(k, v); } },
        triageConfig: async () => ({ auto: false }),
        reviewConfig: async () => ({ auto: true, commands: true }),
        repoOf: () => REPO, ghEnv: () => process.env, repos: async () => [REPO], openPrs: async () => [],
        forgeId: (r: string) => /^([a-z]+)~/.exec(r)?.[1] || "", isForgeRepo: (r: string) => /^[a-z]+~/.test(r), nativeRepo: (r: string) => r.replace(/^[a-z]+~/, ""),
        oneLine: (x: unknown, max: number) => String(x).slice(0, max),
        triagePr: async () => {},
        score: async (url: string, _force: boolean, repo: string) => { calls.push(["score", url, repo]); return { pr: { url } }; },
        syncPrComments: async () => {},
        normalizeForgePr: () => { throw new Error("GitLab routes through its adapter"); },
        parseCommand: (body: unknown) => { const m = String(body || "").match(/^\/(review|ask)(?:\s+(.*))?$/); return m ? { cmd: m[1], arg: m[2] || "" } : null; },
        commentPrNumber: (c: { prNumber?: unknown }) => Number(c?.prNumber) || 0,
        commenterTrusted: async (_r: string, c: ForgeComment) => c.user.id === 42,
        runCommand: async (repo: string, c: { id: unknown }, cmd: { cmd: string }) => { calls.push(["command", repo, c.id, cmd.cmd]); },
        answerReplies: async (repo: string, n: number, commentId: string) => { calls.push(["replies", repo, n, commentId]); return 1; },
        AUTO: { id: "auto", name: "auto" },
        withActor: (_actor: unknown, fn: () => unknown) => fn(),
        effectiveRules: async (_repo: string, ui: object) => ui,
        skipReason: () => "",
      };
      const names = Object.keys(stubs);
      const q = new Function(...names, `${block}; return { handleWebhook, pending: () => PR_QUEUE.size || REPLY_QUEUE.size || prDraining };`)(...names.map((n) => stubs[n])) as {
        handleWebhook: (src: string, h: Record<string, string | undefined>, raw: Buffer) => Promise<{ status: number; body: unknown }>; pending: () => unknown;
      };
      const settle = async () => { for (let i = 0; i < 100 && q.pending(); i++) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 30)); };
      const deliver = (event: string, body: unknown, token: string | undefined, key = randomBytes(8).toString("hex")) =>
        q.handleWebhook("gitlab", { "x-gitlab-event": event, "x-gitlab-token": token, "idempotency-key": key }, Buffer.from(JSON.stringify(body)));
      const project = { path_with_namespace: "acme/platform/api" };
      const mr = (action: string, state = "opened") => ({ object_kind: "merge_request", project, user: { id: 42, username: "dev" }, object_attributes: { iid: 7, action, state, title: "t", source_branch: "feat", target_branch: "main", last_commit: { id: head }, updated_at: "2026-11-20 10:00:00 UTC" } });

      assert.equal((await deliver("Merge Request Hook", mr("open"), "wrong")).status, 401);
      assert.equal((await deliver("Merge Request Hook", mr("open"), undefined)).status, 401);
      assert.equal((await deliver("Merge Request Hook", mr("open"), "gl-secre")).status, 401, "never a prefix match");
      await settle();
      assert.deepEqual(calls, []);
      assert.equal((await deliver("Merge Request Hook", mr("update"), "gl-secret", "k1")).status, 202);
      assert.equal((await deliver("Merge Request Hook", mr("update"), "gl-secret", "k1")).status, 202, "a retry is answered");
      await settle();
      assert.deepEqual(calls, [["score", `${ORIGIN}/acme/platform/api/-/merge_requests/7`, REPO]], "and run once");
      calls.length = 0;
      await deliver("Merge Request Hook", mr("close", "closed"), "gl-secret");
      await deliver("Merge Request Hook", mr("approved"), "gl-secret");
      await deliver("Merge Request Hook", { ...mr("open"), project: { path_with_namespace: "other/repo" } }, "gl-secret");
      await settle();
      assert.deepEqual(calls, [], "closed, approvals and repositories not onboarded run nothing");

      const note = (id: number, userId: number, extra: Record<string, unknown> = {}) => ({ object_kind: "note", project, user: { id: userId, username: "dev" }, merge_request: { iid: 7 }, object_attributes: { id, note: "/review", noteable_type: "MergeRequest", author_id: userId, created_at: "2026-11-20 10:00:00 UTC", ...extra } });
      await deliver("Note Hook", note(501, 42), "gl-secret", "n1");
      await deliver("Note Hook", note(501, 42), "gl-secret", "n2"); // the same comment again
      await deliver("Note Hook", note(502, 43), "gl-secret"); // not trusted
      await deliver("Note Hook", note(503, 42, { system: true }), "gl-secret");
      await deliver("Note Hook", note(504, 42, { noteable_type: "Issue" }), "gl-secret");
      await settle();
      assert.deepEqual(calls, [["command", REPO, 501, "review"]]);
      calls.length = 0;
      await deliver("Note Hook", note(601, 42, { note: "Why is this wrong?", type: "DiffNote" }), "gl-secret");
      await deliver("Note Hook", note(602, 42, { note: "/review", type: "DiffNote" }), "gl-secret");
      await settle();
      assert.deepEqual(calls, [["replies", REPO, 7, "601"], ["command", REPO, 602, "review"]], "a diff-discussion note is a reply candidate; a command there still runs");
      calls.length = 0;
      assert.equal((settings.get("commandsSeen") as Record<string, string>)[REPO], "2026-11-20T10:00:00.000Z", "webhook dates read as UTC");
      ctx.diagnostic("webhooks: X-Gitlab-Token in constant time, retries de-duplicated, MR open/update queued, note commands once and trusted only");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
