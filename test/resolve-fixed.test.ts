// Resolving CodeOtter's own inline comments that a later push fixed: the model check (<fixed-check> in engines.ts), GitHub's
// GraphQL thread resolution (<resolve-fixed> in review.ts, gh stubbed) and the git server adapters (fetch stubbed).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serverBlock } from "./helpers/server-blocks.ts";

process.env.CODEOTTER_HOME = mkdtempSync(join(tmpdir(), "codeotter-resolve-"));
const { makeForge } = await import("../core/forges.ts");

interface F { file: string; line?: number; severity: string; title: string; detail: string }
type Sent = { method: string; url: string; body?: Record<string, unknown> };
type Route = [method: string, url: string | RegExp, reply: (url: string) => Response | object];

test("resolve fixed comments", async (ctx) => {
  const fixedFinding: F = { file: "src/cart.js", line: 12, severity: "high", title: "Tax rate is hard-coded", detail: "Use TAX_RATE." };
  const otherFinding: F = { file: "src/cart.js", line: 12, severity: "low", title: "Name is unclear", detail: "Rename t." };
  const delta = "diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ -12 +12 @@\n-  return t * 1.15;\n+  return t * (1 + TAX_RATE);";

  // --- model check ------------------------------------------------------------------------------------------------
  {
    const prompts: string[] = [];
    let s1Answer = 0.9;
    const confirm = new Function("askModel", "askSystemOne", "compressDiff", `${serverBlock("fixed-check")}; return confirmFixedFindings;`)(
      async (p: string) => { prompts.push(p); return 'Sure: {"fixed":[{"index":0,"fixed":true},{"index":1,"fixed":false}]}'; },
      async (_state: unknown, q: Record<string, unknown>) => ({ [Object.keys(q)[0]]: { noul: s1Answer } }),
      (d: string) => ({ diff: d }),
    ) as (f: F[], d: string, s1: object | null, llm: object | null) => Promise<F[]>;
    const llm = { provider: "test", model: "stub", api: "openai" };
    assert.deepEqual(await confirm([fixedFinding, otherFinding], delta, null, llm), [fixedFinding]);
    assert.match(prompts[0], /Tax rate is hard-coded/);
    assert.match(prompts[0], /TAX_RATE\);/);
    assert.deepEqual(await confirm([fixedFinding], "", null, llm), [], "no push since, nothing fixed");
    assert.deepEqual(await confirm([fixedFinding, otherFinding], delta, { enabled: true, provider: "s1", model: "m" }, null), [fixedFinding, otherFinding]);
    s1Answer = 0.1;
    assert.deepEqual(await confirm([fixedFinding], delta, { enabled: true, provider: "s1", model: "m" }, null), []);
    await assert.rejects(confirm([fixedFinding], delta, null, null), /No model/);
    await assert.rejects(confirm([fixedFinding], delta, null, { ...llm, api: "codereviewer" }), /No model/);
    ctx.diagnostic("a model, not the title match, decides which comments a push fixed");
  }

  // --- GitHub: GraphQL review threads -------------------------------------------------------------------------------
  {
    const calls: string[][] = [];
    const ourBody = "<!-- codeotter:suggestion:src/cart.js:12 -->\n🦦 **CodeOtter [HIGH]** — **Tax rate is hard-coded** (`src/cart.js:L12`)";
    const sameLineOther = "<!-- codeotter:suggestion:src/cart.js:12 -->\n🦦 **CodeOtter [LOW]** — **Name is unclear** (`src/cart.js:L12`)";
    const thread = (id: string, body: string, extra: object = {}) => ({ id, isResolved: false, viewerCanResolve: true, viewerCanReply: true, comments: { nodes: [{ body, viewerDidAuthor: true }] }, ...extra });
    const pages = [
      { nodes: [thread("T1", ourBody), thread("T2", sameLineOther), thread("T3", ourBody, { isResolved: true })], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: [thread("T4", ourBody, { comments: { nodes: [{ body: ourBody, viewerDidAuthor: false }] } }), thread("T5", ourBody, { viewerCanResolve: false })], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const ghAsync = async (args: string[]) => {
      calls.push(args);
      if (args.some((a) => a.startsWith("query=query"))) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: pages[args.includes("cursor=c1") ? 1 : 0] } } } });
      return "{}";
    };
    const block = new Function("ghAsync", "isForgeRepo", "forgeOf", "REPO_RE", "deriveSuggestionFromDetail", `${serverBlock("resolve-fixed")}; return resolveFixedComments;`);
    const resolve = block(ghAsync, () => false, () => { throw new Error("no forge"); }, /^[\w.-]+\/[\w.-]+$/, (f: F) => f) as (pr: object, repo: string, f: F[], sha: string) => Promise<number>;
    const n = await resolve({ url: "https://github.com/acme/shop/pull/7", number: 7 }, "acme/shop", [fixedFinding], "f".repeat(40));
    assert.equal(n, 2);
    const mutations = calls.filter((a) => a.some((x) => x.startsWith("query=mutation")));
    assert.deepEqual(mutations.map((a) => [a.find((x) => x.startsWith("query="))!.match(/resolveReviewThread|addPullRequestReviewThreadReply/)![0], a.find((x) => x.startsWith("id="))]), [["resolveReviewThread", "id=T1"], ["addPullRequestReviewThreadReply", "id=T5"]]);
    assert.ok(mutations[1].includes("body=✅ Resolved in `fffffff`"));
    assert.ok(calls[0].includes("owner=acme") && calls[0].includes("name=shop") && calls[0].includes("number=7"));
    assert.equal(await resolve({ url: "", number: 7 }, "acme/shop", [], "f"), 0);
    ctx.diagnostic("GitHub: only open threads we wrote for the fixed finding are resolved; no resolve permission -> reply");
  }

  // --- git server adapters -----------------------------------------------------------------------------------------
  const realFetch = globalThis.fetch;
  let routes: Route[] = [];
  let sent: Sent[] = [];
  globalThis.fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const method = init.method || "GET";
    sent.push({ method, url: String(url), body: init.body ? JSON.parse(init.body as string) : undefined });
    const hit = routes.find(([m, u]) => m === method && (u instanceof RegExp ? u.test(String(url)) : String(url).startsWith(u)));
    if (!hit) return new Response("not found", { status: 404 });
    const out = hit[2](String(url));
    return out instanceof Response ? out : Response.json(out);
  };
  const reset = (r: Route[]) => { routes = r; sent = []; };
  const ours = (body: string) => body.includes("<!-- codeotter:suggestion:src/cart.js:12 -->") && body.includes("**Tax rate is hard-coded**");
  const MARK = "<!-- codeotter:suggestion:src/cart.js:12 -->\n**Tax rate is hard-coded**";
  try {
    // Bitbucket Cloud: resolve endpoint; a 404 (older API) falls back to a reply
    {
      const bb = makeForge("bitbucket", { kind: "bitbucket", label: "Bitbucket", fixed: true, url: "https://bitbucket.org", token: "tok", user: "me@example.com" });
      const API = "https://api.bitbucket.org/2.0/repositories/team/app/pullrequests/5/comments";
      reset([
        ["GET", "https://api.bitbucket.org/2.0/user", () => ({ account_id: "me" })],
        ["GET", API, () => ({ values: [
          { id: 1, inline: { path: "src/cart.js", to: 12 }, content: { raw: MARK }, user: { account_id: "me" } },
          { id: 2, inline: { path: "src/cart.js", to: 12 }, content: { raw: MARK }, user: { account_id: "someone" } },
          { id: 3, inline: { path: "src/cart.js", to: 12 }, content: { raw: MARK }, user: { account_id: "me" }, resolution: { type: "resolved" } },
          { id: 4, content: { raw: MARK }, user: { account_id: "me" } },
          { id: 5, inline: { path: "src/cart.js", to: 12 }, content: { raw: MARK }, user: { account_id: "me" } },
        ] })],
        ["POST", `${API}/1/resolve`, () => ({ type: "resolved" })],
        ["POST", `${API}/5/resolve`, () => new Response("no", { status: 404 })],
        ["POST", API, () => ({ id: 9 })],
      ]);
      assert.equal(await bb.resolveInline("bitbucket~team/app", 5, ours, "✅ Resolved in `abc1234`"), 2);
      const writes = sent.filter((s) => s.method === "POST");
      assert.deepEqual(writes.map((s) => s.url.replace(API, "")), ["/1/resolve", "/5/resolve", ""]);
      assert.deepEqual(writes[2].body, { content: { raw: "✅ Resolved in `abc1234`" }, parent: { id: 5 } });
      ctx.diagnostic("Bitbucket Cloud: own open inline comments resolved, reply where resolving is refused");
    }

    // Azure DevOps: our active inline thread gets a reply and status fixed
    {
      const az = makeForge("azure", { kind: "azure", label: "Azure DevOps", fixed: true, url: "https://dev.azure.com", token: "pat", orgs: ["contoso"] });
      const G = "https://dev.azure.com/contoso/Web%20Shop/_apis/git/repositories/api/pullRequests/31/threads";
      reset([
        ["GET", "https://dev.azure.com/contoso/_apis/connectionData", () => ({ authenticatedUser: { id: "me" } })],
        ["GET", G, () => ({ value: [
          { id: 10, status: "active", threadContext: { filePath: "/src/cart.js" }, comments: [{ id: 1, content: MARK, author: { id: "me" }, publishedDate: "2026-11-01" }] },
          { id: 11, status: "fixed", threadContext: { filePath: "/src/cart.js" }, comments: [{ id: 1, content: MARK, author: { id: "me" }, publishedDate: "2026-11-01" }] },
          { id: 12, status: "active", threadContext: { filePath: "/src/cart.js" }, comments: [{ id: 1, content: MARK, author: { id: "other" }, publishedDate: "2026-11-01" }] },
          { id: 13, status: "closed", comments: [{ id: 1, content: MARK, author: { id: "me" }, publishedDate: "2026-11-01" }] },
          { id: 14, status: "active", threadContext: { filePath: "/src/cart.js" }, comments: [{ id: 1, content: "<!-- codeotter:suggestion:src/cart.js:12 -->\n**Other**", author: { id: "me" }, publishedDate: "2026-11-01" }] },
        ] })],
        ["POST", `${G}/10/comments`, () => ({ id: 2 })],
        ["PATCH", `${G}/10`, () => ({ id: 10, status: "fixed" })],
      ]);
      assert.equal(await az.resolveInline("azure~contoso/Web Shop/api", 31, ours, "✅ Resolved in `abc1234`"), 1);
      const writes = sent.filter((s) => s.method !== "GET");
      assert.deepEqual(writes.map((s) => [s.method, s.url.split("?")[0].replace(G, "")]), [["POST", "/10/comments"], ["PATCH", "/10"]]);
      assert.deepEqual(writes[0].body, { parentCommentId: 1, content: "✅ Resolved in `abc1234`", commentType: 1 });
      assert.deepEqual(writes[1].body, { status: "fixed" });
      ctx.diagnostic("Azure DevOps: own active inline thread set to fixed");
    }

    // Bitbucket Data Center: threadResolved on 8.9+, a reply when the server ignores it
    {
      const dc = makeForge("bitbucketdc", { kind: "bitbucketdc", label: "Bitbucket Data Center", url: "https://git.example.com", token: "tok" });
      const P = "https://git.example.com/rest/api/latest/projects/OPS/repos/app/pull-requests/8";
      reset([
        ["GET", `${P}/activities`, () => ({ isLastPage: true, values: [
          { action: "COMMENTED", commentAnchor: { path: "src/cart.js" }, comment: { id: 1, text: MARK, version: 0 } },
          { action: "COMMENTED", commentAnchor: { path: "src/cart.js" }, comment: { id: 2, text: MARK, version: 3 } },
          { action: "COMMENTED", commentAnchor: { path: "src/cart.js" }, comment: { id: 3, text: MARK, threadResolved: true } },
          { action: "COMMENTED", comment: { id: 4, text: MARK } },
        ] })],
        ["GET", `${P}/comments/1`, () => ({ id: 1, text: MARK, version: 0 })],
        ["GET", `${P}/comments/2`, () => ({ id: 2, text: MARK, version: 3 })],
        ["PUT", `${P}/comments/1`, () => ({ id: 1, threadResolved: true })],
        ["PUT", `${P}/comments/2`, () => ({ id: 2 })],
        ["POST", `${P}/comments`, () => ({ id: 9 })],
      ]);
      assert.equal(await dc.resolveInline("bitbucketdc~OPS/app", 8, ours, "✅ Resolved in `abc1234`"), 2);
      const writes = sent.filter((s) => s.method !== "GET");
      assert.deepEqual(writes.map((s) => [s.method, s.url.replace(P, "")]), [["PUT", "/comments/1"], ["PUT", "/comments/2"], ["POST", "/comments"]]);
      assert.deepEqual(writes[0].body, { text: MARK, version: 0, threadResolved: true });
      assert.deepEqual(writes[2].body, { text: "✅ Resolved in `abc1234`", parent: { id: 2 } });
      ctx.diagnostic("Bitbucket Data Center: thread resolved, reply on servers without threadResolved");
    }

    // Gitea / Forgejo: no resolve API, so one PR comment lists the fixed comments
    {
      const gt = makeForge("gitea", { kind: "gitea", label: "Gitea", url: "https://gitea.example.com", token: "tok" });
      const R = "https://gitea.example.com/api/v1/repos/acme/shop";
      reset([
        ["GET", "https://gitea.example.com/api/v1/user", () => ({ id: 7, login: "otter" })],
        ["GET", /\/pulls\/3\/reviews\?.*page=1$/, () => [{ id: 40, user: { id: 7 } }, { id: 41, user: { id: 8 } }]],
        ["GET", /\/pulls\/3\/reviews\?/, () => []],
        ["GET", `${R}/pulls/3/reviews/40/comments`, () => [
          { id: 1, path: "src/cart.js", body: MARK, user: { id: 7 }, html_url: "https://gitea.example.com/acme/shop/pulls/3#issuecomment-1" },
          { id: 2, path: "src/cart.js", body: MARK, user: { id: 7 }, resolver: { id: 7 } },
        ]],
        ["POST", `${R}/issues/3/comments`, () => ({ id: 99 })],
      ]);
      assert.equal(await gt.resolveInline("gitea~acme/shop", 3, ours, "✅ Resolved in `abc1234`"), 1);
      const writes = sent.filter((s) => s.method === "POST");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body?.body, "✅ Resolved in `abc1234`\n\n- [`src/cart.js`](https://gitea.example.com/acme/shop/pulls/3#issuecomment-1): **Tax rate is hard-coded**");
      assert.ok(!sent.some((s) => s.url.includes("/reviews/41/")), "another account's review is not read");
      ctx.diagnostic("Gitea/Forgejo: reply listing the fixed comments");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
