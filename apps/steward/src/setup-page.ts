// Server-rendered setup page (ADR-0001 decisions 8 and 12): plain HTML, no build chain, no
// client JS. Opens only behind SETUP_TOKEN; the DO 404s it permanently once setup is complete
// (manual flow: the owner's first DM; QR flow: webhook delivery verified — issue #24, ADR
// decision 8's "owner is bound" reads as "onboarding finished", which for the QR flow includes
// the webhook switch). Progress while a scan or the verifying DM is pending comes from a
// `<meta refresh>`, so polling stays server-side. Copy is Chinese to match the product's
// user-facing language.
//
// Post-deploy reachability self-check (issue #25): the page classifies the host it was opened
// on — *.workers.dev vs a custom domain — and says what that means for Feishu's webhook
// delivery (research/feishu-channel.md §3, §9.3). That this page renders at all is the other
// half of the check: the HTML comes from the Durable Object, so Worker + DO + storage are up.
import { renderSVG } from "uqr";
import type { Brand } from "./channel/types.ts";

export type SetupPhase =
  | "start" // nothing configured: QR creation offered, manual entry as the fallback
  | "scan1" // QR #1 (create the app) shown, the DO is alarm-polling
  | "scan2" // QR #2 (add application:application:patch) shown, the DO is alarm-polling
  | "created" // scan #1 done, scan #2 not begun (or its begin failed)
  | "scope_added" // scan #2 done; the config PATCH has not succeeded yet
  | "patched" // PATCH accepted: console republish + verifying DM awaited
  | "failed" // create-flow terminal failure (denied / expired)
  | "awaiting_owner"; // manual credentials saved, the owner's first DM binds (issue #4)

export interface SetupView {
  phase: SetupPhase;
  /** The scan-ready URL the QR encodes (only on scan phases). */
  qrUrl?: string;
  userCode?: string;
  expiresAt?: number;
  appId?: string;
  brand?: Brand;
  /** Error recorded on the QR-flow row (PATCH failure, terminal scan failure…). */
  phaseError?: string;
  /** Top-level submission error (form handling). */
  formError?: string;
  /** Sticky App ID for the manual form. */
  appIdValue?: string;
}

export interface SetupPageOptions {
  view: SetupView;
  actionUrl: string;
  webhookUrl: string;
  /** The host the page was opened on — drives the workers.dev warning. */
  host: string;
}

const MANUAL_STEPS = `<ol>
<li>在 <a href="https://open.feishu.cn/app" rel="noopener">飞书开放平台</a> 创建一个<b>企业自建应用</b>，在「添加应用能力」里开启<b>机器人</b>。</li>
<li>在「凭证与基础信息」页复制 <code>App ID</code>、<code>App Secret</code>、<code>Verification Token</code>（保持「加密策略」关闭，不填 Encrypt Key）。</li>
<li>填入下方表单并提交（会现场校验 App ID / Secret，换取一次 tenant_access_token）。</li>
<li>回到开放平台，「事件与回调」→ 订阅方式选「将事件发送至开发者服务器」，请求地址填
<span class="url">__WEBHOOK_URL__</span>，并添加事件 <code>接收消息 im.message.receive_v1</code>（保存时飞书会立即校验该地址）。</li>
<li><b>创建版本并发布</b>应用（API 发布不能替代这一步）。</li>
<li>在飞书里找到这个机器人，<b>给它发送任意一条私聊消息</b>——发送者即绑定为主人。</li>
</ol>`;

export function renderSetupPage(opts: SetupPageOptions): string {
  const refresh = opts.view.phase === "scan1" || opts.view.phase === "scan2" || opts.view.phase === "patched";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="3">\n` : ""}<title>Shepherd 设置</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; }
  main { max-width: 640px; margin: 0 auto; }
  code, .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .card { border: 1px solid rgba(127,127,127,.35); border-radius: 10px; padding: 20px 24px; margin-top: 20px; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid rgba(127,127,127,.5); border-radius: 6px; font: inherit; background: transparent; color: inherit; }
  button { margin-top: 14px; padding: 8px 22px; border: 0; border-radius: 6px; background: #3370ff; color: #fff; font: inherit; cursor: pointer; }
  button.secondary { background: transparent; border: 1px solid rgba(127,127,127,.5); color: inherit; margin-left: 8px; }
  .error { color: #d5304f; margin-top: 12px; }
  .ok { color: #2ea86f; }
  .warn { border-left: 3px solid #d8a017; padding: 8px 12px; background: rgba(216,160,23,.08); margin-top: 16px; }
  ol { padding-left: 20px; } li { margin: 6px 0; }
  details { margin-top: 28px; }
  summary { cursor: pointer; font-weight: 600; }
  .qr { margin: 16px 0; text-align: center; }
  .qr svg { width: 280px; max-width: 100%; height: auto; background: #fff; border-radius: 8px; padding: 8px; }
  .muted { color: rgba(127,127,127,.9); font-size: 13px; }
  .actions { margin-top: 8px; }
  .step-done { text-decoration: line-through; color: rgba(127,127,127,.8); }
</style>
</head>
<body><main>
<h1>Shepherd 设置</h1>
<p>一次性引导：扫码创建飞书机器人并切换为 webhook 投递，或手动填写凭据。引导完成后，本页面将<b>永久关闭</b>。</p>
${renderReachabilityCheck(opts.host)}
${opts.view.formError ? `<p class="error">${escapeHtml(opts.view.formError)}</p>` : ""}
${renderPhase(opts)}
${renderManualFallback(opts)}
</main></body></html>`;
}

const DEPLOY_GUIDE = "https://github.com/iefnaf/shepherd/blob/main/docs/deploy.md";

/** What a SETUP_TOKEN holder sees once onboarding is complete (ADR-0001 decision 8). The page
 *  stays closed — nothing here configures anything — but it says so, and says what to do next. */
export function renderSetupClosedPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Shepherd 设置已完成</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; }
  main { max-width: 640px; margin: 0 auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; }
  .card { border: 1px solid rgba(127,127,127,.35); border-radius: 10px; padding: 20px 24px; margin-top: 20px; }
  .ok { color: #2ea86f; }
  li { margin: 6px 0; }
</style>
</head>
<body><main>
<h1>Shepherd 设置已完成 <span class="ok">✓</span></h1>
<p>飞书机器人已绑定，事件已通过 webhook 送达。引导按设计已<b>永久关闭</b>：这个页面不再提供任何配置入口（HTTP 状态码仍是 404），也就没人能用它重新配置你的机器人。</p>
<div class="card">
<b>接下来回到飞书，直接给机器人发消息：</b>
<ul>
<li><code>/网页</code>：拿到一次性登录链接（15 分钟、仅一次有效），查看任务时间线与机器管理；</li>
<li><code>/加机器</code>：拿到配对码，用来连接你的电脑；</li>
<li>想让它理解自然语言、派发任务，需要先给部署配置模型 key（<code>MODEL_KEY</code>），见<a href="${DEPLOY_GUIDE}#model-provider">部署指南 · 模型配置</a>。</li>
</ul>
</div>
</main></body></html>`;
}

// Reachability self-check (issue #25, research §3 + §9.3). Shown on every phase: the host you
// open the page on decides whether Feishu's servers (inside mainland China) can deliver
// webhooks to this deployment. `*.workers.dev` is blocked there (DNS pollution + SNI reset,
// verified live); custom domains are usually reachable but not guaranteed — the authoritative
// test is Feishu's own URL validation during the webhook switch, i.e. the QR flow's step 3.
function renderReachabilityCheck(host: string): string {
  const alive = `<p class="ok">✓ 部署自检：本页由你的 Durable Object 渲染——能打开它，说明 Worker、Durable Object 与存储都已正常工作。</p>`;
  const bare = host.replace(/^\[|\]$/g, "");
  if (/(^|\.)localhost$/i.test(host) || bare === "::1" || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return ""; // local wrangler dev: nothing to check
  }
  if (/(^|\.)workers\.dev$/i.test(host)) {
    return `<div class="warn">${alive}
⚠️ 网络自检：你正通过 <code>${escapeHtml(host)}</code>（workers.dev）访问。飞书服务器在国内，
<b>无法访问 <code>*.workers.dev</code></b>（DNS 污染 + SNI 重置，实测）：webhook 事件永远送不到这里，
大陆用户直接打开本页或运行 connector 也需要代理。继续之前：
<ol style="margin:8px 0 0">
<li>为 Worker <b>绑定自定义域名</b>（需要一个托管在 Cloudflare DNS 上的域名）；</li>
<li>用自定义域名重新打开本页（SETUP_TOKEN 不变），自检变为绿色后再继续扫码。</li>
</ol>
<p class="muted" style="margin:8px 0 0">步骤与截图见 <a href="${DEPLOY_GUIDE}#custom-domain" rel="noopener">部署指南 · 自定义域名</a>。大陆网络下 Cloudflare 自定义域名也并非全部可达，最终以第 3 步切换 webhook 时飞书侧的地址校验为准。</p>
</div>`;
  }
  return `<div class="card" style="border-color:#2ea86f">${alive}
<p class="ok">✓ 网络自检：你正通过<b>自定义域名</b> <code>${escapeHtml(host)}</code> 访问，webhook 地址将以它为准。
飞书能否真正送达，以「切换到 webhook」（扫码流程第 3 步，或手动在开放平台保存事件订阅地址）时飞书侧的
地址校验为准——那一步成功即证明可达。</p>
<p class="muted" style="margin:8px 0 0">大陆网络下部分 Cloudflare 域名同样不可达：若切换失败或收不到验证消息，见
<a href="${DEPLOY_GUIDE}#custom-domain" rel="noopener">部署指南 · 自定义域名</a>的排查清单。</p>
</div>`;
}

function renderPhase(opts: SetupPageOptions): string {
  const { view } = opts;
  switch (view.phase) {
    case "start":
      return `<div class="card">
<h2 style="margin-top:0">方式一（推荐）：扫码创建</h2>
<p>用飞书 App 扫码，一键创建一个专属机器人：扫码人即绑定为主人，无需填写任何凭据。共需扫两次码，
中途在开发者控制台手动「发布」一次，最后给机器人发条私聊消息即完成。</p>
<form method="post" action="${escapeHtml(opts.actionUrl)}">
<input type="hidden" name="action" value="start_qr">
<button type="submit">生成二维码，开始扫码创建</button>
</form>
</div>`;

    case "scan1":
      return qrCard({
        title: "第 1 步 · 扫码创建机器人",
        body: `用飞书 App 扫描下方二维码，在确认页<b>点击确认</b>。机器人将以
<code>${escapeHtml(prefillNameFromQrUrl(view.qrUrl))}</code> 为默认名称创建（名称用于区分不同部署，可修改）。
扫码并确认后本页面会自动刷新。`,
        actionUrl: opts.actionUrl,
        restartAction: "start_qr",
        restartLabel: "重新生成二维码",
        ...qrCommon(view),
      });

    case "scan2":
      return `<div class="card">
<p class="ok">✓ 第 1 步完成：机器人 <code>${escapeHtml(view.appId ?? "")}</code> 已创建，<b>你已绑定为主人</b>${
        view.brand === "lark" ? "（Lark 国际版账号）" : ""
      }。</p>
</div>` + qrCard({
        title: "第 2 步 · 再扫一次，添加切换权限",
        body: `切换 webhook 需要给机器人追加 <code>${escapeHtml("application:application:patch")}</code> 权限。
用飞书 App 扫描下方二维码，确认页会显示将要添加的权限，<b>点击确认</b>即可（App Secret 不会轮换）。`,
        actionUrl: opts.actionUrl,
        restartAction: "start_scope_scan",
        restartLabel: "重新生成二维码",
        extraButton: `<form method="post" action="${escapeHtml(opts.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="patch_webhook">
<button type="submit" class="secondary">已在控制台手动添加权限，直接切换</button>
</form>`,
        ...qrCommon(view),
      });

    case "created":
      return `<div class="card">
<p class="ok">✓ 机器人 <code>${escapeHtml(view.appId ?? "")}</code> 已创建，<b>你已绑定为主人</b>。</p>
<h2>第 2 步 · 添加切换权限</h2>
<p>下一步需要再扫一次码，为机器人追加 <code>${escapeHtml("application:application:patch")}</code> 权限
（也可在开放平台「权限管理」里手动开通）。</p>
${view.phaseError ? `<p class="error">${escapeHtml(view.phaseError)}</p>` : ""}
<div class="actions">
<form method="post" action="${escapeHtml(opts.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="start_scope_scan">
<button type="submit">生成第二步二维码</button>
</form>
<form method="post" action="${escapeHtml(opts.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="patch_webhook">
<button type="submit" class="secondary">已手动添加权限，直接切换</button>
</form>
</div>
</div>`;

    case "scope_added":
      return `<div class="card">
<p class="ok">✓ 权限已添加：机器人 <code>${escapeHtml(view.appId ?? "")}</code> 已具备 <code>${escapeHtml("application:application:patch")}</code>。</p>
<h2>第 3 步 · 切换为 webhook 投递</h2>
<p>把事件与回调的投递方式切换到 <span class="url">${escapeHtml(opts.webhookUrl)}</span>。</p>
${view.phaseError ? `<p class="error">${escapeHtml(view.phaseError)}</p>` : ""}
<p class="muted">若重试仍报权限错误：到开放平台「权限管理」搜索 <code>application:application:patch</code> 手动开通后再重试。</p>
<div class="actions">
<form method="post" action="${escapeHtml(opts.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="patch_webhook">
<button type="submit">切换到 webhook</button>
</form>
<form method="post" action="${escapeHtml(opts.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="start_scope_scan">
<button type="submit" class="secondary">重新扫码添加权限</button>
</form>
</div>
</div>`;

    case "patched":
      return `<div class="card">
<p class="ok">✓ 配置已切换：事件与回调将投递到 <span class="url">${escapeHtml(opts.webhookUrl)}</span>（飞书已完成地址校验）。</p>
<h2>第 4 步 · 控制台发布 + 验证</h2>
<ol>
<li>打开 <a href="${escapeHtml(consoleUrl(view.brand, view.appId))}" rel="noopener">开发者控制台</a>
→「版本管理与发布」→ <b>创建版本并发布</b>。<b>API 发布不能替代这一步</b>：不重新发布，事件仍走长连接，不会到达这里。</li>
<li>发布完成后，<b>在飞书里给机器人发送任意一条私聊消息</b>。消息一旦到达，即证明投递已真正切换，本页面会自动关闭。</li>
</ol>
${view.phaseError ? `<p class="error">${escapeHtml(view.phaseError)}</p>` : ""}
<p class="muted">已发布但仍未收到消息？可能是配置与发布时序不同步：先
<form method="post" action="${escapeHtml(opts.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="patch_webhook">
<button type="submit" class="secondary" style="margin:0">重新执行一次切换</button>
</form>，再重发一条私聊消息。</p>
</div>`;

    case "failed":
      return `<div class="card">
<p class="error">${escapeHtml(view.phaseError ?? "扫码流程失败。")}</p>
<form method="post" action="${escapeHtml(opts.actionUrl)}">
<input type="hidden" name="action" value="start_qr">
<button type="submit">重新生成二维码</button>
</form>
</div>`;

    case "awaiting_owner":
      return `<div class="card">
<p class="ok">✓ 凭据已保存并校验通过。</p>
<ol>
<li>若还未配置：在开放平台「事件与回调」里，订阅方式选「将事件发送至开发者服务器」，请求地址填
<span class="url">${escapeHtml(opts.webhookUrl)}</span>，添加事件 <code>im.message.receive_v1</code>。</li>
<li><b>创建版本并发布</b>应用。</li>
<li>在飞书里给机器人<b>发送任意一条私聊消息</b>——发送者即绑定为主人，绑定后此页面立即关闭。</li>
</ol>
<p>当前状态：<b>等待主人首次私聊</b>。</p>
</div>`;
  }
}

function qrCommon(view: SetupView): { qrSvg: string; qrUrl: string; userCode: string; expiresAt?: number; phaseError?: string } {
  return {
    qrSvg: renderSVG(view.qrUrl ?? "", { ecc: "M" }),
    qrUrl: view.qrUrl ?? "",
    userCode: view.userCode ?? "",
    expiresAt: view.expiresAt,
    phaseError: view.phaseError,
  };
}

interface QrCardOptions {
  title: string;
  body: string;
  actionUrl: string;
  restartAction: string;
  restartLabel: string;
  extraButton?: string;
  qrSvg: string;
  qrUrl: string;
  userCode: string;
  expiresAt?: number;
  phaseError?: string;
}

function qrCard(o: QrCardOptions): string {
  const minutes = typeof o.expiresAt === "number" ? Math.max(0, Math.round((o.expiresAt - Date.now()) / 60_000)) : undefined;
  return `<div class="card">
<h2 style="margin-top:0">${o.title}</h2>
<p>${o.body}</p>
<div class="qr">${o.qrSvg}</div>
<p class="muted">二维码约 ${minutes ?? "??"} 分钟内有效、一次性。国内版飞书 App 偶尔对二维码无反应：在手机浏览器中直接打开
<a href="${escapeHtml(o.qrUrl)}" rel="noopener">这个链接</a>效果相同；或改用下方手动凭据。</p>
${o.phaseError ? `<p class="error">${escapeHtml(o.phaseError)}</p>` : ""}
<div class="actions">
<form method="post" action="${escapeHtml(o.actionUrl)}" style="display:inline">
<input type="hidden" name="action" value="${escapeHtml(o.restartAction)}">
<button type="submit" class="secondary">${escapeHtml(o.restartLabel)}</button>
</form>
${o.extraButton ?? ""}
</div>
</div>`;
}

function renderManualFallback(opts: SetupPageOptions): string {
  return `<details>
<summary>方式二（备用）：手动填写应用凭据</summary>
<div class="card">
${MANUAL_STEPS.replace("__WEBHOOK_URL__", escapeHtml(opts.webhookUrl))}
<form method="post" action="${escapeHtml(opts.actionUrl)}">
<input type="hidden" name="action" value="manual">
<label for="appId">App ID（cli_…）</label>
<input id="appId" name="appId" value="${escapeHtml(opts.view.appIdValue ?? "")}" placeholder="cli_xxxxxxxx" required autocomplete="off">
<label for="appSecret">App Secret</label>
<input id="appSecret" name="appSecret" type="password" required autocomplete="off">
<label for="verificationToken">Verification Token</label>
<input id="verificationToken" name="verificationToken" required autocomplete="off">
<button type="submit">保存并校验</button>
</form>
<p class="muted">手动提交会取消进行中的扫码流程；若填入的是另一个应用的凭据，主人绑定会重置。</p>
</div>
</details>`;
}

/** Display-only echo of the prefilled name (it rides the QR URL's `name` param). */
function prefillNameFromQrUrl(qrUrl: string | undefined): string {
  if (!qrUrl) return "Shepherd";
  try {
    return new URL(qrUrl).searchParams.get("name") ?? "Shepherd";
  } catch {
    return "Shepherd";
  }
}

function consoleUrl(brand: Brand | undefined, appId: string | undefined): string {
  const base = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  return `${base}/app/${appId ?? ""}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
