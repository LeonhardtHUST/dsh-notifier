# Install dsh-notifier with an AI

This document is intended for an AI/agent with terminal access to the machine.

## Package identity and host range

- Package: `@leonhardthust/dsh-notifier` (maintained fork).
- Repository: `https://github.com/LeonhardtHUST/dsh-notifier`. The original project is `https://github.com/THEWOLFWALKER/dsh-notifier`; attribution is preserved.
- Host: this package declares exact compatibility with DSH `0.2.2-rc.5` only (`engines.dsh`). Older or newer DSH releases are rejected by the install preflight unless the user explicitly grants a host exemption; do not claim support for an unverified release.
- The original `dsh-notifier` package and this fork must not be installed together: both export the same service/event names and would contend for the same plugin id and state directory. Remove the original before installing the fork.

## One-sentence prompt

> Install or upgrade `@leonhardthust/dsh-notifier` on this machine. First detect the active DSH profile and current install source, verify the installed DSH is `0.2.2-rc.5` and Node is supported, and preserve the existing configuration. Do not modify unrelated plugins or print any token/secret. If the original `dsh-notifier` package is present, confirm and remove it so the two never coexist. Restart the relevant DSH Host once, verify the actual installed version and the **Notify & Control** entry; if this upgrades 0.13.x to 0.14.0, tell me to back up the old state first and expect to re-pair/reconfigure. Then report the commands you ran, the result, and any remaining problem. Project: `https://github.com/LeonhardtHUST/dsh-notifier`

## Full agent prompt

```text
You are helping the user install or upgrade @leonhardthust/dsh-notifier.

Maintained fork:
https://github.com/LeonhardtHUST/dsh-notifier
Original project (attribution only, not this install source):
https://github.com/THEWOLFWALKER/dsh-notifier

First perform read-only inspection:

1. Identify Node.js version.
2. Identify the DSH/Harness version and confirm 0.2.2-rc.5 (the only engines.dsh line this package declares).
3. Detect the active/common DSH profile. If multiple profiles exist and you cannot determine the target, list them and ask instead of guessing.
4. Check whether @leonhardthust/dsh-notifier is installed, and whether the original dsh-notifier package is also present.
5. Identify the install source: registry, file:, Git, or manual node_modules.
6. Record the current version.
7. Never print full state.json, bot tokens, webhook secrets, admin tokens, or Authorization headers.
8. Do not modify unrelated plugins.

Then install:

- If the original package and this fork coexist, stop and list the conflict. Keep only the fork after the user confirms.
- Prefer the DSH CLI:
  dsh plugin add @leonhardthust/dsh-notifier@latest --profile <correct-profile>
- If that CLI does not accept @latest:
  dsh plugin add @leonhardthust/dsh-notifier --profile <correct-profile>
- Do not replace a stable release with dev source unless explicitly requested.
- Do not use manual source-copying into node_modules as the persistent installation method.

When upgrading 0.13.x to 0.14.0:

1. Before installing, confirm the user has backed up the existing $DSH_HOME/dsh-notifier/state.json (or the whole state directory).
2. Do not hand-edit the old state or fabricate a __schema marker.
3. Explain that bindings, pending approvals, pairing codes, and credentials from the old namespace are not trusted. On the first application write the store creates a forensic copy named state.json.pre-v0.14-legacy.<timestamp>, keeps the original file, and expects re-pairing plus channel/credential reconfirmation.

After installation:

1. Restart the relevant DSH Host once.
2. Verify the actual installed package version from its manifest, not only the install command output.
3. Verify client.js exists in the installed package.
4. For a web/Native-capable profile, check:
   - Notify & Control appears in the sidebar;
   - @leonhardthust/dsh-notifier appears in Plugins.
5. Do not require notification-channel secrets merely to verify installation.
6. Preserve existing channel configuration unless the 0.14.0 legacy-namespace isolation applied; in that case follow the reconfiguration steps above.
7. If installation fails, preserve evidence and switch to read-only diagnosis instead of repeated reinstall loops.

Final report:
- profile
- Node version
- DSH version (0.2.2-rc.5 expected)
- package version/source before
- whether the original package was removed
- actual version after
- commands executed
- restart status
- Native entry status
- 0.14.0 legacy-state isolation (backup file, re-pair/reconfigure status)
- stale file:/install-source risk
- warnings/failures
- next step

Never include secrets.
```

## Next steps

- Upgrade steps and 0.14.0 data migration: [upgrade-guide.en.md](upgrade-guide.en.md)
- Host evidence boundary: [compatibility-matrix.md](compatibility-matrix.md)
- Diagnostic commands: [DIAGNOSTICS.en.md](DIAGNOSTICS.en.md)

If the package is installed but the UI is missing or behavior is stale, use [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md).
