# dsh-notifier Diagnostics

Use this after first-line troubleshooting has not resolved the problem.

The goal is a **small reproducible support report**, not a giant log dump.

## Evidence to collect

Record:

```text
OS
Node
DSH/Harness (this package declares 0.2.2-rc.3 only)
DSH profile
@leonhardthust/dsh-notifier version
install source
channel
direction/capability
first known bad version
reproducibility
```

Install source must be explicit: registry, `file:`, Git, manual node_modules, or unknown.
If the original `dsh-notifier` package is still installed alongside the fork, record the
co-install and remove the original first per [upgrade-guide.en.md](upgrade-guide.en.md).

## Minimal reproduction

Reduce the failure to the shortest sequence of actions.

Separate:

```text
Expected
Actual
```

For delivery issues also separate:

```text
provider accepted?
confirmed receipt?
client actually displayed?
```

## Safe version/install evidence

Examples:

```bash
node -v
npm ls @leonhardthust/dsh-notifier
pnpm why @leonhardthust/dsh-notifier
npm view @leonhardthust/dsh-notifier version
```

Do not guess the active package from the repository checkout; inspect the dependency tree used by the active DSH profile.

## Native UI

Capture:
- Plugins entry present for @leonhardthust/dsh-notifier?
- Notify & Control sidebar entry present?
- installed `client.js` present?
- client/slot/module error?
- blank, crash, or stale UI?

Screenshots are useful, but redact tokens/private data first.

## Outbound

Capture:
- channel type
- save result
- provider status/code/message, redacted
- Hot Apply result
- whether the next real send uses the new config

## Inbound

Capture:
- configured
- active
- restartPending
- transport state
- last connect/disconnect error

## Identity/pairing

Capture:
- private/group
- channel
- presence of accountId/userId
- code expired/used/locked?
- role
- rejection reason/code

Do not post full user identifiers when unnecessary.

## Storage

Report status only:

```text
file exists/readable/writable
bootStatus
schemaVersion / namespace matches the current package?
legacyUnknown (old-namespace isolation) hit?
state.json.pre-v0.14-legacy.<timestamp> forensic copy present?
disk/permission condition
STATE_BUSY / STATE_CORRUPT / STATE_READ_FAILED / STATE_WRITE_FAILED
```

Never upload full `state.json`.

## Network

Capture:
- DNS/proxy/TLS/timeout
- non-secret target host
- HTTP status/provider code
- redirect behavior

Never post Authorization headers.

## Support Report template

```markdown
# dsh-notifier Support Report

## Environment
- OS:
- Node:
- DSH/Harness:
- Profile:
- @leonhardthust/dsh-notifier:
- Install source:
- Original dsh-notifier co-installed: yes/no

## Scope
- Channel:
- Direction:
- Capability:
- First known version:
- Reproducible: yes/no

## Expected
...

## Actual
...

## Minimal reproduction
1.
2.
3.

## Evidence
- Provider accepted:
- Confirmed receipt:
- Runtime state:
- Relevant error code:
- Sanitized log excerpt:

## Checks already completed
- [ ] actual package version verified
- [ ] install source checked
- [ ] original dsh-notifier package confirmed absent
- [ ] correct profile confirmed
- [ ] DSH restarted after package upgrade
- [ ] stale file: install checked
- [ ] restartPending checked where relevant
- [ ] legacy state isolation / pre-v0.14 backup checked when upgrading
- [ ] secrets redacted

## Local fixes attempted
...

## AI diagnosis
Most likely layer:
Evidence:
Remaining uncertainty:

## Attachments
- screenshots:
- sanitized logs:
```

Remove tokens, secrets, bearer headers, full webhooks, full state files and unredacted private chat before reporting.
