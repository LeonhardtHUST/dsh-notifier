# dsh-notifier Troubleshooting

Use this support flow:

```text
AI-assisted read-only diagnosis
→ identify the failing layer
→ safely fix locally when clear
→ otherwise generate a Support Report
→ then report upstream
```

Do **not** start with uninstall/reinstall or state deletion. Preserve evidence.

## Copy/paste troubleshooting prompt

> Help me troubleshoot `@leonhardthust/dsh-notifier`. The first pass must be read-only: do not uninstall, reinstall, delete state, or change credentials. Identify the actual package version and install source, whether the original `dsh-notifier` package is co-installed, DSH version (this package declares 0.2.2-rc.3 only) and profile, Node version, whether `client.js` is loaded, and whether the failure belongs to Native UI, outbound, inbound, identity/pairing, provider, storage, network, or Host compatibility. Build a minimal reproduction. Redact all logs/config and never print tokens, secrets, or Authorization headers. Report evidence and your conclusion first; only then propose a low-risk local fix if one is clear. If unresolved, generate a support report using `docs/DIAGNOSTICS.en.md`. Project: `https://github.com/LeonhardtHUST/dsh-notifier`

## First-pass checklist

Confirm:
- Node version
- DSH/Harness version (this package declares 0.2.2-rc.3 only)
- active profile
- actual @leonhardthust/dsh-notifier version
- install source (`registry`, `file:`, Git, manual)
- whether the original `dsh-notifier` package is co-installed
- failing channel and direction
- minimal reproduction
- relevant sanitized logs

Classify the failure:

| Layer | Typical symptom |
| --- | --- |
| Install/profile | plugin/version not actually loaded |
| Native client | missing sidebar, empty page, slot error |
| Outbound config | save or Hot Apply mismatch |
| Provider | API/permission/quota/client rendering |
| Inbound runtime | configured but bot/WS not online |
| Identity/pairing | `/pair`, member/role mismatch |
| Control Core | approval/question settlement |
| Storage | read/write/corrupt/permission/disk |
| Network | DNS/proxy/timeout/TLS/webhook |
| Host compatibility | missing attachment/session/client seam |

Preserve the current state. Do not delete `state.json`, disable security checks, expose Admin publicly, rotate all secrets, or dump full configuration.

## Common cases

### Native entry missing
Check actual installed version, DSH restart, correct profile, installed `client.js`, Host compatibility, and client/slot logs.

### New version number, old behavior
Check:

```bash
npm ls @leonhardthust/dsh-notifier
pnpm why @leonhardthust/dsh-notifier
```

A stale `file:` installation is a common cause. If the original `dsh-notifier` package is
also present, remove it first per [upgrade-guide.en.md](upgrade-guide.en.md); the two must
not coexist.

### Outbound save still requires restart
0.14.0 outbound config is Hot Apply. Verify the running package and distinguish outbound from inbound.

### Legacy state reported as untrusted after upgrading to 0.14.0
That is the 0.14.0 schema/namespace gate, not corruption:

1. bindings, pending approvals, pairing codes, and credentials from the old namespace are
   not treated as authority;
2. the first application write creates `state.json.pre-v0.14-legacy.<timestamp>` and keeps
   the original file;
3. re-`/pair` and re-save or re-scan channel credentials as prompted;
4. do not hand-edit `state.json` or fabricate a `__schema` marker.

Back up state before attempting a rollback; see [upgrade-guide.en.md](upgrade-guide.en.md).

### Inbound configured but offline
Check whether the UI reports **Restart pending**.

### API test succeeds but no phone message
Provider acceptance is not the same as confirmed client delivery. Record the provider result and actual client behavior separately.

### Pairing fails
Check private-chat source, code expiry/use, lockout, and identity/account scope.

If unresolved, use [DIAGNOSTICS.en.md](DIAGNOSTICS.en.md) to generate a compact support report.
