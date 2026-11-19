# dsh-notifier Guide

> Goal: go from “plugin installed” to “notifications reach my phone, and I can respond when the agent needs me.”\
> 中文版: [guide.md](guide.md)

## Choose your target

| Mode | What you get | Required setup |
| --- | --- | --- |
| **Notifications** | Task completion, approval, error and long-running status notifications | At least one outbound channel |
| **Remote control** | Mobile approvals, `ask_user`, remote conversation, task/session control | Outbound + supported inbound + pairing |
| **Headless / automation** | YAML / CLI without depending on Native UI | DSH profile + YAML / CLI |

For a first install, get **notifications** working before adding remote control.

## 1. Install

### Ask an AI to install it

Copy this to an AI/agent with terminal access:

> Install or upgrade `@leonhardthust/dsh-notifier` on this machine. First detect the active DSH profile and current install source, verify the installed DSH is `0.2.2-rc.3` and Node is supported, and preserve the current configuration. Do not modify unrelated plugins or print any token/secret. If the original `dsh-notifier` package is present, confirm and remove it. Restart the relevant DSH Host once, verify the actual installed version and the **Notify & Control** entry; when upgrading 0.13.x to 0.14.0, back up the old state first and expect to re-pair/reconfigure. Project: `https://github.com/LeonhardtHUST/dsh-notifier`

Full procedure: [AI_INSTALL.en.md](AI_INSTALL.en.md).

### Manual install

```bash
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile-name>
```

This package declares exact compatibility with DSH `0.2.2-rc.3` only (`engines.dsh`); other
releases are rejected by the install preflight. Do not install the original `dsh-notifier`
package alongside the fork: both contend for the same plugin id and state directory.

Restart DSH once so the Host plugin and `client.js` are loaded.

Verify:
1. **Notify & Control** appears in the sidebar.
2. `@leonhardthust/dsh-notifier` appears under Plugins.
3. The actual installed version is the release you expect.

If the version looks correct but behavior is old, see [upgrade-guide.en.md](upgrade-guide.en.md) and check for stale `file:` installs.

## 2. Configure your first notification channel

If you are at the computer and just want a pop-up when DSH finishes, desktop notifications are enough:

```text
DSH Sidebar
→ Notify & Control
→ Desktop notifications
→ turn on "Show notifications on this computer", then send a test notification
```

Desktop notifications stay on this machine and need no account or credentials:

- Windows 10/11: the built-in toast notifications. With DSH desktop installed they appear as DeepSeek Harness. No PowerShell module is needed and nothing is written to the registry. Once the toast is handed to the system the send returns without a fixed extra delay; only a system API failure falls back to the legacy balloon tip.
- Linux: GNOME and KDE Plasma are supported through `notify-send`, falling back to `gdbus`. Other desktop environments get the freedesktop standard path without specific adaptation.
- macOS: Notification Center via `osascript`.

If nothing appears, check Do Not Disturb or Focus first.

If you want notifications while away from the computer, set up a remote channel:

```text
DSH Sidebar
→ Notify & Control
→ Remote channels
```

Pick a service you already use, enter its credentials, then choose **Save and test**.

### What “test success” means

dsh-notifier distinguishes:

- **provider accepted** — the provider API accepted the request;
- **confirmed** — explicit end-to-end receipt evidence exists.

Many providers only expose the first signal. If the UI says the provider accepted the test, verify it on the device.

### Session notifications: overlay, system and remote

These controls are in the development tree and are not part of the published 0.14.2 package. Contract and protocol tests cover them; the overlay and system actions have no real-device or authenticated-GUI run yet.

Open **Notify & Control → Desktop notifications** and use **Delivery by category**. Overlay and System offer Always, When focused, When away and Never. Remote adds Follow presence. System means the local desktop toast and the terminal bell.

| Category | Overlay | System | Remote |
| --- | --- | --- | --- |
| Approval / question waiting | When focused | Always | Always |
| Session started / completed / cancelled / error / status | When focused | Always | Follow presence |
| Manual `notify` message | When focused | Always | Always |
| Todo / goal completed or cancelled | When focused | Always | Follow presence |
| Todo / goal changed or paused | Never | Never | Never |

The matrix routes events that already exist; the existing `events.*` switches still decide whether an event line is emitted.

Follow presence skips remote targets only while this computer has focus and a desktop notification was actually accepted. If the desktop send fails, session mute blocks it, or a Linux action receipt is unverified, the remote targets are sent after all. Approval and question rows cannot use Follow presence because a missed request leaves the agent waiting. If you change their remote mode to When away or Never, the handler returns control to the desktop immediately instead of waiting for a card that will not be sent.

Approval and question events wait 1.5 seconds before they are announced, so a request the host settles immediately does not produce a false alert. A timed question that returns `pending: true` stays waiting until the `user-question-reply`. A todo item that leaves the list counts as cancelled, and `in_progress → pending` counts as paused. A goal `clear` counts as cancelled; `block` is grouped under paused, which is off by default.

The overlay has six positions, six entrance animations, a stacking switch and an up/down direction. Stacking keeps four cards; without stacking only the newest card remains. Top placement follows the host titlebar safe area and bottom placement keeps 20px. Selecting a card opens its Session; its menu lists the mute durations. Mute is per session and blocks the overlay, system notification and remote channels.

System actions differ by platform:

- Windows shows **Open session** on a physical toast only when the Host has a bound loopback web server. It has no mute action, and button rendering still needs a real Windows session.
- Linux exposes Open and the configured mute durations only when `notify-send` supports `--action` and `--wait`, with at most eight observers running for 60 seconds each. Action output is not delivery evidence. Older `notify-send` builds and the `gdbus` fallback stay text-only.
- macOS is text only.

The installed Desktop app accepts only `dsh://open` to focus itself and has no session deep link. Open uses the loopback web URL and is handled by the authenticated client. Settings live in `local:session-notifications` and `local:session-mutes` and are read through Native RPC. This branch does not change an installed profile or publish to npm.

## 3. Understand Hot Apply

Outbound changes are hot-applied:

```text
save
→ validate
→ persist canonical state
→ update live runtime
→ next send uses the new config
```

Inbound WebSocket/SDK/long-poll transports may still show **Restart pending** and require a restart to recreate the connection.

## 4. Notifications-only mode

Common automatic notification sources include:

- `turn/end`
- `approval/asked`
- `agent/error`
- long-running heartbeat
- stall
- model-triggered `notify`

No member pairing is required if you only receive notifications.

## 5. Enable remote control

Supported inbound control channels:

```text
Telegram
Feishu
QQ official bot
WxPusher
WeChat iLink
DingTalk
```

Provider onboarding differs. If the UI marks an inbound change as restart-pending, restart DSH after saving it.

## 6. Pair identities

Membership uses the canonical principal:

```text
(channel, accountId, userId)
```

`chatId` / `chatType` scope the event source; they are not the membership identity itself.

Create a pairing code in Advanced Console, then send:

```text
/pair <code>
```

from the bot private chat.

Unknown or incomplete identities fail closed.

## 7. Daily mobile control

Plain text continues the remote conversation.

To steer a running turn:

```text
! use plan B and do not touch the database yet
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `/help` | Commands |
| `/whoami` | Identity / pairing |
| `/status` | Routing / session state |
| `/tasks` / `/use …` | Task list / selection |
| `/sessions` | Session overview |
| `/stop` | Stop current turn |
| `/route` | Bidirectional route |
| `/quiet …` / `/unquiet …` | Mute / restore notifications |
| `/pair <code>` / `/unpair` | Pair / detach |
| `/log [N]` | Bounded redacted recent log; off by default, owner-only |

Unsafe remote-control semantics are not enabled in group chats.

**Command admission (v0.14 / T04):** every command above must clear one unified
authorization gate before it takes effect. By default (unless the matching
capability is explicitly enabled under `inbound.control.capabilities`): read-only
commands (`/status` `/tasks` `/sessions` `/help` `/whoami`) work; `/stop` needs
`stop`; ordinary text and `!steer` need `converse`; `/bind` `/use` need `assets`;
`/quiet` `/unquiet` need `quiet`; `/log` needs owner (and is off by default). An
unrecognized `/xxx` is **explicitly refused** (an "unrecognized command" receipt),
never delivered to the agent as plain text. Group chats reject control,
conversation and sensitive command entry points by default (group notifications
are unaffected).

## 8. Advanced Console

Use the Native UI for daily work. Use Advanced Console for:

- members / pairing;
- pending identities;
- bindings;
- session management;
- deeper diagnostics;
- Native recovery.

It remains loopback-only on `127.0.0.1`.

## 9. YAML / CLI

For automation/headless use:

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "${ENV:TELEGRAM_BOT_TOKEN}"
          chatId: "987654321"
```

Prefer `${ENV:NAME}` for credentials and never commit secrets.

CLI examples:

```bash
node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat>
node scripts/channel-selfcheck.mjs ...
node scripts/route.mjs show
```

Avoid manually editing a live `state.json`; let the existing store preserve lock/transaction/merge semantics.

## 10. Upgrade

```bash
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile-name>
```

Restart once after installing a new package version.

### Upgrade 0.13.x to 0.14.0

0.14.0 uses a new state schema/namespace. Before upgrading, back up
`$DSH_HOME/dsh-notifier/state.json` (or the whole state directory).

If the plugin reports that the old state is untrusted after the upgrade, bindings, pending
approvals, pairing codes and credentials from the old namespace are not treated as
authority. On the first application write the store creates
`state.json.pre-v0.14-legacy.<timestamp>` and keeps the original file. Then:

1. generate a new pairing code and `/pair` from the phone;
2. re-save outbound/inbound channel settings or re-scan the credential;
3. let the agent re-raise any pending approval that was lost.

Do not hand-edit `state.json` or fabricate a `__schema` marker. See
[upgrade-guide.en.md](upgrade-guide.en.md) for stale installs and rollback.

## If something is wrong

Start with AI-assisted read-only diagnosis:

[TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md)

If it remains unresolved, generate a support bundle using:

[DIAGNOSTICS.en.md](DIAGNOSTICS.en.md)

Do not post secrets, full state files, authorization headers, or unredacted private messages.

## More docs

- [AI installation](AI_INSTALL.en.md)
- [Troubleshooting](TROUBLESHOOTING.en.md)
- [Diagnostics](DIAGNOSTICS.en.md)
- [Compatibility](compatibility-matrix.md)
- [Operations](OPERATIONS.md)
- [Plugin API](../PLUGINS.en.md)
