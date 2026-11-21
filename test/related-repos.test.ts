// Context from related repositories (core/related.ts): Repository settings validation (same organization, same provider,
// onboarded, at most 7), the search budget and the repo+SHA cache, failure isolation, and what a developer sees.
// A temp CODEOTTER_HOME, gh off PATH, fetch stubbed for the GitLab adapter; nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { OutsideImpact } from "../core/diff.ts";

test("related repositories", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-related-"));
  const ORIGIN = "https://gitlab.example.test";
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), GITLAB_URL: ORIGIN, GITLAB_TOKEN: "glpat", CODEOTTER_UPDATE_CHECK: "0" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  const sent: string[] = [];
  // project -> search term -> blobs; "fail" answers 500, "hang" never answers
  let blobs: Record<string, Record<string, { path: string; startline: number; data: string }[]> | "fail" | "hang"> = {};
  globalThis.fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    sent.push(u);
    const m = u.match(/^https:\/\/gitlab\.example\.test\/api\/v4\/projects\/([^/]+)\/search\?scope=blobs&search=([^&]+)/);
    if (/\/api\/v4\/projects\/[^/?]+$/.test(u)) return Response.json({ default_branch: "main" }); // Repository settings reads the guides
    if (!m) return new Response("not found", { status: 404 });
    const project = decodeURIComponent(m[1]);
    const rows = blobs[project];
    if (rows === "fail") return new Response("boom", { status: 500 });
    if (rows === "hang") return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    return Response.json(rows?.[decodeURIComponent(m[2])] || []);
  };
  try {
    const rel = await import("../core/related.ts");
    const { store } = await import("../core/store.ts");
    const { SETTINGS_PAGES } = await import("../core/settings-pages.ts");
    const { reviewConfig } = await import("../core/context.ts");
    const { extractChangedSymbols, blastRadius } = await import("../core/diff.ts");

    // <settings>
    const REPO = "gitlab~acme/api";
    const onboarded = ["gitlab~acme/api", "gitlab~acme/web", "gitlab~acme/ops", "gitlab~other/web", "gitea~acme/web", "acme/web",
      ...[1, 2, 3, 4, 5, 6].map((i) => `gitlab~acme/svc${i}`)];
    assert.deepEqual(rel.relatedChoices(REPO, onboarded), ["gitlab~acme/web", "gitlab~acme/ops", ...[1, 2, 3, 4, 5, 6].map((i) => `gitlab~acme/svc${i}`)]);
    assert.deepEqual(rel.validateRelated(REPO, ["gitlab~acme/web", "gitlab~acme/web", "gitlab~acme/ops"], onboarded), ["gitlab~acme/web", "gitlab~acme/ops"]);
    assert.deepEqual(rel.validateRelated(REPO, undefined, onboarded), []);
    assert.throws(() => rel.validateRelated(REPO, ["gitlab~other/web"], onboarded), /same organization and provider/, "another organization");
    assert.throws(() => rel.validateRelated(REPO, ["gitea~acme/web"], onboarded), /same organization and provider/, "another provider");
    assert.throws(() => rel.validateRelated(REPO, ["acme/web"], onboarded), /same organization and provider/, "GitHub is another provider");
    assert.throws(() => rel.validateRelated(REPO, ["gitlab~acme/nope"], onboarded), /same organization and provider/, "not onboarded");
    assert.throws(() => rel.validateRelated(REPO, [REPO], onboarded), /same organization and provider/, "itself");
    assert.throws(() => rel.validateRelated(REPO, "gitlab~acme/web", onboarded), /must be a list/);
    assert.throws(() => rel.validateRelated(REPO, ["gitlab~acme/web", "gitlab~acme/ops", ...[1, 2, 3, 4, 5, 6].map((i) => `gitlab~acme/svc${i}`)], onboarded), /At most 7/);
    assert.deepEqual(rel.usableRelated(REPO, ["gitlab~acme/web", "gitlab~acme/gone", "gitlab~other/web"], onboarded), ["gitlab~acme/web"]);
    ctx.diagnostic("validation: onboarded, same organization, same provider, not itself, at most 7; offboarded repositories drop at review time");

    // through the Repository settings page: stored in repoSettings[repo].review, read back through reviewConfig
    await store.setSetting("repos", onboarded);
    const page = SETTINGS_PAGES.repo;
    const loaded = await page.load({ org: "gitlab~acme", repo: REPO });
    const field = loaded.sections[0].fields.find((f) => f.key === "related");
    assert.equal(field?.type, "multiselect");
    assert.deepEqual(field?.options?.map((o) => o.value), rel.relatedChoices(REPO, onboarded));
    await page.save({ repo: { related: ["gitlab~acme/web", "gitlab~acme/ops"] } }, { org: "gitlab~acme", repo: REPO });
    assert.deepEqual((await reviewConfig(REPO)).related, ["gitlab~acme/web", "gitlab~acme/ops"]);
    assert.deepEqual((await store.getSetting("repoSettings"))?.[REPO]?.review?.related, ["gitlab~acme/web", "gitlab~acme/ops"]);
    await assert.rejects(page.save({ repo: { related: ["gitea~acme/web"] } }, { org: "gitlab~acme", repo: REPO }), /same organization and provider/);
    await assert.rejects(page.save({ repo: { related: rel.relatedChoices(REPO, onboarded) } }, { org: "gitlab~acme", repo: REPO }), /At most 7/);
    assert.deepEqual((await reviewConfig(REPO)).related, ["gitlab~acme/web", "gitlab~acme/ops"], "a refused save changes nothing");
    assert.deepEqual((await reviewConfig("gitlab~acme/web")).related, [], "defaults to none");
    ctx.diagnostic("Repository settings: multiselect of in-scope repositories, saved in repoSettings[repo].review, refused saves keep the old list");
    // </settings>

    // <symbols>
    const diff = "diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,3 +1,3 @@\n-export function totalPrice(items) {\n+export function totalPrice(items, tax) {\n+  const helperInternal = (x) => x;\n+export const formatCart = (c) => c;";
    assert.deepEqual(extractChangedSymbols(diff, true), ["totalPrice", "formatCart"]);
    assert.ok(extractChangedSymbols(diff).includes("helperInternal"));
    ctx.diagnostic("symbols: exported declarations on changed lines");
    // </symbols>

    // <search>
    const blob = (path: string, startline: number, data: string) => ({ path, startline, data });
    blobs = {
      "acme/web": {
        totalPrice: [blob("src/checkout.ts", 10, "import x\nconst t = totalPrice(items);"), blob("src/notes.ts", 1, "totalPriceOld()"), blob("package.json", 1, "totalPrice")],
        formatCart: [blob("src/view.ts", 4, "formatCart(cart)")],
      },
      "acme/ops": { totalPrice: Array.from({ length: 10 }, (_, i) => blob(`jobs/j${i}.ts`, 1, `totalPrice(${i})`)) },
    };
    const budget = { ...rel.RELATED_BUDGET, perRepoHits: 4, totalHits: 6 };
    sent.length = 0;
    const a = await rel.relatedImpact(["gitlab~acme/web", "gitlab~acme/ops"], ["totalPrice", "formatCart"], "a".repeat(40), budget);
    const web = a.relatedCallers.filter((c) => c.repo === "gitlab~acme/web");
    assert.deepEqual(web.map((c) => `${c.file}:${c.line}:${c.symbol}`), ["src/checkout.ts:11:totalPrice", "src/view.ts:4:formatCart"], "loose matches and lock/json files dropped; line from startline");
    assert.equal(a.related.find((r) => r.repo === "gitlab~acme/ops")?.callers, 4, "per-repository hit budget");
    assert.equal(a.relatedCallers.length, 6, "total hit budget");
    assert.ok(a.relatedFormatted.includes("[gitlab~acme/web] src/checkout.ts:11 uses 'totalPrice'"));
    assert.ok(sent.every((u) => u.startsWith(`${ORIGIN}/api/v4/`)), "only the configured origin");
    const firstCalls = sent.length;
    const b = await rel.relatedImpact(["gitlab~acme/web", "gitlab~acme/ops"], ["totalPrice", "formatCart"], "a".repeat(40), budget);
    assert.equal(sent.length, firstCalls, "second review of the same head is served from the cache");
    assert.ok(b.related.every((r) => r.cached));
    assert.deepEqual(b.relatedCallers, a.relatedCallers);
    await rel.relatedImpact(["gitlab~acme/web"], ["totalPrice", "formatCart"], "b".repeat(40), budget);
    assert.ok(sent.length > firstCalls, "a new head searches again");
    const few = await rel.relatedImpact(["gitlab~acme/web"], ["totalPrice", "formatCart", "a1", "a2", "a3", "a4", "a5"], "c".repeat(40), { ...budget, symbols: 1 });
    assert.ok(few.relatedCallers.every((c) => c.symbol === "totalPrice"), "symbol budget");
    ctx.diagnostic("search: word-matched hits, per-repository and total hit budgets, symbol budget, cached by repository + head SHA");
    // </search>

    // <isolation>
    blobs["acme/ops"] = "fail";
    blobs["acme/svc1"] = "hang";
    const started = Date.now();
    const c = await rel.relatedImpact(["gitlab~acme/web", "gitlab~acme/ops", "gitlab~acme/svc1", "gitea~acme/web", "acme/web"], ["totalPrice"], "d".repeat(40), { ...budget, perRepoMs: 300, totalMs: 600 });
    const by = Object.fromEntries(c.related.map((r) => [r.repo, r.status]));
    assert.deepEqual(by, { "gitlab~acme/web": "ok", "gitlab~acme/ops": "failed", "gitlab~acme/svc1": "timeout", "gitea~acme/web": "unsupported", "acme/web": "failed" });
    assert.ok(Date.now() - started < 3000, "a hanging repository is cut at its time budget");
    assert.equal(c.relatedCallers.length, 1, "the healthy repository's usage survives the others failing");
    assert.match(c.related.find((r) => r.repo === "acme/web")?.error || "", /gh/, "GitHub without gh reports the reason");
    const again = await rel.relatedImpact(["gitlab~acme/ops"], ["totalPrice"], "d".repeat(40), budget);
    assert.ok(!again.related[0].cached, "failures are not cached");
    const none = await rel.relatedImpact(["gitlab~acme/web"], [], "e".repeat(40), budget);
    assert.equal(none.related[0].status, "skipped");
    ctx.diagnostic("isolation: failed, timed-out, unsupported and gh-less repositories are reported per repository; the rest still count");
    // </isolation>

    // <viewer>
    const record: { outsideDiffImpact: OutsideImpact } = { outsideDiffImpact: { symbols: ["totalPrice"], callers: [], outsideCallers: 0, uniqueFiles: 0, formatted: "",
      related: [{ repo: "gitlab~acme/web", status: "ok", callers: 2, files: 2 }, { repo: "gitlab~acme/ops", status: "ok", callers: 3, files: 3 }],
      relatedCallers: [
        { repo: "gitlab~acme/web", symbol: "totalPrice", file: "a.ts", line: 1, snippet: "totalPrice()" },
        { repo: "gitlab~acme/web", symbol: "totalPrice", file: "b.ts", line: 2, snippet: "totalPrice()" },
        { repo: "gitlab~acme/ops", symbol: "totalPrice", file: "secret.ts", line: 3, snippet: "totalPrice(SECRET)" },
      ],
      relatedFormatted: "prompt with snippets" } };
    const dev = rel.forViewer(record, ["gitlab~acme/api", "gitlab~acme/web"]);
    assert.deepEqual(dev.outsideDiffImpact.relatedCallers?.map((c) => c.file), ["a.ts", "b.ts"]);
    assert.deepEqual(dev.outsideDiffImpact.related?.map((r) => r.repo), ["gitlab~acme/web"]);
    assert.equal(dev.outsideDiffImpact.relatedHidden, 3, "usages in unassigned repositories arrive as a count only");
    assert.ok(!JSON.stringify(dev).includes("SECRET") && !JSON.stringify(dev).includes("acme/ops"));
    assert.equal(dev.outsideDiffImpact.relatedFormatted, undefined, "the prompt block never leaves the server");
    const admin = rel.forViewer(record, null);
    assert.equal(admin.outsideDiffImpact.relatedCallers?.length, 3);
    assert.equal(admin.outsideDiffImpact.relatedFormatted, undefined);
    assert.equal(record.outsideDiffImpact.relatedCallers?.length, 3, "the stored record is not changed");
    const plain: { outsideDiffImpact: OutsideImpact } = { outsideDiffImpact: { symbols: [], callers: [], outsideCallers: 0, uniqueFiles: 0, formatted: "" } };
    assert.equal(rel.forViewer(plain, []), plain);
    assert.deepEqual(rel.relatedCount(record.outsideDiffImpact), { usages: 5, repos: 2 });
    ctx.diagnostic("developer view: snippets only from assigned repositories, a count for the rest");
    // </viewer>

    // <blast>
    const files = [{ path: "src/cart.ts", additions: 3, deletions: 1 }];
    const base = blastRadius(files);
    const wide = blastRadius(files, 0, 0, { callers: 4, repos: 2 });
    assert.ok(wide.score > base.score);
    assert.equal(wide.relatedCallers, 4);
    assert.equal(base.relatedCallers, undefined);
    ctx.diagnostic("blast radius counts related-repository usages");
    // </blast>
  } finally {
    globalThis.fetch = realFetch;
  }
});
