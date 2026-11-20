# Roadmap

| Status | Feature | Date |
| :---: | :--- | :--- |
| [x] | Post comments, reviews and statuses as the GitHub App bot (installation tokens) instead of the operator's `gh` login | 2026-11-20 |
| [x] | Review strictness profile per repository (chill / balanced / assertive: findings budget, self-check threshold, model instructions) and a minimum severity for posted comments | 2026-11-20 |
| [x] | Path filters, path instructions and auto-review skip rules (drafts, authors, base branches, title keywords, labels) per repository, overridable by `.codeotter.json` on the base branch | 2026-11-20 |
| [x] | Custom pre-merge checks per repository: yes/no questions (off / warn / block) asked of System One with the built-in gates, or of the language model without it; shown on the review page and PR comments; `codeotter/checks` commit status | 2026-11-20 |
| [x] | Conversational replies under CodeOtter's inline comments (GitHub, GitLab, Forgejo, Gitea): the language model answers trusted replies in the thread; `@codeotter remember <rule>` saves a team learning, dismissals are offered one. Bitbucket and Azure DevOps threads not yet; installs that receive events only through the CodeOtter GitHub Action get no replies until the Action forwards `pull_request_review_comment` | 2026-11-20 |
| [x] | Resolve fixed comments: CodeOtter's inline comments a later push fixed (model-confirmed) are resolved on GitHub, GitLab, Bitbucket Cloud/Data Center and Azure DevOps, or answered on Forgejo/Gitea; per-repository setting. Stub-tested | 2026-11-20 |
| [x] | Fix with AI: a self-contained prompt per finding and for all findings (copy on the review page; collapsed "Prompt for AI agents" in posted comments, per-repository setting) and the `/fix [n]` comment command, which posts a model patch as committable suggestions only after it applies to the PR head; nothing is pushed | 2026-11-20 |
| [x] | Jira and Linear tickets as linked issues: keys from the PR title, branch and description (configured project / team keys, Linear URLs), title, description and acceptance criteria in the prompt and the `issue_requirements` gate; Settings → System → Issue trackers | 2026-11-20 |
| [x] | Static analysis evidence: gitleaks, Semgrep and Trivy on a PR's changed files (PATH or pinned, checksum-verified download under Settings → System → Analyzers), results on changed lines given to the language model to confirm or reject, secrets redacted, per-repository opt-in | 2026-11-20 |
| [x] | Analytics: per-review tokens, estimated cost, duration, findings by severity, gates and suggestion outcomes (posted, applied, dismissed); report per period, repository and organization, developer-scoped | 2026-11-20 |
| [x] | Enterprise SSO: generic OpenID Connect sign-in (Okta, Entra ID, Google Workspace, Keycloak, Authentik, JumpCloud) on PocketBase's `oidc2` slot; invites by verified email in allowed domains, optional auto-admit and Require SSO. Stub-tested; not yet run against a live IdP | 2026-11-20 |
| [x] | Audit log: sign-ins, accounts, invites, settings and provider changes (secrets masked), repositories, posted reviews, comment commands and local models; owner-only page under Settings → Workspace with filters and CSV export; kept for 10,000 entries / 180 days | 2026-11-20 |
| [x] | GitLab repositories, gitlab.com or self-managed (nested groups; merge request reviews, inline suggestions, statuses including `codeotter/checks`, PR tools, comment commands, replies in diff discussions, resolving fixed discussions, project hooks) and GitLab sign-in. Stub-tested; not yet run against a live server | 2026-11-20 |
| [x] | Backend in one module per subsystem; HTTP on Hono with one route module per area and route-level access middleware | 2026-11-07 |
| [x] | Backend, CLI and tests in strict TypeScript, run by Node type stripping with no build step | 2026-11-08 |
| [x] | Bitbucket Cloud, Bitbucket Data Center and Azure DevOps repositories (reviews, inline comments, statuses, PR tools, comment commands, webhooks / service hooks) alongside GitHub, Forgejo and Gitea; sign-in with Bitbucket and Microsoft Entra ID. Stub-tested; not yet run against live servers | 2026-11-07 |
| [x] | Developer role, per-account repository access and invites (uninvited sign-ins refused) | 2026-10-13 |
| [x] | Auto-review: new and updated pull requests reviewed and posted without a command; CI on every PR; async gh; /healthz | 2026-10-09 |
| [x] | Repository TUI in the existing CLI, sharing web storage and engines without a web server; organization tree and automatic missing reviews | 2026-10-09 |
| [x] | Live score/summary previews, formatted details, folder walkthroughs, copying, PR links and Review/Changes tabs using Delta | 2026-10-09 |
| [x] | Branded favicon header, focus-aware selection, structured skeletons, compact layouts and keyboard navigation | 2026-10-09 |
| [x] | Independent local PocketBase lifetime, read recovery and CLI/TUI regression tests | 2026-10-09 |
| [x] | Lightweight workspace TUI: diff sources, reviews, Ask and draft tools, cancellation, history and JSON export | 2026-10-08 |
| [x] | Cloudflare Clef (`cloudflare/clef`, `cloudflare/clef-flash`) as a hosted System One provider via OpenRouter | 2026-10-08 |
| [x] | Accepted fixes: suggestions authors applied are remembered per repository and guide later reviews (PR-Agent-inspired) | 2026-10-04 |
| [x] | PR comment commands: /review, /describe, /improve, /ask, /docs, /changelog (PR-Agent-inspired) | 2026-10-04 |
| [x] | PR events and comment commands via webhooks (GitHub App manifest with `hook_attributes`, Forgejo/Gitea repository hooks), one review queue with retries, catch-up poll, failed-delivery redelivery after restart, `gh webhook forward` for localhost | 2026-11-01 |
| [x] | Docs and Changelog tools (PR-Agent-inspired) | 2026-10-04 |
| [x] | Improve: ranked, self-checked code suggestions posted as multi-line committable suggestions (PR-Agent-inspired) | 2026-10-04 |
| [x] | Ask: free-form questions about a PR (PR-Agent-inspired) | 2026-10-04 |
| [x] | Tools card + Describe (title, type, summary, file changes; apply to PR description) (PR-Agent-inspired) | 2026-10-04 |
| [x] | Self-check: second model pass scores findings 0-10 and drops weak ones (PR-Agent-inspired) | 2026-10-04 |
| [x] | Large-PR diff compression: ranked files, partial hunks, deletions and left-out files named (PR-Agent-inspired) | 2026-10-04 |
| [x] | Dynamic context: hunks extend to the enclosing declaration, trailing context cut to one line (first PR-Agent-inspired step) | 2026-10-04 |
| [x] | Website and docs at codeotter.io | 2026-10-04 |
| [x] | Kev 4B local System One model in the catalog; llama.cpp b11388 | 2026-10-04 |
| [x] | One-click deploy: `install.sh` for any VPS (Caddy HTTPS with a domain), Deploy to Azure and Render buttons, Linode StackScript | 2026-10-02 |
| [ ] | Linode: publish `bin/deploy/linode-stackscript.sh` as a public StackScript (cloud.linode.com/stackscripts/create) and add its button | |
| [ ] | Railway: template from `ghcr.io/dharmeshgurnani/codeotter` with a volume at `/app/pb_data` and a generated `PB_ADMIN_PASSWORD`; add the `railway.com/deploy/...` button | |
| [ ] | AWS: CloudFormation template (EC2 + `install.sh` user data) hosted in S3 for a Launch Stack button | |
| [ ] | DigitalOcean and Vultr: apply as marketplace vendors for 1-Click apps | |
| [x] | GitHub Marketplace: CodeOtter Review action ([codeotter-action](https://github.com/marketplace/actions/codeotter-review)) | 2026-11-08 |
| [ ] | Coolify and Dokploy: submit one-click templates | |
| [x] | Automatic Docker updates: release tags publish a multi-arch image to GHCR, Compose runs Watchtower, sidebar shows a newer release to admins | 2026-10-02 |
| [x] | Fast triage: System One rates correctness risk and blast radius of each new or updated PR from a whole-change digest, sets the `codeotter/triage` commit status and an updatable PR comment, polled every 2 minutes; GitHub Actions wait job in the [CI triage docs](https://docs.codeotter.io/docs/ci-triage) | 2026-10-02 |
| [ ] | Validate System One triage on past pull requests with known outcomes and set the default stop threshold from the results | |
| [x] | Full-Stack Setup & Onboarding Wizard (first-time deployment detection, primary Git/OAuth provider selection for GitHub/Forgejo/Gitea, dual-engine AI model configuration with non-blocking local background downloads, multi-org searchable repository onboarding, and direct dashboard landing) | 2026-10-01 |
| [x] | Native CodeOtter CLI & CI Review Engine (`bin/codeotter.mjs`, `codeotter review`, `codeotter pr`, `codeotter ci --fail-on-gate`, `codeotter mcp` stdio server, multi-agent critique pass, rich ANSI terminal scorecard) | 2026-10-01 |
| [x] | Forgejo repositories + OAuth alongside GitHub: implemented; isolated integration tests, production build and browser checks pass. User authorized the Gitea follow-up | 2026-09-30 |
| [x] | Gitea repositories + OAuth alongside GitHub and Forgejo: isolated integration tests, production build and browser checks pass | 2026-09-30 |
| [x] | "Smart Context" Outside-Diff Call Graph Impact Slicing & Blast Radius Fan-Out (AST symbol extraction, zero-dependency git/repo caller trace, contract safety verification, outside callers in Blast Radius and Mermaid graph, and prompt caching optimization) | 2026-09-30 |
| [x] | Inline Line-Level `suggestion` Fixes & One-Click Apply / GitHub Review Sync (`line` & `suggestion` finding schema, deterministic `deriveSuggestionFromDetail`, interactive `Suggested Fix` cards with 1-click Copy fix, `POST /api/review-suggestions` inline PR review thread sync, and per-repo `postInlineSuggestions` setting) | 2026-09-29 |
| [x] | Incremental Commit-by-Commit Delta Reviews (`headSha` tracking, `prevSha → headSha` commit compare diff, resolved findings tracking, and in-place GitHub PR comment upsert via `<!-- codeotter:scores -->` / `<!-- codeotter:review -->`) | 2026-09-29 |
| [x] | Repo "Learnings" (1-click dismiss finding to persistent per-repository team rule, injected into LLM & System 1 prompts and editable in Settings → Repositories) | 2026-09-29 |
| [x] | Linked Issue & Requirement Validation (`Closes #123` acceptance criteria in LLM prompt, System 1 `issue_requirements` merge gate, and PR badges) | 2026-09-29 |
| [x] | Architecture & Blast Radius Mermaid Diagram (`flowchart LR` SVG graph in review terminal and GitHub PR comments) | 2026-09-29 |
| [x] | Hugging Face model & provider icons in selection lists and local model rows | 2026-09-29 |
| [x] | Cinematic CodeOtter product film with camera rails, layered UI, fictional data and reproducible Flute rendering | 2026-09-28 |
| [x] | Post scores on PR (`gh pr comment` with System One scores and merge gates) | 2026-09-28 |
| [x] | Add PR review as a comment (`gh pr comment` with review summary and link to full platform report) | 2026-09-28 |
