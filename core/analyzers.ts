// Static analyzers (gitleaks, semgrep, trivy): run on the changed files of a pull request's head, results kept to the
// changed lines and handed to the language model as evidence to confirm or reject. Never findings on their own.
// A binary comes from PATH or from a pinned, checksum-verified download started on Settings / Analyzers.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDiff } from "./diff.ts";
import { runtimeDir } from "./providers.ts";
import { downloadFile, downloads, findPython, TAR } from "./local-models.ts";
import type { DiffHunk } from "./diff.ts";

export const ANALYZER_IDS = ["gitleaks", "semgrep", "trivy"] as const;
export type AnalyzerId = (typeof ANALYZER_IDS)[number];
export const isAnalyzerId = (x: unknown): x is AnalyzerId => typeof x === "string" && (ANALYZER_IDS as readonly string[]).includes(x);

interface ArchiveInstall { kind: "archive"; source: string; assets: Record<string, { file: string; sha256: string }>; }
interface PipInstall { kind: "pip"; pkg: string; }
export interface Analyzer {
  label: string;
  checks: string;
  version: string;
  license: string;
  bin: string;
  timeoutMs: number;
  install: ArchiveInstall | PipInstall;
}
// Pinned releases. Checksums are the publishers' own (`*_checksums.txt` of each release).
export const ANALYZERS: Record<AnalyzerId, Analyzer> = {
  gitleaks: {
    label: "gitleaks",
    checks: "Secrets",
    version: "8.30.1",
    license: "MIT",
    bin: "gitleaks",
    timeoutMs: 60000,
    install: {
      kind: "archive",
      source: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/",
      assets: {
        "linux-x64": { file: "gitleaks_8.30.1_linux_x64.tar.gz", sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" },
        "linux-arm64": { file: "gitleaks_8.30.1_linux_arm64.tar.gz", sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" },
        "darwin-x64": { file: "gitleaks_8.30.1_darwin_x64.tar.gz", sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709" },
        "darwin-arm64": { file: "gitleaks_8.30.1_darwin_arm64.tar.gz", sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" },
        "win32-x64": { file: "gitleaks_8.30.1_windows_x64.zip", sha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e" },
        "win32-arm64": { file: "gitleaks_8.30.1_windows_arm64.zip", sha256: "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f" },
      },
    },
  },
  semgrep: {
    label: "Semgrep",
    checks: "SAST (p/ci rules)",
    version: "1.186.0",
    license: "LGPL-2.1",
    bin: "semgrep",
    timeoutMs: 300000,
    install: { kind: "pip", pkg: "semgrep==1.186.0" },
  },
  trivy: {
    label: "Trivy",
    checks: "Dependency vulnerabilities",
    version: "0.76.2",
    license: "Apache-2.0",
    bin: "trivy",
    timeoutMs: 300000,
    install: {
      kind: "archive",
      source: "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/",
      assets: {
        "linux-x64": { file: "trivy_0.76.2_Linux-64bit.tar.gz", sha256: "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf" },
        "linux-arm64": { file: "trivy_0.76.2_Linux-ARM64.tar.gz", sha256: "ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3" },
        "darwin-x64": { file: "trivy_0.76.2_macOS-64bit.tar.gz", sha256: "e08bb9ea449ecf66c6bfb03cbb8697c503ff33d35fc585c9747e3eaeb7ed4c7b" },
        "darwin-arm64": { file: "trivy_0.76.2_macOS-ARM64.tar.gz", sha256: "ae7ea358326960406b703c77b2ac490190797d80b306b5b50c2a27221da0a5b8" },
        "win32-x64": { file: "trivy_0.76.2_windows-64bit.zip", sha256: "691f737a7e5566a673c3a74dab9160552ec32101e953b659e5c77443d16dddb6" },
      },
    },
  },
};

// One result, already redacted: no secret value, no matched source text.
export interface AnalyzerResult { ref: string; analyzer: AnalyzerId; rule: string; file: string; line: number; endLine: number; severity: string; message: string; }
export type AnalyzerStatus = "ok" | "failed" | "timeout" | "unavailable";
// What a review stores and the review page shows per analyzer.
export interface AnalyzerRun { id: AnalyzerId; label: string; status: AnalyzerStatus; found: number; kept: number; ms: number; error?: string; }
export interface Analysis { runs: AnalyzerRun[]; results: AnalyzerResult[]; secrets: string[]; }

const EXE = process.platform === "win32" ? ".exe" : "";
const platform = `${process.platform}-${process.arch}`;
export const analyzerDir = (id: AnalyzerId): string => runtimeDir(`analyzer-${id}`);
const installedBin = (id: AnalyzerId): string => ANALYZERS[id].install.kind === "pip"
  ? join(analyzerDir(id), "venv", process.platform === "win32" ? "Scripts" : "bin", `${ANALYZERS[id].bin}${EXE}`)
  : join(analyzerDir(id), `${ANALYZERS[id].bin}${EXE}`);
const onPath = (name: string): string => {
  for (const d of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(d, `${name}${EXE}`);
    if (existsSync(p)) return p;
  }
  return "";
};
// Where the analyzer runs from: the downloaded copy first, else PATH. "" when neither.
export function analyzerBin(id: AnalyzerId): { bin: string; source: "download" | "path" | "" } {
  if (existsSync(installedBin(id))) return { bin: installedBin(id), source: "download" };
  const p = onPath(ANALYZERS[id].bin);
  return p ? { bin: p, source: "path" } : { bin: "", source: "" };
}
export const analyzerAsset = (id: AnalyzerId) => { const i = ANALYZERS[id].install; return i.kind === "archive" ? i.assets[platform] || null : null; };
export const canInstall = (id: AnalyzerId): boolean => (ANALYZERS[id].install.kind === "pip" ? !!findPython() : !!analyzerAsset(id));

const sha256File = (path: string): Promise<string> => new Promise((res, rej) => {
  const h = createHash("sha256");
  createReadStream(path).on("data", (d) => h.update(d)).on("error", rej).on("end", () => res(h.digest("hex")));
});
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Install from Settings / Analyzers (never on its own). Progress and errors in `downloads` under analyzer:<id>.
export async function installAnalyzer(id: AnalyzerId): Promise<void> {
  const a = ANALYZERS[id];
  const key = `analyzer:${id}`;
  if (downloads.get(key)?.active) return;
  const dir = analyzerDir(id);
  mkdirSync(dir, { recursive: true });
  if (a.install.kind === "pip") {
    const st = { active: true, done: 0, total: 0, error: "", label: `Installing ${a.install.pkg}` };
    downloads.set(key, st);
    try {
      const sys = findPython();
      if (!sys) throw new Error("Python 3.10+ is needed and was not found on PATH (set PR_SCORER_PYTHON)");
      const venv = join(dir, "venv");
      const py = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (!existsSync(py)) await exec(sys, [...(sys === "py" ? ["-3"] : []), "-m", "venv", venv], { timeoutMs: 600000 }).then(must);
      await exec(py, ["-m", "pip", "install", "--quiet", a.install.pkg], { timeoutMs: 1800000 }).then(must);
      if (!existsSync(installedBin(id))) throw new Error(`${a.install.pkg} installed no ${a.bin} executable`);
    } catch (e) {
      st.error = errMessage(e);
    } finally {
      st.active = false;
    }
    return;
  }
  const asset = a.install.assets[platform];
  if (!asset) { downloads.set(key, { active: false, done: 0, total: 0, error: `No ${a.label} build for ${platform}` }); return; }
  const archive = join(dir, asset.file);
  await downloadFile(`${a.install.source}${asset.file}`, archive, key);
  const st = downloads.get(key)!;
  if (st.error) { rmSync(archive, { force: true }); return; }
  st.active = true;
  st.label = "Verifying";
  try {
    const got = await sha256File(archive);
    if (got !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.file}: expected ${asset.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
    execFileSync(TAR, ["-xf", asset.file], { cwd: dir, windowsHide: true });
    if (!existsSync(installedBin(id))) for (const d of readdirSync(dir)) { const inner = join(dir, d, `${a.bin}${EXE}`); if (existsSync(inner)) renameSync(inner, installedBin(id)); }
    if (!existsSync(installedBin(id))) throw new Error(`${asset.file} did not contain ${a.bin}`);
  } catch (e) {
    st.error = errMessage(e);
  } finally {
    rmSync(archive, { force: true });
    st.active = false;
  }
}
export function removeAnalyzer(id: AnalyzerId): void {
  rmSync(analyzerDir(id), { recursive: true, force: true });
  downloads.delete(`analyzer:${id}`);
}

// Child processes. Swappable for tests (setAnalyzerSpawn); a run past its time limit is killed and reported.
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnFn: SpawnFn = spawn;
export const setAnalyzerSpawn = (fn: SpawnFn | null): void => { spawnFn = fn || spawn; };
interface ExecResult { code: number | null; stderr: string; timedOut: boolean; }
function exec(cmd: string, args: string[], { cwd, timeoutMs, env }: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult> {
  return new Promise((res, rej) => {
    let p: ChildProcess;
    try {
      p = spawnFn(cmd, args, { cwd, env: env || process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) { rej(e); return; }
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: ExecResult) => { if (!settled) { settled = true; clearTimeout(timer); res(r); } };
    const timer = setTimeout(() => { timedOut = true; try { p.kill("SIGKILL"); } catch {} done({ code: null, stderr, timedOut: true }); }, timeoutMs);
    p.stdout?.on("data", () => {});
    p.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    p.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
    p.on("close", (code) => done({ code, stderr, timedOut }));
  });
}
const must = (r: ExecResult): void => {
  if (r.timedOut) throw new Error("timed out");
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
};

// Changed lines of the new side, per file, and the added text (trivy results carry no line: the package must appear in
// an added line of a changed manifest).
export interface Changed { lines: Set<number>; added: string[]; }
export function changedLines(diff: string): Map<string, Changed> {
  const out = new Map<string, Changed>();
  for (const f of parseDiff(diff)) {
    if (!f.file) continue;
    for (const part of f.parts) {
      if (typeof part === "string") continue;
      const h: DiffHunk = part;
      let n = h.new;
      for (const l of h.lines) {
        if (l[0] === "+") {
          const c = out.get(f.file) || { lines: new Set<number>(), added: [] };
          c.lines.add(n);
          c.added.push(l.slice(1));
          out.set(f.file, c);
          n++;
        } else if (l[0] === " ") n++;
      }
    }
  }
  return out;
}
export const NEAR = 3;
export function onChangedLines(results: AnalyzerResult[], changed: Map<string, Changed>, near = NEAR): AnalyzerResult[] {
  return results.filter((r) => {
    const c = changed.get(r.file);
    if (!c) return false;
    if (r.analyzer === "trivy") return c.added.some((t) => t.includes(r.rule.split(" ")[1] || "\u0000"));
    for (let l = r.line - near; l <= (r.endLine || r.line) + near; l++) if (c.lines.has(l)) return true;
    return false;
  });
}

// Every known secret value is replaced, wherever it appears; short values would mask ordinary words, so 4+ chars only.
export function redact(text: string, secrets: string[]): string {
  let out = String(text ?? "");
  for (const s of [...secrets].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join("[REDACTED]");
  return out;
}

// Parsers: untrusted tool JSON in, redacted results out. The secret values gitleaks reports are returned separately, kept
// in memory for redact() and never stored or put in a prompt.
const rel = (p: unknown, root: string): string => {
  let s = String(p ?? "").replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (r && s.startsWith(`${r}/`)) s = s.slice(r.length + 1);
  else if (isAbsolute(s)) s = relative(root, s).replace(/\\/g, "/");
  return s.replace(/^(\.\/)+/, "");
};
const txt = (x: unknown, max: number): string => String(x ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (x: unknown): number => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export function parseGitleaks(json: string, root = ""): { results: AnalyzerResult[]; secrets: string[] } {
  const secrets: string[] = [];
  const results = list(JSON.parse(json || "[]")).map((x): AnalyzerResult => {
    const o = obj(x);
    for (const k of ["Secret", "Match"]) if (typeof o[k] === "string" && o[k]) secrets.push(o[k] as string);
    const line = num(o.StartLine);
    return { ref: "", analyzer: "gitleaks", rule: txt(o.RuleID, 120), file: rel(o.File, root), line, endLine: num(o.EndLine) || line, severity: "high", message: txt(o.Description, 300) || "Possible secret" };
  });
  return { results: results.map((r) => ({ ...r, rule: redact(r.rule, secrets), message: redact(r.message, secrets) })), secrets };
}
export function parseSemgrep(json: string, root = ""): AnalyzerResult[] {
  return list(obj(JSON.parse(json || "{}")).results).map((x): AnalyzerResult => {
    const o = obj(x);
    const extra = obj(o.extra);
    const line = num(obj(o.start).line);
    // extra.lines (the matched source) is never read: it may hold a secret
    return { ref: "", analyzer: "semgrep", rule: txt(o.check_id, 200), file: rel(o.path, root), line, endLine: num(obj(o.end).line) || line, severity: txt(extra.severity, 20).toLowerCase() || "info", message: txt(extra.message, 400) };
  });
}
export function parseTrivy(json: string, root = ""): AnalyzerResult[] {
  return list(obj(JSON.parse(json || "{}")).Results).flatMap((t) => {
    const target = rel(obj(t).Target, root);
    return list(obj(t).Vulnerabilities).map((x): AnalyzerResult => {
      const v = obj(x);
      const fixed = txt(v.FixedVersion, 80);
      return {
        ref: "",
        analyzer: "trivy",
        rule: `${txt(v.VulnerabilityID, 60)} ${txt(v.PkgName, 120)}`,
        file: target,
        line: 0,
        endLine: 0,
        severity: txt(v.Severity, 20).toLowerCase() || "unknown",
        message: `${txt(v.PkgName, 120)} ${txt(v.InstalledVersion, 60)}: ${txt(v.Title, 240) || txt(v.VulnerabilityID, 60)}${fixed ? ` (fixed in ${fixed})` : ""}`,
      };
    });
  });
}

// Command lines. Reports go to a file outside the scanned tree.
function command(id: AnalyzerId, report: string): string[] {
  if (id === "gitleaks") return ["dir", ".", "--report-format", "json", "--report-path", report, "--no-banner", "--exit-code", "0", "--log-level", "error"];
  if (id === "semgrep") return ["scan", "--config", "p/ci", "--json", "--output", report, "--metrics", "off", "--quiet", "--disable-version-check", "."];
  return ["fs", "--scanners", "vuln", "--format", "json", "--output", report, "--quiet", "--exit-code", "0", "."];
}

// Write the head text of the changed files into a fresh temp tree, run each analyzer there, keep results on changed
// lines (± NEAR). Never throws: a missing tool, a failure or a time-out is a run status for the review page.
export async function runAnalyzers(files: Map<string, string>, diff: string, ids: AnalyzerId[]): Promise<Analysis> {
  const changed = changedLines(diff);
  const base = mkdtempSync(join(tmpdir(), "codeotter-analyze-"));
  const src = join(base, "src");
  const out = join(base, "out");
  mkdirSync(src, { recursive: true });
  mkdirSync(out, { recursive: true });
  const secrets: string[] = [];
  try {
    let written = 0;
    for (const [path, text] of files) {
      if (!changed.has(path)) continue;
      const dest = resolve(src, path);
      if (!dest.startsWith(src + sep)) continue; // a path that escapes the tree is skipped
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
      written++;
    }
    if (!written) return { runs: ids.map((id) => ({ id, label: ANALYZERS[id].label, status: "ok", found: 0, kept: 0, ms: 0 })), results: [], secrets };
    const runs = await Promise.all(ids.map(async (id): Promise<{ run: AnalyzerRun; results: AnalyzerResult[] }> => {
      const a = ANALYZERS[id];
      const started = Date.now();
      const run = (status: AnalyzerStatus, found = 0, kept = 0, error = ""): AnalyzerRun => ({ id, label: a.label, status, found, kept, ms: Date.now() - started, ...(error ? { error: error.slice(0, 300) } : {}) });
      const { bin } = analyzerBin(id);
      if (!bin) return { run: run("unavailable", 0, 0, "Not installed: Settings / Analyzers"), results: [] };
      const report = join(out, `${id}.json`);
      try {
        const r = await exec(bin, command(id, report), { cwd: src, timeoutMs: a.timeoutMs, env: { ...process.env, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" } });
        if (r.timedOut) return { run: run("timeout", 0, 0, `No result within ${Math.round(a.timeoutMs / 1000)} s`), results: [] };
        if (!existsSync(report)) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}, no report`);
        const raw = readFileSync(report, "utf8");
        let all: AnalyzerResult[];
        if (id === "gitleaks") { const g = parseGitleaks(raw, src); secrets.push(...g.secrets); all = g.results; }
        else all = id === "semgrep" ? parseSemgrep(raw, src) : parseTrivy(raw, src);
        const kept = onChangedLines(all, changed);
        return { run: run("ok", all.length, kept.length), results: kept };
      } catch (e) {
        return { run: run("failed", 0, 0, errMessage(e)), results: [] };
      }
    }));
    const results = runs.flatMap((r) => r.results).slice(0, 40).map((r, i) => ({ ...r, ref: `A${i + 1}`, rule: redact(r.rule, secrets), message: redact(r.message, secrets) }));
    return { runs: runs.map((r) => ({ ...r.run, ...(r.run.error ? { error: redact(r.run.error, secrets) } : {}) })), results, secrets };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// The prompt block for the language model.
export function analyzerPrompt(results: AnalyzerResult[]): string {
  if (!results.length) return "";
  return `\nAnalyzer results (static analysis tools run on the changed lines; evidence, not verdicts). For each one, decide from the diff whether it is a real problem this change introduces. Confirm it by adding a finding at that file and line with "analyzer":"<tool name>"; reject it by leaving it out. Secret values are redacted: never quote a secret, a credential or a token in any field.\n${results.map((r) => `- ${r.ref} [${r.analyzer}] ${r.file}${r.line ? `:${r.line}` : ""} ${r.rule} (${r.severity}): ${r.message}`).join("\n")}\n`;
}

// Every string inside a value (a review, model output) with known secret values replaced.
export function redactDeep<T>(x: T, secrets: string[]): T {
  if (!secrets.length) return x;
  const walk = (v: unknown): unknown => typeof v === "string" ? redact(v, secrets) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, y]) => [k, walk(y)])) : v;
  return walk(x) as T;
}
// When the changed files could not be fetched: every requested analyzer failed, the review goes on.
export const analysisFailed = (ids: AnalyzerId[], error: string): Analysis => ({ runs: ids.map((id) => ({ id, label: ANALYZERS[id].label, status: "failed", found: 0, kept: 0, ms: 0, error: error.slice(0, 300) })), results: [], secrets: [] });
