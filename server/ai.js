/*
 * AI provider layer. Supported providers: Claude (Anthropic Messages API) and Cursor (Cloud Agents API v1).
 * The API key is stored encrypted (AES-256-GCM) and is never returned to the widget.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    editableUrl: true
  },
  cursor: {
    label: 'Cursor',
    apiUrl: 'https://api.cursor.com',
    model: 'composer-2',
    keyUrl: 'https://cursor.com/dashboard/api',
    editableUrl: true
  }
};

const secretKeyFile = path.join(__dirname, 'data', '.secret.key');
let cachedKey = null;

function encryptionKey() {
  if (cachedKey) return cachedKey;
  if (process.env.LIVINGDOCS_SECRET) {
    cachedKey = crypto.createHash('sha256').update(process.env.LIVINGDOCS_SECRET).digest();
    return cachedKey;
  }
  try {
    cachedKey = Buffer.from(fs.readFileSync(secretKeyFile, 'utf8').trim(), 'base64');
    if (cachedKey.length === 32) return cachedKey;
  } catch (_) { /* generated below */ }
  cachedKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(secretKeyFile), { recursive: true });
  fs.writeFileSync(secretKeyFile, cachedKey.toString('base64'), { mode: 0o600 });
  return cachedKey;
}

function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

function decryptSecret(value) {
  if (!value) return '';
  if (!String(value).startsWith('enc:v1:')) return String(value);
  try {
    const raw = Buffer.from(String(value).slice(7), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function validateApiUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    return { ok: false, error: 'API URL is not a valid URL.' };
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { ok: false, error: 'API URL must use https (http is only allowed for localhost).' };
  }
  return { ok: true, url: url.toString() };
}

function hostOf(value) {
  try { return new URL(value).host.toLowerCase(); } catch (_) { return ''; }
}

// Last line of defence: anything that still looks like a credential is replaced before a prompt leaves the server.
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

// Record, org, workflow and field IDs: long digit runs are never sent to the AI.
const ID_PATTERN = /(?<![\w{])\d{9,}(?![\w}])/g;

/*
 * Returns the redacted text plus a map of placeholder -> original so callers can restore the
 * values in the AI response on this server. The originals themselves never leave the backend.
 */
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
  REDACT_PATTERNS.forEach(re => {
    out = out.replace(re, (match, pre, post) => {
      count += 1;
      if (typeof pre === 'string' && pre && match.startsWith(pre)) {
        const tail = typeof post === 'string' ? post : '';
        const value = match.slice(pre.length, match.length - tail.length);
        return `${pre}${placeholder(value, 'SECRET')}${tail}`;
      }
      return placeholder(match, 'SECRET');
    });
  });
  out = out.replace(ID_PATTERN, match => {
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

function providerError(status, data, label) {
  const msg = data && ((data.error && (data.error.message || data.error)) || data.message);
  return new Error(typeof msg === 'string' && msg ? msg : `${label} returned HTTP ${status}`);
}

async function readJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch (_) { return { message: text.slice(0, 300) }; }
}

async function callAnthropic(cfg, { system, user, maxTokens, temperature }) {
  const resp = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await readJson(resp);
  if (!resp.ok || data.error) throw providerError(resp.status, data, cfg.label);
  return {
    text: (data.content || []).map(part => part.text || '').join('\n'),
    model: data.model || cfg.model,
    tokens_in: data.usage ? data.usage.input_tokens || 0 : 0,
    tokens_out: data.usage ? data.usage.output_tokens || 0 : 0
  };
}

/*
 * Cursor Cloud Agents API v1 (https://cursor.com/docs/cloud-agent/api/endpoints).
 * Each call starts a no-repo agent, polls its run until it ends, reads run.result,
 * then deletes the agent so the masked prompt does not stay in the Cursor account.
 */
const CURSOR_TIMEOUT_MS = 8 * 60 * 1000;
const CURSOR_POLL_MS = 3000;
const CURSOR_TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

const CURSOR_TEXT_ONLY = `Reply with the complete answer in your final message. That message is the only output the caller can read, so it must contain the full answer and nothing else.
Do not create files, do not run commands, and do not open a pull request.`;

function cursorBase(cfg) {
  return String(cfg.apiUrl || PROVIDERS.cursor.apiUrl).replace(/\/+$/, '').replace(/\/v[01]$/, '');
}

async function cursorRequest(cfg, method, pathname, body) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const resp = await fetch(`${cursorBase(cfg)}${pathname}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.apiKey}:`).toString('base64')}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await readJson(resp);
    if (resp.status === 429 && attempt < 3) {
      const wait = Number(resp.headers.get('retry-after')) * 1000 || 2000 * (attempt + 1);
      await new Promise(r => setTimeout(r, Math.min(wait, 15000)));
      continue;
    }
    if (!resp.ok) {
      const msg = (data && (data.message || (data.error && (data.error.message || data.error)))) || `HTTP ${resp.status}`;
      const err = new Error(resp.status === 401 || resp.status === 403
        ? `Cursor rejected the API key (${resp.status}). Create a user API key at cursor.com/dashboard/api.`
        : `Cursor ${method} ${pathname} failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = resp.status;
      throw err;
    }
    return data;
  }
  throw new Error('Cursor rate limit: try again in a minute.');
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string' || Array.isArray(value.content)) return textOf(value.content);
    if (typeof value.message === 'string') return value.message;
  }
  return '';
}

// A finished run often leaves result empty and puts the reply on the SSE stream instead.
async function cursorStreamText(cfg, agentId, runId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let deltas = '';
  let finalText = '';
  let extra = '';
  try {
    const resp = await fetch(`${cursorBase(cfg)}/v1/agents/${agentId}/runs/${runId}/stream`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.apiKey}:`).toString('base64')}`,
        accept: 'text/event-stream'
      },
      signal: ctrl.signal
    });
    if (!resp.ok || !resp.body) return '';
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let event = '';
    let data = '';
    const flush = () => {
      if (data) {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch (_) { parsed = {}; }
        if (event === 'assistant') deltas += textOf(parsed.text != null ? parsed.text : parsed);
        else if (event === 'result') finalText = textOf(parsed.text != null ? parsed.text : parsed) || finalText;
        else if (event === 'interaction_update' && !deltas) extra += textOf(parsed.text || parsed.delta || parsed.textDelta);
        if (event === 'done' || event === 'result') ctrl.abort();
      }
      event = '';
      data = '';
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line) flush();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      }
    }
    flush();
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('[Cursor] stream read failed:', err.message);
  } finally {
    clearTimeout(timer);
  }
  const streamed = finalText.trim().length >= deltas.trim().length ? finalText : deltas;
  return streamed.trim() || extra.trim();
}

async function cursorAnswer(cfg, agentId, run) {
  let text = textOf(run.result);
  for (let i = 0; i < 4 && text.trim().length < 200; i += 1) {
    await new Promise(r => setTimeout(r, 1500));
    const again = await cursorRequest(cfg, 'GET', `/v1/agents/${agentId}/runs/${run.id}`);
    const latest = textOf(again.result);
    if (latest.trim().length > text.trim().length) text = latest;
  }
  if (text.trim().length >= 200) return text;
  const streamed = await cursorStreamText(cfg, agentId, run.id);
  return streamed.trim().length > text.trim().length ? streamed : text;
}

async function callCursor(cfg, { system, user }) {
  const text = [CURSOR_TEXT_ONLY, system, user].filter(Boolean).join('\n\n');
  const created = await cursorRequest(cfg, 'POST', '/v1/agents', {
    prompt: { text },
    ...(cfg.model ? { model: { id: cfg.model } } : {}),
    name: 'Living Docs request',
    mode: 'agent'
  });
  const agentId = created && created.agent && created.agent.id;
  let run = created && created.run;
  if (!agentId || !run || !run.id) throw new Error('Cursor did not return an agent run.');
  const started = Date.now();
  let removeAgent = true;
  try {
    while (!CURSOR_TERMINAL.has(String(run.status || '').toUpperCase())) {
      if (Date.now() - started > CURSOR_TIMEOUT_MS) {
        await cursorRequest(cfg, 'POST', `/v1/agents/${agentId}/runs/${run.id}/cancel`).catch(() => {});
        throw new Error('Cursor did not finish within 8 minutes.');
      }
      await new Promise(r => setTimeout(r, CURSOR_POLL_MS));
      run = await cursorRequest(cfg, 'GET', `/v1/agents/${agentId}/runs/${run.id}`);
    }
    const status = String(run.status).toUpperCase();
    if (status !== 'FINISHED') throw new Error(`Cursor run ended with status ${status}.`);
    const answer = await cursorAnswer(cfg, agentId, run);
    if (!answer.trim()) {
      removeAgent = false;
      const link = (created.agent && created.agent.url) || `https://cursor.com/agents/${agentId}`;
      console.warn(`[Cursor] finished with an empty reply. Run fields: ${Object.keys(run).join(', ') || 'none'}. Agent kept at ${link}`);
      throw new Error(`Cursor finished the run but the reply was empty. Open the agent to see what it did: ${link}`);
    }
    let usage = null;
    try {
      usage = (await cursorRequest(cfg, 'GET', `/v1/agents/${agentId}/usage?runId=${encodeURIComponent(run.id)}`)).totalUsage;
    } catch (_) { /* usage is optional */ }
    return {
      text: answer,
      model: cfg.model || 'default',
      tokens_in: usage ? usage.inputTokens || 0 : 0,
      tokens_out: usage ? usage.outputTokens || 0 : 0
    };
  } finally {
    if (removeAgent) {
      cursorRequest(cfg, 'DELETE', `/v1/agents/${agentId}`).catch(err => console.warn('[Cursor] agent cleanup failed:', err.message));
    }
  }
}

// Checks the key (GET /v1/me) and the model (GET /v1/models) without starting an agent.
async function testCursor(cfg) {
  const me = await cursorRequest(cfg, 'GET', '/v1/me');
  const models = await cursorModels(cfg).catch(() => null);
  if (cfg.model && models && models.length) {
    const known = models.some(m => m.id === cfg.model || (m.aliases || []).includes(cfg.model));
    if (!known) throw new Error(`Model "${cfg.model}" is not available for this key. Available: ${models.map(m => m.id).slice(0, 12).join(', ')}`);
  }
  return { account: me.userEmail || me.apiKeyName || 'Cursor API key', model: cfg.model || 'default' };
}

async function cursorModels(cfg) {
  const data = await cursorRequest(cfg, 'GET', '/v1/models');
  return (data.items || []).map(m => ({ id: m.id, displayName: m.displayName || m.id, aliases: m.aliases || [] }));
}

/*
 * restore: put redacted originals back into the answer (used for code, so the function still works).
 * The provider only ever sees the placeholders.
 */
async function callAi(cfg, { system = '', user = '', maxTokens = 4000, temperature = 0.2, restore = false } = {}) {
  if (!cfg || !PROVIDERS[cfg.provider] || !cfg.apiKey || !cfg.model) {
    throw new Error('No AI provider is configured.');
  }
  const map = new Map();
  const safeSystem = redactSecrets(system, map);
  const safeUser = redactSecrets(user, map);
  const args = { system: safeSystem.text, user: safeUser.text, maxTokens, temperature };
  const result = cfg.provider === 'cursor'
    ? await callCursor(cfg, args)
    : await callAnthropic(cfg, args);
  return {
    ...result,
    text: restore ? restoreRedacted(result.text, map) : result.text,
    provider: cfg.provider,
    label: cfg.label || PROVIDERS[cfg.provider].label,
    redacted: safeSystem.count + safeUser.count
  };
}

module.exports = {
  PROVIDERS,
  encryptSecret,
  decryptSecret,
  validateApiUrl,
  hostOf,
  redactSecrets,
  restoreRedacted,
  callAi,
  testCursor,
  cursorModels
};
