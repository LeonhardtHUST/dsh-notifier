# Workstream: dsh rc.5 host line and single-main branch consolidation

- Agent identity: `lead | DSH Agent Teams (three Flash workers, one Sol read-only reviewer) | Windows 11, DSH Desktop 0.2.2-rc.5`
- Agent: `lead`
- Branch: `main` (single long-lived branch after consolidation)
- Status: `done` (published as 0.15.1)
- Start/end: `2026-11-23 -> 2026-11-23`
- Scope: move the declared DSH host line from exact `0.2.2-rc.3` to exact `0.2.2-rc.5` with evidence, and converge the repository onto one `main` line with every other branch deleted.
- Plan:
  1. Confirm the installed host version and read only the upgrade guides in the rc.3 → rc.5 span.
  2. Re-check every host seam the plugin calls against the rc.5 sources; change code only if a seam moved.
  3. Move `engines.dsh`, the optional `@deepseek-ai/dsh-session` peer, `dshWorkshop.compatibility.dshVersions` and the host matrix together; keep the guard test in sync.
  4. Prove the gate with the disposable host smoke on rc.5, then run the full suite and every release guard.
  5. Consolidate branches onto `main`, archive divergent lines as tags, and rewrite the branch/release rules in the agent and ops docs.
- Owned files: `package.json` (compatibility + version), `docs/compatibility-matrix.md`, `CHANGELOG.md`, `HANDOFF.md`, `docs/memory/**`, `test/host-compat-matrix.test.mjs`, `test/host/README.md`, `scripts/verify-host-compat.mjs`, `scripts/upstream-sync.mjs`, `test/upstream-sync.test.mjs`, `test/v013-invariants.test.mjs`, `.github/workflows/ci.yml`, `src/admin/ui/markup.mjs` (version mark only), `test/public.test.mjs` (environment-dependent assertion), this workstream.
- Do not touch: adapters, control surface, inbound routers, `.agents/workstreams/*` owned by other agents.

## Host evidence (installed rc.5)

- `@deepseek-ai/dsh` `0.2.2-rc.5`, `@deepseek-ai/cordis` `4.1.0`.
- Preflight: own `engines.dsh` decides alone, peers ignored, prereleases included (`dsh-app-boot/lib/index.js:1099-1107,1124-1148`); a mismatched profile bundle is collected as `skippedBundles` (`:1800-1837`), never activated.
- All 22 recorded seams still match, including the additions that do not change plugin usage: `agent/created` `source`/`signal`, approval answers outside the allowlist normalizing to `unavailable`, `ask()` refusing delegated callers, `turn/end` gaining a `forked` reason.
- Upgrade span review: `v0.2.2-rc.3` (DeepSeek refusal code) and `v0.2.2-rc.4` (default web search provider) are both irrelevant to this plugin.
- Smoke: `node test/host/harness.smoke.mjs` 19/19 on rc.5, and the same harness first reproduced the skip with the stale rc.3 manifest.

## Review and revision

- The first full-suite run failed `test/public.test.mjs:543` because a real Windows toast made `delivered` include `desktop`; the same failure reproduces on a pristine `a457b41` checkout, so it is a pre-existing environment-dependent assertion, not a regression. Fixed by pinning the configured remote channel and leaving local OS channels to their own adapter tests.
- `docs/memory/decisions.md` still described `dev` as the development branch; updated with the single-main model.
- `scripts/upstream-sync.mjs` pinned `dev` as the sync target, so the workflow change alone would have failed at runtime; the script and its tests moved to `main` in the same change.

## Handoff

Branch `dev` and every `codex/*` branch were deleted locally and on `origin`; divergent history is preserved as `archive/v0.13.1-release`, `archive/core-distillation-v015`, `archive/thewolfwalker-patch-2`. `0.15.1` is published: tag `v0.15.1` at `8961617`, GitHub Release created, npm latest `0.15.1`, tarball 334 files with the local SHA-512. The OIDC publish itself succeeded on the first run; the post-publish registry check failed on propagation and passed on rerun, so no duplicate publish. Next step: install the npm artifact in a disposable profile and exercise the Native entry once.
