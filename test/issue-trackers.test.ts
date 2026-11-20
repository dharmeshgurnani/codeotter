// Jira and Linear tickets as linked issues (core/trackers.ts): key detection, ADF to text, both fetchers, the settings
// page, and that credentials only ever go to the configured Jira server or Linear's API. fetch is stubbed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("issue trackers", async (ctx) => {
  const home = mkdtempSync(join(tmpdir(), "codeotter-trackers-"));
  Object.assign(process.env, { CODEOTTER_HOME: home, PATH: dirname(process.execPath), CODEOTTER_UPDATE_CHECK: "0" });
  delete process.env.PB_URL;
  const realFetch = globalThis.fetch;
  type Sent = { url: string; auth: string; redirect?: RequestInit["redirect"]; body?: string };
  let sent: Sent[] = [];
  let reply: (url: string, body: string | undefined) => Response = (url) => { throw new Error(`unexpected fetch ${url}`); };
  globalThis.fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    sent.push({ url: String(url), auth: String((init.headers as Record<string, string> | undefined)?.authorization || ""), redirect: init.redirect, body });
    return reply(String(url), body);
  };
  ctx.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

  const { ticketRefs, adfToText, fetchJiraTicket, fetchLinearTicket, linkedTickets, clearTicketCache, trackerKeys, jiraBase } = await import("../core/trackers.ts");
  const { fetchLinkedIssues, issueLabel } = await import("../core/context.ts");
  const { SETTINGS_PAGES } = await import("../core/settings-pages.ts");
  const { store } = await import("../core/store.ts");

  const jira = { url: "https://acme.atlassian.net", email: "dev@acme.test", token: "jira-secret", projects: ["ABC", "OPS"] };
  const linear = { apiKey: "lin_api_secret", teams: ["ENG"] };
  const s = { jira, linear };

  // Detection: only configured keys, never UTF-8, SHA-256, ISO-8601 or other dash-number words.
  assert.deepEqual(ticketRefs({ title: "ABC-123: fix login", body: "Uses UTF-8 and SHA-256 per ISO-8601, see RFC-7231 and COVID-19." }, s), [{ tracker: "jira", key: "ABC-123" }]);
  assert.deepEqual(ticketRefs({ title: "Use UTF-8 everywhere", body: "SHA-256 digests, x86-64 builds, GPT-4 notes" }, s), []);
  assert.deepEqual(ticketRefs({ headRefName: "feature/abc-42-login" }, s), [{ tracker: "jira", key: "ABC-42" }]);
  assert.deepEqual(ticketRefs({ headRefName: "dharmesh/eng-7-cache" }, s), [{ tracker: "linear", key: "ENG-7" }]);
  // prose needs the upper-case key; part of a longer word or a leading zero does not count
  assert.deepEqual(ticketRefs({ title: "abc-123 ZABC-1 ABC-0123 ABC-12x" }, s), []);
  assert.deepEqual(ticketRefs({ body: "Closes https://linear.app/acme/issue/DES-9/new-header" }, s), [{ tracker: "linear", key: "DES-9" }]);
  assert.deepEqual(ticketRefs({ title: "ABC-1 ABC-1 OPS-2 ENG-3 ABC-4" }, s).map((r) => r.key), ["ABC-1", "OPS-2", "ENG-3"]);
  // nothing configured: nothing detected, even a Linear URL
  assert.deepEqual(ticketRefs({ title: "ABC-1", body: "https://linear.app/acme/issue/ENG-1" }, {}), []);
  // keys listed without a connection do not count
  assert.deepEqual(ticketRefs({ title: "ABC-1" }, { jira: { projects: ["ABC"] } }), []);
  assert.deepEqual(trackerKeys("abc, Ops  eng"), ["ABC", "OPS", "ENG"]);
  assert.throws(() => trackerKeys("A"), /Not a project or team key/);
  assert.throws(() => trackerKeys("AB-1"), /Not a project or team key/);
  assert.equal(jiraBase("https://jira.acme.test/jira/"), "https://jira.acme.test/jira");
  assert.throws(() => jiraBase("https://user:pw@jira.acme.test"), /without credentials/);
  assert.throws(() => jiraBase("ftp://jira.acme.test"), /HTTP\(S\)/);
  ctx.diagnostic("ticket keys match configured projects and teams only; no false hits on UTF-8, SHA-256 and similar");

  // ADF (Jira Cloud rich text) to plain text.
  const adf = { type: "doc", version: 1, content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
    { type: "paragraph", content: [{ type: "text", text: "Users sign in with " }, { type: "text", text: "SSO", marks: [{ type: "strong" }] }, { type: "hardBreak" }, { type: "mention", attrs: { text: "@Ana" } }] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Redirects to the IdP" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Rejects expired tokens" }] }] },
    ] },
    { type: "codeBlock", content: [{ type: "text", text: "login()" }] },
    { type: "unknownBlock", content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }] },
  ] };
  assert.equal(adfToText(adf), "Goal\nUsers sign in with SSO\n@Ana\n- Redirects to the IdP\n- Rejects expired tokens\n```\nlogin()\n```\nkept");
  assert.equal(adfToText(null), "");
  assert.equal(adfToText({ type: "text", text: 5 }), "");
  ctx.diagnostic("ADF converts to text: headings, paragraphs, lists, mentions, code; malformed nodes are empty");

  // Jira Cloud: Basic email:token on REST v3, acceptance criteria found by field name, no redirects followed.
  reply = (url) => (url.startsWith("https://acme.atlassian.net/rest/api/3/issue/ABC-123?")
    ? json({ key: "ABC-123", names: { summary: "Summary", customfield_10035: "Acceptance Criteria" }, fields: { summary: "SSO login", description: adf, status: { name: "In Progress" }, labels: ["auth", 7], customfield_10035: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Given SSO, user lands on home" }] }] } } })
    : new Response("no", { status: 404 }));
  const t = await fetchJiraTicket(jira, "ABC-123");
  assert.ok(t);
  assert.equal(t.key, "ABC-123");
  assert.equal(t.number, 123);
  assert.equal(t.repo, "jira");
  assert.equal(t.title, "SSO login");
  assert.equal(t.state, "IN PROGRESS");
  assert.equal(t.url, "https://acme.atlassian.net/browse/ABC-123");
  assert.deepEqual(t.labels, ["auth"]);
  assert.match(t.body, /^Acceptance criteria:\nGiven SSO, user lands on home\n\nGoal\n/);
  assert.equal(issueLabel(t), "ABC-123");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].auth, `Basic ${Buffer.from("dev@acme.test:jira-secret").toString("base64")}`);
  assert.equal(sent[0].redirect, "manual");
  // Data Center: no email, a personal access token as Bearer on REST v2, wiki-markup description as is.
  sent = [];
  reply = (url) => (url.startsWith("https://jira.acme.test/jira/rest/api/2/issue/OPS-9?") ? json({ key: "OPS-9", fields: { summary: "Rotate keys", description: "h2. Steps\n* rotate" } }) : new Response("no", { status: 404 }));
  const dc = await fetchJiraTicket({ url: "https://jira.acme.test/jira", token: "pat", projects: ["OPS"] }, "OPS-9");
  assert.equal(dc?.body, "h2. Steps\n* rotate");
  assert.equal(dc?.state, "OPEN");
  assert.equal(sent[0].auth, "Bearer pat");
  // a redirect is refused, never followed with the token
  reply = () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } });
  await assert.rejects(fetchJiraTicket(jira, "ABC-1"), /redirect/);
  // a malformed key never reaches the server
  sent = [];
  assert.equal(await fetchJiraTicket(jira, "ABC-1/../../x"), null);
  assert.equal(sent.length, 0);
  ctx.diagnostic("Jira Cloud and Data Center fetchers: auth scheme, API version, criteria field, redirects refused");

  // Linear: API key as the Authorization header on api.linear.app GraphQL; criteria from the description's section.
  sent = [];
  reply = (url, body) => {
    assert.equal(url, "https://api.linear.app/graphql");
    assert.deepEqual(JSON.parse(String(body)).variables, { id: "ENG-7" });
    return json({ data: { issue: { identifier: "ENG-7", title: "Cache tokens", description: "Why\n\n## Acceptance criteria\n- cached 5 min\n- cleared on logout\n\n## Notes\nnone", url: "https://linear.app/acme/issue/ENG-7/cache-tokens", state: { name: "Todo" }, labels: { nodes: [{ name: "backend" }, null] } } } });
  };
  const l = await fetchLinearTicket(linear, "ENG-7");
  assert.equal(l?.key, "ENG-7");
  assert.equal(l?.repo, "linear");
  assert.equal(l?.state, "TODO");
  assert.equal(l?.url, "https://linear.app/acme/issue/ENG-7/cache-tokens");
  assert.deepEqual(l?.labels, ["backend"]);
  assert.match(String(l?.body), /^Acceptance criteria:\n- cached 5 min\n- cleared on logout\n\nWhy/);
  assert.equal(sent[0].auth, "lin_api_secret");
  assert.equal(sent[0].redirect, "manual");
  reply = () => json({ data: { issue: { identifier: "ENG-8", title: "x", url: "https://evil.test/ENG-8" } } });
  assert.equal((await fetchLinearTicket(linear, "ENG-8"))?.url, "", "a non-Linear URL from the API is dropped");
  reply = () => json({ errors: [{ message: "Entity not found" }] });
  await assert.rejects(fetchLinearTicket(linear, "ENG-9"), /Entity not found/);
  ctx.diagnostic("Linear fetcher: GraphQL with the API key, criteria section, errors surfaced");

  // linkedTickets: credentials go only to the configured Jira origin and Linear's API, whatever URLs the PR names.
  // Results are cached briefly; a ticket that fails is left out.
  clearTicketCache();
  sent = [];
  reply = (url) => {
    if (url.startsWith("https://acme.atlassian.net/rest/api/3/issue/ABC-5?")) return json({ key: "ABC-5", fields: { summary: "Five" } });
    if (url === "https://api.linear.app/graphql") return json({ data: { issue: { identifier: "ENG-6", title: "Six", url: "https://linear.app/acme/issue/ENG-6" } } });
    return new Response("missing", { status: 404 });
  };
  const pr = { title: "ABC-5 and ENG-6", headRefName: "abc-404-gone", body: "See https://evil.test/browse/ABC-5 and https://evil.test/rest/api/3/issue/OPS-1" };
  const got = await linkedTickets(pr, s);
  assert.deepEqual(got.map(issueLabel), ["ABC-5", "ENG-6"]);
  assert.ok(sent.length >= 3);
  for (const r of sent) assert.ok(r.url.startsWith("https://acme.atlassian.net/rest/api/") || r.url === "https://api.linear.app/graphql", `credentials sent to ${r.url}`);
  const before = sent.length;
  await linkedTickets(pr, s);
  assert.equal(sent.length, before, "tickets come from the cache on the next review");
  ctx.diagnostic("credentials only reach the configured Jira server and api.linear.app; tickets cached");

  // Settings → System → Issue trackers: a Provider · Server · Status table, tokens masked, saved through the row.
  const page = SETTINGS_PAGES.trackers;
  assert.equal(page.group, "admin");
  assert.equal(page.access, "admin");
  await page.save({ trackers: { rows: [{ id: "jira", edited: true, settings: { values: { url: "https://acme.atlassian.net/", email: "dev@acme.test", token: "jira-secret-9876", projects: "abc, ops" } } }] } });
  await page.save({ linear: { apiKey: "lin_api_key_1234", teams: "eng" } });
  const saved = await store.getSetting("issueTrackers");
  assert.deepEqual(saved, { jira: { url: "https://acme.atlassian.net", email: "dev@acme.test", token: "jira-secret-9876", projects: ["ABC", "OPS"] }, linear: { apiKey: "lin_api_key_1234", teams: ["ENG"] } });
  const loaded = JSON.stringify(await page.load());
  assert.ok(!loaded.includes("jira-secret-9876") && !loaded.includes("lin_api_key_1234"), "tokens are never sent back to the browser");
  assert.ok(loaded.includes("9876") && loaded.includes('"Status"'));
  // a blank token keeps the saved one; a new server needs a new token
  await page.save({ jira: { url: "https://acme.atlassian.net", email: "dev@acme.test", token: "", projects: "ABC" } });
  assert.equal((await store.getSetting("issueTrackers"))?.jira?.token, "jira-secret-9876");
  await assert.rejects(page.save({ jira: { url: "https://other.atlassian.net", token: "" } }), /new Jira URL/);
  await assert.rejects(page.save({ jira: { url: "https://acme.atlassian.net", projects: "UTF-8" } }), /Not a project/);
  // Test actions call the configured tracker only
  sent = [];
  reply = (url) => (url === "https://acme.atlassian.net/rest/api/3/myself" ? json({ displayName: "Dev" }) : url === "https://api.linear.app/graphql" ? json({ data: { viewer: { name: "Lin" } } }) : new Response("no", { status: 404 }));
  const http = { setCookie() {} };
  assert.deepEqual(await page.actions?.testjira({}, http), { message: "Connected to Jira as Dev" });
  assert.deepEqual(await page.actions?.testlinear({}, http), { message: "Connected to Linear as Lin" });
  await page.save({ linear: { clear: true } });
  assert.equal((await store.getSetting("issueTrackers"))?.linear, undefined);
  ctx.diagnostic("Issue trackers page: saves through the table row, masks tokens, Test actions, clear");

  // fetchLinkedIssues merges the saved trackers' tickets with forge issues (none here: no #refs).
  reply = (url) => (url.startsWith("https://acme.atlassian.net/rest/api/3/issue/ABC-3?") ? json({ key: "ABC-3", fields: { summary: "Three" } }) : new Response("no", { status: 404 }));
  const linked = await fetchLinkedIssues("acme/api", { number: 1, title: "ABC-3: tidy", body: "", headRefName: "main" });
  assert.deepEqual(linked.map((i) => [i.key, i.title]), [["ABC-3", "Three"]]);
  ctx.diagnostic("saved trackers feed the linked-issue path");
});
