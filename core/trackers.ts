// Issue trackers: Jira and Linear tickets named by a pull request (title, branch, description), fetched as linked issues.
// The Jira server and both credentials come only from settings (Settings → System → Issue trackers), never from the PR.
import { store } from "./store.ts";
import type { LinkedIssue } from "./context.ts";

export interface JiraSetting { url: string; email: string; token: string; projects: string[] }
export interface LinearSetting { apiKey: string; teams: string[] }
export interface TrackerSettings { jira?: Partial<JiraSetting>; linear?: Partial<LinearSetting> }
export type Tracker = "jira" | "linear";
export interface TicketRef { tracker: Tracker; key: string }
export interface TicketSource { title?: string; body?: string | null; headRefName?: string }

export const LINEAR_API = "https://api.linear.app/graphql";
const MAX_TICKETS = 3;
const TIMEOUT_MS = 15000;
const CACHE_MS = 5 * 60 * 1000;
export const TRACKER_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
// A ticket key: a project or team key, a dash and a number not starting with 0, standing alone (not part of a longer word).
const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9]\d{0,6})(?![A-Za-z0-9])/g;
const LINEAR_URL_RE = /https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-[1-9]\d{0,6})\b/g;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === "string" ? x : "");

// Project / team keys as typed in settings: "ABC, ops" -> ["ABC", "OPS"]; anything that is not a key is refused.
export function trackerKeys(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[\s,]+/);
  const keys = [...new Set(list.map((k) => k.trim().toUpperCase()).filter(Boolean))];
  for (const k of keys) if (!TRACKER_KEY_RE.test(k)) throw new Error(`Not a project or team key: ${k}`);
  return keys;
}

// The Jira base URL: HTTP(S), no credentials, query or fragment; a path is kept for Data Center under a context path.
export function jiraBase(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error("Jira URL must be an HTTP(S) address without credentials, query or fragment");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// Ticket keys named in the title, description and branch. Jira keys count only for configured projects and Linear keys
// only for configured teams (so UTF-8, SHA-256 or ISO-8601 never match); a linear.app issue URL counts on its own.
// The branch is matched case-insensitively (feature/abc-123-login); prose needs the upper-case key.
export function ticketRefs(pr: TicketSource | null | undefined, s: TrackerSettings): TicketRef[] {
  const jira = new Set(jiraReady(s.jira) ? s.jira?.projects || [] : []);
  const linear = new Set(linearReady(s.linear) ? s.linear?.teams || [] : []);
  const out: TicketRef[] = [];
  const add = (tracker: Tracker, key: string) => {
    if (out.length < MAX_TICKETS && !out.some((r) => r.tracker === tracker && r.key === key)) out.push({ tracker, key });
  };
  const scan = (text: string, anyCase: boolean) => {
    if (linearReady(s.linear)) for (const m of text.matchAll(LINEAR_URL_RE)) add("linear", m[1].toUpperCase());
    for (const m of text.matchAll(KEY_RE)) {
      if (!anyCase && m[1] !== m[1].toUpperCase()) continue;
      const project = m[1].toUpperCase();
      const key = `${project}-${m[2]}`;
      if (jira.has(project)) add("jira", key);
      else if (linear.has(project)) add("linear", key);
    }
  };
  scan(String(pr?.title || ""), false);
  scan(String(pr?.headRefName || ""), true);
  scan(String(pr?.body || ""), false);
  return out;
}

const jiraReady = (j: Partial<JiraSetting> | undefined): j is Partial<JiraSetting> & { url: string; token: string } => !!(j?.url && j.token);
const linearReady = (l: Partial<LinearSetting> | undefined): l is Partial<LinearSetting> & { apiKey: string } => !!l?.apiKey;

// Atlassian Document Format (Jira Cloud v3 rich text) to plain text: paragraphs and headings on their own lines,
// list items as "- ", mentions and emoji by their text, code blocks kept. Unknown nodes contribute their children.
export function adfToText(node: unknown): string {
  const walk = (n: unknown, depth: number): string => {
    if (typeof n === "string") return n;
    if (!isObj(n) || depth > 40) return "";
    const kids = Array.isArray(n.content) ? n.content : [];
    const inner = (sep = "") => kids.map((k) => walk(k, depth + 1)).join(sep);
    const attrs = isObj(n.attrs) ? n.attrs : {};
    switch (n.type) {
      case "text": return str(n.text);
      case "hardBreak": return "\n";
      case "mention": case "emoji": case "status": return str(attrs.text) || str(attrs.shortName);
      case "inlineCard": case "blockCard": return str(attrs.url);
      case "paragraph": case "heading": return `${inner()}\n`;
      case "codeBlock": return `\`\`\`\n${inner()}\n\`\`\`\n`;
      case "bulletList": case "orderedList": return inner();
      case "listItem": return `- ${inner().trim().replace(/\n/g, "\n  ")}\n`;
      case "rule": return "---\n";
      case "tableRow": return `${kids.map((k) => walk(k, depth + 1).trim()).join(" | ")}\n`;
      default: return inner();
    }
  };
  return walk(node, 0).replace(/\n{3,}/g, "\n\n").trim();
}

// fetch with a timeout and no redirects followed: credentials only ever reach the configured address.
async function call(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) throw new Error(`${new URL(url).host} answered with a redirect; set the address it redirects to`);
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`), { status: res.status });
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`${new URL(url).host} returned a non-JSON answer`); }
}

// Jira Cloud: email + API token (Basic) on REST v3, descriptions in ADF. Data Center: a personal access token (Bearer)
// on REST v2, descriptions in wiki markup. Which one is decided by whether an email is set.
function jiraRequest(j: Partial<JiraSetting> & { url: string; token: string }, path: string): Promise<unknown> {
  const cloud = !!j.email;
  const auth = cloud ? `Basic ${Buffer.from(`${j.email}:${j.token}`).toString("base64")}` : `Bearer ${j.token}`;
  return call(`${jiraBase(j.url)}/rest/api/${cloud ? 3 : 2}/${path}`, { headers: { authorization: auth, accept: "application/json" } });
}
const richText = (v: unknown): string => (typeof v === "string" ? v.trim() : isObj(v) ? adfToText(v) : "");
const ticketBody = (criteria: string, description: string) => [criteria && `Acceptance criteria:\n${criteria}`, description].filter(Boolean).join("\n\n").slice(0, 4000);

export async function fetchJiraTicket(j: Partial<JiraSetting>, key: string): Promise<LinkedIssue | null> {
  if (!jiraReady(j) || !/^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/.test(key)) return null;
  const raw = await jiraRequest(j, `issue/${encodeURIComponent(key)}?fields=*navigable&expand=names`);
  if (!isObj(raw) || !isObj(raw.fields)) return null;
  const f = raw.fields;
  const names = isObj(raw.names) ? raw.names : {};
  // Acceptance criteria are a custom field on most sites; found by its display name.
  const criteria = Object.entries(names).filter(([, n]) => /acceptance\s*criteria/i.test(str(n))).map(([id]) => richText(f[id])).filter(Boolean).join("\n");
  const issueKey = str(raw.key) || key;
  return {
    number: Number(issueKey.split("-")[1]) || 0,
    key: issueKey,
    repo: "jira",
    title: str(f.summary).trim().slice(0, 300),
    body: ticketBody(criteria, richText(f.description)),
    state: (isObj(f.status) ? str(f.status.name) : "").toUpperCase() || "OPEN",
    url: `${jiraBase(j.url)}/browse/${encodeURIComponent(issueKey)}`,
    labels: (Array.isArray(f.labels) ? f.labels : []).map(str).filter(Boolean).slice(0, 12),
  };
}

function linearRequest(l: Partial<LinearSetting> & { apiKey: string }, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  return call(LINEAR_API, { method: "POST", headers: { authorization: l.apiKey, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query, variables }) });
}
const linearData = (raw: unknown): Record<string, unknown> => {
  if (!isObj(raw)) throw new Error("Linear returned no data");
  if (Array.isArray(raw.errors) && raw.errors.length) throw new Error(`Linear: ${str(isObj(raw.errors[0]) ? raw.errors[0].message : "") || "query failed"}`);
  return isObj(raw.data) ? raw.data : {};
};

export async function fetchLinearTicket(l: Partial<LinearSetting>, key: string): Promise<LinkedIssue | null> {
  if (!linearReady(l) || !/^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/.test(key)) return null;
  const data = linearData(await linearRequest(l, "query Ticket($id: String!) { issue(id: $id) { identifier title description url state { name } labels { nodes { name } } } }", { id: key }));
  const i = data.issue;
  if (!isObj(i)) return null;
  const identifier = str(i.identifier) || key;
  const url = str(i.url);
  const description = str(i.description).trim();
  // Linear has no criteria field; teams write them as a section of the description.
  const criteria = (description.match(/(?:^|\n)#{1,6}\s*acceptance criteria\s*\n([\s\S]*?)(?=\n#{1,6}\s|$)/i) || [])[1]?.trim() || "";
  return {
    number: Number(identifier.split("-")[1]) || 0,
    key: identifier,
    repo: "linear",
    title: str(i.title).trim().slice(0, 300),
    body: ticketBody(criteria, description),
    state: (isObj(i.state) ? str(i.state.name) : "").toUpperCase() || "OPEN",
    url: url.startsWith("https://linear.app/") ? url : "",
    labels: (isObj(i.labels) && Array.isArray(i.labels.nodes) ? i.labels.nodes : []).map((n) => (isObj(n) ? str(n.name) : "")).filter(Boolean).slice(0, 12),
  };
}

// Fetched tickets, kept briefly so a re-review or the next commit does not ask again.
const cache = new Map<string, { at: number; value: LinkedIssue | null }>();
export const clearTicketCache = () => cache.clear();

export async function trackerSettings(): Promise<TrackerSettings> {
  const s = await store.getSetting("issueTrackers");
  return isObj(s) ? s : {};
}

// The tickets a pull request names, fetched from their tracker. A ticket that cannot be read is left out.
export async function linkedTickets(pr: TicketSource | null | undefined, settings?: TrackerSettings): Promise<LinkedIssue[]> {
  const s = settings || await trackerSettings();
  const refs = ticketRefs(pr, s);
  const list = await Promise.all(refs.map(async ({ tracker, key }) => {
    const id = `${tracker}:${tracker === "jira" ? s.jira?.url : ""}:${key}`;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    try {
      const value = tracker === "jira" ? await fetchJiraTicket(s.jira || {}, key) : await fetchLinearTicket(s.linear || {}, key);
      cache.set(id, { at: Date.now(), value });
      return value;
    } catch (e) {
      // a ticket that does not exist (or is not visible to the token) is remembered too; other failures are retried
      if (isObj(e) && (e.status === 404 || e.status === 403)) cache.set(id, { at: Date.now(), value: null });
      console.warn(`[trackers] ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }));
  return list.filter((x): x is LinkedIssue => !!x);
}

export async function testJira(s: TrackerSettings): Promise<string> {
  if (!jiraReady(s.jira)) throw new Error("Set the Jira URL and token first");
  const me = await jiraRequest(s.jira, "myself");
  const name = isObj(me) ? str(me.displayName) || str(me.emailAddress) || str(me.name) : "";
  return `Connected to Jira${name ? ` as ${name}` : ""}`;
}
export async function testLinear(s: TrackerSettings): Promise<string> {
  if (!linearReady(s.linear)) throw new Error("Set the Linear API key first");
  const data = linearData(await linearRequest(s.linear, "query { viewer { name email } }"));
  const v = isObj(data.viewer) ? data.viewer : {};
  return `Connected to Linear${str(v.name) ? ` as ${str(v.name)}` : ""}`;
}
