# Agent connector runbook

You are a coding agent running on a computer the owner wants to connect to an existing Sig deployment. Install the connector, pair this machine, register the owner's chosen repositories, and verify a real task. Cloud deployment is covered separately in [agent-deploy.md](agent-deploy.md).

## 0 · Check the machine and destination

- Confirm this is the machine that will run coding agents. Ask for the existing Sig HTTPS URL and the local repository paths the owner wants to connect.
- Check macOS or Linux, Node ≥ 22.18 (`node -v`), npm, and git. Background mode uses launchd on macOS and a systemd user service on Linux. For a container or a machine without a supported service manager, use foreground mode and explain that its terminal must stay open.
- Check the intended local coding agent: pi (`pi --version`) is the default; installed Claude Code (`claude --version`) is also supported. These CLIs are separate from the connector. If missing, install the owner's chosen agent using its official instructions. Have the owner complete its login or provider setup directly, keeping credentials out of chat and logs. The cloud model key does not configure the local coding agent.
- If `sig` is already installed, run `sig status` first. Preserve a correct pairing. If it points to a different deployment, confirm the intended replacement before pairing again.
- Check for `SIG_HOME` overrides without dumping the environment. A custom state directory cannot install the shared background service; resolve the intended setup or use `--foreground`.
- Verify that the deployment URL is reachable. An unauthenticated `GET /app` returning 401 is expected. On a network where the URL is only reachable through a local HTTP proxy (filtered networks, mainland China), connect with `sig connect <url> <code> --proxy http://127.0.0.1:7890` — both channels (fetch, WebSocket), the connector's `git` calls, and worker children follow it, and the choice is stored so the background service needs no inherited environment. An `HTTPS_PROXY` already set in the shell is captured automatically; `sig doctor` diagnoses direct-vs-proxy reachability when things fail.

Do not read credential stores or ask the owner to paste SERVER_KEY, model keys, login links, or device tokens into chat. Pairing needs a short-lived code, not the owner's permanent SERVER_KEY.

## 1 · Install the connector

If the public npm package is available (`npm view @alexlikevibe/sig version`), install it to a stable location:

```sh
npm install --global @alexlikevibe/sig
sig --version
```

Use the owner's normal Node installation and a user-writable npm prefix; do not reach for `sudo` to fix permissions. A global install gives the background service a stable executable path and makes the `sig` command available for later steps.

### If the package is not yet published

An npm 404 is not a successful installation. Use an accessible checkout of [iefnaf/sig](https://github.com/iefnaf/sig); if access is denied, ask the owner to authorize GitHub or provide a checkout. From the repository root, use its pinned pnpm version:

```sh
git clone https://github.com/iefnaf/sig && cd sig   # or use an existing checkout
pnpm install
pnpm --filter @alexlikevibe/sig build
sig_package_dir="$(mktemp -d)"
npm pack ./apps/connector --ignore-scripts --pack-destination "$sig_package_dir"
npm install --global "$sig_package_dir"/alexlikevibe-sig-*.tgz
sig --version
```

The built tarball contains the CLI and its assets, so the installed service does not depend on the checkout or an npx cache. If installing an update over a running connector, run `sig restart` afterwards. Until the npm package is published, update by repeating this source-install procedure instead of `sig upgrade`. For network or registry errors other than a missing package, diagnose the error rather than treating it as proof the package is unpublished.

## 2 · Pair with the personal agent

Have the owner open the existing Sig web workspace and go to **Machines → Add a machine → Create pairing command** (中文：**机器 → 添加机器 → 生成配对命令**). Generate the code only after installation is complete; it is single-use and expires in 10 minutes.

The workspace generates a command shaped like:

```sh
npx @alexlikevibe/sig connect https://sig.example.com <pairing-code>
```

Use the installed CLI with the URL and code from that command (append `--proxy <url>` on filtered networks — see step 0):

```sh
sig connect https://sig.example.com <pairing-code>
```

The owner can run it directly in their terminal, keeping the pairing code out of the agent transcript. With an authorized browser session, an agent may carry out pairing without repeating the code in its report. Use the final reachable deployment URL and do not reuse a code from an example.

`connect` saves the device credentials, installs the background service, and starts it. On a machine without launchd/systemd user services, use `sig connect <url> <code> --foreground` in a persistent terminal instead. If the code expires or has already been used, generate a fresh one in the workspace. If the owner cannot sign in, follow [browser access recovery](deploy.md#recover-browser-access). Never ask for a password or SERVER_KEY in chat.

## 3 · Register the selected repositories

In the web workspace, open **Machines**, find the connected machine, and choose **Add directory** (中文：**机器 → 添加目录**). Select an existing directory or enter its absolute path, then wait for registration to succeed. Repeat for each directory the owner chose. The connector detects a Git repository automatically; a plain directory registers the same way, with no branch, worktree isolation, or PR support.

The connector resolves and saves each directory's identity locally before the workspace shows it as registered. Keep the connector online during registration. No restart is needed.

Keep the default `worktree` isolation unless the owner wants a different write policy — a plain (non-Git) directory can only run `in-place`. Do not add `--approve` as a setup shortcut: it enables the repository's local pi extensions and is a separate trust choice. Repository settings are documented in [deploy.md](deploy.md#connecting-a-machine).

## 4 · Verify the full connection

1. Run `sig status`. Confirm the intended deployment, installed/running service (or the live foreground process), and registered repositories. A saved pairing alone does not prove the WebSocket is connected.
2. Check recent `sig logs -n 50` for a `welcomed` event and confirm the machine is **online** in the workspace's Machines page, with the expected repositories and agents. Fix repeated connection failures before continuing.
3. Ask Sig in the workspace to run a small read-only task using **pi**, for example: “On this machine, use pi to summarize the README in this repository. Do not modify files.” Verify that the task returns a result and its session record opens. Claude Code's adapter does not support Sig's read-only mode; if only Claude Code is configured, report that the read-only check is pending rather than claiming it passed or silently dispatching a write-capable task.

Hand over the machine name, connected repositories, and the observed task result. Explain that the computer must stay awake and connected, and give the owner these management commands:

```sh
sig status
sig logs -n 50
sig stop
sig start
sig restart
sig uninstall   # removes the service, preserves local state
```

State is stored in `~/.sig/`. The owner can revoke a machine from the workspace at any time. See [deploy.md](deploy.md) for updates and operations, and [usage.md](usage.md) for agent behavior and session viewing.
