# Project state

## Current state type:state

- 2026-11-18: `@leonhardthust/dsh-notifier@0.14.1` is published as npm latest. Immutable tag `v0.14.1` points at `58507ac1e295165c02ba73caa83b6da47a20806e`; GitHub Release exists. Source commits: `dc7106c` (desktop), `d788898` (Native), `9819e90` (usage docs), `58507ac` (release).
- The Native panel owns a bounded scroller, and separates Desktop notifications from Remote channels. `local.get`/`local.save` reuse canonical outbound state and transactions; YAML management, runtime activation and desired state remain separate facts.
- Windows 10/11 use native WinRT Toast through Windows PowerShell 5.1 with no BurntToast dependency or registry mutation. Linux uses notify-send then gdbus; GNOME and KDE are the intended desktops, other environments are best effort.
- DSH requirement remains exact `0.2.2-rc.3`; Node `>=22`, ESM, zero mandatory runtime dependencies, no build step. There are 28 outbound adapters (including two local ones) and six inbound control transports.
- Development goes through fork `dev`; releases go through fork `main`. Always use `gh -R LeonhardtHUST/dsh-notifier` because bare gh currently resolves to upstream. Never push to `THEWOLFWALKER/dsh-notifier`.

## Validation type:progress

- Final complete suite passed 2137/2137 on 2026-11-18 (0 fail, 0 skip). The payload guard found 322 files with no development/tool directories. Release, host, matrix and syntax checks passed.
- Windows 11 26H2: real Toast send, DSH AUMID attribution, literal malicious text, silent audio XML, empty-text and maximum-length PowerShell scripts were verified. First-send delay from Get-StartApps was removed; Start-menu shortcut existence is cached per resolved config instead.
- Real Chromium host-geometry reproduction: old content could not scroll; new viewport was 565px high with 1532px content and scrollTop advanced to 400. The authenticated installed Desktop UI was not driven end to end.
- Independent Sol static review closed empty base64, zero-option YAML, revoke/startup snapshot resurrection, strict state reads, switch guards and public diagnostic leakage. Linux has contract-only evidence, not a desktop-device run.
- The first OIDC/provenance release succeeded for `0.14.1` through `release.yml` / `npm-release`. CI run `44129363178` passed Ubuntu/macOS Node 22. Release run `44130646586` succeeded after rerunning only its failed post-publish verification job once npm processing completed; no duplicate publish or retag.
- Registry tarball: 322 files, shasum `216dbdf0af21cf047a6e81d057e4f18c46e437c3`, integrity `sha512-Y+Zzn6489Wh0ymOfRtF4sVtRYwjL0yQK848M6KEInI9bZ+kh8z8vWXhw36GAqIiOQrNFbWAtL6JHwXEAkLcxcg==`. A downloaded registry archive matched integrity, imported the plugin/local modules, and contained version 0.14.1 / test count 2137 with no agent-tool directories. The SLSA subject and source commit match the release.

## Durable boundaries

- State files contain credentials and bindings; use store transactions/locking and never hand-edit a live file. Canonical UI state is `channel:<type>:outbound`.
- Inbound identity is composite and source-bound. Unknown/missing source, expired token, timeout and callback failures remain fail-closed. No approval/question logic was changed by this release.
- Desktop ask_user settlement has no safe host API; do not claim dual-end parity. NotifyIcon fallback cannot enforce mute. Provider limits, rendering and reconnect behavior need real-device evidence.
- Source/tests are runtime authority; package.json is version authority. Historical release details remain in CHANGELOG and immutable tags, not in this compact snapshot.

## Next step type:goal

Upgrade the actual Desktop profile through the plugin manager, restart once, then test Desktop notifications and the long Remote channels setup page. Do not restart the active agent session automatically. Linux GNOME/KDE and authenticated Native end-to-end verification remain the next device checks.
