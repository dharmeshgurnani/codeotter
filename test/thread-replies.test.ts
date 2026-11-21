// Replies under CodeOtter's inline comments: webhook -> queue -> model -> reply in the thread, on GitHub (gh stubbed) and
// Gitea (the real adapter against a stubbed fetch); learnings; and never answering itself, bots, outsiders or old threads.
// Runs the real <pr-events>, <webhooks> and <thread-replies> blocks with storage, gh and the model stubbed.
import assert from "node:assert";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { test } from "node:test";
import { serverBlocks } from "./helpers/server-blocks.ts";
import { makeForge, secretMatches, type ForgeConfig } from "../core/forges.ts";

type Headers = Record<string, string | undefined>;
interface Api {
  handleWebhook: (src: string, headers: Headers, raw: Buffer) => Promise<{ status: number; body: unknown }>;
  answerReplies: (repo: string, n: number, commentId?: string) => Promise<number>;
  pending: () => unknown;
}
type Row = Record<string, unknown>;

test("Thread replies", async (ctx) => {

const block = serverBlocks("pr-events", "webhooks", "thread-replies");
const realFetch = globalThis.fetch;
const MARK = "<!-- codeotter:suggestion:src/cart.js:3 -->\n🦦 **CodeOtter [MEDIUM]** — **Tax is hard-coded**";
const now = () => new Date().toISOString();

function load({ ghComments = [] as Row[], giteaReviews = {} as Record<number, Row[]>, trusted = true, commands = true, answer = '{"answer":"Fair point, the rate comes from config.","dismissed":false,"learning":""}', learnings = [] as string[] } = {}) {
  const settings = new Map<string, unknown>([["review", { commands }], ["githubApp", { webhookSecret: "gh-secret" }], ["giteaWebhook", { secret: "gt-secret" }]]);
  const calls: unknown[][] = [];
  const prompts: string[] = [];
  const saved = { learnings: [...learnings] };
  const FORGES: Record<string, ForgeConfig> = { gitea: { kind: "gitea", label: "Gitea", url: "https://git.example", token: "t" } };
  const FORGE_API = { gitea: makeForge("gitea", FORGES.gitea) };
  globalThis.fetch = (async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/api\/v1\//, "");
    calls.push(["forge", method, path, init.body ? JSON.parse(String(init.body)) : undefined]);
    if (path === "user") return Response.json({ id: 1, login: "otter-bot" });
    const reviews = path.match(/\/reviews\/(\d+)\/comments$/);
    if (reviews) return Response.json(giteaReviews[Number(reviews[1])] || []);
    if (path.endsWith("/reviews") && method === "GET") return Response.json(u.searchParams.get("page") === "1" ? Object.keys(giteaReviews).map((id) => ({ id: Number(id), state: "COMMENT" })) : []);
    return Response.json({});
  }) as typeof fetch;
  const stubs: Record<string, unknown> = {
    SHA_RE: /^[0-9a-f]{7,40}$/i,
    REPO_RE: /^(?:(?:gitea)~)?[\w][\w.-]*\/[\w][\w.-]*$/,
    FORGES, FORGE_API, secretMatches,
    forgeOf: (r: string) => (r.startsWith("gitea~") ? FORGE_API.gitea : undefined),
    APP_URL: "https://otter.example", PORT: 4747, IS_SERVER: false,
    createHmac, timingSafeEqual, randomBytes,
    spawn: () => { throw new Error("no spawn in tests"); },
    createGitHubAppJwt: () => "jwt",
    forgetGithubRepos: () => {},
    store: { getSetting: async (k: string) => settings.get(k) ?? null, setSetting: async (k: string, v: unknown) => { settings.set(k, v); } },
    triageConfig: async () => ({ auto: false }),
    reviewConfig: async () => ({ auto: false, ...(settings.get("review") as object) }),
    repoOf: (pr: { url: string }) => String(pr.url),
    ghEnv: () => process.env,
    repos: async () => ["acme/app", "gitea~acme/lib"],
    openPrs: async () => [],
    forgeId: (r: string) => /^([a-z]+)~/.exec(r)?.[1] || "",
    isForgeRepo: (r: string) => /^[a-z]+~/.test(r),
    hunkAt: () => "",
    nativeRepo: (r: string) => r.replace(/^[a-z]+~/, ""),
    oneLine: (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max),
    isObj: (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x),
    proseOf: (x: unknown, max: number) => String(x ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/(^|[^\w`])@(?=[\w-])/g, "$1@​").trim().slice(0, max),
    triagePr: async () => {},
    score: async () => { throw new Error("no reviews here"); },
    syncPrComments: async () => {},
    normalizeForgePr: () => ({}),
    parseCommand: (body: unknown) => (/^\/review/.test(String(body)) ? { cmd: "review", arg: "" } : null),
    commentPrNumber: () => 0,
    commandEnabled: (cmd: string, rc: { commands?: boolean; overrides?: boolean }) => (cmd === "override" ? !!rc.overrides : !!rc.commands),
    commenterTrusted: async (_repo: string, c: { author_association?: string; user?: { login?: string } }) => { calls.push(["trusted", c.user?.login, c.author_association]); return trusted; },
    runCommand: async () => { calls.push(["command"]); },
    llmConfig: async () => ({ provider: "test", model: "stub" }),
    askJson: async (_c: unknown, text: string) => { prompts.push(text); return JSON.parse(answer); },
    getRepoLearnings: async () => saved.learnings,
    setRepoLearnings: async (_repo: string, list: string[]) => { saved.learnings = list; return list; },
    ghAsync: async (...args: string[]) => {
      calls.push(["gh", ...args]);
      if (args.includes("--slurp")) return JSON.stringify([ghComments]);
      return "{}";
    },
    // replies are writes: posted as the GitHub App bot where installed (git.ts falls back to the operator)
    ghAsApp: async (repo: string, ...args: string[]) => { calls.push(["gh", ...args]); calls.push(["as-app", repo]); return "{}"; },
    audit: async (actor: { id: string }, action: string, target: string, detail: { command?: string }) => { calls.push(["audit", actor.id, action, target, detail.command]); },
    orgOfRepo: (r: string) => r.split("/")[0],
    withActor: (_actor: unknown, fn: () => unknown) => fn(),
    prUrlFor: (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`,
  };
  const names = Object.keys(stubs);
  const api = new Function(...names, `${block}; return { handleWebhook, answerReplies, pending: () => PR_QUEUE.size || REPLY_QUEUE.size || prDraining };`)(...names.map((n) => stubs[n])) as Api;
  return { ...api, calls, prompts, saved, settings };
}
const sign = (secret: string, raw: Buffer, prefix: string) => prefix + createHmac("sha256", secret).update(raw).digest("hex");
async function deliver(api: Api, src: string, event: string, body: unknown, secret: string) {
  const raw = Buffer.from(JSON.stringify(body));
  const sigHeader = src === "github" ? "x-hub-signature-256" : `x-${src}-signature`;
  return api.handleWebhook(src, { [`x-${src}-event`]: event, [`x-${src}-delivery`]: randomBytes(8).toString("hex"), [sigHeader]: sign(secret, raw, src === "github" ? "sha256=" : "") }, raw);
}
const settle = async (api: Api) => { for (let i = 0; i < 200 && api.pending(); i++) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 20)); };
const ghPosts = (calls: unknown[][]) => calls.filter((c) => c[0] === "gh" && c.includes("POST"));

// GitHub: the thread as the REST API lists it, and the webhook for the latest reply
const root = { id: 100, body: MARK, path: "src/cart.js", line: 3, diff_hunk: "@@ -1,2 +1,3 @@\n+  return t * 1.15;", created_at: "2026-11-20T09:00:00Z", user: { id: 9, login: "otter", type: "User" }, author_association: "OWNER" };
const reply = { id: 101, in_reply_to_id: 100, body: "This is intentional: NZ GST is fixed.", path: "src/cart.js", line: 3, created_at: now(), user: { id: 7, login: "dev", type: "User" }, author_association: "MEMBER" };
const hook = (c: Row, action = "created") => ({ action, repository: { full_name: "acme/app" }, pull_request: { number: 7, html_url: "https://github.com/acme/app/pull/7" }, comment: c });
{
  const api = load({ ghComments: [root, reply] });
  assert.strictEqual((await deliver(api, "github", "pull_request_review_comment", hook(reply), "gh-secret")).status, 202);
  await settle(api);
  const posts = ghPosts(api.calls);
  assert.strictEqual(posts.length, 1);
  assert.deepStrictEqual(posts[0].slice(1, 5), ["api", "--method", "POST", "repos/acme/app/pulls/7/comments/100/replies"]);
  assert.match(String(posts[0][6]), /^body=<!-- codeotter:reply -->\nFair point/);
  assert.ok(api.calls.some((c) => c[0] === "as-app" && c[1] === "acme/app"), "the reply is posted as the GitHub App bot where installed");
  assert.ok(api.calls.some((c) => c[0] === "audit" && c[2] === "command.run" && c[3] === "https://github.com/acme/app/pull/7" && c[4] === "reply"), "the reply is audited like a comment command");
  assert.match(api.prompts[0], /Tax is hard-coded/);
  assert.match(api.prompts[0], /return t \* 1\.15/, "the hunk");
  assert.match(api.prompts[0], /Latest reply from dev:\nThis is intentional/);
  assert.ok(!api.prompts[0].includes("<!-- codeotter"), "markers are not sent to the model");
  assert.deepStrictEqual(api.calls.find((c) => c[0] === "trusted"), ["trusted", "dev", "MEMBER"], "trust is read from the API, not the payload");
  ctx.diagnostic("GitHub: webhook -> queue -> model -> reply in the thread");
}

// loops and noise: our own reply, a bot, an edit, a top-level review comment, outsiders, commands off
{
  const ours = { ...reply, id: 102, body: "<!-- codeotter:reply -->\nFair point", user: { id: 9, login: "otter", type: "User" } };
  const bot = { ...reply, id: 103, body: "LGTM", user: { id: 5, login: "dependabot[bot]", type: "Bot" } };
  const api = load({ ghComments: [root, reply, ours, bot] });
  await deliver(api, "github", "pull_request_review_comment", hook(ours), "gh-secret");
  await deliver(api, "github", "pull_request_review_comment", hook(bot), "gh-secret");
  await deliver(api, "github", "pull_request_review_comment", hook(reply, "edited"), "gh-secret");
  await deliver(api, "github", "pull_request_review_comment", hook({ ...root, id: 104 }), "gh-secret");
  await settle(api);
  assert.strictEqual(api.prompts.length, 0);
  assert.strictEqual(ghPosts(api.calls).length, 0);
  // even if a bot's delivery got through, the thread scan sees the last comment is not a person's
  assert.strictEqual(await api.answerReplies("acme/app", 7, "103"), 0);
  assert.strictEqual(await api.answerReplies("acme/app", 7, ""), 0);
  // a thread that is not rooted in a CodeOtter comment
  const human = load({ ghComments: [{ ...root, body: "nit: rename" }, reply] });
  assert.strictEqual(await human.answerReplies("acme/app", 7, "101"), 0);
  const outsider = load({ ghComments: [root, reply], trusted: false });
  assert.strictEqual(await outsider.answerReplies("acme/app", 7, "101"), 0);
  assert.strictEqual(ghPosts(outsider.calls).length, 0);
  const off = load({ ghComments: [root, reply], commands: false });
  await deliver(off, "github", "pull_request_review_comment", hook(reply), "gh-secret");
  await settle(off);
  assert.ok(!off.calls.some((c) => c[0] === "gh"), "commands off: not even read");
  const twice = load({ ghComments: [root, reply] });
  assert.strictEqual(await twice.answerReplies("acme/app", 7, "101"), 1);
  assert.strictEqual(await twice.answerReplies("acme/app", 7, "101"), 0, "a reply is answered once");
  ctx.diagnostic("never answers itself, bots, edits, other threads, outsiders, twice, or with commands off");
}

// learnings: an explicit remember is recorded without the model; a dismissal is offered, not recorded
{
  const remember = { ...reply, body: "@codeotter remember `GST is fixed at 15% in cart totals`" };
  const api = load({ ghComments: [root, remember], learnings: ["older rule"] });
  assert.strictEqual(await api.answerReplies("acme/app", 7, "101"), 1);
  assert.deepStrictEqual(api.saved.learnings, ["older rule", "GST is fixed at 15% in cart totals"]);
  assert.strictEqual(api.prompts.length, 0);
  assert.match(String(ghPosts(api.calls)[0][6]), /Saved as a team learning.*GST is fixed/);
  const offer = load({ ghComments: [root, reply], answer: '{"answer":"Understood.","dismissed":true,"learning":"Do not flag the fixed GST rate in cart totals"}' });
  await offer.answerReplies("acme/app", 7, "101");
  assert.deepStrictEqual(offer.saved.learnings, []);
  assert.match(String(ghPosts(offer.calls)[0][6]), /Understood\.\n\nTo keep this as a team learning, reply `@codeotter remember Do not flag the fixed GST rate in cart totals`/);
  const failing = load({ ghComments: [root, reply], answer: "not json" });
  await assert.rejects(failing.answerReplies("acme/app", 7, "101"));
  assert.match(String(ghPosts(failing.calls)[0][6]), /CodeOtter could not answer/);
  ctx.diagnostic("remember records a learning; a dismissal offers one; a model failure is said in the thread");
}

// Gitea: a review event names no comment, so the PR's threads are scanned; CodeOtter's comments are the token's
{
  const g = (id: number, user: Row, body: string, created_at = now()) => ({ id, body, user, path: "src/cart.js", position: 3, diff_hunk: "@@ +1,3 @@", created_at });
  const otter = { id: 1, login: "otter-bot" }, dev = { id: 7, login: "dev" };
  const api = load({ giteaReviews: { 11: [g(1, otter, MARK, "2026-11-20T09:00:00Z")], 12: [g(2, dev, "Why? The rate is config-driven.")], 13: [{ ...g(3, dev, "old question", "2026-01-01T00:00:00Z"), position: 9 }, { ...g(4, otter, MARK, "2025-12-31T00:00:00Z"), position: 9 }] } });
  const body = { action: "reviewed", number: 4, repository: { full_name: "acme/lib" }, pull_request: { number: 4 } };
  assert.strictEqual((await deliver(api, "gitea", "pull_request_review_comment", body, "gt-secret")).status, 202);
  await settle(api);
  const posts = api.calls.filter((c) => c[0] === "forge" && c[1] === "POST");
  assert.strictEqual(posts.length, 1, "the stale thread on line 9 is left alone");
  assert.strictEqual(posts[0][2], "repos/acme/lib/pulls/4/reviews");
  assert.deepStrictEqual((posts[0][3] as { comments: Row[] }).comments, [{ path: "src/cart.js", new_position: 3, old_position: 0, body: "<!-- codeotter:reply -->\nFair point, the rate comes from config." }]);
  assert.deepStrictEqual(api.calls.find((c) => c[0] === "trusted"), ["trusted", "dev", undefined]);
  // our reply is now the thread's last comment: a second event answers nothing
  const after = load({ giteaReviews: { 11: [g(1, otter, MARK, "2026-11-20T09:00:00Z")], 12: [g(2, dev, "Why?")], 14: [g(5, otter, "<!-- codeotter:reply -->\nBecause.")] } });
  await deliver(after, "gitea", "pull_request_comment", { action: "created", is_pull: true, repository: { full_name: "acme/lib" }, issue: { number: 4 }, comment: { id: 5, body: "Because." } }, "gt-secret");
  await settle(after);
  assert.ok(!after.calls.some((c) => c[0] === "forge" && c[1] === "POST"));
  assert.ok(after.calls.some((c) => c[0] === "forge" && c[2] === "repos/acme/lib/pulls/4/reviews"), "a PR comment event scans the threads");
  ctx.diagnostic("Gitea: review events scan threads, reply as a review comment on the same line, stop once answered");
}

globalThis.fetch = realFetch;

});
