/*
 * Deluge function review: secret masking, best-practice checks and a line diff.
 * No DOM access, so the same file runs in the widget (window.DelugeReview) and in Node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DelugeReview = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RULES = {
    1: { title: 'Hardcoded token, org ID or API key', severity: 'error', fix: 'Keep credentials in a Zoho Connection or an org variable, never in the script.' },
    2: { title: 'invokeurl response is not checked', severity: 'warning', fix: 'Add detailed:true and check responseCode (or check the response map) before using the result.' },
    3: { title: 'API call without try/catch', severity: 'warning', fix: 'Wrap the call in try { ... } catch (e) { info e; } so a failure is logged instead of stopping the workflow.' },
    4: { title: '.get() without a null check', severity: 'warning', fix: 'Check the value with isNull(), isEmpty() or containKey() before reading keys from it.' },
    5: { title: 'Debug info left in code', severity: 'info', fix: 'Remove debugging info statements. Keep info only for error logging inside catch.' },
    6: { title: 'Hardcoded record ID or URL', severity: 'warning', fix: 'Pass record IDs in as arguments and keep URLs in a variable or org variable.' },
    7: { title: 'Not using a Zoho Connection', severity: 'warning', fix: 'Add connection:"<connection name>" to invokeurl instead of sending tokens or Authorization headers.' },
    8: { title: 'CRM API call inside a loop', severity: 'warning', fix: 'Fetch the records once before the loop (searchRecords with criteria) or collect updates and send them together.' },
    9: { title: 'Unclear variable name', severity: 'info', fix: 'Use a descriptive name such as dealRecord or invoiceResponse.' },
    10: { title: 'No header comment', severity: 'info', fix: 'Add a comment at the top of the body that says what the function does, its arguments and what it returns.' },
    11: { title: 'Unused variable', severity: 'info', fix: 'Remove the variable or use it.' },
    12: { title: 'No error logging or return value', severity: 'warning', fix: 'Log failures with info inside catch and return a result the caller can check.' }
  };

  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

  // Kinds the user may un-mask. Empty: IDs, org IDs, tokens and keys are always masked before the AI sees them.
  const OPTIONAL_KINDS = new Set();

  const PREFIX = { token: 'TOKEN', secret: 'SECRET', random: 'SECRET', org: 'ORG_ID', id: 'ID', manual: 'CUSTOM' };

  const PLACEHOLDER_RE = /\{\{([A-Z]+(?:_[A-Z]+)*(?:_\d+)?)\}\}/g;

  // ---------------------------------------------------------------------------
  // Source scanning
  // ---------------------------------------------------------------------------

  // Returns the source with string contents and comments blanked out (same length, newlines kept),
  // so structural regexes never match inside literals or comments.
  function scan(src) {
    const out = src.split('');
    const strings = [];
    const comments = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === '/' && next === '/') {
        const start = i;
        while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
        comments.push({ start, end: i });
        continue;
      }
      if (c === '/' && next === '*') {
        const start = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        for (let k = start; k < i; k++) if (src[k] !== '\n') out[k] = ' ';
        comments.push({ start, end: i });
        continue;
      }
      if (c === '"' || c === "'") {
        const start = i;
        i++;
        while (i < n && src[i] !== c && src[i] !== '\n') {
          if (src[i] === '\\' && i + 1 < n && src[i + 1] !== '\n') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
          out[i] = ' ';
          i++;
        }
        strings.push({ start, end: Math.min(n, i + 1), value: src.slice(start + 1, i) });
        i++;
        continue;
      }
      i++;
    }
    return { code: out.join(''), strings, comments };
  }

  function lineIndex(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    return {
      starts,
      at(pos) {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return { line: lo + 1, col: pos - starts[lo] };
      }
    };
  }

  function matchBracket(code, openPos, open, close) {
    let depth = 0;
    for (let i = openPos; i < code.length; i++) {
      if (code[i] === open) depth++;
      else if (code[i] === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return code.length - 1;
  }

  function escapeRe(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function withIndices(re) {
    return new RegExp(re.source, re.flags.includes('d') ? re.flags : `${re.flags}d`);
  }

  function signatureOf(src) {
    const { code } = scan(src);
    const lines = code.split('\n');
    const original = src.split('\n');
    for (let k = 0; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      const m = /^\s*(?:([A-Za-z]\w*(?:\s*<[^>\n]*>)?)\s+)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(lines[k]);
      if (!m) return null;
      const args = original[k].slice(original[k].indexOf('(') + 1, original[k].lastIndexOf(')'));
      return {
        line: k + 1,
        returnType: (m[1] || '').replace(/\s+/g, '').toLowerCase(),
        category: m[2],
        name: m[3],
        args: args.trim(),
        text: original[k].trim()
      };
    }
    return null;
  }

  function sameSignature(a, b) {
    if (!a || !b) return false;
    return a.category.toLowerCase() === b.category.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Secret detection and masking
  // ---------------------------------------------------------------------------

  const KEY_NAMES = 'api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|authtoken|client[_-]?secret|client[_-]?id|secret[_-]?key|secret|password|passwd|pwd|private[_-]?key|x-api-key|signature|webhook[_-]?secret|token';

  const SECRET_PATTERNS = [
    { kind: 'token', label: 'Zoho OAuth token', priority: 90, re: /Zoho-oauthtoken\s+([A-Za-z0-9._-]{16,})/gi },
    { kind: 'token', label: 'Bearer token', priority: 90, re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g },
    { kind: 'token', label: 'Zoho OAuth token', priority: 90, re: /\b(1000\.[a-f0-9]{32}\.[a-f0-9]{32})\b/gi },
    { kind: 'secret', label: 'Basic auth credentials', priority: 88, re: /\bBasic\s+([A-Za-z0-9+/=]{12,})/g },
    { kind: 'secret', label: 'Key in URL', priority: 80, re: new RegExp(`[?&](?:${KEY_NAMES})=([^&"'\\s]{4,})`, 'gi') },
    { kind: 'secret', label: 'Key in map', priority: 80, re: new RegExp(`["'](?:${KEY_NAMES})["']\\s*[:,]\\s*["']([^"'\\n]{4,})["']`, 'gi') },
    { kind: 'secret', label: 'Key in variable', priority: 78, re: /\b\w*(?:key|secret|token|password|passwd|pwd)\w*\s*=\s*["']([^"'\n]{4,})["']/gi },
    { kind: 'secret', label: 'Authorization header', priority: 70, re: /["']Authorization["']\s*[:,]\s*["']([^"'\n]{6,})["']/gi }
  ];

  function isPlausibleSecretValue(value) {
    const v = value.trim();
    if (!v) return false;
    if (/^(Zoho-oauthtoken|Bearer|Basic)\s*$/i.test(v)) return false;
    if (/^(true|false|null|none|yes|no|string|map|list)$/i.test(v)) return false;
    if (/^https?:\/\//i.test(v)) return false;
    if (/\{\{[A-Z0-9_]+\}\}/.test(v)) return false;
    return true;
  }

  function entropy(text) {
    const freq = {};
    for (const ch of text) freq[ch] = (freq[ch] || 0) + 1;
    let h = 0;
    const len = text.length;
    Object.values(freq).forEach((count) => { const p = count / len; h -= p * Math.log2(p); });
    return h;
  }

  function looksRandom(token) {
    if (token.length < 24) return false;
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
    if (/^[A-Za-z]+(?:_[A-Za-z0-9]+)+$/.test(token)) return false;
    const digits = (token.match(/\d/g) || []).length / token.length;
    if (digits < 0.1 || digits > 0.9) return false;
    const mixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token);
    if (!mixedCase && token.length < 32) return false;
    return entropy(token) >= 3.5;
  }

  function detectSecrets(src, options = {}) {
    const manual = (options.manual || []).filter(v => v && v.length >= 3);
    const ignore = new Set(options.ignore || []);
    const { strings } = scan(src);
    const idx = lineIndex(src);
    const found = [];

    manual.forEach((value) => {
      let from = 0;
      let pos;
      while ((pos = src.indexOf(value, from)) !== -1) {
        found.push({ start: pos, end: pos + value.length, value, kind: 'manual', label: 'Marked by you', priority: 100 });
        from = pos + value.length;
      }
    });

    SECRET_PATTERNS.forEach((p) => {
      const re = withIndices(p.re);
      let m;
      while ((m = re.exec(src))) {
        const [start, end] = m.indices[1];
        const value = src.slice(start, end);
        if (!isPlausibleSecretValue(value)) continue;
        found.push({ start, end, value, kind: p.kind, label: p.label, priority: p.priority });
      }
    });

    const digitsRe = /(?<![\w.{])(\d{9,})(?![\w.}])/g;
    let dm;
    while ((dm = digitsRe.exec(src))) {
      const lineStart = src.lastIndexOf('\n', dm.index) + 1;
      const before = src.slice(lineStart, dm.index);
      const isOrg = /org|organi[sz]ation|zgid|zsoid|portal|tenant/i.test(before);
      found.push({
        start: dm.index,
        end: dm.index + dm[1].length,
        value: dm[1],
        kind: isOrg ? 'org' : 'id',
        label: isOrg ? 'Org ID' : 'Record ID',
        priority: isOrg ? 60 : 40
      });
    }

    strings.forEach((s) => {
      const re = /[A-Za-z0-9_+=-]{24,}/g;
      let m;
      while ((m = re.exec(s.value))) {
        if (!looksRandom(m[0])) continue;
        const start = s.start + 1 + m.index;
        found.push({ start, end: start + m[0].length, value: m[0], kind: 'random', label: 'Looks like a key', priority: 50 });
      }
    });

    const accepted = [];
    found
      .filter(d => !(OPTIONAL_KINDS.has(d.kind) && ignore.has(d.value)))
      .sort((a, b) => (b.priority - a.priority) || ((b.end - b.start) - (a.end - a.start)))
      .forEach((d) => {
        if (!accepted.some(o => d.start < o.end && o.start < d.end)) accepted.push(d);
      });

    // Any other copy of an accepted value is masked too, wherever it appears.
    accepted.slice().forEach((d) => {
      if (d.value.length < 6) return;
      let from = 0;
      let pos;
      while ((pos = src.indexOf(d.value, from)) !== -1) {
        const end = pos + d.value.length;
        if (!accepted.some(o => pos < o.end && o.start < end)) {
          accepted.push({ ...d, start: pos, end });
        }
        from = end;
      }
    });

    return accepted
      .sort((a, b) => a.start - b.start)
      .map(d => ({ ...d, line: idx.at(d.start).line, col: idx.at(d.start).col, optional: OPTIONAL_KINDS.has(d.kind) }));
  }

  function maskSource(src, detections) {
    const byValue = new Map();
    const counters = {};
    const entries = [];
    const spans = detections.slice().sort((a, b) => a.start - b.start);
    spans.forEach((d) => {
      let entry = byValue.get(d.value);
      if (!entry) {
        const prefix = PREFIX[d.kind] || 'SECRET';
        counters[prefix] = (counters[prefix] || 0) + 1;
        const n = counters[prefix];
        const name = prefix === 'ORG_ID' && n === 1 ? 'ORG_ID' : `${prefix}_${n}`;
        entry = { placeholder: `{{${name}}}`, value: d.value, kind: d.kind, label: d.label, optional: !!d.optional, lines: [], count: 0 };
        byValue.set(d.value, entry);
        entries.push(entry);
      }
      entry.count++;
      if (!entry.lines.includes(d.line)) entry.lines.push(d.line);
      d.placeholder = entry.placeholder;
    });
    let masked = '';
    let last = 0;
    spans.forEach((d) => {
      masked += src.slice(last, d.start) + d.placeholder;
      last = d.end;
    });
    masked += src.slice(last);
    return { masked, entries, spans };
  }

  // Replaces placeholders with the real values. Reports placeholders the model dropped or invented.
  function unmask(text, entries) {
    const map = new Map(entries.map(e => [e.placeholder, e.value]));
    const used = new Set();
    const unknown = new Set();
    const out = String(text).replace(PLACEHOLDER_RE, (whole) => {
      if (map.has(whole)) { used.add(whole); return map.get(whole); }
      unknown.add(whole);
      return whole;
    });
    return {
      text: out,
      missing: entries.filter(e => !used.has(e.placeholder)).map(e => e.placeholder),
      unknown: [...unknown]
    };
  }

  // Last line of defence before any text leaves the browser: replaces every known secret value.
  function scrubText(text, entries) {
    let out = String(text);
    entries
      .slice()
      .sort((a, b) => b.value.length - a.value.length)
      .forEach((e) => { out = out.split(e.value).join(e.placeholder); });
    return out;
  }

  function maskPreview(value) {
    const v = String(value);
    if (v.length <= 6) return '•'.repeat(v.length);
    return `${v.slice(0, 3)}${'•'.repeat(Math.min(12, v.length - 5))}${v.slice(-2)}`;
  }

  // ---------------------------------------------------------------------------
  // Best-practice checks
  // ---------------------------------------------------------------------------

  const CRM_CALL_RE = /zoho\.crm\.(getRecordById|getRecords|searchRecords|searchRecordsByPhone|searchRecordsByEmail|getRelatedRecords|updateRecord|updateRelatedRecord|createRecord|bulkCreate|bulkUpdate|invokeConnector|attachFile)\b/;

  function lintDeluge(src, options = {}) {
    const issues = [];
    const { code, strings, comments } = scan(src);
    const idx = lineIndex(src);
    const lines = src.split('\n');
    const codeLines = code.split('\n');
    const detections = options.detections || detectSecrets(src, options);
    const sig = signatureOf(src);
    const argNames = new Set(((sig && sig.args) || '').split(',').map(a => a.trim().split(/\s+/).pop()).filter(Boolean));
    const seen = new Set();

    function add(rule, pos, len, message, extra = {}) {
      const at = typeof pos === 'number' ? idx.at(pos) : pos;
      const key = `${rule}:${at.line}:${extra.key || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      const text = lines[at.line - 1] || '';
      let start = at.col;
      let end = start + (len || 0);
      if (!len) {
        start = Math.max(0, text.search(/\S/));
        end = text.length;
      }
      end = Math.max(end, start + 1);
      issues.push({
        rule,
        severity: RULES[rule].severity,
        title: RULES[rule].title,
        line: at.line,
        start,
        end,
        message,
        fix: extra.fix || RULES[rule].fix
      });
    }

    function ranges(re) {
      const out = [];
      let m;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(code))) {
        const open = code.indexOf('{', m.index + m[0].length - 1);
        if (open < 0) continue;
        out.push({ pos: m.index, open, close: matchBracket(code, open, '{', '}'), name: m[1] || '' });
      }
      return out;
    }
    const inside = (pos, list) => list.some(r => pos > r.open && pos < r.close);

    const tryRanges = ranges(/\btry\s*\{/g);
    const catchRanges = ranges(/\bcatch\s*\(\s*(\w+)\s*\)\s*\{/g);
    const loopRanges = ranges(/\bfor\s+each\s+(?:index\s+)?(\w+)\s+in\b[^{]*\{/g);

    // API calls
    const apiCalls = [];
    const invokes = [];
    const invRe = /(?:\b([A-Za-z_]\w*)\s*=\s*)?\binvokeurl\s*\[/g;
    let m;
    while ((m = invRe.exec(code))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(code, open, '[', ']');
      const pos = m.index + m[0].indexOf('invokeurl');
      const inv = { varName: m[1] || null, pos, open, close, blockCode: code.slice(open, close + 1), block: src.slice(open, close + 1) };
      invokes.push(inv);
      apiCalls.push({ pos, len: 9, name: 'invokeurl', varName: inv.varName, end: close, crm: false });
    }
    const zRe = /(?:\b([A-Za-z_]\w*)\s*=\s*)?\b(zoho\.(?!encryption\b|currenttime\b|currentdate\b|loginuser\b|loginuserid\b|adminuser\b|adminuserid\b)\w+\.\w+(?:\.\w+)?)\s*\(/g;
    while ((m = zRe.exec(code))) {
      const pos = m.index + m[0].indexOf('zoho.');
      const open = m.index + m[0].length - 1;
      apiCalls.push({ pos, len: m[2].length, name: m[2], varName: m[1] || null, end: matchBracket(code, open, '(', ')'), crm: CRM_CALL_RE.test(m[2]) });
    }
    const legacyRe = /(?:\b([A-Za-z_]\w*)\s*=\s*)?\b(getUrl|postUrl)\s*\(/g;
    while ((m = legacyRe.exec(code))) {
      const pos = m.index + m[0].indexOf(m[2]);
      const open = m.index + m[0].length - 1;
      apiCalls.push({ pos, len: m[2].length, name: m[2], varName: m[1] || null, end: matchBracket(code, open, '(', ')'), crm: false });
    }
    apiCalls.sort((a, b) => a.pos - b.pos);

    // Rule 1 and 6 (IDs): from the secret detector
    detections.forEach((d) => {
      const at = { line: d.line, col: d.col };
      const len = d.end - d.start;
      if (d.kind === 'id') add(6, at, len, `Record ID ${maskPreview(d.value)} is hardcoded.`, { key: d.value });
      else if (d.kind === 'manual') add(1, at, len, 'A value you marked as secret is written in the code.', { key: d.value });
      else add(1, at, len, `${d.label} is written in the code.`, { key: d.value });
    });

    // Rule 2
    invokes.forEach((inv) => {
      if (!inv.varName) {
        add(2, inv.pos, 9, 'The invokeurl response is not stored, so a failed call goes unnoticed.');
        return;
      }
      const v = escapeRe(inv.varName);
      const after = src.slice(inv.close);
      const checked = new RegExp(
        `\\b${v}\\s*\\.\\s*(?:get\\s*\\(\\s*["'](?:responseCode|code|status|status_code|statusCode|error|errors)["']|containKey|containsKey|isEmpty|isNull|size)` +
        `|\\b${v}\\s*[!=]=\\s*(?:null|"")` +
        `|\\b(?:isNull|isEmpty|ifnull|isnull)\\s*\\(\\s*${v}\\b` +
        `|\\bif\\s*\\(\\s*!?\\s*${v}\\s*\\)`, 'i');
      if (!checked.test(after)) add(2, inv.pos, 9, `"${inv.varName}" is used without checking whether the call succeeded.`);
    });

    // Rule 3
    apiCalls.forEach((call) => {
      if (!inside(call.pos, tryRanges)) add(3, call.pos, call.len, `${call.name} runs outside try/catch.`);
    });

    // Assignments, used by rules 4, 9 and 11
    const assignments = [];
    const asRe = /(^|[;{}\s(])([A-Za-z_]\w*)\s*=(?!=)/g;
    while ((m = asRe.exec(code))) {
      const namePos = m.index + m[1].length;
      if (code[namePos - 1] === '.') continue;
      const stmtEnd = (() => {
        let depth = 0;
        for (let i = namePos; i < code.length; i++) {
          const ch = code[i];
          if (ch === '[' || ch === '(' || ch === '{') depth++;
          else if (ch === ']' || ch === ')' || ch === '}') depth--;
          else if (ch === ';' && depth <= 0) return i;
        }
        return code.length;
      })();
      assignments.push({ name: m[2], pos: namePos, end: stmtEnd, rhs: code.slice(namePos + m[2].length, stmtEnd) });
    }

    // Rule 4
    const derivedSource = (rhs) => {
      if (/\binvokeurl\b/.test(rhs)) return 'an invokeurl call';
      const z = /zoho\.\w+\.\w+/.exec(rhs);
      if (z) return z[0];
      if (/\.get\s*\(/.test(rhs)) return 'a .get() lookup';
      if (/\.toMap\s*\(/.test(rhs)) return 'a text converted to a map';
      return null;
    };
    assignments.forEach((a) => {
      const source = derivedSource(a.rhs);
      if (!source) return;
      const v = escapeRe(a.name);
      const useRe = new RegExp(`\\b${v}\\s*\\.\\s*get\\s*\\(`, 'g');
      useRe.lastIndex = a.end;
      const use = useRe.exec(code);
      if (!use) return;
      const between = src.slice(a.end, use.index);
      const check = new RegExp(
        `\\b${v}\\s*[!=]=\\s*null|\\b(?:isNull|isEmpty|isnull|ifnull)\\s*\\(\\s*${v}\\b|\\b${v}\\s*\\.\\s*(?:isNull|isEmpty|containKey|containsKey|size)\\s*\\(|\\bif\\s*\\(\\s*!?\\s*${v}\\s*\\)`, 'i');
      if (!check.test(between)) {
        add(4, use.index, a.name.length + 4, `"${a.name}" comes from ${source} and is read with .get() without a null check.`, { key: a.name });
      }
    });
    const chainRe = /\.get\s*\([^()]*\)\s*\.get\s*\(/g;
    while ((m = chainRe.exec(code))) {
      add(4, m.index, 0, 'Chained .get() calls fail when the inner key is missing.', { key: 'chain' });
    }

    // Rule 5
    codeLines.forEach((text, k) => {
      const im = /^(\s*)info\b/.exec(text);
      if (!im) return;
      const pos = idx.starts[k] + im[1].length;
      if (inside(pos, catchRanges)) return;
      add(5, pos, 0, 'info statement used for debugging.');
    });

    // Rule 6 (URLs)
    strings.forEach((s) => {
      if (!/^https?:\/\//i.test(s.value)) return;
      const zohoDc = /zohoapis\.(com|eu|in|com\.au|jp|ca|com\.cn|sa)\b|\.zoho\.(com|eu|in|com\.au|jp|ca|com\.cn|sa)\b/i.test(s.value);
      add(6, s.start, s.end - s.start,
        zohoDc ? 'The Zoho data-center domain is hardcoded, so the function breaks in other data centers.' : 'This URL is hardcoded.',
        { key: `url${s.start}`, fix: zohoDc ? 'Keep the base URL in a variable or org variable so it can change per data center.' : RULES[6].fix });
    });

    // Rule 7
    invokes.forEach((inv) => {
      if (!/\bconnection\s*:/.test(inv.blockCode)) add(7, inv.pos, 9, 'invokeurl has no connection, so it depends on credentials in the code.');
    });
    strings.forEach((s) => {
      if (/^authorization$/i.test(s.value)) add(7, s.start, s.end - s.start, 'The Authorization header is built by hand.', { key: 'auth' });
    });

    // Rule 8
    apiCalls.forEach((call) => {
      if ((call.crm || call.name === 'invokeurl') && inside(call.pos, loopRanges)) {
        add(8, call.pos, call.len, `${call.name} runs once per loop item and can hit the API limit.`, { key: 'loop' });
      }
    });

    // Rule 9
    const unclear = name => /^[a-zA-Z]$/.test(name) || /^[a-zA-Z]{1,2}\d+$/.test(name) || /^(tmp|temp|foo|bar|baz|abc|xyz|test|dummy|var)$/i.test(name);
    const named = new Set();
    loopRanges.forEach((r) => {
      if (r.name && !named.has(r.name)) {
        named.add(r.name);
        if (unclear(r.name)) add(9, r.pos + code.slice(r.pos).indexOf(r.name), r.name.length, `"${r.name}" does not say what it holds.`, { key: r.name });
      }
    });
    assignments.forEach((a) => {
      if (named.has(a.name) || argNames.has(a.name)) return;
      named.add(a.name);
      if (unclear(a.name)) add(9, a.pos, a.name.length, `"${a.name}" does not say what it holds.`, { key: a.name });
    });

    // Rule 10
    const declLine = sig ? sig.line : 1;
    const hasHeader = comments.some(c => idx.at(c.start).line <= declLine + 2);
    if (!hasHeader) {
      add(10, { line: declLine, col: 0 }, 0, comments.length ? 'There is no header comment describing the function.' : 'The function has no comments.');
    }

    // Rule 11
    const firstAssign = new Map();
    assignments.forEach((a) => { if (!firstAssign.has(a.name)) firstAssign.set(a.name, a); });
    firstAssign.forEach((a, name) => {
      if (argNames.has(name)) return;
      const re = new RegExp(`(?<![.\\w])${escapeRe(name)}\\b(\\s*=(?!=))?`, 'g');
      let total = 0;
      let targets = 0;
      let x;
      while ((x = re.exec(code))) { total++; if (x[1]) targets++; }
      if (total - targets === 0) add(11, a.pos, name.length, `"${name}" is assigned but never used.`, { key: name });
    });

    // Rule 12
    const returnType = sig ? sig.returnType : '';
    if (returnType && returnType !== 'void' && !/\breturn\b\s*[^\s;]/.test(code)) {
      add(12, { line: declLine, col: 0 }, 0, `Declared to return ${returnType} but never returns a value.`, { key: 'return' });
    }
    catchRanges.forEach((r) => {
      const body = src.slice(r.open + 1, r.close);
      if (!/\b(info|return|sendmail|throw)\b|zoho\.crm\.createRecord|zoho\.cliq/.test(body)) {
        add(12, r.pos, 5, 'This catch block hides the error without logging it.', { key: `catch${r.pos}` });
      }
    });
    if (apiCalls.length && !catchRanges.length && !/\binfo\b|\bsendmail\b/.test(code) && (!returnType || returnType === 'void')) {
      add(12, { line: declLine, col: 0 }, 0, 'Failures are neither logged nor returned.', { key: 'log' });
    }

    return issues.sort((a, b) => (a.line - b.line) || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.rule - b.rule));
  }

  function summarize(issues) {
    return issues.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, { error: 0, warning: 0, info: 0 });
  }

  // Local fallback when no model is configured: adds a header and review notes, code is unchanged.
  function annotate(src, issues) {
    const sig = signatureOf(src);
    const lines = src.split('\n');
    const braceLine = (() => {
      const { code } = scan(src);
      const start = sig ? idx0(code, sig.line) : 0;
      const brace = code.indexOf('{', start);
      return brace < 0 ? (sig ? sig.line : 1) : code.slice(0, brace).split('\n').length;
    })();
    const headerNotes = [];
    const notes = new Map();
    issues.forEach((i) => {
      if (i.rule === 10) return;
      const note = `${i.title}. ${i.fix}`;
      if (i.line <= braceLine) {
        if (!headerNotes.includes(note)) headerNotes.push(note);
        return;
      }
      const list = notes.get(i.line) || [];
      if (!list.includes(note)) list.push(note);
      notes.set(i.line, list);
    });
    const needsHeader = issues.some(i => i.rule === 10) || headerNotes.length;
    const out = [];
    lines.forEach((text, k) => {
      const n = k + 1;
      const indent = (/^\s*/.exec(text) || [''])[0];
      (notes.get(n) || []).forEach(note => out.push(`${indent}// REVIEW: ${note}`));
      out.push(text);
      if (n === braceLine && needsHeader) {
        out.push('\t/*');
        if (sig) out.push(`\t * ${sig.name}`);
        out.push('\t * Purpose: describe what this function does.');
        if (sig && sig.args) out.push(`\t * Arguments: ${sig.args}`);
        if (sig) out.push(`\t * Returns: ${sig.returnType || 'void'}`);
        headerNotes.forEach(note => out.push(`\t * REVIEW: ${note}`));
        out.push('\t */');
      }
    });
    return out.join('\n');
  }

  function idx0(code, line) {
    let pos = 0;
    for (let k = 1; k < line; k++) {
      const nl = code.indexOf('\n', pos);
      if (nl < 0) break;
      pos = nl + 1;
    }
    return pos;
  }

  // ---------------------------------------------------------------------------
  // Line diff
  // ---------------------------------------------------------------------------

  function diffLines(aText, bText) {
    const a = String(aText).split('\n');
    const b = String(bText).split('\n');
    const A = a.map(s => s.replace(/\s+$/, ''));
    const B = b.map(s => s.replace(/\s+$/, ''));
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a2 = A.slice(pre, A.length - suf);
    const b2 = B.slice(pre, B.length - suf);
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ t: 'eq', a: i, b: i });
    const n = a2.length;
    const m = b2.length;
    if (n * m <= 4e6) {
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * w + j] = a2[i] === b2[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a2[i] === b2[j]) { ops.push({ t: 'eq', a: pre + i, b: pre + j }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: 'del', a: pre + i }); i++; }
        else { ops.push({ t: 'add', b: pre + j }); j++; }
      }
      while (i < n) ops.push({ t: 'del', a: pre + i++ });
      while (j < m) ops.push({ t: 'add', b: pre + j++ });
    } else {
      for (let i = 0; i < n; i++) ops.push({ t: 'del', a: pre + i });
      for (let j = 0; j < m; j++) ops.push({ t: 'add', b: pre + j });
    }
    for (let k = 0; k < suf; k++) ops.push({ t: 'eq', a: A.length - suf + k, b: B.length - suf + k });

    const rows = [];
    let added = 0;
    let removed = 0;
    let k = 0;
    while (k < ops.length) {
      if (ops[k].t === 'eq') {
        rows.push({ type: 'equal', left: { no: ops[k].a + 1, text: a[ops[k].a] }, right: { no: ops[k].b + 1, text: b[ops[k].b] } });
        k++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (k < ops.length && ops[k].t !== 'eq') {
        if (ops[k].t === 'del') dels.push(ops[k].a); else adds.push(ops[k].b);
        k++;
      }
      added += adds.length;
      removed += dels.length;
      const len = Math.max(dels.length, adds.length);
      for (let r = 0; r < len; r++) {
        const left = r < dels.length ? { no: dels[r] + 1, text: a[dels[r]] } : null;
        const right = r < adds.length ? { no: adds[r] + 1, text: b[adds[r]] } : null;
        rows.push({ type: left && right ? 'change' : left ? 'removed' : 'added', left, right });
      }
    }
    return { rows, added, removed, changed: added > 0 || removed > 0 };
  }

  // Common prefix and suffix of two lines, for highlighting the changed part of a changed line.
  function inlineDiff(left, right) {
    let p = 0;
    while (p < left.length && p < right.length && left[p] === right[p]) p++;
    let s = 0;
    while (s < left.length - p && s < right.length - p && left[left.length - 1 - s] === right[right.length - 1 - s]) s++;
    return {
      prefix: left.slice(0, p),
      left: left.slice(p, left.length - s),
      right: right.slice(p, right.length - s),
      suffix: left.slice(left.length - s)
    };
  }

  // Unified diff text ("-" old, "+" new) with a few context lines, for change logs.
  function unifiedDiff(aText, bText, context = 2) {
    const { rows } = diffLines(aText, bText);
    const keep = rows.map((row, i) => rows.slice(Math.max(0, i - context), i + context + 1).some(x => x.type !== 'equal'));
    const out = [];
    let skipped = 0;
    rows.forEach((row, i) => {
      if (!keep[i]) { skipped++; return; }
      if (skipped) { out.push(`@@ ${skipped} unchanged line${skipped === 1 ? '' : 's'} @@`); skipped = 0; }
      if (row.type === 'equal') out.push(`  ${row.left.text}`);
      if (row.left && row.type !== 'equal') out.push(`- ${row.left.text}`);
      if (row.right && row.type !== 'equal') out.push(`+ ${row.right.text}`);
    });
    if (skipped) out.push(`@@ ${skipped} unchanged line${skipped === 1 ? '' : 's'} @@`);
    return out.join('\n');
  }

  function review(src, options = {}) {
    const detections = detectSecrets(src, options);
    const mask = maskSource(src, detections);
    const issues = options.lint === false ? [] : lintDeluge(src, { ...options, detections });
    return { detections, mask, issues, counts: summarize(issues), signature: signatureOf(src) };
  }

  return {
    RULES,
    SEVERITY_ORDER,
    PLACEHOLDER_RE,
    scan,
    signatureOf,
    sameSignature,
    detectSecrets,
    maskSource,
    unmask,
    scrubText,
    maskPreview,
    lintDeluge,
    summarize,
    annotate,
    diffLines,
    inlineDiff,
    unifiedDiff,
    review
  };
});
