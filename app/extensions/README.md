# Extensions

Any unpacked extension directory (one containing a `manifest.json`) placed
here loads automatically at session start via `app/extensions.js`. Empty
directory = no-op, nothing to configure.

Not vendored into git (see root `.gitignore`) — extension binaries don't
belong in version control.

## uBlock Origin

Easiest path: Settings panel -> Extensions -> "Install uBlock Origin" button,
which downloads and loads it immediately, no restart needed.

Or run it standalone:

```
node app/extensions/fetch-ublock.js
```

Downloads the latest uBlock Origin Chromium release zip from GitHub and
unpacks it into `app/extensions/ublock-origin/`. Requires network access and
`unzip` on PATH (default on Linux/macOS). On Windows without `unzip`,
download the `*.chromium.zip` asset from
https://github.com/gorhill/uBlock/releases/latest and unzip it into
`app/extensions/ublock-origin/` by hand.
