/*
 * Living Docs AI layer. Prompts are masked here, then sent to the standalone Deluge function
 * livingdocs_llm_gateway, which decrypts the API key inside CRM and calls Claude (Anthropic Messages API)
 * or Cursor (Cloud Agents API v1). The browser never holds a provider key, except for the moment an
 * administrator types one into setup and it is handed to livingdocs_save_api_key.
 */
(function () {
  'use strict';

  // Provider hosts are fixed inside the gateway function, so the URL is shown but not editable.
  const PROVIDERS = {
    anthropic: {
      label: 'Claude',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-5',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      editableUrl: false
    },
    cursor: {
      label: 'Cursor',
      apiUrl: 'https://api.cursor.com',
      model: 'composer-2',
      keyUrl: 'https://cursor.com/dashboard/api',
      editableUrl: false
    }
  };

  const FN = window.LivingDocsFunctions || { SAVE_FN: 'livingdocs_save_api_key', GATEWAY_FN: 'livingdocs_llm_gateway' };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
      Promise.resolve(promise).then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  // ---------- CRM function transport ----------
  // Zoho may hand back the function output as an object, a JSON string or a double-encoded string.
  function decode(value) {
    let v = value;
    for (let i = 0; i < 3 && typeof v === 'string'; i += 1) {
      const s = v.trim();
      if (!s) return {};
      try { v = JSON.parse(s); continue; } catch (_) { /* not plain JSON */ }
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { v = JSON.parse(s.slice(start, end + 1)); continue; } catch (_) { /* not embedded JSON */ }
      }
      return { message: s.slice(0, 400), raw: s };
    }
    return v;
  }

  // FUNCTIONS.execute answers { code, details: { output } }; output is the JSON text the Deluge function returned.
  function functionOutput(raw) {
    let body = decode(raw);
    for (let i = 0; i < 3 && body && typeof body === 'object'; i += 1) {
      if (Object.prototype.hasOwnProperty.call(body, 'ok')) return body;
      const details = body.details;
      if (details && typeof details === 'object' && Object.prototype.hasOwnProperty.call(details, 'output')) {
        body = decode(details.output);
        continue;
      }
      break;
    }
    return body;
  }

  function errorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err.slice(0, 300);
    if (typeof err.message === 'string' && err.message && err.message !== '[object Object]') {
      return `${err.code ? `${err.code}: ` : ''}${err.message}`.slice(0, 300);
    }
    try { return JSON.stringify(err).slice(0, 300); } catch (_) { return String(err); }
  }

  function codedError(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    return Object.assign(err, extra || {});
  }

  function functionUnavailable(name, detail) {
    return codedError('FUNCTION_UNAVAILABLE',
      `The CRM function ${name} could not run${detail ? ` (${detail})` : ''}. An administrator can fix this with Install on the Living Docs setup page.`,
      { fn: name });
  }

  // Deluge stops a function whose invokeurl waits too long for the provider. Nothing is wrong with the setup,
  // so this is retried like a network error instead of sending the admin to Install.
  const CRM_TIMEOUT_RE = /taking too long to respond|execution time.*exceed|timed? ?out|did not answer within/i;

  function crmTimeout(name) {
    return codedError('CRM_TIMEOUT', `The AI provider took longer to answer than Zoho lets ${name} wait. Trying again usually works; a faster model also helps.`, { fn: name });
  }

  function crmFunctionsAvailable() {
    return typeof ZOHO !== 'undefined' && !!(ZOHO.CRM && ZOHO.CRM.FUNCTIONS && ZOHO.CRM.FUNCTIONS.execute);
  }

  // Runs as the signed-in user (not as the connection owner), so the save function can check the caller's profile.
  async function runFunction(name, payload, timeoutMs = 90000) {
    if (!crmFunctionsAvailable()) {
      throw codedError('NOT_IN_CRM', 'Open the widget inside Zoho CRM. AI requests run through a CRM function.');
    }
    let raw;
    try {
      raw = await withTimeout(ZOHO.CRM.FUNCTIONS.execute(name, { arguments: JSON.stringify({ payload: JSON.stringify(payload) }) }), timeoutMs, name);
    } catch (err) {
      const text = errorText(err);
      throw CRM_TIMEOUT_RE.test(text) ? crmTimeout(name) : functionUnavailable(name, text);
    }
    const body = functionOutput(raw);
    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'ok')) return body;
    const code = body && (body.code || body.status);
    const detail = body && body.message ? `${code ? `${code}: ` : ''}${body.message}` : JSON.stringify(body || {}).slice(0, 200);
    if (CRM_TIMEOUT_RE.test(detail)) throw crmTimeout(name);
    throw functionUnavailable(name, detail);
  }

  // Gateway error codes -> the error types the retry logic and the screens already understand.
  const GATEWAY_ERROR_TYPES = {
    KEY_REJECTED: 'authentication_error',
    PERMISSION: 'permission_error',
    BILLING: 'billing_error',
    NOT_FOUND: 'not_found_error',
    TOO_LARGE: 'request_too_large',
    INPUT_TOO_LARGE: 'request_too_large',
    WORKSPACE_REQUIRED: 'workspace_required',
    RATE_LIMITED: 'rate_limit_error',
    OVERLOADED: 'overloaded_error'
  };

  function gatewayMessage(code, error, provider) {
    const label = (PROVIDERS[provider] || {}).label || 'The AI provider';
    const said = error.message ? ` ${label} said: ${error.message}` : '';
    switch (code) {
      case 'KEY_REJECTED': return provider === 'cursor'
        ? 'Cursor rejected the API key. Create a user API key at cursor.com/dashboard/api and save it again on the setup page.'
        : 'Anthropic rejected the API key. Check the key in the Anthropic console, then save it again on the setup page.';
      case 'WORKSPACE_REQUIRED': return 'This Claude API key is not scoped to a workspace. Enter the Claude workspace ID (Anthropic console, Settings, Workspaces; it starts with wrkspc_), or create the key inside one workspace.';
      case 'BILLING': return 'Your Anthropic account has no credit left. Add credit under Billing in the Anthropic console.';
      case 'NOT_FOUND': return `${label} could not find that model. Check the model name.${said}`;
      case 'TOO_LARGE': return `The request is too large for ${label}. Select fewer workflows or shorter functions.`;
      case 'RATE_LIMITED': return `${label} rate limit reached. Wait a minute and try again.`;
      case 'OVERLOADED': return `${label} is busy right now. Try again in a few minutes.`;
      case 'PERMISSION': return `The ${label} API key is not allowed to do this.${said}`;
      case 'PROVIDER_ERROR': return error.message ? `${label}: ${error.message}` : `${label} returned an error (HTTP ${error.status || '?'}).`;
      default: return error.message || code;
    }
  }

  async function gateway(payload, timeoutMs) {
    const body = await runFunction(FN.GATEWAY_FN, payload, timeoutMs);
    if (body.ok) return body;
    const error = body.error || {};
    const code = error.code || 'GATEWAY_ERROR';
    throw codedError(code, gatewayMessage(code, error, payload.provider), {
      type: GATEWAY_ERROR_TYPES[code] || '',
      status: error.status || 0,
      keyStatus: body.keyStatus || ''
    });
  }

  // ---------- Secret redaction ----------
  // Last check before a prompt leaves the browser: anything that still looks like a credential or ID is replaced.
  const REDACT_PATTERNS = [
    /Zoho-oauthtoken\s+[A-Za-z0-9._-]{16,}/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g,
    /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/gi,
    /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /(["'](?:client_secret|refresh_token|access_token|api_key|apikey|authtoken|password|secret)["']\s*[:,]\s*["'])(?!\{\{)[^"'\n]{4,}(["'])/gi,
    /([?&](?:client_secret|refresh_token|access_token|api_key|apikey|authtoken|password)=)(?!\{\{)[^&"'\s]{4,}/gi,
    /(["']?(?:org_?id|orgid|zgid|zsoid|client_id|clientid|organization_id)["']?\s*[:=,]\s*["']?)(?!\{\{)(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9._-]{4,}/gi,
    /\b1000\.[A-Z0-9]{20,}\b/g,
    /\b[a-f0-9]{32,}\b/gi
  ];
  const ID_PATTERN = /(?<![\w{])\d{9,}(?![\w}])/g;

  function redactSecrets(text, map = new Map()) {
    let count = 0;
    let out = String(text == null ? '' : text);
    const reverse = new Map([...map].map(([k, v]) => [v, k]));
    const placeholder = (value, kind) => {
      if (reverse.has(value)) return reverse.get(value);
      const key = `{{SRV_${kind}_${map.size + 1}}}`;
      map.set(key, value);
      reverse.set(value, key);
      return key;
    };
    REDACT_PATTERNS.forEach((re) => {
      out = out.replace(re, (match, pre, post) => {
        count += 1;
        if (typeof pre === 'string' && pre && match.startsWith(pre)) {
          const tail = typeof post === 'string' ? post : '';
          return `${pre}${placeholder(match.slice(pre.length, match.length - tail.length), 'SECRET')}${tail}`;
        }
        return placeholder(match, 'SECRET');
      });
    });
    out = out.replace(ID_PATTERN, (match) => {
      count += 1;
      return placeholder(match, 'ID');
    });
    return { text: out, count, map };
  }

  function restoreRedacted(text, map) {
    if (!map || !map.size) return text;
    let out = String(text || '');
    map.forEach((value, key) => { out = out.split(key).join(value); });
    return out;
  }


  // ---------- Generation through the gateway ----------
  // Claude: direct Messages API calls, each one short enough to finish inside Zoho's invokeurl time limit.
  // When a call stops at max_tokens, the next call sends the text so far and Claude carries on from there.
  // Cursor runs as a cloud agent and is polled.
  const MAX_OUTPUT_TOKENS = 64000;
  const CHUNK_START = 2000;
  const CHUNK_MIN = 400;
  const CHUNK_MAX = 6000;
  // Aim each call at this many milliseconds, well below the Deluge limit, using the speed measured so far.
  const CHUNK_TARGET_MS = 22000;
  const POLL_MS = 3000;
  const POLL_TIMEOUT_MS = 8 * 60 * 1000;
  const POLL_ERRORS_ALLOWED = 3;
  const SHORT_ANSWER_RETRIES = 3;
  // A cloud agent explores its workspace unless told not to; everything it needs is in this prompt.
  const CURSOR_TEXT_ONLY = `Answer straight away from the text below. Everything you need is in this message.
Do not use any tools: do not read or search files, do not run commands, do not browse, do not create files, and do not open a pull request.
Reply with the complete answer in your final message. That message is the only output the caller can read, so it must contain the full answer and nothing else.`;

  function providerFields(cfg) {
    return { provider: cfg.provider, model: cfg.model || '', workspaceId: cfg.provider === 'anthropic' ? String(cfg.workspaceId || '').trim() : '' };
  }

  function answerOf(res, cfg) {
    const text = String(res.text || '');
    if (!text.trim()) {
      throw new Error(`${cfg.label || PROVIDERS[cfg.provider].label} finished but the reply was empty${res.stopReason ? ` (stop reason: ${res.stopReason})` : ''}.`);
    }
    return {
      text,
      model: res.model || cfg.model,
      stopReason: res.stopReason || '',
      tokens_in: Number(res.tokensIn || 0),
      tokens_out: Number(res.tokensOut || 0)
    };
  }

  function newRequestId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  // Zoho can stop the start call while Cursor is still creating the agent. The agent carries the request ID
  // in its name, so it is looked up for a while instead of starting (and paying for) a second run.
  const FIND_TRIES = 12;
  const FIND_MS = 5000;

  async function findStartedJob(fields, requestId) {
    for (let i = 0; i < FIND_TRIES; i += 1) {
      await sleep(FIND_MS);
      try {
        const res = await gateway({ action: 'find', ...fields, requestId });
        if (res.found && res.job) return res.job;
      } catch (err) {
        if (needsUserAction(err)) throw err;
      }
    }
    return null;
  }

  async function generateClaude(cfg, args, onProgress) {
    const fields = providerFields(cfg);
    let text = '';
    let chunk = CHUNK_START;
    let tokensIn = 0;
    let tokensOut = 0;
    let model = cfg.model;
    let stopReason = '';
    let pieceRetries = 0;
    // Lowered whenever Zoho cuts a call off, so the speed estimate never asks for that much again.
    let ceiling = CHUNK_MAX;
    while (tokensOut < MAX_OUTPUT_TOKENS) {
      let res;
      try {
        res = await gateway({ action: 'start', ...fields, system: args.system, user: args.user, partial: text, maxTokens: chunk });
      } catch (err) {
        // Zoho stopped the call before Claude finished: ask for a shorter piece and try again.
        if (err.code === 'CRM_TIMEOUT' && chunk > CHUNK_MIN) {
          ceiling = Math.max(CHUNK_MIN, Math.floor(chunk * 0.75));
          chunk = Math.max(CHUNK_MIN, Math.floor(chunk / 2));
          continue;
        }
        // Once some text exists, a passing error is retried here so the text written so far is kept.
        if (text && !needsUserAction(err) && pieceRetries < AI_RETRIES) {
          pieceRetries += 1;
          await sleep(1500 * pieceRetries);
          continue;
        }
        throw err;
      }
      pieceRetries = 0;
      const piece = String(res.text || '');
      const out = Number(res.tokensOut || 0);
      text += piece;
      tokensIn += Number(res.tokensIn || 0);
      tokensOut += out;
      model = res.model || model;
      stopReason = res.stopReason || '';
      if (onProgress && piece) onProgress({ text, tokensOut });
      if (stopReason !== 'max_tokens' || !piece) break;
      const ms = Number(res.latencyMs || 0);
      if (out > 0 && ms > 0) chunk = Math.round(Math.min(ceiling, Math.max(CHUNK_MIN, (out / ms) * CHUNK_TARGET_MS)));
    }
    return answerOf({ text, model, stopReason, tokensIn, tokensOut }, cfg);
  }

  async function generate(cfg, args, onProgress) {
    if (cfg.provider === 'anthropic') return generateClaude(cfg, args, onProgress);
    const fields = providerFields(cfg);
    const label = cfg.label || PROVIDERS[cfg.provider].label;
    const requestId = newRequestId();
    let first;
    try {
      first = await gateway({ action: 'start', ...fields, ...args, requestId });
    } catch (err) {
      if (err.code !== 'CRM_TIMEOUT' || cfg.provider !== 'cursor') throw err;
      const found = await findStartedJob(fields, requestId);
      if (!found) throw codedError('CRM_TIMEOUT', `${label} did not confirm the request before Zoho stopped the call. Try again.`);
      first = { done: false, job: found };
    }
    if (first.done) return answerOf(first, cfg);
    const job = first.job;
    if (!job) throw new Error(`${label} did not accept the request.`);
    const started = Date.now();
    let pollErrors = 0;
    let shortAnswers = 0;
    for (;;) {
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        gateway({ action: 'cancel', ...fields, job }).catch(() => null);
        throw new Error(`${label} did not finish within 8 minutes. Try again, or pick a faster model.`);
      }
      await sleep(POLL_MS);
      let poll;
      try {
        poll = await gateway({ action: 'poll', ...fields, job, acceptShort: shortAnswers >= SHORT_ANSWER_RETRIES });
      } catch (err) {
        pollErrors += 1;
        if (needsUserAction(err) || pollErrors > POLL_ERRORS_ALLOWED) throw err;
        continue;
      }
      if (poll.done) return answerOf(poll, cfg);
      if (poll.status === 'FINALIZING') shortAnswers += 1;
    }
  }

  // ---------- Public calls ----------
  function checkConfig(cfg) {
    if (!cfg || !PROVIDERS[cfg.provider]) throw new Error('Choose Claude or Cursor first.');
    if (!cfg.model) throw new Error('Enter the model.');
  }

  // A failed AI call is retried quietly 3 times. Nothing reaches the screen until all 3 have failed.
  // Errors only the user can fix (key, workspace, billing, model name, setup) are shown at once.
  const AI_RETRIES = 3;
  const USER_ACTION_CODES = new Set([
    'KEY_NOT_SET', 'KEY_UNREADABLE', 'KEY_REJECTED', 'NOT_DEPLOYED', 'FUNCTION_UNAVAILABLE', 'NOT_IN_CRM', 'DAILY_LIMIT',
    'USAGE_NOT_RECORDED', 'BAD_WORKSPACE', 'INVALID_MODEL', 'UNSUPPORTED_PROVIDER', 'NOT_ALLOWED', 'INPUT_TOO_LARGE', 'BAD_REQUEST'
  ]);

  function needsUserAction(err) {
    const type = (err && err.type) || '';
    if (['workspace_required', 'authentication_error', 'permission_error', 'billing_error', 'not_found_error', 'request_too_large'].includes(type)) return true;
    if (err && USER_ACTION_CODES.has(err.code)) return true;
    return /Choose Claude or Cursor|Enter the model|Open the widget inside Zoho/i.test((err && err.message) || '');
  }

  async function withAiRetries(call) {
    let lastErr;
    for (let attempt = 1; attempt <= AI_RETRIES; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        lastErr = err;
        if (needsUserAction(err) || attempt === AI_RETRIES) throw err;
        console.warn(`[Living Docs AI] attempt ${attempt} failed, retrying (${AI_RETRIES - attempt} left):`, err.message || err);
        await sleep(1500 * attempt);
      }
    }
    throw lastErr;
  }

  // restore: put redacted originals back into the answer (used for code, so the function still works).
  // No length cap: Claude writes until it is done (up to MAX_OUTPUT_TOKENS). onProgress gets the text so far.
  async function callAi(cfg, { system = '', user = '', restore = false, onProgress = null } = {}) {
    checkConfig(cfg);
    const map = new Map();
    const safeSystem = redactSecrets(system, map);
    const safeUser = redactSecrets(user, map);
    let systemText = safeSystem.text;
    if (cfg.provider === 'cursor') systemText = [CURSOR_TEXT_ONLY, systemText].filter(Boolean).join('\n\n');
    const args = { system: systemText, user: safeUser.text };
    const progress = onProgress ? ({ text, tokensOut }) => onProgress({ text: restore ? restoreRedacted(text, map) : text, tokensOut }) : null;
    const result = await withAiRetries(() => generate(cfg, args, progress));
    return {
      ...result,
      text: restore ? restoreRedacted(result.text, map) : result.text,
      provider: cfg.provider,
      label: cfg.label || PROVIDERS[cfg.provider].label,
      redacted: safeSystem.count + safeUser.count
    };
  }

  // Models the saved key can use, straight from the provider.
  async function listModels(cfg) {
    if (!cfg || !PROVIDERS[cfg.provider]) return [];
    const res = await gateway({ action: 'models', ...providerFields(cfg) });
    return (res.models || []).map(m => ({ id: m.id, displayName: m.displayName || m.id, aliases: m.aliases || [] }));
  }

  // Uses the key already saved in CRM. Setup saves a newly typed key before it calls this.
  async function testConnection(cfg) {
    checkConfig(cfg);
    const started = Date.now();
    const label = cfg.label || PROVIDERS[cfg.provider].label;
    const res = await gateway({ action: 'test', ...providerFields(cfg) });
    let models = [];
    if (cfg.provider === 'cursor') {
      models = await listModels(cfg).catch(() => []);
      if (models.length && !models.some(m => m.id === cfg.model || m.aliases.includes(cfg.model))) {
        throw codedError('INVALID_MODEL', `Model "${cfg.model}" is not available for this key. Available: ${models.map(m => m.id).slice(0, 12).join(', ')}`);
      }
    }
    return { label, model: res.model || cfg.model, account: res.account || '', models, ms: Date.now() - started };
  }

  // { keyStatus: 'set' | 'not_set' | 'unreadable', keys: { anthropic: { set, hint }, cursor: { set, hint } }, secretTag }
  async function keyStatus() {
    const res = await gateway({ action: 'status' }, 30000);
    return { keyStatus: res.keyStatus || 'not_set', keys: res.keys || {}, secretTag: res.secretTag || '', version: Number(res.version || 1) };
  }

  async function saveFunction(payload) {
    const body = await runFunction(FN.SAVE_FN, payload, 60000);
    if (body.ok) return { keys: body.keys || {}, secretTag: body.secretTag || '', readable: body.readable !== false };
    const error = body.error || {};
    throw codedError(error.code || 'SAVE_FAILED', error.message || 'The API key was not saved.');
  }

  // The key leaves the browser once, to the save function, and is not kept in widget state.
  function saveApiKey(provider, key, apiDomain) {
    return saveFunction({ action: 'save', provider, key, apiDomain });
  }

  function clearApiKey(provider, apiDomain) {
    return saveFunction({ action: 'clear', provider: provider || '', apiDomain });
  }

  function checkSaveFunction() {
    return saveFunction({ action: 'check' });
  }

  async function pingGateway() {
    const res = await runFunction(FN.GATEWAY_FN, { action: 'ping' }, 30000);
    return { ok: !!res.ok, secretTag: res.secretTag || '', version: Number(res.version || 1) };
  }

  // ---------- Documentation prompt ----------
  // No input limit for now; the model's context window is the only cap.
  const DOC_INPUT_CHAR_BUDGET = 5000000;
  const TRUNCATED = '[truncated to fit the model input limit]';

  const WORKFLOW_SYSTEM_PROMPT = `You are a senior Zoho CRM solution architect. You write operations documentation for workflow rules and the custom functions they call, for an administrator who has to maintain them.
RULES:
1. Output Markdown only. No HTML, no mermaid, and do not paste the function source back.
2. Use only facts in the user message. When something is not stated, write "Not determined".
3. The code block under each function is its real implementation. Trace it: the arguments and which record values the workflow passes in, records fetched (zoho.crm.getRecordById, searchRecords, getRelatedRecords), fields read, fields written (updateRecord, createRecord), external calls (invokeurl, sendmail, named connections), branches, loops, and the return value.
4. If a function has no source, or its source ends with "${TRUNCATED}", say so in that function's section and do not guess the missing part.
5. Write for the requested audience. Lead with the business outcome, then give exact CRM API names.
6. End with: "> Reviewed by: ____________"`;

  function clipForModel(text, maxChars) {
    const value = String(text || '');
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n${TRUNCATED}`;
  }

  function moduleNameOf(wf) {
    if (!wf) return '';
    if (typeof wf.module === 'string') return wf.module;
    return (wf.module && wf.module.api_name) || '';
  }

  function formatFunctionArgs(args) {
    return (args || [])
      .map(arg => (arg && typeof arg === 'object') ? `${arg.name || ''}${arg.type ? ` (${arg.type})` : ''}` : String(arg || ''))
      .filter(Boolean)
      .join(', ');
  }

  function codeFenceFor(fn, source) {
    const lang = String(fn.language || fn.runtime || 'deluge').toLowerCase();
    const tag = /deluge/.test(lang) ? 'deluge' : /node|javascript/.test(lang) ? 'javascript' : /python/.test(lang) ? 'python' : /java/.test(lang) ? 'java' : 'deluge';
    const fence = source.includes('```') ? '~~~~' : '```';
    return `${fence}${tag}\n${source}\n${fence}`;
  }

  const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Only fields the criteria, actions or function source mention are sent, so the budget goes to code.
  function referencedFieldsText(workflows, snapshot) {
    const names = new Set(workflows.map(moduleNameOf).filter(Boolean));
    const haystack = workflows.map(wf => [
      typeof wf.criteria === 'string' ? wf.criteria : JSON.stringify(wf.criteria || ''),
      (wf.actions || []).join('\n'),
      (wf.function_code || []).map(fn => fn.source || '').join('\n')
    ].join('\n')).join('\n');
    const lines = [];
    ((snapshot && snapshot.modules) || []).filter(mod => names.has(mod.module)).forEach((mod) => {
      const fields = mod.fields || [];
      let used = fields.filter(f => f.api_name && new RegExp(`\\b${escapeRegExp(f.api_name)}\\b`).test(haystack));
      const label = used.length ? 'referenced by this rule' : 'first fields of the module, none are referenced by name';
      if (!used.length) used = fields.slice(0, 20);
      used = used.slice(0, 60);
      if (!used.length) return;
      lines.push(`### ${mod.module} (${label})`);
      used.forEach(f => lines.push(`- ${f.api_name}: ${f.label || f.api_name}, ${f.data_type || 'type not returned'}`));
    });
    return lines.join('\n');
  }

  function workflowPromptSection(wf, index, sourceLimit) {
    const criteria = typeof wf.criteria === 'string' ? wf.criteria : JSON.stringify(wf.criteria || '');
    const lines = [
      `## Workflow rule ${index + 1}: ${wf.name}`,
      `- Module: ${moduleNameOf(wf) || 'Not determined'}`,
      `- Trigger: ${wf.trigger_type || (wf.execute_when && wf.execute_when.type) || 'Not determined'}`,
      `- Status: ${wf.status || 'Not determined'}`,
      `- Criteria: ${criteria || 'None (runs for every record matching the trigger)'}`,
      `- Description: ${wf.description || 'None'}`,
      '- Actions:'
    ];
    (wf.actions && wf.actions.length ? wf.actions : ['None returned']).forEach(act => lines.push(`  - ${act}`));
    const fns = wf.function_code || [];
    if (fns.length) {
      lines.push('', '### Custom functions called by this rule');
      fns.forEach((fn) => {
        lines.push('', `#### Function: ${fn.name || fn.api_name || 'Unnamed function'}`);
        lines.push(`- API name: ${fn.api_name || 'Not returned'} | Language: ${fn.language || fn.runtime || 'Not returned'} | Runs: ${fn.timing || 'instant'}`);
        const args = formatFunctionArgs(fn.arguments);
        if (args) lines.push(`- Arguments: ${args}`);
        if (fn.description) lines.push(`- Description: ${fn.description}`);
        if (fn.shared) {
          lines.push(`- Source: ${fn.note}`);
        } else if (fn.source) {
          const clipped = clipForModel(fn.source, sourceLimit);
          const cut = fn.source_truncated && !clipped.endsWith(TRUNCATED) ? `\n${TRUNCATED}` : '';
          lines.push('- Source:', codeFenceFor(fn, clipped + cut));
        } else {
          lines.push(`- Source: not retrieved. ${fn.error || fn.note || ''}`.trim());
        }
      });
    }
    return lines.join('\n');
  }

  // Output length sets the response time, so quick documents ask for less text and send less source.
  const DOC_MODES = {
    quick: { maxTokens: MAX_OUTPUT_TOKENS, inputChars: DOC_INPUT_CHAR_BUDGET },
    detailed: { maxTokens: MAX_OUTPUT_TOKENS, inputChars: DOC_INPUT_CHAR_BUDGET }
  };

  const QUICK_TASK = `# Task
Write one short document, about 500 words per workflow rule. Prefer bullets to paragraphs. Write "None" for a section that does not apply. For each workflow rule below, use these sections in this order:

# <workflow name>
## Purpose
Two sentences: the business outcome of this rule.
## When it runs
One line each for module, trigger and status, then the criteria in plain language.
## What it does
A numbered list, one short line per action, in the order Zoho runs them.
## Custom functions
For each function, at most five bullets: what it does, the fields it reads, the fields it writes, external calls or connections, and what it returns. Read this only from the code block.
## Risks
At most three bullets, only risks visible in the rule or the code.
## How to test
Three short checks an admin can run in Zoho CRM.`;

  function buildWorkflowPrompt(workflows, snapshot, audience, detail) {
    const mode = DOC_MODES[detail] ? detail : 'quick';
    const rules = workflows || [];
    const fieldsText = mode === 'quick' ? '' : referencedFieldsText(rules, snapshot);
    const task = mode === 'quick' ? `Audience: ${audience}\n\n${QUICK_TASK}` : `Audience: ${audience}

# Task
Write one document. For each workflow rule below, use these sections in this order:

# <workflow name>
## Purpose
One paragraph: the business outcome of this rule.
## When it runs
Module, trigger, and whether the rule is active. Explain the criteria in plain language, then quote the exact criteria.
## What it does
A numbered list, one step per action, in the order Zoho runs them.
## Custom function walkthrough
For each function: what it is for, its arguments and where their values come from, a numbered walk through the code, and what it returns. Read this only from the code block.
## Data touched
A markdown table with columns: Module | Field or API name | Read or write | Where this happens.
## Failure and re-entry
Only risks visible in the rule or the code, such as an update that can fire this rule again, a missing null check, a hardcoded id, or a named connection the code depends on.
## How to test
Three to five checks an admin can run in Zoho CRM.`;
    const sourceCount = rules.reduce((n, wf) => n + (wf.function_code || []).filter(fn => fn.source).length, 0);
    const overhead = task.length + fieldsText.length + rules.map((wf, i) => workflowPromptSection(wf, i, 0)).join('\n\n').length;
    const room = Math.max(4000, DOC_MODES[mode].inputChars - overhead - 2000);
    const sourceLimit = Math.max(2000, Math.floor(room / Math.max(sourceCount, 1)));
    const rawUser = [
      task,
      '# Workflow rules',
      rules.map((wf, i) => workflowPromptSection(wf, i, sourceLimit)).join('\n\n'),
      fieldsText ? `# Fields on the related modules\n${fieldsText}` : ''
    ].filter(Boolean).join('\n\n');
    const scrubbed = redactSecrets(rawUser);
    return { system: WORKFLOW_SYSTEM_PROMPT, user: scrubbed.text, identifiersRemoved: scrubbed.count, maxTokens: DOC_MODES[mode].maxTokens, detail: mode };
  }

  function cleanMarkdown(text) {
    const trimmed = String(text || '').trim();
    const wrapped = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
    return wrapped ? wrapped[1].trim() : trimmed;
  }

  // ---------- Function improvement ----------
  const IMPROVE_SYSTEM_PROMPT = `You are a senior Zoho CRM Deluge developer. You improve one Deluge function.

Rules:
1. Return the complete function. The first line must be the declaration exactly as given: same return type, category, name and arguments. Zoho rejects the update if the name or category changes. Put comments inside the body, never above the declaration.
2. Values like {{TOKEN_1}}, {{SECRET_2}}, {{ORG_ID}}, {{ID_3}}, {{CUSTOM_1}} and {{SRV_ID_4}} are masked secrets or IDs. Copy each one exactly, character for character, wherever the value is still needed. Never invent placeholders and never write real-looking keys. If you replace a credential with a Zoho Connection, drop its placeholder and say so in the summary.
3. Keep the behaviour the same. Only fix the listed issues and obvious bugs. Do not add integrations, modules, fields or features.
4. Typical fixes: wrap API calls in try/catch and log with info in the catch; check invokeurl responses (detailed:true and responseCode, or check the map); null checks with isNull(), isEmpty() or containKey() before .get(); move CRM calls out of for each loops; descriptive variable names; a short header comment; remove unused variables and debug info; return a value when the declaration has a return type.
5. Write valid Deluge only. Deluge has no let, const, var, function keyword, arrow functions, template strings, while loops or ?? operator.

Output format, exactly:
SUMMARY:
- one short line per change
CODE:
\`\`\`deluge
<the complete function>
\`\`\``;

  function buildImprovePrompt(fn, source, issues, placeholders) {
    const issueLines = (issues || []).slice(0, 80).map(i =>
      `- [${i.severity}] line ${i.line}, rule ${i.rule} (${i.title}): ${i.message} Fix: ${i.fix}`);
    return [
      `Function: ${fn.name || fn.api_name || 'unnamed'}${fn.api_name && fn.api_name !== fn.name ? ` (api name ${fn.api_name})` : ''}`,
      fn.signature ? `Declaration (keep exactly): ${fn.signature}` : '',
      placeholders && placeholders.length ? `Masked values to keep verbatim: ${placeholders.join(', ')}` : 'No masked values.',
      '',
      'Issues found by the local checker:',
      issueLines.length ? issueLines.join('\n') : '- none',
      '',
      'Function (secrets already masked):',
      '```deluge',
      source,
      '```'
    ].join('\n');
  }

  function parseImproveResponse(text) {
    const codeAt = text.search(/^\s*CODE:\s*$/m);
    const codePart = codeAt >= 0 ? text.slice(codeAt) : text;
    const fence = /(```|~~~)[\w-]*[ \t]*\n([\s\S]*?)\n?\1/.exec(codePart);
    const code = fence ? fence[2].replace(/\s+$/, '') : '';
    const summaryEnd = codeAt >= 0 ? codeAt : (fence ? text.indexOf(fence[0]) : text.length);
    const summary = text.slice(0, summaryEnd)
      .replace(/^\s*SUMMARY:\s*/m, '')
      .split('\n')
      .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
      .filter(Boolean);
    return { code, summary };
  }

  async function improveFunction(cfg, { fn, source, issues, placeholders }, onProgress) {
    const result = await callAi(cfg, {
      system: IMPROVE_SYSTEM_PROMPT,
      user: buildImprovePrompt(fn, source, issues, placeholders),
      restore: true,
      onProgress
    });
    const parsed = parseImproveResponse(result.text || '');
    if (!parsed.code.trim()) throw new Error(`${result.label} did not return a code block.`);
    return { ...parsed, model: result.model, label: result.label };
  }

  window.LivingDocsAI = {
    keyStatus,
    saveApiKey,
    clearApiKey,
    checkSaveFunction,
    pingGateway,
    needsUserAction,
    PROVIDERS,
    callAi,
    testConnection,
    listModels,
    buildWorkflowPrompt,
    cleanMarkdown,
    improveFunction
  };
})();
