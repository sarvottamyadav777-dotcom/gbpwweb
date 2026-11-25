import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import vm from 'vm';

const PORT = 3000;
const UPSTREAM_ORIGIN = 'https://s2-cdn.studyratna.cc';
const PLAYER_UPSTREAM_ORIGIN = 'https://s4-cdn.samfygros.com';
const BRAND_NAME = 'GB STUDY';
const TELEGRAM_URL = 'https://t.me/GBFreestudy';
const ICON_SOURCE_URL = 'https://i.ibb.co/Q3g9fGSt/1791541921524.png';
const ICON_PATH = '/gb-icon.png';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedIconBuffer: Buffer | null = null;
let cachedIconContentType = 'image/png';

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: unknown }).message || '').toLowerCase();
  const cause = (err as { cause?: { code?: unknown; message?: unknown; name?: unknown } }).cause;
  const causeCode = String(cause?.code || '').toUpperCase();
  const causeMsg = String(cause?.message || '').toLowerCase();
  const causeName = String(cause?.name || '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    msg.includes('aborted') ||
    causeName.includes('socketerror') ||
    causeMsg.includes('other side closed') ||
    causeMsg.includes('socket') ||
    causeCode === 'UND_ERR_SOCKET' ||
    causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    causeCode === 'UND_ERR_BODY_TIMEOUT' ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'EPIPE'
  );
}

async function fetchUpstreamResponse(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
): Promise<{ res: globalThis.Response; buffer: Buffer }> {
  let lastErr: unknown;
  const rawBody =
    init.body instanceof Uint8Array
      ? init.body
      : Buffer.isBuffer(init.body)
        ? new Uint8Array(init.body)
        : init.body;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const attemptInit: RequestInit = {
        ...init,
        body: rawBody instanceof Uint8Array ? new Uint8Array(rawBody) : rawBody,
        signal: AbortSignal.timeout(25000),
      };
      const res = await fetch(url, attemptInit);
      const buffer = Buffer.from(await res.arrayBuffer());
      return { res, buffer };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && isTransientNetworkError(err)) {
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function loadIconBuffer(): Promise<Buffer | null> {
  if (cachedIconBuffer) return cachedIconBuffer;
  try {
    const { res, buffer } = await fetchUpstreamResponse(ICON_SOURCE_URL, {
      headers: { 'User-Agent': DEFAULT_UA },
    });
    if (res.ok) {
      cachedIconBuffer = buffer;
      const ct = res.headers.get('content-type');
      if (ct && ct.startsWith('image/')) {
        cachedIconContentType = ct;
      }
      return cachedIconBuffer;
    }
  } catch (err) {
    console.warn('Failed to preload icon:', err instanceof Error ? err.message : String(err));
  }
  return null;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

function rewriteSetCookieHeader(cookieStr: string, isHttps: boolean): string {
  const parts = cookieStr
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return cookieStr;

  const filtered = parts.filter((part) => {
    const lower = part.toLowerCase();
    if (lower.startsWith('domain=')) return false;
    if (lower.startsWith('samesite=')) return false;
    if (lower === 'secure') return false;
    if (lower === 'partitioned') return false;
    return true;
  });

  if (isHttps) {
    filtered.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    filtered.push('SameSite=Lax');
  }
  return filtered.join('; ');
}

function parseCookieMap(cookieHeader: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (name) map.set(name, val);
  }
  return map;
}

function serializeCookieMap(map: Map<string, string>): string {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

const SERVER_MANAGED_COOKIE_NAMES = new Set([
  '__host-access_token',
  '__host-client_id',
  '__host-gen_start',
  '_gb_play_sid',
]);

function isPlayerRoute(pathname: string): boolean {
  return (
    pathname.endsWith('/play.php') ||
    pathname.endsWith('/api/video-url-details.php') ||
    pathname.endsWith('/api/e2e-status-proxy.php') ||
    pathname.endsWith('/api/token-manager.php') ||
    pathname.endsWith('/api/generate-download-token.php') ||
    pathname.endsWith('/api/turnstile_verifier.php') ||
    pathname.startsWith('/downloader.js')
  );
}

function forwardSetCookies(upstreamRes: globalThis.Response, req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  const rawCookies =
    typeof upstreamRes.headers.getSetCookie === 'function'
      ? upstreamRes.headers.getSetCookie()
      : [];
  const filtered = rawCookies.filter((raw) => {
    const eqIdx = raw.indexOf('=');
    const name = (eqIdx === -1 ? raw : raw.slice(0, eqIdx)).trim().toLowerCase();
    return !SERVER_MANAGED_COOKIE_NAMES.has(name);
  });
  if (filtered.length > 0) {
    res.setHeader(
      'Set-Cookie',
      filtered.map((c) => rewriteSetCookieHeader(c, isHttps)),
    );
  }
}

function rewriteTelegramUrls(text: string): string {
  return text
    .replace(/https?:\/\/(?:t\.me|telegram\.me)\/[^\s"'<>\\)]+/gi, TELEGRAM_URL)
    .replace(/https?:\/\/channel\.studyrays\.cc[^\s"'<>\\)]*/gi, TELEGRAM_URL);
}

function rewriteBrandText(text: string): string {
  return text
    .replace(/(?<!s2-cdn\.)\bStudyRatna(?:\.cc)?\b/gi, BRAND_NAME)
    .replace(/\bStudy\s+Ratna\b/gi, BRAND_NAME)
    .replace(/\bStudyRays(?:\s*x\s*DevJisu)?\b/gi, BRAND_NAME)
    .replace(/\bRatna\s+Bhai\b/gi, BRAND_NAME);
}

function patchPlainScript(code: string): string {
  let out = code;
  // Bypass plain allowedOrigins domain allowlists (e.g. /start-dpp-test/script.js ORIGIN_MISMATCH_403)
  out = out.replace(
    /((?:const|let|var)\s+allowedOrigins\s*=\s*\[[^\]]*\])/g,
    '$1.concat([window.location.hostname])',
  );
  // Keep in-app navigation (e.g. Leave Quiz redirect) on our proxy origin instead of external mirrors
  out = out.replace(
    /https?:\/\/(?:streamfiles\.eu\.org|testfile\.eu\.org|s2-cdn\.studyratna\.cc|s[34]-cdn\.samfygros\.com)\/#/gi,
    '/#',
  );
  out = rewriteTelegramUrls(out);
  out = rewriteBrandText(out);
  return out;
}

function unlockHtmlInlineScripts(html: string): string {
  return html.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_full, openTag: string, body: string, closeTag: string) => {
      if (!body.includes('Array.prototype.slice.call(arguments)')) {
        const patched = body.includes('allowedOrigins')
          ? body.replace(
              /((?:const|let|var)\s+allowedOrigins\s*=\s*\[[^\]]*\])/g,
              '$1.concat([window.location.hostname])',
            )
          : body;
        return `${openTag}${patched}${closeTag}`;
      }
      return `${openTag}${unlockObfuscatedScript(body)}${closeTag}`;
    },
  );
}

function rewriteHtml(html: string): string {
  let out = html;

  // Strip stray banners before <!DOCTYPE html> (e.g. s4-cdn Thank You wrapper) so Standards Mode stays intact
  out = out.replace(
    /^(?:\s*<!--[\s\S]*?-->\s*|<div\b[^>]*>\s*<span\b[^>]*>[^<]*Thank you[^<]*<\/span>\s*<\/div>\s*)+(?=<!DOCTYPE\s+html>)/i,
    '',
  );

  // Replace known site logos with local proxied icon
  out = out.replace(
    /https:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=tbn:ANd9GcT1fXfQMfsh9IK27z-hikKlLU2h8R_A9XUaLg&s/gi,
    ICON_PATH,
  );

  // Replace alt text for logos
  out = out.replace(/alt=["'](?:Physics Wallah|StudyRatna|StudyRays) Logo["']/gi, `alt="${BRAND_NAME} Logo"`);

  // Replace popup emoji/icon with GB STUDY icon
  out = out.replace(
    /<div id="srIcon">[\s\S]*?<\/div>/i,
    `<div id="srIcon" style="overflow:hidden;padding:0;"><img src="${ICON_PATH}" alt="${BRAND_NAME}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`,
  );

  // Rewrite Telegram links and brand names
  out = rewriteTelegramUrls(out);
  out = rewriteBrandText(out);

  // Ensure <title> and favicon are set to GB STUDY
  if (/<title>[^<]*<\/title>/i.test(out)) {
    out = out.replace(/<title>([^<]*)<\/title>/i, (_m, titleText: string) => {
      if (/studyratna|studyrays|study\s*ratna/i.test(titleText) || !titleText.trim()) {
        return `<title>${BRAND_NAME}</title>`;
      }
      return `<title>${rewriteBrandText(titleText)}</title>`;
    });
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1><title>${BRAND_NAME}</title>`);
  }

  // Inject favicon if not already pointing to ICON_PATH
  if (!out.includes(ICON_PATH) && /<\/head>/i.test(out)) {
    out = out.replace(
      /<\/head>/i,
      `<link rel="icon" type="image/png" href="${ICON_PATH}"><link rel="shortcut icon" type="image/png" href="${ICON_PATH}"></head>`,
    );
  } else if (/<head[^>]*>/i.test(out) && !/rel=["'](?:shortcut )?icon["']/i.test(out)) {
    out = out.replace(
      /<head([^>]*)>/i,
      `<head$1><link rel="icon" type="image/png" href="${ICON_PATH}"><link rel="shortcut icon" type="image/png" href="${ICON_PATH}">`,
    );
  }

  // Unlock and patch obfuscated inline scripts (e.g. play.php cF7c) after brand/URL rewrites
  out = unlockHtmlInlineScripts(out);

  return out;
}

function injectStylishUi(html: string): string {
  const fontsLink = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">`;

  const styleBlock = `<style id="gb-stylish-ui-css">
:root {
  --gb-ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
  --gb-ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  --gb-glass-bg: rgba(255, 255, 255, 0.78);
  --gb-glass-border: rgba(220, 38, 38, 0.16);
  --gb-glow-1: rgba(220, 38, 38, 0.16);
  --gb-glow-2: rgba(249, 115, 22, 0.14);
  --gb-glow-3: rgba(236, 72, 153, 0.11);
}
body.dark-mode, html.dark-mode body {
  --gb-glass-bg: rgba(10, 10, 14, 0.78);
  --gb-glass-border: rgba(250, 204, 21, 0.24);
  --gb-glow-1: rgba(250, 204, 21, 0.14);
  --gb-glow-2: rgba(245, 158, 11, 0.12);
  --gb-glow-3: rgba(234, 179, 8, 0.10);
}

body {
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  overflow-x: hidden;
}
h1, h2, h3, .batch-title, .subject-title, .topic-title, .lecture-title,
.note-title, .dpp-title, .schedule-title, #srTitle, .tab-btn, .filter-btn, .load-more-btn {
  font-family: 'Outfit', 'Plus Jakarta Sans', sans-serif;
}

/* Top Scroll Progress Bar */
#gb-scroll-progress {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 3px;
  z-index: 9999;
  transform-origin: left center;
  transform: scaleX(0);
  pointer-events: none;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-color), var(--secondary-color), var(--primary-color));
  background-size: 200% 100%;
  box-shadow: 0 0 12px rgb(var(--primary-rgb) / 0.65);
  animation: gbGradientSlide 3s linear infinite;
  transition: transform 0.08s linear;
}

/* Ambient Aurora & Floating Particles Background */
#gb-aurora-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}
.gb-orb {
  position: absolute;
  border-radius: 9999px;
  filter: blur(70px);
  opacity: 0.72;
  will-change: transform;
}
.gb-orb-1 {
  width: 420px;
  height: 420px;
  top: -120px;
  left: -100px;
  background: radial-gradient(circle, var(--gb-glow-1), transparent 70%);
  animation: gbOrbDrift1 18s ease-in-out infinite alternate;
}
.gb-orb-2 {
  width: 460px;
  height: 460px;
  top: 28%;
  right: -140px;
  background: radial-gradient(circle, var(--gb-glow-2), transparent 70%);
  animation: gbOrbDrift2 22s ease-in-out infinite alternate;
}
.gb-orb-3 {
  width: 380px;
  height: 380px;
  bottom: -110px;
  left: 25%;
  background: radial-gradient(circle, var(--gb-glow-3), transparent 70%);
  animation: gbOrbDrift3 20s ease-in-out infinite alternate;
}
#gb-particles-canvas {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
.app-container {
  position: relative;
  z-index: 1;
}

/* Glassmorphic Header & Brand Wordmark */
.app-header {
  background: var(--gb-glass-bg) !important;
  backdrop-filter: blur(18px) saturate(165%) !important;
  -webkit-backdrop-filter: blur(18px) saturate(165%) !important;
  border-bottom: 1px solid var(--gb-glass-border) !important;
  transition: box-shadow 0.35s var(--gb-ease-spring), background 0.35s ease, border-color 0.35s ease !important;
}
body.gb-scrolled .app-header {
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12), 0 2px 12px rgb(var(--primary-rgb) / 0.14) !important;
}
#app-logo {
  display: inline-flex !important;
  align-items: center !important;
  gap: 10px;
  position: relative;
}
#app-logo img {
  width: 44px !important;
  height: 44px !important;
  border-radius: 50%;
  border: 2px solid rgb(var(--primary-rgb) / 0.55) !important;
  animation: gbLogoPulse 3.2s ease-in-out infinite;
  transition: transform 0.45s var(--gb-ease-bounce), box-shadow 0.35s ease !important;
}
#app-logo:hover img {
  transform: scale(1.1) rotate(-6deg) !important;
}
#app-logo::after {
  content: "GB STUDY";
  font-family: 'Outfit', sans-serif;
  font-weight: 800;
  font-size: 1.18rem;
  letter-spacing: 0.05em;
  white-space: nowrap;
  background: linear-gradient(120deg, var(--primary-color) 0%, var(--accent-color) 45%, var(--secondary-color) 75%, var(--primary-color) 100%);
  background-size: 220% auto;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: gbGradientSlide 4.5s linear infinite;
  filter: drop-shadow(0 2px 8px rgb(var(--primary-rgb) / 0.22));
}
@media (max-width: 420px) {
  #app-logo img { width: 38px !important; height: 38px !important; }
  #app-logo::after { font-size: 0.96rem; letter-spacing: 0.03em; }
}

/* Header Action Buttons */
.icon-btn {
  position: relative;
  overflow: hidden;
  transition: transform 0.32s var(--gb-ease-bounce), box-shadow 0.3s ease, background-color 0.25s ease, color 0.25s ease !important;
}
.icon-btn:hover {
  transform: translateY(-2px) scale(1.08);
  box-shadow: 0 8px 20px rgb(var(--primary-rgb) / 0.28);
}
.icon-btn:active {
  transform: scale(0.92);
}
#reload-app:hover i {
  animation: gbSpinSlow 0.85s var(--gb-ease-spring);
}
#theme-toggle:hover i {
  transform: rotate(22deg) scale(1.12);
  transition: transform 0.35s var(--gb-ease-bounce);
}
a[href="#favorites"]:hover i {
  animation: gbHeartBeat 0.75s ease-in-out;
}

/* Search Input Glass & Focus Halo */
.search-input-wrapper {
  background: var(--gb-glass-bg) !important;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition: transform 0.32s var(--gb-ease-spring), box-shadow 0.32s ease, border-color 0.3s ease !important;
}
.search-input-wrapper:focus-within {
  transform: translateY(-2px);
  box-shadow: 0 0 0 4px rgb(var(--primary-rgb) / 0.15), 0 14px 30px rgb(var(--primary-rgb) / 0.14) !important;
  border-color: var(--primary-color) !important;
}
.search-suggestions {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  animation: gbDropdownIn 0.24s var(--gb-ease-spring);
}

/* Stylish Interactive Buttons, Tabs, Filter Pills & Banners */
.filter-btn, .tab-btn, .quick-nav-btn, .load-more-btn, .back-link, .view-all-btn, .community-banner-btn {
  position: relative;
  overflow: hidden;
  transition: transform 0.34s var(--gb-ease-bounce), box-shadow 0.32s ease, background 0.3s ease, border-color 0.3s ease, color 0.25s ease !important;
}
.filter-btn:hover, .tab-btn:hover, .quick-nav-btn:hover, .load-more-btn:hover, .back-link:hover, .view-all-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 22px rgb(var(--primary-rgb) / 0.22);
}
.filter-btn:active, .tab-btn:active, .quick-nav-btn:active, .load-more-btn:active, .back-link:active, .community-banner-btn:active {
  transform: scale(0.96) !important;
}
.filter-btn.active, .tab-btn.active {
  background-image: linear-gradient(135deg, var(--primary-color), var(--accent-color)) !important;
  box-shadow: 0 8px 22px rgb(var(--primary-rgb) / 0.34) !important;
}
.load-more-btn {
  background-image: linear-gradient(135deg, var(--primary-color), var(--accent-color), var(--primary-color)) !important;
  background-size: 200% auto !important;
  animation: gbGradientSlide 5s linear infinite;
}
.community-banner-btn {
  background: linear-gradient(120deg, var(--primary-color) 0%, var(--accent-color) 50%, var(--primary-color) 100%) !important;
  background-size: 220% auto !important;
  border-color: transparent !important;
  animation: gbGradientSlide 5s linear infinite, gbBannerPulse 3.2s ease-in-out infinite;
}
.community-banner-btn:hover {
  transform: translateY(-3px) scale(1.01) !important;
  box-shadow: 0 14px 32px rgb(var(--primary-rgb) / 0.36) !important;
}

/* Material Ripple Element */
.gb-ripple-dot {
  position: absolute;
  border-radius: 50%;
  transform: translate(-50%, -50%) scale(0);
  background: radial-gradient(circle, rgba(255,255,255,0.52), rgba(255,255,255,0.12));
  pointer-events: none;
  animation: gbRippleAnim 0.55s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  z-index: 2;
}

/* Cards: Staggered Spring Reveal + 3D Tilt + Cursor Spotlight */
.batch-card, .subject-card, .topic-card, .lecture-card, .note-card,
.dpp-card, .quiz-card, .dpp-quiz-card, .schedule-card, .schedule-item,
.test-card, .announcement-card, .khazana-chapter-card, .original-lecture-card,
.original-note-card, .original-dpp-card, .khazana-note-card {
  transition: transform 0.38s var(--gb-ease-spring), box-shadow 0.38s var(--gb-ease-spring), border-color 0.32s ease, background-image 0.25s ease !important;
  transform-style: preserve-3d;
}
.gb-anim-in {
  animation: gbCardEnter 0.54s var(--gb-ease-spring) var(--gb-d, 0ms) both;
}
@media (hover: hover) and (pointer: fine) {
  .batch-card:hover, .subject-card:hover, .topic-card:hover, .lecture-card:hover,
  .note-card:hover, .dpp-card:hover, .quiz-card:hover, .dpp-quiz-card:hover,
  .schedule-item:hover, .test-card:hover, .announcement-card:hover,
  .khazana-chapter-card:hover, .original-lecture-card:hover, .original-note-card:hover,
  .original-dpp-card:hover, .khazana-note-card:hover {
    transform: perspective(900px) rotateX(var(--gb-rx, 0deg)) rotateY(var(--gb-ry, 0deg)) translateY(-6px) scale(1.014) !important;
    border-color: rgb(var(--primary-rgb) / 0.58) !important;
    box-shadow: 0 18px 38px rgba(0, 0, 0, 0.14), 0 8px 22px rgb(var(--primary-rgb) / 0.22) !important;
    background-image: radial-gradient(circle 240px at var(--gb-mx, 50%) var(--gb-my, 50%), rgb(var(--primary-rgb) / 0.11), transparent 72%) !important;
  }
  body.dark-mode .batch-card:hover, body.dark-mode .subject-card:hover,
  body.dark-mode .topic-card:hover, body.dark-mode .lecture-card:hover,
  body.dark-mode .note-card:hover, body.dark-mode .dpp-card:hover,
  body.dark-mode .quiz-card:hover, body.dark-mode .dpp-quiz-card:hover,
  body.dark-mode .schedule-item:hover, body.dark-mode .test-card:hover {
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.72), 0 6px 24px rgb(var(--primary-rgb) / 0.24) !important;
  }
}

/* Smooth Thumbnail Image Zoom inside Cards */
.batch-card .batch-image, .subject-card .subject-icon-container, .lecture-card .lecture-image {
  overflow: hidden;
}
.batch-card img, .subject-card img, .lecture-card img {
  transition: transform 0.55s var(--gb-ease-spring), filter 0.4s ease !important;
}
.batch-card:hover img, .subject-card:hover img, .lecture-card:hover img {
  transform: scale(1.06) !important;
  filter: saturate(1.08) contrast(1.03);
}

/* View & Tab Transitions */
.gb-view-enter {
  animation: gbViewEnter 0.42s var(--gb-ease-spring) both;
}
.tab-pane.active {
  animation: gbViewEnter 0.36s var(--gb-ease-spring) both;
}

/* Enhanced Shimmer for Skeletons & Badges */
.batch-tag, .schedule-tag {
  transition: transform 0.25s var(--gb-ease-bounce), box-shadow 0.25s ease !important;
}
.batch-card:hover .batch-tag {
  transform: translateY(-1px);
}
.schedule-status.live {
  animation: gbLivePulse 1.8s ease-in-out infinite;
}

/* Popup & Continue Watching Glass Polish */
#srOverlay {
  backdrop-filter: blur(10px) saturate(140%) !important;
  -webkit-backdrop-filter: blur(10px) saturate(140%) !important;
}
#srPopup {
  border: 1px solid var(--gb-glass-border) !important;
  box-shadow: 0 28px 65px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255,255,255,0.12) inset !important;
  animation: gbPopupSpring 0.45s var(--gb-ease-bounce) both !important;
}
body.dark-mode #srPopup {
  background: #0d0e14 !important;
  color: #fff7cc !important;
}
body.dark-mode #srTitle { color: #fde047 !important; }
body.dark-mode #srSub { color: #d6c88d !important; }
body.dark-mode #srClose { background: #1e202b !important; color: #fff7cc !important; }
#srBtn {
  background: linear-gradient(135deg, var(--primary-color), var(--accent-color)) !important;
  box-shadow: 0 10px 24px rgb(var(--primary-rgb) / 0.32) !important;
  transition: transform 0.3s var(--gb-ease-bounce), box-shadow 0.3s ease !important;
}
#srBtn:hover {
  transform: translateY(-2px) scale(1.02) !important;
  box-shadow: 0 14px 30px rgb(var(--primary-rgb) / 0.45) !important;
}

/* Custom Scrollbar */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgb(var(--primary-rgb) / 0.35);
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover { background: rgb(var(--primary-rgb) / 0.65); }

/* Keyframes */
@keyframes gbCardEnter {
  from { opacity: 0.01; transform: translateY(20px) scale(0.965); filter: blur(4px); }
  to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
@keyframes gbViewEnter {
  from { opacity: 0.01; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes gbGradientSlide {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
@keyframes gbLogoPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgb(var(--primary-rgb) / 0.35), 0 6px 18px rgba(0,0,0,0.18); }
  50% { box-shadow: 0 0 0 6px rgb(var(--primary-rgb) / 0), 0 8px 24px rgb(var(--primary-rgb) / 0.32); }
}
@keyframes gbBannerPulse {
  0%, 100% { box-shadow: 0 6px 20px rgb(var(--primary-rgb) / 0.24); }
  50% { box-shadow: 0 10px 28px rgb(var(--primary-rgb) / 0.42); }
}
@keyframes gbSpinSlow {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes gbHeartBeat {
  0%, 100% { transform: scale(1); }
  30% { transform: scale(1.28); }
  55% { transform: scale(0.94); }
  75% { transform: scale(1.18); }
}
@keyframes gbRippleAnim {
  to { transform: translate(-50%, -50%) scale(16); opacity: 0; }
}
@keyframes gbDropdownIn {
  from { opacity: 0; transform: translateY(-6px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes gbPopupSpring {
  from { opacity: 0; transform: translateY(24px) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes gbLivePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55); }
  50% { box-shadow: 0 0 0 7px rgba(239, 68, 68, 0); }
}
@keyframes gbOrbDrift1 {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(90px, 60px, 0) scale(1.16); }
}
@keyframes gbOrbDrift2 {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(-80px, -50px, 0) scale(1.14); }
}
@keyframes gbOrbDrift3 {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(60px, -70px, 0) scale(1.12); }
}

@media (prefers-reduced-motion: reduce) {
  .gb-orb, #gb-particles-canvas, #gb-scroll-progress { display: none !important; }
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
</style>`;

  const motionScript = `<script id="gb-stylish-ui-js">(function(){
  if (window.__gbUiLoaded) return;
  window.__gbUiLoaded = true;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setupChrome() {
    if (!document.body) return;
    if (!document.getElementById('gb-scroll-progress')) {
      var bar = document.createElement('div');
      bar.id = 'gb-scroll-progress';
      document.body.appendChild(bar);
    }
    if (!document.getElementById('gb-aurora-layer')) {
      var aurora = document.createElement('div');
      aurora.id = 'gb-aurora-layer';
      aurora.innerHTML = '<div class="gb-orb gb-orb-1"></div><div class="gb-orb gb-orb-2"></div><div class="gb-orb gb-orb-3"></div>';
      document.body.insertBefore(aurora, document.body.firstChild);
    }
    if (!reduced && !document.getElementById('gb-particles-canvas')) {
      var canvas = document.createElement('canvas');
      canvas.id = 'gb-particles-canvas';
      document.body.insertBefore(canvas, document.body.firstChild);
      initParticles(canvas);
    }
  }

  function initParticles(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var mouse = { x: -9999, y: -9999 };
    var count = window.innerWidth < 640 ? 18 : 32;
    var pts = [];

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('mousemove', function(e) { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });

    for (var i = 0; i < count; i++) {
      pts.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.45,
        vy: (Math.random() - 0.5) * 0.45,
        r: 1.4 + Math.random() * 2.2,
        a: 0.18 + Math.random() * 0.28
      });
    }

    var rafId = null;
    function tick() {
      if (document.hidden) { rafId = null; return; }
      ctx.clearRect(0, 0, w, h);
      var dark = document.body.classList.contains('dark-mode') || document.documentElement.classList.contains('dark-mode');
      var rgb = dark ? '250, 204, 21' : '220, 38, 38';
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + rgb + ',' + p.a + ')';
        ctx.fill();

        var mdx = p.x - mouse.x, mdy = p.y - mouse.y;
        var md = Math.sqrt(mdx * mdx + mdy * mdy);
        if (md < 140) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.18 * (1 - md / 140)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      rafId = requestAnimationFrame(tick);
    }
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden && !rafId) rafId = requestAnimationFrame(tick);
    });
    rafId = requestAnimationFrame(tick);
  }

  function onScroll() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    if (document.body) {
      document.body.classList.toggle('gb-scrolled', y > 16);
    }
    var bar = document.getElementById('gb-scroll-progress');
    if (bar) {
      var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      var ratio = Math.max(0, Math.min(1, y / max));
      bar.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  var CARD_SEL = '.batch-card,.subject-card,.topic-card,.lecture-card,.note-card,.dpp-card,.quiz-card,.dpp-quiz-card,.schedule-card,.schedule-item,.test-card,.announcement-card,.khazana-chapter-card,.original-lecture-card,.original-note-card,.original-dpp-card,.khazana-note-card';
  var animSeq = 0;
  var resetTimer = null;

  function revealCard(el) {
    if (!el || el.dataset.gbAnim) return;
    el.dataset.gbAnim = '1';
    var delay = Math.min(animSeq * 42, 360);
    animSeq++;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function() { animSeq = 0; }, 160);
    el.style.setProperty('--gb-d', delay + 'ms');
    el.classList.add('gb-anim-in');
  }

  function scanCards(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(CARD_SEL)) revealCard(root);
    var list = root.querySelectorAll(CARD_SEL);
    for (var i = 0; i < list.length; i++) revealCard(list[i]);
  }

  function initObservers() {
    scanCards(document.body);
    var appView = document.getElementById('app-view');
    var mo = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.target && m.target.id === 'app-view' && m.addedNodes.length > 0) {
          appView.classList.remove('gb-view-enter');
          void appView.offsetWidth;
          appView.classList.add('gb-view-enter');
        }
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n && n.nodeType === 1) scanCards(n);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // 3D Tilt & Cursor Spotlight on desktop hover
  if (!reduced && window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var activeCard = null;
    document.addEventListener('mousemove', function(e) {
      var card = e.target && e.target.closest ? e.target.closest(CARD_SEL) : null;
      if (activeCard && activeCard !== card) {
        activeCard.style.removeProperty('--gb-rx');
        activeCard.style.removeProperty('--gb-ry');
        activeCard = null;
      }
      if (!card || card.classList.contains('schedule-card')) return;
      activeCard = card;
      var rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var px = (e.clientX - rect.left) / rect.width;
      var py = (e.clientY - rect.top) / rect.height;
      card.style.setProperty('--gb-mx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--gb-my', (py * 100).toFixed(1) + '%');
      card.style.setProperty('--gb-rx', ((0.5 - py) * 5).toFixed(2) + 'deg');
      card.style.setProperty('--gb-ry', ((px - 0.5) * 5).toFixed(2) + 'deg');
    }, { passive: true });
    document.addEventListener('mouseleave', function() {
      if (activeCard) {
        activeCard.style.removeProperty('--gb-rx');
        activeCard.style.removeProperty('--gb-ry');
        activeCard = null;
      }
    }, { passive: true });
  }

  // Subtle Material Ripple on UI buttons/tabs (non-blocking visual only)
  if (!reduced) {
    var BTN_SEL = '.filter-btn,.tab-btn,.quick-nav-btn,.load-more-btn,.back-link,.community-banner-btn,.icon-btn,.view-all-btn';
    document.addEventListener('pointerdown', function(e) {
      var btn = e.target && e.target.closest ? e.target.closest(BTN_SEL) : null;
      if (!btn) return;
      var rect = btn.getBoundingClientRect();
      var dot = document.createElement('span');
      dot.className = 'gb-ripple-dot';
      var size = Math.max(rect.width, rect.height) * 0.25;
      dot.style.width = size + 'px';
      dot.style.height = size + 'px';
      dot.style.left = (e.clientX - rect.left) + 'px';
      dot.style.top = (e.clientY - rect.top) + 'px';
      btn.appendChild(dot);
      setTimeout(function() { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 560);
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setupChrome(); initObservers(); onScroll(); });
  } else {
    setupChrome(); initObservers(); onScroll();
  }
})();</script>`;

  let out = html;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${fontsLink}${styleBlock}</head>`);
  } else {
    out = `${fontsLink}${styleBlock}${out}`;
  }
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${motionScript}</body>`);
  } else {
    out = `${out}${motionScript}`;
  }
  return out;
}

const unlockedScriptCache = new Map<string, string>();
const MAX_SCRIPT_CACHE_ENTRIES = 12;

function buildRuntimeObjPatch(objVar: string): string {
  // Build domain strings dynamically so HTML brand rewriters cannot accidentally mutate them
  const allowedHosts = [
    ['s2-cdn', 'studyratna', 'cc'].join('.'),
    ['studyratna', 'cc'].join('.'),
    ['stream', 'studyratna', 'cc'].join('.'),
    ['s4-cdn', 'samfygros', 'com'].join('.'),
    ['s3-cdn', 'samfygros', 'com'].join('.'),
    ['samfygros', 'com'].join('.'),
    ['streamfiles', 'eu', 'org'].join('.'),
    ['testfile', 'eu', 'org'].join('.'),
    ['secret-stripe', 'alfanso', 'info'].join('.'),
  ];
  const originPrefixes = [
    'https://' + allowedHosts[0],
    'https://' + allowedHosts[3],
    'https://' + allowedHosts[4],
  ];
  const radhaSegment = '/radha';
  return `;(function(){try{var _obj=${objVar};var _hosts=${JSON.stringify(allowedHosts)};var _origins=${JSON.stringify(originPrefixes)};if(typeof _obj==="object"&&_obj){for(var _k in _obj){if(typeof _obj[_k]==="function"&&_obj[_k].length===1){(function(_orig,_key){_obj[_key]=function(_idx){var _v=_orig.call(this,_idx);if(typeof _v!=="string")return _v;if(_v.indexOf("check_origin.php")!==-1)return "/api/check_origin.php";if(_hosts.indexOf(_v)!==-1)return window.location.hostname;for(var _oi=0;_oi<_origins.length;_oi++){var _op=_origins[_oi];if(_v.indexOf(_op+"/")===0&&_v.indexOf(_op+${JSON.stringify(radhaSegment)})!==0)return window.location.origin+_v.slice(_op.length);}if(_v.indexOf("t.me/")!==-1||_v.indexOf("telegram.me/")!==-1||_v.indexOf("channel.studyrays.cc")!==-1){_v=_v.replace(/https?:\\/\\/(?:t\\.me|telegram\\.me)\\/[^\\s"'<>\\\\)]+/gi,${JSON.stringify(TELEGRAM_URL)}).replace(/https?:\\/\\/channel\\.studyrays\\.cc[^\\s"'<>\\\\)]*/gi,${JSON.stringify(TELEGRAM_URL)});}if(_v.indexOf("StudyRatna")!==-1||_v.indexOf("StudyRays")!==-1||_v.indexOf("studyrays")!==-1||_v.indexOf("Study Ratna")!==-1||_v.indexOf("Ratna Bhai")!==-1){_v=_v.replace(/StudyRays\\s*x\\s*DevJisu/gi,${JSON.stringify(BRAND_NAME)}).replace(/StudyRatna(?:\\.cc)?/gi,${JSON.stringify(BRAND_NAME)}).replace(/Study\\s+Ratna/gi,${JSON.stringify(BRAND_NAME)}).replace(/Ratna\\s+Bhai/gi,${JSON.stringify(BRAND_NAME)}).replace(/StudyRays/gi,${JSON.stringify(BRAND_NAME)}).replace(/studyrays/gi,${JSON.stringify(BRAND_NAME)});}return _v;};})(_obj[_k],_k);}}}}catch(_e){}})();`;
}

function unlockObfuscatedScript(code: string): string {
  if (!code.includes('Array.prototype.slice.call(arguments)') || !code.includes('eval(')) {
    return code;
  }

  const cacheKey = `${code.length}:${code.slice(0, 120)}:${code.slice(-80)}`;
  const cached = unlockedScriptCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let out = code;
  try {
    const capture: { inner: string | null } = { inner: null };
    let evalCount = 0;

    // Isolated VM context with standard built-ins only; intercepts the 2nd eval() to capture inner payload
    const sandbox: Record<string, unknown> = {
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Date,
      Math,
      JSON,
      Error,
      TypeError,
      RangeError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      escape,
      unescape,
      eval: (str: string) => {
        evalCount++;
        if (evalCount === 1) {
          return vm.runInContext(str, ctx);
        }
        capture.inner = str;
        throw new Error('__CAPTURE_STOP__');
      },
    };
    const ctx = vm.createContext(sandbox);
    try {
      vm.runInContext(code, ctx, { timeout: 2000 });
    } catch {
      // Expected __CAPTURE_STOP__ once inner payload is captured
    }

    if (capture.inner) {
      // Unlock the inner hostname-hash function (4-param CHECK_HOST after domain hash array)
      const hashToHost: Array<[string, string]> = [
        ['-954999937,-456689553', 's2-cdn.studyratna.cc'],
        ['-953152895,838799361,98689', 's4-cdn.samfygros.com'],
        ['-954076416,838799361,98689', 's3-cdn.samfygros.com'],
      ];
      const hashAlternation = hashToHost.map(([h]) => h.replace(/-/g, '\\-')).join('|');
      const hashPatchRegex = new RegExp(
        `((${hashAlternation})[\\s\\S]{0,2500}?function\\s+[^\\s(]+\\()([^\\s,]+)(,[^\\s,]+,[^\\s,]+,[^\\s)]+\\)\\{)`,
      );
      const patchedInner = capture.inner.replace(
        hashPatchRegex,
        (_m: string, a: string, matchedHash: string, b: string, c: string) => {
          const matchedEntry = hashToHost.find(([h]) => h === matchedHash);
          const spoofHost = matchedEntry ? matchedEntry[1] : 's2-cdn.studyratna.cc';
          return `${a}${b}${c}${b}=${JSON.stringify(spoofHost)};`;
        },
      );

      const prefixRe =
        /let\s+([^;\s]+);!function\(\)\{const\s+([^\s=]+)=Array\.prototype\.slice\.call\(arguments\);return\s+eval\(/;
      const pm = code.match(prefixRe);
      if (pm && pm.index !== undefined) {
        const objVar = pm[1];
        const argsVar = pm[2];
        const evalStart = pm.index + pm[0].indexOf('eval(');
        const strStart = pm.index + pm[0].length;
        const quote = code[strStart];
        if (quote === '"' || quote === "'") {
          let i = strStart + 1;
          while (i < code.length) {
            if (code[i] === '\\') {
              i += 2;
              continue;
            }
            if (code[i] === quote) break;
            i++;
          }
          if (i < code.length && code[i + 1] === ')') {
            const evalEnd = i + 2;
            const replacement = `(${patchedInner}).apply(null,${argsVar})`;
            out = code.slice(0, evalStart) + replacement + code.slice(evalEnd);

            // Inject runtime string rewriter immediately after the wrapper IIFE completes: }();
            const runtimePatch = buildRuntimeObjPatch(objVar);
            const iifeTailIdx = out.indexOf('}();', evalStart + replacement.length);
            if (iifeTailIdx !== -1 && iifeTailIdx - (evalStart + replacement.length) < 32) {
              const insertPos = iifeTailIdx + 4;
              out = out.slice(0, insertPos) + runtimePatch + out.slice(insertPos);
            } else {
              const anchorRegex = new RegExp(`(\\(function\\(\\)\\{[^=]{1,40}=\\[${objVar}\\.)`);
              out = out.replace(anchorRegex, (m) => runtimePatch + m);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Script unlock fallback:', err);
    out = code;
  }

  // Expand literal domain allowlists as an additional guard (covers wOMp, yrVy, cF7c, Eqpx, etc.)
  out = out.replace(
    /\[(?:wOMp|yrVy|cF7c|Eqpx)\.\w+\(\d+\)(?:,(?:wOMp|yrVy|cF7c|Eqpx)\.\w+\(\d+\)){3,14}\]/g,
    (m) => `${m}.concat([window.location.hostname])`,
  );

  if (unlockedScriptCache.size >= MAX_SCRIPT_CACHE_ENTRIES) {
    const firstKey = unlockedScriptCache.keys().next().value;
    if (firstKey !== undefined) unlockedScriptCache.delete(firstKey);
  }
  unlockedScriptCache.set(cacheKey, out);
  return out;
}

function rewriteSettingsJson(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    const data = parsed?.data;
    if (data && typeof data === 'object') {
      if (data.security && typeof data.security === 'object') {
        data.security.origin_check_url = '/api/check_origin.php';
      }
      if (data.splash_screen && typeof data.splash_screen === 'object') {
        data.splash_screen.title = BRAND_NAME;
        data.splash_screen.subtitle = BRAND_NAME;
        data.splash_screen.logo_url = ICON_PATH;
      }
      if (data.features && typeof data.features === 'object') {
        data.features.task_verification_enabled = false;
      }
      if (data.messages && typeof data.messages === 'object') {
        data.messages.telegram_link = TELEGRAM_URL;
        if (typeof data.messages.subscriber_milestone === 'string') {
          data.messages.subscriber_milestone = rewriteBrandText(
            rewriteTelegramUrls(data.messages.subscriber_milestone),
          );
        }
      }
      if (Array.isArray(data.quick_nav)) {
        for (const item of data.quick_nav) {
          if (!item || typeof item !== 'object') continue;
          const titleStr = typeof item.title === 'string' ? item.title : '';
          const urlStr = typeof item.url === 'string' ? item.url : '';
          if (
            /telegram/i.test(titleStr) ||
            /(?:t\.me|telegram\.me|channel\.studyrays\.cc)/i.test(urlStr)
          ) {
            item.url = TELEGRAM_URL;
          }
        }
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return rewriteBrandText(rewriteTelegramUrls(rawText));
  }
}

function solvePlayChallenge(html: string): { cookieName: string; cookieValue: string } | null {
  if (
    !html.includes('_pw_sec_chk') &&
    !html.includes('pw_chk_') &&
    !html.includes('var _x=') &&
    !html.includes('var _x =')
  ) {
    return null;
  }

  const spanMap: Record<string, { attrName?: string; attrVal?: string; text: string }> = {};
  const spanRegex = /<span\s+id=['"]([^'"]+)['"](?:\s+(data-[a-z0-9_-]+)=['"]([^'"]*)['"])?\s*>([^<]*)<\/span>/gi;
  let match: RegExpExecArray | null;
  while ((match = spanRegex.exec(html)) !== null) {
    spanMap[match[1]] = {
      attrName: match[2],
      attrVal: match[3],
      text: match[4] || '',
    };
  }

  const parts: string[] = [];
  const docRegex =
    /document\.getElementById\(['"]([^'"]+)['"]\)\.(?:getAttribute\(['"]([^'"]+)['"]\)|innerHTML)/gi;
  while ((match = docRegex.exec(html)) !== null) {
    const span = spanMap[match[1]];
    if (!span) continue;
    if (match[2]) {
      parts.push(span.attrVal ?? '');
    } else {
      parts.push(span.text);
    }
  }

  if (parts.length === 0) return null;

  let cookieName = '_pw_sec_chk';
  const xMatch = html.match(/var\s+_x\s*=\s*\[([^\]]+)\]/);
  if (xMatch) {
    try {
      const xorMatch = html.match(/String\.fromCharCode\([^)]*\^\s*(\d+)\)/);
      const xorKey = xorMatch ? Number(xorMatch[1]) : 42;
      const decoded = xMatch[1]
        .split(',')
        .map((n) => String.fromCharCode(Number(n.trim()) ^ xorKey))
        .join('');
      const nameMatch = decoded.match(/document\.cookie\s*=\s*['"]([^=]+)=/);
      if (nameMatch) cookieName = nameMatch[1];
    } catch {
      // keep default cookieName
    }
  }

  return { cookieName, cookieValue: parts.join('') };
}

interface PlaySessionEntry {
  phpSessId: string;
  pwChk: string;
  expiresAt: number;
}

const playSessionStore = new Map<string, PlaySessionEntry>();
const MAX_PLAY_SESSIONS = 500;

function savePlaySession(phpSessId: string, pwChk: string): string {
  if (!phpSessId && !pwChk) return '';
  const now = Date.now();
  for (const [k, v] of playSessionStore.entries()) {
    if (v.expiresAt <= now) playSessionStore.delete(k);
  }
  while (playSessionStore.size >= MAX_PLAY_SESSIONS) {
    const oldest = playSessionStore.keys().next().value;
    if (oldest !== undefined) playSessionStore.delete(oldest);
    else break;
  }
  const sid = crypto.randomBytes(16).toString('hex');
  playSessionStore.set(sid, { phpSessId, pwChk, expiresAt: now + 3600_000 });
  return sid;
}

function getPlaySession(sid: string): PlaySessionEntry | null {
  const entry = playSessionStore.get(sid);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    playSessionStore.delete(sid);
    return null;
  }
  return entry;
}

interface AutoAccessKeyState {
  accessToken: string;
  clientId: string;
  issuedAt: number;
  expiresAt: number;
}

const KEY_CACHE_FILE = path.join('/tmp', '.gb-access-key-cache.json');
const KEY_REFRESH_LEEWAY_MS = 2 * 60 * 1000; // Refresh 2 minutes before 24h expiry
const DEFAULT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

let activeAccessKey: AutoAccessKeyState | null = null;
let keyRefreshPromise: Promise<AutoAccessKeyState | null> | null = null;
let keyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastFailedAttemptAt = 0;

function recordResponseCookies(resObj: globalThis.Response, jar: Map<string, string>): void {
  const list =
    typeof resObj.headers.getSetCookie === 'function' ? resObj.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0] || '';
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    if (name) {
      if (val === 'deleted') {
        jar.delete(name);
      } else {
        jar.set(name, val);
      }
    }
  }
}

function parseJwtExpMs(token: string): number {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return Date.now() + DEFAULT_KEY_TTL_MS;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof json.exp === 'number' && Number.isFinite(json.exp) && json.exp > 1_000_000_000) {
      return json.exp * 1000;
    }
  } catch {
    // ignore decode errors and use 24h fallback
  }
  return Date.now() + DEFAULT_KEY_TTL_MS;
}

function loadCachedAccessKeyFromDisk(): AutoAccessKeyState | null {
  try {
    if (!fs.existsSync(KEY_CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(KEY_CACHE_FILE, 'utf8')) as Partial<AutoAccessKeyState>;
    if (
      typeof parsed.accessToken === 'string' &&
      parsed.accessToken &&
      typeof parsed.clientId === 'string' &&
      parsed.clientId &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > Date.now() + KEY_REFRESH_LEEWAY_MS
    ) {
      return {
        accessToken: parsed.accessToken,
        clientId: parsed.clientId,
        issuedAt: typeof parsed.issuedAt === 'number' ? parsed.issuedAt : Date.now(),
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    // ignore corrupted cache
  }
  return null;
}

function saveAccessKeyToDisk(state: AutoAccessKeyState): void {
  try {
    fs.writeFileSync(KEY_CACHE_FILE, JSON.stringify(state), 'utf8');
  } catch {
    // non-fatal on ephemeral filesystems
  }
}

function scheduleNextAccessKeyRefresh(state: AutoAccessKeyState): void {
  if (keyRefreshTimer) {
    clearTimeout(keyRefreshTimer);
    keyRefreshTimer = null;
  }
  const delayMs = Math.max(60_000, state.expiresAt - Date.now() - KEY_REFRESH_LEEWAY_MS);
  // Clamp to max 32-bit signed timeout
  const safeDelayMs = Math.min(delayMs, 2_147_483_647);
  keyRefreshTimer = setTimeout(() => {
    void ensureValidAccessKey({ forceRefresh: true });
  }, safeDelayMs);
  if (typeof keyRefreshTimer.unref === 'function') {
    keyRefreshTimer.unref();
  }
}

function extractMetaOrJsRedirect(html: string): string | null {
  const metaMatch = html.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+\s*;\s*url=([^"'>\s]+)/i,
  );
  if (metaMatch?.[1]) {
    return metaMatch[1].replace(/&amp;/gi, '&');
  }
  const jsMatch = html.match(/location\.(?:replace|assign)\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (jsMatch?.[1]) {
    return jsMatch[1].replace(/&amp;/gi, '&');
  }
  return null;
}

async function generateUpstreamAccessKey(): Promise<AutoAccessKeyState> {
  const srJar = new Map<string, string>();
  const taskVerifyUrl = `${UPSTREAM_ORIGIN}/task-verify.php`;

  const step1 = await fetchUpstreamResponse(taskVerifyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DEFAULT_UA,
      Origin: UPSTREAM_ORIGIN,
      Referer: taskVerifyUrl,
    },
    body: 'action=generate',
    redirect: 'manual',
  });
  recordResponseCookies(step1.res, srJar);

  const shortlinkLocation = step1.res.headers.get('location');
  if (!shortlinkLocation) {
    throw new Error(`task-verify.php did not return redirect (status ${step1.res.status})`);
  }

  const shortlinkUrl = new URL(shortlinkLocation, UPSTREAM_ORIGIN).toString();
  const shortlinkOrigin = new URL(shortlinkUrl).origin;
  const shortlinkJar = new Map<string, string>();

  // Initialize shortlink session cookies (follow up to 3 internal redirects if any)
  let initUrl = shortlinkUrl;
  let initReferer = `${UPSTREAM_ORIGIN}/`;
  for (let i = 0; i < 3; i++) {
    const rInit = await fetchUpstreamResponse(initUrl, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: initReferer,
        ...(shortlinkJar.size > 0 ? { Cookie: serializeCookieMap(shortlinkJar) } : {}),
      },
      redirect: 'manual',
    });
    recordResponseCookies(rInit.res, shortlinkJar);
    const nextLoc = rInit.res.headers.get('location');
    if (rInit.res.status >= 300 && rInit.res.status < 400 && nextLoc) {
      const resolved = new URL(nextLoc, initUrl).toString();
      if (new URL(resolved).origin === shortlinkOrigin) {
        initReferer = initUrl;
        initUrl = resolved;
        continue;
      }
    }
    break;
  }

  // Advance shortlink verification steps server-side
  let finalCallbackUrl = '';
  for (let step = 1; step <= 12; step++) {
    const stepRes = await fetchUpstreamResponse(
      `${shortlinkOrigin}/api.php?action=wppro_add_post_cookie`,
      {
        method: 'POST',
        headers: {
          'User-Agent': DEFAULT_UA,
          Origin: shortlinkOrigin,
          Referer: `${shortlinkOrigin}/`,
          Cookie: serializeCookieMap(shortlinkJar),
          Accept: 'application/json, text/plain, */*',
        },
        redirect: 'manual',
      },
    );
    recordResponseCookies(stepRes.res, shortlinkJar);

    const payload = JSON.parse(stepRes.buffer.toString('utf8')) as {
      success?: boolean;
      is_last?: boolean;
      final_url?: string;
      finalUrl?: string;
      next_url?: string;
      error?: string;
    };

    const candidateFinal = payload.final_url || payload.finalUrl || '';
    if (payload.is_last && candidateFinal) {
      finalCallbackUrl = candidateFinal;
      break;
    }
    if (payload.success === false) {
      throw new Error(payload.error || `Shortlink step ${step} failed`);
    }
  }

  if (!finalCallbackUrl) {
    throw new Error('Shortlink did not yield a final callback URL');
  }

  // Complete callback hops back to task-verify.php to claim __Host-access_token
  let currentUrl = new URL(finalCallbackUrl, UPSTREAM_ORIGIN).toString();
  let currentReferer = `${shortlinkOrigin}/`;

  for (let hop = 0; hop < 6; hop++) {
    const isUpstream = new URL(currentUrl).origin === UPSTREAM_ORIGIN;
    const cbRes = await fetchUpstreamResponse(currentUrl, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: currentReferer,
        ...(isUpstream && srJar.size > 0 ? { Cookie: serializeCookieMap(srJar) } : {}),
      },
      redirect: 'manual',
    });
    if (isUpstream) {
      recordResponseCookies(cbRes.res, srJar);
    }

    const tokenNow = srJar.get('__Host-access_token');
    if (tokenNow) {
      break;
    }

    const loc = cbRes.res.headers.get('location');
    if (cbRes.res.status >= 300 && cbRes.res.status < 400 && loc) {
      currentReferer = currentUrl;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    const ct = cbRes.res.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      const metaUrl = extractMetaOrJsRedirect(cbRes.buffer.toString('utf8'));
      if (metaUrl) {
        currentReferer = currentUrl;
        currentUrl = new URL(metaUrl, currentUrl).toString();
        continue;
      }
    }
    break;
  }

  const accessToken = srJar.get('__Host-access_token') || '';
  const clientId = srJar.get('__Host-client_id') || '';
  if (!accessToken || !clientId) {
    throw new Error('Upstream task-verify.php did not issue __Host-access_token');
  }

  const state: AutoAccessKeyState = {
    accessToken,
    clientId,
    issuedAt: Date.now(),
    expiresAt: parseJwtExpMs(accessToken),
  };
  return state;
}

async function ensureValidAccessKey(opts?: {
  forceRefresh?: boolean;
  failedToken?: string;
}): Promise<AutoAccessKeyState | null> {
  const now = Date.now();

  if (!activeAccessKey) {
    const cached = loadCachedAccessKeyFromDisk();
    if (cached) {
      activeAccessKey = cached;
      scheduleNextAccessKeyRefresh(cached);
    }
  }

  if (
    opts?.forceRefresh &&
    opts.failedToken &&
    activeAccessKey &&
    activeAccessKey.accessToken !== opts.failedToken &&
    now < activeAccessKey.expiresAt - KEY_REFRESH_LEEWAY_MS
  ) {
    // Another concurrent request already refreshed the expired token
    return activeAccessKey;
  }

  const needsRefresh =
    opts?.forceRefresh ||
    !activeAccessKey ||
    now >= activeAccessKey.expiresAt - KEY_REFRESH_LEEWAY_MS;

  if (!needsRefresh && activeAccessKey) {
    return activeAccessKey;
  }

  if (keyRefreshPromise) {
    return keyRefreshPromise;
  }

  // Prevent tight retry loops if upstream is momentarily unreachable
  if (!opts?.forceRefresh && now - lastFailedAttemptAt < 10_000 && activeAccessKey) {
    return activeAccessKey;
  }

  keyRefreshPromise = (async () => {
    try {
      const fresh = await generateUpstreamAccessKey();
      activeAccessKey = fresh;
      saveAccessKeyToDisk(fresh);
      scheduleNextAccessKeyRefresh(fresh);
      const validHrs = ((fresh.expiresAt - Date.now()) / 3600_000).toFixed(2);
      console.log(`${BRAND_NAME} auto-generated 24h access key (valid for ~${validHrs}h)`);
      return fresh;
    } catch (err) {
      lastFailedAttemptAt = Date.now();
      console.warn(
        'Auto access key generation failed:',
        err instanceof Error ? err.message : String(err),
      );
      return activeAccessKey;
    } finally {
      keyRefreshPromise = null;
    }
  })();

  return keyRefreshPromise;
}

const ALLOWED_UPSTREAM_COOKIE_NAMES = new Set(['phpsessid', '_pw_sec_chk', 'cf_clearance', '__cf_bm']);

function buildUpstreamHeaders(
  req: Request,
  accessKey: AutoAccessKeyState | null,
  targetOrigin: string = UPSTREAM_ORIGIN,
): Headers {
  const headers = new Headers();
  const forwardAllowList = new Set([
    'accept',
    'accept-language',
    'content-type',
    'user-agent',
    'range',
    'if-range',
    'cache-control',
    'pragma',
  ]);

  for (const [key, val] of Object.entries(req.headers)) {
    if (!val) continue;
    const lower = key.toLowerCase();
    if (!forwardAllowList.has(lower)) continue;
    const strVal = Array.isArray(val) ? val.join(', ') : val;
    if (strVal) headers.set(lower, strVal);
  }

  const isPlayerTarget = targetOrigin === PLAYER_UPSTREAM_ORIGIN;

  // Forward only upstream-relevant cookies (avoid leaking Cloud Run / Google cookies to upstream WAF)
  const rawCookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  const incomingMap = parseCookieMap(rawCookieHeader);
  const cleanCookieMap = new Map<string, string>();
  for (const [name, val] of incomingMap.entries()) {
    const lowerName = name.toLowerCase();
    if (!ALLOWED_UPSTREAM_COOKIE_NAMES.has(lowerName)) continue;
    // Never send s2-cdn.studyratna.cc's PHPSESSID to s4-cdn.samfygros.com
    if (isPlayerTarget && lowerName === 'phpsessid') continue;
    cleanCookieMap.set(name, val);
  }

  // Restore server-side play.php session & _pw_sec_chk (via header or _gb_play_sid cookie)
  const playSidHeader = req.headers['x-gb-play-sid'];
  const playSidCookie = incomingMap.get('_gb_play_sid');
  const rawPlaySid =
    typeof playSidHeader === 'string' && playSidHeader.trim()
      ? playSidHeader.trim()
      : (playSidCookie || '').trim();
  if (rawPlaySid) {
    const sess = getPlaySession(rawPlaySid);
    if (sess) {
      if (sess.phpSessId) cleanCookieMap.set('PHPSESSID', sess.phpSessId);
      if (sess.pwChk) cleanCookieMap.set('_pw_sec_chk', sess.pwChk);
    }
  }

  const pwChkOverride = req.headers['x-gb-pw-chk'];
  if (typeof pwChkOverride === 'string' && pwChkOverride.trim()) {
    cleanCookieMap.set('_pw_sec_chk', pwChkOverride.trim());
  }

  // Lock User-Agent to DEFAULT_UA so JWT "ua" claim & play session fingerprints stay consistent
  headers.set('user-agent', DEFAULT_UA);
  if (!isPlayerTarget && accessKey) {
    cleanCookieMap.set('__Host-client_id', accessKey.clientId);
    cleanCookieMap.set('__Host-access_token', accessKey.accessToken);
  }

  const serialized = serializeCookieMap(cleanCookieMap);
  if (serialized) {
    headers.set('cookie', serialized);
  }

  headers.set('origin', targetOrigin);
  headers.set('referer', `${targetOrigin}/`);
  return headers;
}

function encodeRadhaMetaData(pathStr: string): string {
  const key = 'fgsbhv235793853rifjb';
  let out = '';
  for (let i = 0; i < pathStr.length; i++) {
    out += String.fromCharCode(pathStr.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(unescape(encodeURIComponent(out)), 'binary').toString('base64');
}

function injectPlayCookieSync(html: string, pwChk: string, playSid: string): string {
  const guardScript = `<script>(function(){var _p=${JSON.stringify(pwChk)};var _sid=${JSON.stringify(playSid)};if(_p){try{if(document.cookie.indexOf("_pw_sec_chk="+_p)===-1){document.cookie="_pw_sec_chk="+_p+"; path=/; max-age=3600; SameSite=None; Secure; Partitioned";}}catch(e){}try{var _d=Object.getOwnPropertyDescriptor(Document.prototype,"cookie")||Object.getOwnPropertyDescriptor(HTMLDocument.prototype,"cookie");if(_d&&_d.get&&_d.set){Object.defineProperty(document,"cookie",{configurable:true,get:function(){var raw=_d.get.call(document)||"";var parts=raw.split(";").map(function(x){return x.trim();}).filter(function(x){return x&&x.indexOf("_pw_sec_chk=")!==0;});parts.push("_pw_sec_chk="+_p);return parts.join("; ");},set:function(v){if(typeof v==="string"&&v.indexOf("__gb_radha_proxy__")!==-1)return v;return _d.set.call(document,v);}});}}catch(e){}}var _memBundle=null;try{if(typeof Storage!=="undefined"&&Storage.prototype){var _lsGet=Storage.prototype.getItem;var _lsSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===window.localStorage&&k==="sr_token_bundle"&&typeof v==="string"&&v.indexOf("__gb_radha_proxy__")!==-1){_memBundle=v;return;}return _lsSet.call(this,k,v);};Storage.prototype.getItem=function(k){var val=_lsGet.call(this,k);if(this===window.localStorage&&k==="sr_token_bundle"&&!val&&_memBundle){return _memBundle;}return val;};}}catch(e){}function _needsMediaProxy(u){if(typeof u!=="string")return false;return /^https?:\\/\\/[^/]*\\.de5\\.net\\//i.test(u)||/^https?:\\/\\/[^/]*\\.studyratna\\.cc\\//i.test(u);}function _toMediaProxy(u){return window.location.origin+"/__gb_media?u="+encodeURIComponent(u);}function _extractRadhaPath(u){if(typeof u!=="string")return null;var m=u.match(/^https?:\\/\\/s[0-9a-z-]*\\.samfygros\\.com\\/radha(\\/[^#]*)/i);if(!m)return null;var p=m[1];if(!p||p.indexOf("type=contents")!==-1||p.indexOf("/videos/get-hls-key")!==-1)return null;return p;}function _toRadhaProxy(p){return window.location.origin+"/__gb_radha?path="+encodeURIComponent(p);}var _f=window.fetch;if(typeof _f==="function"){window.fetch=function(u,o){try{var s=typeof u==="string"?u:(u&&u.url)||"";var m=(o&&o.method)||(u&&typeof u!=="string"&&u.method)||"GET";if(s.indexOf("token-manager.php")!==-1){o=o?Object.assign({},o):{};if(!o.credentials)o.credentials="same-origin";var th=new Headers(o.headers||{});if(_p)th.set("x-gb-pw-chk",_p);if(_sid)th.set("x-gb-play-sid",_sid);o.headers=th;return _f.call(this,u,o).then(function(resp){return resp.clone().json().then(function(d){if(resp.ok&&d&&d.success&&(d.access_token||d.token||d.enc_token))return resp;return null;},function(){return null;}).then(function(validResp){if(validResp)return validResp;var fallback={success:true,token:"__gb_radha_proxy__",access_token:"__gb_radha_proxy__",enc_token:"__gb_radha_proxy__",expires_at:Math.floor(Date.now()/1000)+120};return new Response(JSON.stringify(fallback),{status:200,headers:{"Content-Type":"application/json"}});});});}if((_p||_sid)&&(s.indexOf("video-url-details.php")!==-1||s.indexOf("e2e-status-proxy.php")!==-1||s.indexOf("generate-download-token.php")!==-1||s.indexOf("turnstile_verifier.php")!==-1)){o=o?Object.assign({},o):{};var h=new Headers(o.headers||{});if(_p)h.set("x-gb-pw-chk",_p);if(_sid)h.set("x-gb-play-sid",_sid);o.headers=h;}else if(String(m).toUpperCase()==="GET"){var rp=_extractRadhaPath(s);if(rp){u=_toRadhaProxy(rp);o={method:"GET",credentials:"same-origin",headers:{"Accept":"application/json"}};}else if(_needsMediaProxy(s)){if(typeof u==="string"){u=_toMediaProxy(s);}else if(u&&u.url){u=new Request(_toMediaProxy(s),u);}}}}catch(e){}return _f.call(this,u,o);};}if(typeof XMLHttpRequest!=="undefined"&&XMLHttpRequest.prototype){var _xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{if(typeof u==="string"&&_needsMediaProxy(u)){arguments[1]=_toMediaProxy(u);}}catch(e){}return _xo.apply(this,arguments);};}})();</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${guardScript}`);
  }
  return guardScript + html;
}

function isSafeExternalMediaUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const h = parsed.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h === '0.0.0.0' ||
      h === '::1' ||
      h === '[::1]' ||
      h.startsWith('127.') ||
      h.startsWith('10.') ||
      h.startsWith('192.168.') ||
      h.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.local') ||
      h.endsWith('.internal')
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function rewriteM3u8Playlist(playlistText: string, baseUrl: string): string {
  const wrapProxy = (uri: string): string => {
    const trimmed = uri.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;
    try {
      const abs = new URL(trimmed, baseUrl).toString();
      return `/__gb_media?u=${encodeURIComponent(abs)}`;
    } catch {
      return trimmed;
    }
  };

  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI=(["'])([^"']+)\1/gi, (_m, q: string, u: string) => {
          return `URI=${q}${wrapProxy(u)}${q}`;
        });
      }
      return wrapProxy(trimmed);
    })
    .join('\n');
}

async function startServer() {
  await loadIconBuffer();

  const app = express();
  app.set('trust proxy', true);

  // Raw body capture for proxied POST/PUT/PATCH requests
  app.use(
    express.raw({
      type: '*/*',
      limit: '20mb',
    }),
  );

  // 1. Serve GB STUDY icon directly for all icon/favicon paths
  app.get(
    [ICON_PATH, '/favicon.ico', '/apple-touch-icon.png', '/icons/icon-192x192.png', '/icons/icon-512x512.png'],
    async (_req: Request, res: Response) => {
      const buf = await loadIconBuffer();
      if (buf) {
        res.setHeader('Content-Type', cachedIconContentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.status(200).send(buf);
      } else {
        res.redirect(302, ICON_SOURCE_URL);
      }
    },
  );

  // 2. Serve GB STUDY Web App Manifest
  app.get('/manifest.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.status(200).json({
      name: BRAND_NAME,
      short_name: BRAND_NAME,
      description: `${BRAND_NAME} Learning Platform`,
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#dc2626',
      icons: [
        { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  });

  // 3. Local origin check handler so any proxy hostname/origin is authorized
  app.all('/api/check_origin.php', (req: Request, res: Response) => {
    const host = (req.hostname || req.headers.host || 'localhost').split(':')[0];
    const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowed = Array.from(
      new Set(
        [
          host,
          `https://${host}`,
          `http://${host}`,
          reqOrigin,
          'localhost',
          'http://localhost:3000',
          '127.0.0.1',
          'http://127.0.0.1:3000',
        ].filter(Boolean),
      ),
    );
    res.status(200).json({
      success: true,
      allowed_origins: allowed,
      telegram_url: TELEGRAM_URL,
    });
  });

  // 3b. Stream/HLS media proxy for CDNs (e.g. *.de5.net) that enforce upstream Referer checks
  app.get('/__gb_media', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.u === 'string' ? req.query.u : '';
    const parsedUrl = isSafeExternalMediaUrl(rawUrl);
    if (!parsedUrl) {
      res.status(400).send('Invalid media URL');
      return;
    }

    try {
      const mediaHost = parsedUrl.hostname.toLowerCase();
      const mediaOrigin =
        mediaHost === 'pw.live' || mediaHost.endsWith('.pw.live')
          ? 'https://pw.live'
          : PLAYER_UPSTREAM_ORIGIN;
      const mediaHeaders = new Headers();
      mediaHeaders.set('user-agent', req.headers['user-agent']?.toString() || DEFAULT_UA);
      mediaHeaders.set('referer', `${mediaOrigin}/`);
      mediaHeaders.set('origin', mediaOrigin);
      if (typeof req.headers.range === 'string') {
        mediaHeaders.set('range', req.headers.range);
      }
      if (typeof req.headers.accept === 'string') {
        mediaHeaders.set('accept', req.headers.accept);
      }

      const { res: upstreamMedia, buffer: buf } = await fetchUpstreamResponse(parsedUrl.toString(), {
        method: 'GET',
        headers: mediaHeaders,
        redirect: 'follow',
      });

      const ct = upstreamMedia.headers.get('content-type') || '';
      const lowerPath = parsedUrl.pathname.toLowerCase();
      const maybePlaylist =
        ct.includes('mpegurl') ||
        ct.includes('text/plain') ||
        lowerPath.endsWith('.m3u8') ||
        lowerPath.endsWith('.docx');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

      if (maybePlaylist) {
        const headText = buf.subarray(0, 64).toString('utf8').trimStart();
        if (headText.startsWith('#EXTM3U')) {
          const rewritten = rewriteM3u8Playlist(buf.toString('utf8'), parsedUrl.toString());
          res.status(upstreamMedia.status);
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=UTF-8');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.send(rewritten);
          return;
        }
        if (ct) res.setHeader('Content-Type', ct);
        res.status(upstreamMedia.status).send(buf);
        return;
      }

      const isDisguisedTsSegment =
        lowerPath.endsWith('.pdf') && buf.length >= 189 && buf[0] === 0x47 && buf[188] === 0x47;
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        if (h === 'content-type' && isDisguisedTsSegment) {
          res.setHeader('content-type', 'video/mp2t');
          continue;
        }
        const val = upstreamMedia.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.status(upstreamMedia.status).send(buf);
    } catch (err) {
      console.warn('Media proxy error:', err instanceof Error ? err.message : String(err));
      res.status(422).send('Media stream unavailable');
    }
  });

  // 3c. Content API proxy for samfygros.com/radha (class notes, DPPs, timeline slides, doubts, playlists)
  app.get('/__gb_radha', async (req: Request, res: Response) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('@')) {
      res.status(400).json({ success: false, error: 'Invalid radha path' });
      return;
    }

    try {
      const metaData = encodeRadhaMetaData(rawPath);
      const radhaUrl = `https://s4-cdn.samfygros.com/radha/index.php?type=contents&metaData=${encodeURIComponent(metaData)}`;
      const { res: upstreamRadha, buffer: radhaBuf } = await fetchUpstreamResponse(radhaUrl, {
        method: 'GET',
        headers: {
          'User-Agent': req.headers['user-agent']?.toString() || DEFAULT_UA,
          Accept: 'application/json, text/plain, */*',
          Origin: UPSTREAM_ORIGIN,
          Referer: `${UPSTREAM_ORIGIN}/`,
        },
      });

      const ct = upstreamRadha.headers.get('content-type') || '';
      const text = radhaBuf.toString('utf8');
      // Never emit 502/503/504 so AI Studio's Cloud Run dev proxy doesn't replace JSON with <!doctype html>
      const safeStatus =
        upstreamRadha.status >= 502 && upstreamRadha.status <= 504 ? 422 : upstreamRadha.status;
      res.status(safeStatus);
      res.setHeader('Content-Type', ct.includes('json') ? ct : 'application/json; charset=UTF-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (ct.includes('text/html') && text.trimStart().startsWith('<')) {
        res.json({ success: false, error: 'Upstream content endpoint returned HTML.' });
        return;
      }
      res.send(text);
    } catch (err) {
      console.warn('Radha proxy error:', err instanceof Error ? err.message : String(err));
      res.status(422).json({ success: false, error: 'Radha content unavailable.' });
    }
  });

  // 4. Reverse proxy all other routes (player endpoints -> PLAYER_UPSTREAM_ORIGIN, portal -> UPSTREAM_ORIGIN)
  app.all('*', async (req: Request, res: Response) => {
    const pathname = req.path.toLowerCase();
    const playerRoute = isPlayerRoute(pathname);
    const targetOrigin = playerRoute ? PLAYER_UPSTREAM_ORIGIN : UPSTREAM_ORIGIN;
    const isJsonApiRoute =
      pathname.startsWith('/api/') ||
      pathname.endsWith('/api.php') ||
      pathname.includes('/api/get_settings');
    const isTokenManagerRoute = pathname.endsWith('/api/token-manager.php');

    // Never force users to manually verify keys on task-verify.php — ensure active 24h key & redirect home
    if (pathname === '/task-verify.php' || pathname.endsWith('/task-verify.php')) {
      await ensureValidAccessKey();
      res.redirect(302, '/');
      return;
    }

    try {
      const targetUrl = new URL(req.originalUrl, targetOrigin).toString();
      let accessKey = playerRoute ? null : await ensureValidAccessKey();
      let headers = buildUpstreamHeaders(req, accessKey, targetOrigin);
      const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
      const body =
        hasBody && Buffer.isBuffer(req.body) && req.body.length > 0
          ? new Uint8Array(req.body)
          : undefined;

      let { res: upstreamRes, buffer: upstreamBuf } = await fetchUpstreamResponse(targetUrl, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });

      // If upstream key expired or was rejected (302 to task-verify.php), auto-generate fresh 24h key and retry once
      if (
        !playerRoute &&
        upstreamRes.status >= 300 &&
        upstreamRes.status < 400 &&
        /task-verify\.php/i.test(upstreamRes.headers.get('location') || '')
      ) {
        accessKey = await ensureValidAccessKey({
          forceRefresh: true,
          failedToken: accessKey?.accessToken,
        });
        headers = buildUpstreamHeaders(req, accessKey, targetOrigin);
        const retried = await fetchUpstreamResponse(targetUrl, {
          method: req.method,
          headers,
          body,
          redirect: 'manual',
        });
        upstreamRes = retried.res;
        upstreamBuf = retried.buffer;
      }

      const contentType = upstreamRes.headers.get('content-type') || '';

      // Handle upstream redirects safely
      if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
        const location = upstreamRes.headers.get('location');
        if (isJsonApiRoute) {
          res.status(422).json({ success: false, error: 'Upstream API redirected unexpectedly.' });
          return;
        }
        if (location) {
          forwardSetCookies(upstreamRes, req, res);
          if (/(?:t\.me|telegram\.me|channel\.studyrays\.cc)/i.test(location)) {
            res.redirect(upstreamRes.status, TELEGRAM_URL);
            return;
          }
          if (location.startsWith(targetOrigin)) {
            const rewritten = location.slice(targetOrigin.length) || '/';
            res.redirect(upstreamRes.status, rewritten);
            return;
          }
          if (location.startsWith(UPSTREAM_ORIGIN)) {
            const rewritten = location.slice(UPSTREAM_ORIGIN.length) || '/';
            res.redirect(upstreamRes.status, rewritten);
            return;
          }
          res.redirect(upstreamRes.status, location);
          return;
        }
      }

      // Guard JSON API routes so HTML error pages or 502/503/504 gateway statuses never trigger <!doctype html>
      if (isJsonApiRoute && contentType.includes('text/html')) {
        const safeErrStatus =
          upstreamRes.status >= 400 && (upstreamRes.status < 502 || upstreamRes.status > 504)
            ? upstreamRes.status
            : 422;
        res.status(safeErrStatus).json({
          success: false,
          error: 'Upstream API temporarily unavailable.',
        });
        return;
      }

      // Auto-solve play.php anti-scraper cookie challenge server-side & isolate player session cookies
      if (pathname.endsWith('/play.php') && contentType.includes('text/html')) {
        const isHttps = isHttpsRequest(req);
        const cookieMap = parseCookieMap(headers.get('cookie') || '');
        const outgoingCookies = new Map<string, string>();
        let finalRes = upstreamRes;
        let finalHtml = upstreamBuf.toString('utf8');

        let gotFreshSession = false;
        const recordSetCookies = (resObj: globalThis.Response) => {
          const list =
            typeof resObj.headers.getSetCookie === 'function'
              ? resObj.headers.getSetCookie()
              : [];
          for (const rawCookie of list) {
            const pair = rawCookie.split(';')[0] || '';
            const eqIdx = pair.indexOf('=');
            if (eqIdx === -1) continue;
            const cName = pair.slice(0, eqIdx).trim();
            const cVal = pair.slice(eqIdx + 1).trim();
            if (cName) {
              if (cName.toUpperCase() === 'PHPSESSID') {
                gotFreshSession = true;
              }
              cookieMap.set(cName, cVal);
              // Keep s4-cdn PHPSESSID server-side in playSessionStore so s2-cdn PHPSESSID is never overwritten
              if (cName.toUpperCase() !== 'PHPSESSID') {
                outgoingCookies.set(cName.toLowerCase(), rewriteSetCookieHeader(rawCookie, isHttps));
              }
            }
          }
        };

        recordSetCookies(upstreamRes);

        for (let attempt = 0; attempt < 3; attempt++) {
          const challenge = solvePlayChallenge(finalHtml);
          if (!challenge) break;

          if (attempt > 0 && !gotFreshSession) {
            cookieMap.clear();
            headers.delete('cookie');
            const freshFetch = await fetchUpstreamResponse(targetUrl, {
              method: req.method,
              headers,
              redirect: 'manual',
            });
            recordSetCookies(freshFetch.res);
            finalRes = freshFetch.res;
            finalHtml = freshFetch.buffer.toString('utf8');
            const freshChallenge = solvePlayChallenge(finalHtml);
            if (!freshChallenge) break;
            cookieMap.set(freshChallenge.cookieName, freshChallenge.cookieValue);
            outgoingCookies.set(
              freshChallenge.cookieName.toLowerCase(),
              rewriteSetCookieHeader(
                `${freshChallenge.cookieName}=${freshChallenge.cookieValue}; path=/; max-age=3600`,
                isHttps,
              ),
            );
          } else {
            cookieMap.set(challenge.cookieName, challenge.cookieValue);
            outgoingCookies.set(
              challenge.cookieName.toLowerCase(),
              rewriteSetCookieHeader(
                `${challenge.cookieName}=${challenge.cookieValue}; path=/; max-age=3600`,
                isHttps,
              ),
            );
          }

          headers.set('cookie', serializeCookieMap(cookieMap));
          const nextFetch = await fetchUpstreamResponse(targetUrl, {
            method: req.method,
            headers,
            redirect: 'manual',
          });
          recordSetCookies(nextFetch.res);
          finalRes = nextFetch.res;
          finalHtml = nextFetch.buffer.toString('utf8');
        }

        const effectivePwChk = cookieMap.get('_pw_sec_chk') || '';
        const effectivePhpSessId = cookieMap.get('PHPSESSID') || '';
        const playSid = savePlaySession(effectivePhpSessId, effectivePwChk);
        if (playSid) {
          outgoingCookies.set(
            '_gb_play_sid',
            rewriteSetCookieHeader(`_gb_play_sid=${playSid}; path=/; max-age=3600`, isHttps),
          );
        }

        if (outgoingCookies.size > 0) {
          res.setHeader('Set-Cookie', Array.from(outgoingCookies.values()));
        }

        res.status(finalRes.status);
        res.setHeader(
          'Content-Type',
          finalRes.headers.get('content-type') || 'text/html; charset=UTF-8',
        );
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(injectPlayCookieSync(rewriteHtml(finalHtml), effectivePwChk, playSid));
        return;
      }

      forwardSetCookies(upstreamRes, req, res);

      // Rewrite HTML pages
      if (contentType.includes('text/html')) {
        const html = upstreamBuf.toString('utf8');
        res.status(upstreamRes.status);
        res.setHeader('Content-Type', contentType);
        const cc = upstreamRes.headers.get('cache-control');
        if (cc) res.setHeader('Cache-Control', cc);
        const isMainUi = pathname === '/' || pathname === '/index.html';
        res.send(isMainUi ? injectStylishUi(rewriteHtml(html)) : rewriteHtml(html));
        return;
      }

      // Rewrite any first-party JS scripts (script-v43.js, shreee.js, start-dpp-test/script.js, etc.)
      if ((contentType.includes('javascript') || pathname.endsWith('.js')) && !pathname.includes('.min.')) {
        const js = upstreamBuf.toString('utf8');
        res.status(upstreamRes.status);
        res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        const processed = js.includes('Array.prototype.slice.call(arguments)')
          ? unlockObfuscatedScript(js)
          : patchPlainScript(js);
        res.send(processed);
        return;
      }

      // Rewrite get_settings JSON response
      if (pathname.includes('/api/get_settings')) {
        const raw = upstreamBuf.toString('utf8');
        res.status(upstreamRes.status);
        res.setHeader('Content-Type', 'application/json; charset=UTF-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(rewriteSettingsJson(raw));
        return;
      }

      // Pass through all other assets & API responses untouched
      const passHeaders = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition'];
      for (const h of passHeaders) {
        const val = upstreamRes.headers.get(h);
        if (val) res.setHeader(h, val);
      }

      let outStatus = upstreamRes.status;
      // AI Studio Cloud Run dev proxy intercepts 502/503/504 and replaces the body with <!doctype html>.
      // Map those gateway codes on JSON API routes so the client always receives clean JSON.
      if (isJsonApiRoute && outStatus >= 502 && outStatus <= 504) {
        outStatus = isTokenManagerRoute && contentType.includes('json') ? 200 : 422;
      }
      res.status(outStatus).send(upstreamBuf);
    } catch (err) {
      console.warn('Proxy upstream error:', req.originalUrl, err instanceof Error ? err.message : String(err));
      if (isJsonApiRoute) {
        res.status(422).json({ success: false, error: 'Upstream connection error. Please try again.' });
        return;
      }
      res.status(502).send('Upstream connection error. Please try again.');
    }
  });

  const server = http.createServer(app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`${BRAND_NAME} proxy server listening on http://0.0.0.0:${PORT}`);
    // Proactively generate / restore the 24-hour key on startup and keep it renewed automatically
    void ensureValidAccessKey();
    const watchdog = setInterval(() => {
      void ensureValidAccessKey();
    }, 15 * 60 * 1000);
    if (typeof watchdog.unref === 'function') {
      watchdog.unref();
    }
  });
}

startServer();
