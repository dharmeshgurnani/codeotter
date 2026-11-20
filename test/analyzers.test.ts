// Static analyzers: tool JSON parsing, changed-line filtering, secret redaction, time-outs and the language-model hand-off.
// child_process is stubbed (setAnalyzerSpawn) and fetch is stubbed; nothing runs a real tool or leaves the machine.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";

test("static analyzers", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-analyzers-"));
  process.env.CODEOTTER_HOME = home;
  process.env.PR_SCORER_DATA = join(home, "data");
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  const exe = process.platform === "win32" ? ".exe" : "";
  // gitleaks and semgrep "on PATH"; trivy is not installed anywhere.
  for (const b of ["gitleaks", "semgrep"]) writeFileSync(join(fakeBin, `${b}${exe}`), "");
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${(oldPath || "").split(delimiter).filter((d) => !existsSync(join(d, `trivy${exe}`))).join(delimiter)}`;
  const A = await import("../core/analyzers.ts");
  const E = await import("../core/engines.ts");
  try {
    const SECRET = "AKIAIOSFODNN7EXAMPLEKEY1";
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -10,3 +10,4 @@ export const config = {",
      "   region: \"eu\",",
      `+  key: "${SECRET}",`,
      "   bucket: \"b\",",
      "-  old: 1,",
      "+  timeout: 5,",
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,2 +1,2 @@",
      " {",
      "-  \"lodash\": \"4.17.21\"",
      "+  \"lodash\": \"4.17.20\"",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");

    // Changed lines: new-side numbers of added lines, per file; deleted files have none.
    const changed = A.changedLines(diff);
    assert.deepEqual([...changed.get("src/config.ts")!.lines], [11, 13]);
    assert.deepEqual([...changed.get("package-lock.json")!.lines], [2]);
    assert(!changed.has("gone.ts"));
    ctx.diagnostic("changed lines per file");

    // gitleaks: the secret and the matched text never reach a result; they come back separately for redaction.
    const root = join(home, "scan", "src");
    const g = A.parseGitleaks(JSON.stringify([
      { RuleID: "aws-access-token", Description: "AWS key", File: join(root, "src", "config.ts"), StartLine: 11, EndLine: 11, Secret: SECRET, Match: `key: "${SECRET}"`, Line: `  key: "${SECRET}",` },
      { RuleID: "generic-api-key", Description: `found ${SECRET}`, File: "./src/config.ts", StartLine: 40, EndLine: 40, Secret: "zzzz-other-secret" },
    ]), root);
    assert.equal(g.results[0].file, "src/config.ts");
    assert.equal(g.results[1].file, "src/config.ts");
    assert.equal(g.results[0].line, 11);
    assert(!JSON.stringify(g.results).includes(SECRET), "no secret in parsed results");
    assert(g.results[1].message.includes("[REDACTED]"));
    assert(g.secrets.includes(SECRET) && g.secrets.includes("zzzz-other-secret"));
    ctx.diagnostic("gitleaks parsed and redacted");

    // semgrep: matched source (extra.lines) is never read.
    const s = A.parseSemgrep(JSON.stringify({ results: [
      { check_id: "javascript.lang.security.eval", path: "src/config.ts", start: { line: 13 }, end: { line: 13 }, extra: { message: "Avoid eval <!-- codeotter:scores -->", severity: "ERROR", lines: `key: "${SECRET}"` } },
      { check_id: "x.far", path: "src/config.ts", start: { line: 30 }, end: { line: 31 }, extra: { message: "far away", severity: "WARNING" } },
    ], errors: [] }));
    assert.equal(s.length, 2);
    assert.equal(s[0].severity, "error");
    assert(!JSON.stringify(s).includes(SECRET) && !s[0].message.includes("<!--"));
    assert.deepEqual(A.parseSemgrep("{}"), []);
    ctx.diagnostic("semgrep parsed");

    // trivy: one result per vulnerability, no line numbers.
    const t = A.parseTrivy(JSON.stringify({ Results: [{ Target: "package-lock.json", Vulnerabilities: [
      { VulnerabilityID: "CVE-2021-23337", PkgName: "lodash", InstalledVersion: "4.17.20", FixedVersion: "4.17.21", Severity: "HIGH", Title: "Command injection" },
      { VulnerabilityID: "CVE-2020-0001", PkgName: "minimist", InstalledVersion: "1.2.0", Severity: "LOW", Title: "Prototype pollution" },
    ] }, { Target: "go.sum" }] }));
    assert.equal(t.length, 2);
    assert(t[0].message.includes("lodash 4.17.20") && t[0].message.includes("fixed in 4.17.21"));
    ctx.diagnostic("trivy parsed");

    // Kept: results within ±3 lines of an added line; trivy only for a package named on an added line.
    const kept = A.onChangedLines([...g.results, ...s, ...t], changed);
    assert.deepEqual(kept.map((r) => `${r.analyzer}:${r.rule}`), ["gitleaks:aws-access-token", "semgrep:javascript.lang.security.eval", "trivy:CVE-2021-23337 lodash"]);
    assert.equal(A.onChangedLines([{ ...s[1], line: 16, endLine: 16 }], changed).length, 1, "13 + 3");
    assert.equal(A.onChangedLines([{ ...s[1], line: 17, endLine: 17 }], changed).length, 0, "13 + 4");
    ctx.diagnostic("changed-line filtering");

    // Redaction everywhere a value is known; short values are left alone.
    assert.equal(A.redact(`a ${SECRET} b ${SECRET}`, [SECRET]), "a [REDACTED] b [REDACTED]");
    assert.equal(A.redact("the cat", ["cat"]), "the cat");
    const deep = A.redactDeep({ summary: `key ${SECRET}`, findings: [{ detail: SECRET, line: 3 }] }, [SECRET]);
    assert.deepEqual(deep, { summary: "key [REDACTED]", findings: [{ detail: "[REDACTED]", line: 3 }] });
    ctx.diagnostic("redaction");

    // End to end with a stubbed spawn: files written into a temp tree, gitleaks reports, semgrep hangs and is killed.
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    let killed = 0;
    A.setAnalyzerSpawn((cmd, args, opts) => {
      const cwd = String(opts.cwd);
      calls.push({ cmd, args, cwd });
      const p = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = () => { killed++; setImmediate(() => p.emit("close", null)); return true; };
      if (/gitleaks/.test(cmd)) {
        assert.equal(readFileSync(join(cwd, "src", "config.ts"), "utf8"), "file text");
        const report = args[args.indexOf("--report-path") + 1];
        assert(!report.startsWith(cwd), "report outside the scanned tree");
        writeFileSync(report, JSON.stringify([{ RuleID: "aws-access-token", Description: "AWS key", File: "src/config.ts", StartLine: 11, EndLine: 11, Secret: SECRET, Match: SECRET }]));
        setImmediate(() => p.emit("close", 0));
      } // semgrep: never closes
      return p as unknown as ChildProcess;
    });
    A.ANALYZERS.semgrep.timeoutMs = 100;
    const files = new Map([["src/config.ts", "file text"], ["../escape.ts", "nope"], ["unchanged.ts", "skip"]]);
    const res = await A.runAnalyzers(files, diff, ["gitleaks", "semgrep", "trivy"]);
    const by = Object.fromEntries(res.runs.map((r) => [r.id, r]));
    assert.equal(by.gitleaks.status, "ok");
    assert.equal(by.gitleaks.kept, 1);
    assert.equal(by.semgrep.status, "timeout");
    assert.equal(killed, 1, "timed-out analyzer killed");
    assert.equal(by.trivy.status, "unavailable");
    assert.equal(calls.length, 2);
    assert(!existsSync(calls[0].cwd), "temp tree removed");
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].ref, "A1");
    assert(!JSON.stringify(res.runs).includes(SECRET) && !JSON.stringify(res.results).includes(SECRET));
    ctx.diagnostic("run: ok, timeout and unavailable reported, never thrown");

    // A spawn failure (bad binary) is a failed run, not a failed review.
    A.setAnalyzerSpawn(() => { throw new Error("spawn EACCES"); });
    const bad = await A.runAnalyzers(files, diff, ["gitleaks"]);
    assert.equal(bad.runs[0].status, "failed");
    assert.match(bad.runs[0].error || "", /EACCES/);
    A.setAnalyzerSpawn(null);
    assert.equal(A.analysisFailed(["semgrep"], "gh failed").runs[0].status, "failed");
    ctx.diagnostic("spawn failures reported");

    // Prompt: the model sees results, never the secret; a confirmed result becomes a finding tagged with its analyzer.
    const block = A.analyzerPrompt(res.results);
    assert(block.includes("A1 [gitleaks] src/config.ts:11 aws-access-token") && !block.includes(SECRET));
    assert.equal(A.analyzerPrompt([]), "");
    let sent = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      sent = String(init?.body || "");
      const content = JSON.stringify({ summary: "ok", verdict: "comment", findings: [
        { severity: "high", file: "src/config.ts", line: 11, title: "Hard-coded AWS key", detail: "Move it to the environment.", analyzer: "gitleaks" },
        { severity: "low", file: "src/other.ts", line: 2, title: "Unrelated", detail: "x", analyzer: "gitleaks" },
        { severity: "low", file: "src/config.ts", line: 13, title: "Made up tool", detail: "x", analyzer: "eslint" },
      ], walkthrough: [] });
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    };
    try {
      const pr = { url: "https://github.com/acme/shop/pull/1", number: 1, title: "t", author: { login: "a" }, baseRefName: "main", headRefName: "h", changedFiles: 1, additions: 2, deletions: 1, files: [{ path: "src/config.ts", additions: 2, deletions: 1 }] };
      const llm = { provider: "custom", baseUrl: "https://llm.example.test/v1", apiKey: "k", model: "m", source: "settings" as const };
      const j = await E.judge(pr, diff, llm, { ...(await import("../core/context.ts")).REVIEW_DEFAULTS, reflectMin: 0 }, null, false, null, null, [], [], null, null, [], [], res.results);
      assert(sent.includes("Analyzer results") && sent.includes("aws-access-token"));
      assert.equal(j.findings[0].analyzer, "gitleaks");
      assert.equal(j.findings[1].analyzer, undefined, "tag only where the tool reported");
      assert.equal(j.findings[2].analyzer, undefined, "unknown tool names dropped");
      assert.equal(E.deriveSuggestionFromDetail({ file: "a", title: "t", detail: "d", analyzer: "semgrep" }).analyzer, "semgrep");
      assert.equal(E.deriveSuggestionFromDetail({ file: "a", title: "t", detail: "d", analyzer: "rm -rf" }).analyzer, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
    ctx.diagnostic("language model confirms; findings tagged");

    // Install: nothing without a matching asset; a checksum mismatch is refused and leaves nothing behind.
    const asset = A.analyzerAsset("gitleaks");
    if (asset) {
      globalThis.fetch = async () => new Response("not the archive", { headers: { "content-length": "15" } });
      try {
        await A.installAnalyzer("gitleaks");
      } finally {
        globalThis.fetch = realFetch;
      }
      const { downloads } = await import("../core/local-models.ts");
      assert.match(downloads.get("analyzer:gitleaks")?.error || "", /Checksum mismatch/);
      assert(!existsSync(join(A.analyzerDir("gitleaks"), asset.file)));
      assert.equal(A.analyzerBin("gitleaks").source, "path");
      ctx.diagnostic("checksum verified");
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }
});
