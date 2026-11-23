# Optional SDK and DSH host compatibility matrix

Snapshot: 2026-11-23.

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
0.2.2-rc.5
```

`engines.dsh` decides alone in the rc.5 preflight
(`@deepseek-ai/dsh-app-boot/lib/index.js:1099-1107`): once a plugin declares its
own `engines.dsh`, its `@deepseek-ai/dsh*` peers are ignored. Prereleases
participate in the range (`semver.satisfies(..., { includePrerelease: true })`,
`:1100`), and a single prerelease literal is an exact match, not a caret range.
Every host prerelease step therefore needs the manifest to move with it: an
incompatible bundle is skipped by the profile loader
(`:1800-1837`, `skippedBundles`), not activated and not reported as a crash.
The optional peer marker `@deepseek-ai/dsh-session` is declared at the same
line (`0.2.2-rc.5`), and `scripts/verify-host-compat.mjs` keeps
`engines.dsh`, the peer range, this matrix and
`dshWorkshop.compatibility.dshVersions` aligned.

| DSH | Core Session/Message seams | Native client dependency/slot seams | Native Control Surface evidence | Evidence level |
|---|---|---|---|---|
| `0.2.2-rc.5` | compatible with the rc.5 host contract set (tools/agents/session events/connection/webServer/attachments seams present; see the contract table below) | connection / locale / renderer / layout / sidebar / plugin-manager packages present at `0.2.2-rc.5`; global panel slots `main`, `sidebar.panellist`, `plugins.bundle.config`, `plugins.bundle.activation` exist; the client graph entry id equals the package name and `client.js` registers that same id | plugin activates in web + headless with no exemption; `dump-config` composes the row with no skip; the `/dsh-notifier` route is mounted behind Connection admission (401 without auth); headless activates with the notify tool + `ctx.notifier` and delivers a real local webhook POST | **host smoke verified** (19/19 on 2026-11-23; host seams; rendered UI not driven) |
| `0.2.2-rc.3` | previous line; every seam below was re-checked against the rc.5 sources, but the plugin was not re-certified in an rc.3 host after that | previous client package set; not re-certified | historical T02 evidence only (2026-11-17) | **unverified** |
| `0.2.1-rc.5` | older line; not re-certified | older client package set; not re-certified | historical T02 evidence only | **unverified** |
| `0.1.0-rc.6` | historical only | current Native surface not re-certified | old historical plugin verification only | **unverified** |

Peer range: `0.2.2-rc.5`.

No row is `real-device-verified`; provider/device evidence is scoped separately.
The `0.2.2-rc.3`, `0.2.1-*` and `0.1.7-*` families are no longer declared
targets; a future line needs its own verified matrix row and matching range.

### Host smoke evidence (2026-11-23)

`node test/host/harness.smoke.mjs` ran against the installed Desktop
`0.2.2-rc.5` (`@deepseek-ai/dsh` inside `app.asar`, Electron-as-node runtime)
with disposable `DSH_HOME` profiles. **19/19 checks passed**:

- **web**: `--dump-config` composed the `dsh-notifier` row with no skipped
  bundle, the web app booted on a random loopback port, the plugin logged its
  own activation line, and `POST /dsh-notifier/smoke-probe` returned
  `401 unauthorized` — the route is mounted and passes through Connection
  admission (no authenticated call is claimed).
- **headless**: the profile composed neither `connection` nor `webServer`,
  there was no PENDING/waiting-services line, `ctx.notifier` and the `notify`
  tool were visible to a probe bundle, `push()` returned `ok:true`, and the
  local receiver recorded a real `POST /hook`. The process then exited `1` with
  `MISSING_CREDENTIAL`; that is expected after activation because no LLM key is
  present and no provider turn was attempted.
- **real Cordis EventContext**: the host runtime ran the lifecycle-listener
  contract script (`test/host/event-context.smoke.mjs`, 9/9): wrapper/listener
  return values are thenables, synchronous side effects stay synchronous, a
  legacy `.catch` host does not crash, and a rejecting listener is contained.
- **manifest gate**: the same harness run first proved the gate itself. With the
  previous `engines.dsh: 0.2.2-rc.3` manifest the rc.5 host skipped the bundle
  with an exact-version incompatibility message; after the manifest moved to
  `0.2.2-rc.5` the same profile composed and activated the row. No host
  exemption was granted at any point.

Limitations recorded honestly: no browser is driven, so slot rendering/themes
and the browser-side `__ModuleLoader__.load` execution are **not** re-verified
here; the client graph id/package-name alignment and the `arrive` registration
contract are source-verified only. No real provider/device was contacted, and
the plugin's own loopback admin console was disabled in the disposable profiles.

### rc.5 contract evidence

Every row below was checked against the installed DSH `0.2.2-rc.5` package
sources (Desktop ASAR), not against another release:

| Contract actually used | rc.5 source evidence | Result |
|---|---|---|
| Host identity | `@deepseek-ai/dsh/package.json` name `@deepseek-ai/dsh`, version `0.2.2-rc.5`; `@deepseek-ai/cordis` `4.1.0` | matches the declared line |
| Plugin preflight | `@deepseek-ai/dsh-app-boot/lib/index.js:1099-1107` (`engines.dsh` alone; peers ignored at `:1109-1121`; prereleases included), `:1124-1148` (issue assembly) | exact `engines.dsh` accepted; a stale literal is skipped, not crashed |
| Profile bundles | `@deepseek-ai/dsh-app-boot/lib/index.js:1779-1785` (installation-then-profile resolution), `:1800-1837` (`loadProfileDirectory`, incompatible bundles collected as `skippedBundles`), `:1851-1861` (`loadProfile` + template init) | profile fixture recipe is valid |
| Profile templates | `@deepseek-ai/dsh-official-bundles/lib/index.js:4-9` (`web` = base + web-app, `headless` = base + headless; acp/sdk templates added) | headless has no `connection`/`webServer` |
| Static inject | `src/index.mjs` exports `inject = ['tools', 'agents']`; Native surface mounts through `ctx.inject(['connection', 'webServer'], …)`; `@deepseek-ai/cordis/lib/index.js:1672-1678,1707` | headless cannot go PENDING on `connection` (#49) |
| `ctx.tools.register` | `@deepseek-ai/dsh-tools/lib/index.js:433-445` (definition requires `output { schema, render }`; optional `presentationMeta`/`timeoutMs` are additive; returns the exact disposer) | notify/notify_test/ask_user definitions match |
| `ctx.agents.list/get` | `@deepseek-ai/dsh-agent/lib/index.js:720-729`; no `roots()` method exists in rc.5 (package-wide search) | task projection works; root-only filtering degrades to the documented all-agent fallback |
| `session/event` | `@deepseek-ai/dsh-session/lib/index.js:1275-1284` (per-listener containment via `Promise.resolve(returned)`), `:1592-1608` (`(session, event)` shape, isolated observers) | listener shape matches; non-Promise returns are tolerated |
| `agent/created`, `agent/disposed` | `@deepseek-ai/dsh-agent/lib/index.js:698-714` (serial creation, payload `{ agent, source, signal? }`), `:637-687` (`enter`/`detachEntered`/`emitDisposed` → `{ agent }`) | payload unwrapping matches; `source`/`signal` are additive |
| `agent/error` | `@deepseek-ai/dsh-agent/lib/index.js:358-388` (`{agent, turn, step, error}` payload fused with the agent subject); emitter `dsh-agent-loop/lib/index.js:657`; type `dsh-agent/src/runtime-types.ts:430` | listener shape matches |
| `approval/request` waterfall | `@deepseek-ai/dsh-user-approval/lib/index.js:201` (`ctx.waterfall(scopeTarget(...), 'approval/request', …)`); `OUTCOMES` `:30-35`; non-allowlisted answers normalize to `unavailable` | interceptor registration matches; `allowed-once`/`rejected` stay valid |
| `user-questions/request` waterfall | `@deepseek-ai/dsh-user-questions/lib/index.js:675-718` (`ask()` only; no `registerProvider()`; `:708-711` waterfall, `noAnswerer` → `NO_PROVIDER`); `:679` native caller assertion (`DELEGATED_CALLER`/`CALLER_NOT_LIVE`) | native bridge uses the waterfall seam and keeps the defensive fallback; delegated-caller questions are refused by the host before any answerer |
| `ctx.connection.admit` | `@deepseek-ai/dsh-client-connection/lib/index.js:742-750` (untrusted 403 / unauthenticated 401 / else `{ peer }`) | admission/401 contract matches |
| `ctx.connection.rpc.handle` | `@deepseek-ai/dsh-client-connection/lib/index.js:724-730` (owner context is the connection service's `ctx`), `:855-871` (`owner.webServer.register`) | the webServer mount remains the working seam for a third-party caller |
| `ctx.webServer.register` | `@deepseek-ai/dsh-host-webserver/lib/index.js:375-382` (service `webServer`; `register({kind, path, handler})`, duplicate kind/path throws), `:471` handler invocation, `:580-586` prefix match | prefix route + disposer contract matches |
| `attachments.saveFile` | `@deepseek-ai/dsh-attachment-local/lib/index.js:1045-1049` (`saveFile` → `saveFileVerbatim`, `{data, name?}` → `{attachmentId, name, bytes}`; `saveFileStream` is additive) | durable file admission boundary unchanged |
| Client manifest | `@deepseek-ai/dsh-client-modules/lib/index.js:78-93` (`dsh.client.platform/inject`, additive `external`/`immediately`), `:785-800` (`exports["./client"]` required), `:957` + `graphRow` (`entry id` = package name); `src/client/system.ts:209-225,377` (`arrive()` requires the loaded bundle to register that exact id) | `dsh.client` shape matches; the scoped client bundle registers the scoped package name; rendered browser execution is not re-verified |
| Client slots | `@deepseek-ai/dsh-client-ui-layout/src/client/index.ts:75,107` (`main`, `shell.overlay`), `@deepseek-ai/dsh-client-ui-sidebar/src/client/contract/slots.ts:47` (`sidebar.panellist`), `@deepseek-ai/dsh-client-ui-plugin-manager/src/client/slot-contract.ts:143,159` (`plugins.bundle.activation`, `plugins.bundle.config`) | registration names/`key`/`id` shapes match; rendered UI is not re-verified without browser control |
| Cordis feature surface | `@deepseek-ai/cordis/lib/index.js:903-918` (`waterfall`), `:951-959` (`on` options object), `:920` (`options.prepend`), `:834` (`options.global`), `:1672-1678` (`inject`) | option usage matches 4.1.0 |
| Client services | `slots` `dsh-client-ui-renderer/src/client/registry.ts:160`, `locale` `dsh-client-locale/src/client/index.ts:588`, `layout` `dsh-client-ui-layout/src/client/index.ts:191`, `connection` `dsh-client-connection/src/client/index.ts:336`, `uiWorkspace` `dsh-client-ui-workspace/src/client/navigation.ts:195` | every client service the bundle injects is present |
| Session event vocabulary | `@deepseek-ai/dsh-session/src/known-event-types.ts:22-86` (`turn/start`, `turn/end`, `approval/asked|decided`, `tool/call|result`, `todo/write`, `goal/change` all still listed); payload types `dsh-session/src/types.ts:294-303,369,383-393` | no event rename or removed field in the shapes this plugin consumes |

### Upgrade-guide review for this line

Starting line: `0.2.2-rc.3`; target: the installed `0.2.2-rc.5`. The installed
index (`docs/upgrade-guide/README.md`) has no section for leaving `0.2.2-rc.5`
(it is the newest release), so the span to review is two steps:

- `v0.2.2-rc.3` — **DeepSeek content refusal error code** (`MALFORMED_RESPONSE`
  → `CONTENT_REFUSED`) on LLM error finishes and `turn/end` errors. **Skipped**:
  this plugin does not classify LLM finish codes; it renders the host-provided
  `turn/end` reason and error text and never branches on those literals.
- `v0.2.2-rc.4` — **Search on DeepSeek models defaults to legacy Messages
  search**. **Skipped**: the plugin consumes no web search/fetch API and no
  search provider configuration.

No guide in the span required a code or configuration change for this plugin.
The comparisons above are rc.5 artifact against the recorded rc.3 shapes: the
machine holds only the rc.5 build, so a line-by-line rc.4 → rc.5 diff was not
possible. The additive differences found are recorded instead:
`agent/created` gained `source`/`signal`, approval answers outside the outcome
allowlist normalize to `unavailable`, `ask()` refuses delegated callers, and
`turn/end` gained a `forked` reason kind.

### Inbound file attachment boundary

File admission requires the Host AttachmentStore capability `attachments.saveFile`. A
legacy host that exposes the attachment service but not `saveFile` is outside the current
file-inbound support boundary: the plugin fails closed, does not pass a remote URL into the
Session, and emits a bounded diagnostic in both Chinese and English. The current supported
host matrix above is the `0.2.2-rc.5` line only.

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
    { "version": "0.2.2-rc.5", "status": "verified" },
    { "version": "0.2.2-rc.3", "status": "unverified", "tag": null },
    { "version": "0.2.1-rc.5", "status": "unverified", "tag": "dsh-v0.2.1-rc.5" },
    { "version": "0.1.0-rc.6", "status": "unverified", "tag": null }
  ]
}
```

### Connection transport note

The intended logical channel is `/dsh-notifier`.

rc.5 still scopes `ctx.connection.rpc.handle` to the connection service's own
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
`0.2.2-rc.5` in the installed host):

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
