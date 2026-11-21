// "Fix with AI": self-contained prompts that hand review findings to a coding agent (Claude Code, Codex, Cursor, Copilot
// agent), and the /fix comment command, which asks the language model for a patch, checks it applies to the PR head in
// memory, and posts it as committable suggestions. Nothing is ever pushed to the pull request's branch: /fix stacked
// commits the stored review's suggested changes to a separate codeotter/fix-<pr>-<sha> branch and opens a pull request
// into the PR's head branch.
import { store } from "./store.ts";
import { createPrComment, forgeOf, githubStacked, isForgeRepo, readPr, repoLabel } from "./git.ts";
import { audit, orgOfRepo } from "./audit.ts";
import { askModel, llmConfig } from "./models.ts";
import { guideFor, headFileTexts } from "./context.ts";
import { deriveSuggestionFromDetail } from "./engines.ts";
import { postInlineSuggestionsOnPr, resolvePr } from "./review.ts";
import type { PullRequest } from "./context.ts";
import type { Finding } from "./engines.ts";
import type { FixFile, StackedOps } from "./forges.ts";

// What a prompt needs to know about the pull request; `guide` is the detected guide file(s), e.g. "AGENTS.md + CLAUDE.md".
export interface PromptPr { url: string; number: number; title?: string; headRefName?: string; baseRefName?: string }
export interface PromptContext { repo: string; pr: PromptPr; guide?: string | null }
export interface AgentPrompts { all: string; findings: string[] }

// <agent-prompts>
const HUNK_LINES = 40;
// A code fence longer than any backtick run inside, so prompt text can never close it early.
const fence = (text: string, lang = "") => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text.replace(/\r?\n$/, "")}\n${ticks}`;
};
// Repository ids carry an internal provider prefix (forgejo~owner/name); people and agents know the plain name.
const plainRepo = (repo: string) => repo.replace(/^[a-z]+~/, "");
const flat = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// The hunk of `diff` that shows `line` of `file` (new-file numbering), cut to a window around that line.
export function hunkAt(diff: string, file: string, line = 0): string {
  if (!diff || !file) return "";
  const hunks: { header: string; body: string[]; start: number }[] = [];
  let inFile = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) { inFile = false; continue; }
    if (l.startsWith("+++ ")) { inFile = l.slice(4).replace(/^b\//, "").trim() === file; continue; }
    if (l.startsWith("--- ")) continue;
    if (!inFile) continue;
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { hunks.push({ header: l, body: [], start: Number(m[1]) }); continue; }
    if (hunks.length && /^[ +\-\\]/.test(l)) hunks.at(-1)!.body.push(l.replace(/\r$/, ""));
  }
  if (!hunks.length) return "";
  // new-file line number of each body line (removed lines take the number of the next new line)
  const numbered = hunks.map((h) => {
    let n = h.start;
    return { ...h, nums: h.body.map((l) => (l.startsWith("-") || l.startsWith("\\") ? n : n++)) };
  });
  const hit = (line > 0 && numbered.find((h) => h.nums.length && h.nums[0] <= line && line <= h.nums.at(-1)!)) || numbered[0];
  let from = 0;
  let to = hit.body.length;
  if (to > HUNK_LINES) {
    const at = Math.max(0, hit.nums.findIndex((n) => n >= line));
    from = Math.max(0, Math.min(at - HUNK_LINES / 2, to - HUNK_LINES));
    to = from + HUNK_LINES;
  }
  return [hit.header, ...hit.body.slice(from, to)].join("\n").slice(0, 6000);
}

// One finding as a prompt section: where, what, the code at that spot and the suggested replacement, if any.
function findingSection(raw: Finding, heading: string): string {
  const f = deriveSuggestionFromDetail(raw, "");
  const where = `${f.file}${f.line ? `:L${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}`;
  const explanation = String(f.detail || "").split("\n\n@@")[0].trim();
  const hunk = typeof raw.hunk === "string" ? raw.hunk.slice(0, 6000) : "";
  return [
    `${heading} [${String(f.severity).toUpperCase()}] ${where}: ${flat(f.title, 300) || "Finding"}`,
    ...(explanation ? ["", explanation] : []),
    ...(hunk ? ["", "Code at the finding (diff hunk):", fence(hunk, "diff")] : []),
    ...(f.suggestion ? ["", `Suggested replacement for ${f.startLine ? `lines ${f.startLine}-${f.line}` : `line ${f.line || "?"}`}:`, fence(f.suggestion)] : []),
  ].join("\n");
}
function promptHeader(ctx: PromptContext, what: string): string[] {
  const { pr } = ctx;
  return [
    `Fix ${what} from a code review of pull request #${pr.number}${pr.title ? ` "${flat(pr.title, 200)}"` : ""} in ${plainRepo(ctx.repo)}.`,
    `PR: ${pr.url}`,
    ...(pr.headRefName ? [`Branch: ${pr.headRefName}${pr.baseRefName ? ` (merging into ${pr.baseRefName})` : ""}. Work on this branch.`] : []),
    ...(ctx.guide ? [`Repository instructions: read ${ctx.guide} at the repository root first and follow it.`] : []),
  ];
}
const STEPS = [
  "Steps:",
  "1. Check each finding against the current code on the branch. If one does not hold, leave that code alone and say why.",
  "2. Make the smallest change that fixes it, in the style of the surrounding code. Do not touch unrelated code.",
  "3. Run the relevant tests and linters. Add a test when the problem is testable.",
  "4. Summarise what you changed per finding.",
];
// One finding as a self-contained agent prompt.
export function findingPrompt(ctx: PromptContext, f: Finding): string {
  return [...promptHeader(ctx, "one finding"), "", findingSection(f, "Finding"), "", ...STEPS].join("\n");
}
// Every given finding in one prompt, numbered.
export function allFindingsPrompt(ctx: PromptContext, findings: Finding[]): string {
  if (!findings.length) return "";
  return [...promptHeader(ctx, `${findings.length} finding${findings.length === 1 ? "" : "s"}`), "", ...findings.flatMap((f, i) => [findingSection(f, `${i + 1}.`), ""]), ...STEPS].join("\n");
}
// The prompt as a collapsed block in a posted comment. HTML comments are broken up so a hunk cannot forge CodeOtter's
// comment markers.
export function promptDetails(prompt: string): string {
  if (!prompt) return "";
  return ["<details>", "<summary>🤖 Prompt for AI agents</summary>", "", fence(prompt.replace(/<!--/g, "<!-​-"), "text"), "", "</details>"].join("\n");
}
// A review's prompts for the review page: one per finding (by index; empty for dismissed ones) and one for all open ones.
export function reviewPrompts(r: { pr: PromptPr; guide?: string | null; review?: { findings?: Finding[] } }, repo: string): AgentPrompts {
  const findings = Array.isArray(r.review?.findings) ? r.review.findings : [];
  const ctx: PromptContext = { repo, pr: r.pr, guide: r.guide };
  return { all: allFindingsPrompt(ctx, findings.filter((f) => !f.dismissed)), findings: findings.map((f) => (f.dismissed ? "" : findingPrompt(ctx, f))) };
}
// </agent-prompts>

// <fix-patch>
// A unified diff from a model, applied to the head files in memory. Each hunk must match the file exactly (trailing
// whitespace aside), at its stated line or within FUZZ lines of it, and hunks in one file must not overlap; a hunk that
// does not is rejected, never guessed at. Accepted hunks become line-range replacements: committable suggestions.
export interface PatchHunk { file: string; oldStart: number; lines: string[] }
export interface Replacement { file: string; startLine: number; endLine: number; text: string }
const FUZZ = 100;

// The diff inside the model's answer: a ```diff fence if there is one, else everything from the first file header.
export function extractPatch(out: string): string {
  const fenced = out.match(/```(?:diff|patch)[^\n]*\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const at = out.search(/^(?:diff --git|--- )/m);
  return at >= 0 ? out.slice(at) : "";
}
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let file = "";
  let cur: PatchHunk | null = null;
  const all = patch.split("\n").map((l) => l.replace(/\r$/, ""));
  for (const [i, l] of all.entries()) {
    if (l.startsWith("diff --git")) { cur = null; continue; }
    // a file header is "--- old" directly followed by "+++ new"; "--- x" inside a hunk is a removed "-- x" line
    if (l.startsWith("--- ") && all[i + 1]?.startsWith("+++ ")) { cur = null; continue; }
    if (l.startsWith("+++ ") && all[i - 1]?.startsWith("--- ")) {
      const p = l.slice(4).trim().split("\t")[0];
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      cur = null;
      continue;
    }
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (m) {
      cur = { file, oldStart: Number(m[1]), lines: [] };
      if (file) hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    if (l === "") cur.lines.push(" "); // models drop the space of an empty context line
    else if (/^[ +-]/.test(l)) cur.lines.push(l);
    else cur = null;
  }
  // trailing blank lines are separators, not context
  for (const h of hunks) while (h.lines.length && h.lines.at(-1) === " ") h.lines.pop();
  return hunks;
}
// 0-based index where the hunk's old lines sit in `fileLines`, or -1.
export function locateHunk(fileLines: string[], h: PatchHunk): number {
  const old = h.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1).trimEnd());
  if (!old.length) return -1;
  const matches = (at: number) => at >= 0 && at + old.length <= fileLines.length && old.every((l, i) => fileLines[at + i].trimEnd() === l);
  const want = Math.max(0, h.oldStart - 1);
  for (let d = 0; d <= FUZZ; d++) {
    if (matches(want - d)) return want - d;
    if (d && matches(want + d)) return want + d;
  }
  return -1;
}
// One validated hunk -> the smallest line-range replacement covering its changes. A pure insertion or deletion takes
// in a neighbouring context line, since a suggestion replaces at least one line with at least one line.
export function hunkReplacement(fileLines: string[], h: PatchHunk): Replacement | string {
  const at = locateHunk(fileLines, h);
  if (at < 0) return `${h.file}: hunk at line ${h.oldStart} does not match the head`;
  const L = h.lines;
  let a = L.findIndex((l) => l[0] !== " ");
  let b = L.length - 1 - [...L].reverse().findIndex((l) => l[0] !== " ");
  if (a < 0) return `${h.file}: hunk at line ${h.oldStart} changes nothing`;
  const count = (from: number, to: number, keep: (c: string) => boolean) => L.slice(from, to + 1).filter((l) => keep(l[0])).length;
  while (!count(a, b, (c) => c !== "+") || !count(a, b, (c) => c !== "-")) {
    if (a > 0) a--;
    else if (b < L.length - 1) b++;
    else return `${h.file}: hunk at line ${h.oldStart} has no context line to anchor on`;
  }
  const startLine = at + count(0, a - 1, (c) => c !== "+") + 1;
  const endLine = startLine + count(a, b, (c) => c !== "+") - 1;
  const text = L.slice(a, b + 1).filter((l) => l[0] !== "-").map((l) => l.slice(1)).join("\n");
  if (text.includes("```")) return `${h.file}: replacement at line ${startLine} contains a code fence`;
  return { file: h.file, startLine, endLine, text };
}
// The whole patch against the head files: replacements that apply, and why the rest did not.
export function patchReplacements(patch: string, files: Map<string, string>): { ok: Replacement[]; rejected: string[] } {
  const ok: Replacement[] = [];
  const rejected: string[] = [];
  const hunks = parsePatch(patch);
  if (!hunks.length) return { ok, rejected: ["the answer held no unified diff"] };
  for (const h of hunks) {
    const text = files.get(h.file);
    if (text === undefined) { rejected.push(`${h.file}: not a file of the findings`); continue; }
    const r = hunkReplacement(text.split("\n").map((l) => l.replace(/\r$/, "")), h);
    if (typeof r === "string") { rejected.push(r); continue; }
    if (ok.some((o) => o.file === r.file && o.startLine <= r.endLine && r.startLine <= o.endLine)) { rejected.push(`${r.file}: hunk at line ${r.startLine} overlaps another`); continue; }
    ok.push(r);
  }
  return { ok, rejected };
}
// </fix-patch>

// <fix-command>
// The findings /fix works on, numbered as the posted review numbers them: open, not nits.
export const openFindings = (findings: Finding[] | undefined): Finding[] => (Array.isArray(findings) ? findings : []).filter((f) => f && !f.dismissed && f.severity !== "nit" && f.file);
const numberedLines = (text: string, line: number, around = 40) => {
  const lines = text.split("\n");
  const from = Math.max(1, (line || 1) - around);
  const to = Math.min(lines.length, (line || 1) + around);
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}| ${l.replace(/\r$/, "")}`).join("\n");
};
// /fix (all open findings) or /fix <n>: one model call for a patch, checked against the head, posted as suggestions.
export async function fixFindings(prUrl: string, repo: string, arg = ""): Promise<string> {
  const { urlGuess, spec } = await resolvePr(prUrl, repo);
  const saved = await store.get(urlGuess);
  const open = openFindings(saved?.review?.findings);
  if (!open.length) throw new Error("No open findings: run /review first");
  const n = arg ? Number(arg) : 0;
  if (arg && !(Number.isInteger(n) && n >= 1 && n <= open.length)) throw new Error(`No finding ${String(arg).slice(0, 20)}: pick 1-${open.length}`);
  const targets = n ? [{ n, f: open[n - 1] }] : open.map((f, i) => ({ n: i + 1, f }));
  const c = await llmConfig();
  if (!c.model) throw new Error("/fix needs a language model: open Admin / Model provider");
  if (c.api === "codereviewer") throw new Error("CodeReviewer cannot write patches: pick a language model in Admin / Model provider");
  const pr: PullRequest = JSON.parse(await readPr(urlGuess, spec));
  const files = await headFileTexts(pr, [...new Set(targets.map((t) => t.f.file))]);
  const usable = targets.filter((t) => files.has(t.f.file));
  if (!usable.length) throw new Error("Could not read the findings' files at the PR head");
  const guide = await guideFor(repo, isForgeRepo(repo) ? pr.headRefOid : pr.headRefName, pr.headRepo || repo).catch(() => null);
  const prompt = `Write a patch that fixes these code review findings in pull request #${pr.number} "${flat(pr.title, 200)}". Each file is shown at the PR head with line numbers ("  123| code"); the numbers and "| " are not part of the file.
Reply with ONLY a unified diff (git diff format, paths a/<file> and b/<file>) in a \`\`\`diff fence. Context and removed lines must match the file exactly. Change only what the findings need. Leave out a finding you cannot fix safely within the lines shown.
${guide ? `\nRepository guidelines from ${guide.file}:\n${guide.text.slice(0, 8000)}\n` : ""}
${usable.map(({ n: i, f }) => {
  const d = deriveSuggestionFromDetail(f, "");
  return `### Finding ${i} [${d.severity.toUpperCase()}] ${d.file}${d.line ? `:L${d.line}` : ""}: ${flat(d.title, 300)}
${String(d.detail || "").split("\n\n@@")[0].trim().slice(0, 2000)}
${d.suggestion ? `Reviewer's suggested replacement:\n${fence(d.suggestion)}\n` : ""}
${d.file} at the head:
${numberedLines(files.get(d.file)!, d.line || 0)}`;
}).join("\n\n")}`;
  const out = await askModel(prompt, { ...c, temperature: 0.1 });
  const { ok, rejected } = patchReplacements(extractPatch(out), files);
  const sha = (pr.headRefOid || "").slice(0, 7);
  if (!ok.length) throw new Error(`the patch from ${c.provider}/${c.model} did not apply to ${sha || "the head"}${rejected.length ? ` (${rejected.slice(0, 3).join("; ")})` : ""}`);
  // each replacement is credited to the nearest finding in its file
  const suggestions: Finding[] = ok.map((r) => {
    const near = usable.filter((t) => t.f.file === r.file).sort((x, y) => Math.abs((x.f.line || 0) - r.endLine) - Math.abs((y.f.line || 0) - r.endLine))[0];
    return { file: r.file, line: r.endLine, ...(r.startLine < r.endLine ? { startLine: r.startLine } : {}), severity: near.f.severity, title: `Fix for finding ${near.n}: ${flat(near.f.title, 200)}`, detail: "", suggestion: r.text };
  });
  const { posted, mode } = await postInlineSuggestionsOnPr({ pr, review: { findings: suggestions } }, repo, { agentPrompts: false });
  return `posted ${posted} suggestion${posted === 1 ? "" : "s"} checked against \`${sha}\`${mode === "pr_comment_fallback" ? " as a PR comment (lines outside the diff)" : ""}${rejected.length ? `; ${rejected.length} hunk${rejected.length === 1 ? "" : "s"} did not apply` : ""}. Nothing was pushed.`;
}
// </fix-command>

// <fix-stacked-plan>
// The stored review's suggested replacements (model output: startLine..line of the reviewed commit become `suggestion`)
// applied to the head files. Each replacement is located in the head by its old lines plus STACK_CONTEXT..1 lines of
// context on each side, from the file at the reviewed commit; one that no longer matches, is already in, or overlaps an
// earlier one is skipped with the reason. Nothing is guessed.
export interface StackTarget { n: number; f: Finding }
export interface StackPlan { files: FixFile[]; applied: StackTarget[]; skipped: (StackTarget & { why: string })[] }
const STACK_CONTEXT = 3;
const splitLines = (t: string) => t.split("\n").map((l) => l.replace(/\r$/, ""));
export function planStackedFix(targets: StackTarget[], reviewed: Map<string, string>, head: Map<string, string>): StackPlan {
  const applied: StackTarget[] = [];
  const skipped: StackPlan["skipped"] = [];
  const edits = new Map<string, { from: number; to: number; text: string[]; n: number }[]>();
  for (const t of targets) {
    const d = deriveSuggestionFromDetail(t.f, "");
    const end = d.line || 0;
    const start = d.startLine && d.startLine <= end ? d.startLine : end;
    const before = reviewed.get(d.file), now = head.get(d.file);
    if (!d.suggestion || !end) { skipped.push({ ...t, why: "no suggested change" }); continue; }
    if (before === undefined || now === undefined) { skipped.push({ ...t, why: "file not readable at the head" }); continue; }
    const old = splitLines(before);
    if (end > old.length) { skipped.push({ ...t, why: "lines outside the reviewed file" }); continue; }
    const next = d.suggestion.split("\n");
    if (old.slice(start - 1, end).join("\n").trimEnd() === next.join("\n").trimEnd()) { skipped.push({ ...t, why: "already applied" }); continue; }
    const headLines = splitLines(now);
    // the widest context that still matches, down to one line on each side (a change next door narrows it)
    const find = (body: string[]) => {
      for (let n = STACK_CONTEXT; n >= 1; n--) {
        const lo = Math.max(0, start - 1 - n), hi = Math.min(old.length, end + n);
        const before = old.slice(lo, start - 1).map((l) => ` ${l}`);
        const at = locateHunk(headLines, { file: d.file, oldStart: lo + 1, lines: [...before, ...body.map((l) => `-${l}`), ...old.slice(end, hi).map((l) => ` ${l}`)] });
        if (at >= 0) return at + before.length;
      }
      return -1;
    };
    const from = find(old.slice(start - 1, end));
    if (from < 0) { skipped.push({ ...t, why: find(next) >= 0 ? "already applied" : "no longer applies to the head" }); continue; }
    const to = from + (end - start + 1);
    const list = edits.get(d.file) || [];
    const clash = list.find((e) => e.from < to && from < e.to);
    if (clash) { skipped.push({ ...t, why: `overlaps finding ${clash.n}` }); continue; }
    list.push({ from, to, text: next, n: t.n });
    edits.set(d.file, list);
    applied.push(t);
  }
  const files: FixFile[] = [...edits].map(([path, list]) => {
    const text = head.get(path)!; // edits only exist for files read at the head
    const crlf = text.includes("\r\n");
    const out = splitLines(text);
    for (const e of [...list].sort((a, b) => b.from - a.from)) out.splice(e.from, e.to - e.from, ...e.text);
    return { path, content: out.join(crlf ? "\r\n" : "\n") };
  });
  return { files, applied, skipped };
}
// </fix-stacked-plan>

// <fix-stacked>
// /fix stacked and the review page's "Open fix PR": the stored review's suggested changes that still apply, committed on
// a fix branch from the PR's head commit, in a pull request into the PR's head branch; a re-run updates that pull request.
// Same-repository PRs only: a fork's branch is not CodeOtter's to write to, and the fix PR's base must be in this repository.
const md = (x: unknown, max: number) => flat(x, max).replace(/<!--/g, "<!-​-").replace(/(^|[^\w`])@(?=[\w-])/g, "$1@​").replace(/`/g, "'");
const stackedOpsOf = (repo: string): StackedOps | undefined => (isForgeRepo(repo) ? forgeOf(repo).stacked : githubStacked);
const findingAt = (f: Finding) => {
  const d = deriveSuggestionFromDetail(f, "");
  return `\`${md(d.file, 200)}${d.line ? `:L${d.startLine && d.startLine < d.line ? `${d.startLine}-` : ""}${d.line}` : ""}\``;
};
const stackItem = (t: StackTarget) => `finding ${t.n} [${String(t.f.severity).toUpperCase()}] ${findingAt(t.f)}: ${md(t.f.title, 200) || "Finding"}`;
export interface StackedResult { message: string; url: string; updated: boolean; applied: number; skipped: number }
export async function fixStacked(prUrl: string, repo: string): Promise<StackedResult> {
  const { urlGuess, spec } = await resolvePr(prUrl, repo);
  const ops = stackedOpsOf(repo);
  if (!ops) throw new Error(`${repoLabel(repo)}: fix pull requests need a git server whose API commits files as JSON (GitHub, GitLab, Forgejo, Gitea, Azure DevOps). Use /fix for suggestions`);
  const saved = await store.get(urlGuess);
  const targets = openFindings(saved?.review?.findings).map((f, i) => ({ n: i + 1, f })).filter((t) => {
    const d = deriveSuggestionFromDetail(t.f, "");
    return !!d.suggestion && !!d.line;
  });
  if (!targets.length) throw new Error("No open findings with a suggested change: run /review first");
  const pr: PullRequest = JSON.parse(await readPr(urlGuess, spec));
  if (String(pr.state || "OPEN").toUpperCase() !== "OPEN") throw new Error("The pull request is not open");
  const fork = ops.fork ? await ops.fork(repo, pr.number) : !!pr.headRepo && pr.headRepo !== repo;
  if (fork) throw new Error("this pull request's branch lives in a fork. CodeOtter writes only to this repository, and a fix pull request into a fork's branch needs write access to the fork. Use /fix to get the same changes as suggestions");
  const headSha = String(pr.headRefOid || "");
  const headBranch = String(pr.headRefName || "");
  if (!/^[0-9a-f]{40}$/i.test(headSha) || !headBranch) throw new Error("Could not read the pull request's head commit");
  const reviewSha = String(saved?.headSha || saved?.pr?.headRefOid || "");
  if (!/^[0-9a-f]{7,40}$/i.test(reviewSha)) throw new Error("The stored review names no commit: run /review first");
  const paths = [...new Set(targets.map((t) => t.f.file))];
  const head = await headFileTexts(pr, paths, 25, 400000, headSha);
  const reviewed = headSha.startsWith(reviewSha) || reviewSha.startsWith(headSha) ? head : await headFileTexts(pr, paths, 25, 400000, reviewSha);
  const plan = planStackedFix(targets, reviewed, head);
  const sha = headSha.slice(0, 7);
  const skippedList = plan.skipped.map((t) => `- ${stackItem(t)} (${t.why})`);
  if (!plan.applied.length) throw new Error(`none of the ${targets.length} suggested change${targets.length === 1 ? "" : "s"} apply to \`${sha}\`:\n${skippedList.join("\n")}`);
  const prefix = `codeotter/fix-${pr.number}-`;
  const existing = await ops.findFixPr(repo, headBranch, prefix);
  const branch = existing?.branch || `${prefix}${sha}`;
  const count = `${plan.applied.length} fix${plan.applied.length === 1 ? "" : "es"}`;
  const message = [`fix: CodeOtter suggestions for #${pr.number}`, "", ...plan.applied.map((t) => `- finding ${t.n}: ${flat(t.f.title, 120)}`), "", `From the review at ${reviewSha.slice(0, 7)}, applied to ${sha}.`].join("\n");
  await ops.commit(repo, { branch, headSha, headBranch, files: plan.files, message });
  const title = `CodeOtter fixes for #${pr.number}: ${flat(pr.title, 120)}`.slice(0, 200);
  const body = [
    `<!-- codeotter:fix-stacked:${pr.number} -->`,
    `🦦 Fixes from the CodeOtter review of [#${pr.number}](${pr.url}), made on \`${md(headBranch, 200)}\` at \`${sha}\`. Merge into \`${md(headBranch, 200)}\` to apply them.`,
    "", "**Fixes**", ...plan.applied.map((t) => `- ${stackItem(t)}`),
    ...(skippedList.length ? ["", "**Skipped**", ...skippedList] : []),
  ].join("\n");
  const fix = existing ? (await ops.editPr(repo, existing.number, { title, body }), existing) : await ops.openPr(repo, { branch, base: headBranch, title, body });
  await audit(null, "fix.stacked", urlGuess, { fixPr: fix.url, branch, head: sha, applied: plan.applied.length, skipped: plan.skipped.length, updated: !!existing }, orgOfRepo(repo));
  const summary = `${existing ? "updated" : "opened"} [fix pull request #${fix.number}](${fix.url}) with ${count} on \`${sha}\`${skippedList.length ? `. Skipped:\n${skippedList.join("\n")}` : "."}`;
  await createPrComment(urlGuess, repo, pr.number, `🦦 CodeOtter \`/fix stacked\`: ${summary}`);
  return { message: summary, url: fix.url, updated: !!existing, applied: plan.applied.length, skipped: plan.skipped.length };
}
// </fix-stacked>
