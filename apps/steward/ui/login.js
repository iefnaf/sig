const STRINGS = {
  heading: ['Welcome back.', '欢迎回来。'],
  intro: ['Sign in to your personal agent.', '登录你的个人智能体。'],
  password: ['Deployment password', '部署密码'],
  passwordSignIn: ['Sign in', '登录'],
  signingIn: ['Signing in…', '正在登录…'],
  or: ['or', '或'],
  passkeySignIn: ['Sign in with a passkey', '使用通行密钥登录'],
  failed: ['Couldn’t sign in with that passkey. Try again, or use your password.', '通行密钥登录失败，请重试或使用密码。'],
  cancelled: ['Passkey sign-in was cancelled. Try again, or use your password.', '已取消通行密钥登录，可以重试或使用密码。'],
  unsupported: ['Passkeys aren’t available in this browser. You can sign in with your password.', '当前浏览器无法使用通行密钥，你可以使用密码登录。'],
  invalid: ['Incorrect password. Try again.', '密码错误，请重试。'],
  unavailable: ['Password sign-in is unavailable. The configured password may have been rejected by the policy; open "Forgot your password?" below for the dashboard fix. Temporary outages clear on retry.', '密码登录暂不可用。配置的密码可能未通过规则检查，请按下方「忘记密码？」的步骤在 Cloudflare 控制台修复。临时故障稍后重试即可。'],
  rejected: ['The deployment password does not meet the password requirements. Set LOGIN_PASSWORD to a new, unique password of at least 15 characters in Cloudflare, then deploy the change. Follow the steps below.', '部署密码未通过 Sig 的规则检查。请在 Cloudflare 中将 LOGIN_PASSWORD 改为新的独立密码（至少 15 个字符），然后部署更新。操作步骤已在下方展开。'],
  notConfigured: ['No deployment password is configured. Set LOGIN_PASSWORD in Cloudflare to a new, unique password of at least 15 characters, then deploy the change. Follow the steps below.', '尚未配置部署密码。请在 Cloudflare 中设置 LOGIN_PASSWORD，使用新的独立密码（至少 15 个字符），然后部署更新。操作步骤已在下方展开。'],
  screeningUnavailable: ['Password safety checks are temporarily unavailable. Try again in a minute, or use a passkey. You do not need to change your password for this error.', '密码安全检查服务暂时不可用。请一分钟后重试，或使用通行密钥。此错误不需要修改密码。'],
  network: ['Couldn’t reach Sig. Check your connection and try again.', '无法连接 Sig，请检查网络后重试。'],
  retry: ['Too many attempts. Try again in {seconds}s, or use a passkey.', '尝试次数过多，请在 {seconds} 秒后重试，或使用通行密钥。'],
  retryPasskey: ['Too many passkey attempts. Try again in {seconds}s, or use your password.', '通行密钥尝试次数过多，请在 {seconds} 秒后重试，或使用密码。'],
  retryReady: ['You can try again now.', '现在可以重新尝试。'],
  recoveryTitle: ['Forgot your password?', '忘记密码？'],
  recovery: ['In the Cloudflare dashboard, open your Worker, then Settings > Variables and Secrets. Set LOGIN_PASSWORD to a new, unique password of at least 15 characters and deploy the change. This signs out all browsers without deleting your data or disconnecting your machines.', '在 Cloudflare 控制台打开你的 Worker，进入 Settings > Variables and Secrets，将 LOGIN_PASSWORD 修改为新的独立密码（至少 15 个字符），然后部署更新。所有浏览器会退出登录，但数据和已连接的机器不会受到影响。'],
  reauth: ['Sign in again to change your security settings.', '请重新登录以修改安全设置。'],
  footer: ['Your own agent. Your own workspace.', '你的智能体，你的工作台。'],
};

function locale() {
  try {
    const saved = localStorage.getItem('pip.locale');
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {}
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}

const language = locale();
const t = (key) => STRINGS[key][language === 'zh' ? 1 : 0];
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
for (const element of document.querySelectorAll('[data-copy]')) element.textContent = t(element.dataset.copy);
const query = new URLSearchParams(location.search);
document.getElementById('reauth-notice').hidden = query.get('reauth') !== '1';
const requestedNext = query.get('next') ?? (location.pathname.startsWith('/app') ? location.pathname : null);
const nextPath = requestedNext && /^\/app(?:\/|$)/.test(requestedNext) ? requestedNext : '/app';

function b64urlToBuffer(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function bufferToB64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const passwordForm = document.getElementById('password-form');
const passwordInput = document.getElementById('login-password');
const passwordButton = document.getElementById('password-signin');
const passwordStatus = document.getElementById('password-status');
const passkeyButton = document.getElementById('passkey-signin');
const passkeyStatus = document.getElementById('passkey-status');
let retryAt = 0;
let retryTimer;
let passkeyRetryAt = 0;
let passkeyRetryTimer;

function showStatus(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function startCooldown(retryAfter, button = passwordButton, status = passwordStatus, getRetryAt = () => retryAt) {
  const seconds = Number(retryAfter);
  const deadline = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
  const deadlineAt = Number.isFinite(deadline) && deadline > Date.now() ? deadline : Date.now() + 60_000;
  if (button === passwordButton) retryAt = deadlineAt;
  else passkeyRetryAt = deadlineAt;
  const timer = button === passwordButton ? retryTimer : passkeyRetryTimer;
  clearInterval(timer);
  const update = () => {
    const remaining = Math.max(0, Math.ceil((getRetryAt() - Date.now()) / 1000));
    button.disabled = remaining > 0;
    const retryCopy = button === passwordButton ? 'retry' : 'retryPasskey';
    showStatus(status, remaining ? t(retryCopy).replace('{seconds}', String(remaining)) : t('retryReady'));
    if (!remaining) clearInterval(timer);
  };
  update();
  if (button === passwordButton) retryTimer = setInterval(update, 1000);
  else passkeyRetryTimer = setInterval(update, 1000);
}

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (passwordButton.disabled || Date.now() < retryAt) return;
  passwordButton.disabled = true;
  passwordButton.textContent = t('signingIn');
  passwordStatus.hidden = true;
  try {
    const response = await fetch('/auth/password', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (response.status === 200) {
      passwordInput.value = '';
      location.assign(nextPath);
    } else if (response.status === 429) {
      startCooldown(response.headers.get('retry-after'));
    } else if (response.status === 503) {
      const body = await response.json().catch(() => null);
      const error = body?.error;
      const copy = error === 'password_rejected' ? 'rejected'
        : error === 'password_not_configured' ? 'notConfigured'
        : error === 'password_screening_unavailable' ? 'screeningUnavailable'
        : 'unavailable';
      showStatus(passwordStatus, t(copy));
      if (error === 'password_rejected' || error === 'password_not_configured') {
        document.querySelector('details.recovery').open = true;
      }
    } else {
      showStatus(passwordStatus, t(response.status === 401 ? 'invalid' : 'network'));
    }
  } catch {
    showStatus(passwordStatus, t('network'));
  } finally {
    passwordButton.textContent = t('passwordSignIn');
    passwordButton.disabled = Date.now() < retryAt;
  }
});

async function signInWithPasskey() {
  if (passkeyButton.disabled || Date.now() < passkeyRetryAt) return;
  passkeyButton.disabled = true;
  passkeyStatus.hidden = true;
  try {
    const optionsResponse = await fetch('/webauthn/login/options', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (optionsResponse.status === 429) {
      startCooldown(optionsResponse.headers.get('retry-after'), passkeyButton, passkeyStatus, () => passkeyRetryAt);
      return;
    }
    if (!optionsResponse.ok) throw new Error('options_failed');
    const { challenge, challengeToken, rpId } = await optionsResponse.json();
    let credential;
    try {
      credential = await navigator.credentials.get({
        publicKey: { challenge: b64urlToBuffer(challenge), rpId, userVerification: 'preferred', timeout: 60000 },
      });
    } catch (error) {
      showStatus(passkeyStatus, t(error.name === 'NotAllowedError' || error.name === 'AbortError' ? 'cancelled' : 'failed'));
      return;
    }
    if (!credential) {
      showStatus(passkeyStatus, t('cancelled'));
      return;
    }
    const verify = await fetch('/webauthn/login/verify', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeToken,
        credentialId: bufferToB64url(credential.rawId),
        clientDataJSON: bufferToB64url(credential.response.clientDataJSON),
        authenticatorData: bufferToB64url(credential.response.authenticatorData),
        signature: bufferToB64url(credential.response.signature),
      }),
    });
    if (verify.status === 200) {
      location.assign(nextPath);
      return;
    }
    if (verify.status === 429) {
      startCooldown(verify.headers.get('retry-after'), passkeyButton, passkeyStatus, () => passkeyRetryAt);
      return;
    }
    showStatus(passkeyStatus, t('failed'));
  } catch {
    showStatus(passkeyStatus, t('failed'));
  } finally {
    passkeyButton.disabled = Date.now() < passkeyRetryAt;
  }
}

if (window.PublicKeyCredential && navigator.credentials?.get) {
  passkeyButton.hidden = false;
  document.getElementById('passkey-divider').hidden = false;
  passkeyButton.addEventListener('click', () => { void signInWithPasskey(); });
} else {
  showStatus(passkeyStatus, t('unsupported'));
}
