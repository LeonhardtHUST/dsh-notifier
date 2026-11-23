# test/host — disposable DSH 0.2.2-rc.5 test harness

Reusable infrastructure for driving the **installed** DSH 0.2.2-rc.5 host
against a throwaway `DSH_HOME`. It backs the rc.5 host-smoke evidence.

Nothing here is a product file. `test/host/**` is deliberately **outside** the
`npm test` glob (`test/*.test.mjs`), so it never runs as part of the unit suite.
Run it explicitly.

## Quick start

```powershell
node test/host/harness.smoke.mjs
```

Exit code is `0` on PASS and non-zero on FAIL. On the Windows Desktop install the
harness finds the host from `DSH_INSTALL_DIR` / `DSH_NODE_EXECUTABLE`; both may be
set explicitly for another install:

```powershell
$env:DSH_INSTALL_DIR = 'C:\...\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh'
$env:DSH_NODE_EXECUTABLE = 'C:\...\DeepSeek Harness.exe'
```

## Host-rc5 vs provider-live (read this first)

| Tier | What it is | In scope? |
|---|---|---|
| **host-rc5** | The installed DSH 0.2.2-rc.5 CLI composing the real Cordis tree, with our plugin activated in a disposable profile. External I/O stays **local/controlled** (loopback HTTP receiver). | **Yes — this harness.** |
| **provider-live** | A real IM/provider account or device receiving an actual push. | **No.** Out of scope; never claim it passed. |

Everything this harness proves is host-level (activation, tool/service wiring, the
authenticated Native route, outbound delivery to a local webhook). It says nothing
about a real provider.

## Why the Electron runtime

The Desktop CLI lives inside `app.asar`, which plain Node cannot read. The harness
therefore boots `DSH_NODE_EXECUTABLE` with `ELECTRON_RUN_AS_NODE=1` (the Electron
runtime is ASAR-aware); it never resolves a Node from `PATH`.

## Profile-bundle path

`dsh plugin --profile <name> add` forwards to pnpm, which is not guaranteed here.
The harness instead writes the host's own profile layout:

```
<home>/profiles/<profile>/package.json   → dsh.profile.bundles: [<base…>, <bundle row name>]
<home>/profiles/<profile>/node_modules/<bundle row name>/   → plugin payload
<home>/profiles/<profile>/cordis.patch.yml                  → profile patch layer
```

The bundle row name is read from the plugin's own `cordis.patch.yml` insert row
(`name:`), so the scoped `@leonhardthust/dsh-notifier` identity resolves without
editing `package.json.name`. The app-boot preflight reads this path manifest
directly, so the compatibility gate is exercised identically.

## Environment / paths

- **Scratch root** (the only place homes may be created):
  `%TEMP%\dsh-notifier-rc3-scratch\` (override with `DSH_NOTIFIER_HOST_SCRATCH`).
  Homes are named `dshhome-<name>`; every write helper refuses paths outside it.
- **Real DSH homes** (`%USERPROFILE%\.dsh`, `$HOME/.dsh`) are sacred.
  `never-touch-real-profile.md` documents the guard.
- Booting sets a **minimal allowlisted env** (OS plumbing, `DSH_HOME`,
  `NO_COLOR`, `FORCE_COLOR`, `ELECTRON_RUN_AS_NODE`); the parent environment is not
  forwarded wholesale, so no secrets leak into the child.
- Every boot has a bounded timeout and a Windows tree kill; a failed smoke cannot
  leave an orphan process.

## API (`test/host/harness.mjs`)

| Helper | Purpose |
|---|---|
| `makeDisposableDshHome(name)` | Create `scratch/dshhome-<name>` (guarded). Returns `{ home, name, cleanup }`. |
| `installPluginIntoProfile({home, profile, bundles, …})` | Write the profile dir + plugin node_modules + `cordis.patch.yml` via the profile-bundle path. `bundles` = the base bundles **without** the plugin; the install path comes from the bundle patch row. |
| `installProbeIntoProfile({home, profile, probeDir})` | Add a separate probe bundle alongside the plugin. |
| `dumpConfig({home, profile})` | Run `dsh --profile <p> --dump-config` through the ASAR-aware runtime. |
| `bootProfile({home, profile, args, timeoutMs})` | Spawn the CLI with `DSH_HOME=<home>`, bounded timeout, guaranteed kill. Returns `{ stdout, stderr, waitFor, result, stop, output }`. |
| `startLocalReceiver(opts)` | Loopback HTTP server recording `{method, path, headers, body}`. |
| `readPluginState(dir)` | Read `<dir>/state.json` if present. **Never writes.** |

## What the smoke proves

`harness.smoke.mjs`:
- **real Cordis EventContext** — `event-context.smoke.mjs` is invoked by the smoke
  through the same host runtime: it imports the installed `@deepseek-ai/cordis`,
  and proves the lifecycle-listener wrapper returns thenables, keeps synchronous
  side effects synchronous, survives a legacy `.catch` host, contains a rejecting
  listener, and that the conversation lifecycle listeners follow the same contract.
- **A. web** — installs the plugin into a `web` profile (`dsh-base` + `dsh-web-app`),
  runs `--dump-config` (must compose the `dsh-notifier` row, no "skipping"),
  boots it on `--port 0 --no-open`, asserts the plugin log line and the advertised
  URL, then POSTs to `/dsh-notifier/smoke-probe` and requires the Connection
  admission to answer `401`/`403` — evidence that the Native route is mounted
  behind host admission, not that an authenticated call succeeded.
- **B. headless** — installs the plugin into a `headless` profile
  (`dsh-base` + `dsh-headless`, which composes **neither** `connection` nor
  `webServer`) with a webhook channel pointed at the local receiver, plus the
  probe bundle. Boots it and asserts: the plugin activates
  (`已启用渠道：webhook`), there is **no** PENDING / waiting-for-services line,
  the probe sees `ctx.notifier` present with the `notify` tool registered, its
  `push()` returns `ok:true`, and the receiver logged a real `POST /hook`.

## Known limitations

- **No LLM key** → headless exits non-zero with `MISSING_CREDENTIAL` **after** the
  plugin has activated and delivered; that exit code is expected, not a plugin
  failure. No full agent turn is driven.
- The web client bundle is served by the host, but no browser is driven; rendered
  slots/themes are not re-verified here.
- Everything under the scratch root is disposable and is **not** committed.
