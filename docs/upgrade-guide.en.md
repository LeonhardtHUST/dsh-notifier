# dsh-notifier Upgrade Guide

> For DSH users: update, verify the installed build, migrate 0.13.x to 0.14.0, triage stale installs, and roll back.
>
> 中文版：[`upgrade-guide.md`](upgrade-guide.md)

## 1. Update to the latest release

Recommended:

```bash
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile-name>
```

If your DSH CLI does not accept `@latest`:

```bash
dsh plugin add @leonhardthust/dsh-notifier --profile <profile-name>
```

Or manage it from the DSH root:

```bash
npm install @leonhardthust/dsh-notifier@latest
# or
pnpm add @leonhardthust/dsh-notifier@latest
```

This package is the maintained fork (`https://github.com/LeonhardtHUST/dsh-notifier`); the
original project is `https://github.com/THEWOLFWALKER/dsh-notifier` and attribution is
preserved. Do not install the original `dsh-notifier` package alongside the fork: both
contend for the same plugin id, service names, and state directory. Remove the original
first when migrating.

### Restart once after installing the new package

Restart DSH once so the new Host plugin and `client.js` are loaded.

That restart is required to **load the upgrade**. It does not mean 0.14.0 outbound edits are restart-bound: once 0.14.0 is running, outbound channel saves Hot Apply through the shared canonical runtime truth.

## 2. What changes from v0.11 to v0.12

### Native is now the primary UI

Old daily path:

```text
startup log
→ copy localhost /#token link
→ configure in Web Admin
```

v0.12 primary path:

```text
DSH Sidebar "Notify & Control"
or Plugins → dsh-notifier
→ configure channel
→ save + real test
```

The Standalone Web console remains as **Advanced / Recovery**.

### Outbound saves are live

The old v0.11 “view-hot, delivery-cold / restart required” rule no longer applies to v0.12 outbound configuration.

v0.12:

```text
save
→ validate / resolve
→ persist
→ atomically replace OutboundSource entry
→ next send uses the new config
```

### Canonical outbound state changed

New writes use:

```text
channel:<type>:outbound
```

Old `admin:channel:<type>:outbound` and legacy `<type>:account` entries are compatibility inputs only.

The canonical state is independent of `admin.enabled`.

### Inbound can still be restart-bound

v0.12 intentionally does not implement a generic hot-reloader for every inbound SDK/WS/long-poll transport. Follow the UI `applyMode`.

## 3. Verify the actual installed version

| Evidence | How | Expected |
|---|---|---|
| Native UI | DSH Sidebar / Plugins | `Notify & Control` entry exists for @leonhardthust/dsh-notifier |
| CLI | `npm ls @leonhardthust/dsh-notifier` / `pnpm ls @leonhardthust/dsh-notifier` | `0.14.0` or newer |
| Registry | `npm view @leonhardthust/dsh-notifier version` | matches the release you intended to install |

Developers can also inspect the installed package:

```text
exports["./client"] = "./client.js"
dshQuality.testCount = 2011    # historical v0.13.1 line; the final 0.14.0 count follows release metadata
```

## 4. Version is new, behavior looks old

The usual cause is a stale `file:` install, manual node_modules overwrite, or pnpm restoring a different package tree.

Check:

```bash
pnpm why @leonhardthust/dsh-notifier
# or
npm ls @leonhardthust/dsh-notifier
```

A `file:` / absolute local path means you are not testing the registry artifact.

Clean reinstall:

```bash
dsh plugin remove @leonhardthust/dsh-notifier --profile <profile-name>
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile-name>
```

Restart DSH afterwards.

## 5. 0.14.0 triage

### Native entry is missing

Check:

1. installed package is `0.14.0+`;
2. DSH restarted;
3. Host is `0.2.2-rc.3`;
4. installed package contains `client.js`;
5. the web profile reports no client-module/slot failure.

Declared requirement (`engines.dsh`; the rc.3 preflight reads it alone and ignores the
`@deepseek-ai/dsh*` peers):

```text
0.2.2-rc.3
```

The `0.1.7-*` and `0.2.1-*` lines are no longer supported: the host preflight rejects the
manifest version gate at install time (unless an exact-version exemption is granted by
hand, which this plugin does not ship).

### Outbound save still requires restart

That is not normal 0.14.0 behavior. Verify that you are testing the registry build, that the edit is outbound (not inbound), and that no stale local package is shadowing it.

### Advanced Console will not open

Native does not auto-enable `admin.enabled`. If you explicitly disabled Admin, re-enable it or use YAML/CLI for recovery.

## 6. Roll back

This fork's published line starts at `0.14.0`. To return to the earlier feature line you
must switch back to the original package `dsh-notifier@0.13.1`; remove the fork first.

```bash
dsh plugin remove @leonhardthust/dsh-notifier --profile <profile-name>
dsh plugin add dsh-notifier@0.13.1 --profile <profile-name>
```

Back up state first. 0.13.x does not understand the 0.14.0 schema/namespace marker, so a
channel configured only through the 0.14.0 Native UI may need reconfiguration after the
downgrade. Reconfigure in the original package if needed, and re-pair.

Do not edit a live state file by hand, and do not keep the original package and the fork
installed together.

## 7. DSH 0.2.2-rc.3 migration and the new data namespace

This plugin declares activation against DSH **0.2.2-rc.3** only (`engines.dsh`). The rc.3
install preflight reads an own `engines.dsh` alone and ignores the `@deepseek-ai/dsh*`
peers, so the package installs with **no version exemption**.

### 7.1 Old state is no longer authority

The state store now carries an explicit schema/namespace version. At startup:

- version == current: normal load;
- **unknown/old version** (for example a `state.json` written by 0.13.x or the older
  `0.1.7-*` line): the identity bindings, pending bindings, pairing codes, session
  selection and cursors inside are **not** treated as authority — they are not executed
  and not authorized; the plugin asks you to **re-configure / re-pair**, and **never
  deletes the original file**.
- On the first application write the store creates
  `state.json.pre-v0.14-legacy.<timestamp>` as a forensic copy, then establishes the new
  namespace.

So after upgrading you must re-configure channels and re-`/pair`. Old pending actions, old
pairing codes and old account-owned members are not inherited. The backup and forensic
copy live in the same state directory: `$DSH_HOME/dsh-notifier/` (or
`~/.dsh/dsh-notifier/` when `$DSH_HOME` is unset).

### 7.2 Account identity key

The identity/authority primary key is `AuthorityKey = (channel, accountIdentity, userId)`
(see [CONTRACTS.md](new-host/CONTRACTS.md) §identity-and-data-version). The local alias
`default` is not proof of a subject; a provider without an authoritative subject source
conservatively re-establishes a local account identity and requires re-pairing.

## 8. Developers: use the registry artifact as the real-machine baseline

`file:` is for temporary development only.

Before publishing or reporting a real-host result, install the registry fork build, then verify:

- registry version;
- package payload;
- Native client module;
- one real save/test;
- one real post-save outbound operation without restart.

Green mocks/contracts do not certify external provider/device behavior.
