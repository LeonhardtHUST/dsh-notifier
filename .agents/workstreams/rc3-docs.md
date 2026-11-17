# Workstream: rc3 docs

- Agent identity: `rc3-host | deepseek-flash | Windows DSH Desktop 0.2.2-rc.3`
- Agent: `rc3-host`
- Branch: `codex/rc3-scoped-release` (shared topic; lead coordinates commits/push)
- Status: `done` (docs/sync complete; commit/push deferred to lead's serial slot)
- Start/end: `2026-11-17 -> 2026-11-17`
- Scope: sync the public usage docs/examples to the scoped fork identity and the exact DSH 0.2.2-rc.3 line, record the 0.14.0 state-namespace migration in user-facing upgrade steps, write the outbound immutable-config contract into `ADAPTER.md`, and run the neat-freak inventory across root docs/docs/memory without rewriting history.
- Plan:
  1. Enumerate every root markdown, `docs/*.md` and `docs/memory/*.md`; record the evaluated/changed/left-alone decision (table below).
  2. Read the scoped release facts before editing: package `@leonhardthust/dsh-notifier@0.14.0`, fork `LeonhardtHUST/dsh-notifier`, `engines.dsh=0.2.2-rc.3`, T03 state namespace and `pre-v0.14-legacy` backup behavior, and the outbound-fix contract.
  3. Update public install/diagnostics/troubleshooting/upgrade/operations/versioning docs.
  4. Update consumer docs (`PLUGINS*`, `examples/consumer-demo`) to scoped subpath imports and the rc.3 service-injection reality.
  5. Write the outbound contract into `ADAPTER.md`.
  6. Add the historical note to `docs/new-host/00-START-HERE.md` without changing `STATUS.json` or claiming T05–T29.
  7. Run humanizer over new prose, verify links/commands statically, record out-of-scope gaps, hand the commit list to lead.
- Owned files: `docs/AI_INSTALL*.md`, `docs/DIAGNOSTICS*.md`, `docs/guide*.md`, `docs/TROUBLESHOOTING*.md`, `docs/upgrade-guide*.md`, `docs/OPERATIONS.md`, `docs/VERSIONING.md`, `PLUGINS*.md`, `ADAPTER.md`, `examples/consumer-demo`, `docs/ROADMAP.md`, `docs/new-host/00-START-HERE.md`, this workstream.
- Do not touch: `README*`, `AGENTS.md`, `CHANGELOG.md`, `HANDOFF.md`, `docs/memory/**`, `docs/KNOWLEDGE_BASE.md`, `docs/FORK_RELEASE.md`, another agent's workstream.
- Validation: static grep for old unscoped install/subpath commands and old host range in owned docs; relative-link check on every edited file; link/command review against `package.json` exports; no full test suite (lead's serial slot).
- Neat-freak: skill read; inventory below; `CHANGELOG.md` (1616 lines) and `docs/repair-plan-v0.11.md` (3015 lines) are history files exempt from the 1500-line split rule with that reason.

## Neat-freak inventory (2026-11-17)

Scope from task-5: root markdown, `docs/*.md` (25 files), `docs/memory/*.md` (4 files), examples. The table groups by decision; every file was inspected against the scoped identity / DSH 0.2.2-rc.3 / 0.14.0 state migration.

### Changed (19 files)

`docs/AI_INSTALL.md`, `docs/AI_INSTALL.en.md`, `docs/DIAGNOSTICS.md`,
`docs/DIAGNOSTICS.en.md`, `docs/guide.md`, `docs/guide.en.md`,
`docs/TROUBLESHOOTING.md`, `docs/TROUBLESHOOTING.en.md`,
`docs/upgrade-guide.md`, `docs/upgrade-guide.en.md`, `docs/OPERATIONS.md`,
`docs/VERSIONING.md`, `PLUGINS.md`, `PLUGINS.en.md`, `ADAPTER.md`,
`docs/ROADMAP.md` (top archive note only), `docs/new-host/00-START-HERE.md`
(historical note only), `examples/consumer-demo/README.md`,
`examples/consumer-demo/src/index.mjs`.

### Reviewed, no change needed

| File | Reason |
|---|---|
| `docs/architecture.md` | Architecture/state flow still matches the code; host/package naming is not repeated there |
| `docs/architecture-roadmap.md` | Historical planning prose, no install command or version fact |
| `docs/BRAND.md` | Asset inventory only |
| `docs/SUPPORT.md`, `docs/SUPPORT.en.md` | Generic support pointers, no stale identity |
| `THIRD_PARTY_NOTICES.md` | Attribution/liscenses must stay historical and unchanged |
| `docs/TECHNICAL_DEBT.md` | Debt items still worded as forward-looking; no package/host claim to fix |
| `docs/RELAY_BOOTSTRAP_PROMPT.md` | Relay bootstrap prompt, not an install entry; unchanged by the scoped release |
| `docs/compatibility-matrix.md` | Already updated by the host task (rc.3 host-smoke verified); docs task only cross-links it |
| `docs/repair-plan-v0.11.md` | 3015-line historical repair plan; split would rewrite history, exempt |
| `docs/taskbook-v0.11.md` | Historical task book; left verbatim |
| `docs/new-host/**` (25 other files) | 2026-10-31 rc.5 taskpack archive; only the entry note changed, per task |

### Out of scope (lead/automation owned), reported not edited

| File | Finding |
|---|---|
| `README.md`, `README.zh-CN.md` | lead owns; scoped identity already being integrated there |
| `AGENTS.md`, `CLAUDE.md` | lead owns the rulebook |
| `CHANGELOG.md` | lead owns; 1616 lines of release history (exempt from split rule) |
| `HANDOFF.md` | lead consolidates the snapshot |
| `docs/KNOWLEDGE_BASE.md` | still says current line v0.13.1 and host target 0.2.1-rc.5 (lines 5,9,10,11,15) — needs lead/neat-freak update |
| `docs/memory/project-state.md` | still v0.13.1 + rc.5 + upstream single-repo model (lines 3,9,18,25,26,32) |
| `docs/memory/risks.md` | rc.5 alignment entry and v0.13.1 release entry remain; add rc.3/0.14 evidence in the lead's memory pass |
| `docs/memory/decisions.md` | lead is updating it; not touched here |
| `docs/FORK_RELEASE.md` | automation owns this file |

## Implemented

- Package identity everywhere in scope: `@leonhardthust/dsh-notifier`, fork repo `LeonhardtHUST/dsh-notifier`, upstream attribution retained; original package and fork must not coexist.
- Host facts: exact DSH `0.2.2-rc.3` (`engines.dsh`), older `0.2.1-*`/`0.1.7-*` unclaimed; no version exemption is shipped.
- 0.14.0 state migration in install/upgrade/troubleshooting/diagnostics/operations docs: back up `state.json`; old namespace is not authority; first write creates `state.json.pre-v0.14-legacy.<timestamp>`; re-pair and re-configure channels/credentials; never hand-edit state or fake `__schema`.
- Public subpaths in `PLUGINS*` and `examples/consumer-demo`: `@leonhardthust/dsh-notifier/testing`, `/types`, `/internal`; the `dsh-notifier/sent` event name stays unchanged.
- Consumer injection guidance corrected with rc.3 evidence: static `inject` remains recommended; callback-style `ctx.inject` works for optional dependencies on Cordis 4.1.0 (the old rc.6 "callback never fires" result is marked historical).
- `ADAPTER.md` §1/§3: `resolved` is a pure JSON frozen snapshot; send-time state belongs to adapter-private WeakMaps keyed by the resolved object; derived non-secret alias names may stay in the snapshot, only the warn latch moves; no credential/alias-warning leakage; new resolved object on hot replace means fresh runtime state.
- `docs/new-host/00-START-HERE.md`: top historical note points at HANDOFF + rc.3 workstreams, keeps `STATUS.json` untouched and explicitly does not claim T05–T29.
- `docs/ROADMAP.md`: top archive note now says the current line is the scoped 0.14.0 fork line and that historical `dsh-notifier/*` subpaths are served by the scoped package; W1–W10 history untouched.
- Humanizer pass on new prose; no new em/en dash or not-X-but-Y staging patterns kept in the new sections.

## Validation evidence

- Relative links: every link in the 19 edited files resolves (checked with a local path resolver); the only external links are the two repository URLs.
- Stale-reference grep in owned files: no unscoped install commands remain (`dsh plugin add dsh-notifier`, `npm/pnpm install dsh-notifier`, unscoped subpaths). Remaining `dsh-notifier@0.13.1` hits are intentional rollback/history references; remaining `THEWOLFWALKER` hits are explicit upstream attribution.
- `package.json` exports confirm the documented subpaths (`.`, `./internal`, `./testing`, `./types`, `./client`).
- `node --check examples/consumer-demo/src/index.mjs` — pass (source file, not a docs claim).
- No full test suite was run (lead's serial, isolated-DSH_HOME slot). The compatibility link target is the host-task matrix already verified by `node scripts/verify-host-compat.mjs`.

## Gaps / notes

- Rendered UI/provider/device behavior is not claimed anywhere in these docs; host evidence is delegated to `docs/compatibility-matrix.md`.
- The fork's `0.14.0` npm publish status is unknown at this snapshot; OPERATIONS labels it “release preparation” rather than published.
- Stale lead-owned docs listed above must be reconciled in the lead's neat-freak pass; this workstream only records them.
- `docs/new-host/STATUS.json` and the 25 archived taskpack files stay untouched by design.

## Handoff

Docs are committed as `7ea53d7` on `codex/rc3-scoped-release` (20 files: `ADAPTER.md`,
`PLUGINS.md`, `PLUGINS.en.md`, the 14 edited `docs/*.md` files listed above, the two
`examples/consumer-demo` files, and this workstream). No push was performed. The lead's
remaining docs pass has to reconcile the out-of-scope files listed above (especially
`docs/KNOWLEDGE_BASE.md`, `docs/memory/project-state.md`, `docs/memory/risks.md`,
`HANDOFF.md`, `CHANGELOG.md`).

## Final review revision (2026-11-17)

- Commit-hash correction: this workstream previously named the pre-amend commit
  `ca37a0d`; the actual committed docs revision is `7ea53d7` (the amend only
  added this handoff record; the 20-file payload is unchanged).
