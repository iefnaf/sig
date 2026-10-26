<p align="center">
  <img src="brand/sig.svg" alt="Sig logo" width="96" height="96">
</p>

# Sig connector

**English** · [简体中文](#sig-connector-简体中文)

`@alexlikevibe/sig` installs the `sig` command. Sig is a self-hosted personal agent that runs in your Cloudflare account; the connector runs on a macOS or Linux computer and connects that computer to Sig. It keeps a WebSocket connection to your deployment, starts local coding agents such as pi and Claude Code, and reports their progress back to your personal agent.

The connector makes only an outbound connection. You do not need to open an inbound port on your computer.

## Requirements

- macOS or Linux
- Node.js 22.18 or newer
- npm 7 or newer
- A deployed Sig workspace
- A local coding agent, such as pi or Claude Code, installed and authenticated separately

## Install

Install the connector globally on the machine that will run your coding agents:

```sh
npm install --global @alexlikevibe/sig
sig --version
```

Use a user-writable npm prefix. Do not use `sudo` to work around an npm permissions problem.

## Connect a machine

Open your Sig web workspace and go to **Machines → Add a machine → Create pairing command**. The workspace creates a one-time command:

```sh
npx @alexlikevibe/sig connect https://sig.example.com <pairing-code>
```

If the connector is already installed globally, use the shorter form:

```sh
sig connect https://sig.example.com <pairing-code>
```

The pairing code is single-use and expires after 10 minutes. `connect` saves the device credential, installs a launchd service on macOS or a systemd user service on Linux, and starts the connector. On a machine without a supported service manager, add `--foreground` and keep the terminal open.

### Networks that block the deployment

`*.workers.dev` and similar hosts are unreachable from some networks (notably mainland China without a proxy). Pass a proxy so both the pairing request and the long-lived connection can get through:

```sh
sig connect https://sig.example.com <pairing-code> --proxy http://127.0.0.1:7890
```

With no `--proxy`, `connect` captures `HTTPS_PROXY` from the environment and stores it; the background service, git, and agent workers all inherit it. Check reachability any time with `sig doctor`, and inspect or change the stored proxy with `sig proxy`.

After pairing, open **Machines** in the Sig web workspace. Choose **Add directory** on the online machine, then select an existing directory or enter its absolute path. Sig detects a Git repository automatically; a plain directory works too, with no branch, worktree isolation, or PR support. Wait for registration to succeed before starting work. Repeat for each directory that Sig may use. No connector restart is needed.

Keep repository paths explicit. Do not register an entire home directory.

## Manage the connector

```sh
sig status                 # service, pairing, workers, and registered repositories
sig logs -n 50             # recent connector logs
sig stop                   # stop and disable start-at-login
sig start                  # enable and start
sig restart                # restart the background service
sig upgrade                # install the latest package and restart
sig uninstall              # remove the service, preserve local state
```

State remains in `~/.sig/`. You can revoke a machine from the Sig workspace at any time.

## License

Released under the [MIT License](LICENSE).

## Documentation

The deployment and connector runbooks live in the [Sig repository](https://github.com/iefnaf/sig):

- [Deploy Sig](https://github.com/iefnaf/sig/blob/main/docs/deploy.md)
- [Connect a machine](https://github.com/iefnaf/sig/blob/main/docs/agent-connect.md)
- [Usage and agent behavior](https://github.com/iefnaf/sig/blob/main/docs/usage.md)

---

# Sig connector 简体中文

`@alexlikevibe/sig` 会安装 `sig` 命令。Sig 是部署在你 Cloudflare 账号里的 personal agent；connector 运行在 macOS 或 Linux 电脑上，把这台电脑接入 Sig。它保持到你部署地址的 WebSocket 连接，启动本地的 pi、Claude Code 等 coding agent，并把进展回传给 personal agent。

Connector 只主动发起出站连接，不需要在电脑上开放入站端口。

## 环境要求

- macOS 或 Linux
- Node.js 22.18 或更新版本
- npm 7 或更新版本
- 已部署的 Sig 工作台
- 已单独安装并完成认证的本地 coding agent，例如 pi 或 Claude Code

## 安装

在需要运行 coding agent 的电脑上全局安装：

```sh
npm install --global @alexlikevibe/sig
sig --version
```

请使用当前用户可写的 npm prefix。遇到权限问题时不要用 `sudo` 绕过。

## 连接电脑

打开 Sig 网页工作台，进入 **机器 → 添加机器 → 生成配对命令**。工作台会生成一次性命令：

```sh
npx @alexlikevibe/sig connect https://sig.example.com <pairing-code>
```

如果已经全局安装 connector，可以直接运行：

```sh
sig connect https://sig.example.com <pairing-code>
```

配对码只能使用一次，10 分钟后过期。`connect` 会保存设备凭证，在 macOS 安装 launchd 服务、在 Linux 安装 systemd 用户服务，并启动 connector。没有受支持服务管理器的机器可以加 `--foreground`，并保持终端打开。

### 无法直连部署地址的网络

部分网络（典型如未开代理的中国大陆）无法访问 `*.workers.dev` 等域名。请传入代理，让配对请求和长连接都能通过：

```sh
sig connect https://sig.example.com <pairing-code> --proxy http://127.0.0.1:7890
```

不传 `--proxy` 时，`connect` 会捕获环境变量 `HTTPS_PROXY` 并持久化；后台服务、git 和 agent worker 都会继承该代理。可随时用 `sig doctor` 检查连通性，用 `sig proxy` 查看或修改已存储的代理。

配对后，在 Sig 工作台打开**机器**，找到在线机器并点击**添加目录**。选择一个已有目录或输入其绝对路径，Sig 会自动检测是否为 Git 仓库；普通目录也能添加，只是没有分支、worktree 隔离和 PR 支持。等待登记成功后再开始任务。逐个添加允许 Sig 使用的目录，无需重启 connector。

请明确指定仓库路径，不要登记整个 home 目录。

## 管理 connector

```sh
sig status                 # 查看服务、配对、worker 和已登记仓库
sig logs -n 50             # 查看最近日志
sig stop                   # 停止并取消开机自启
sig start                  # 启用并启动
sig restart                # 重启后台服务
sig upgrade                # 安装最新包并重启
sig uninstall              # 移除服务，保留本地状态
```

状态保存在 `~/.sig/`。你可以随时在 Sig 工作台撤销一台电脑。

## 许可证

采用 [MIT License](LICENSE)。
