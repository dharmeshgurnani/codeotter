// Review strictness profile and minimum severity to post: profile -> effective settings, what a Repository settings save
// stores, the language-model prompt per profile, and the findings posted to a pull request (Forgejo, stubbed fetch).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "codeotter-profile-"));
process.env.CODEOTTER_HOME = home;
delete process.env.PB_URL;
process.env.FORGEJO_URL = "https://forgejo.test";
process.env.FORGEJO_TOKEN = "test-token";

test("review profile", async (ctx) => {
  const { PROFILES, REVIEW_DEFAULTS, postable, resolveReview, reviewConfig, storedReview } = await import("../core/context.ts");
  const { prompt } = await import("../core/engines.ts");
  const { syncPrComments } = await import("../core/review.ts");
  const { store } = await import("../core/store.ts");
  const realFetch = globalThis.fetch;
  try {
    // ---- profile -> effective settings ----
    assert.deepEqual(resolveReview({}), REVIEW_DEFAULTS);
    assert.equal(resolveReview({ profile: "chill" }).maxFindings, PROFILES.chill.maxFindings);
    assert.equal(resolveReview({ profile: "chill" }).reflectMin, 7);
    assert.equal(resolveReview({ profile: "assertive" }).maxFindings, 12);
    assert.equal(resolveReview({ profile: "assertive" }).reflectMin, 3);
    assert.equal(resolveReview({ profile: "chill", maxFindings: 10 }).maxFindings, 10, "explicit value wins over the profile");
    assert.equal(resolveReview({ profile: "nonsense" as "chill" }).profile, "balanced");
    ctx.diagnostic("profile supplies maxFindings / reflectMin defaults; explicit values win");

    const repo = "forgejo~acme/shop";
    // An old install-wide "review" setting pins nothing once the repository has its own saved settings.
    await store.setSetting("review", { ...REVIEW_DEFAULTS });
    await store.setSetting("repoSettings", { [repo]: { review: { profile: "chill" } } });
    const chill = await reviewConfig(repo);
    assert.equal(chill.maxFindings, 5);
    assert.equal(chill.reflectMin, 7);
    await store.setSetting("repoSettings", { [repo]: { review: { profile: "assertive", maxFindings: 6 } } });
    const explicit = await reviewConfig(repo);
    assert.equal(explicit.maxFindings, 6);
    assert.equal(explicit.reflectMin, 3);
    ctx.diagnostic("reviewConfig resolves the repository's profile over the legacy global values");

    // ---- what a save stores ----
    const balanced = resolveReview({});
    // Switching profile with the sliders untouched: they follow the new profile.
    const s1 = storedReview(balanced, { ...balanced, profile: "chill" });
    assert.equal(s1.profile, "chill");
    assert.ok(!("maxFindings" in s1) && !("reflectMin" in s1));
    assert.equal(resolveReview(s1).maxFindings, 5);
    // A value moved off the profile's default is explicit and kept, also across a later profile change.
    const s2 = storedReview(balanced, { ...balanced, maxFindings: 10 });
    assert.equal(s2.maxFindings, 10);
    const s3 = storedReview(resolveReview(s2), { ...resolveReview(s2), profile: "chill" });
    assert.equal(resolveReview(s3).maxFindings, 10);
    assert.equal(resolveReview(s3).reflectMin, 7);
    assert.equal(storedReview(balanced, { minSeverity: "medium" }).minSeverity, "medium");
    assert.equal(storedReview(balanced, { minSeverity: "critical" }).minSeverity, "nit");
    ctx.diagnostic("saves keep only explicit maxFindings / reflectMin");

    // ---- prompt per profile ----
    const pr = { url: "https://forgejo.test/acme/shop/pulls/3", number: 3, title: "Fix totals", author: { login: "dev" }, baseRefName: "main", headRefName: "fix", changedFiles: 1, additions: 1, deletions: 1, files: [] };
    const diff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b";
    const c = { provider: "test", model: "stub", baseUrl: "", apiKey: "" } as Parameters<typeof prompt>[2];
    const pBalanced = prompt(pr, diff, c, resolveReview({}));
    const pChill = prompt(pr, diff, c, resolveReview({ profile: "chill" }));
    const pAssertive = prompt(pr, diff, c, resolveReview({ profile: "assertive" }));
    assert.ok(pBalanced.includes("Max 8 findings") && !pBalanced.includes("Profile:"));
    assert.ok(pChill.includes("Max 5 findings") && pChill.includes("Profile: chill") && /No nitpicks/.test(pChill));
    assert.ok(pAssertive.includes("Max 12 findings") && pAssertive.includes("Profile: assertive") && /nitpicks/.test(pAssertive));
    ctx.diagnostic("prompt instructions vary by profile");

    // ---- posted output filtered by minimum severity ----
    const findings = [
      { severity: "high" as const, file: "a.js", line: 1, title: "Drops tax", detail: "b drops tax" },
      { severity: "medium" as const, file: "a.js", line: 1, title: "Race", detail: "unsynchronised" },
      { severity: "low" as const, file: "a.js", line: 1, title: "Extract helper", detail: "duplicated" },
      { severity: "nit" as const, file: "a.js", line: 1, title: "Rename b", detail: "naming" },
    ];
    assert.deepEqual(postable(findings, "medium").map((f) => f.title), ["Drops tax", "Race"]);
    assert.equal(postable(findings).length, 4);
    assert.deepEqual(postable(findings, "high").map((f) => f.title), ["Drops tax"]);

    await store.setSetting("repoSettings", { [repo]: { review: { minSeverity: "medium" } } });
    const sent: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const get = (init.method || "GET") === "GET";
      if (!get) sent.push({ url, body: String(init.body || "") });
      const json = url.endsWith("/api/v1/user") ? { id: 1, login: "bot" } : get && url.includes("/comments") ? [] : { id: 9 };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const record = {
      pr: { ...pr, files: [{ path: "a.js", additions: 1, deletions: 1 }] },
      headSha: "a".repeat(40),
      blast: { score: 10, files: 1, lines: 2, hotspots: [], testFiles: 0 },
      review: { summary: "Fine.", verdict: "comment" as const, scores: { quality: 80, correctness_risk: 20, test_coverage: 50, readability: 80, pr_hygiene: 80 }, findings, walkthrough: [] },
    };
    await syncPrComments(record as unknown as Parameters<typeof syncPrComments>[0], repo, { postReview: true, postInlineSuggestions: true });
    const summary = sent.find((s) => s.body.includes("codeotter:review"));
    assert.ok(summary, "summary posted");
    assert.ok(summary.body.includes("Drops tax") && summary.body.includes("Race"));
    assert.ok(!summary.body.includes("Extract helper") && !summary.body.includes("Rename b"));
    const inline = sent.find((s) => s.url.includes("/pulls/3/reviews"));
    assert.ok(inline, "inline review posted");
    assert.ok(inline.body.includes("Drops tax") && inline.body.includes("Race"));
    assert.ok(!inline.body.includes("Extract helper") && !inline.body.includes("Rename b"));
    assert.equal(record.review.findings.length, 4, "the stored review keeps every finding");
    ctx.diagnostic("posted summary and inline comments carry only findings at or above the minimum severity");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  }
});
