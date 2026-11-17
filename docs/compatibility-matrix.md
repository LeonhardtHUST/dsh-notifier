# Optional SDK and DSH host compatibility matrix

Snapshot: 2026-11-17.

This document separates three evidence levels:

- **contract/source verified** — repository seams and official source/artifact shape match;
- **host smoke verified** — the plugin was booted in that DSH release and the relevant host/client seam responded;
- **real-provider/device verified** — an external provider/device flow was exercised end to end.

Do not collapse these into one “supported” claim.

## Optional SDK / legacy compatibility

| Surface | Optional dependency | Supported seam | Missing/old shape | Lifecycle evidence | Capability status |
|---|---|---|---|---|---|
| Feishu QR login | `@larksuiteoapi/node-sdk` `>=1.61.1` | lazy `registerApp`; named/default export variants | normalized `missing-sdk` guidance | timeout/denied/expired/malformed/partial persistence guarded | contract-tested; provider validation scoped separately |
| QQ QR login | `@tencent-connect/qqbot-connector` `^1.2.0` | lazy `startQrConnect`; named/default export variants | incompatible export/result fails safely | timeout/SDK error/invalid credential list guarded | contract-tested; provider validation scoped separately |
| Feishu inbound WS | `@larksuiteoapi/node-sdk` | lazy `Client`/`WSClient`/`EventDispatcher`; isolated bounded HTTP instance | missing/incomplete SDK reports unavailable | idempotent start/stop, bounded transport, SDK-owned reconnect | contract-tested; long-connection real validation still external |
| QQ inbound gateway | none | native fetch + WebSocket implementation | transport errors isolated | heartbeat/reconnect/stop/restart covered by tests | contract-tested; gateway/device validation still external |
| QR terminal rendering | `qrcode-terminal` | login CLI convenience | absence does not affect credential result | callback failures absorbed | optional convenience |

Legacy YAML `inbound.allowUsers` remains a one-time migration input. Runtime membership is managed by pairing/admin APIs.

WxPusher inbound has a local `accountId` (default `default` when omitted). Multiple apps should use distinct explicit `accountId` values; channel names are never used as account IDs.

No optional SDK is a production runtime dependency.

## DSH host compatibility matrix

Declared host requirement (`engines.dsh`):

```text
0.2.2-rc.3
```

`engines.dsh` decides alone in the rc.3 preflight
(`@deepseek-ai/dsh-app-boot/lib/index.js:1102-1120`): once a plugin declares its
own `engines.dsh`, its `@deepseek-ai/dsh*` peers are ignored. Prereleases
participate in the range (`semver.satisfies(..., { includePrerelease: true })`,
`:1099-1101`), so an exact prerelease string is required for the current line.
The optional peer marker `@deepseek-ai/dsh-session` is declared at the same
line (`0.2.2-rc.3`), and `scripts/verify-host-compat.mjs` keeps
`engines.dsh`, the peer range, this matrix and
`dshWorkshop.compatibility.dshVersions` aligned. A mismatched bundle row is
skipped by the profile loader (`:1800-1826`), not silently activated.

| DSH | Core Session/Message seams | Native client dependency/slot seams | Native Control Surface evidence | Evidence level |
|---|---|---|---|---|
| `0.2.2-rc.3` | compatible with the rc.3 host contract set (tools/agents/session events/connection/webServer/attachments seams present; see the contract table below) | connection / locale / renderer / layout / sidebar / plugin-manager packages present at `0.2.2-rc.3`; global panel slots `main`, `sidebar.panellist`, `plugins.bundle.config`, `plugins.bundle.activation` exist; the client graph entry id equals the package name and `client.js` registers that same id | plugin activates in web + headless with no exemption; `dump-config` composes the row with no skip; the `/dsh-notifier` route is mounted behind Connection admission (401 without auth); headless activates with the notify tool + `ctx.notifier` and delivers a real local webhook POST | **host smoke verified** (host seams; rendered UI not driven) |
| `0.2.1-rc.5` | previous line; not re-certified after the rc.3 seams were re-checked | previous client package set; not re-certified | historical T02 evidence only | **unverified** |
| `0.1.0-rc.6` | historical only | current Native surface not re-certified | old historical plugin verification only | **unverified** |

Peer range: `0.2.2-rc.3`.

No row is `real-device-verified`; provider/device evidence is scoped separately.
The `0.1.7-*` and `0.2.1-*` families are no longer declared targets; a future
line needs its own verified matrix row and matching range.

### Host smoke evidence (2026-11-17)

`node test/host/harness.smoke.mjs` ran against the installed Desktop
`0.2.2-rc.3` (`@deepseek-ai/dsh` inside `app.asar`, Electron-as-node runtime) with
disposable `DSH_HOME` profiles. **19/19 checks passed**:

- **web**: `--dump-config` composed the `dsh-notifier` row with no skipped bundle,
  the web app booted on a random loopback port, the plugin logged its own
  activation line, and `POST /dsh-notifier/smoke-probe` returned
  `401 unauthorized` — the route is mounted and passes through Connection
  admission (no authenticated call is claimed).
- **headless**: the profile composed neither `connection` nor `webServer`, there
  was no PENDING/waiting-services line, `ctx.notifier` and the `notify` tool were
  visible to a probe bundle, `push()` returned `ok:true`, and the local receiver
  recorded a real `POST /hook`. The process then exited `1` with
  `MISSING_CREDENTIAL`; that is expected after activation because no LLM key is
  present and no provider turn was attempted.
- **real Cordis EventContext**: the host runtime ran the lifecycle-listener
  contract script (`test/host/event-context.smoke.mjs`, 9/9): wrapper/listener
  return values are thenables, synchronous side effects stay synchronous, a
  legacy `.catch` host does not crash, and a rejecting listener is contained.

Limitations recorded honestly: no browser is driven, so slot rendering/themes
and the browser-side `__ModuleLoader__.load` execution are **not** re-verified
here; the client graph id/package-name alignment and the `arrive` registration
contract are source-verified only. No real provider/device was contacted, and the
plugin's own loopback admin console was disabled in the disposable profiles.

### rc.3 contract evidence

Every row below was checked against the installed DSH `0.2.2-rc.3` package
sources (Desktop ASAR), not against another release:

| Contract actually used | rc.3 source evidence | Result |
|---|---|---|
| Host identity | `@deepseek-ai/dsh/package.json` name `@deepseek-ai/dsh`, version `0.2.2-rc.3`; `@deepseek-ai/cordis` `4.1.0` | matches the declared line |
| Plugin preflight | `@deepseek-ai/dsh-app-boot/lib/index.js:1099-1148` (`engines.dsh` alone; peers ignored; prereleases included) | exact `engines.dsh` accepted |
| Profile bundles | `@deepseek-ai/dsh-app-boot/lib/index.js:1306-1332,1780-1826` (`$DSH_HOME/profiles/<name>`, ordered `dsh.profile.bundles`, installation-then-profile resolution, incompatible bundles skipped) | profile fixture recipe is valid |
| Profile templates | `@deepseek-ai/dsh-official-bundles/lib/index.js:4-10` (`web` = base + web-app, `headless` = base + headless) | headless has no `connection`/`webServer` |
| Static inject | `src/index.mjs` exports `inject = ['tools', 'agents']`; Native surface mounts through `ctx.inject(['connection', 'webServer'], …)` | headless cannot go PENDING on `connection` (#49) |
| `ctx.tools.register` | `@deepseek-ai/dsh-tools/lib/index.js:433-445` (definition requires `output { schema, render }`; returns the exact disposer) | notify/notify_test/ask_user definitions match |
| `ctx.agents.list/get` | `@deepseek-ai/dsh-agent/lib/index.js:720-729`; no `roots()` method exists in rc.3 (package-wide search) | task projection works; root-only filtering degrades to the documented all-agent fallback |
| `session/event` | `@deepseek-ai/dsh-session/lib/index.js:1275-1284,1598-1608` (`(session, event)`, per-listener containment via `Promise.resolve(returned)`) | listener shape matches; non-Promise returns are tolerated by rc.3 |
| `agent/created`, `agent/disposed` | `@deepseek-ai/dsh-agent/lib/index.js:673-714` (`{ agent }`, serial creation, contained disposal) | payload unwrapping matches; listener return hardening keeps old hosts safe (#46 side finding) |
| `agent/error` | `@deepseek-ai/dsh-agent/lib/index.js:358-388` (`{agent, turn, step, error}` payload fused with the agent subject) | listener shape matches |
| `approval/request` waterfall | `@deepseek-ai/dsh-user-approval/lib/index.js:201` (`ctx.waterfall(scopeTarget(...), 'approval/request', …)`) | interceptor registration matches |
| `user-questions/request` waterfall | `@deepseek-ai/dsh-user-questions/lib/index.js:447-538,675-718` (`ask()` only; no `registerProvider()`; waterfall is the answerer seam) | native bridge uses the waterfall seam and keeps the defensive fallback |
| `ctx.connection.admit` | `@deepseek-ai/dsh-client-connection/lib/index.js:709-750` (host half provides `connection`; `admit()` returns `{ peer }` or `{ rejection }`) | admission/401 contract matches |
| `ctx.connection.rpc.handle` | `@deepseek-ai/dsh-client-connection/lib/index.js:724-730,855-871` (owner context is the connection service's `ctx`, so `owner.webServer` is still unavailable to a third-party caller) | the webServer mount remains the working seam |
| `ctx.webServer.register` | `@deepseek-ai/dsh-host-webserver/lib/index.js:334-382` (service `webServer`; `register({kind, path, handler})`, duplicate kind/path throws) | prefix route + disposer contract matches |
| `attachments.saveFile` | `@deepseek-ai/dsh-attachment-local/lib/index.js:1045-1049` | durable file admission boundary unchanged |
| Client manifest | `@deepseek-ai/dsh-client-modules/lib/index.js:78-93,789-792` (`dsh.client.platform/inject`, `exports["./client"]` required) and `:956` + `graphRow` (`entry id` = package name; `lib/client.js` `arrive()` requires the loaded bundle to register that exact id) | `dsh.client` shape matches; the scoped client bundle registers the scoped package name; rendered browser execution is not re-verified |
| Client slots | `@deepseek-ai/dsh-client-ui-sidebar`, `@deepseek-ai/dsh-client-ui-plugin-manager` and `@deepseek-ai/dsh-cordis-client-runner` client bundles contain the four registered slot ids | registration names match; rendered UI is not re-verified without browser control |
| Cordis feature surface | `@deepseek-ai/cordis/lib/index.js:903,952-965,1672` (`on` options `prepend`/`global`, `waterfall`, `inject`) | option usage matches 4.1.0 |

### Upgrade-guide review for this line

Starting line: `0.2.1-rc.5`; target: the installed `0.2.2-rc.3`. The installed
index (`docs/upgrade-guide/README.md`) lists directories
`v0.2.2-alpha.2`, `v0.2.2-alpha.3`, and `v0.2.2-rc.1` for this span. Each was
checked against the surfaces above:

- `v0.2.2-alpha.2` — client context-menu types/icons, CSS-anchored menus, loader
  entry-tree commits, projection frames/snapshots, schedule/SDK/LLM/search and
  Forge changes. **Skipped**: this plugin registers no context menus, no Menu
  rectangles, no Loader entry trees, no projections, and consumes none of the
  LLM/search/schedule/Forge APIs.
- `v0.2.2-alpha.3` — chat `ProcessActivity`, office packages/tools, subagent
  name addressing. **Skipped**: no Office, no subagent-control tools, no
  `ProcessActivity` consumer.
- `v0.2.2-rc.1` — attachment error codes, account notification APIs, Forge
  snapshots/diffs, `BundleInfo.update`, runtime-context reminders,
  `Session.append` overloads, subagent interruption defaults, terminal bundle
  and window drag regions. **Skipped**: no account API, no Forge, no
  `Session.append` replacement, no `interrupt_agent`, no terminal/overlay
  client code. The attachment error-code change only affects the host's error
  typing; this plugin treats attachment failures by code/shape defensively.
- Guides for versions at or below `0.2.1-rc.4` are earlier than the starting
  line and were not re-read as migration steps; their host surfaces were
  re-checked directly in the installed rc.3 sources instead.

No guide in the selected span required a code or configuration change for this
plugin.

### Inbound file attachment boundary

File admission requires the Host AttachmentStore capability `attachments.saveFile`. A
legacy host that exposes the attachment service but not `saveFile` is outside the current
file-inbound support boundary: the plugin fails closed, does not pass a remote URL into the
Session, and emits a bounded diagnostic in both Chinese and English. The current supported
host matrix above is the `0.2.2-rc.3` line only.

The closed #36 follow-up now has one real QQ C2C file-download sample: the URL used
`grouptalk.c2c.qq.com`, returned HTTP 200 without redirect or authentication, used
`application/octet-stream`, and its declared `content-length` matched the downloaded bytes.
The sample had no usable `content-disposition` filename. This confirms the download-side
shape for that sample only; it does not certify all QQ payloads. QQ GROUP attachment
evidence remains unreachable under the existing upstream group-control deny policy, so
`fileInbound` remains disabled until a supported-host end-to-end image/file admission run
is available.

Machine-readable block (the source of truth for `scripts/verify-host-compat.mjs` and
`npm run verify:release`):

```json dsh-host-matrix
{
  "peerPackage": "@deepseek-ai/dsh-session",
  "runtimes": [
    { "version": "0.2.2-rc.3", "status": "verified", "tag": null },
    { "version": "0.2.1-rc.5", "status": "unverified", "tag": "dsh-v0.2.1-rc.5" },
    { "version": "0.1.0-rc.6", "status": "unverified", "tag": null }
  ]
}
```

### Connection transport note

The intended logical channel is `/dsh-notifier`.

rc.3 still scopes `ctx.connection.rpc.handle` to the connection service's own
context (`@deepseek-ai/dsh-client-connection/lib/index.js:724-730`), whose
`register()` dereferences `owner.webServer` (`:855-871`). A third-party caller
therefore cannot own that route. The host line uses a guarded fallback that
mounts the same authenticated request envelope on the Host web server seam,
applying Connection admission/trust rules. The Native mount lives in a child
fiber (`ctx.inject(['connection','webServer'], …)`) so headless/no-webServer
profiles degrade without crashing the notifier runtime.

This is a host-integration fact, not a reason to expose the loopback Admin API to Native.

### Client dependency set

The Native client metadata depends on these DSH client packages (all present at
`0.2.2-rc.3` in the installed host):

```text
@deepseek-ai/dsh-client-connection
@deepseek-ai/dsh-client-locale
@deepseek-ai/dsh-client-ui-renderer
@deepseek-ai/dsh-client-ui-layout
@deepseek-ai/dsh-client-ui-sidebar
@deepseek-ai/dsh-client-ui-plugin-manager
```

They are Host-provided client dependencies, not npm runtime dependencies of dsh-notifier.

## Provider/device scope

The host gate verifies DSH integration. It does **not** automatically certify every Telegram/Feishu/QQ/DingTalk/WeChat/WxPusher provider payload, button ACK, media limit or reconnect condition.

Standing provider-level gaps remain documented in `docs/memory/risks.md`.
