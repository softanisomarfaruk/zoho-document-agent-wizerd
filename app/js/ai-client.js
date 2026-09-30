/*
 * Living Docs AI layer. Runs inside the widget and reaches Claude (Anthropic Messages API) or
 * Cursor (Cloud Agents API v1) through ZOHO.CRM.HTTP, so the uploaded widget needs no server.
 */
(function () {
  'use strict';

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

  // ---------- Zoho HTTP transport ----------
  function messageOf(data, status) {
    const msg = data && ((data.error && (data.error.message || data.error)) || data.message);
    if (typeof msg === 'string' && msg) return msg;
    if (msg) return JSON.stringify(msg).slice(0, 300);
    return `The provider returned HTTP ${status}`;
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (_) { return { message: String(text).slice(0, 400) }; }
  }

  function parseResponse(raw) {
    if (raw == null || raw === '') return {};
    if (typeof raw === 'string') return parseJson(raw);
    const status = Number(raw.status_code || raw.statusCode || (typeof raw.status === 'number' ? raw.status : 0));
    const payload = raw.body != null ? raw.body : raw.response;
    const data = typeof payload === 'string' ? parseJson(payload) : (payload && typeof payload === 'object' ? payload : raw);
    if (status >= 400) {
      const err = new Error(messageOf(data, status));
      err.status = status;
      throw err;
    }
    if (data && data.type === 'error' && data.error) throw new Error(messageOf(data, status || 400));
    return data;
  }

  function errorText(err) {
    if (!err) return 'Zoho could not reach the AI provider.';
    if (typeof err === 'string') return err.slice(0, 400);
    if (typeof err.message === 'string' && err.message && err.message !== '[object Object]') return err.message;
    try { parseResponse(err.data || err); } catch (parsed) { return parsed.message; }
    return err.code ? String(err.code) : 'Zoho could not reach the AI provider.';
  }

  async function http(method, url, headers, body) {
    const api = typeof ZOHO !== 'undefined' && ZOHO.CRM && ZOHO.CRM.HTTP;
    const fn = api && api[method];
    if (!fn) throw new Error('Open the widget inside Zoho CRM. The AI provider is called through the Zoho HTTP API.');
    const req = { url, headers: headers || {} };
    if (body !== undefined) req.body = typeof body === 'string' ? body : JSON.stringify(body);
    let raw;
    try {
      raw = await fn(req);
    } catch (err) {
      throw new Error(errorText(err));
    }
    return parseResponse(raw);
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

  // ---------- Claude ----------
  async function callAnthropic(cfg, { system, user, maxTokens, temperature }) {
    const data = await http('post', cfg.apiUrl || PROVIDERS.anthropic.apiUrl, {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }, {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }]
    });
    return {
      text: (data.content || []).map(part => part.text || '').join('\n'),
      model: data.model || cfg.model,
      tokens_in: data.usage ? data.usage.input_tokens || 0 : 0,
      tokens_out: data.usage ? data.usage.output_tokens || 0 : 0
    };
  }

  // ---------- Cursor ----------
  const CURSOR_TIMEOUT_MS = 8 * 60 * 1000;
  const CURSOR_POLL_MS = 3000;
  const CURSOR_TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
  const CURSOR_TEXT_ONLY = `Reply with the complete answer in your final message. That message is the only output the caller can read, so it must contain the full answer and nothing else.
Do not create files, do not run commands, and do not open a pull request.`;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function cursorBase(cfg) {
    return String(cfg.apiUrl || PROVIDERS.cursor.apiUrl).replace(/\/+$/, '').replace(/\/v[01]$/, '');
  }

  function cursorHeaders(cfg, withBody) {
    const headers = { Authorization: `Basic ${btoa(`${cfg.apiKey}:`)}`, Accept: 'application/json' };
    if (withBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async function cursorRequest(cfg, method, pathname, body) {
    try {
      return await http(method, `${cursorBase(cfg)}${pathname}`, cursorHeaders(cfg, body !== undefined), body);
    } catch (err) {
      if (err.status === 401 || err.status === 403 || /unauthori[sz]ed|invalid api key/i.test(err.message)) {
        throw new Error('Cursor rejected the API key. Create a user API key at cursor.com/dashboard/api.');
      }
      throw err;
    }
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

  async function callCursor(cfg, { system, user }) {
    const created = await cursorRequest(cfg, 'post', '/v1/agents', {
      prompt: { text: [CURSOR_TEXT_ONLY, system, user].filter(Boolean).join('\n\n') },
      ...(cfg.model ? { model: { id: cfg.model } } : {}),
      name: 'Living Docs request',
      mode: 'agent'
    });
    const agentId = created && created.agent && created.agent.id;
    let run = created && created.run;
    if (!agentId || !run || !run.id) throw new Error('Cursor did not return an agent run.');
    const started = Date.now();
    try {
      while (!CURSOR_TERMINAL.has(String(run.status || '').toUpperCase())) {
        if (Date.now() - started > CURSOR_TIMEOUT_MS) {
          await cursorRequest(cfg, 'post', `/v1/agents/${agentId}/runs/${run.id}/cancel`, {}).catch(() => null);
          throw new Error('Cursor did not finish within 8 minutes.');
        }
        await sleep(CURSOR_POLL_MS);
        run = await cursorRequest(cfg, 'get', `/v1/agents/${agentId}/runs/${run.id}`);
      }
      const status = String(run.status).toUpperCase();
      if (status !== 'FINISHED') throw new Error(`Cursor run ended with status ${status}.`);
      let text = textOf(run.result);
      for (let i = 0; i < 4 && text.trim().length < 200; i += 1) {
        await sleep(1500);
        const again = await cursorRequest(cfg, 'get', `/v1/agents/${agentId}/runs/${run.id}`);
        const latest = textOf(again.result);
        if (latest.trim().length > text.trim().length) text = latest;
      }
      if (!text.trim()) throw new Error('Cursor finished the run but the reply was empty.');
      return { text, model: cfg.model || 'default', tokens_in: 0, tokens_out: 0 };
    } finally {
      cursorRequest(cfg, 'delete', `/v1/agents/${agentId}`).catch(() => null);
    }
  }

  async function cursorModels(cfg) {
    const data = await cursorRequest(cfg, 'get', '/v1/models');
    return (data.items || []).map(m => ({ id: m.id, displayName: m.displayName || m.id, aliases: m.aliases || [] }));
  }

  // ---------- Public calls ----------
  function checkConfig(cfg) {
    if (!cfg || !PROVIDERS[cfg.provider]) throw new Error('Choose Claude or Cursor first.');
    if (!cfg.apiKey) throw new Error('Enter the API key.');
    if (!cfg.model) throw new Error('Enter the model.');
  }

  // restore: put redacted originals back into the answer (used for code, so the function still works).
  async function callAi(cfg, { system = '', user = '', maxTokens = 8000, temperature = 0.2, restore = false } = {}) {
    checkConfig(cfg);
    const map = new Map();
    const safeSystem = redactSecrets(system, map);
    const safeUser = redactSecrets(user, map);
    const args = { system: safeSystem.text, user: safeUser.text, maxTokens, temperature };
    const result = cfg.provider === 'cursor' ? await callCursor(cfg, args) : await callAnthropic(cfg, args);
    return {
      ...result,
      text: restore ? restoreRedacted(result.text, map) : result.text,
      provider: cfg.provider,
      label: cfg.label || PROVIDERS[cfg.provider].label,
      redacted: safeSystem.count + safeUser.count
    };
  }

  async function testConnection(cfg) {
    checkConfig(cfg);
    const started = Date.now();
    const label = cfg.label || PROVIDERS[cfg.provider].label;
    if (cfg.provider === 'cursor') {
      const me = await cursorRequest(cfg, 'get', '/v1/me');
      const models = await cursorModels(cfg).catch(() => null);
      if (models && models.length && !models.some(m => m.id === cfg.model || m.aliases.includes(cfg.model))) {
        throw new Error(`Model "${cfg.model}" is not available for this key. Available: ${models.map(m => m.id).slice(0, 12).join(', ')}`);
      }
      return { label, model: cfg.model, account: me.userEmail || me.apiKeyName || 'Cursor API key', models: models || [], ms: Date.now() - started };
    }
    const result = await callAnthropic(cfg, {
      system: 'You are a connection test. Reply with the single word OK.',
      user: 'Reply with OK.',
      maxTokens: 16,
      temperature: 0
    });
    return { label, model: result.model, account: '', models: [], ms: Date.now() - started };
  }

  // ---------- Documentation prompt ----------
  const DOC_INPUT_CHAR_BUDGET = 120000;
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
        if (fn.source) {
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

  function buildWorkflowPrompt(workflows, snapshot, audience) {
    const rules = workflows || [];
    const fieldsText = referencedFieldsText(rules, snapshot);
    const task = `Audience: ${audience}

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
    const room = Math.max(4000, DOC_INPUT_CHAR_BUDGET - overhead - 2000);
    const sourceLimit = Math.max(2000, Math.floor(room / Math.max(sourceCount, 1)));
    const rawUser = [
      task,
      '# Workflow rules',
      rules.map((wf, i) => workflowPromptSection(wf, i, sourceLimit)).join('\n\n'),
      fieldsText ? `# Fields on the related modules\n${fieldsText}` : ''
    ].filter(Boolean).join('\n\n');
    const scrubbed = redactSecrets(rawUser);
    return { system: WORKFLOW_SYSTEM_PROMPT, user: scrubbed.text, identifiersRemoved: scrubbed.count };
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

  async function improveFunction(cfg, { fn, source, issues, placeholders }) {
    const result = await callAi(cfg, {
      system: IMPROVE_SYSTEM_PROMPT,
      user: buildImprovePrompt(fn, source, issues, placeholders),
      maxTokens: 8000,
      temperature: 0.1,
      restore: true
    });
    const parsed = parseImproveResponse(result.text || '');
    if (!parsed.code.trim()) throw new Error(`${result.label} did not return a code block.`);
    return { ...parsed, model: result.model, label: result.label };
  }

  window.LivingDocsAI = {
    PROVIDERS,
    callAi,
    testConnection,
    cursorModels,
    buildWorkflowPrompt,
    cleanMarkdown,
    improveFunction
  };
})();
