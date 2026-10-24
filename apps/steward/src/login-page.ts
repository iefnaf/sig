import { BRAND_HEAD, BRAND_LOCKUP, BRAND_STYLE } from "./brand.ts";

export const LOGIN_SCRIPT_PATH = "/login.js";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

export function loginPage(message = "", status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in - Sig</title>
${BRAND_HEAD}
<style>${BRAND_STYLE}
:root{--page:#fcfcfa;--surface:#fff;--ink:#292e2a;--muted:#777c75;--line:#e8e9e2;--green:#37624d;--green-soft:#eaf0e9}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% 0%,var(--green-soft),transparent 65%),var(--page);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:32px 20px}main{width:100%;max-width:420px}.sig-brand{font-size:24px;margin-bottom:28px}h1{font-size:30px;letter-spacing:-.04em;line-height:1.2;margin:0 0 10px}.intro{color:var(--muted);margin:0 0 28px}.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 12px 40px #292e2a06}label{display:block;font-weight:600;margin-bottom:8px}input,button{font:inherit}input{width:100%;border:1px solid #c8cec5;border-radius:8px;padding:12px;background:var(--surface);color:var(--ink);min-width:0}button{width:100%;padding:12px 16px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer;font-weight:600}button.primary{background:var(--green);color:#fff;border-color:var(--green);margin-top:14px}button:disabled{opacity:.6;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--green);outline-offset:3px}.divider{display:flex;align-items:center;gap:14px;color:var(--muted);font-size:12px;margin:22px 0}.divider:before,.divider:after{content:"";height:1px;background:var(--line);flex:1}.status{font-size:13px;margin:12px 0 0;color:#9b332a}.notice{background:var(--green-soft);padding:12px 16px;border-radius:8px;margin-bottom:20px;font-size:13px}.recovery{color:var(--muted);font-size:13px;margin-top:24px}summary{cursor:pointer;color:var(--ink)}details p{margin:12px 0 0}code{font-size:12px;overflow-wrap:anywhere}.footer{color:var(--muted);font-size:12px;text-align:center;margin-top:20px}[hidden]{display:none!important}@media(max-width:440px){.card{padding:22px}body{padding:24px 16px}}
</style></head>
<body><main>
${BRAND_LOCKUP}
<h1 data-copy="heading">Welcome back.</h1>
<p class="intro" data-copy="intro">Sign in to your personal agent.</p>
<p class="notice" ${message ? "" : "hidden"}>${escapeHtml(message)}</p>
<p id="reauth-notice" class="notice" hidden data-copy="reauth">Sign in again to change your security settings.</p>
<section class="card" aria-label="Sign in">
<form id="password-form">
<label for="login-password" data-copy="password">Deployment password</label>
<input id="login-password" name="password" type="password" required maxlength="128" autocomplete="current-password" aria-describedby="password-status" autofocus>
<button id="password-signin" class="primary" type="submit" data-copy="passwordSignIn">Sign in</button>
<p id="password-status" class="status" role="status" aria-live="polite" hidden></p>
</form>
<div id="passkey-divider" class="divider" hidden data-copy="or">or</div>
<button id="passkey-signin" type="button" hidden data-copy="passkeySignIn">Sign in with a passkey</button>
<p id="passkey-status" class="status" role="status" aria-live="polite" hidden></p>
<details class="recovery"><summary data-copy="recoveryTitle">Forgot your password?</summary>
<p data-copy="recovery">In the Cloudflare dashboard, open your Worker, then Settings &gt; Variables and Secrets. Set LOGIN_PASSWORD to a new, unique password of at least 15 characters and deploy the change. This signs out all browsers without deleting your data or disconnecting your machines.</p></details>
<noscript><p class="status">Enable JavaScript to sign in.</p></noscript>
</section>
<p class="footer" data-copy="footer">Your own agent. Your own workspace.</p>
<script type="module" src="${LOGIN_SCRIPT_PATH}"></script>
</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
