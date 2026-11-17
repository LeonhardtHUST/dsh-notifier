# Workstream: rc3 host

- Agent identity: `rc3-host | deepseek-flash | Windows DSH Desktop 0.2.2-rc.3`
- Agent: `rc3-host`
- Branch: `codex/rc3-scoped-release` (shared topic; lead coordinates commits/push)
- Status: `done` (code+tests+smoke complete; commit/push deferred to lead's serial slot)
- Start/end: `2026-11-17 -> 2026-11-17`
- Scope: certify the installed DSH `0.2.2-rc.3` host surface used by this plugin, declare exactly that range, and repair the `connection`/lifecycle-listener compatibility findings (#49/#51 plus the #46 side observation) without claiming unverified hosts.
- Plan:
  1. Read the installed rc.3 upgrade index and only the guides that can change a surface this plugin uses; record used/skipped guides with reasons.
  2. Verify every host contract the plugin actually calls against installed rc.3 sources.
  3. Set the declared range to the exact verified version and tie `engines.dsh` into the mechanical guard. Never touch `name`/`version`.
  4. Fix the #46-adjacent lifecycle-listener defect without moving synchronous side effects into a microtask.
  5. Rebuild `test/host` for rc.3 on this Windows/ASAR install.
  6. Run one disposable headless boot and one disposable web boot; never boot the daily profile, never call a real provider.
  7. Focused tests, neat-freak self-check, report evidence and gaps.
- Owned files: `package.json` (compatibility fields only; handed to lead), `src/index.mjs` (verified, unchanged), `src/host-events.mjs`, `src/inbound/conversation.mjs`, `scripts/verify-host-compat.mjs`, `docs/compatibility-matrix.md`, `test/host-compat-matrix.test.mjs`, `test/host-lifecycle-listener.test.mjs`, `test/host/**`, `test/wiring.route.test.mjs` (lead-approved stateDir isolation), this workstream.
- Do not touch: `name`/`version`/scoped release metadata (lead), adapters, CI/workflows, `CHANGELOG.md`, `HANDOFF.md`, `README*`, `docs/memory/**`, another agent's workstream file.

## Confirmed rc.3 contracts (installed source)

- `@deepseek-ai/dsh` 0.2.2-rc.3; `@deepseek-ai/cordis` 4.1.0 (`on` options `global`/`prepend`, `waterfall`, `inject`, `provide`, `effect`).
- Preflight: own `engines.dsh` decides alone, peers ignored, prereleases included (`@deepseek-ai/dsh-app-boot/lib/index.js:1099-1148`); a mismatched profile bundle is skipped (`:1800-1826`).
- Profile layout/templates: `$DSH_HOME/profiles/<name>`, `dsh.profile.bundles`, installation-first then profile resolution (`app-boot:1306-1332,1780-1826`); `web` = base+web-app, `headless` = base+headless (`dsh-official-bundles/lib/index.js:4-10`).
- `ctx.tools.register(definition)` requires `output { schema, render }` (`dsh-tools:433-445`).
- `session/event` = `(session, event)` with per-listener `Promise.resolve(returned)` containment (`dsh-session:1275-1284,1598-1608`); `agent/created` serial / `agent/disposed` emit use `{ agent }` (`dsh-agent:673-714`).
- `ctx.agents.list/get` exist; **no `roots()` in rc.3** (package-wide search) → the plugin's existing root-only filter degrades to all-agent tracking.
- `approval/request` and `user-questions/request` are waterfalls (`dsh-user-approval:201`; `dsh-user-questions:447-538,675-718`); rc.3 `userQuestions` has `ask()` but no `registerProvider()` — the plugin's waterfall interceptor is the live seam.
- `ctx.connection.admit` = `{peer}|{rejection}` (`dsh-client-connection:709-750`); `connection.rpc.handle` still uses the service's own ctx (`:724-730,855-871`), so the webServer fallback remains the working route.
- `ctx.webServer.register({kind,path,handler})` (`dsh-host-webserver:334-382`); `attachments.saveFile` (`dsh-attachment-local:1045`).
- Client: `dsh.client.platform/inject` + `exports["./client"]` (`dsh-client-modules:78-93,789-792`); graph entry id = package name (`:956` + `graphRow`) and the bundle must register that same id (`lib/client.js` `arrive`); all six declared client packages and the four slot ids exist at rc.3.

## Upgrade guides read/skipped

Starting line `0.2.1-rc.5` → target `0.2.2-rc.3`; installed index dirs in span:
`v0.2.2-alpha.2`, `v0.2.2-alpha.3`, `v0.2.2-rc.1`.

- Read: v0.2.2-alpha.2 (client menus/loader/projections/schedule/LLM/search/Forge — all skipped: no menus, loader entry trees, projections, or those APIs); v0.2.2-alpha.3 (chat ProcessActivity/office/subagent names — skipped: no consumers); v0.2.2-rc.1 (attachment codes/account/Forge/BundleInfo/runtime-context/Session.append/subagent interrupt/terminal/window regions — skipped: none used; attachment failures are handled by shape/code defensively).
- Guides at or below `v0.2.1-rc.4` are earlier than the starting line; their surfaces were re-checked directly against rc.3 instead of read as migration steps.
- No selected guide required a code/config change.

## Implemented

- `package.json`: `engines.dsh=0.2.2-rc.3`, optional `@deepseek-ai/dsh-session` peer `0.2.2-rc.3`, `@deepseek-ai/cordis` peer `~4.1.0`, `dshWorkshop.compatibility.dshVersions=["0.2.2-rc.3"]`; `name`/`version` untouched (lead owns scoped metadata, committed separately).
- `scripts/verify-host-compat.mjs`: `engines.dsh` now checked for exact/OR-exact versions, covered/uncovered matrix rows, and equality with the peer range; guard output prints both.
- `docs/compatibility-matrix.md`: rc.3 row now **host smoke verified** (host seams) with a contract table, upgrade-guide review, smoke evidence, and honest limits; rc.5/0.1.0-rc.6 marked unverified; machine block updated.
- `src/host-events.mjs`: wrapper runs the listener synchronously then returns `Promise.resolve(returned).catch(report)`; sync throw → reported + resolved promise. No microtask deferral, no unhandled rejection.
- `src/inbound/conversation.mjs`: direct `agent/created` / `agent/disposed` listeners keep synchronous effects and return `Promise.resolve()`.
- `test/wiring.route.test.mjs`: the one `apply()` without a stateDir now uses a temp dir (no real `~/.dsh` write).

## Validation evidence

- `node --check src/index.mjs src/host-events.mjs src/inbound/conversation.mjs` — pass.
- `node scripts/verify-host-compat.mjs` → `engines.dsh=0.2.2-rc.3, peer 0.2.2-rc.3`.
- `node --import ./test/_hermetic-network-guard.mjs --test test/host-compat-matrix.test.mjs test/host-lifecycle-listener.test.mjs test/conversation.test.mjs test/index.test.mjs test/wiring.route.test.mjs` → **86/86 pass**, 0 fail.
- `node test/host/harness.smoke.mjs` (installed rc.3, disposable DSH_HOME) → **19/19 PASS**:
  web dump-config composes the scoped bundle row with no skip; web boots on `--port 0`; `/dsh-notifier/*` POST → `401 unauthorized` (mounted behind Connection admission); headless composes no connection/webServer, activates `已启用渠道：webhook` with no PENDING, probe sees `ctx.notifier` + notify tool, `push():ok:true`, receiver gets real `POST /hook`; headless exits 1 `MISSING_CREDENTIAL` after activation (no key, no provider turn).
- Real Cordis EventContext via the host runtime (`test/host/event-context.smoke.mjs`, 9/9): thenable returns, synchronous listener body, legacy `.catch` host safe, rejecting listener contained, conversation lifecycle listeners thenable.

## Gaps / risks

- Browser rendering is not driven: slot rendering/themes and browser-side `__ModuleLoader__.load` execution are not re-verified; client graph-id/package-name alignment and the `arrive` contract are source-verified only.
- No real provider/device was contacted; provider-level evidence remains in `docs/memory/risks.md`.
- `ctx.agents.roots()` is absent in rc.3; subagent filtering falls back to all-agent tracking (existing defensive behavior, not new).
- Stale rc.5 references remain in lead/neat-freak-owned docs (`docs/KNOWLEDGE_BASE.md:15`, `docs/upgrade-guide*.md`, `docs/OPERATIONS.md`, `docs/memory/{project-state,risks}.md`, `CHANGELOG.md`, `HANDOFF.md`) — reported for the lead's docs consolidation, not edited here.
- Smoke starts no background job; every booted child was bounded and stopped/cleaned in the same run (no job ids to collect).

## Adversarial review (self)

- Guard drift: engines/peer/workshop/matrix disagreements now fail the guard; verified by new drift tests.
- Static inject: a regression test asserts `['tools','agents']` and that connection/webServer stay inside `ctx.inject`.
- Listener contract: unit test covers sync ordering, throw, rejection containment and legacy `.catch`; the real-Cordis smoke re-proves it on the host runtime.
- Isolation: harness refuses `~/.dsh` and any path outside the scratch root; the smoke's web/headless homes were removed in `finally`; no real profile was touched.
- Scoped identity: harness installs under the bundle-patch row name (scoped) and accepts any package name, so the final package identity is exercised without editing `package.json.name`.

## Handoff

Code/tests/smoke are complete and committed as `31d3a5d` on
`codex/rc3-scoped-release` (host source/tests/scripts/matrix/workstream; no
`package.json`, no `client.js`, no `test/client-module`). `package.json`
compatibility fields were handed to lead for the scoped/release metadata commit.
No push was performed by this worker; the git-index slot is released after the
commit report.

## Final review revision (2026-11-17)

- Commit-hash correction: this workstream previously named the pre-amend commit
  `49a1f76`; the actual committed host revision is `31d3a5d` (the amend only
  added this handoff record).
- Host-test copy filter: `test/host/harness.mjs` now refuses sensitive paths
  (`.env`, `.env.*`, `.npmrc`, `.yarnrc`, `.pypirc`, `.netrc`,
  `.credentials`/`credentials`, `state.json`, `state/`, `.ssh/`, `.gnupg/`,
  `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `bootstrap-paircode.txt`) anywhere in a copied package payload. It rejects by
  path name only and never reads file contents. The guard also skips
  `node_modules`/`.git`/agent directories at any depth, not only at the top
  level. Covered by `test/host/harness.copy-filter.test.mjs`; no product source
  changed.

