// Repository rules (core/repo-rules.ts): globs, path filters, path instructions, skip decisions, the .codeotter.json
// merge, and that the file is read from the base repository's base branch only. A temp CODEOTTER_HOME, gh off PATH,
// and fetch stubbed for the Gitea adapter; nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("repository rules", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-rules-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), GITEA_URL: "https://git.example.test", GITEA_TOKEN: "tok", CODEOTTER_UPDATE_CHECK: "0" });
  const realFetch = globalThis.fetch;
  const sent: string[] = [];
  let files: Record<string, string> = {};
  globalThis.fetch = async (url: string | URL | Request) => {
    const u = String(url);
    sent.push(u);
    const m = u.match(/\/api\/v1\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)(?:\?ref=(.*))?$/);
    const key = m ? `${m[1]}@${decodeURIComponent(m[3] || "")}:${decodeURIComponent(m[2])}` : "";
    if (!(key in files)) return new Response("not found", { status: 404 });
    return Response.json({ encoding: "base64", content: Buffer.from(files[key]).toString("base64") });
  };
  try {
    const r = await import("../core/repo-rules.ts");
    const { normalizeReview, effectiveRules, repoConfigFile, clearRepoConfigCache } = await import("../core/context.ts");

    // globs
    const yes = (glob: string, path: string) => assert.ok(r.globMatch(path, glob), `${glob} should match ${path}`);
    const no = (glob: string, path: string) => assert.ok(!r.globMatch(path, glob), `${glob} should not match ${path}`);
    yes("*.lock", "pnpm.lock"); yes("*.lock", "a/b/yarn.lock"); no("*.lock", "a/lock.txt");
    yes("src/*.ts", "src/a.ts"); no("src/*.ts", "src/a/b.ts"); no("src/*.ts", "lib/src/a.ts");
    yes("src/**", "src/a/b/c.ts"); no("src/**", "lib/a.ts");
    yes("src/**/*.ts", "src/a.ts"); yes("src/**/*.ts", "src/x/y/a.ts"); no("src/**/*.ts", "src/a.js");
    yes("**/test/**", "test/a.ts"); yes("**/test/**", "pkg/test/a/b.ts"); no("**/test/**", "pkg/tests/a.ts");
    yes("dist/", "dist/app.js"); yes("dist/", "dist/x/y.js"); no("dist/", "src/dist.js");
    yes("/README.md", "README.md"); no("/README.md", "docs/README.md"); yes("README.md", "docs/README.md");
    yes("file?.ts", "file1.ts"); no("file?.ts", "file10.ts"); no("a?b", "a/b");
    yes("*.min.js", "public/vendor.min.js"); no("*.min.js", "public/vendorxminjs");
    yes("docs/[draft].md", "docs/[draft].md"); no("docs/[draft].md", "docs/d.md");
    yes("**", "any/path/at/all.txt");
    ctx.diagnostic("glob matching");

    // path filters and path instructions
    const diff = [
      "diff --git a/src/api/user.ts b/src/api/user.ts\n--- a/src/api/user.ts\n+++ b/src/api/user.ts\n@@ -1 +1 @@\n-a\n+b\n",
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-x\n+y\n",
      "diff --git a/dist/old.js b/dist/old.js\ndeleted file mode 100644\n--- a/dist/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n",
    ].join("");
    assert.deepEqual(r.diffFiles(diff), ["src/api/user.ts", "pnpm-lock.yaml", "dist/old.js"]);
    assert.equal(r.filterDiff(diff, { pathInclude: [], pathExclude: [] }).diff, diff);
    const ex = r.filterDiff(diff, { pathInclude: [], pathExclude: ["pnpm-lock.yaml", "dist/"] });
    assert.deepEqual(ex.excluded, ["pnpm-lock.yaml", "dist/old.js"]);
    assert.deepEqual(r.diffFiles(ex.diff), ["src/api/user.ts"]);
    const inc = r.filterDiff(diff, { pathInclude: ["src/**"], pathExclude: ["**/user.ts"] });
    assert.equal(inc.diff, "");
    const block = r.pathInstructionBlock([{ path: "src/api/**", instructions: "Check auth." }, { path: "**/*.sql", instructions: "Reversible." }], r.diffFiles(diff));
    assert.match(block, /src\/api\/\*\*: Check auth\./);
    assert.doesNotMatch(block, /Reversible/);
    assert.equal(r.pathInstructionBlock([{ path: "**/*.sql", instructions: "Reversible." }], r.diffFiles(diff)), "");
    ctx.diagnostic("path filters and path instructions");

    // skip decisions
    const rules = r.normalizeRules({ skipAuthors: "dependabot[bot]\n*-bot", skipLabels: ["No-Review"], skipTitleKeywords: "WIP\n[skip review]", skipBaseBranches: ["gh-pages", "release/*"] });
    const pr = { isDraft: false, labels: [{ name: "feature" }], title: "Add totals", author: { login: "dev" }, baseRefName: "main" };
    assert.equal(r.skipReason(pr, rules), "");
    assert.equal(r.skipReason({ ...pr, isDraft: true }, rules), "draft");
    assert.equal(r.skipReason({ ...pr, isDraft: true }, { ...rules, reviewDrafts: true }), "");
    assert.equal(r.skipReason({ ...pr, labels: [{ name: "codeotter:skip" }] }, r.RULE_DEFAULTS), "label codeotter:skip");
    assert.equal(r.skipReason({ ...pr, labels: [{ name: "no-review" }] }, rules), "label no-review");
    assert.equal(r.skipReason({ ...pr, author: { login: "Dependabot[bot]" } }, rules), "author Dependabot[bot]");
    assert.equal(r.skipReason({ ...pr, author: { login: "deploy-bot" } }, rules), "author deploy-bot");
    assert.equal(r.skipReason({ ...pr, author: { login: "dependabot" } }, rules), "");
    assert.equal(r.skipReason({ ...pr, baseRefName: "release/1.2" }, rules), "base release/1.2");
    assert.equal(r.skipReason({ ...pr, baseRefName: "develop" }, { ...rules, onlyBaseBranches: ["main"] }), "base develop");
    assert.equal(r.skipReason({ ...pr, baseRefName: "" }, { ...rules, onlyBaseBranches: ["main"] }), "");
    assert.equal(r.skipReason({ ...pr, title: "wip: totals" }, rules), "title WIP");
    assert.equal(r.skipReason({ ...pr, title: "Totals [Skip Review]" }, rules), "title [skip review]");
    ctx.diagnostic("skip decisions");

    // settings round trip: the page sends text, one item per line; review settings keep their own keys
    const saved = normalizeReview({ auto: true, pathExclude: " **/*.lock \n\n dist/ ", pathInstructions: "src/**: Keep handlers small.\nnot an instruction", skipAuthors: ["a", "a", 3] });
    assert.deepEqual(saved.pathExclude, ["**/*.lock", "dist/"]);
    assert.deepEqual(saved.pathInstructions, [{ path: "src/**", instructions: "Keep handlers small." }]);
    assert.deepEqual(saved.skipAuthors, ["a"]);
    assert.equal(saved.auto, true);
    assert.equal(r.rulesAsText(saved).pathInstructions, "src/**: Keep handlers small.");
    ctx.diagnostic("settings round trip");

    // .codeotter.json: only the keys it sets, and they win
    assert.deepEqual(r.parseRepoConfig('{"pathExclude":["*.snap"],"reviewDrafts":true,"unknown":1}'), { pathExclude: ["*.snap"], reviewDrafts: true });
    assert.deepEqual(r.parseRepoConfig('{"pathInstructions":[{"path":"db/**","instructions":"Reversible."},{"path":1}]}'), { pathInstructions: [{ path: "db/**", instructions: "Reversible." }] });
    assert.throws(() => r.parseRepoConfig("{ nope"), /\.codeotter\.json/);
    assert.throws(() => r.parseRepoConfig("[]"), /expected a JSON object/);
    files = { "acme/shop@main:.codeotter.json": JSON.stringify({ skipAuthors: ["renovate[bot]"], pathExclude: [] }) };
    const ui = { ...rules, pathExclude: ["dist/"], skipLabels: ["no-review"] };
    const merged = await effectiveRules("gitea~acme/shop", ui, { baseRefName: "main" });
    assert.deepEqual(merged.skipAuthors, ["renovate[bot]"]);
    assert.deepEqual(merged.pathExclude, []);
    assert.deepEqual(merged.skipLabels, ["no-review"]);
    assert.deepEqual(merged.configFile?.sort(), ["pathExclude", "skipAuthors"]);
    const none = await effectiveRules("gitea~acme/other", ui, { baseRefName: "main" });
    assert.deepEqual(none.pathExclude, ["dist/"]);
    assert.equal(none.configFile, null);
    assert.equal(none.checks, undefined);
    // custom pre-merge checks in the file replace Repository settings' (normalised like the settings page's)
    clearRepoConfigCache();
    files = { "acme/shop@main:.codeotter.json": JSON.stringify({ checks: [{ name: "Changelog", instructions: "Has a CHANGELOG line?", mode: "block" }, { instructions: "" }, { instructions: "Tests?", mode: "bogus" }] }) };
    const withChecks = await effectiveRules("gitea~acme/shop", ui, { baseRefName: "main" });
    assert.deepEqual(withChecks.checks, [{ name: "Changelog", instructions: "Has a CHANGELOG line?", mode: "block" }, { name: "Check 2", instructions: "Tests?", mode: "warn" }]);
    assert.deepEqual(withChecks.configFile, ["checks"]);
    assert.deepEqual(withChecks.pathExclude, ["dist/"]);
    ctx.diagnostic("config merge");

    // fork safety: a fork PR's head carries a .codeotter.json that would turn every rule off; only the base is read
    clearRepoConfigCache();
    sent.length = 0;
    files = {
      "acme/shop@main:.codeotter.json": JSON.stringify({ skipTitleKeywords: ["WIP"] }),
      "evil/shop@feature:.codeotter.json": JSON.stringify({ skipTitleKeywords: [], pathExclude: ["**"] }),
      "acme/shop@feature:.codeotter.json": JSON.stringify({ pathExclude: ["**"] }),
    };
    const forkPr = { baseRefName: "main", headRefName: "feature", headRepo: "gitea~evil/shop", headRefOid: "a".repeat(40) };
    const forked = await effectiveRules("gitea~acme/shop", r.RULE_DEFAULTS, forkPr);
    assert.deepEqual(forked.skipTitleKeywords, ["WIP"]);
    assert.deepEqual(forked.pathExclude, []);
    assert.deepEqual(sent, ["https://git.example.test/api/v1/repos/acme/shop/contents/.codeotter.json?ref=main"]);
    assert.equal(r.skipReason({ title: "WIP: try", baseRefName: "main" }, forked), "title WIP");
    await assert.rejects(repoConfigFile("gitea~acme/../x"), /Invalid repository/);
    // GitHub with gh unavailable reads as no file, like the guide detection
    assert.equal(await repoConfigFile("acme/shop", "main"), null);
    ctx.diagnostic("fork safety");
  } finally {
    globalThis.fetch = realFetch;
  }
});
