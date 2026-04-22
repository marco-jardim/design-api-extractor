// ==UserScript==
// @name         DESIGN.md + API.md Extractor
// @namespace    marquinho.userscripts
// @version      1.0.0
// @description  Extract a TypeUI-compatible DESIGN.md and an inferred API.md (endpoints, headers, auth, schemas) from any website. Debloated clean-room alternative to the "DESIGN.md Style Extractor" Chrome extension, with an added internal-API contract sniffer.
// @author       marquinho
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_notification
// @noframes
// ==/UserScript==

/*
 * Runs at document-start so the network sniffer can hook fetch/XHR before the page
 * issues any requests. Design extraction runs on demand from a menu command or
 * keyboard shortcut (Ctrl+Shift+D for DESIGN.md, Ctrl+Shift+A for API.md).
 *
 * No network calls are made to any third party. Discovery probes (OpenAPI/GraphQL)
 * are opt-in via a separate menu command and only hit the same origin as the page.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const CFG = {
    sampleLimit: 280,
    bodySampleBytes: 48 * 1024,
    perEndpointSampleCap: 5,
    uiColor: '#111827',
    uiAccent: '#6366f1',
    // Deep probe
    probeMaxEndpoints: 150,
    probeIntervalMs: 200,
    probeTimeoutMs: 8000,
    probeMaxScriptBytes: 2 * 1024 * 1024, // cap per-script download at 2 MB
    probeMaxScripts: 40                   // cap how many external scripts we fetch
  };

  // Path segments we refuse to probe even with GET — they might be state-changing
  const DANGEROUS_PATH_WORDS = [
    'logout', 'signout', 'logoff', 'log-out', 'sign-out',
    'delete', 'destroy', 'remove', 'purge', 'wipe',
    'revoke', 'cancel', 'unsubscribe', 'deactivate', 'disable',
    'reset-password', 'reset_password', 'forgot-password'
  ];

  const SIZE_NAMES   = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'];
  const RADIUS_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
  const SURFACE_NAMES= ['base', 'muted', 'raised', 'strong'];
  const TEXT_NAMES   = ['primary', 'secondary', 'tertiary', 'inverse'];
  const BORDER_NAMES = ['default', 'muted', 'strong'];
  const MOTION_NAMES = ['instant', 'fast', 'normal', 'slow', 'slower'];

  const AUTH_HEADERS = new Set([
    'authorization', 'cookie', 'x-api-key', 'x-auth-token',
    'x-access-token', 'x-csrf-token', 'x-xsrf-token', 'x-session-id',
    'proxy-authorization', 'x-amz-security-token', 'x-firebase-auth'
  ]);

  // ---------------------------------------------------------------------------
  // Shared state
  // ---------------------------------------------------------------------------

  const state = {
    startedAt: Date.now(),
    observations: new Map(), // key = `${method} ${urlTemplate}`
    totalRequests: 0,
    errors: []
  };

  // Make accessible for debugging only
  window.__designApiExtractor = state;

  // ===========================================================================
  // 1. NETWORK SNIFFER — installed immediately
  // ===========================================================================

  installFetchHook();
  installXhrHook();

  function installFetchHook() {
    const original = window.fetch;
    if (typeof original !== 'function') return;

    window.fetch = async function patchedFetch(input, init) {
      const startedAt = performance.now();
      const req = buildRequestRecord(input, init);
      let response;
      try {
        response = await original.call(this, input, init);
      } catch (err) {
        recordCall(req, { error: String(err && err.message || err), durationMs: performance.now() - startedAt });
        throw err;
      }

      // Clone to read body without consuming the page's copy
      try {
        const cloned = response.clone();
        const body = await readBodySample(cloned);
        recordCall(req, {
          status: response.status,
          statusText: response.statusText,
          responseHeaders: headersToObj(response.headers),
          responseContentType: response.headers.get('content-type') || '',
          responseSample: body,
          durationMs: performance.now() - startedAt
        });
      } catch (err) {
        recordCall(req, {
          status: response.status,
          responseHeaders: headersToObj(response.headers),
          durationMs: performance.now() - startedAt,
          error: 'response body read failed: ' + (err && err.message || err)
        });
      }
      return response;
    };
  }

  function installXhrHook() {
    const XHR = window.XMLHttpRequest;
    if (!XHR) return;
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__sniff = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url || ''),
        requestHeaders: {},
        startedAt: 0,
        requestBody: null
      };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      if (this.__sniff) {
        this.__sniff.requestHeaders[String(name).toLowerCase()] = String(value);
      }
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      const s = this.__sniff;
      if (s) {
        s.startedAt = performance.now();
        s.requestBody = body;
        this.addEventListener('loadend', () => {
          try {
            const responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
            let sample = null;
            const type = (responseHeaders['content-type'] || '').toLowerCase();
            if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
              const raw = this.responseType === 'json' ? this.response : this.responseText;
              sample = summarizeBody(raw, type);
            } else if (this.responseType === 'arraybuffer' || this.responseType === 'blob') {
              sample = { kind: 'binary', type: this.responseType };
            }
            const req = buildRequestRecordFromParts(s.method, s.url, s.requestHeaders, s.requestBody);
            recordCall(req, {
              status: this.status,
              statusText: this.statusText,
              responseHeaders,
              responseContentType: responseHeaders['content-type'] || '',
              responseSample: sample,
              durationMs: performance.now() - s.startedAt
            });
          } catch (err) {
            state.errors.push('xhr record: ' + err);
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function buildRequestRecord(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : String(input);
    const method = ((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();
    const headers = {};
    if (init && init.headers) Object.assign(headers, headersToObj(init.headers));
    if (isRequest) Object.assign(headers, headersToObj(input.headers));
    const body = (init && init.body) || (isRequest ? input._body : null);
    return buildRequestRecordFromParts(method, url, headers, body);
  }

  function buildRequestRecordFromParts(method, url, headers, body) {
    const absolute = toAbsoluteUrl(url);
    const u = tryUrl(absolute);
    return {
      method,
      url: absolute,
      host: u ? u.host : '',
      origin: u ? u.origin : '',
      pathname: u ? u.pathname : url,
      queryParams: u ? Array.from(u.searchParams.keys()) : [],
      requestHeaders: Object.fromEntries(
        Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
      ),
      requestBody: summarizeRequestBody(body, headers)
    };
  }

  function recordCall(req, callInfo) {
    // Skip data:/blob:/extension URLs and our own generation activity
    if (!req.url || /^(data|blob|chrome|chrome-extension|moz-extension):/i.test(req.url)) return;

    state.totalRequests += 1;
    const template = templatizeUrl(req.pathname);
    const key = req.method + ' ' + (req.host ? req.host + template : template);

    let obs = state.observations.get(key);
    if (!obs) {
      obs = {
        key,
        method: req.method,
        host: req.host,
        origin: req.origin,
        urlTemplate: template,
        calls: [],
        requestHeaderFreq: new Map(),
        responseHeaderFreq: new Map(),
        queryParamFreq: new Map(),
        statusCounts: new Map(),
        contentTypes: new Set(),
        sampleRequestBodies: [],
        sampleResponseBodies: [],
        isGraphQL: false,
        graphQLOps: new Set()
      };
      state.observations.set(key, obs);
    }

    // Update frequency maps
    for (const h of Object.keys(req.requestHeaders || {})) {
      obs.requestHeaderFreq.set(h, (obs.requestHeaderFreq.get(h) || 0) + 1);
    }
    for (const h of Object.keys(callInfo.responseHeaders || {})) {
      obs.responseHeaderFreq.set(h, (obs.responseHeaderFreq.get(h) || 0) + 1);
    }
    for (const q of req.queryParams || []) {
      obs.queryParamFreq.set(q, (obs.queryParamFreq.get(q) || 0) + 1);
    }
    if (callInfo.status) {
      obs.statusCounts.set(callInfo.status, (obs.statusCounts.get(callInfo.status) || 0) + 1);
    }
    if (callInfo.responseContentType) obs.contentTypes.add(callInfo.responseContentType.split(';')[0].trim());

    // GraphQL detection
    if (req.requestBody && typeof req.requestBody === 'object' && req.requestBody.kind === 'json'
        && req.requestBody.value && (req.requestBody.value.query || req.requestBody.value.operationName)) {
      obs.isGraphQL = true;
      const op = extractGraphQLOperation(req.requestBody.value);
      if (op) obs.graphQLOps.add(op);
    }

    // Cap sample calls
    if (obs.calls.length < CFG.perEndpointSampleCap) {
      obs.calls.push({
        url: req.url,
        requestHeaders: redactHeaders(req.requestHeaders),
        requestBody: req.requestBody,
        status: callInfo.status,
        statusText: callInfo.statusText,
        responseHeaders: redactHeaders(callInfo.responseHeaders),
        responseSample: callInfo.responseSample,
        durationMs: callInfo.durationMs,
        error: callInfo.error
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Sniffer utilities
  // ---------------------------------------------------------------------------

  function toAbsoluteUrl(url) {
    try { return new URL(url, window.location.href).href; }
    catch { return String(url); }
  }

  function tryUrl(url) { try { return new URL(url); } catch { return null; } }

  function headersToObj(h) {
    const obj = {};
    if (!h) return obj;
    if (typeof h.forEach === 'function') {
      h.forEach((value, name) => { obj[String(name).toLowerCase()] = String(value); });
      return obj;
    }
    if (Array.isArray(h)) {
      for (const [k, v] of h) obj[String(k).toLowerCase()] = String(v);
      return obj;
    }
    for (const k of Object.keys(h || {})) obj[String(k).toLowerCase()] = String(h[k]);
    return obj;
  }

  function parseRawHeaders(raw) {
    const obj = {};
    if (!raw) return obj;
    for (const line of String(raw).trim().split(/[\r\n]+/)) {
      const idx = line.indexOf(':');
      if (idx < 1) continue;
      obj[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return obj;
  }

  async function readBodySample(response) {
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!response.body) return null;
    try {
      if (type.includes('json')) {
        const text = await response.text();
        return summarizeBody(text, type);
      }
      if (type.startsWith('text/') || type.includes('xml') || type.includes('html') || type.includes('javascript')) {
        const text = await response.text();
        return { kind: 'text', type, preview: text.slice(0, 2000), length: text.length };
      }
      return { kind: 'binary', type };
    } catch {
      return null;
    }
  }

  function summarizeBody(raw, contentType) {
    if (raw == null) return null;
    if (typeof raw === 'object' && !(raw instanceof ArrayBuffer)) {
      return { kind: 'json', schema: inferSchema(raw), preview: safeJsonSlice(raw) };
    }
    const text = String(raw);
    if ((contentType || '').includes('json') || /^[\[{]/.test(text.trim())) {
      try {
        const parsed = JSON.parse(text);
        return { kind: 'json', schema: inferSchema(parsed), preview: safeJsonSlice(parsed) };
      } catch {}
    }
    return { kind: 'text', preview: text.slice(0, 2000), length: text.length };
  }

  function summarizeRequestBody(body, headers) {
    if (body == null) return null;
    const ct = (headersToObj(headers)['content-type'] || '').toLowerCase();
    if (typeof body === 'string') {
      if (ct.includes('json') || /^[\[{]/.test(body.trim())) {
        try {
          const parsed = JSON.parse(body);
          return { kind: 'json', value: parsed, schema: inferSchema(parsed) };
        } catch {}
      }
      if (ct.includes('x-www-form-urlencoded')) {
        const params = {};
        for (const [k, v] of new URLSearchParams(body).entries()) params[k] = v;
        return { kind: 'form', value: params, keys: Object.keys(params) };
      }
      return { kind: 'text', preview: body.slice(0, 800) };
    }
    if (body instanceof FormData) {
      const keys = [];
      try { body.forEach((_v, k) => keys.push(k)); } catch {}
      return { kind: 'formdata', keys };
    }
    if (body instanceof URLSearchParams) {
      const params = {};
      for (const [k, v] of body.entries()) params[k] = v;
      return { kind: 'form', value: params, keys: Object.keys(params) };
    }
    if (body instanceof ArrayBuffer || (body && body.byteLength != null)) return { kind: 'binary' };
    if (body && body.constructor === Object) {
      return { kind: 'json', value: body, schema: inferSchema(body) };
    }
    return { kind: 'unknown' };
  }

  function safeJsonSlice(value) {
    try {
      const str = JSON.stringify(value, null, 2);
      if (!str) return '';
      return str.length > CFG.bodySampleBytes ? str.slice(0, CFG.bodySampleBytes) + '\n…(truncated)' : str;
    } catch {
      return String(value).slice(0, 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // URL templating
  // ---------------------------------------------------------------------------

  function templatizeUrl(pathname) {
    if (!pathname) return '/';
    return pathname
      .split('/')
      .map(segment => {
        if (!segment) return segment;
        if (/^[0-9]+$/.test(segment)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':uuid';
        if (/^[0-9a-f]{24}$/i.test(segment)) return ':objectId';
        if (/^[0-9a-f]{32,}$/i.test(segment)) return ':hash';
        if (/^[A-Za-z0-9_-]{20,}$/.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)) return ':token';
        return segment;
      })
      .join('/');
  }

  // ---------------------------------------------------------------------------
  // Redaction
  // ---------------------------------------------------------------------------

  function redactHeaders(headers) {
    if (!headers) return headers;
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (AUTH_HEADERS.has(lower) || /^set-cookie$/i.test(name)) {
        out[lower] = redactValue(value);
      } else {
        out[lower] = redactLikelySecret(String(value));
      }
    }
    return out;
  }

  function redactValue(value) {
    const v = String(value || '');
    const scheme = v.match(/^(Bearer|Basic|Digest|Token|ApiKey|Key)\s+/i);
    if (scheme) return `${scheme[1]} <REDACTED>`;
    return '<REDACTED>';
  }

  function redactLikelySecret(text) {
    if (!text) return text;
    let out = text;
    // JWT
    out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<JWT>');
    // Long random tokens mixed alphanumeric
    out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => /[A-Za-z]/.test(m) && /[0-9]/.test(m) ? '<TOKEN>' : m);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Schema inference
  // ---------------------------------------------------------------------------

  function inferSchema(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      if (value.length === 0) return { kind: 'array', items: 'unknown' };
      const items = value.slice(0, 10).map(inferSchema);
      return { kind: 'array', items: mergeTypes(items), length: value.length };
    }
    if (typeof value === 'object') {
      const fields = {};
      for (const [k, v] of Object.entries(value)) fields[k] = inferSchema(v);
      return { kind: 'object', fields };
    }
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return 'string(datetime)';
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'string(date)';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'string(uuid)';
      if (/^https?:\/\//.test(value)) return 'string(url)';
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'string(email)';
      return 'string';
    }
    return typeof value;
  }

  function mergeTypes(types) {
    if (types.length === 0) return 'unknown';
    if (types.length === 1) return types[0];
    const objects = types.filter(t => t && t.kind === 'object');
    const arrays = types.filter(t => t && t.kind === 'array');
    const primitives = types.filter(t => typeof t === 'string');
    const unique = Array.from(new Set(primitives));

    if (objects.length && !arrays.length && !unique.length) {
      const all = {};
      for (const o of objects) for (const [k, v] of Object.entries(o.fields)) {
        all[k] = all[k] ? mergeTypes([all[k], v]) : v;
      }
      return { kind: 'object', fields: all };
    }
    if (arrays.length && !objects.length && !unique.length) {
      return { kind: 'array', items: mergeTypes(arrays.map(a => a.items)) };
    }
    if (unique.length && !objects.length && !arrays.length) {
      return unique.join(' | ');
    }
    return 'union';
  }

  function renderSchema(schema, indent = 0) {
    const pad = '  '.repeat(indent);
    if (!schema) return 'unknown';
    if (typeof schema === 'string') return schema;
    if (schema.kind === 'array') {
      const inner = renderSchema(schema.items, indent);
      return /\n/.test(inner) ? inner + '[]' : inner + '[]';
    }
    if (schema.kind === 'object') {
      const lines = ['{'];
      for (const [k, v] of Object.entries(schema.fields)) {
        const rendered = renderSchema(v, indent + 1);
        lines.push(`${pad}  ${k}: ${rendered}${Object.keys(schema.fields).pop() === k ? '' : ','}`);
      }
      lines.push(pad + '}');
      return lines.join('\n');
    }
    return String(schema);
  }

  function extractGraphQLOperation(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.operationName) return body.operationName;
    if (typeof body.query === 'string') {
      const m = body.query.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) return `${m[1]} ${m[2]}`;
      const opM = body.query.match(/^\s*(query|mutation|subscription)\b/);
      if (opM) return opM[1];
    }
    return null;
  }

  // ===========================================================================
  // 2. DESIGN EXTRACTION (DOM-based, runs on demand)
  // ===========================================================================

  function extractStylesFromPage() {
    const sampled = collectSampledElements(CFG.sampleLimit);
    const typography = [], colors = [], spacing = [], radius = [], shadows = [], motion = [];

    for (const el of sampled) {
      const s = window.getComputedStyle(el);
      typography.push({
        fontFamily: normWs(s.fontFamily),
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        fontWeight: s.fontWeight,
        letterSpacing: s.letterSpacing
      });
      colors.push({
        textColor: s.color,
        backgroundColor: s.backgroundColor,
        borderColor: s.borderColor,
        outlineColor: s.outlineColor
      });
      spacing.push({
        marginTop: s.marginTop, marginRight: s.marginRight,
        marginBottom: s.marginBottom, marginLeft: s.marginLeft,
        paddingTop: s.paddingTop, paddingRight: s.paddingRight,
        paddingBottom: s.paddingBottom, paddingLeft: s.paddingLeft
      });
      radius.push(s.borderRadius);
      shadows.push(s.boxShadow);
      motion.push({
        transitionDuration: s.transitionDuration,
        transitionTimingFunction: s.transitionTimingFunction,
        animationDuration: s.animationDuration,
        animationTimingFunction: s.animationTimingFunction
      });
    }

    return {
      source: { url: location.href, title: document.title || 'Untitled page' },
      sampledAt: new Date().toISOString(),
      totalElements: document.querySelectorAll('*').length,
      sampledElements: sampled.length,
      typography, colors, spacing, radius, shadows, motion,
      cssCustomProperties: collectCssCustomProperties(),
      fontFaces: collectFontFaces(),
      components: collectComponentCounts(),
      siteSignals: collectSiteSignals()
    };
  }

  function collectSampledElements(limit) {
    const selectors = [
      'body', 'h1,h2,h3,h4,h5,h6', 'p', 'a', 'button',
      'input,textarea,select', 'label',
      'nav,header,footer,main,section,article,aside',
      'ul li,ol li', 'table,th,td',
      "[role='button']", "[class*='card']", "[class*='btn']", '[tabindex]'
    ];
    const seen = new Set(), out = [];
    for (const sel of selectors) {
      for (const node of document.querySelectorAll(sel)) {
        if (!(node instanceof HTMLElement) || seen.has(node) || !isVisible(node)) continue;
        seen.add(node); out.push(node);
        if (out.length >= limit) return out;
      }
    }
    if (out.length === 0 && document.body) out.push(document.body);
    return out;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function collectCssCustomProperties() {
    const rootStyle = getComputedStyle(document.documentElement);
    const props = {};
    // Walk stylesheet rules looking for --custom-property declarations
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (!rule.style) continue;
          for (let i = 0; i < rule.style.length; i++) {
            const name = rule.style[i];
            if (name && name.startsWith('--')) {
              const value = rootStyle.getPropertyValue(name).trim() || rule.style.getPropertyValue(name).trim();
              if (value && !props[name]) props[name] = value;
            }
          }
        }
      }
    } catch {}
    return props;
  }

  function collectFontFaces() {
    const out = [];
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (rule.type === CSSRule.FONT_FACE_RULE) {
            out.push({
              family: (rule.style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim(),
              src: (rule.style.getPropertyValue('src') || '').slice(0, 200),
              weight: rule.style.getPropertyValue('font-weight') || '',
              style: rule.style.getPropertyValue('font-style') || ''
            });
          }
        }
      }
    } catch {}
    return out;
  }

  function collectComponentCounts() {
    const map = {
      buttons:    "button, [role='button'], .btn, [class*='button']",
      links:      'a[href]',
      inputs:     'input, textarea, select',
      cards:      ".card, [class*='card'], article",
      navigation: 'nav, header',
      lists:      'ul, ol',
      tables:     'table'
    };
    return Object.entries(map).map(([type, sel]) => ({ type, count: document.querySelectorAll(sel).length }));
  }

  function collectSiteSignals() {
    return {
      title: document.title || '',
      description: getMeta('description'),
      keywords: getMeta('keywords'),
      ogType: getMeta('og:type', true),
      ogSiteName: getMeta('og:site_name', true),
      appName: getMeta('application-name'),
      pathname: location.pathname || '/',
      hostname: location.hostname || '',
      headings: collectTexts('h1, h2', 10, 120),
      navTexts: collectTexts('nav a, nav button, header a, header button', 24, 50),
      ctaTexts: collectTexts("button, [role='button'], a[class*='button'], a[class*='btn'], input[type='submit']", 24, 40),
      textSample: normWs((document.body && document.body.innerText || '').slice(0, 14000)),
      elementCounts: {
        forms: document.querySelectorAll('form').length,
        inputs: document.querySelectorAll('input, textarea, select').length,
        tables: document.querySelectorAll('table').length,
        codeBlocks: document.querySelectorAll('pre, code').length,
        articles: document.querySelectorAll('article').length
      }
    };
  }

  function getMeta(name, property = false) {
    const sel = property ? `meta[property="${name}"]` : `meta[name="${name}"]`;
    return normWs((document.querySelector(sel) || {}).getAttribute ? document.querySelector(sel).getAttribute('content') || '' : '');
  }

  function collectTexts(sel, limit, maxLen) {
    const seen = new Set(), out = [];
    for (const node of document.querySelectorAll(sel)) {
      if (!(node instanceof HTMLElement)) continue;
      const t = normWs(node.innerText || node.textContent || '');
      if (!t || t.length > maxLen || seen.has(t)) continue;
      seen.add(t); out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ===========================================================================
  // 3. NORMALIZATION → DESIGN TOKENS
  // ===========================================================================

  function normalizeExtraction(p) {
    const typeMap = new Map(), fontFamilyMap = new Map();
    const textMap = new Map(), bgMap = new Map(), borderMap = new Map(), focusMap = new Map();
    const spaceMap = new Map(), radiusMap = new Map(), shadowMap = new Map();
    const motionDur = new Map(), motionEase = new Map();

    for (const r of p.typography || []) {
      const fs = parsePx(r.fontSize);
      if (fs !== null) bump(typeMap, String(fs));
      const ff = normalizeFamily(r.fontFamily);
      if (ff) bump(fontFamilyMap, ff);
    }
    for (const r of p.colors || []) {
      const text = toHexColor(r.textColor);
      const bg = toHexColor(r.backgroundColor);
      const bd = toHexColor(r.borderColor);
      const ol = toHexColor(r.outlineColor);
      if (text && !isTransparent(text)) bump(textMap, text);
      if (bg && !isTransparent(bg)) bump(bgMap, bg);
      if (bd && !isTransparent(bd)) bump(borderMap, bd);
      if (ol && !isTransparent(ol)) bump(focusMap, ol);
    }
    for (const r of p.spacing || []) {
      for (const raw of [r.marginTop, r.marginRight, r.marginBottom, r.marginLeft,
                         r.paddingTop, r.paddingRight, r.paddingBottom, r.paddingLeft]) {
        const px = parsePx(raw);
        if (px !== null && px > 0) bump(spaceMap, String(px));
      }
    }
    for (const v of p.radius || []) {
      const px = parsePx(v); if (px !== null && px > 0) bump(radiusMap, String(px));
    }
    for (const v of p.shadows || []) {
      const n = normWs(v); if (n && n !== 'none') bump(shadowMap, n);
    }
    for (const r of p.motion || []) {
      const d = parseDuration(r.transitionDuration) ?? parseDuration(r.animationDuration);
      const e = normWs(r.transitionTimingFunction || r.animationTimingFunction);
      if (d !== null && d > 0) bump(motionDur, String(d));
      if (e && e !== 'ease') bump(motionEase, e);
    }

    const typographyScale = scaleTokens(numericKeys(typeMap), SIZE_NAMES, 'font.size');
    const spacingScale    = scaleTokens(numericKeys(spaceMap), [], 'space', true);
    const radiusTokens    = scaleTokens(numericKeys(radiusMap), RADIUS_NAMES, 'radius');
    const shadowTokens    = rankedTokens(shadowMap, 'shadow');
    const motionDuration  = scaleTokens(numericKeys(motionDur), MOTION_NAMES, 'motion.duration', false, 'ms');
    const motionEasing    = rankedTokens(motionEase, 'motion.easing', true);
    const colorPalette    = buildColorTokens(textMap, bgMap, borderMap, focusMap);
    const mainFont        = inferMainFont(p.typography || [], fontFamilyMap);
    const siteProfile     = inferSiteProfile(p);

    const diagnostics = [];
    if (p.sampledElements < 30) diagnostics.push('Low sample size: fewer than 30 visible elements.');
    if (colorPalette.length < 4) diagnostics.push('Limited color diversity; token inference confidence low.');
    if (typographyScale.length < 3) diagnostics.push('Limited typography variety; size scale may need manual refinement.');
    if (!mainFont.familyStack) diagnostics.push('Main font family could not be confidently extracted.');

    return {
      source: p.source, sampledAt: p.sampledAt,
      sampledElements: p.sampledElements, totalElements: p.totalElements,
      typographyScale, mainFont, colorPalette, spacingScale, radiusTokens,
      shadowTokens, motionDuration, motionEasing,
      cssCustomProperties: p.cssCustomProperties || {},
      fontFaces: p.fontFaces || [],
      componentHints: (p.components || []).filter(c => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 7),
      siteProfile, diagnostics
    };
  }

  function inferMainFont(rows, familyMap) {
    const topFamily = topEntries(familyMap, 1)[0];
    const familyStack = topFamily ? topFamily.key : '';
    if (!familyStack) return { familyStack: '', primaryFamily: '', weight: '', size: '', lineHeight: '', usage: 0, confidence: 'low' };
    const primary = (familyStack.split(',')[0] || '').trim().replace(/^['"]|['"]$/g, '');
    const styleMap = new Map();
    for (const r of rows) {
      if (normalizeFamily(r.fontFamily) !== familyStack) continue;
      bump(styleMap, JSON.stringify({ weight: normWs(r.fontWeight), size: normWs(r.fontSize), lineHeight: normWs(r.lineHeight) }));
    }
    const topStyle = topEntries(styleMap, 1)[0];
    const style = topStyle ? JSON.parse(topStyle.key) : {};
    const ratio = rows.length > 0 ? topFamily.count / rows.length : 0;
    const styleUsage = topStyle ? topStyle.count : 0;
    const confidence = ratio >= 0.45 && styleUsage >= 3 ? 'high' : (ratio >= 0.2 && styleUsage >= 1 ? 'medium' : 'low');
    return { familyStack, primaryFamily: primary, weight: style.weight || '', size: style.size || '', lineHeight: style.lineHeight || '', usage: topFamily.count, confidence };
  }

  // Compact site profile: single-pass keyword/cue scoring (no evidence bookkeeping)
  function inferSiteProfile(p) {
    const s = p.siteSignals || {}, c = s.elementCounts || {};
    const corpus = [p.source && p.source.url, s.title, s.description, s.keywords, s.ogType, s.ogSiteName,
                    s.appName, s.pathname, (s.headings || []).join(' '), (s.navTexts || []).join(' '),
                    (s.ctaTexts || []).join(' '), (s.textSample || '').slice(0, 2400)]
                   .filter(Boolean).join(' ').toLowerCase();

    const kw = (words, w) => words.reduce((acc, word) => corpus.includes(word) ? acc + w : acc, 0);
    const num = (v, t, w) => (Number(v) || 0) >= t ? w * Math.max(1, Math.floor((Number(v) || 0) / t)) : 0;
    const path = (fragments, sc) => fragments.some(f => (s.pathname || '').toLowerCase().includes(f)) ? sc : 0;

    const surface = {
      documentation: kw(['docs', 'documentation', 'api', 'reference', 'sdk', 'cli', 'guide', 'endpoint'], 0.8) + num(c.codeBlocks, 4, 0.35) + path(['/docs', '/api', '/reference'], 2),
      dashboard:     kw(['dashboard', 'workspace', 'settings', 'admin', 'billing', 'projects', 'users'], 0.7) + num(c.forms, 3, 0.4) + num(c.tables, 1, 0.45),
      marketing:     kw(['features', 'pricing', 'book demo', 'testimonials', 'enterprise', 'get started'], 0.6),
      content:       kw(['blog', 'article', 'newsletter', 'author', 'published'], 0.7) + num(c.articles, 2, 0.5),
      ecommerce:     kw(['shop', 'product', 'checkout', 'cart', 'buy now', 'shipping'], 0.8),
      webapp:        kw(['account', 'profile', 'app', 'platform', 'integrations'], 0.35)
    };
    const topSurface = Object.entries(surface).sort((a, b) => b[1] - a[1])[0];

    const audience = {
      developer: kw(['developer', 'api', 'sdk', 'cli', 'github', 'integration'], 0.75) + num(c.codeBlocks, 3, 0.45),
      operator:  kw(['dashboard', 'workspace', 'manage', 'admin', 'team'], 0.55) + num(c.forms, 2, 0.35),
      business:  kw(['enterprise', 'pricing', 'sales', 'customers'], 0.55),
      consumer:  kw(['shop', 'cart', 'checkout', 'buy', 'shipping'], 0.65),
      reader:    kw(['blog', 'article', 'newsletter', 'read'], 0.55),
      general:   kw(['home', 'welcome', 'about', 'contact'], 0.2)
    };
    const topAudience = Object.entries(audience).sort((a, b) => b[1] - a[1])[0];

    const surfaceLabels = { documentation: 'documentation site', dashboard: 'dashboard web app', marketing: 'marketing site', content: 'content site', ecommerce: 'e-commerce storefront', webapp: 'web app' };
    const audienceLabels = { developer: 'developers and technical teams', operator: 'authenticated users and operators', business: 'buyers, teams, and decision-makers', consumer: 'online shoppers and consumers', reader: 'readers and knowledge seekers', general: 'website visitors and product users' };

    return {
      audience: audienceLabels[topAudience[0]],
      productSurface: surfaceLabels[topSurface[0]],
      confidence: topSurface[1] >= 2.4 ? 'medium' : 'low'
    };
  }

  // ---------------------------------------------------------------------------
  // Normalization helpers
  // ---------------------------------------------------------------------------

  function buildColorTokens(textMap, bgMap, borderMap, focusMap) {
    const rows = [];
    topEntries(textMap, 4).forEach((e, i) => rows.push({ token: `color.text.${TEXT_NAMES[i] || 'level' + (i + 1)}`, value: e.key, usage: e.count }));
    topEntries(bgMap, 4).forEach((e, i) => rows.push({ token: `color.surface.${SURFACE_NAMES[i] || 'level' + (i + 1)}`, value: e.key, usage: e.count }));
    topEntries(borderMap, 3).forEach((e, i) => rows.push({ token: `color.border.${BORDER_NAMES[i] || 'level' + (i + 1)}`, value: e.key, usage: e.count }));
    const focus = topEntries(focusMap, 1)[0];
    if (focus) rows.push({ token: 'color.focus.ring', value: focus.key, usage: focus.count });
    const byValue = new Map();
    for (const r of rows) { const ex = byValue.get(r.value); if (!ex || r.usage > ex.usage) byValue.set(r.value, r); }
    return Array.from(byValue.values());
  }

  function scaleTokens(values, names, prefix, numericSeq = false, unit = 'px') {
    return values.map((v, i) => ({ token: `${prefix}.${numericSeq ? i + 1 : names[i] || 'step' + (i + 1)}`, value: `${v}${unit}`, usage: 0 }));
  }
  function rankedTokens(map, prefix, keepRaw = false) {
    return topEntries(map, 4).map((e, i) => ({ token: `${prefix}.${i + 1}`, value: keepRaw ? e.key : normWs(e.key), usage: e.count }));
  }
  function numericKeys(map) {
    return Array.from(map.keys()).map(k => parseFloat(k)).filter(Number.isFinite).sort((a, b) => a - b);
  }
  function topEntries(map, limit) {
    return Array.from(map.entries()).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  }
  function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }
  function parsePx(v) {
    if (!v || v === 'normal' || v === 'auto') return null;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function parseDuration(v) {
    if (!v) return null;
    const first = String(v).split(',')[0].trim();
    if (!first) return null;
    if (first.endsWith('ms')) { const n = parseFloat(first); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; }
    if (first.endsWith('s'))  { const n = parseFloat(first); return Number.isFinite(n) ? Math.round(n * 1000 * 10) / 10 : null; }
    return null;
  }
  function toHexColor(v) {
    if (!v) return null;
    const raw = normWs(String(v).toLowerCase());
    if (!raw) return null;
    if (raw.startsWith('#')) return raw;
    const m = raw.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return raw;
    const [r, g, b] = m[1].split(',').slice(0, 3).map(p => parseFloat(p.trim()));
    if (![r, g, b].every(Number.isFinite)) return raw;
    const h = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  function isTransparent(v) { return v.includes('transparent'); }
  function normalizeFamily(v) {
    const raw = normWs(v || ''); if (!raw) return '';
    return raw.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join(', ');
  }
  function normWs(v) { return String(v || '').trim().replace(/\s+/g, ' '); }

  // ===========================================================================
  // 4. DESIGN.md GENERATION
  // ===========================================================================

  function buildDesignMarkdown(norm) {
    const profile = norm.siteProfile || {};
    const systemName = inferSystemName(norm.source && norm.source.title);
    const brand = systemName;
    const url = (norm.source && norm.source.url) || 'Unknown URL';
    const audience = profile.audience || 'website visitors and product users';
    const surface = profile.productSurface || 'web app';

    const tokenJoin = (rows, limit) => (!rows || !rows.length)
      ? 'No reliable extraction yet; define semantic tokens manually.'
      : rows.slice(0, limit).map(r => `\`${r.token}=${r.value}\``).join(', ');

    const groups = [norm.radiusTokens, norm.shadowTokens, norm.motionDuration].filter(g => g && g.length);
    const shapeMotion = groups.length
      ? groups.map(g => g.slice(0, 8).map(r => `\`${r.token}=${r.value}\``).join(', ')).join(' | ')
      : 'No reliable extraction yet; shape and motion tokens should be defined manually.';

    const mainFontStr = !norm.mainFont.familyStack
      ? 'No reliable primary font family detected from computed styles.'
      : [
          `\`font.family.primary=${norm.mainFont.primaryFamily || norm.mainFont.familyStack}\``,
          norm.mainFont.familyStack && `\`font.family.stack=${norm.mainFont.familyStack}\``,
          norm.mainFont.size && `\`font.size.base=${norm.mainFont.size}\``,
          norm.mainFont.weight && `\`font.weight.base=${norm.mainFont.weight}\``,
          norm.mainFont.lineHeight && `\`font.lineHeight.base=${norm.mainFont.lineHeight}\``
        ].filter(Boolean).join(', ');

    const componentNotes = norm.componentHints.map(c => `${c.type} (${c.count})`).join(', ') || 'not enough evidence from extraction';
    const visualStyle = norm.colorPalette.length >= 8 && norm.spacingScale.length >= 6
      ? 'structured, tokenized, content-first'
      : (norm.colorPalette.length >= 5 ? 'clean, functional, implementation-oriented' : 'minimal, utility-first, accessibility-prioritized');

    const customProps = Object.entries(norm.cssCustomProperties || {}).slice(0, 40);
    const customPropsBlock = customProps.length
      ? '\n## CSS Custom Properties (on :root / sampled rules)\n' + customProps.map(([k, v]) => `- \`${k}: ${v}\``).join('\n') + '\n'
      : '';

    const fontFaceBlock = norm.fontFaces.length
      ? '\n## Font Faces Declared\n' + norm.fontFaces.slice(0, 12).map(f => `- \`${f.family}\` weight=\`${f.weight || 'normal'}\` style=\`${f.style || 'normal'}\``).join('\n') + '\n'
      : '';

    const diag = norm.diagnostics.length ? `\n- Extraction diagnostics: ${norm.diagnostics.join(' ')}` : '';

    return `# ${systemName}

## Mission
Create implementation-ready, token-driven UI guidance for ${brand} that is optimized for consistency, accessibility, and fast delivery across ${surface}.

## Brand
- Product/brand: ${brand}
- URL: ${url}
- Audience: ${audience}
- Product surface: ${surface}

## Style Foundations
- Visual style: ${visualStyle}
- Main font style: ${mainFontStr}
- Typography scale: ${tokenJoin(norm.typographyScale, 8)}
- Color palette: ${tokenJoin(norm.colorPalette, 10)}
- Spacing scale: ${tokenJoin(norm.spacingScale, 8)}
- Radius/shadow/motion tokens: ${shapeMotion}
${customPropsBlock}${fontFaceBlock}
## Accessibility
- Target: WCAG 2.2 AA.
- Keyboard-first interactions required.
- Focus-visible rules required.
- Contrast constraints required.

## Writing Tone
Concise, confident, implementation-focused.

## Rules: Do
- Use semantic tokens, not raw hex values, in component guidance.
- Every component must define states for default, hover, focus-visible, active, disabled, loading, and error.
- Component behavior should specify responsive and edge-case handling.
- Interactive components must document keyboard, pointer, and touch behavior.
- Accessibility acceptance criteria must be testable in implementation.

## Rules: Don't
- Do not allow low-contrast text or hidden focus indicators.
- Do not introduce one-off spacing or typography exceptions.
- Do not use ambiguous labels or non-descriptive actions.
- Do not ship component guidance without explicit state rules.

## Component Rule Expectations
- Include keyboard, pointer, and touch behavior.
- Include spacing and typography token requirements.
- Include long-content, overflow, and empty-state handling.
- Known page component density: ${componentNotes}.${diag}

## Quality Gates
- Every non-negotiable rule must use "must".
- Every recommendation should use "should".
- Every accessibility rule must be testable in implementation.
- Teams should prefer system consistency over local visual exceptions.

---
_Extracted from ${url} on ${norm.sampledAt} — sampled ${norm.sampledElements}/${norm.totalElements} visible elements._
`;
  }

  function inferSystemName(title) {
    if (!title) return 'Extracted Design System';
    const clean = title.replace(/\s*\|\s*.*/g, '').replace(/\s*-\s*.*/g, '').trim();
    return clean || 'Extracted Design System';
  }

  // ===========================================================================
  // 5. API.md GENERATION
  // ===========================================================================

  function buildApiMarkdown() {
    const obs = Array.from(state.observations.values())
      .filter(o => !looksLikeStaticAsset(o))
      .sort((a, b) => (a.host + a.urlTemplate).localeCompare(b.host + b.urlTemplate));

    if (obs.length === 0) {
      return `# API Contract — ${location.hostname}

_No API calls observed yet._

The sniffer was installed at document-start but no \`fetch\`/\`XMLHttpRequest\` calls have been captured for this page. Try:
1. Interact with the site (log in, navigate, trigger actions).
2. Refresh the page while this userscript is active.
3. Run **Generate API.md** from the Violentmonkey menu again.
`;
    }

    const hosts = Array.from(new Set(obs.map(o => o.host).filter(Boolean)));
    const graphQLEndpoints = obs.filter(o => o.isGraphQL);
    const authSummary = summarizeAuth(obs);

    const lines = [];
    lines.push(`# API Contract — ${location.hostname}`);
    lines.push('');
    lines.push(`> Reverse-engineered from live traffic observed on \`${location.href}\`.`);
    lines.push(`> Captured on ${new Date().toISOString()} — ${state.totalRequests} total request(s), ${obs.length} distinct endpoint(s).`);
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Page origin**: \`${location.origin}\``);
    lines.push(`- **Distinct API hosts**: ${hosts.length ? hosts.map(h => '`' + h + '`').join(', ') : '—'}`);
    lines.push(`- **Total observed requests**: ${state.totalRequests}`);
    lines.push(`- **Distinct endpoints**: ${obs.length}`);
    lines.push(`- **GraphQL endpoints detected**: ${graphQLEndpoints.length}`);
    lines.push('');

    if (authSummary.length) {
      lines.push('## Authentication & Common Required Headers');
      lines.push('');
      lines.push('Headers that appear consistently across traffic (candidate required / auth headers):');
      lines.push('');
      for (const h of authSummary) {
        lines.push(`- \`${h.name}\` — present in ${h.count} endpoint(s)${h.isAuth ? ' **(auth)**' : ''}${h.sample ? ` — sample: \`${h.sample}\`` : ''}`);
      }
      lines.push('');
    }

    if (graphQLEndpoints.length) {
      lines.push('## GraphQL Endpoints');
      lines.push('');
      for (const g of graphQLEndpoints) {
        lines.push(`### \`${g.method} ${g.host || ''}${g.urlTemplate}\``);
        lines.push('');
        const ops = Array.from(g.graphQLOps);
        if (ops.length) {
          lines.push('Observed operations:');
          for (const op of ops) lines.push(`- \`${op}\``);
          lines.push('');
        }
        lines.push('> Tip: run **Probe API docs** to fire a GraphQL introspection query against this endpoint.');
        lines.push('');
      }
    }

    lines.push('## Endpoints');
    lines.push('');
    // Group by host
    const byHost = new Map();
    for (const o of obs) {
      const h = o.host || '(relative)';
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h).push(o);
    }
    for (const [host, endpoints] of byHost) {
      lines.push(`### Host: \`${host}\``);
      lines.push('');
      for (const e of endpoints) lines.push(...renderEndpoint(e));
    }

    lines.push('---');
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- Header and body samples have been **redacted** for obvious secrets (JWTs, long tokens, cookies, bearer tokens).');
    lines.push('- Path segments like numeric IDs, UUIDs, and long random-looking tokens were templated into `:id`, `:uuid`, `:token`.');
    lines.push('- Field types are inferred from live samples and may be incomplete or too narrow. Verify against real documentation.');
    lines.push('- "Required" is approximated as "header present in every observed call to this endpoint". Low-volume endpoints may have false positives.');
    lines.push('');
    return lines.join('\n');
  }

  function renderEndpoint(e) {
    const lines = [];
    const callCount = e.calls.length;
    const totalCalls = Array.from(e.statusCounts.values()).reduce((s, n) => s + n, 0) || callCount;
    lines.push(`#### \`${e.method} ${e.urlTemplate}\``);
    lines.push('');
    lines.push(`- **Calls observed**: ${totalCalls}`);
    if (e.contentTypes.size) lines.push(`- **Response content-types**: ${Array.from(e.contentTypes).map(c => '`' + c + '`').join(', ')}`);
    if (e.statusCounts.size) {
      const statusLine = Array.from(e.statusCounts.entries()).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} (${n})`).join(', ');
      lines.push(`- **Status codes**: ${statusLine}`);
    }
    if (e.isGraphQL) lines.push(`- **GraphQL**: yes — operations: ${Array.from(e.graphQLOps).map(o => '`' + o + '`').join(', ')}`);

    // Required headers (present in 100% of calls)
    const requiredHeaders = Array.from(e.requestHeaderFreq.entries())
      .filter(([, c]) => c === totalCalls)
      .map(([n]) => n)
      .filter(n => !isBuiltInHeader(n));
    if (requiredHeaders.length) {
      lines.push(`- **Likely required request headers**: ${requiredHeaders.map(h => '`' + h + '`' + (AUTH_HEADERS.has(h) ? ' (auth)' : '')).join(', ')}`);
    }

    // Observed query params
    if (e.queryParamFreq.size) {
      const qp = Array.from(e.queryParamFreq.entries()).sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `\`${k}\` (${c}/${totalCalls})`).join(', ');
      lines.push(`- **Query parameters observed**: ${qp}`);
    }

    // Request body schema (merge across samples)
    const reqSchemas = e.calls.map(c => c.requestBody && c.requestBody.schema).filter(Boolean);
    if (reqSchemas.length) {
      lines.push('');
      lines.push('**Request body shape** (merged from samples):');
      lines.push('');
      lines.push('```ts');
      lines.push(renderSchema(mergeTypes(reqSchemas)));
      lines.push('```');
    } else if (e.calls.some(c => c.requestBody && c.requestBody.kind === 'form')) {
      const formKeys = new Set();
      for (const c of e.calls) if (c.requestBody && c.requestBody.keys) for (const k of c.requestBody.keys) formKeys.add(k);
      lines.push('');
      lines.push(`**Request body (form-encoded) fields**: ${Array.from(formKeys).map(k => '`' + k + '`').join(', ')}`);
    }

    // Response body schema (merge across samples)
    const resSchemas = e.calls.map(c => c.responseSample && c.responseSample.schema).filter(Boolean);
    if (resSchemas.length) {
      lines.push('');
      lines.push('**Response body shape** (merged from samples):');
      lines.push('');
      lines.push('```ts');
      lines.push(renderSchema(mergeTypes(resSchemas)));
      lines.push('```');
    }

    // First sample call (redacted)
    const sample = e.calls[0];
    if (sample) {
      lines.push('');
      lines.push('<details><summary>Sample call (redacted)</summary>');
      lines.push('');
      lines.push('```http');
      lines.push(`${e.method} ${sample.url}`);
      for (const [n, v] of Object.entries(sample.requestHeaders || {})) lines.push(`${n}: ${v}`);
      lines.push('');
      if (sample.requestBody && sample.requestBody.value) {
        const body = typeof sample.requestBody.value === 'string' ? sample.requestBody.value : JSON.stringify(sample.requestBody.value, null, 2);
        lines.push(body.length > 1000 ? body.slice(0, 1000) + '\n…(truncated)' : body);
      } else if (sample.requestBody && sample.requestBody.preview) {
        lines.push(sample.requestBody.preview);
      }
      lines.push('```');
      lines.push('');
      if (sample.status) {
        lines.push('```http');
        lines.push(`HTTP/1.1 ${sample.status} ${sample.statusText || ''}`.trim());
        for (const [n, v] of Object.entries(sample.responseHeaders || {})) lines.push(`${n}: ${v}`);
        lines.push('');
        if (sample.responseSample && sample.responseSample.preview) {
          const preview = String(sample.responseSample.preview);
          lines.push(preview.length > 1500 ? preview.slice(0, 1500) + '\n…(truncated)' : preview);
        }
        lines.push('```');
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    lines.push('');
    return lines;
  }

  function summarizeAuth(obs) {
    const headerStats = new Map();
    for (const o of obs) {
      for (const [name] of o.requestHeaderFreq) {
        if (isBuiltInHeader(name)) continue;
        const stat = headerStats.get(name) || { name, count: 0, isAuth: AUTH_HEADERS.has(name), sample: '' };
        stat.count += 1;
        if (!stat.sample) {
          const sampleCall = o.calls.find(c => c.requestHeaders && c.requestHeaders[name]);
          if (sampleCall) stat.sample = sampleCall.requestHeaders[name].slice(0, 80);
        }
        headerStats.set(name, stat);
      }
    }
    return Array.from(headerStats.values())
      .filter(s => s.isAuth || s.count >= Math.max(3, obs.length * 0.5))
      .sort((a, b) => Number(b.isAuth) - Number(a.isAuth) || b.count - a.count);
  }

  function isBuiltInHeader(n) {
    return /^(accept|accept-encoding|accept-language|connection|content-length|content-type|host|origin|referer|user-agent|sec-fetch-|sec-ch-|dnt|pragma|cache-control|upgrade-insecure-requests)/i.test(n);
  }

  function looksLikeStaticAsset(o) {
    const path = o.urlTemplate.toLowerCase();
    return /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|map|mp4|webm|avif)(\?|$)/.test(path);
  }

  // ===========================================================================
  // 6. OPT-IN DOC DISCOVERY
  // ===========================================================================

  async function probeApiDocs() {
    const candidates = [
      '/openapi.json', '/openapi.yaml', '/swagger.json', '/swagger.yaml',
      '/api-docs', '/api-docs.json', '/api/openapi.json', '/api/v1/openapi.json',
      '/api/swagger.json', '/api/v1/swagger.json', '/docs/openapi.json',
      '/.well-known/openapi.json', '/spec', '/spec.json'
    ];
    const results = [];
    for (const path of candidates) {
      try {
        const url = new URL(path, location.origin).href;
        const res = await fetch(url, { credentials: 'omit' });
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          const text = await res.text();
          if (ct.includes('json') || /^[\[{]/.test(text.trim())) {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch {}
            results.push({ url, status: res.status, type: 'openapi', preview: text.slice(0, 600), hasSchema: !!(parsed && (parsed.openapi || parsed.swagger)) });
          } else if (ct.includes('yaml') || ct.includes('text')) {
            results.push({ url, status: res.status, type: 'yaml', preview: text.slice(0, 600) });
          }
        }
      } catch {}
    }

    // GraphQL introspection — try candidate endpoints
    const graphqlCandidates = new Set(['/graphql', '/api/graphql', '/v1/graphql']);
    for (const g of state.observations.values()) {
      if (g.isGraphQL) graphqlCandidates.add(g.urlTemplate);
    }
    const introspectionQuery = `query IntrospectionQuery {
      __schema { queryType { name } mutationType { name } subscriptionType { name }
        types { kind name description
          fields(includeDeprecated: true) { name description type { kind name ofType { kind name } } }
          inputFields { name type { kind name } }
        }
      }
    }`;
    for (const path of graphqlCandidates) {
      try {
        const url = new URL(path, location.origin).href;
        const res = await fetch(url, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: introspectionQuery })
        });
        if (res.ok) {
          const json = await res.json();
          if (json && json.data && json.data.__schema) {
            results.push({ url, status: res.status, type: 'graphql', schemaTypes: json.data.__schema.types.length, queryType: json.data.__schema.queryType && json.data.__schema.queryType.name, raw: json });
          }
        }
      } catch {}
    }

    return results;
  }

  function buildDiscoveryMarkdown(results) {
    if (!results.length) return '\n## Documentation Discovery\n\nNo OpenAPI/Swagger/GraphQL schema found at common paths.\n';
    const lines = ['', '## Documentation Discovery', ''];
    for (const r of results) {
      lines.push(`### \`${r.url}\` (${r.status}, ${r.type})`);
      lines.push('');
      if (r.type === 'graphql') {
        lines.push(`- Types: **${r.schemaTypes}**`);
        lines.push(`- Root query: \`${r.queryType || '?'}\``);
        lines.push('- Save the full introspection JSON to rebuild an SDL schema (available via the raw response).');
      } else {
        lines.push('```');
        lines.push(r.preview);
        lines.push('```');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // 6.5. DEEP PROBE — harvest source, extract endpoints, probe everything
  // ===========================================================================

  const probeState = {
    running: false,
    cancelled: false,
    panel: null
  };

  async function deepProbeApi(opts) {
    opts = opts || { allowedMethods: new Set(['GET']), tier: 'safe' };
    if (probeState.running) { notify('Deep probe', 'Already running.'); return; }
    probeState.running = true;
    probeState.cancelled = false;

    const panel = createProgressPanel(opts.tier);
    probeState.panel = panel;
    panel.setStatus('Harvesting HTML & scripts…');

    try {
      const sources = await harvestSources((msg) => panel.setStatus(msg));
      if (probeState.cancelled) return finishProbe();

      panel.setStatus(`Extracting endpoint candidates from ${sources.totalBytes.toLocaleString()} bytes of source…`);
      const { candidates, invocations } = extractCandidates(sources);

      const filtered = filterProbeCandidates(candidates, opts.allowedMethods);
      panel.setTotal(filtered.length);

      const methodBreakdown = countBy(filtered, x => x.method);
      const breakdownStr = Object.entries(methodBreakdown).map(([m, n]) => `${n} ${m}`).join(', ') || '—';
      panel.setStatus(`${candidates.length} candidates — ${filtered.length} will be probed (${breakdownStr}).`);

      if (filtered.length === 0) {
        await sleep(800);
        panel.setStatus('Nothing safe to probe. Rendering API.md from static analysis only.');
      } else {
        const hasMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].some(m => methodBreakdown[m]);
        const warning = hasMutating
          ? `\n\n⚠️  ⚠️  ⚠️  WARNING  ⚠️  ⚠️  ⚠️\n` +
            `This includes NON-IDEMPOTENT methods (${['POST', 'PUT', 'PATCH', 'DELETE'].filter(m => methodBreakdown[m]).map(m => `${methodBreakdown[m]} ${m}`).join(', ')}).\n` +
            `Probes MAY CREATE, MODIFY, OR DELETE DATA on the server.\n` +
            `POST/PUT/PATCH probes will be sent with an empty JSON body "{}".\n` +
            `Only run this on systems you OWN or have EXPLICIT PERMISSION to test.\n`
          : '';
        const ok = confirm(
          `Deep probe (${opts.tier}):\n` +
          `  • ${candidates.length} candidate URL(s) found in source\n` +
          `  • ${filtered.length} will be probed: ${breakdownStr}\n` +
          `  • ~${Math.ceil(filtered.length * CFG.probeIntervalMs / 1000)}s estimated\n` +
          `  • Probes include credentials (cookies).` +
          warning +
          `\nContinue?`
        );
        if (!ok) { probeState.cancelled = true; return finishProbe(); }

        for (let i = 0; i < filtered.length; i++) {
          if (probeState.cancelled) break;
          const { url, method } = filtered[i];
          panel.setProgress(i + 1, `${method} ${url.replace(location.origin, '')}`);
          await probeOne(url, method);
          await sleep(CFG.probeIntervalMs);
        }
      }

      // Fold static-only findings into the observations map
      mergeStaticAnalysisIntoObservations(candidates, invocations);

      panel.setStatus('Building API.md…');
      const md = buildApiMarkdown() +
                 '\n' + buildStaticAnalysisMarkdown(candidates, invocations);
      const slug = (location.hostname || 'site').replace(/[^A-Za-z0-9._-]/g, '_');
      const tierTag = opts.tier === 'all' ? '.all-methods' : opts.tier === 'read' ? '.read' : '';
      downloadMarkdown(`API.${slug}.deep${tierTag}.md`, md);
      panel.setStatus(`Done. ${state.observations.size} endpoint(s) in API.md.`);
      notify('Deep probe complete', `${state.observations.size} endpoints, ${state.totalRequests} total calls.`);
    } catch (err) {
      console.error('[design-extractor] deep probe failed:', err);
      notify('Deep probe failed', String(err && err.message || err));
    } finally {
      finishProbe();
    }
  }

  function countBy(arr, fn) {
    const out = {};
    for (const x of arr) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
    return out;
  }

  function finishProbe() {
    probeState.running = false;
    setTimeout(() => { if (probeState.panel) probeState.panel.destroy(); probeState.panel = null; }, 4000);
  }

  // ---------------------------------------------------------------------------
  // Source harvesting
  // ---------------------------------------------------------------------------

  async function harvestSources(onStatus) {
    const chunks = [];
    const meta = { htmlBytes: 0, scriptCount: 0, mapCount: 0, robotsFound: false, swFound: false };

    // 1. Inline HTML + inline scripts
    const html = document.documentElement.outerHTML;
    chunks.push({ kind: 'html', url: location.href, text: html });
    meta.htmlBytes = html.length;

    // Inline <script> contents
    for (const s of document.querySelectorAll('script:not([src])')) {
      if (s.textContent) chunks.push({ kind: 'inline-script', url: location.href, text: s.textContent });
    }

    // 2. Next.js / SvelteKit data blobs often embed route info
    const dataBlobs = document.querySelectorAll(
      'script#__NEXT_DATA__, script[type="application/json"], script[type="application/ld+json"]'
    );
    for (const s of dataBlobs) {
      if (s.textContent) chunks.push({ kind: 'data-blob', url: location.href + '#' + (s.id || 'blob'), text: s.textContent });
    }

    // 3. External scripts — same origin only, capped
    const externalScripts = Array.from(document.querySelectorAll('script[src]'))
      .map(s => s.src)
      .filter(u => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } })
      .slice(0, CFG.probeMaxScripts);

    for (let i = 0; i < externalScripts.length; i++) {
      if (probeState.cancelled) break;
      const url = externalScripts[i];
      onStatus && onStatus(`Fetching script ${i + 1}/${externalScripts.length}…`);
      try {
        const res = await fetchWithTimeout(url, { credentials: 'same-origin' }, CFG.probeTimeoutMs);
        if (!res || !res.ok) continue;
        const text = (await res.text()).slice(0, CFG.probeMaxScriptBytes);
        chunks.push({ kind: 'external-script', url, text });
        meta.scriptCount++;

        // 4. Source maps — unminified gold
        const mapMatch = text.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/);
        if (mapMatch) {
          try {
            const mapUrl = new URL(mapMatch[1], url).href;
            if (new URL(mapUrl).origin === location.origin) {
              const mapRes = await fetchWithTimeout(mapUrl, { credentials: 'same-origin' }, CFG.probeTimeoutMs);
              if (mapRes && mapRes.ok) {
                const map = await mapRes.json();
                if (map && Array.isArray(map.sourcesContent)) {
                  const combined = map.sourcesContent.filter(Boolean).join('\n\n/* --- */\n\n');
                  chunks.push({ kind: 'sourcemap', url: mapUrl, text: combined.slice(0, CFG.probeMaxScriptBytes * 2) });
                  meta.mapCount++;
                }
              }
            }
          } catch {}
        }
      } catch {}
    }

    // 5. robots.txt + sitemap.xml + service worker (best-effort)
    for (const p of ['/robots.txt', '/sitemap.xml', '/sw.js', '/service-worker.js', '/manifest.json']) {
      if (probeState.cancelled) break;
      try {
        const res = await fetchWithTimeout(new URL(p, location.origin).href, { credentials: 'omit' }, CFG.probeTimeoutMs);
        if (res && res.ok) {
          const text = (await res.text()).slice(0, CFG.probeMaxScriptBytes);
          chunks.push({ kind: p.slice(1), url: new URL(p, location.origin).href, text });
          if (p === '/robots.txt') meta.robotsFound = true;
          if (p.includes('sw') || p.includes('worker')) meta.swFound = true;
        }
      } catch {}
    }

    const totalBytes = chunks.reduce((s, c) => s + c.text.length, 0);
    return { chunks, meta, totalBytes };
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Endpoint extraction from source
  // ---------------------------------------------------------------------------

  function extractCandidates(sources) {
    const urlMap = new Map();  // url → { url, method, origins:Set<source-kind>, contextSamples:[] }
    const invocations = [];    // { method, url, context, sourceKind, sourceUrl }

    const recordUrl = (rawUrl, method, source, context) => {
      const cleaned = cleanExtractedUrl(rawUrl);
      if (!cleaned) return;
      const existing = urlMap.get(cleaned) || { url: cleaned, methods: new Set(), origins: new Set(), contextSamples: [] };
      existing.methods.add(String(method || 'GET').toUpperCase());
      existing.origins.add(source.kind);
      if (context && existing.contextSamples.length < 3) existing.contextSamples.push(context.slice(0, 180).replace(/\s+/g, ' '));
      urlMap.set(cleaned, existing);
    };

    for (const chunk of sources.chunks) {
      const text = chunk.text;

      // Pattern A — fetch("URL", { method: "METHOD" ... })
      for (const m of text.matchAll(/\bfetch\s*\(\s*(["'`])([^"'`]{2,500})\1\s*(?:,\s*\{([^}]{0,600})\})?/g)) {
        const url = m[2];
        const opts = m[3] || '';
        const methodMatch = opts.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
        invocations.push({ method, url, context: m[0], sourceKind: chunk.kind, sourceUrl: chunk.url });
        recordUrl(url, method, chunk, m[0]);
      }

      // Pattern B — axios.METHOD("URL"…) / this.http.METHOD("URL"…) / $http.METHOD("URL"…)
      for (const m of text.matchAll(/\b(?:axios|http|\$http|this\.http|api|client)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(["'`])([^"'`]{2,500})\2/gi)) {
        invocations.push({ method: m[1].toUpperCase(), url: m[3], context: m[0], sourceKind: chunk.kind, sourceUrl: chunk.url });
        recordUrl(m[3], m[1].toUpperCase(), chunk, m[0]);
      }

      // Pattern C — $.ajax({ url: "URL", method/type: "METHOD" })
      for (const m of text.matchAll(/\$\.ajax\s*\(\s*\{([^}]{0,800})\}/g)) {
        const body = m[1];
        const urlMatch = body.match(/url\s*:\s*(["'`])([^"'`]+)\1/);
        const methodMatch = body.match(/(?:method|type)\s*:\s*(["'`])(GET|POST|PUT|PATCH|DELETE)\1/i);
        if (urlMatch) {
          const method = methodMatch ? methodMatch[2].toUpperCase() : 'GET';
          invocations.push({ method, url: urlMatch[2], context: m[0], sourceKind: chunk.kind, sourceUrl: chunk.url });
          recordUrl(urlMatch[2], method, chunk, m[0]);
        }
      }

      // Pattern D — new Request("URL", { method: "..." })
      for (const m of text.matchAll(/new\s+Request\s*\(\s*(["'`])([^"'`]+)\1\s*(?:,\s*\{([^}]{0,600})\})?/g)) {
        const url = m[2];
        const methodMatch = (m[3] || '').match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
        invocations.push({ method, url, context: m[0], sourceKind: chunk.kind, sourceUrl: chunk.url });
        recordUrl(url, method, chunk, m[0]);
      }

      // Pattern E — XHR .open("METHOD", "URL")
      for (const m of text.matchAll(/\.open\s*\(\s*(["'`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(["'`])([^"'`]+)\3/gi)) {
        invocations.push({ method: m[2].toUpperCase(), url: m[4], context: m[0], sourceKind: chunk.kind, sourceUrl: chunk.url });
        recordUrl(m[4], m[2].toUpperCase(), chunk, m[0]);
      }

      // Pattern F — route config objects { path: "/api/...", method: "GET" }  (useful in Next/Remix data)
      for (const m of text.matchAll(/["']?(?:path|url|endpoint|route)["']?\s*:\s*(["'`])(\/[^"'`]{2,200})\1/g)) {
        recordUrl(m[2], 'GET', chunk, m[0]);
      }

      // Pattern G — string literals that look like API paths
      // /api/..., /v1/..., /v2/..., /_next/data/..., /rest/..., /graphql
      for (const m of text.matchAll(/(["'`])(\/(?:api|v\d+|_next\/data|rest|graphql|wp-json|hasura)(?:\/[^"'`\s\\<>]{0,240})?)\1/g)) {
        recordUrl(m[2], 'GET', chunk, '');
      }

      // Pattern H — full URLs pointing at the page's origin (catches CDN / subdomain APIs too)
      for (const m of text.matchAll(/(["'`])(https?:\/\/[^"'`\s\\<>]{5,300})\1/g)) {
        const url = m[2];
        try {
          const u = new URL(url);
          // Only keep same-origin OR api.* / admin.* subdomains of current host
          const sameOrigin = u.origin === location.origin;
          const apiSubdomain = u.hostname.endsWith('.' + location.hostname.split('.').slice(-2).join('.')) &&
                               /^(api|admin|backend|gql|graph|rest|app)\./.test(u.hostname);
          if (sameOrigin || apiSubdomain) recordUrl(url, 'GET', chunk, '');
        } catch {}
      }

      // Pattern I — sitemap.xml <loc>...</loc>
      if (chunk.kind === 'sitemap.xml') {
        for (const m of text.matchAll(/<loc>([^<]+)<\/loc>/g)) recordUrl(m[1], 'GET', chunk, '');
      }

      // Pattern J — robots.txt "Sitemap: ..." / "Allow: /..." / "Disallow: /..."
      if (chunk.kind === 'robots.txt') {
        for (const m of text.matchAll(/^(?:Sitemap|Allow|Disallow):\s*(\S+)/gm)) recordUrl(m[1], 'GET', chunk, '');
      }
    }

    return { candidates: Array.from(urlMap.values()), invocations };
  }

  function cleanExtractedUrl(raw) {
    if (!raw) return null;
    let url = String(raw).trim();
    if (!url) return null;
    // Strip template expressions — `${x}` / `%s` / `:param` become a placeholder
    url = url.replace(/\$\{[^}]+\}/g, ':param').replace(/%[sd]/g, ':param');
    // Reject obvious non-URLs
    if (url.length > 500) return null;
    if (url.startsWith('//')) url = location.protocol + url;
    if (url.startsWith('/')) url = location.origin + url;
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      const u = new URL(url);
      // Reject static assets
      if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|map|mp4|webm|avif|css|html|pdf)(\?|$)/i.test(u.pathname)) return null;
      // Reject bare-root and non-content paths
      if (u.pathname === '/' || u.pathname === '') return null;
      // Reject things that look like CSS selectors that slipped through
      if (/[{}()]/.test(u.pathname)) return null;
      return u.href;
    } catch { return null; }
  }

  function filterProbeCandidates(candidates, allowedMethods) {
    const out = [];
    const seen = new Set();
    const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    for (const c of candidates) {
      let u; try { u = new URL(c.url); } catch { continue; }
      // Same-origin only
      if (u.origin !== location.origin) continue;
      // Skip URL templates with placeholders — we don't want to probe `/users/:param`
      if (u.pathname.includes(':param') || /\/:/.test(u.pathname)) continue;
      // Dangerous path check — belt & suspenders, applies to every method
      const lowered = u.pathname.toLowerCase();
      if (DANGEROUS_PATH_WORDS.some(w => lowered.includes(w))) continue;

      // Explicit methods discovered in source
      const methods = c.methods.size ? Array.from(c.methods) : ['GET'];
      for (const method of methods) {
        if (!allowedMethods.has(method)) continue;
        // Extra rule: never probe a mutating method unless it was explicitly
        // observed in source with that method. Prevents us from e.g. POSTing to
        // a path that was only seen as a GET string-literal.
        if (mutating.has(method) && !c.methods.has(method)) continue;
        const key = method + ' ' + c.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: c.url, method });
        if (out.length >= CFG.probeMaxEndpoints) return out;
      }
    }
    return out;
  }

  async function probeOne(url, method) {
    const opts = {
      method,
      credentials: 'include',
      redirect: 'follow',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    };
    // POST/PUT/PATCH with empty JSON body — many servers will 400 with
    // "field X required", which is exactly the schema signal we want.
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = '{}';
    }
    // Fire through the already-patched fetch so the sniffer captures the response
    try { await fetchWithTimeout(url, opts, CFG.probeTimeoutMs); } catch {}
  }

  function mergeStaticAnalysisIntoObservations(candidates, invocations) {
    // For each invocation we saw in source that we didn't probe (non-GET, templates,
    // cross-origin, dangerous), add a synthetic entry so API.md includes it with a
    // "discovered-in-source" marker.
    for (const inv of invocations) {
      const cleaned = cleanExtractedUrl(inv.url);
      if (!cleaned) continue;
      let u; try { u = new URL(cleaned); } catch { continue; }
      const pathname = u.pathname;
      const template = templatizeUrl(pathname);
      const key = inv.method + ' ' + u.host + template;
      if (state.observations.has(key)) continue;
      state.observations.set(key, {
        key,
        method: inv.method,
        host: u.host,
        origin: u.origin,
        urlTemplate: template,
        calls: [],
        requestHeaderFreq: new Map(),
        responseHeaderFreq: new Map(),
        queryParamFreq: new Map(),
        statusCounts: new Map(),
        contentTypes: new Set(),
        sampleRequestBodies: [],
        sampleResponseBodies: [],
        isGraphQL: false,
        graphQLOps: new Set(),
        staticOnly: true,
        sourceContext: inv.context ? inv.context.slice(0, 180).replace(/\s+/g, ' ') : '',
        sourceKind: inv.sourceKind
      });
    }
  }

  function buildStaticAnalysisMarkdown(candidates, invocations) {
    const notProbed = candidates.filter(c => {
      try {
        const u = new URL(c.url);
        return u.origin !== location.origin || u.pathname.includes(':param');
      } catch { return true; }
    });
    if (!candidates.length && !invocations.length) return '';

    const lines = ['', '## Static Analysis (source harvesting)', ''];
    lines.push(`- **Total URL candidates extracted**: ${candidates.length}`);
    lines.push(`- **Call sites with method extracted**: ${invocations.length}`);
    lines.push(`- **Not probed** (cross-origin, templated, or dangerous paths): ${notProbed.length}`);
    lines.push('');

    // Group invocations by method
    const byMethod = new Map();
    for (const inv of invocations) {
      const cleaned = cleanExtractedUrl(inv.url);
      if (!cleaned) continue;
      if (!byMethod.has(inv.method)) byMethod.set(inv.method, []);
      byMethod.get(inv.method).push({ url: cleaned, context: inv.context });
    }

    if (byMethod.size) {
      lines.push('### Call sites found in source');
      lines.push('');
      for (const [method, calls] of Array.from(byMethod.entries()).sort()) {
        lines.push(`**${method}** (${calls.length})`);
        lines.push('');
        const seen = new Set();
        for (const c of calls) {
          if (seen.has(c.url)) continue;
          seen.add(c.url);
          let displayUrl = c.url;
          try { const u = new URL(c.url); if (u.origin === location.origin) displayUrl = u.pathname + u.search; } catch {}
          lines.push(`- \`${method} ${displayUrl}\``);
          if (seen.size >= 40) { lines.push(`- _… and ${calls.length - seen.size} more_`); break; }
        }
        lines.push('');
      }
    }

    // URL-only candidates (from string literals with no method context)
    const urlOnly = candidates.filter(c => !invocations.some(i => cleanExtractedUrl(i.url) === c.url));
    if (urlOnly.length) {
      lines.push('### URL literals found in source (method unknown)');
      lines.push('');
      const seen = new Set();
      for (const c of urlOnly) {
        let displayUrl = c.url;
        try { const u = new URL(c.url); if (u.origin === location.origin) displayUrl = u.pathname + u.search; } catch {}
        if (seen.has(displayUrl)) continue;
        seen.add(displayUrl);
        lines.push(`- \`${displayUrl}\``);
        if (seen.size >= 60) { lines.push(`- _… and ${urlOnly.length - seen.size} more (see clipboard copy for full list)_`); break; }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------------------------------------------------------------------------
  // Floating progress panel
  // ---------------------------------------------------------------------------

  function createProgressPanel(tier) {
    const existing = document.getElementById('__design_api_extractor_panel');
    if (existing) existing.remove();

    const tierColors = {
      safe: CFG.uiAccent,            // indigo
      read: '#10b981',               // emerald
      all:  '#ef4444'                // red — destructive
    };
    const tierLabel = { safe: 'safe · GET only', read: 'read methods', all: 'ALL METHODS ⚠' }[tier] || '';
    const accent = tierColors[tier] || CFG.uiAccent;

    const wrap = document.createElement('div');
    wrap.id = '__design_api_extractor_panel';
    Object.assign(wrap.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
      width: '320px', padding: '14px 16px', borderRadius: '10px',
      background: CFG.uiColor, color: '#f8fafc', fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px', lineHeight: '1.4', boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
      border: `1px solid ${accent}55`
    });

    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div>
          <strong style="color:${accent};">API Deep Probe</strong>
          <span style="font-size:11px;opacity:0.7;margin-left:6px;">${tierLabel}</span>
        </div>
        <span id="__daep_close" style="cursor:pointer;opacity:0.6;padding:2px 6px;border-radius:4px;">&times;</span>
      </div>
      <div id="__daep_status" style="margin-bottom:8px;opacity:0.9;word-break:break-word;">Initializing…</div>
      <div style="height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;margin-bottom:8px;">
        <div id="__daep_bar" style="height:100%;width:0%;background:${accent};transition:width 0.2s;"></div>
      </div>
      <div id="__daep_count" style="font-size:11px;opacity:0.6;margin-bottom:10px;">—</div>
      <button id="__daep_cancel" style="
        width:100%;padding:6px 10px;background:rgba(255,255,255,0.08);color:#f8fafc;
        border:1px solid rgba(255,255,255,0.15);border-radius:5px;cursor:pointer;font-size:12px;
      ">Cancel</button>
    `;

    document.documentElement.appendChild(wrap);

    const $ = (id) => wrap.querySelector('#' + id);
    const api = {
      total: 0,
      setTotal(n) { this.total = n; $('__daep_count').textContent = `0 / ${n}`; },
      setProgress(done, label) {
        const pct = this.total > 0 ? Math.min(100, (done / this.total) * 100) : 0;
        $('__daep_bar').style.width = pct + '%';
        $('__daep_count').textContent = `${done} / ${this.total}`;
        if (label) $('__daep_status').textContent = label;
      },
      setStatus(s) { $('__daep_status').textContent = s; },
      destroy() { try { wrap.remove(); } catch {} }
    };

    $('__daep_cancel').addEventListener('click', () => {
      probeState.cancelled = true;
      api.setStatus('Cancelling…');
    });
    $('__daep_close').addEventListener('click', () => { probeState.cancelled = true; api.destroy(); });

    return api;
  }



  function generateDesignMd() {
    try {
      const payload = extractStylesFromPage();
      const normalized = normalizeExtraction(payload);
      const markdown = buildDesignMarkdown(normalized);
      const slug = (location.hostname || 'site').replace(/[^A-Za-z0-9._-]/g, '_');
      downloadMarkdown(`DESIGN.${slug}.md`, markdown);
      notify('DESIGN.md generated', `${normalized.sampledElements}/${normalized.totalElements} elements sampled.`);
    } catch (err) {
      console.error('[design-extractor] design failed:', err);
      notify('DESIGN.md failed', String(err && err.message || err));
    }
  }

  function generateApiMd(extraDiscoveryBlock) {
    try {
      let markdown = buildApiMarkdown();
      if (extraDiscoveryBlock) markdown += '\n' + extraDiscoveryBlock;
      const slug = (location.hostname || 'site').replace(/[^A-Za-z0-9._-]/g, '_');
      downloadMarkdown(`API.${slug}.md`, markdown);
      notify('API.md generated', `${state.observations.size} endpoint(s), ${state.totalRequests} call(s) observed.`);
    } catch (err) {
      console.error('[design-extractor] api failed:', err);
      notify('API.md failed', String(err && err.message || err));
    }
  }

  async function generateApiMdWithDiscovery() {
    notify('Probing API docs', 'Checking /openapi.json, /swagger.json, /graphql …');
    const results = await probeApiDocs();
    generateApiMd(buildDiscoveryMarkdown(results));
  }

  function downloadMarkdown(filename, markdown) {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    if (typeof GM_download === 'function') {
      try { GM_download({ url, name: filename, saveAs: true }); setTimeout(() => URL.revokeObjectURL(url), 60000); return; } catch {}
    }
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.documentElement.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function notify(title, text) {
    if (typeof GM_notification === 'function') {
      try { GM_notification({ title, text, timeout: 4000 }); return; } catch {}
    }
    console.log(`[design-extractor] ${title}: ${text}`);
  }

  // Register Violentmonkey menu commands
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Generate DESIGN.md (Ctrl+Shift+D)', generateDesignMd);
    GM_registerMenuCommand('Generate API.md (Ctrl+Shift+A)', () => generateApiMd());
    GM_registerMenuCommand('Generate API.md + probe OpenAPI/GraphQL', generateApiMdWithDiscovery);
    GM_registerMenuCommand('🔎 Deep probe (safe — GET only)',
      () => deepProbeApi({ allowedMethods: new Set(['GET']), tier: 'safe' }));
    GM_registerMenuCommand('🔎 Deep probe (read methods — GET + HEAD + OPTIONS)',
      () => deepProbeApi({ allowedMethods: new Set(['GET', 'HEAD', 'OPTIONS']), tier: 'read' }));
    GM_registerMenuCommand('⚠️ Deep probe (ALL METHODS from source — may modify data!)',
      () => deepProbeApi({ allowedMethods: new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']), tier: 'all' }));
    GM_registerMenuCommand('Copy DESIGN.md to clipboard', () => {
      const md = buildDesignMarkdown(normalizeExtraction(extractStylesFromPage()));
      (typeof GM_setClipboard === 'function' ? GM_setClipboard : navigator.clipboard.writeText.bind(navigator.clipboard))(md);
      notify('Copied DESIGN.md', 'Clipboard updated.');
    });
    GM_registerMenuCommand('Copy API.md to clipboard', () => {
      const md = buildApiMarkdown();
      (typeof GM_setClipboard === 'function' ? GM_setClipboard : navigator.clipboard.writeText.bind(navigator.clipboard))(md);
      notify('Copied API.md', 'Clipboard updated.');
    });
    GM_registerMenuCommand('Show observation count', () => notify('Observations', `${state.observations.size} endpoints, ${state.totalRequests} calls.`));
    GM_registerMenuCommand('Clear API observations', () => {
      state.observations.clear();
      state.totalRequests = 0;
      notify('API observations cleared', 'Counters reset.');
    });
  }

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (e.code === 'KeyD') { e.preventDefault(); generateDesignMd(); }
    else if (e.code === 'KeyA') { e.preventDefault(); generateApiMd(); }
    else if (e.code === 'KeyP') { e.preventDefault(); deepProbeApi({ allowedMethods: new Set(['GET']), tier: 'safe' }); }
  }, true);
})();
