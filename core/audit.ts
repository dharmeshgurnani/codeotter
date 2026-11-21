// Audit log: an append-only record of security- and configuration-relevant events (sign-in, accounts, invites, settings,
// providers, repositories, posted reviews, comment commands, local models). Secret values never reach it: a settings save
// is recorded as the fields it sent, and a field named like a secret, token, key, password or PEM is stored as a mask.
// Who did it comes from the request (gate() runs the route inside withActor) or from the caller (auto-review, commands).
import { AsyncLocalStorage } from "node:async_hooks";
import { AUDIT_DAYS, AUDIT_MAX } from "./config.ts";
import { auditStore, PB_URL, store } from "./store.ts";
import type { AuditEntry, AuditQuery } from "./store.ts";
import type { Body, Field, PageData, Row, SettingsPage } from "./settings-pages.ts";
import type { CellObject, Tone } from "./views.ts";

export interface Actor { id: string; name: string }
export const SYSTEM: Actor = { id: "system", name: "system" };
export const AUTO: Actor = { id: "auto", name: "auto" };
const SPECIAL_ACTORS: Actor[] = [AUTO, SYSTEM, { id: "anonymous-bootstrap", name: "anonymous-bootstrap" }, { id: "recovery", name: "recovery" }, { id: "anonymous", name: "anonymous (refused sign-in)" }];
export const AUDIT_ACTIONS = [
  "signin.success", "signin.refused", "account.update", "invite.add", "invite.remove",
  "repository.add", "repository.remove", "repositories.update", "repository-settings.update",
  "model-provider.update", "git-provider.update", "git-provider.app", "auth-provider.update", "webhook-secret.update",
  "local-model.download", "local-model.use", "local-model.delete", "analyzer.download", "analyzer.delete",
  "issue-tracker.update", "settings.update", "review.post", "command.run", "pr-tool.run", "fix.stacked",
] as const;

// <audit-actor>
const actors = new AsyncLocalStorage<Actor>();
export const withActor = <T>(actor: Actor, fn: () => T): T => actors.run(actor, fn);
export const currentActor = (fallback: Actor = SYSTEM): Actor => actors.getStore() || fallback;
// A gate()-allowed viewer as an actor: the account, else the anonymous owner of bootstrap or PR_SCORER_RECOVERY=1.
export const actorOf = (user: { id: string; name: string } | null | undefined): Actor =>
  user ? { id: user.id, name: user.name } : process.env.PR_SCORER_RECOVERY === "1" ? { id: "recovery", name: "recovery" } : { id: "anonymous-bootstrap", name: "anonymous-bootstrap" };
// </audit-actor>
// The organization of a repository id (owner, or <prefix>~owner); "" for instance-wide events.
export const orgOfRepo = (repo: string) => (repo.includes("/") ? repo.split("/")[0] : "");

// <audit-mask>
export const MASK = "••••";
const SECRET_KEY = /secret|token|passw|pem|key/i;
// Echoed back by settings dialogs, never set by the user.
const NOISE_KEY = /^(webhookUrl|webhookStatus|forwardStatus|forwardStatusText|callback|llmStatus|status|noGuides|edited|loaded\w*)$/;
type Scalar = string | number | boolean;
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function flatten(x: unknown, path: string, out: Record<string, Scalar>) {
  const key = path.split(".").pop() || "";
  if (NOISE_KEY.test(key) || x === undefined || x === null || x === "") return;
  if (SECRET_KEY.test(key) && typeof x !== "boolean") { out[path] = MASK; return; }
  if (Array.isArray(x)) {
    const ids = x.map((v) => (isObj(v) ? v.id : v));
    out[path] = ids.every((v) => ["string", "number", "boolean"].includes(typeof v)) ? clip(ids.map(String).join(", ")) : `${x.length} items`;
    return;
  }
  if (isObj(x)) { for (const [k, v] of Object.entries(x)) flatten(v, path ? `${path}.${k}` : k, out); return; }
  out[path] = typeof x === "string" ? clip(x) : typeof x === "number" || typeof x === "boolean" ? x : clip(String(x));
}
// What a settings save sent, as "section.field" -> value, secrets masked and blanks ("keep the stored value") left out.
// A table posts every row with the edited one marked: only that row counts, as "section.row.field".
export function settingsChanges(body: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [section, v] of Object.entries(body)) {
    if (isObj(v) && Array.isArray(v.rows)) {
      for (const row of v.rows.filter((r): r is Record<string, unknown> => isObj(r) && !!r.edited)) {
        const id = String(row.id);
        if (typeof row.toggle === "boolean") out[`${section}.${id}.enabled`] = row.toggle;
        flatten(isObj(row.settings) ? row.settings.values : undefined, `${section}.${id}`, out);
      }
      continue;
    }
    flatten(v, section, out);
  }
  return out;
}
// </audit-mask>

let appended = 0;
// Never throws: a failed audit write is logged and the audited operation goes on.
export async function audit(actor: Actor | null, action: string, target: string, detail: Record<string, unknown> = {}, org = ""): Promise<void> {
  const a = actor || currentActor();
  const entry: AuditEntry = { at: new Date().toISOString(), actor: a.id, actorName: clip(a.name, 120), action, target: clip(String(target), 300), org, detail };
  try {
    await auditStore.add(entry);
    if (appended++ % 200 === 0) await trimAudit();
  } catch (e) {
    console.warn(`[audit] ${action} ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
// Retention: the newest `max` entries, none older than `days`.
export const trimAudit = ({ max = AUDIT_MAX, days = AUDIT_DAYS, now = Date.now() } = {}) => auditStore.trim(max, new Date(now - days * 86400000).toISOString());

// Settings route hooks: one entry per save or row action, named by page.
const PAGE_ACTION: Record<string, string> = { repos: "repositories.update", repo: "repository-settings.update", model: "model-provider.update", git: "git-provider.update", oauth: "auth-provider.update", accounts: "account.update", trackers: "issue-tracker.update" };
const ROW_ACTION: Record<string, string> = { download: "local-model.download", use: "local-model.use", delete: "local-model.delete", uninvite: "invite.remove" };
const PAGE_ROW_ACTION: Record<string, Record<string, string>> = { analyzers: { download: "analyzer.download", delete: "analyzer.delete" } };
export async function auditSettings(page: string, body: Record<string, unknown>, scope: { org?: string; repo?: string }) {
  if (page === "audit") return;
  const fields = settingsChanges(body);
  const edited = Object.values(body).flatMap((v) => (isObj(v) && Array.isArray(v.rows) ? v.rows.filter((r) => isObj(r) && r.edited).map((r) => String(r.id)) : []))[0];
  const invite = page === "accounts" && isObj(body.invite);
  const action = invite ? "invite.add" : PAGE_ACTION[page] || "settings.update";
  const target = invite && isObj(body.invite) ? String(body.invite.login || "") : edited || scope.repo || page;
  const org = scope.repo ? orgOfRepo(scope.repo) : page === "repos" ? scope.org || "" : "";
  await audit(null, action, target, { page, fields }, org);
  if (Object.keys(fields).some((k) => /webhookSecret$/.test(k))) await audit(null, "webhook-secret.update", target, { page }, org);
}
export async function auditAction(page: string, id: string, body: Record<string, unknown>) {
  // tests change nothing; connect only starts the GitHub App flow, whose callback is audited
  if (id === "test" || id === "probe" || id === "connect" || id.startsWith("test")) return;
  const app = page === "git" && id.startsWith("app");
  const action = PAGE_ROW_ACTION[page]?.[id] || ROW_ACTION[id] || (app ? "git-provider.app" : `settings.${page}.${id}`);
  await audit(null, action, app ? id.slice(3) : body.item ? String(body.item) : page, { page });
}
export async function auditRepos(before: string[], after: string[]) {
  for (const r of after.filter((x) => !before.includes(x))) await audit(null, "repository.add", r, {}, orgOfRepo(r));
  for (const r of before.filter((x) => !after.includes(x))) await audit(null, "repository.remove", r, {}, orgOfRepo(r));
}

// <audit-csv>
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // a leading = + - @ would run as a formula in a spreadsheet
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
const detailText = (d: Record<string, unknown>) => {
  const fields = isObj(d.fields) ? d.fields : {};
  const rest = Object.entries(d).filter(([k]) => k !== "fields" && k !== "page");
  return [...Object.entries(fields), ...rest].map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
};
export function auditCsv(items: AuditEntry[]): string {
  const head = ["time", "actor_id", "actor", "action", "target", "org", "detail"];
  return [head, ...items.map((e) => [e.at, e.actor, e.actorName, e.action, e.target, e.org, detailText(e.detail)])].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
// </audit-csv>
const ACTOR_RE = /^[\w.:@~-]{1,120}$/;
export const auditFilter = (q: { action?: unknown; actor?: unknown; org?: string }) => ({
  action: AUDIT_ACTIONS.find((a) => a === q.action) || "",
  actor: typeof q.actor === "string" && ACTOR_RE.test(q.actor) ? q.actor : "",
  org: q.org || "",
});
export async function exportAudit(q: Omit<AuditQuery, "page" | "perPage">): Promise<string> {
  const items: AuditEntry[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await auditStore.list({ ...q, page, perPage: 500 });
    items.push(...r.items);
    if (items.length >= r.total || !r.items.length) break;
  }
  return auditCsv(items);
}

// Settings → Workspace → Audit log (owner): filters, then the entries, newest first. Apply posts the filter section; the
// page loads with it (the settings route hands the posted body to load()), so nothing about the view is stored.
const PER_PAGE = 50;
const TONE: Record<string, Tone> = { "signin.refused": "bad", "signin.success": "ok", "review.post": "info", "command.run": "info", "fix.stacked": "info" };
const when = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
async function actorOptions() {
  const users = PB_URL ? await store.users().catch(() => []) : [];
  return [
    { value: "", label: "All actors" },
    ...users.map((u) => ({ value: u.id, label: u.name || u.username || u.email?.split("@")[0] || u.id })),
    ...SPECIAL_ACTORS.map((a) => ({ value: a.id, label: a.name })),
  ];
}
export const auditPage: SettingsPage = {
  title: "Audit log",
  group: "workspace",
  access: "owner",
  async load({ org = "" } = {}, _user, view: Body = {}): Promise<PageData> {
    const f = isObj(view.filter) ? view.filter : {};
    const q = auditFilter({ action: f.action, actor: f.actor, org });
    let page = Math.max(1, Math.floor(Number(f.page) || 1));
    let r = await auditStore.list({ ...q, page, perPage: PER_PAGE });
    const pages = Math.max(1, Math.ceil(r.total / PER_PAGE));
    if (page > pages) { page = pages; r = await auditStore.list({ ...q, page, perPage: PER_PAGE }); }
    const csv = `/api/audit/export?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`;
    const fields: Field[] = [
      { key: "action", label: "Action", type: "select", options: [{ value: "", label: "All actions" }, ...AUDIT_ACTIONS.map((a) => ({ value: a, label: a }))] },
      { key: "actor", label: "Actor", type: "select", options: await actorOptions() },
      { key: "page", label: "Page", type: "select", options: Array.from({ length: pages }, (_, i) => ({ value: i + 1, label: `${i + 1} of ${pages}` })) },
      { key: "export", label: "Export", type: "readonly", link: { label: "Download CSV", url: csv } },
    ];
    const rows: Row[] = r.items.map((e, i) => ({
      id: `${e.at}:${i}`,
      label: e.action,
      cells: {
        at: { text: when(e.at), mono: true },
        actor: e.actorName || e.actor,
        action: { text: e.action, tone: TONE[e.action] || "muted" } satisfies CellObject,
        target: e.target ? { text: e.target, mono: true } : "",
        detail: clip(detailText(e.detail), 200),
      },
    }));
    return {
      sections: [
        { id: "filter", title: "Filter", fields, actions: [{ id: "save", label: "Apply" }] },
        { id: "entries", title: "Entries", fields: [{ key: "rows", label: "Entries", type: "table", columns: [{ key: "at", label: "Time (UTC)" }, { key: "actor", label: "Actor" }, { key: "action", label: "Action" }, { key: "target", label: "Target" }, { key: "detail", label: "Detail" }] }] },
      ],
      values: { filter: { action: q.action, actor: q.actor, page, export: `${r.total} entries` }, entries: { rows } },
    };
  },
  async save() {},
};
