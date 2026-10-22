// The pre-session passkey sign-in script (ADR-0005). Served as its own public asset, next to
// LOGO_PATH/AVATAR_PATH (index.ts) — the sign-in page has no session, so it cannot reach
// anything under the session-gated /app/assets/* tree, including i18n.js. It carries its own
// tiny inline string table instead, reading the same `pip.locale` key i18n.js uses, for a
// consistent language choice without sharing any code with it.
const STRINGS = {
  signIn: ['Sign in with a passkey', '使用通行密钥登录'],
  failed: ['Couldn’t sign in with that passkey. Try again, or use a login link.', '通行密钥登录失败，请重试，或使用登录链接。'],
  unsupported: ['This browser doesn’t support passkeys.', '当前浏览器不支持通行密钥。'],
};

function locale() {
  try {
    if (localStorage.getItem('pip.locale') === 'zh') return 'zh';
  } catch {
    // Storage can be blocked (private mode, embedded views); fall through to navigator.language.
  }
  return navigator.language && navigator.language.startsWith('zh') ? 'zh' : 'en';
}

const t = (key) => STRINGS[key][locale() === 'zh' ? 1 : 0];

function b64urlToBuffer(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const button = document.getElementById('passkey-signin');
const status = document.getElementById('passkey-status');

function showError() {
  status.textContent = t('failed');
  status.hidden = false;
}

async function signInWithPasskey() {
  button.disabled = true;
  status.hidden = true;
  try {
    const optionsRes = await fetch('/webauthn/login/options', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    if (!optionsRes.ok) throw new Error('options_failed');
    const { challenge, challengeToken, rpId } = await optionsRes.json();
    let credential;
    try {
      credential = await navigator.credentials.get({
        publicKey: { challenge: b64urlToBuffer(challenge), rpId, userVerification: 'preferred', timeout: 60000 },
      });
    } catch {
      // The user cancelled the platform prompt, or no matching passkey is on this device.
      showError();
      return;
    }
    const verify = await fetch('/webauthn/login/verify', {
      method: 'POST',
      credentials: 'same-origin',
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
      location.assign('/app');
      return;
    }
    showError();
  } catch {
    showError();
  } finally {
    button.disabled = false;
  }
}

if (window.PublicKeyCredential) {
  button.textContent = t('signIn');
  button.hidden = false;
  button.addEventListener('click', () => { void signInWithPasskey(); });
} else {
  status.textContent = t('unsupported');
  status.hidden = false;
}
