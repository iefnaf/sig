// Public identity; durable storage and protocol identifiers keep their original names
// so a rebrand does not reset an existing deployment (ADR-0002).
export const LOGO_PATH = "/brand/sig.svg";
export const AVATAR_PATH = "/brand/sig-avatar.png";
export const BRAND_HEAD = `<link rel="icon" type="image/svg+xml" href="${LOGO_PATH}">
<meta name="theme-color" content="#1c3656">`;
export const BRAND_LOCKUP = `<span class="sig-brand"><img src="${LOGO_PATH}" width="32" height="32" alt=""><span>Sig</span></span>`;
export const BRAND_STYLE = `.sig-brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 700; letter-spacing: -.03em; vertical-align: middle; }
.sig-brand img { display: block; flex: none; }`;
