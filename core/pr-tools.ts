// PR tools (describe, improve, ask, docs, changelog) and comment commands.
import { APP_URL, IS_SERVER } from "./config.ts";
import { store } from "./store.ts";
import { createPrComment, forgeId, forgeOf, ghAsApp, ghAsync, isForgeRepo, parsePrUrl, prUrlFor, readPr, repos } from "./git.ts";
import { askModel, llmConfig } from "./models.ts";
import { compressDiff, dynamicContextFiles, extendDiffContext, parseDiff } from "./diff.ts";
import { getRepoLearnings, headFileTexts, prGuide, reviewConfig, setRepoLearnings } from "./context.ts";
import { deriveSuggestionFromDetail, reflectFindings } from "./engines.ts";
import { postInlineSuggestionsOnPr, resolvePr, score, syncPrComments } from "./review.ts";
import { CATCH_UP_EVERY, HANDLED_COMMENTS, lastCatchUp, remember, webhookHealthy } from "./queue.ts";
import { repoOf } from "./views.ts";
import { fixFindings, fixStacked, hunkAt } from "./fix.ts";
import { overrideChecks } from "./merge-checks.ts";
import { countReactions } from "./forges.ts";
import type { ForgeComment, ThreadComment } from "./forges.ts";
import { noteReply } from "./learned.ts";
import { audit, orgOfRepo, withActor } from "./audit.ts";
import type { Guide, PullRequest, ReviewSettings } from "./context.ts";
import type { Finding } from "./engines.ts";
import type { LlmConfig } from "./models.ts";

// A PR comment as the commands read it: a GitHub issue comment (webhook or REST) or a forge adapter's ForgeComment.
export interface PrComment { id?: number | string; body?: string; created_at?: string; html_url?: string; prNumber?: number; author_association?: string; user?: { id?: number | string; login?: string } }
export interface PrCommand { cmd: string; arg: string }
// What every PR tool gets: the PR, its diff (dynamic context, compressed to the budget) and the review settings.
export interface PrToolContext { pr: PullRequest; repo: string; c: LlmConfig; rc: ReviewSettings; guide: Guide | null; diff: string }
export type Suggestion = Finding & { label: string };
export interface PrToolOutput { markdown: string; data: { suggestions?: Suggestion[]; [field: string]: unknown } }
export type PrToolResult = PrToolOutput & { tool: string; label: string; headSha: string; at: string };
export interface PrTool {
  label: string;
  applyLabel?: string;
  input?: string; // the tool needs this text (Ask: the question)
  run(ctx: PrToolContext, question: string): Promise<PrToolOutput>;
  apply?(target: { pr: PullRequest }, result: PrToolResult): Promise<string>;
}

// <pr-tools>
// PR tools: one language model call each over the pull request and its diff (dynamic context, compressed to the review
// budget). The model answers JSON; the server renders markdown from normalised fields only. The review page runs them
// from one generic card, and PR comment commands run them by id. Results are kept in memory per pull request.
export const oneLine = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const mdCell = (x: unknown, max: number) => oneLine(x, max).replace(/[|`]/g, (ch) => (ch === "|" ? "\\|" : "'"));
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
async function askJson(c: LlmConfig, text: string, what: string): Promise<Record<string, unknown>> {
  const out = await askModel(text, { ...c, temperature: 0.2 });
  try {
    const j: unknown = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    return isObj(j) ? j : {}; // always an object: the text parsed starts with { and ends with }
  } catch {
    throw new Error(`${c.provider}/${c.model} did not return valid JSON for ${what}`);
  }
}
const prBrief = (pr: PullRequest, guide: Guide | null) => `PR #${pr.number}: ${pr.title}
Author: ${pr.author?.login || "unknown"}  Base: ${pr.baseRefName} <- Head: ${pr.headRefName}  Files: ${pr.changedFiles}  +${pr.additions} -${pr.deletions}
Description:
${String(pr.body || "(none)").replace(/<!-- codeotter:describe -->[\s\S]*?<!-- \/codeotter:describe -->/, "").trim().slice(0, 3000) || "(none)"}
${guide ? `\nRepository guidelines from ${guide.file}:\n${guide.text.slice(0, 8000)}\n` : ""}`;
async function prToolContext(prUrl: string): Promise<PrToolContext> {
  const { urlGuess, spec } = await resolvePr(prUrl, repoOf({ url: prUrl }));
  const [pr, rawDiff, c, rc] = await Promise.all([readPr(urlGuess, spec).then((t): PullRequest => JSON.parse(t)), readPr(urlGuess, spec, true), llmConfig(), reviewConfig(repoOf({ url: urlGuess }))]);
  if (!c.model) throw new Error("PR tools need a language model: open Admin / Model provider");
  if (c.api === "codereviewer") throw new Error("CodeReviewer only writes per-hunk comments: pick a language model in Admin / Model provider for PR tools");
  let diff = rawDiff;
  if (rc.contextLines > 0) diff = extendDiffContext(rawDiff, await headFileTexts(pr, dynamicContextFiles(parseDiff(rawDiff))), { before: rc.contextLines, after: 1 }).diff;
  const repo = repoOf(pr);
  const guide = await prGuide(repo, pr, rc.rulesSource).then((g) => g.guide, () => null);
  return { pr, repo, c, rc, guide, diff: compressDiff(diff, Math.min(rc.diffChars, c.contextChars || Infinity)).diff };
}

const DESCRIBE_TYPES = ["Bug fix", "Feature", "Refactor", "Performance", "Security", "Tests", "Docs", "Config", "Dependencies", "Chore"];
const DESCRIBE_RE = /<!-- codeotter:describe -->[\s\S]*?<!-- \/codeotter:describe -->/;
async function updatePrBody(pr: PullRequest, body: string) {
  const { repo, number } = parsePrUrl(pr.url)!; // a PR read back from its own URL
  if (isForgeRepo(repo)) return forgeOf(repo).setBody(repo, number, body);
  return ghAsApp(repo, "api", "--method", "PATCH", `repos/${repo}/pulls/${number}`, "-f", `body=${body}`);
}
export const PR_TOOLS: Record<string, PrTool> = {
  describe: {
    label: "Describe",
    applyLabel: "Update PR description",
    async run({ pr, c, guide, diff }) {
      const out = await askJson(c, `Write the description of this pull request for its reviewers, from the diff. Follow the title conventions of the repository guidelines if they set any. Reply with ONLY a JSON object:
{"title":"imperative title under 72 characters","type":["one or more of: ${DESCRIBE_TYPES.join(", ")}"],"summary":["2-5 bullets: what changed and why"],"files":[{"file":"path","change":"one line"}]}

${prBrief(pr, guide)}
Diff:
${diff}`, "Describe");
      const title = oneLine(out.title, 120) || pr.title;
      const types = listOf(out.type).filter((t): t is string => typeof t === "string" && DESCRIBE_TYPES.includes(t));
      const summary = listOf(out.summary).map((s) => oneLine(s, 400)).filter(Boolean).slice(0, 8);
      const files = listOf(out.files).filter((f): f is Record<string, unknown> => isObj(f) && typeof f.file === "string").slice(0, 80).map((f) => ({ file: mdCell(f.file, 300), change: mdCell(f.change, 300) }));
      if (!summary.length) throw new Error(`${c.provider}/${c.model} returned no summary for Describe`);
      const markdown = [
        `**Title:** ${title}`,
        ...(types.length ? ["", `**Type:** ${types.join(", ")}`] : []),
        "", "**Summary**", ...summary.map((s) => `- ${s}`),
        ...(files.length ? ["", "**Changes**", "| File | Change |", "| :--- | :--- |", ...files.map((f) => `| \`${f.file}\` | ${f.change} |`)] : []),
      ].join("\n");
      return { markdown, data: { title, types, summary, files } };
    },
    // Writes the generated block into the PR body, keeping the author's own text; a later run replaces the block.
    async apply({ pr }, result) {
      const block = `<!-- codeotter:describe -->\n### 🦦 CodeOtter description\n\n${result.markdown}\n<!-- /codeotter:describe -->`;
      const body = String(pr.body || "");
      await updatePrBody(pr, DESCRIBE_RE.test(body) ? body.replace(DESCRIBE_RE, () => block) : `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${block}`);
      return "PR description updated";
    },
  },
  ask: {
    label: "Ask",
    input: "Question",
    async run({ pr, c, guide, diff }, question) {
      const out = await askJson(c, `Answer a question about this pull request from its diff. Be specific: name files, functions and lines. If the diff does not show enough to answer, say what is missing instead of guessing. Reply with ONLY a JSON object: {"answer":"markdown"}

Question: ${question}

${prBrief(pr, guide)}
Diff:
${diff}`, "Ask");
      const answer = proseOf(out.answer, 6000);
      if (!answer) throw new Error(`${c.provider}/${c.model} returned no answer`);
      return { markdown: `**Q:** ${oneLine(question, 500)}\n\n${answer}`, data: { question: oneLine(question, 2000), answer } };
    },
  },
  improve: {
    label: "Improve",
    applyLabel: "Post inline suggestions",
    // Code suggestions only (no scores): each replaces a line range of the new file, then the self-check scores them.
    async run({ pr, c, rc, guide, diff }) {
      const out = await askJson(c, `Suggest concrete code improvements to the lines this pull request adds or changes (lines starting with "+" in the diff): bugs, missing error handling, security, performance, clarity. Each suggestion replaces lines start_line..end_line of the new file with "improved", which must be complete, correctly indented code for exactly those lines. Do not suggest adding comments or docstrings, reformatting, or restating the code. Reply with ONLY a JSON object:
{"suggestions":[{"file":"path","start_line":10,"end_line":12,"label":"one of: ${IMPROVE_LABELS.join(", ")}","title":"short","why":"one or two sentences","improved":"replacement code"}]}
At most ${rc.maxFindings} suggestions, most important first. An empty list is a valid answer.

${prBrief(pr, guide)}
Diff:
${diff}`, "Improve");
      let items = suggestionItems(out, diff, IMPROVE_LABELS, "enhancement");
      // reflectFindings returns the same findings spread with a confidence, so each keeps its label
      if (rc.reflectMin > 0 && items.length) items = (await reflectFindings(pr, diff, c, rc, items)) as Suggestion[];
      items = items.slice(0, rc.maxFindings);
      return { markdown: suggestionsMarkdown(items), data: { suggestions: items } };
    },
    apply: postSuggestions,
  },
  docs: {
    label: "Docs",
    applyLabel: "Post inline suggestions",
    // Docstrings for functions and classes this PR adds or changes that have none, in the language's own convention.
    async run({ pr, c, rc, guide, diff }) {
      const out = await askJson(c, `Write documentation for functions, methods and classes that this pull request adds or changes (lines starting with "+" in the diff) and that have no doc comment. Use the language's convention (JSDoc, Python docstring, Go doc comment, Rust ///, and so on) and the style already used in the file. Say what it does, its parameters, what it returns and what it throws; nothing the name already says. Each suggestion replaces lines start_line..end_line of the new file (the declaration line, or the lines the docstring goes into) with "improved": the documentation plus those same lines, unchanged and correctly indented. Reply with ONLY a JSON object:
{"suggestions":[{"file":"path","start_line":10,"end_line":10,"title":"Document functionName","improved":"documentation and the original lines"}]}
At most ${rc.maxFindings} suggestions. An empty list is a valid answer.

${prBrief(pr, guide)}
Diff:
${diff}`, "Docs");
      const items = suggestionItems(out, diff, ["documentation"], "documentation").slice(0, rc.maxFindings);
      return { markdown: suggestionsMarkdown(items), data: { suggestions: items } };
    },
    apply: postSuggestions,
  },
  changelog: {
    label: "Changelog",
    // An entry in the style of the repository's own changelog (read from the PR head), for the author to paste.
    async run({ pr, c, guide, diff }) {
      const files = await headFileTexts(pr, CHANGELOG_FILES);
      const [file, text = ""] = [...files].find(([, t]) => t.trim()) || [];
      const out = await askJson(c, `Write the changelog entry for this pull request${file ? `, matching the format, tense and level of detail of the existing ${file} below` : " as Keep a Changelog bullets"}. Describe user-visible behaviour, not implementation. Reply with ONLY a JSON object: {"entry":"markdown lines to add under the unreleased section"}
${file ? `\nExisting ${file} (start):\n${text.slice(0, 3000)}\n` : ""}
${prBrief(pr, guide)}
Diff:
${diff}`, "Changelog");
      const entry = proseOf(out.entry, 3000);
      if (!entry) throw new Error(`${c.provider}/${c.model} returned no changelog entry`);
      return { markdown: `${file ? `For \`${file}\`:` : "No changelog file found at the repository root."}\n\n\`\`\`markdown\n${entry.replace(/```/g, "'''")}\n\`\`\``, data: { file: file || null, entry } };
    },
  },
};
const IMPROVE_LABELS = ["possible issue", "security", "performance", "error handling", "maintainability", "enhancement"];
const CHANGELOG_FILES = ["CHANGELOG.md", "CHANGES.md", "HISTORY.md"];
// Model suggestions -> findings with a line range, a label from `labels`, and cleaned prose.
type RawSuggestion = { file: string; improved: string; [field: string]: unknown };
const suggestionItems = (out: Record<string, unknown>, diff: string, labels: string[], fallback: string): Suggestion[] => listOf(out.suggestions)
  .filter((s): s is RawSuggestion => isObj(s) && typeof s.file === "string" && Number(s.end_line) > 0 && typeof s.improved === "string" && !!s.improved.trim())
  .slice(0, 20)
  .map((s) => {
    const label = typeof s.label === "string" && labels.includes(s.label) ? s.label : fallback;
    const f = deriveSuggestionFromDetail({ file: s.file, line: Number(s.end_line), startLine: Number(s.start_line), severity: ["possible issue", "security"].includes(label) ? "medium" : "low", title: oneLine(s.title, 200), detail: proseOf(s.why, 1000), suggestion: s.improved }, diff);
    return { ...f, label };
  });
const fenceFor = (code: unknown) => "`".repeat(Math.max(3, ...[...String(code).matchAll(/`+/g)].map((m) => m[0].length + 1)));
const suggestionsMarkdown = (items: Suggestion[]) => items.length
  ? items.map((f, i) => [
      `**${i + 1}. ${mdCell(f.title, 200)}** · \`${mdCell(f.file, 300)}:L${f.startLine ? `${f.startLine}-` : ""}${f.line}\` · ${f.label}${typeof f.confidence === "number" ? ` · ${Math.round(f.confidence * 10)}/10` : ""}`,
      ...(f.detail ? ["", f.detail] : []),
      "", fenceFor(f.suggestion), f.suggestion, fenceFor(f.suggestion),
    ].join("\n")).join("\n\n")
  : "No suggestions.";
async function postSuggestions({ pr }: { pr: PullRequest }, result: PrToolResult) {
  const findings = result.data?.suggestions || [];
  if (!findings.length) throw new Error("No suggestions to post");
  const { posted, mode } = await postInlineSuggestionsOnPr({ pr, review: { findings } }, repoOf(pr));
  return `Posted ${posted} suggestion(s)${mode === "pr_comment_fallback" ? " as a PR comment (lines outside the diff)" : ""}`;
}
// Model prose posted to a PR: no HTML comments (they could forge CodeOtter's comment markers) and no live @mentions.
const proseOf = (x: unknown, max: number) => String(x ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/(^|[^\w`])@(?=[\w-])/g, "$1@\u200b").trim().slice(0, max);
const toolResults = new Map<string, PrToolResult>();
// Caches keyed by PR or commit grow with every review; keep the newest entries only.
export const capMap = (map: Map<unknown, unknown>, max: number) => { while (map.size > max) map.delete(map.keys().next().value); };
export async function runPrTool(prUrl: string, id: string, { question = "", action = "run" } = {}): Promise<PrToolResult & { message?: string }> {
  const tool = PR_TOOLS[id];
  if (!tool) throw new Error(`Unknown tool ${id}`);
  const key = `${prUrl}#${id}`;
  if (action === "run") {
    if (tool.input && !oneLine(question, 2000)) throw new Error(`${tool.label} needs ${tool.input.toLowerCase()}`);
    const ctx = await prToolContext(prUrl);
    const result: PrToolResult = { tool: id, label: tool.label, ...(await tool.run(ctx, oneLine(question, 2000))), headSha: ctx.pr.headRefOid || "", at: new Date().toISOString() };
    toolResults.set(key, result);
    capMap(toolResults, 500);
    return result;
  }
  const result = toolResults.get(key);
  if (!result) throw new Error(`Run ${tool.label} first`);
  if (action === "comment") {
    const pr = { url: prUrl, number: parsePrUrl(prUrl)!.number };
    const body = `<!-- codeotter:tool:${id} -->\n### 🦦 CodeOtter · ${tool.label}\n\n${result.markdown}\n\n---\n🔗 **[Open on CodeOtter →](${APP_URL}/review?pr=${encodeURIComponent(prUrl)})**`;
    // only `extra` is posted, which reads nothing of the PR beyond its URL and number
    await syncPrComments({ pr }, repoOf(pr), { extra: [[`<!-- codeotter:tool:${id} -->`, body, tool.label]] });
    return { ...result, message: "Posted as a PR comment" };
  }
  if (action === "apply" && tool.apply) {
    const { urlGuess, spec } = await resolvePr(prUrl, repoOf({ url: prUrl }));
    return { ...result, message: await tool.apply({ pr: JSON.parse(await readPr(urlGuess, spec)) }, result) };
  }
  throw new Error("Unknown action");
}
// </pr-tools>

// <pr-commands>
// PR comment commands: a comment whose first line is /review, /describe, /improve, /docs, /changelog, /ask <question> or
// /fix [n | stacked] runs that action and replies on the pull request. Off unless enabled in Settings, and only the repository's owner,
// members and collaborators can trigger one: anyone can comment on a public repository and spend its model budget.
// /override <check|all> <reason> has its own switch and rule (merge-checks.ts: requested reviewers, never the author),
// checked when it runs; the queue neither requires comment commands nor write access for it.
const COMMANDS = ["review", "describe", "improve", "ask", "docs", "changelog", "fix", "override"];
export const commandEnabled = (cmd: string, rc: { commands?: boolean; overrides?: boolean }) => (cmd === "override" ? !!rc.overrides : !!rc.commands);
export function parseCommand(body: unknown): PrCommand | null {
  const m = String(body || "").trimStart().split("\n")[0].trim().match(/^\/([a-z]+)(?:\s+(.*))?$/i);
  if (!m || !COMMANDS.includes(m[1].toLowerCase())) return null;
  return { cmd: m[1].toLowerCase(), arg: String(m[2] || "").trim().slice(0, 2000) };
}
// The pull request a comment belongs to: adapters set prNumber; otherwise its web link (GitHub /pull/7#..., Gitea /pulls/7#...).
export const commentPrNumber = (c: PrComment | null | undefined) => Number(c?.prNumber) || Number((String(c?.html_url || "").match(/\/pulls?\/([1-9]\d*)(?:#|$)/) || [])[1]) || 0;
// Who may run a comment command: write access on GitHub and Forgejo/Gitea, see each adapter's trusted() for the others.
export async function commenterTrusted(repo: string, c: PrComment): Promise<boolean> {
  if (!isForgeRepo(repo)) return ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association || "");
  return forgeOf(repo).trusted(repo, c as ForgeComment); // a forge repository's comments come from its adapter
}
async function commentsSince(repo: string, since: string): Promise<PrComment[]> {
  if (isForgeRepo(repo)) return forgeOf(repo).commentsSince(repo, since);
  return JSON.parse(await ghAsync("api", `repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100`));
}
export async function runCommand(repo: string, c: PrComment, { cmd, arg }: PrCommand) {
  const number = commentPrNumber(c);
  const prUrl = prUrlFor(repo, number);
  const id = Number(c.id);
  if (isForgeRepo(repo)) await Promise.resolve().then(() => forgeOf(repo).react(repo, c as ForgeComment)).catch(() => {});
  else if (Number.isSafeInteger(id) && id > 0) await ghAsApp(repo, "api", "--method", "POST", `repos/${repo}/issues/comments/${id}/reactions`, "-f", "content=eyes").catch(() => {});
  const login = String(c.user?.login || "unknown");
  const actor = { id: `comment:${login}`, name: login };
  await audit(actor, "command.run", prUrl, { command: `/${cmd}` }, orgOfRepo(repo));
  try {
    await withActor(actor, async () => {
      if (cmd === "review") {
        await syncPrComments(await score(prUrl, true, repo), repo, { postScores: true, postReview: true });
      } else if (cmd === "override") {
        await createPrComment(prUrl, repo, number, `🦦 CodeOtter \`/override\`: ${await overrideChecks(repo, number, c.user || {}, arg)}`);
      } else if (cmd === "fix" && arg.toLowerCase() === "stacked") {
        await fixStacked(prUrl, repo); // a fix branch and pull request; it comments the link itself
      } else if (cmd === "fix") {
        // suggestions only: nothing is pushed to the branch
        await createPrComment(prUrl, repo, number, `🦦 CodeOtter \`/fix${arg ? ` ${oneLine(arg, 20)}` : ""}\`: ${await fixFindings(prUrl, repo, arg)}`);
      } else {
        await runPrTool(prUrl, cmd, { question: arg });
        await runPrTool(prUrl, cmd, { action: "comment" });
      }
    });
  } catch (e) {
    await createPrComment(prUrl, repo, number, `🦦 CodeOtter \`/${cmd}${cmd === "fix" && arg.toLowerCase() === "stacked" ? " stacked" : ""}\` failed: ${oneLine((e as Error).message, 500)}`).catch(() => {});
    throw e;
  }
}
// </pr-commands>

// <thread-replies>
// Replies under CodeOtter's inline comments. A trusted reply in a thread whose root is a CodeOtter inline comment gets an
// answer from the language model in the same thread, given the finding, its hunk and the conversation. "@codeotter
// remember <rule>" records a team learning; a reply the model reads as "intentional / false positive" is offered one.
// Same switch and trust rule as comment commands. Never answers CodeOtter's own comments (marked) or bots. Queue only.
const ROOT_MARK = "<!-- codeotter:suggestion:";
const REPLY_MARK = "<!-- codeotter:reply -->";
const REMEMBER_RE = /@codeotter\s+remember\b:?\s*([\s\S]+)/i;
const REPLY_WINDOW = 30 * 60e3; // a thread scan (no comment id) answers only replies this recent
const isOurs = (c: ThreadComment, meId: string) => c.bot || c.body.includes("<!-- codeotter:") || (!!meId && String(c.user.id) === meId);
const plain = (s: string, max: number) => String(s || "").replace(/<!--[\s\S]*?(-->|$)/g, "").trim().slice(0, max);
// GitHub review comments, grouped by thread: in_reply_to_id always names the thread's first comment.
function githubThreads(raw: unknown): ThreadComment[][] {
  const threads = new Map<string, ThreadComment[]>();
  for (const c of (Array.isArray(raw) ? raw.flat() : []) as unknown[]) {
    if (!isObj(c) || !Number.isSafeInteger(Number(c.id)) || typeof c.path !== "string") continue;
    const user = isObj(c.user) ? c.user : {};
    const login = String(user.login || "");
    const t: ThreadComment = {
      id: Number(c.id), body: String(c.body || ""), created_at: String(c.created_at || ""), user: { id: Number(user.id) || 0, login },
      bot: user.type === "Bot" || /\[bot\]$/.test(login), path: c.path, line: Number(c.line ?? c.original_line) || 0, hunk: String(c.diff_hunk || ""),
      author_association: String(c.author_association || ""), reactions: countReactions(c.reactions),
    };
    const key = String(Number(c.in_reply_to_id) || t.id);
    threads.set(key, [...(threads.get(key) || []), t]);
  }
  return [...threads.values()].map((t) => t.sort((a, b) => a.created_at.localeCompare(b.created_at) || Number(a.id) - Number(b.id)));
}
export async function reviewThreads(repo: string, number: number): Promise<ThreadComment[][]> {
  if (isForgeRepo(repo)) return forgeOf(repo).reviewThreads?.(repo, number) ?? [];
  return githubThreads(JSON.parse(await ghAsync("api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/comments?per_page=100`)));
}
function replyInThread(repo: string, number: number, root: ThreadComment, text: string) {
  const body = `${REPLY_MARK}\n${text}`;
  if (isForgeRepo(repo)) return forgeOf(repo).replyInThread!(repo, number, root, body);
  return ghAsApp(repo, "api", "--method", "POST", `repos/${repo}/pulls/${number}/comments/${Number(root.id)}/replies`, "-f", `body=${body}`);
}
// One queued job: a PR's threads, answering the comment `commentId` (GitHub webhook) or any recent unanswered reply.
export async function answerReplies(repo: string, number: number, commentId = ""): Promise<number> {
  if (!(await reviewConfig(repo)).commands) return 0;
  if (isForgeRepo(repo) && !forgeOf(repo).reviewThreads) return 0;
  const me = isForgeRepo(repo) ? await forgeOf(repo).me(repo).catch(() => null) : null;
  const meId = me?.id === undefined || me?.id === "" ? "" : String(me.id);
  let answered = 0;
  for (const t of await reviewThreads(repo, number)) {
    const root = t[0], last = t[t.length - 1];
    if (t.length < 2 || !root.body.includes(ROOT_MARK) || (meId && String(root.user.id) !== meId)) continue;
    if (isOurs(last, meId)) continue; // answered already, or a bot
    if (commentId ? String(last.id) !== commentId : !(Date.now() - Date.parse(last.created_at) < REPLY_WINDOW)) continue;
    if (!remember(HANDLED_COMMENTS, `${repo}#reply:${last.id}`)) continue;
    const asComment: PrComment = { id: last.id, body: last.body, created_at: last.created_at, prNumber: number, author_association: last.author_association, user: last.user };
    if (!(await commenterTrusted(repo, asComment).catch(() => false))) continue;
    // audited like a comment command: who replied, and whether the reply saved a team learning
    const login = String(last.user.login || "unknown");
    const actor = { id: `comment:${login}`, name: login };
    await audit(actor, "command.run", prUrlFor(repo, number), { command: REMEMBER_RE.test(plain(last.body, 2000)) ? "@codeotter remember" : "reply", thread: String(root.id) }, orgOfRepo(repo));
    await withActor(actor, () => answerThread(repo, number, t));
    answered++;
  }
  return answered;
}
async function answerThread(repo: string, number: number, t: ThreadComment[]) {
  const root = t[0], last = t[t.length - 1];
  const remembered = plain(last.body, 2000).match(REMEMBER_RE);
  const rule = remembered ? oneLine(remembered[1], 300).replace(/`/g, "") : "";
  if (rule) {
    await setRepoLearnings(repo, [...(await getRepoLearnings(repo)), rule]);
    await noteReply(repo, prUrlFor(repo, number), root.body);
    return replyInThread(repo, number, root, `🦦 Saved as a team learning for this repository: ${proseOf(rule, 300)}`);
  }
  const c = await llmConfig();
  try {
    if (!c.model) throw new Error("Replies need a language model: open Admin / Model provider");
    if (c.api === "codereviewer") throw new Error("CodeReviewer cannot hold a conversation: pick a language model in Admin / Model provider");
    // servers whose thread comments carry no diff hunk (GitLab): cut it from the pull request's diff
    const hunk = root.hunk || (isForgeRepo(repo) && root.path && root.line > 0 ? hunkAt(await forgeOf(repo).diff(repo, number).catch(() => ""), root.path, root.line) : "");
    const history = t.slice(1, -1).slice(-10).map((x) => `${isOurs(x, "") ? "CodeOtter" : x.user.login || "reviewer"}: ${plain(x.body, 1500)}`).join("\n\n");
    const out = await askJson(c, `You are CodeOtter. A developer replied under one of your inline review comments on pull request #${number}. Answer the latest reply directly and briefly: explain, concede when the reply is right, or hold your point with a concrete reason from the code. Do not repeat your original comment. Reply with ONLY a JSON object:
{"answer":"markdown","dismissed":false,"learning":""}
Set "dismissed" to true only when the reply shows the finding is intentional, a false positive or unwanted in this repository; then "learning" is a one-line rule that keeps future reviews from raising it again.

File: ${root.path}${root.line ? ` line ${Math.abs(root.line)}` : ""}
Diff hunk:
${hunk.slice(0, 4000) || "(not available)"}

Your original comment:
${plain(root.body, 3000)}
${history ? `\nEarlier replies (oldest first):\n${history}\n` : ""}
Latest reply from ${last.user.login || "reviewer"}:
${plain(last.body, 3000)}`, "a thread reply");
    const answer = proseOf(out.answer, 4000);
    if (!answer) throw new Error(`${c.provider}/${c.model} returned no reply`);
    const learning = out.dismissed === true ? oneLine(proseOf(out.learning, 300), 300).replace(/`/g, "'") : "";
    // the model read the reply as pushback: signal for learned rules
    if (out.dismissed === true) await noteReply(repo, prUrlFor(repo, number), root.body);
    await replyInThread(repo, number, root, learning ? `${answer}\n\nTo keep this as a team learning, reply \`@codeotter remember ${learning}\`` : answer);
  } catch (e) {
    await Promise.resolve(replyInThread(repo, number, root, `🦦 CodeOtter could not answer: ${oneLine((e as Error).message, 500)}`)).catch(() => {});
    throw e;
  }
}
// </thread-replies>
// Every minute: each onboarded repository's comments since the last poll, oldest first. The first poll after enabling
// looks back five minutes, so older comments never fire.
let commandPolling = false;
if (IS_SERVER) setInterval(async () => {
  if (commandPolling) return;
  commandPolling = true;
  try {
    const seen = (await store.getSetting("commandsSeen")) || {};
    for (const repo of await repos()) {
      const rc = await reviewConfig(repo);
      if (!rc.commands && !rc.overrides) {
        // marked once while off; the first poll after turning commands on starts from that moment, so nothing posted
        // while they were off ever runs (and an off repository costs no writes)
        if (seen[repo] !== "off") { seen[repo] = "off"; await store.setSetting("commandsSeen", seen); }
        continue;
      }
      if (seen[repo] === "off") { seen[repo] = new Date().toISOString(); await store.setSetting("commandsSeen", seen); continue; }
      // webhooks deliver comments as they happen; this loop is the catch-up for a forge with no recent delivery
      if (webhookHealthy(forgeId(repo) || "github") && Date.now() - (lastCatchUp[forgeId(repo) || "github"] || 0) < CATCH_UP_EVERY) continue;
      const since = seen[repo] || new Date(Date.now() - 5 * 60e3).toISOString();
      let list;
      try {
        list = await commentsSince(repo, since);
      } catch (e) {
        console.warn(`[commands] ${repo}: ${(e as Error).message}`);
        continue;
      }
      let latest = since;
      for (const c of Array.isArray(list) ? list : []) {
        const at = String(c?.created_at || "");
        if (!at || Date.parse(at) <= Date.parse(since)) continue;
        if (Date.parse(at) > Date.parse(latest)) latest = new Date(Date.parse(at)).toISOString();
        const command = parseCommand(c.body);
        if (!command || !commentPrNumber(c) || !commandEnabled(command.cmd, rc)) continue;
        if (!remember(HANDLED_COMMENTS, `${repo}#${c.id}`)) continue; // a webhook already ran it
        if (command.cmd !== "override" && !(await commenterTrusted(repo, c).catch(() => false))) continue;
        await runCommand(repo, c, command).catch((e) => console.warn(`[commands] ${repo} /${command.cmd}: ${e.message}`));
      }
      seen[repo] = latest;
      await store.setSetting("commandsSeen", seen);
    }
  } catch (e) {
    console.warn(`[commands] ${(e as Error).message}`);
  } finally {
    commandPolling = false;
  }
}, 60e3).unref();
