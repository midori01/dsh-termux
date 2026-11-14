# dsh-termux

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`) on Android in [Termux](https://github.com/termux/termux-app) — with one-command install, `dsh update` and `dsh rollback`.

```sh
curl -fsSL https://raw.githubusercontent.com/midori01/dsh-termux/main/install.sh | bash
```

Then put your API key in `~/.dsh/.env` (or enter it on the Models page of the web UI):

```sh
echo 'DEEPSEEK_API_KEY=sk-...' >> ~/.dsh/.env && chmod 600 ~/.dsh/.env
dsh            # same as `dsh web`: starts the web UI and opens it in your browser
```

## Requirements

- Termux from F-Droid or GitHub (not the Play Store build), aarch64
- Android 11 (API 30) or newer
- The installer adds what is missing: `nodejs-lts` (Node.js ≥ 24.9), `clang`, `make`, `cmake`, `ninja`, `python`, `pkg-config`

## Commands

| Command | |
|---|---|
| `dsh` / `dsh web` | Web UI (opens the browser; `--no-open` to only print the URL) |
| `dsh headless "task"` | Answer one task and exit |
| `dsh update` | Update dsh and this compatibility layer; the new version is self-tested before it replaces the old one |
| `dsh update --tag next` | Follow another npm dist-tag (`latest`, `next`, `alpha`); the choice is remembered |
| `dsh update --version 0.2.2-rc.1` | Install an exact version |
| `dsh rollback` | Switch back to the previously installed version |
| `dsh termux status` / `doctor` / `uninstall` | Show versions, re-run the self-test, remove everything except `~/.dsh` |

Anything else is passed to dsh unchanged (`dsh --help`, `dsh plugin …`).

## How it works

The official package targets glibc Linux. Instead of patching dsh's files — which breaks on every release — this project leaves the installed packages untouched and adapts them at startup, so the same layer keeps working when dsh updates:

| Problem on Android | Fix |
|---|---|
| `koffi` calls `statx()`, which bionic only declares from API 30 | compiled with `-D__ANDROID_UNAVAILABLE_SYMBOLS_ARE_WEAK__` |
| `node-addon-require-builtin` has no android-arm64 binary | a JS stand-in, enabled by running Node with `--expose-internals` |
| `@deepseek-ai/node-addon-system` (flock) refuses android | a stand-in that calls libc `flock(2)` through koffi |
| SELinux denies `link(2)` (session files are published with hard links) | `fs.link` falls back to an exclusive copy, keeping the `EEXIST` contract |
| `sharp` has no android-arm64 binary | its WebAssembly build `@img/sharp-wasm32` |
| Android browsers open the `dsh web` link as a cross-site navigation, so the `SameSite=Strict` login cookie is not sent after the redirect (401) | the login link answers with a page that navigates to `./` itself, a same-origin navigation that carries the cookie |

The stand-ins are wired in by `runtime/preload.mjs` (`node --import`) through Node's module hooks. Every version lives in its own directory under `$PREFIX/lib/dsh-termux/versions/`, together with the layer it was tested with; `current` and `previous` are symlinks, so an update or rollback is a symlink switch.

This version of dsh ships no terminal UI; use the web UI, or `headless` for scripts.

## License

MIT. Not affiliated with DeepSeek.
