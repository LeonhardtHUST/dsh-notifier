# Guard: never touch the real DSH profile

The real DSH home (`%USERPROFILE%\.dsh`, `$HOME/.dsh`) belongs to the machine
owner and is OUT OF BOUNDS for every test in this repo. Only throwaway homes under
the scratch root (`%TEMP%\dsh-notifier-rc3-scratch\`, override with
`DSH_NOTIFIER_HOST_SCRATCH`) may be created, written, or deleted.

`harness.mjs` enforces this: `assertNotRealDshHome(p)` throws when any target
resolves to a real `~/.dsh` (or anything inside it), and `assertInsideScratch(p)`
throws when a path escapes the scratch root — every mutating helper calls both.
`makeDisposableDshHome()` defaults to removing and recreating its own home, never
another path.

```js
// Optional standalone check, usable anywhere:
import { assertNotRealDshHome, REAL_DSH_HOME } from './harness.mjs'
try {
  assertNotRealDshHome(REAL_DSH_HOME)
  throw new Error('guard failed: real ~/.dsh was not refused')
} catch (error) {
  if (!/real DSH home/.test(String(error))) throw error // expected refusal
}
```

Do not point a harness `DSH_HOME` at a directory that contains a real profile, and
do not run the smoke while a real DSH process is being debugged against the same
admin port — the smoke disables the plugin's loopback admin console for its own
disposable profiles.
