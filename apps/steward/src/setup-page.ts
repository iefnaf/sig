// Server-rendered setup page (ADR-0001 decisions 8 and 12): plain HTML, no build chain, no
// client JS. Opens only behind SETUP_TOKEN; the DO 404s it permanently once the owner is
// bound. Copy is Chinese to match the product's user-facing language.

export interface SetupPageOptions {
  state: "form" | "awaiting_owner";
  actionUrl: string;
  webhookUrl: string;
  error?: string;
  appIdValue?: string;
}

export function renderSetupPage(opts: SetupPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Shepherd 设置</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; }
  main { max-width: 640px; margin: 0 auto; }
  code, .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .card { border: 1px solid rgba(127,127,127,.35); border-radius: 10px; padding: 20px 24px; margin-top: 20px; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid rgba(127,127,127,.5); border-radius: 6px; font: inherit; background: transparent; color: inherit; }
  button { margin-top: 18px; padding: 8px 22px; border: 0; border-radius: 6px; background: #3370ff; color: #fff; font: inherit; cursor: pointer; }
  .error { color: #d5304f; margin-top: 12px; }
  .ok { color: #2ea86f; }
  ol { padding-left: 20px; } li { margin: 6px 0; }
</style>
</head>
<body><main>
<h1>Shepherd 设置</h1>
<p>一次性引导：填入飞书自建应用凭据，绑定主人账号。绑定完成后，本页面将<b>永久关闭</b>。</p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
${
  opts.state === "form"
    ? renderForm(opts)
    : renderAwaitingOwner(opts)
}
</main></body></html>`;
}

function renderForm(opts: SetupPageOptions): string {
  return `<div class="card">
<ol>
<li>在 <a href="https://open.feishu.cn/app" rel="noopener">飞书开放平台</a> 创建一个<b>企业自建应用</b>，在「添加应用能力」里开启<b>机器人</b>。</li>
<li>在「凭证与基础信息」页复制 <code>App ID</code>、<code>App Secret</code>、<code>Verification Token</code>（保持「加密策略」关闭，不填 Encrypt Key）。</li>
<li>填入下方表单并提交（会现场校验 App ID / Secret，换取一次 tenant_access_token）。</li>
<li>回到开放平台，「事件与回调」→ 订阅方式选「将事件发送至开发者服务器」，请求地址填
<span class="url">${escapeHtml(opts.webhookUrl)}</span>，并添加事件 <code>接收消息 im.message.receive_v1</code>（保存时飞书会立即校验该地址）。</li>
<li><b>创建版本并发布</b>应用（API 发布不能替代这一步）。</li>
<li>在飞书里找到这个机器人，<b>给它发送任意一条私聊消息</b>——发送者即绑定为主人。</li>
</ol>
<form method="post" action="${escapeHtml(opts.actionUrl)}">
<label for="appId">App ID（cli_…）</label>
<input id="appId" name="appId" value="${escapeHtml(opts.appIdValue ?? "")}" placeholder="cli_xxxxxxxx" required autocomplete="off">
<label for="appSecret">App Secret</label>
<input id="appSecret" name="appSecret" type="password" required autocomplete="off">
<label for="verificationToken">Verification Token</label>
<input id="verificationToken" name="verificationToken" required autocomplete="off">
<button type="submit">保存并校验</button>
</form>
</div>`;
}

function renderAwaitingOwner(opts: SetupPageOptions): string {
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

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
