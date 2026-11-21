// Learned rules. Signal on CodeOtter's own inline comments (thumbs up / down where the server has a reactions API,
// replies the language model read as pushback, fixed by a later push, dismissed on the review page, still open when the
// pull request closed); candidate team learnings the language model drafts from recurring pushback on similar findings
// (stored as suggested, accepted or rejected on Repository settings, switched on by themselves only with the repository's
// auto-promotion on and enough pushback); and rule health: a learning whose findings are rarely fixed switches off unless
// locked. Collected lazily through the PR queue (re-review, close), never by a poll of its own. Per repository, in the
// setting `learned:<repo>`.
import { createHash } from "node:crypto";
import { store } from "./store.ts";
import { forgeOf, isForgeRepo } from "./git.ts";
import { getRepoLearnings, reviewConfig, ruleId, setRepoLearnings } from "./context.ts";
import { askModel, llmConfig } from "./models.ts";
import { reviewThreads } from "./pr-tools.ts";
import { audit, AUTO, orgOfRepo } from "./audit.ts";
import { repoOf } from "./views.ts";
import type { Reactions, ThreadComment } from "./forges.ts";
import type { ReviewSettings } from "./context.ts";
import type { Finding } from "./engines.ts";

export type Outcome = "open" | "fixed" | "dismissed" | "ignored";
// One finding CodeOtter raised on one pull request. `pushback`: a reply the model read as "intentional / false positive",
// or "@codeotter remember". `used`: the rule it went into (or "none": the model found no pattern), so it is drafted once.
export interface Signal {
  id: string; pr: string; file: string; title: string; detail: string; rule?: string;
  up: number; down: number; replies: string[]; pushback: boolean; outcome: Outcome; counted?: boolean; used?: string; at: string;
}
export type RuleStatus = "active" | "off" | "suggested" | "rejected";
// Health of one learning, keyed by ruleId(text). `evidence`: titles of the findings a model-drafted rule came from.
export interface RuleHealth {
  text: string; status: RuleStatus; locked?: boolean; source: "team" | "model";
  fixed: number; ignored: number; dismissed: number; up: number; down: number; evidence: string[]; support: number; at: string; changedAt?: string;
}
export interface LearnedState { signals: Signal[]; rules: Record<string, RuleHealth>; error?: string }

const MAX_SIGNALS = 80; // the newest; a setting value is capped at 100 kB
const SUGGEST_AFTER = 2; // similar findings pushed back on before the model is asked for a rule
const DRAFTS_PER_RUN = 2;
const key = (repo: string) => `learned:${repo}` as const;
const now = () => new Date().toISOString();
const clip = (x: unknown, n: number) => String(x ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/\s+/g, " ").trim().slice(0, n);
export const signalId = (pr: string, file: string, title: string) => createHash("sha256").update(`${pr}\n${file}\n${title}`).digest("hex").slice(0, 16);
export const isNegative = (s: Signal) => s.pushback || s.down > s.up || s.outcome === "dismissed";

// Writers run one at a time: a collection, a reply and a row action all read, change and write the same value.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

export async function loadLearned(repo: string): Promise<LearnedState> {
  const v = await store.getSetting(key(repo));
  return { signals: Array.isArray(v?.signals) ? v.signals : [], rules: v?.rules && typeof v.rules === "object" ? v.rules : {}, ...(v?.error ? { error: v.error } : {}) };
}
async function saveLearned(repo: string, st: LearnedState) {
  st.signals = st.signals.sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_SIGNALS);
  await store.setSetting(key(repo), st);
}
const newRule = (text: string, source: RuleHealth["source"], status: RuleStatus): RuleHealth =>
  ({ text, status, source, fixed: 0, ignored: 0, dismissed: 0, up: 0, down: 0, evidence: [], support: 0, at: now() });
// The health record of an active learning, made on first use.
const ruleOf = (st: LearnedState, learnings: string[], id: string): RuleHealth | null => {
  if (st.rules[id]) return st.rules[id];
  const text = learnings.find((l) => ruleId(l) === id);
  return text ? (st.rules[id] = newRule(text, "team", "active")) : null;
};

// <learned-anchor>
// The finding an inline comment root names: its marker carries the file, its bold heading the title (review.ts inlineAnchor).
export function anchorOf(body: string): { file: string; title: string } | null {
  const m = /<!-- codeotter:suggestion:(.+?):\d+ -->/.exec(body);
  const t = /— \*\*(.+?)\*\* \(`/.exec(body);
  return m && t ? { file: m[1], title: t[1] } : null;
}
// </learned-anchor>

// A reply under one of CodeOtter's inline comments that the model read as pushback (pr-tools.ts answerThread).
export function noteReply(repo: string, prUrl: string, rootBody: string): Promise<void> {
  const a = anchorOf(rootBody);
  if (!a) return Promise.resolve();
  return serial(async () => {
    const st = await loadLearned(repo);
    const id = signalId(prUrl, a.file, a.title);
    const s = st.signals.find((x) => x.id === id);
    if (s) s.pushback = true;
    else st.signals.push({ id, pr: prUrl, file: a.file, title: clip(a.title, 160), detail: "", up: 0, down: 0, replies: [], pushback: true, outcome: "open", at: now() });
    await saveLearned(repo, st);
  });
}

// One queued job (queue.ts): the stored review of `prUrl`, its inline threads, their reactions and replies. `final`: the
// pull request closed, so a finding still open counts as ignored. Then rule health and candidates (evolve).
export async function collectFeedback(repo: string, prUrl: string, final = false): Promise<number> {
  const rec = await store.get(prUrl);
  if (!rec?.review || repoOf(rec.pr) !== repo) return 0;
  const n = Number(rec.pr.number);
  const threads = Number.isSafeInteger(n) && n > 0 ? await reviewThreads(repo, n).catch((e: Error) => { console.warn(`[learned] ${prUrl}: ${e.message}`); return [] as ThreadComment[][]; }) : [];
  const forge = isForgeRepo(repo) ? forgeOf(repo) : null;
  const ours = new Map<string, { t: ThreadComment[]; reactions: Reactions | null }>();
  for (const t of threads.slice(0, 60)) {
    const a = t[0] && !t[0].bot ? anchorOf(t[0].body) : null;
    if (!a) continue;
    // GitHub lists reactions with the comment; Gitea/Forgejo and GitLab are asked per comment; elsewhere there are none
    const reactions = t[0].reactions ?? (forge?.reactions ? await forge.reactions(repo, n, t[0]).catch(() => null) : null);
    ours.set(signalId(prUrl, a.file, a.title), { t, reactions });
  }
  const findings: [Finding, Outcome][] = [
    ...(rec.review.findings || []).map((f): [Finding, Outcome] => [f, f.dismissed ? "dismissed" : "open"]),
    ...(rec.incremental?.resolvedFindings || []).map((f): [Finding, Outcome] => [f, "fixed"]),
  ];
  const rc = await reviewConfig(repo);
  return serial(async () => {
    const st = await loadLearned(repo);
    const learnings = await getRepoLearnings(repo);
    let seen = 0;
    for (const [f, o] of findings) {
      if (!f?.file || f.severity === "nit") continue;
      const title = f.title || "Suggested fix";
      const id = signalId(prUrl, f.file, title);
      let s = st.signals.find((x) => x.id === id);
      if (!s) st.signals.push((s = { id, pr: prUrl, file: clip(f.file, 300), title: clip(title, 160), detail: "", up: 0, down: 0, replies: [], pushback: false, outcome: "open", at: now() }));
      if (f.rule && !s.rule) s.rule = f.rule;
      const thread = ours.get(id);
      const rule = s.rule ? ruleOf(st, learnings, s.rule) : null;
      if (thread?.reactions) {
        if (rule) { rule.up += thread.reactions.up - s.up; rule.down += thread.reactions.down - s.down; }
        s.up = thread.reactions.up;
        s.down = thread.reactions.down;
      }
      if (thread) s.replies = thread.t.slice(1).filter((c) => !c.bot && !c.body.includes("<!-- codeotter:")).map((c) => clip(c.body, 240)).filter(Boolean).slice(-2);
      if (s.outcome === "open") s.outcome = o === "open" ? (final ? "ignored" : "open") : o;
      if (s.outcome !== "open" && !s.counted && rule) { rule[s.outcome]++; s.counted = true; }
      // only pushback needs the text: it goes to the model when a rule is drafted
      s.detail = isNegative(s) ? clip(String(f.detail || "").split("\n\n@@")[0], 240) : "";
      seen++;
    }
    await evolve(repo, st, rc, learnings);
    await saveLearned(repo, st);
    return seen;
  });
}

// <rule-health>
// Whether a learning switches off: enough findings tied to it closed (fixed, dismissed or ignored) and too few fixed.
export function shouldSwitchOff(r: RuleHealth, rc: Pick<ReviewSettings, "ruleMinSamples" | "ruleMinFixRate">): boolean {
  const samples = r.fixed + r.ignored + r.dismissed;
  return r.status === "active" && !r.locked && rc.ruleMinFixRate > 0 && samples >= rc.ruleMinSamples && (r.fixed / samples) * 100 < rc.ruleMinFixRate;
}
// </rule-health>
const WORD = /[\p{L}\p{N}_]{3,}/gu;
const words = (s: string) => new Set((s.toLowerCase().match(WORD) || []).filter((w) => !["the", "and", "for", "with", "not", "this", "that", "from"].includes(w)));
// Similar findings: half or more of the title words shared. Grouping only; the rule text always comes from the model.
export function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.5;
}

// Rule health, then candidates from unused pushback, then (auto-promotion on) suggested rules with enough support.
async function evolve(repo: string, st: LearnedState, rc: ReviewSettings, learnings0: string[]) {
  let learnings = [...learnings0];
  const org = orgOfRepo(repo);
  for (const [id, r] of Object.entries(st.rules)) {
    if (r.status === "active" && !learnings.some((l) => ruleId(l) === id)) continue; // removed by hand: nothing to switch
    if (!shouldSwitchOff(r, rc)) continue;
    r.status = "off";
    r.changedAt = now();
    learnings = learnings.filter((l) => ruleId(l) !== id);
    await setRepoLearnings(repo, learnings);
    await audit(AUTO, "rule.auto-off", repo, { rule: clip(r.text, 160), fixed: r.fixed, ignored: r.ignored, dismissed: r.dismissed, minFixRate: rc.ruleMinFixRate }, org);
  }
  let drafts = 0;
  for (const s of st.signals) {
    if (s.used || !isNegative(s)) continue;
    // pushback like a model-drafted rule's evidence goes to that rule (suggested: more support; rejected: absorbed)
    const hit = Object.entries(st.rules).find(([, r]) => r.source === "model" && r.evidence.some((e) => similar(e, s.title)));
    if (hit) {
      s.used = hit[0];
      hit[1].support++;
      if (hit[1].evidence.length < 10) hit[1].evidence.push(s.title);
      continue;
    }
    const group = st.signals.filter((o) => !o.used && isNegative(o) && (o === s || similar(o.title, s.title)));
    if (group.length < SUGGEST_AFTER || drafts >= DRAFTS_PER_RUN) continue;
    drafts++;
    let text: string;
    try {
      text = await draftRule(repo, group);
    } catch (e) {
      st.error = clip((e as Error).message, 300); // nothing is suggested; the same pushback is tried again next time
      continue;
    }
    delete st.error;
    const id = text ? ruleId(text) : "none";
    for (const o of group) o.used = id;
    if (!text || st.rules[id] || learnings.includes(text)) continue;
    st.rules[id] = { ...newRule(text, "model", "suggested"), evidence: group.map((o) => o.title).slice(0, 10), support: group.length };
  }
  if (!rc.autoLearn) return;
  for (const [id, r] of Object.entries(st.rules)) {
    if (r.status !== "suggested" || r.support < rc.promoteAfter) continue;
    r.status = "active";
    r.changedAt = now();
    learnings = [...learnings, r.text];
    await setRepoLearnings(repo, learnings);
    await audit(AUTO, "rule.auto-on", repo, { rule: clip(r.text, 160), support: r.support, promoteAfter: rc.promoteAfter, id }, org);
  }
}

// <draft-rule>
// The language model writes the rule from the findings and what reviewers said; "" when it sees no shared pattern.
// A failure throws: no rule text is ever made up here.
export async function draftRule(repo: string, group: Signal[]): Promise<string> {
  const c = await llmConfig();
  if (!c.model) throw new Error("Learned rules need a language model: open Admin / Model provider");
  if (c.api === "codereviewer") throw new Error("CodeReviewer cannot write rules: pick a language model in Admin / Model provider");
  const items = group.slice(0, 8).map((s, i) => [
    `${i + 1}. ${s.file}: ${s.title}`,
    ...(s.detail ? [`   Finding: ${s.detail}`] : []),
    `   Reviewers: ${[s.down ? `${s.down} thumbs down` : "", s.up ? `${s.up} thumbs up` : "", s.pushback ? "replied that it is intentional or a false positive" : "", s.outcome === "dismissed" ? "dismissed it" : ""].filter(Boolean).join(", ")}`,
    ...s.replies.map((r) => `   Reply: ${r}`),
  ].join("\n")).join("\n");
  const text = await askModel(`You are CodeOtter, a code reviewer. On repository ${repo}, reviewers keep pushing back on findings like these:\n${items}\n\nWrite one team rule, a single imperative line, that keeps future reviews from raising findings like these. If they share no pattern, answer an empty rule. Reply with ONLY a JSON object: {"rule":"..."}`, { ...c, temperature: 0.2 });
  let out: unknown;
  try {
    out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new Error(`${c.provider}/${c.model} did not return valid JSON for a learned rule`);
  }
  const rule = out && typeof out === "object" ? (out as { rule?: unknown }).rule : undefined;
  if (typeof rule !== "string") throw new Error(`${c.provider}/${c.model} returned no rule`);
  return clip(rule, 300).replace(/`/g, "'");
}
// </draft-rule>

// <rule-table>
// Repository settings → Learnings: every active learning, then switched-off and suggested rules. Status is one badge:
// active, off, locked (active and pinned) or suggested.
export type RuleRow = { id: string; text: string; status: "active" | "off" | "locked" | "suggested"; source: RuleHealth["source"]; fixed: number; ignored: number; dismissed: number; up: number; down: number; support: number };
export function ruleRows(learnings: string[], st: LearnedState): RuleRow[] {
  const row = (id: string, text: string, r: RuleHealth | undefined, status: RuleRow["status"]): RuleRow =>
    ({ id, text, status, source: r?.source || "team", fixed: r?.fixed || 0, ignored: r?.ignored || 0, dismissed: r?.dismissed || 0, up: r?.up || 0, down: r?.down || 0, support: r?.support || 0 });
  const active = learnings.map((text) => { const id = ruleId(text), r = st.rules[id]; return row(id, text, r, r?.locked ? "locked" : "active"); });
  const ids = new Set(active.map((r) => r.id));
  const rest = Object.entries(st.rules).filter(([id, r]) => !ids.has(id) && (r.status === "off" || r.status === "suggested")).map(([id, r]) => row(id, r.text, r, r.status === "off" ? "off" : "suggested"));
  return [...active, ...rest];
}
// </rule-table>
export async function repoRules(repo: string): Promise<{ rows: RuleRow[]; error: string }> {
  const [learnings, st] = await Promise.all([getRepoLearnings(repo), loadLearned(repo)]);
  return { rows: ruleRows(learnings, st), error: st.error || "" };
}
export type RuleAction = "accept" | "remove" | "lock" | "switch";
// A row action on Repository settings (admins and owners). accept: a suggestion goes live; remove: rejects a suggestion,
// or drops a learning; lock: pins an active learning on (or unpins it); switch: turns a learning off, or back on.
export function ruleAction(repo: string, id: string, action: RuleAction): Promise<string> {
  return serial(async () => {
    const [st, learnings] = await Promise.all([loadLearned(repo), getRepoLearnings(repo)]);
    const row = ruleRows(learnings, st).find((r) => r.id === id);
    if (!row) throw new Error("Unknown rule");
    const r = ruleOf(st, learnings, id) || (st.rules[id] = newRule(row.text, "team", row.status === "suggested" ? "suggested" : "off"));
    const live = row.status === "active" || row.status === "locked";
    let next = learnings;
    let message: string;
    if (action === "accept") {
      if (row.status !== "suggested") throw new Error("Only a suggested rule can be accepted");
      r.status = "active"; next = [...learnings, r.text]; message = "Rule accepted.";
    } else if (action === "remove") {
      if (row.status === "suggested") { r.status = "rejected"; message = "Suggestion rejected."; }
      else { next = learnings.filter((l) => ruleId(l) !== id); delete st.rules[id]; message = "Rule removed."; }
    } else if (action === "lock") {
      if (!live) throw new Error("Only an active rule can be locked");
      r.locked = !r.locked; message = r.locked ? "Rule locked on." : "Rule unlocked.";
    } else {
      if (row.status === "suggested") throw new Error("Accept a suggested rule first");
      if (row.status === "locked") throw new Error("Unlock the rule first");
      // switched back on by hand: its counts start over, so the same history does not switch it off again
      if (live) { r.status = "off"; next = learnings.filter((l) => ruleId(l) !== id); message = "Rule switched off."; }
      else { Object.assign(r, { status: "active", fixed: 0, ignored: 0, dismissed: 0 }); next = [...learnings, r.text]; message = "Rule switched on."; }
    }
    r.changedAt = now();
    if (next !== learnings) await setRepoLearnings(repo, next);
    await saveLearned(repo, st);
    return message;
  });
}
