/*
 * Living Docs for Zoho CRM - widget controller
 * Flow: setup check -> overview -> select workflows -> review criteria and code -> document -> save record and PDF to CRM
 */

(function () {
  'use strict';

  const state = {
    isZohoEmbedded: false,
    settingsRecordId: null,
    settings: {
      workdriveFolder: '',
      docsAgentConnection: 'docsagent_connection',
      workdriveConnection: 'workdrive_connection'
    },
    audience: localStorage.getItem('livingdocs.audience') || 'admin',
    docDetail: localStorage.getItem('livingdocs.detail') === 'detailed' ? 'detailed' : 'quick',
    hasApiKey: false,
    ai: { provider: '', label: '', apiUrl: '', model: '', workspaceId: '', hasApiKey: false, keyHint: '', configured: false },
    // What the gateway reports about the encrypted key store. The keys themselves never reach the widget.
    aiKeyState: { anthropic: { set: false, hint: '' }, cursor: { set: false, hint: '' } },
    keyStoreStatus: 'unknown',
    // A key typed into setup waits here only until Install hands it to livingdocs_save_api_key.
    pendingKeys: { anthropic: '', cursor: '' },
    // Plain-text keys found on an older Living_Docs_Settings record; Install moves them and blanks the fields.
    legacyKeys: { anthropic: '', cursor: '' },
    clearLegacyKeys: false,
    aiProviders: {},
    docLog: null,
    currentUser: null,
    step: 1,
    maxStep: 1,
    scanning: false,
    crmModules: [],
    allWorkflowsList: [],
    functionCatalog: null,
    functionCatalogError: '',
    selectedWorkflowIds: new Set(),
    reviewWorkflows: [],
    activeReviewId: null,
    reviewDocMode: 'details',
    moduleFields: {},
    fnReviews: {},
    prompts: {},
    docs: [],
    // Set while a whole module is documented into one "<Module>_Master_Document" record.
    moduleRun: null,
    activeDocId: null
  };

  // Rules documented per run. Each gets its own prompt, AI call, PDF and CRM record, written in parallel.
  const MAX_BATCH = 3;

  // Names and script builders of the two Deluge functions that hold the AI keys (ai-functions.js).
  const LDF = window.LivingDocsFunctions;

  const dom = {};

  document.addEventListener('DOMContentLoaded', () => {
    initElements();
    bindEvents();
    initApp();
  });


  // Console helpers. Select the widget iframe as the DevTools console context, then e.g.:
  //   await DocsAgentDebug.env()
  //   await DocsAgentDebug.modules()
  //   await DocsAgentDebug.workflows()
  //   await DocsAgentDebug.workflow('4876876000011070001')
  //   await DocsAgentDebug.get('/crm/v8/settings/automation/workflow_rules?module=Leads')
  window.DocsAgentDebug = {
    env() {
      const info = {
        isZohoEmbedded: state.isZohoEmbedded,
        sdkLoaded: typeof ZOHO !== 'undefined',
        connectionInvokeAvailable: typeof ZOHO !== 'undefined' && !!ZOHO.CRM?.CONNECTION?.invoke,
        connectionName: state.settings.docsAgentConnection,
        apiDomain: getZohoApiDomain(),
        referrer: document.referrer,
        location: window.location.href
      };
      console.table(info);
      return info;
    },
    async get(endpoint, connName) {
      const conn = connName || state.settings.docsAgentConnection;
      const raw = await ZOHO.CRM.CONNECTION.invoke(conn, {
        url: endpoint.startsWith('http') ? endpoint : getZohoApiDomain() + endpoint,
        method: 'GET',
        param_type: 1,
        headers: {}
      });
      const body = unwrapConnectionResponse(raw);
      console.log('raw', raw);
      console.log('body', body);
      return body;
    },
    async modules() {
      const mods = await fetchCrmModules(state.settings.docsAgentConnection);
      console.table(mods.map(m => ({
        api_name: m.api_name,
        label: m.plural_label,
        generated_type: m.generated_type,
        api_supported: m.api_supported,
        visible: m.visible,
        scanned: isScannableModule(m)
      })));
      return mods;
    },
    async sdkModules() {
      const resp = await ZOHO.CRM.META.getModules();
      console.log(resp);
      return resp;
    },
    async workflows({ details = false } = {}) {
      const conn = state.settings.docsAgentConnection;
      let rules = await fetchAllWorkflowRulePages(conn);
      if (details) rules = await enrichWorkflowRules(conn, rules);
      console.table(rules.map(r => ({
        id: r.id,
        name: r.name,
        module: workflowModuleName(r),
        trigger: r.execute_when?.type,
        active: r.status?.active,
        conditions: Array.isArray(r.conditions) ? r.conditions.length : '-'
      })));
      return rules;
    },
    async workflow(id) {
      const body = await crmGet(`/crm/v8/settings/automation/workflow_rules/${encodeURIComponent(id)}`);
      console.log(body);
      return body.workflow_rules?.[0] || body;
    },
    rescan: () => scanCrm(true),
    get history() { return debugHistory; },
    get state() { return state; }
  };

  // ==========================================
  // ZOHO API & CONNECTION HELPER UTILITIES
  // ==========================================

  function withTimeout(promise, ms = 3000, fallback = null) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(fallback);
        }
      }, ms);

      Promise.resolve(promise)
        .then((val) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(val);
          }
        })
        .catch((err) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(fallback);
          }
        });
    });
  }

  function getZohoApiDomain() {
    try {
      const ref = (document.referrer || window.location.href || '').toLowerCase();
      if (ref.includes('.zoho.eu')) return 'https://www.zohoapis.eu';
      if (ref.includes('.zoho.in')) return 'https://www.zohoapis.in';
      if (ref.includes('.zoho.com.au')) return 'https://www.zohoapis.com.au';
      if (ref.includes('.zoho.jp')) return 'https://www.zohoapis.jp';
      if (ref.includes('.zoho.ca')) return 'https://www.zohoapis.ca';
      if (ref.includes('.zoho.com.cn')) return 'https://www.zohoapis.com.cn';
    } catch (_) {}
    return 'https://www.zohoapis.com';
  }

  async function invokeZohoConnectionAPI(connName, { endpoint, method = 'GET', payload = null, queryParams = null }) {
    if (typeof ZOHO === 'undefined' || !ZOHO.CRM?.CONNECTION?.invoke) {
      throw new Error('ZOHO.CRM.CONNECTION.invoke is not available in this environment.');
    }

    const baseDomain = getZohoApiDomain();
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const fullUrl = endpoint.startsWith('http') ? endpoint : `${baseDomain}${cleanEndpoint}`;

    const reqConfig = {
      url: fullUrl,
      method: method.toUpperCase(),
      param_type: method.toUpperCase() === 'GET' ? 1 : 2,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (method.toUpperCase() === 'GET' && queryParams) {
      reqConfig.parameters = queryParams;
    } else if (payload) {
      reqConfig.parameters = payload;
      reqConfig.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    }

    const startedAt = Date.now();
    let rawResp;
    try {
      rawResp = await ZOHO.CRM.CONNECTION.invoke(connName, reqConfig);
    } catch (sdkErr) {
      debugLog('error', connName, method, fullUrl, { request: reqConfig, error: sdkErr, ms: Date.now() - startedAt });
      throw new Error(`CONNECTION.invoke("${connName}") failed: ${describeSdkError(sdkErr)}`);
    }
    const parsed = unwrapConnectionResponse(rawResp);
    const apiErr = zohoApiError(parsed);
    debugLog(apiErr ? 'warn' : 'ok', connName, method, fullUrl, { request: reqConfig, raw: rawResp, body: parsed, ms: Date.now() - startedAt });
    return parsed;
  }

  // CONNECTION.invoke wraps the CRM REST body in details.statusMessage (object or JSON string).
  // FUNCTIONS.execute uses details.output, so both are accepted.
  function unwrapConnectionResponse(rawResp) {
    let body = rawResp;
    const details = rawResp && rawResp.details;
    if (details && typeof details === 'object') {
      if (Object.prototype.hasOwnProperty.call(details, 'statusMessage')) body = details.statusMessage;
      else if (Object.prototype.hasOwnProperty.call(details, 'output')) body = details.output;
      else if (Object.prototype.hasOwnProperty.call(details, 'response')) body = details.response;
    } else if (rawResp && rawResp.result !== undefined) {
      body = rawResp.result;
    }
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (!trimmed) return {};
      try { body = JSON.parse(trimmed); } catch (_) { body = { raw_text: body }; }
    }
    return body == null ? {} : body;
  }

  function zohoApiError(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const code = body.code || '';
    const failed = body.status === 'error' || /SCOPE|PERMISSION|AUTHORIZ|INVALID|NOT_SUPPORTED|MISSING|INTERNAL_ERROR|NO_CONNECTION/i.test(code);
    if (!code || !failed) return null;
    return { code, message: body.message || code, details: body.details || null };
  }

  function describeSdkError(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return err.code ? `${err.code}: ${err.message}` : err.message;
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }

  function withHardTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      Promise.resolve(promise).then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(describeSdkError(err))); }
      );
    });
  }

  // GET through the named connection; throws with the CRM error code instead of returning an error body.
  async function crmGet(endpoint, { connName, timeoutMs = 20000, allowCodes = [] } = {}) {
    const conn = connName || state.settings.docsAgentConnection || 'docsagent_connection';
    const body = await withHardTimeout(invokeZohoConnectionAPI(conn, { endpoint, method: 'GET' }), timeoutMs, `GET ${endpoint}`);
    const apiErr = zohoApiError(body);
    if (apiErr && !allowCodes.includes(apiErr.code)) {
      const err = new Error(`GET ${endpoint} → ${apiErr.code}: ${apiErr.message} (connection "${conn}")`);
      err.code = apiErr.code;
      err.body = body;
      throw err;
    }
    return body;
  }

  const debugHistory = [];
  function debugLog(level, connName, method, url, info) {
    debugHistory.push({ at: new Date().toISOString(), level, connName, method, url, ...info });
    if (debugHistory.length > 100) debugHistory.shift();
    const tag = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '❌';
    console.groupCollapsed(`[DocsAgent] ${tag} ${method} ${url} (${connName}, ${info.ms}ms)`);
    console.log('request', info.request);
    if (info.raw !== undefined) console.log('raw CONNECTION.invoke response', info.raw);
    if (info.body !== undefined) console.log('unwrapped CRM body', info.body);
    if (info.error !== undefined) console.error('error', info.error);
    console.groupEnd();
  }

  async function getActiveProfileIds(docsConn, log = console.log) {
    const profileMap = new Map();

    // Strategy 1 (Fastest in Widgets): ZOHO.CRM.CONFIG.getCurrentUser()
    if (typeof ZOHO !== 'undefined' && ZOHO.CRM?.CONFIG?.getCurrentUser) {
      try {
        const curUser = await withTimeout(ZOHO.CRM.CONFIG.getCurrentUser(), 2500, null);
        if (curUser?.profile?.id) {
          profileMap.set(String(curUser.profile.id), curUser.profile.name || 'User Profile');
          log(`Found active profile: "${curUser.profile.name || 'Current User'}" (${curUser.profile.id})`, 'ok');
        } else if (curUser?.users?.[0]?.profile?.id) {
          profileMap.set(String(curUser.users[0].profile.id), curUser.users[0].profile.name || 'Profile');
          log(`Found active profile: (${curUser.users[0].profile.id})`, 'ok');
        }
      } catch (e) {
        console.warn('[Profile Strategy 1]', e);
      }
    }

    // Strategy 2: Fetch via Named Connection GET /crm/v8/settings/profiles
    if (profileMap.size === 0) {
      try {
        log('Fetching CRM organization profiles via Named Connection...', 'info');
        const profResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
          endpoint: '/crm/v8/settings/profiles',
          method: 'GET'
        }), 3500, null);

        const profList = profResp?.profiles || profResp?.data || [];
        if (Array.isArray(profList) && profList.length > 0) {
          profList.forEach(p => {
            if (p.id) profileMap.set(String(p.id), p.name || 'Profile');
          });
          log(`Found ${profileMap.size} profile(s) via profiles API.`, 'ok');
        }
      } catch (e) {
        console.warn('[Profile Strategy 2]', e);
      }
    }

    // Strategy 3: ZOHO.CRM.API.getAllUsers({ Type: 'AllUsers' })
    if (profileMap.size === 0 && typeof ZOHO !== 'undefined' && ZOHO.CRM?.API?.getAllUsers) {
      try {
        const usersResp = await withTimeout(ZOHO.CRM.API.getAllUsers({ Type: 'AllUsers' }), 2500, null);
        const userList = usersResp?.users || [];
        userList.forEach(u => {
          if (u.profile && u.profile.id) {
            profileMap.set(String(u.profile.id), u.profile.name || 'User Profile');
          }
        });
        if (profileMap.size > 0) {
          log(`Found ${profileMap.size} profile(s) from users list.`, 'ok');
        }
      } catch (e) {
        console.warn('[Profile Strategy 3]', e);
      }
    }

    const result = Array.from(profileMap.keys()).map(id => ({ id }));
    return result;
  }

  function hostedOnZohoStatic() {
    return /(^|\.)zappsusercontent\.com$|(^|\.)zappscontents\.com$/i.test(location.hostname || '');
  }

  function keyInfo(provider) {
    return (state.aiKeyState && state.aiKeyState[provider]) || { set: false, hint: '' };
  }

  function applyKeyState(keys) {
    ['anthropic', 'cursor'].forEach((p) => {
      const k = (keys && keys[p]) || {};
      state.aiKeyState[p] = { set: k.set === true || k.set === 'true', hint: String(k.hint || '') };
    });
    refreshAiFromKeys();
  }

  function refreshAiFromKeys() {
    const provider = state.ai.provider;
    const info = keyInfo(provider);
    const preset = AI_PROVIDER_DEFAULTS[provider] || {};
    // The gateway only talks to the fixed provider hosts, so the URL always follows the preset.
    if (preset.apiUrl && (preset.editableUrl === false || !state.ai.apiUrl)) state.ai.apiUrl = preset.apiUrl;
    if (!state.ai.model && preset.model) state.ai.model = preset.model;
    if (!state.ai.label && preset.label) state.ai.label = preset.label;
    state.ai.hasApiKey = Boolean(provider && info.set);
    state.ai.keyHint = info.hint || '';
    state.ai.configured = Boolean(provider && info.set && state.ai.model);
    state.hasApiKey = state.ai.configured;
  }

  function applyRecordAi(record) {
    if (!record) return;
    state.legacyKeys.anthropic = String(record.Claude_API_Key || '').trim();
    state.legacyKeys.cursor = String(record.Cursor_API_Key || '').trim();
    state.ai.workspaceId = String(record.Claude_Workspace_Id || '').trim();
    const [provider, label] = String(record.AI_Provider || '').split('|');
    if (provider) {
      state.ai.provider = provider;
      state.ai.label = label || state.ai.label || '';
      if (record.AI_API_URL) state.ai.apiUrl = record.AI_API_URL;
      if (record.AI_Model) state.ai.model = record.AI_Model;
    }
    refreshAiFromKeys();
  }

  function aiName() {
    return state.ai.label || (state.aiProviders[state.ai.provider] || {}).label || 'the AI provider';
  }

  function zohoWriteResult(resp) {
    const row = resp?.data?.[0];
    if (!row) return { ok: false, message: 'Zoho CRM returned an empty response.' };
    if (row.code === 'SUCCESS' || row.status === 'success') {
      return { ok: true, id: row.details?.id || null, message: row.message || 'Saved' };
    }
    return { ok: false, code: row.code, message: row.message || row.code || 'CRM rejected the settings record.' };
  }

  function pickSettingsRecord(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const named = rows.filter(r => r.Name === 'agent_config_v1');
    // The gateway keeps its daily counter on the same module; it is never the settings row.
    const pool = named.length ? named : rows.filter(r => r.Name !== window.LivingDocsFunctions.USAGE_RECORD);
    if (!pool.length) return null;
    pool.sort((a, b) => new Date(b.Modified_Time || b.Created_Time || 0) - new Date(a.Modified_Time || a.Created_Time || 0));
    return pool[0];
  }

  async function findExistingSettingsRecord() {
    if (typeof ZOHO === 'undefined' || !ZOHO.CRM?.API) return null;
    if (ZOHO.CRM.API.searchRecord) {
      try {
        const search = await ZOHO.CRM.API.searchRecord({
          Entity: 'Living_Docs_Settings',
          Type: 'criteria',
          Query: '(Name:equals:agent_config_v1)'
        });
        const found = pickSettingsRecord(search?.data || []);
        if (found) return found;
      } catch (err) {
        console.warn('[Settings search]', err);
      }
    }
    if (ZOHO.CRM.API.getAllRecords) {
      try {
        const resp = await ZOHO.CRM.API.getAllRecords({
          Entity: 'Living_Docs_Settings',
          sort_order: 'desc',
          per_page: 200
        });
        return pickSettingsRecord(resp?.data || []);
      } catch (err) {
        console.warn('[Settings list]', err);
      }
    }
    return null;
  }

  function saveSettingsRecord(log) {
    return upsertSettingsRecord({
      docsAgentConnection: state.settings.docsAgentConnection,
      workdriveConnection: state.settings.workdriveConnection,
      workdriveFolder: state.settings.workdriveFolder,
      scheduleFrequency: state.settings.scheduleFrequency
    }, log);
  }

  async function upsertSettingsRecord(fields, log) {
    if (typeof ZOHO === 'undefined' || !ZOHO.CRM?.API) {
      return { ok: false, action: 'unavailable', message: 'Open the widget inside Zoho CRM to save settings.' };
    }

    let existingId = state.settingsRecordId;
    if (!existingId) {
      const existing = await findExistingSettingsRecord();
      existingId = existing?.id || null;
    }

    const APIData = {
      Name: 'agent_config_v1',
      Docs_Agent_Connection: fields.docsAgentConnection,
      Workdrive_Connection: fields.workdriveConnection,
      Workdrive_Folder_Id: fields.workdriveFolder,
      AI_Provider: state.ai.provider ? `${state.ai.provider}|${state.ai.label || ''}` : '',
      AI_Model: state.ai.model || '',
      AI_API_URL: state.ai.apiUrl || '',
      Claude_Workspace_Id: state.ai.workspaceId || ''
    };
    if (fields.scheduleFrequency) APIData.Schedule_Frequency = fields.scheduleFrequency;
    if (state.audience) APIData.Audience = state.audience;

    const write = async (data, isUpdate) => {
      if (isUpdate) {
        return ZOHO.CRM.API.updateRecord({
          Entity: 'Living_Docs_Settings',
          APIData: data
        });
      }
      return ZOHO.CRM.API.insertRecord({
        Entity: 'Living_Docs_Settings',
        APIData: data
      });
    };

    if (canUseZohoConnection()) await removeLegacyKeyFields(log);
    // Older installs kept the keys on this record. Blank a field only when it could not be deleted.
    if (state.clearLegacyKeys) {
      if (!state.removedSettingsKeyFields?.Claude_API_Key) APIData.Claude_API_Key = '';
      if (!state.removedSettingsKeyFields?.Cursor_API_Key) APIData.Cursor_API_Key = '';
    }

    // Zoho can drop values for fields the module does not have yet, so older installs get the new fields before the first write.
    if (!state.settingsFieldsEnsured && state.ai.workspaceId && canUseZohoConnection()) {
      state.settingsFieldsEnsured = true;
      const spec = LIVING_DOCS_MODULES.find(m => m.key === 'settings');
      await ensureModuleFields(state.settings.docsAgentConnection || 'docsagent_connection', spec, (msg, type) => console.log('[Settings fields]', type, msg)).catch(() => null);
    }

    // A failed write usually means the module is missing a field (older install), so add the fields and retry once.
    const attempt = async (data, isUpdate) => {
      try {
        let result = zohoWriteResult(await write(data, isUpdate));
        if (!result.ok && !state.settingsFieldsEnsured) {
          state.settingsFieldsEnsured = true;
          const spec = LIVING_DOCS_MODULES.find(m => m.key === 'settings');
          await ensureModuleFields(state.settings.docsAgentConnection || 'docsagent_connection', spec, (msg, type) => console.log('[Settings fields]', type, msg));
          result = zohoWriteResult(await write(data, isUpdate));
        }
        return result;
      } catch (err) {
        return { ok: false, message: describeSdkError(err) };
      }
    };

    if (existingId && ZOHO.CRM.API.updateRecord) {
      const updateData = { ...APIData, id: existingId };
      const updated = await attempt(updateData, true);
      if (updated.ok) {
        state.settingsRecordId = existingId;
        return { ok: true, action: 'updated', id: existingId };
      }
      // Only create a new row when the saved one was really deleted; any other failure must not add a second settings record.
      const stillThere = await findExistingSettingsRecord();
      if (stillThere && stillThere.id !== existingId) {
        const retried = await attempt({ ...APIData, id: stillThere.id }, true);
        state.settingsRecordId = stillThere.id;
        return retried.ok
          ? { ok: true, action: 'updated', id: stillThere.id }
          : { ok: false, action: 'update-failed', id: stillThere.id, message: retried.message };
      }
      if (stillThere) {
        state.settingsRecordId = stillThere.id;
        return { ok: false, action: 'update-failed', id: stillThere.id, message: updated.message };
      }
      state.settingsRecordId = null;
    }

    if (!ZOHO.CRM.API.insertRecord) {
      return { ok: false, action: 'unavailable', message: 'Zoho CRM record API is not available in this widget.' };
    }
    const created = await attempt(APIData, false);
    if (!created.ok) {
      return { ok: false, action: 'create-failed', message: created.message };
    }
    state.settingsRecordId = created.id || state.settingsRecordId;
    return { ok: true, action: 'created', id: state.settingsRecordId };
  }

  // ==========================================
  // AUTO-PROVISION CUSTOM MODULES & FIELDS (Zoho API v8)
  // Complete implementation of https://www.zoho.com/crm/developer/docs/api/v8/create-custom-module-api.html
  // ==========================================
  const LIVING_DOCS_MODULES = [
    {
      key: 'settings', apiName: 'Living_Docs_Settings', plural: 'Living Docs Settings', singular: 'Living Docs Setting',
      fields: [
        { label: 'Docs Agent Connection', type: 'text', length: 120 },
        { label: 'Workdrive Connection', type: 'text', length: 120 },
        { label: 'Workdrive Folder Id', type: 'text', length: 150 },
        { label: 'Schedule Frequency', type: 'text', length: 40 },
        { label: 'AI Provider', type: 'text', length: 100 },
        { label: 'AI Model', type: 'text', length: 120 },
        { label: 'AI API URL', type: 'text', length: 255 },
        { label: 'Claude Workspace Id', type: 'text', length: 120 },
        { label: 'Audience', type: 'text', length: 40 },
        // Per-user daily request counter, written by livingdocs_llm_gateway.
        { label: 'Usage JSON', type: 'textarea', length: 32000, textarea: 'large' }
        // Claude API Key and Cursor API Key are not module fields. Keys stay in the encrypted Org Variable.
      ]
    },
    {
      key: 'documents', apiName: 'Living_Docs_Documents', plural: 'Living Docs Documents', singular: 'Living Docs Document',
      fields: [
        { label: 'Item Type', type: 'text', length: 20 },
        { label: 'CRM Module', type: 'text', length: 255 },
        { label: 'Item Name', type: 'text', length: 255 },
        { label: 'Item Id', type: 'text', length: 60 },
        { label: 'Doc Version', type: 'integer', length: 9 },
        { label: 'File Name', type: 'text', length: 255 },
        { label: 'Generated By', type: 'text', length: 150 },
        { label: 'Generated At', type: 'datetime' },
        { label: 'Generated By User', type: 'text', length: 150 },
        { label: 'Audience', type: 'text', length: 40 },
        { label: 'Related Items', type: 'textarea', length: 2000, textarea: 'small' },
        { label: 'Masked Values', type: 'integer', length: 9 },
        { label: 'Source Hash', type: 'text', length: 64 },
        { label: 'Source Snapshot', type: 'textarea', length: 32000, textarea: 'large' }
      ]
    }
  ];
  const ZOHO_FIELDS_PER_CALL = 5;
  const moduleApiNames = {};

  function logModuleApi(key) {
    const spec = LIVING_DOCS_MODULES.find(m => m.key === key);
    return moduleApiNames[key] || (spec && spec.apiName);
  }

  function resolveLivingDocsModules(modules) {
    LIVING_DOCS_MODULES.forEach((spec) => {
      const found = findCustomModule(modules, spec.apiName);
      if (found && found.api_name) moduleApiNames[spec.key] = found.api_name;
    });
  }

  function fieldApiName(label) {
    return label.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function zohoFieldPayload(f) {
    const out = { field_label: f.label, data_type: f.type };
    if (f.length) out.length = f.length;
    if (f.type === 'textarea') out.textarea = { type: f.textarea || 'small' };
    return out;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function ensureCustomModule(docsConn, existingMods, profileIds, spec, log) {
    const found = findCustomModule(existingMods, spec.apiName);
    if (found) {
      moduleApiNames[spec.key] = found.api_name || spec.apiName;
      log(`${spec.apiName} already exists.`, 'ok');
      return true;
    }
    log(`Creating custom module ${spec.apiName}…`, 'info');
    try {
      const resp = await withHardTimeout(invokeZohoConnectionAPI(docsConn, {
        endpoint: '/crm/v8/settings/modules',
        method: 'POST',
        payload: { modules: [{ plural_label: spec.plural, singular_label: spec.singular, profiles: profileIds.length ? profileIds : undefined }] }
      }), 20000, `Create ${spec.apiName}`);
      const row = resp?.modules?.[0] || resp?.data?.[0] || resp || {};
      if (row.code === 'SUCCESS' || row.status === 'success' || row.code === 'DUPLICATE_DATA') {
        existingMods.push({ api_name: spec.apiName, plural_label: spec.plural, module_name: spec.apiName });
        moduleApiNames[spec.key] = spec.apiName;
        log(`${spec.apiName} ${row.code === 'DUPLICATE_DATA' ? 'already exists' : 'created'}.`, 'ok');
        return true;
      }
      log(`${spec.apiName} was not created: ${row.message || row.code || JSON.stringify(resp).slice(0, 200)}`, 'warn');
    } catch (err) {
      log(`${spec.apiName} was not created: ${err.message || err}`, 'warn');
    }
    return false;
  }

  async function ensureModuleFields(docsConn, spec, log) {
    const moduleApi = logModuleApi(spec.key);
    let existing = null;
    for (let attempt = 0; attempt < 3 && !existing; attempt++) {
      try {
        const body = await crmGet(`/crm/v8/settings/fields?module=${encodeURIComponent(moduleApi)}`, { connName: docsConn, timeoutMs: 15000 });
        existing = Array.isArray(body.fields) ? body.fields : [];
      } catch (err) {
        if (attempt === 2) {
          log(`Fields of ${moduleApi} could not be read: ${err.message || err}`, 'warn');
          return;
        }
        await sleep(2000);
      }
    }
    const have = new Set(existing.flatMap(f => [String(f.api_name || '').toLowerCase(), String(f.field_label || f.display_label || '').toLowerCase()]));
    const missing = spec.fields.filter(f => !have.has(fieldApiName(f.label).toLowerCase()) && !have.has(f.label.toLowerCase()));
    if (!missing.length) {
      log(`${moduleApi}: all ${spec.fields.length} fields are present.`, 'ok');
      return;
    }
    let created = 0;
    const failed = [];
    for (let i = 0; i < missing.length; i += ZOHO_FIELDS_PER_CALL) {
      const chunk = missing.slice(i, i + ZOHO_FIELDS_PER_CALL);
      try {
        const resp = await withHardTimeout(invokeZohoConnectionAPI(docsConn, {
          endpoint: `/crm/v8/settings/fields?module=${encodeURIComponent(moduleApi)}`,
          method: 'POST',
          payload: { fields: chunk.map(zohoFieldPayload) }
        }), 20000, `Create fields on ${moduleApi}`);
        const rows = Array.isArray(resp?.fields) ? resp.fields : [];
        chunk.forEach((f, k) => {
          const row = rows[k] || {};
          if (row.code === 'SUCCESS' || row.status === 'success' || row.code === 'DUPLICATE_DATA') created++;
          else failed.push(`${f.label} (${row.message || row.code || 'no response'})`);
        });
      } catch (err) {
        chunk.forEach(f => failed.push(`${f.label} (${err.message || err})`));
      }
    }
    if (created) log(`${moduleApi}: added ${plural(created, 'field')}.`, 'ok');
    if (failed.length) log(`${moduleApi}: ${plural(failed.length, 'field')} not added: ${failed.join('; ')}`, 'warn');
  }

  const LEGACY_SETTINGS_KEY_FIELDS = [
    { api: 'Claude_API_Key', provider: 'anthropic', label: 'Claude API Key' },
    { api: 'Cursor_API_Key', provider: 'cursor', label: 'Cursor API Key' }
  ];

  async function listSettingsFields(moduleApi, type) {
    const typeQuery = type ? `&type=${encodeURIComponent(type)}` : '';
    const body = await crmGet(`/crm/v8/settings/fields?module=${encodeURIComponent(moduleApi)}${typeQuery}`, { timeoutMs: 15000 });
    return Array.isArray(body.fields) ? body.fields : [];
  }

  function findLegacyKeyField(fields, spec) {
    return fields.find((field) => {
      const api = String(field.api_name || '').toLowerCase();
      const label = String(field.field_label || field.display_label || '').toLowerCase();
      return api === spec.api.toLowerCase() || label === spec.label.toLowerCase();
    }) || null;
  }

  async function deleteCrmField(moduleApi, field) {
    const endpoint = `/crm/v8/settings/fields/${encodeURIComponent(field.id)}?module=${encodeURIComponent(moduleApi)}`;
    const resp = await withHardTimeout(invokeZohoConnectionAPI(conn(), {
      endpoint,
      method: 'DELETE'
    }), 20000, `Delete ${field.api_name || field.field_label || field.id}`);
    const row = (Array.isArray(resp?.fields) ? resp.fields[0] : null) || resp || {};
    const apiErr = zohoApiError(resp) || zohoApiError(row);
    if (apiErr) return { ok: false, message: apiErr.message || apiErr.code };
    const ok = row.code === 'SUCCESS' || row.status === 'success';
    return { ok, message: row.message || row.code || JSON.stringify(resp).slice(0, 180) };
  }

  // Removes Claude API Key and Cursor API Key from Living_Docs_Settings. A field that still holds the only
  // copy of a key is left in place until that key is in the encrypted Org Variable.
  async function removeLegacyKeyFields(log = () => {}) {
    if (!canUseZohoConnection()) return;
    if (!state.removedSettingsKeyFields) state.removedSettingsKeyFields = {};
    const moduleApi = logModuleApi('settings');
    let fields = [];
    try {
      fields = await listSettingsFields(moduleApi, 'all');
    } catch (err) {
      try {
        fields = await listSettingsFields(moduleApi);
      } catch (fallbackErr) {
        log(`Could not read ${moduleApi} fields: ${fallbackErr.message || fallbackErr}`, 'warn');
        return;
      }
    }
    for (const spec of LEGACY_SETTINGS_KEY_FIELDS) {
      if (state.removedSettingsKeyFields[spec.api]) continue;
      const field = findLegacyKeyField(fields, spec);
      if (!field) {
        state.removedSettingsKeyFields[spec.api] = true;
        continue;
      }
      if (field.custom_field === false) {
        log(`${spec.label} is a system field on ${moduleApi}, so it was left in place.`, 'warn');
        continue;
      }
      if (state.legacyKeys[spec.provider] && !keyInfo(spec.provider).set) {
        log(`${spec.label} still holds the only copy of that key, so it stays on ${moduleApi} until the key is stored encrypted.`, 'warn');
        continue;
      }
      if (!field.id) {
        log(`${spec.label} has no field id, so it could not be removed.`, 'warn');
        continue;
      }
      try {
        const first = await deleteCrmField(moduleApi, field);
        if (!first.ok) {
          log(`${spec.label} was not removed: ${first.message}`, 'warn');
          continue;
        }
        let unused;
        try {
          unused = await listSettingsFields(moduleApi, 'unused');
        } catch (err) {
          log(`${spec.label} left the layout. Unused fields could not be checked: ${err.message || err}`, 'warn');
          continue;
        }
        const parked = findLegacyKeyField(unused, spec);
        if (parked && parked.id) {
          const second = await deleteCrmField(moduleApi, parked);
          if (!second.ok) {
            log(`${spec.label} was moved off the layout, but the unused field is still there: ${second.message}`, 'warn');
            continue;
          }
        }
        state.removedSettingsKeyFields[spec.api] = true;
        state.legacyKeys[spec.provider] = '';
        log(`Removed ${spec.label} from ${moduleApi}.`, 'ok');
      } catch (err) {
        log(`${spec.label} was not removed: ${err.message || err}`, 'warn');
      }
    }
  }

  async function autoProvisionCustomModules(showFeedback = false, statusCallback = null) {
    const log = (msg, type = 'info') => {
      console.log('[Living Docs Agent]', msg);
      if (statusCallback) statusCallback(msg, type);
    };

    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    log(`Auto-verifying custom modules & fields via Zoho CRM v8 API using "${docsConn}"...`);

    // ---- ZOHO EMBEDDED SDK PATH ----
    if (typeof ZOHO !== 'undefined' && ZOHO.CRM) {
      try {
        // 1. Get Organization Profile IDs (Required by Zoho API v8 for module creation)
        const profileIds = await getActiveProfileIds(docsConn, log);
        if (profileIds.length === 0) {
          log('ℹ️ Proceeding with default organization profile access.', 'info');
        }

        // 2. Check Existing Modules in CRM
        log('Checking existing CRM modules...', 'info');
        let existingMods = [];
        try {
          existingMods = await fetchCrmModules(docsConn);
        } catch (e) {
          console.warn('[Module Check API]', e);
          log(`❌ Could not list CRM modules: ${e.message}. Skipping custom module creation to avoid duplicates.`, 'warn');
          return { ok: false, message: `Could not list CRM modules: ${e.message}` };
        }

        for (const spec of LIVING_DOCS_MODULES) {
          await ensureCustomModule(docsConn, existingMods, profileIds, spec, log);
          await ensureModuleFields(docsConn, spec, log);
        }

        // Create the settings row once, then update that same row
        if (showFeedback && ZOHO.CRM.API) {
          log('Saving configuration on Living_Docs_Settings...', 'info');
          const saved = await saveSettingsRecord();
          if (saved.ok) {
            log(`✅ ${saved.action === 'created' ? 'Created' : 'Updated'} settings record ${saved.id || ''}.`, 'ok');
          } else {
            log(`Settings were not saved: ${saved.message || 'Could not write the settings row.'}`, 'warn');
          }
          renderSettingsRecordStatus();
          state.modulesProvisioned = true;
          return saved;
        }

        state.modulesProvisioned = true;
        return { ok: true };
      } catch (sdkErr) {
        log(`⚠️ Modules could not be verified: ${sdkErr.message || sdkErr}`, 'warn');
        return { ok: false, message: sdkErr.message || String(sdkErr) };
      }
    }
    log('Open the widget inside Zoho CRM to install the Living Docs modules.', 'warn');
    return { ok: false, message: 'The Zoho CRM SDK is not available.' };
  }

  function isScannableModule(mod) {
    if (!mod || !mod.api_name) return false;
    if (mod.api_supported === false) return false;
    const generated = String(mod.generated_type || '').toLowerCase();
    return generated !== 'subform' && generated !== 'linking' && generated !== 'web';
  }

  async function mapPool(items, limit, worker) {
    const queue = items.slice();
    const runners = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  async function fetchCrmModules(docsConn) {
    const connectionName = docsConn || state.settings.docsAgentConnection || 'docsagent_connection';
    let connErr = null;
    try {
      const resp = await crmGet('/crm/v8/settings/modules', { connName: connectionName });
      if (Array.isArray(resp.modules)) return resp.modules;
      connErr = new Error(`"${connectionName}" returned no "modules" array from GET /crm/v8/settings/modules. Keys: ${Object.keys(resp).join(', ') || '(empty body)'}`);
    } catch (e) {
      connErr = e;
    }
    console.warn('[DocsAgent] Modules via connection failed, trying ZOHO.CRM.META.getModules():', connErr);

    if (typeof ZOHO !== 'undefined' && ZOHO.CRM?.META?.getModules) {
      try {
        const metaResp = await withHardTimeout(ZOHO.CRM.META.getModules(), 15000, 'ZOHO.CRM.META.getModules');
        console.log('[DocsAgent] ZOHO.CRM.META.getModules() response', metaResp);
        if (Array.isArray(metaResp?.modules) && metaResp.modules.length) {
          showToast(`Modules loaded via SDK fallback. Connection error: ${connErr.message}`, 'warning');
          return metaResp.modules;
        }
      } catch (metaErr) {
        console.error('[DocsAgent] ZOHO.CRM.META.getModules() failed', metaErr);
      }
    }
    throw connErr;
  }

  async function fetchModuleFields(docsConn, moduleApiName) {
    const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: `/crm/v8/settings/fields?module=${encodeURIComponent(moduleApiName)}`,
      method: 'GET'
    }), 15000, null);
    return Array.isArray(resp?.fields) ? resp.fields : [];
  }

  async function fetchOrgLabel(docsConn) {
    const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: '/crm/v8/org',
      method: 'GET'
    }), 8000, null);
    const org = resp?.org?.[0];
    return org?.company_name || null;
  }

  async function fetchAllWorkflowRulePages(docsConn) {
    const allRules = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 50) {
      const wfResp = await crmGet(`/crm/v8/settings/automation/workflow_rules?page=${page}&per_page=200`, { connName: docsConn });
      const rules = Array.isArray(wfResp.workflow_rules) ? wfResp.workflow_rules : [];
      console.log(`[DocsAgent] workflow_rules page ${page}: ${rules.length} rules`, wfResp.info || {});
      if (rules.length === 0) break;
      allRules.push(...rules);
      hasMore = wfResp.info?.more_records === true;
      page += 1;
    }
    return allRules;
  }

  function workflowModuleName(rule) {
    if (!rule || !rule.module) return '';
    return typeof rule.module === 'string' ? rule.module : (rule.module.api_name || '');
  }

  // include_inner_details requires the module param and the full key list, so it is fetched per module.
  async function enrichWorkflowRules(docsConn, rules) {
    const moduleNames = [...new Set(rules.map(workflowModuleName).filter(Boolean))];
    const byId = new Map(rules.map(rule => [String(rule.id), rule]));
    const include = 'conditions,conditions.instant_actions,conditions.criteria_details,conditions.scheduled_actions';
    await mapPool(moduleNames, 3, async (moduleName) => {
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 20) {
        const endpoint = `/crm/v8/settings/automation/workflow_rules?module=${encodeURIComponent(moduleName)}&page=${page}&per_page=200&include_inner_details=${encodeURIComponent(include)}`;
        let wfResp;
        try {
          wfResp = await crmGet(endpoint, { connName: docsConn });
        } catch (e) {
          console.warn(`[DocsAgent] Could not load inner details for ${moduleName}; keeping summary rows.`, e);
          return;
        }
        const detailed = Array.isArray(wfResp.workflow_rules) ? wfResp.workflow_rules : [];
        if (detailed.length === 0) break;
        detailed.forEach(rule => {
          if (rule && rule.id) byId.set(String(rule.id), { ...(byId.get(String(rule.id)) || {}), ...rule });
        });
        hasMore = wfResp.info?.more_records === true;
        page += 1;
      }
    });
    return Array.from(byId.values());
  }

  async function hydrateWorkflowRecord(workflow) {
    if (!canUseZohoConnection() || !workflow?.id) return workflow;
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    let singleResp;
    try {
      singleResp = await crmGet(`/crm/v8/settings/automation/workflow_rules/${encodeURIComponent(workflow.id)}`, { connName: docsConn, timeoutMs: 15000 });
    } catch (e) {
      console.warn(`[DocsAgent] GET workflow_rules/${workflow.id} failed`, e);
      return workflow;
    }
    const raw = singleResp?.workflow_rules?.[0];
    if (!raw) return workflow;
    const normalized = normalizeZohoWorkflows([raw])[0];
    return { ...workflow, ...normalized, module: normalized.module || workflow.module };
  }

  function collectFunctionActions(workflow) {
    const source = workflow?._raw || workflow || {};
    const asList = (value) => Array.isArray(value) ? value : (value ? [value] : []);
    const found = [];
    const push = (action, timing) => {
      if (!action || typeof action !== 'object') return;
      const type = String(action.type || action.action_type || '');
      if (!/function|deluge/i.test(type)) return;
      const related = action.related_details || {};
      found.push({
        id: String(action.id || related.id || ''),
        api_name: related.api_name || action.api_name || '',
        name: action.name || action.action_name || related.name || '',
        type,
        timing
      });
    };
    asList(source.conditions).forEach((condition) => {
      asList(condition.instant_actions).forEach((group) => {
        asList(group.actions).forEach((action) => push(action, 'instant'));
      });
      asList(condition.scheduled_actions).forEach((group) => {
        asList(group.actions).forEach((action) => push(action, 'scheduled'));
      });
    });
    asList(source.actions).forEach((action) => push(action, 'instant'));
    if (!found.length) {
      asList(workflow?.actions).forEach((action) => {
        if (typeof action !== 'string') return;
        const match = action.match(/^(?:\[Scheduled\]\s*)?(?:functions|function|deluge)\s*:\s*(.+)$/i);
        if (match) {
          found.push({
            id: '',
            api_name: '',
            name: match[1].trim(),
            type: 'functions',
            timing: /scheduled/i.test(action) ? 'scheduled' : 'instant'
          });
        }
      });
    }
    const seen = new Set();
    return found.filter((item) => {
      const key = `${item.id}|${item.api_name}|${item.name}|${item.timing}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function fetchFunctionCatalog(docsConn) {
    const pages = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 20) {
      const endpoint = page === 1
        ? '/crm/v8/settings/functions?per_page=200'
        : `/crm/v8/settings/functions?page=${page}&per_page=200`;
      const resp = await crmGet(endpoint, { connName: docsConn, timeoutMs: 20000 });
      const list = Array.isArray(resp?.functions) ? resp.functions : [];
      if (!list.length) break;
      pages.push(...list);
      hasMore = resp.info?.more_records === true;
      page += 1;
    }
    return pages;
  }

  // The .ds download is not JSON, so CONNECTION.invoke hands it back in several shapes
  // (plain string, { raw_text }, or a JSON body from the legacy functions endpoint).
  function textFromFunctionDownload(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof body !== 'object') return '';
    const keys = ['raw_text', '_code', 'script', 'source', 'content', 'response', 'data'];
    for (const key of keys) {
      if (typeof body[key] === 'string' && body[key].trim()) return body[key];
    }
    if (typeof body.code === 'string' && /[\n;{}]/.test(body.code)) return body.code;
    const first = Array.isArray(body.functions) ? body.functions[0] : null;
    if (first) return textFromFunctionDownload(first);
    if (body.details && typeof body.details === 'object') return textFromFunctionDownload(body.details);
    return '';
  }

  async function downloadFunctionSource(docsConn, fn) {
    const ids = [...new Set([fn.id, fn.api_name].map(v => String(v || '').trim()).filter(Boolean))];
    const attempts = [];
    const endpoints = [];
    ids.forEach(idf => endpoints.push(`/crm/v8/settings/functions/${encodeURIComponent(idf)}/code`));
    if (fn.id) {
      endpoints.push(`/crm/v2/settings/functions/${encodeURIComponent(fn.id)}?source=crm&language=deluge`);
    }
    for (const endpoint of endpoints) {
      try {
        const body = await crmGet(endpoint, { connName: docsConn, timeoutMs: 20000 });
        const source = textFromFunctionDownload(body);
        if (source.startsWith('PK')) {
          attempts.push({ endpoint, result: 'ZIP package (Java / Node.js / Python)' });
          return {
            source: '',
            attempts,
            note: 'Zoho returned a ZIP package. Java, Node.js, and Python functions download as ZIP; only Deluge downloads as text.'
          };
        }
        if (source.trim()) {
          attempts.push({ endpoint, result: `ok, ${source.length} characters` });
          return { source, attempts, endpoint, note: '' };
        }
        const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
        attempts.push({ endpoint, result: `no source in response (keys: ${keys || 'empty'})` });
      } catch (err) {
        attempts.push({ endpoint, result: err.message || String(err) });
      }
    }
    return {
      source: '',
      attempts,
      note: 'No endpoint returned function source. Check that the connection has ZohoCRM.settings.functions.READ and that the function is published.'
    };
  }

  function matchCatalogFunction(catalog, ref) {
    const id = String(ref.id || '');
    const apiName = String(ref.api_name || '').toLowerCase();
    const name = String(ref.name || '').trim().toLowerCase();
    return catalog.find((fn) => id && String(fn.id) === id)
      || catalog.find((fn) => apiName && String(fn.api_name || '').toLowerCase() === apiName)
      || catalog.find((fn) => name && String(fn.api_name || '').toLowerCase() === name)
      || catalog.find((fn) => name && String(fn.name || fn.display_name || '').trim().toLowerCase() === name)
      || null;
  }

  // No limit for now: the whole function source goes into the prompt.
  const FUNCTION_SOURCE_MAX_CHARS = Infinity;

  async function attachFunctionCodeToWorkflows(workflows) {
    if (!canUseZohoConnection() || !workflows?.length) return workflows || [];
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    let catalog = [];
    state.functionCatalogError = '';
    try {
      catalog = (state.functionCatalog && state.functionCatalog.length) ? state.functionCatalog : await fetchFunctionCatalog(docsConn);
    } catch (err) {
      state.functionCatalogError = err.message || String(err);
      console.warn('[DocsAgent] GET /crm/v8/settings/functions failed. Add ZohoCRM.settings.functions.READ to the connection.', err);
    }
    const cache = new Map();
    const enriched = [];
    for (const workflow of workflows) {
      const refs = collectFunctionActions(workflow);
      const functionCode = [];
      for (const ref of refs) {
        const match = matchCatalogFunction(catalog, ref);
        const fnId = String((match && match.id) || ref.id || '');
        const fnApiName = (match && match.api_name) || ref.api_name || '';
        const cacheKey = String(fnId || fnApiName || ref.name || '');
        if (!cache.has(cacheKey)) {
          if (!fnId && !fnApiName) {
            cache.set(cacheKey, {
              name: ref.name,
              source: '',
              attempts: [],
              error: 'This workflow action has a function name but no function id, and it was not found in GET /settings/functions.'
            });
          } else {
            const downloaded = await downloadFunctionSource(docsConn, { id: fnId, api_name: fnApiName });
            const source = downloaded.source || '';
            cache.set(cacheKey, {
              id: fnId,
              api_name: fnApiName,
              name: (match && (match.display_name || match.name)) || ref.name || fnApiName,
              category: (match && match.category) || '',
              language: (match && match.language) || '',
              runtime: (match && match.runtime) || '',
              description: (match && match.description) || '',
              arguments: (match && match.arguments) || [],
              modified_time: (match && (match.modified_time || match.modified_on || match.updated_time)) || '',
              modified_by: (match && (match.modified_by?.name || match.modified_by?.full_name || (typeof match.modified_by === 'string' ? match.modified_by : ''))) || '',
              source: source.slice(0, FUNCTION_SOURCE_MAX_CHARS),
              source_truncated: source.length > FUNCTION_SOURCE_MAX_CHARS,
              source_endpoint: downloaded.endpoint || '',
              attempts: downloaded.attempts || [],
              in_catalog: !!match,
              note: downloaded.note || ''
            });
          }
        }
        functionCode.push({
          timing: ref.timing,
          action_type: ref.type,
          ...cache.get(cacheKey)
        });
      }
      const copy = { ...workflow, function_code: functionCode };
      delete copy._raw;
      enriched.push(copy);
    }
    return enriched;
  }

  function formatCriteria(criteria) {
    if (criteria == null || criteria === '') return '';
    if (typeof criteria === 'string') return criteria;
    if (Array.isArray(criteria)) return criteria.map(formatCriteria).filter(Boolean).join(' AND ');
    if (typeof criteria !== 'object') return String(criteria);
    if (criteria.group_operator && Array.isArray(criteria.group)) {
      return criteria.group.map(formatCriteria).filter(Boolean).join(` ${criteria.group_operator} `);
    }
    if (criteria.field || criteria.comparator || criteria.value != null) {
      const field = (criteria.field && (criteria.field.api_name || criteria.field)) || 'Field';
      const value = criteria.value == null ? '' : (typeof criteria.value === 'object' ? JSON.stringify(criteria.value) : criteria.value);
      return `${field} ${criteria.comparator || ''} ${value}`.trim();
    }
    return '';
  }

  // Normalize Zoho CRM API v8 workflow_rules → internal format with conditions & actions
  function normalizeZohoWorkflows(apiWorkflows) {
    return apiWorkflows.map(function(wf) {
      // Extract criteria from conditions or details
      let crit = (wf.execute_when && wf.execute_when.details && wf.execute_when.details.criteria) ||
                 (wf.condition && wf.condition.criteria) ||
                 wf.criteria || null;
      const conditionList = Array.isArray(wf.conditions) ? wf.conditions : [];
      if (!crit && conditionList.length > 0) {
        const parts = conditionList.map(c => {
          const cd = c.criteria_details || {};
          const main = cd.criteria ? formatCriteria(cd.criteria) : '';
          const rel = cd.relational_criteria?.criteria
            ? `[${cd.relational_criteria.module?.api_name || 'Related'}] ${formatCriteria(cd.relational_criteria.criteria)}`
            : '';
          return [main, rel].filter(Boolean).join(' AND ');
        }).filter(Boolean);
        if (parts.length === 1) crit = parts[0];
        else if (parts.length > 1) crit = parts.map((p, i) => `Condition ${i + 1}: ${p}`).join(' | ');
      }
      if (crit && typeof crit === 'object') crit = formatCriteria(crit);

      const asList = (v) => Array.isArray(v) ? v : (v ? [v] : []);
      let actionList = wf.actions || wf.workflow_actions || [];
      if ((!actionList || actionList.length === 0) && conditionList.length > 0) {
        const extracted = [];
        conditionList.forEach(c => {
          asList(c.instant_actions).forEach(ia => {
            (ia.actions || []).forEach(a => {
              extracted.push(a.name ? `${a.type || 'Action'}: ${a.name}` : a);
            });
          });
          asList(c.scheduled_actions).forEach(sa => {
            (sa.actions || []).forEach(a => {
              extracted.push(a.name ? `[Scheduled] ${a.type || 'Action'}: ${a.name}` : a);
            });
          });
        });
        if (extracted.length > 0) actionList = extracted;
      }

      return {
        id: String(wf.id || wf.workflow_rule_id || ('wf_live_' + Date.now() + '_' + Math.random().toString(36).slice(2))),
        name: wf.name || wf.rule_name || 'Unnamed Workflow',
        status: (wf.active === true || (wf.status && wf.status.active === true) || wf.status === 'Active' || wf.status === 'active') ? 'active' : 'inactive',
        trigger_type: normalizeTriggerType((wf.execute_when && wf.execute_when.type) || wf.rule_trigger_category || wf.trigger || 'on_record_action'),
        criteria: crit,
        actions: extractActionLabels(actionList),
        module: workflowModuleName(wf) || 'Unknown',
        module_id: (wf.module && wf.module.id) || null,
        created_time: wf.created_time || null,
        created_by: wf.created_by || null,
        modified_time: wf.modified_time || null,
        modified_by: wf.modified_by || null,
        description: wf.description || '',
        conditions: wf.conditions || [],
        source: wf.source || 'crm',
        _raw: wf,
        _source: 'zoho_api_v8'
      };
    });
  }

  function normalizeTriggerType(raw) {
    var map = {
      'On Record Create': 'on_record_create',
      'On Record Edit': 'on_record_edit',
      'Create or Edit': 'create_or_edit',
      'On Record Delete': 'on_record_delete',
      'Field Update': 'field_update',
      'Incoming Call CreateEdit': 'incoming_call_createedit',
      'Email Received': 'email_received',
      'Overdue': 'overdue',
      'Scheduled': 'scheduled'
    };
    return map[raw] || (raw || 'on_record_action').toLowerCase().replace(/\s+/g, '_');
  }

  function extractActionLabels(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.map(function(act) {
      if (typeof act === 'string') return act;
      var type = act.type || act.action_type || 'Action';
      var name = act.name || act.action_name || '';
      return name ? (type + ': ' + name) : type;
    });
  }

  function pdfBytesFromBase64(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function downloadPdfBytes(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  // PDF: the flowchart is drawn smaller, about half the page width, so it fits under the cover instead of
  // being pushed to the next page. Its pixel size is set on the SVG itself because html2canvas draws an SVG at
  // its width/height attributes and clips it, ignoring a smaller CSS width.
  const PDF_FLOWCHART_PX = 340;

  function documentFlowSection(wf, { pdf = false } = {}) {
    return `<section class="pdf-flow"><h2>Flow</h2>${renderFlowchart(wf, pdf ? { width: PDF_FLOWCHART_PX } : {})}</section>`;
  }

  function pdfDocumentHtml(doc) {
    const g = doc.generated;
    return `
      <header class="pdf-cover">
        <div class="pdf-brand">Living Docs · Zoho CRM workflow documentation</div>
        <h1 class="pdf-title">${escapeHtml(doc.wf.name)}</h1>
        <div class="pdf-meta">
          <span><b>Module</b> ${escapeHtml(moduleLabel(doc.wf.module) || 'CRM')}</span>
          ${g.version ? `<span><b>Version</b> v${escapeHtml(g.version)}</span>` : ''}
          <span><b>Date</b> ${escapeHtml(formatDate(g.at))}</span>
          <span><b>Written by</b> ${escapeHtml(g.generatedBy || aiName())}</span>
        </div>
      </header>
      <article class="doc-view pdf-body">${documentFlowSection(doc.wf, { pdf: true })}${renderMarkdown(g.markdown)}</article>`;
  }

  function renderPdfBytes(doc) {
    return renderSectionsPdf([pdfDocumentHtml(doc)], doc.generated.fileName, doc.wf.name);
  }

  // Browsers cap a canvas at about 32k pixels, so a continuous document is cut into as few
  // render passes as fit under that height. Each pass starts on a new page.
  const PDF_MAX_CANVAS_PX = 28000;

  function pdfSheet(html, compact) {
    const sheet = document.createElement('div');
    sheet.className = compact ? 'pdf-sheet compact' : 'pdf-sheet';
    sheet.innerHTML = html;
    return sheet;
  }

  // html2canvas does not scale an inline SVG to its size reliably (the flowchart came out cropped), so each
  // flowchart is drawn to a PNG by the browser first and html2canvas only sees an <img>. If the browser refuses
  // (for example a tainted canvas), the SVG stays as it is.
  const FLOWCHART_RASTER_SCALE = 3;

  function rasterizeFlowcharts(root) {
    const svgs = [...root.querySelectorAll('.fc svg')];
    return Promise.all(svgs.map(svg => new Promise((resolve) => {
      const w = Number(svg.getAttribute('width')) || FC.width;
      const h = Number(svg.getAttribute('height')) || FC.width;
      const source = new Image();
      source.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * FLOWCHART_RASTER_SCALE);
          canvas.height = Math.round(h * FLOWCHART_RASTER_SCALE);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
          const img = new Image();
          img.src = canvas.toDataURL('image/png');
          // Inline size: a CSS width:auto would otherwise show the PNG at its full 3x resolution.
          img.style.width = `${w}px`;
          img.style.height = `${h}px`;
          img.alt = svg.getAttribute('aria-label') || 'Flowchart';
          svg.replaceWith(img);
        } catch (_) { /* keep the SVG */ }
        resolve();
      };
      source.onerror = () => resolve();
      source.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    })));
  }

  function continuousChunks(sections, maxCssHeight) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(host);
    const chunks = [];
    try {
      let current = [];
      let height = 0;
      sections.forEach((html) => {
        const sheet = pdfSheet(html, true);
        host.appendChild(sheet);
        const h = sheet.scrollHeight;
        host.removeChild(sheet);
        if (current.length && height + h > maxCssHeight) {
          chunks.push(current.join(''));
          current = [];
          height = 0;
        }
        current.push(html);
        height += h;
      });
      if (current.length) chunks.push(current.join(''));
    } finally {
      host.remove();
    }
    return chunks;
  }

  // Separate sections start on a new page. With continuous, sections flow one after another and only
  // the workflow headings separate them (used for module master documents).
  async function renderSectionsPdf(sections, fileName, title, options = {}) {
    if (typeof window.html2pdf !== 'function') throw new Error('The PDF renderer did not load. Reload the widget and try again.');
    const compact = Boolean(options.continuous);
    const scale = compact ? 1.25 : (sections.length > 12 ? 1.5 : 2);
    const parts = compact ? continuousChunks(sections, PDF_MAX_CANVAS_PX / scale) : sections;
    const sheets = parts.map(html => pdfSheet(html, compact));
    await Promise.all(sheets.map(rasterizeFlowcharts));
    const margin = compact ? [8, 10, 10, 10] : [12, 12, 16, 12];
    let worker = window.html2pdf().set({
      margin,
      filename: fileName,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale, useCORS: true, backgroundColor: '#ffffff', logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: compact
        ? { mode: ['css'] }
        : { mode: ['css', 'legacy'], avoid: ['h2', 'h3', 'tr', 'pre', 'blockquote', 'li', '.pdf-cover', '.fc'] }
    }).from(sheets[0]).toPdf();
    sheets.slice(1).forEach((sheet) => {
      worker = worker.get('pdf').then(p => { p.addPage(); }).from(sheet).toContainer().toCanvas().toPdf();
    });
    const pdf = await worker.get('pdf');
    const total = pdf.internal.getNumberOfPages();
    const width = pdf.internal.pageSize.getWidth();
    const height = pdf.internal.pageSize.getHeight();
    for (let page = 1; page <= total; page += 1) {
      pdf.setPage(page);
      pdf.setFontSize(8);
      pdf.setTextColor(140, 146, 158);
      pdf.text(`${title}  ·  Page ${page} of ${total}`, width / 2, height - 7, { align: 'center' });
    }
    return new Uint8Array(pdf.output('arraybuffer'));
  }

  // ==========================================
  // SHARED UI HELPERS
  // ==========================================
  const $ = (id) => document.getElementById(id);

  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="6" x2="12" y2="13"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    up: '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5 1l4 7H1z"/></svg>',
    down: '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5 9L1 2h8z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>'
  };

  function conn() {
    return state.settings.docsAgentConnection || 'docsagent_connection';
  }

  function canUseZohoConnection() {
    return state.isZohoEmbedded && typeof ZOHO !== 'undefined' && !!(ZOHO.CRM && ZOHO.CRM.CONNECTION && ZOHO.CRM.CONNECTION.invoke);
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    $('toastHost').appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 250);
    }, 4200);
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
  }

  function loadingBlock(text) {
    return `<div class="loading-block"><div class="spinner"></div><p>${escapeHtml(text)}</p></div>`;
  }

  function copyText(text, btn, label) {
    const done = () => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1800);
    };
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (_) { showToast('Copy failed. Select the text manually.', 'warning'); }
      area.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function setOrg(label, status) {
    dom.orgChipLabel.textContent = label;
    dom.orgChip.className = `org-chip ${status || ''}`;
  }

  function showScreen(name) {
    if (dom.screenBoot) dom.screenBoot.classList.toggle('active', name === 'boot');
    dom.screenSetup.classList.toggle('active', name === 'setup');
    dom.screenFlow.classList.toggle('active', name === 'flow');
    dom.btnRescan.hidden = name !== 'flow';
  }

  const COMPARATOR_LABELS = {
    not_equal: '≠', equal: '=', greater_equal: '≥', less_equal: '≤',
    greater_than: '>', less_than: '<', not_contains: 'does not contain',
    starts_with: 'starts with', ends_with: 'ends with', not_between: 'not between', not_in: 'not in'
  };

  function readableCriteria(text) {
    return String(text || '').replace(/\b(not_equal|greater_equal|less_equal|greater_than|less_than|not_contains|starts_with|ends_with|not_between|not_in|equal)\b/g, m => COMPARATOR_LABELS[m]);
  }

  function shortCriteria(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? `${clean.slice(0, 46)}…` : clean;
  }

  function displayCriteria(text) {
    const value = String(text || '').trim();
    return value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1).trim() : value;
  }

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function triggerLabel(type) {
    const map = {
      on_record_create: 'On create', create: 'On create',
      on_record_edit: 'On edit', edit: 'On edit',
      create_or_edit: 'Create or edit', on_record_action: 'Record action',
      field_update: 'Field update', delete: 'On delete', on_record_delete: 'On delete',
      date_or_date_time: 'Date based', overdue: 'Overdue', scheduled: 'Scheduled',
      email_received: 'Email received', incoming_call_createedit: 'Incoming call', score_update: 'Score update'
    };
    const key = String(type || '').toLowerCase();
    return map[key] || key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) || 'Not set';
  }

  function actionTypeLabel(type) {
    const map = {
      field_updates: 'Field update', email_notifications: 'Email', tasks: 'Task', webhooks: 'Webhook',
      functions: 'Function', assign_owner: 'Assign owner', add_tags: 'Add tags', remove_tags: 'Remove tags',
      create_record: 'Create record', add_meeting: 'Meeting', schedule_call: 'Call', convert: 'Convert', circuits: 'Circuit'
    };
    return map[type] || String(type || 'Action').replace(/_/g, ' ');
  }

  function stripEmoji(text) {
    return String(text || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2139}]/gu, '').trim();
  }

  // ==========================================
  // ELEMENTS & EVENTS
  // ==========================================
  function initElements() {
    [
      'orgChip', 'orgChipLabel', 'btnRescan', 'btnOpenSettings',
      'screenBoot', 'screenSetup', 'screenFlow', 'setupSkeleton', 'setupBody', 'setupTitle', 'setupSubtitle', 'setupChecklist', 'setupForm',
      'setupDocsConn', 'setupWdConn', 'setupWdFolder', 'setupLogWrap', 'setupLog',
      'setupTabs', 'setupAiSummary', 'setupAiProvider', 'setupAiFields', 'setupAiLabel', 'setupAiUrl', 'setupAiUrlField', 'setupAiUrlHint',
      'setupAiModel', 'setupAiClaudeKey', 'setupAiCursorKey', 'setupAiClaudeHint', 'setupAiCursorHint',
      'btnSetupTestAi', 'setupAiTestResult',
      'btnSetupRetry', 'btnSetupBack', 'btnSetupNext', 'btnSetupInstall', 'btnSetupContinue',
      'stepper', 'scanStatus', 'moduleTableBody', 'btnToSelect',
      'selectedCountPill', 'wfSearch', 'wfModuleFilter', 'wfStatusFilter', 'wfFunctionsOnly',
      'btnClearSelection', 'wfCheckAll', 'wfTableBody', 'btnToReview',
      'reviewStatus', 'reviewTabs', 'reviewBody', 'btnReviewDetails', 'promptCard', 'promptStats', 'promptSystem', 'promptUser',
      'btnRebuildPrompt', 'btnCopyPrompt', 'btnGenerate',
      'docStatus', 'btnViewDetails', 'btnViewDocument', 'btnCopyMd', 'btnDownloadMd', 'btnDownloadPdf', 'docNotice', 'docView', 'docTabs', 'btnToSave',
      'saveCard', 'btnStartOver',
      'drawerBackdrop', 'settingsDrawer', 'btnCloseSettings', 'settingsDocsConn', 'settingsWdConn',
      'settingsWorkDriveFolder', 'settingsAudience',
      'settingsAiProvider', 'settingsAiFields', 'settingsAiLabel', 'settingsAiUrl', 'settingsAiUrlHint', 'settingsAiModel',
      'settingsAiKey', 'settingsAiKeyHint', 'btnTestAi', 'btnClearAiKey', 'settingsAiTestResult',
      'settingsRecordNote', 'btnSettingsRecheck', 'btnSaveSettings',
      'modalBackdrop', 'modalTitle', 'modalBody', 'modalCancel', 'modalConfirm', 'issueTip', 'maskSelBtn',
      'ruleDocBackdrop', 'ruleDocTitle', 'ruleDocBody', 'btnCloseRuleDoc'
    ].forEach((id) => { dom[id] = $(id); });
  }

  function bindEvents() {
    dom.btnRescan.addEventListener('click', () => scanCrm(true));
    dom.btnOpenSettings.addEventListener('click', openSettings);
    dom.btnCloseSettings.addEventListener('click', closeSettings);
    dom.drawerBackdrop.addEventListener('click', closeSettings);
    dom.btnSaveSettings.addEventListener('click', saveSettings);
    dom.settingsAiProvider.addEventListener('change', () => renderAiFields(true));
    dom.btnTestAi.addEventListener('click', () => testAiConnection());
    dom.settingsAiKey.addEventListener('change', () => loadAiModels(aiFormValues(), dom.settingsAiModel));
    $('settingsAiWorkspace').addEventListener('change', () => loadAiModels(aiFormValues(), dom.settingsAiModel));
    dom.btnClearAiKey.addEventListener('click', () => {
      state.clearAiKey = true;
      renderAiFields(false);
      showToast('The saved key is removed when you save.', 'warning');
    });
    dom.btnSettingsRecheck.addEventListener('click', () => { closeSettings(); runSetupCheck(true); });
    $('btnShowUpdateHelper').addEventListener('click', () => { closeSettings(); showUpdateHelperDialog(); });

    dom.btnSetupRetry.addEventListener('click', () => runSetupCheck(true));
    dom.screenSetup.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      copyText(btn.dataset.copy, btn, btn.dataset.copyLabel || 'Copy');
    });
    dom.btnSetupInstall.addEventListener('click', installAndVerify);
    dom.btnSetupContinue.addEventListener('click', enterFlow);
    dom.btnSetupNext.addEventListener('click', () => showSetupTab(2));
    $('btnSetupEdit').addEventListener('click', () => showSetupEditor(2));
    dom.btnSetupBack.addEventListener('click', () => showSetupTab(1));
    dom.setupTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-setup-tab]');
      if (tab) showSetupTab(Number(tab.dataset.setupTab));
    });
    dom.setupAiProvider.addEventListener('change', () => renderSetupAiFields(true));
    dom.btnSetupTestAi.addEventListener('click', () => testAiConnection(setupAiValues(), dom.setupAiTestResult, dom.btnSetupTestAi, dom.setupAiModel));
    [dom.setupAiClaudeKey, dom.setupAiCursorKey, $('setupAiWorkspace')].forEach(el => {
      el.addEventListener('change', () => loadAiModels(setupAiValues(), dom.setupAiModel));
    });

    dom.stepper.addEventListener('click', (e) => {
      const item = e.target.closest('li[data-step]');
      if (item && item.classList.contains('reachable')) goToStep(Number(item.dataset.step));
    });
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => goToStep(Number(btn.dataset.goto)));
    });

    dom.btnToSelect.addEventListener('click', () => goToStep(2));
    dom.moduleTableBody.addEventListener('click', (e) => {
      // The module master document link opens the record instead of filtering by the module.
      const doc = e.target.closest('[data-open-doc]');
      if (doc) {
        e.preventDefault();
        openCrmRecord(logModuleApi('documents'), doc.dataset.openDoc);
        return;
      }
      const row = e.target.closest('tr[data-module]');
      if (!row) return;
      dom.wfModuleFilter.value = row.dataset.module;
      renderWorkflowTable();
      goToStep(2);
    });

    dom.wfSearch.addEventListener('input', renderWorkflowTable);
    [dom.wfModuleFilter, dom.wfStatusFilter, dom.wfFunctionsOnly].forEach(el => el.addEventListener('change', renderWorkflowTable));
    $('btnModuleDoc').addEventListener('click', () => generateModuleDocument(dom.wfModuleFilter.value));
    dom.wfCheckAll.addEventListener('change', () => {
      const visible = visibleWorkflows();
      if (dom.wfCheckAll.checked) {
        visible.forEach((wf) => {
          if (state.selectedWorkflowIds.size < MAX_BATCH) state.selectedWorkflowIds.add(wf.id);
        });
        if (visible.some(wf => !state.selectedWorkflowIds.has(wf.id))) {
          showToast(`Up to ${MAX_BATCH} workflow rules can be documented at a time. The first ${MAX_BATCH} are selected.`, 'warning');
        }
      } else {
        visible.forEach(wf => state.selectedWorkflowIds.delete(wf.id));
      }
      selectionChanged();
    });
    dom.wfTableBody.addEventListener('click', (e) => {
      // A rule's own document link opens the record; it does not select or unselect the row.
      const doc = e.target.closest('[data-open-doc]');
      if (doc) {
        e.preventDefault();
        openCrmRecord(logModuleApi('documents'), doc.dataset.openDoc);
        return;
      }
      const show = e.target.closest('[data-show-rule]');
      if (show) {
        e.preventDefault();
        showWorkflowRule(show.dataset.showRule);
        return;
      }
      const row = e.target.closest('tr[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      if (state.selectedWorkflowIds.has(id)) {
        state.selectedWorkflowIds.delete(id);
      } else if (state.selectedWorkflowIds.size >= MAX_BATCH) {
        showToast(`Up to ${MAX_BATCH} workflow rules can be documented at a time. Clear one first.`, 'warning');
        return;
      } else {
        state.selectedWorkflowIds.add(id);
      }
      selectionChanged();
    });
    dom.btnClearSelection.addEventListener('click', () => {
      state.selectedWorkflowIds.clear();
      selectionChanged();
    });
    dom.btnToReview.addEventListener('click', startReview);

    dom.reviewTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-review-id]');
      if (!tab) return;
      state.activeReviewId = tab.dataset.reviewId;
      renderReview();
    });
    dom.docTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-doc-id]');
      if (!tab) return;
      state.activeDocId = tab.dataset.docId;
      renderDocs();
    });
    bindFunctionReviewEvents();
    dom.btnRebuildPrompt.addEventListener('click', buildPrompt);
    dom.btnCopyPrompt.addEventListener('click', () => copyText(promptAsText(), dom.btnCopyPrompt, 'Copy prompt'));
    [dom.promptSystem, dom.promptUser].forEach(el => el.addEventListener('input', () => {
      const wf = activeReviewWorkflow();
      if (wf) state.prompts[wf.id] = { ...(state.prompts[wf.id] || {}), system: dom.promptSystem.value, user: dom.promptUser.value };
      updatePromptStats();
    }));
    dom.btnGenerate.addEventListener('click', generateDocument);
    dom.btnReviewDetails.addEventListener('click', () => openRuleView('details'));
    dom.btnViewDetails.addEventListener('click', () => openRuleView('details'));
    dom.btnViewDocument.addEventListener('click', () => openRuleView('document'));
    dom.btnCloseRuleDoc.addEventListener('click', closeRuleDoc);
    dom.ruleDocBackdrop.addEventListener('click', (e) => { if (e.target === dom.ruleDocBackdrop) closeRuleDoc(); });
    dom.ruleDocBody.addEventListener('click', (e) => {
      const zoom = e.target.closest('[data-fc-zoom]');
      if (!zoom) return;
      const id = zoom.dataset.fcZoom;
      const wf = state.reviewWorkflows.find(w => String(w.id) === id) || state.allWorkflowsList.find(w => String(w.id) === id);
      if (wf) openFlowchartViewer(wf);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dom.ruleDocBackdrop && !dom.ruleDocBackdrop.hidden) closeRuleDoc();
    });

    dom.btnCopyMd.addEventListener('click', () => copyText(activeDoc()?.generated?.markdown || '', dom.btnCopyMd, 'Copy text'));
    dom.btnDownloadMd.addEventListener('click', () => downloadMarkdown(activeDoc()));
    dom.btnDownloadPdf.addEventListener('click', () => downloadPdf(activeDoc()));
    dom.btnToSave.addEventListener('click', onSaveButton);
    dom.btnStartOver.addEventListener('click', startOver);
  }

  function initApp() {
    let started = false;
    const start = (embedded) => {
      if (started) return;
      started = true;
      state.isZohoEmbedded = embedded || hostedOnZohoStatic();
      runSetupCheck();
    };
    const sdkReady = typeof ZOHO !== 'undefined' && ZOHO.embeddedApp;
    if (!sdkReady) {
      start(false);
      return;
    }
    if (!hostedOnZohoStatic()) {
      let framed = true;
      try { framed = window.top !== window.self; } catch (_) { framed = true; }
      if (!framed) {
        start(false);
        return;
      }
    }
    ZOHO.embeddedApp.on('PageLoad', () => start(true));
    ZOHO.embeddedApp.init().catch(() => start(hostedOnZohoStatic()));
  }

  // ==========================================
  // SETUP CHECK (runs on every launch)
  // ==========================================
  const CHECKS = [
    { key: 'crm', title: 'Zoho CRM connection' },
    { key: 'settings', title: 'Saved settings' },
    { key: 'modules', title: 'Documentation modules' },
    { key: 'functions', title: 'AI functions and encrypted key store' },
    { key: 'model', title: 'AI provider' }
  ];

  function resetChecklist() {
    dom.setupChecklist.innerHTML = CHECKS.map(c => `
      <li class="waiting" data-check="${c.key}">
        <span class="check-icon"></span>
        <div><div class="check-title">${c.title}</div><div class="check-detail">Waiting</div></div>
      </li>`).join('');
  }

  function setCheck(key, status, detail) {
    const item = dom.setupChecklist.querySelector(`[data-check="${key}"]`);
    if (!item) return;
    item.className = status;
    const icons = { ok: ICON.check, warn: ICON.warn, error: ICON.cross };
    item.querySelector('.check-icon').innerHTML = icons[status] || '';
    item.querySelector('.check-detail').textContent = detail || '';
  }

  async function loadSettings() {
    let record = null;
    if (state.isZohoEmbedded) {
      try { record = await findExistingSettingsRecord(); } catch (_) { record = null; }
    }
    if (record) {
      state.settingsRecordId = record.id || null;
      state.settings.docsAgentConnection = record.Docs_Agent_Connection || state.settings.docsAgentConnection;
      state.settings.workdriveConnection = record.Workdrive_Connection || state.settings.workdriveConnection;
      state.settings.workdriveFolder = record.Workdrive_Folder_Id || state.settings.workdriveFolder;
      if (['admin', 'developer', 'client'].includes(record.Audience)) {
        state.audience = record.Audience;
        localStorage.setItem('livingdocs.audience', state.audience);
      }
      applyRecordAi(record);
    }
    refreshAiFromKeys();
    return { record };
  }

  function findCustomModule(modules, apiName) {
    const key = apiName.toLowerCase().replace(/_/g, '');
    return (modules || []).find((m) => [m.api_name, m.module_name, m.plural_label]
      .some(v => String(v || '').toLowerCase().replace(/[_\s]/g, '') === key)) || null;
  }

  function hasCustomModule(modules, apiName) {
    return !!findCustomModule(modules, apiName);
  }

  function setSetupSkeleton(on) {
    if (dom.setupSkeleton) {
      dom.setupSkeleton.hidden = !on;
      dom.setupSkeleton.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    if (dom.setupBody) dom.setupBody.hidden = !!on;
    if (dom.screenSetup) dom.screenSetup.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  async function runSetupCheck(manual) {
    // A reload with saved settings goes straight to the workflows. The checklist
    // is only shown when something required is missing, or when the admin asks.
    // Opening this page shows a skeleton of the verify layout until the check finishes.
    let verifyLoading = false;
    const showVerifySkeleton = () => {
      if (verifyLoading) return;
      verifyLoading = true;
      showScreen('setup');
      setSetupSkeleton(true);
    };
    if (manual) showVerifySkeleton();
    resetChecklist();
    dom.setupTitle.textContent = 'Checking your setup';
    dom.setupSubtitle.textContent = 'Confirming the Zoho CRM connection, saved settings and documentation modules before loading your workflows.';
    dom.setupForm.hidden = true;
    syncSetupActions();
    dom.btnSetupContinue.disabled = true;
    setBusy(dom.btnSetupRetry, true);

    let errors = 0;
    let warnings = 0;
    const fail = (key, detail) => {
      errors += 1;
      setCheck(key, 'error', detail);
      showVerifySkeleton();
    };
    const warn = (key, detail) => { warnings += 1; setCheck(key, 'warn', detail); };

    try {
      setCheck('settings', 'pending', 'Looking for the Living_Docs_Settings record');
      const { record } = await loadSettings();
      if (record) setCheck('settings', 'ok', `Loaded from Living_Docs_Settings record ${record.id}.`);
      else fail('settings', 'No Living_Docs_Settings record yet. Enter the details below and install.');
      // The rest of this check stays on the verify page, so its skeleton should match that page.
      if (!aiIsConfigured()) showVerifySkeleton();

      setCheck('crm', 'pending', `Calling GET /crm/v8/settings/modules with "${conn()}"`);
      let modules = [];
      if (!canUseZohoConnection()) {
        fail('crm', 'Open this widget from inside Zoho CRM. Live CRM data is only available there.');
        setOrg('Not inside Zoho CRM', 'error');
      } else {
        try {
          modules = await fetchCrmModules(conn());
          state.crmModules = modules;
          setCheck('crm', 'ok', `"${conn()}" is working. ${modules.filter(isScannableModule).length} modules are readable.`);
          setOrg('Zoho CRM connected', 'ok');
        } catch (err) {
          fail('crm', `"${conn()}" failed: ${err.message || err}`);
          setOrg('Connection problem', 'error');
        }
      }

      if (!modules.length) {
        fail('modules', 'Could not be checked until the CRM connection works.');
      } else {
        resolveLivingDocsModules(modules);
        const missing = LIVING_DOCS_MODULES.map(m => m.apiName).filter(name => !hasCustomModule(modules, name));
        if (missing.length) fail('modules', `Missing: ${missing.join(', ')}. Install creates them.`);
        else setCheck('modules', 'ok', 'Living_Docs_Settings and Living_Docs_Documents are installed.');
      }

      setCheck('functions', 'pending', `Calling ${LDF.GATEWAY_FN} and ${LDF.SAVE_FN}`);
      const fnCheck = await checkAiFunctions();
      if (fnCheck.status === 'ok') setCheck('functions', 'ok', fnCheck.detail);
      else if (fnCheck.status === 'warn') warn('functions', fnCheck.detail);
      else fail('functions', fnCheck.detail);

      const info = keyInfo(state.ai.provider);
      const workspaceNote = state.ai.provider === 'anthropic' && state.ai.workspaceId ? ` Workspace ${state.ai.workspaceId}.` : '';
      if (state.ai.provider && info.set) {
        setCheck('model', 'ok', `${aiName()} (${state.ai.model}). API key stored encrypted in CRM${info.hint ? `, ends in …${info.hint}` : ''}.${workspaceNote}`);
      } else if (state.ai.provider && fnCheck.status === 'error') {
        warn('model', `${aiName()} is selected. Its key can be saved once the AI functions are installed.`);
      } else if (state.ai.provider) {
        warn('model', `${aiName()} is selected but has no API key. Open the AI provider tab and paste it.`);
      } else {
        warn('model', 'No AI provider yet. Open the AI provider tab and add the Claude or Cursor API key.');
      }
    } finally {
      setBusy(dom.btnSetupRetry, false);
      setSetupSkeleton(false);
    }

    const aiMissing = !aiIsConfigured();
    if (errors || aiMissing) {
      showScreen('setup');
      dom.setupTitle.textContent = errors ? 'Finish setting up' : 'Add the AI provider';
      dom.setupSubtitle.textContent = errors
        ? 'Connection is tab 1. The AI provider is tab 2. Submit saves both on the Living Docs Settings record.'
        : 'Open the AI provider tab, choose Claude or Cursor, paste its API key, then Submit.';
      showSetupEditor(errors ? 1 : 2);
      dom.btnSetupContinue.disabled = errors > 0;
      return;
    }

    if (!manual) {
      enterFlow();
      return;
    }

    showScreen('setup');
    dom.btnSetupContinue.disabled = false;
    if (warnings) {
      dom.setupTitle.textContent = 'Ready, with notes';
      dom.setupSubtitle.textContent = 'You can continue now. The notes below only matter for later steps.';
    } else {
      dom.setupTitle.textContent = 'Everything is ready';
      dom.setupSubtitle.textContent = 'Continue to your workflows, or use Edit settings to change the connection or AI provider (for example the Claude workspace ID).';
    }
  }

  function showSetupTab(tab) {
    state.setupTab = tab === 2 ? 2 : 1;
    document.querySelectorAll('[data-setup-panel]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.setupPanel) !== state.setupTab;
    });
    document.querySelectorAll('[data-setup-tab]').forEach((btn) => {
      const on = Number(btn.dataset.setupTab) === state.setupTab;
      btn.classList.toggle('current', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    syncSetupActions();
  }

  function syncSetupActions() {
    const editing = Boolean(dom.setupForm && !dom.setupForm.hidden);
    const tab = state.setupTab || 1;
    if (dom.btnSetupBack) dom.btnSetupBack.hidden = !editing || tab !== 2;
    if (dom.btnSetupNext) dom.btnSetupNext.hidden = !editing || tab !== 1;
    if (dom.btnSetupInstall) dom.btnSetupInstall.hidden = !editing || tab !== 2;
    if (dom.btnSetupContinue) dom.btnSetupContinue.hidden = editing;
    const edit = $('btnSetupEdit');
    if (edit) edit.hidden = editing;
  }

  function showSetupEditor(tab) {
    dom.setupDocsConn.value = state.settings.docsAgentConnection;
    dom.setupWdConn.value = state.settings.workdriveConnection;
    dom.setupWdFolder.value = state.settings.workdriveFolder === 'folder_living_docs_crm' ? '' : state.settings.workdriveFolder;
    fillSetupAiForm();
    dom.setupForm.hidden = false;
    showSetupTab(tab || 1);
  }

  function appendSetupLog(message, type = 'info') {
    const line = document.createElement('div');
    line.className = `log-${type}`;
    line.textContent = `${new Date().toLocaleTimeString()}  ${stripEmoji(message)}`;
    dom.setupLog.appendChild(line);
    dom.setupLog.scrollTop = dom.setupLog.scrollHeight;
  }

  async function installAndVerify() {
    state.settings.docsAgentConnection = dom.setupDocsConn.value.trim() || 'docsagent_connection';
    state.settings.workdriveConnection = dom.setupWdConn.value.trim() || 'workdrive_connection';
    state.settings.workdriveFolder = dom.setupWdFolder.value.trim();
    captureSetupAi();

    dom.setupLogWrap.hidden = false;
    dom.setupLogWrap.open = true;
    dom.setupLog.innerHTML = '';
    setBusy(dom.btnSetupInstall, true);
    try {
      if (canUseZohoConnection()) {
        // Modules first: the gateway writes its daily counter to Living_Docs_Settings.
        const provisioned = await autoProvisionCustomModules(false, appendSetupLog);
        if (provisioned && provisioned.ok) {
          const fns = await installAiFunctions(appendSetupLog);
          if (fns.ok) await storeKeys(appendSetupLog);
        }
        const saved = await saveSettingsRecord(appendSetupLog);
        if (saved.ok) {
          appendSetupLog(`${saved.action === 'created' ? 'Created' : 'Updated'} settings record ${saved.id || ''}. It holds no API keys.`, 'ok');
          if (state.clearLegacyKeys) {
            const stillOnModule = LEGACY_SETTINGS_KEY_FIELDS.some(spec => !state.removedSettingsKeyFields?.[spec.api]);
            if (stillOnModule) appendSetupLog('The old plain-text key fields on Living_Docs_Settings are now empty.', 'ok');
            state.legacyKeys = { anthropic: '', cursor: '' };
            state.clearLegacyKeys = false;
          }
        } else {
          appendSetupLog(`Settings were not saved: ${saved.message || 'Could not write the settings row.'}`, 'warn');
          showToast(`Settings were not saved: ${saved.message || 'unknown error'}`, 'error');
        }
        renderSettingsRecordStatus();
      } else {
        appendSetupLog('Not running inside Zoho CRM, so modules cannot be installed from here.', 'warn');
      }
    } catch (err) {
      appendSetupLog(`Install stopped: ${err.message || err}`, 'error');
    } finally {
      state.pendingKeys = { anthropic: '', cursor: '' };
      dom.setupAiClaudeKey.value = '';
      dom.setupAiCursorKey.value = '';
      setBusy(dom.btnSetupInstall, false);
    }
    await runSetupCheck();
  }

  // Referenced by autoProvisionCustomModules after the settings row is written.
  function renderSettingsRecordStatus() {
    if (!dom.settingsRecordNote) return;
    dom.settingsRecordNote.textContent = state.settingsRecordId
      ? `Stored in Living_Docs_Settings record ${state.settingsRecordId}. Saving updates that record.`
      : 'Saving creates the Living_Docs_Settings record.';
  }

  function enterFlow() {
    if (dom.screenFlow.classList.contains('active')) return;
    showScreen('flow');
    goToStep(1);
    scanCrm(false);
  }

  // ==========================================
  // STEPPER
  // ==========================================
  function goToStep(step) {
    if (step > state.maxStep) return;
    state.step = step;
    document.querySelectorAll('.step-panel').forEach(p => p.classList.toggle('active', p.id === `step${step}`));
    renderStepper();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function limitSteps(max) {
    state.maxStep = max;
    renderStepper();
  }

  function renderStepper() {
    dom.stepper.querySelectorAll('li[data-step]').forEach((item) => {
      const step = Number(item.dataset.step);
      const done = step < state.maxStep && step !== state.step;
      item.classList.toggle('current', step === state.step);
      item.classList.toggle('done', done);
      item.classList.toggle('reachable', step <= state.maxStep && step !== state.step);
      item.querySelector('.num').innerHTML = done ? ICON.check.replace('<svg ', '<svg width="12" height="12" ') : String(step);
    });
  }

  // ==========================================
  // DOCUMENTATION LOG (Living_Docs_Documents)
  // ==========================================
  const LOG_TEXT_LIMIT = 30000;

  function zohoDateTime(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return zohoDateTime();
    const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
  }

  async function sourceHash(source) {
    const text = String(source || '').replace(/\s+/g, '');
    if (window.crypto?.subtle && window.TextEncoder) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `fnv-${h.toString(16)}-${text.length}`;
  }

  async function currentUserInfo() {
    if (state.currentUser) return state.currentUser;
    let user = null;
    if (typeof ZOHO !== 'undefined' && ZOHO.CRM?.CONFIG?.getCurrentUser) {
      const resp = await withTimeout(ZOHO.CRM.CONFIG.getCurrentUser(), 4000, null);
      user = resp?.users?.[0] || (resp?.full_name || resp?.email ? resp : null);
    }
    state.currentUser = {
      id: user?.id ? String(user.id) : '',
      name: user?.full_name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || '',
      email: user?.email || ''
    };
    return state.currentUser;
  }

  function userLabel(u) {
    if (!u || (!u.name && !u.email)) return 'Unknown user';
    return u.name && u.email ? `${u.name} (${u.email})` : (u.name || u.email);
  }

  function canWriteRecords() {
    return state.isZohoEmbedded && typeof ZOHO !== 'undefined' && !!ZOHO.CRM?.API?.insertRecord;
  }

  async function fetchAllRecords(entity, maxPages = 5) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const resp = await ZOHO.CRM.API.getAllRecords({ Entity: entity, sort_order: 'desc', per_page: 200, page });
      const rows = Array.isArray(resp?.data) ? resp.data : [];
      out.push(...rows);
      if (rows.length < 200 || !resp?.info?.more_records) break;
    }
    return out;
  }

  function splitModules(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function recordTime(rec, field) {
    return new Date(rec[field] || rec.Created_Time || 0).getTime() || 0;
  }

  async function loadDocLogs() {
    if (!canWriteRecords()) {
      state.docLog = { ok: false, byItem: {}, byFunction: {}, byModule: {}, records: [] };
      return;
    }
    let docs = [];
    let error = '';
    try {
      docs = await fetchAllRecords(logModuleApi('documents'));
    } catch (err) {
      error = describeSdkError(err);
    }
    const byItem = {};
    const byFunction = {};
    const byModule = {};
    const newer = (current, rec) => !current || Number(rec.version || 0) >= Number(current.version || 0);
    docs.slice().sort((a, b) => recordTime(a, 'Generated_At') - recordTime(b, 'Generated_At')).forEach((rec) => {
      const id = String(rec.Item_Id || '');
      const at = rec.Generated_At || rec.Created_Time;
      // Older installs also wrote one record per function; those only feed the change check.
      if (rec.Item_Type === 'Function') {
        const entry = { version: rec.Doc_Version, at, hash: rec.Source_Hash || '' };
        if (id && newer(byFunction[id], entry)) byFunction[id] = entry;
        return;
      }
      if (id && (!byItem[id] || Number(rec.Doc_Version || 0) >= Number(byItem[id].Doc_Version || 0))) byItem[id] = rec;
      parseFunctionHashes(rec.Related_Items).forEach(({ key, hash }) => {
        const entry = { version: rec.Doc_Version, at, hash };
        if (newer(byFunction[key], entry)) byFunction[key] = entry;
      });
      splitModules(rec.CRM_Module).forEach((mod) => {
        const g = byModule[mod] || { count: 0, last: null };
        g.count += 1;
        if (!g.last || recordTime(rec, 'Generated_At') >= recordTime(g.last, 'Generated_At')) g.last = rec;
        byModule[mod] = g;
      });
    });
    state.docLog = { ok: !error, error, byItem, byFunction, byModule, records: docs };
    // The tables show the latest version and the link to it, so they follow every reload of the log.
    if (state.allWorkflowsList.length) {
      renderModuleTable();
      renderWorkflowTable();
    }
  }

  // Related_Items on a workflow record lists its functions, one per line: "name [key] sha256:hash".
  function functionHashLine(fn, hash) {
    return `${fn.api_name || fn.name || 'function'} [${fnKey(fn)}] sha256:${hash}`;
  }

  function parseFunctionHashes(text) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
      const m = /\[([^\]]+)\]\s+sha256:(\S+)/.exec(line);
      if (m) out.push({ key: m[1], hash: m[2] });
    });
    return out;
  }

  function insertResults(resp, count) {
    const rows = Array.isArray(resp?.data) ? resp.data : [];
    return Array.from({ length: count }, (_, i) => {
      const row = rows[i] || {};
      const ok = row.code === 'SUCCESS' || row.status === 'success';
      return { ok, id: row.details?.id || null, message: ok ? 'Saved' : (row.message || row.code || 'CRM did not confirm the record') };
    });
  }

  function clip(text, limit = LOG_TEXT_LIMIT) {
    const s = String(text || '');
    return s.length > limit ? `${s.slice(0, limit - 40)}\n… cut off, ${s.length - limit + 40} more characters` : s;
  }

  // A function whose code differs from the last documented version was edited somewhere else, e.g. in the Zoho editor.
  async function detectExternalChanges(workflows) {
    if (!canWriteRecords() || !state.docLog?.ok) return;
    for (const fn of uniqueFunctions(workflows)) {
      const r = fnReview(fn);
      const doc = state.docLog.byFunction[fnKey(fn)];
      r.docInfo = doc ? { version: doc.version, at: doc.at } : null;
      r.externalChange = null;
      if (!doc || !doc.hash) continue;
      const hash = await sourceHash(fn.source);
      if (hash === doc.hash) continue;
      r.externalChange = { version: doc.version, at: fn.modified_time || '', by: fn.modified_by || '' };
      rerenderFnCard(fn);
    }
    renderModuleTable();
  }

  async function writeDocRecord(entity, row, existingId) {
    try {
      const resp = existingId
        ? await ZOHO.CRM.API.updateRecord({ Entity: entity, APIData: { id: existingId, ...row }, Trigger: [] })
        : await ZOHO.CRM.API.insertRecord({ Entity: entity, APIData: row, Trigger: [] });
      const [res] = insertResults(resp, 1);
      return { ...res, id: res.id || existingId || null };
    } catch (err) {
      return { ok: false, id: null, message: describeSdkError(err?.data?.[0] || err) };
    }
  }

  async function attachPdfToRecord(entity, recordId, file) {
    try {
      const resp = await ZOHO.CRM.API.attachFile({ Entity: entity, RecordID: recordId, File: { Name: file.name, Content: file } });
      const row = Array.isArray(resp?.data) ? resp.data[0] : resp;
      const ok = row?.code === 'SUCCESS' || row?.status === 'success';
      return { ok, message: ok ? '' : (row?.message || row?.code || 'CRM did not confirm the attachment') };
    } catch (err) {
      return { ok: false, message: describeSdkError(err?.data?.[0] || err) };
    }
  }

  async function logDocumentation(doc, pdfBytes) {
    if (!canWriteRecords()) return { ok: false, rows: [], message: 'Records are only written inside Zoho CRM. Use Download PDF to keep the file.' };
    await loadDocLogs().catch(() => null);
    if (!state.docLog.ok) {
      return { ok: false, rows: [], message: `${logModuleApi('documents')} could not be read (${state.docLog.error || 'unknown error'}). Run Install from the setup check.` };
    }
    const g = doc.generated;
    const entity = logModuleApi('documents');
    g.savedRecords = g.savedRecords || {};
    // The saved version wins over the one guessed at generation time (another user may have saved in between).
    const savedVersion = g.savedRecords[String(doc.wf.id)]?.version;
    const version = savedVersion || nextDocVersion(doc.wf);
    if (version !== g.version) {
      g.version = version;
      g.fileName = documentFileName(doc.wf, version, g.at);
      g.pdfBytes = null;
      pdfBytes = await docPdfBytes(doc);
    }
    const pdfFile = new File([pdfBytes], g.fileName, { type: 'application/pdf' });
    const user = await currentUserInfo();
    const base = {
      File_Name: g.fileName,
      Generated_By: g.generatedBy || aiName(),
      Generated_At: zohoDateTime(g.at),
      Generated_By_User: userLabel(user),
      Audience: state.audience
    };
    const items = [];
    for (const wf of [doc.wf]) {
      const itemId = String(wf.id);
      const fns = wf.function_code || [];
      const hashLines = [];
      const snapshots = [];
      let masked = 0;
      for (const fn of fns) {
        if (!fn.source) {
          hashLines.push(`${fn.api_name || fn.name || 'function'} [${fnKey(fn)}] (code not loaded)`);
          continue;
        }
        const r = fnReview(fn).result ? fnReview(fn) : runFnReview(fn);
        hashLines.push(functionHashLine(fn, await sourceHash(fn.source)));
        masked += r.result.mask.entries.length;
        if (!fn.source_truncated) snapshots.push(`// ===== ${fn.api_name || fn.name} =====\n${r.result.mask.masked}`);
      }
      items.push({
        label: wf.name, type: 'Workflow', version,
        existingId: state.docLog.byItem[itemId]?.id || null,
        row: {
          ...base,
          Name: String(wf.name).slice(0, 120),
          Item_Type: 'Workflow', CRM_Module: wf.module || '', Item_Name: wf.name, Item_Id: itemId,
          Doc_Version: version,
          Related_Items: clip(hashLines.join('\n'), 2000),
          Masked_Values: masked,
          Source_Hash: await sourceHash(fns.map(f => f.source || '').join('\n')),
          Source_Snapshot: clip(snapshots.join('\n\n'))
        }
      });
    }
    // One record per workflow: later versions update it and add their PDF as another attachment.
    // A retry after a partial failure reuses the record this document already wrote.
    const rows = [];
    for (const item of items) {
      const prev = g.savedRecords[item.row.Item_Id];
      let action = prev ? prev.action : (item.existingId ? 'Updated' : 'Created');
      let res = prev ? { ok: true, id: prev.id } : await writeDocRecord(entity, item.row, item.existingId);
      // Only create a fresh record when the old one is really gone; other failures must not add a second record.
      if (!prev && !res.ok && item.existingId && /not.?found|invalid.?id|INVALID_DATA|deleted|does not exist/i.test(res.message || '')) {
        res = await writeDocRecord(entity, item.row, null);
        action = 'Created';
      }
      if (res.ok && res.id && !prev) g.savedRecords[item.row.Item_Id] = { id: res.id, version: item.version, action, attached: false };
      const saved = g.savedRecords[item.row.Item_Id];
      const attach = !res.ok || !res.id ? { ok: false, message: res.message }
        : saved.attached ? { ok: true, message: '' }
          : await attachPdfToRecord(entity, res.id, pdfFile);
      if (saved && attach.ok) saved.attached = true;
      rows.push({
        label: item.label,
        type: item.type,
        version: saved ? saved.version : item.version,
        action,
        id: res.id,
        ok: res.ok && attach.ok,
        saved: res.ok,
        attached: attach.ok,
        message: res.ok ? attach.message : res.message
      });
    }
    await loadDocLogs().catch(() => null);
    renderModuleTable();
    const failed = rows.filter(r => !r.ok);
    return { ok: !failed.length, rows, entity, message: failed.length ? `${failed[0].label}: ${failed[0].message}` : '' };
  }

  // ==========================================
  // STEP 1: OVERVIEW
  // ==========================================
  const LAST_SCAN_KEY = 'livingdocs.lastScan';

  function setKpisLoading(loading) {
    document.querySelectorAll('.kpi-card').forEach(card => card.classList.toggle('loading', loading));
  }

  function renderKpi(id, value, previous, fallbackSub) {
    const card = $(id);
    card.classList.remove('loading');
    card.querySelector('.kpi-value').textContent = Number(value || 0).toLocaleString();
    const delta = card.querySelector('.kpi-delta');
    const sub = card.querySelector('.kpi-sub');
    if (previous == null) {
      delta.className = 'kpi-delta';
      delta.innerHTML = '';
      sub.textContent = fallbackSub;
      return;
    }
    const diff = value - previous;
    if (diff === 0) {
      delta.className = 'kpi-delta flat';
      delta.textContent = 'No change';
    } else {
      const pct = previous ? Math.abs((diff / previous) * 100) : 100;
      delta.className = `kpi-delta ${diff > 0 ? 'up' : 'down'}`;
      delta.innerHTML = `${diff > 0 ? ICON.up : ICON.down} ${pct.toFixed(1)}%`;
    }
    sub.textContent = `vs. ${Number(previous).toLocaleString()} last scan`;
  }

  function renderKpis() {
    const modules = state.crmModules.filter(isScannableModule).length;
    const workflows = state.allWorkflowsList.length;
    const functions = (state.functionCatalog || []).length;
    const active = state.allWorkflowsList.filter(wf => wf.status === 'active').length;
    const withFn = state.allWorkflowsList.filter(wf => wf.fnCount > 0).length;

    let previous = null;
    try { previous = JSON.parse(localStorage.getItem(`${LAST_SCAN_KEY}.${conn()}`) || 'null'); } catch (_) { previous = null; }
    const prev = (key) => (previous && typeof previous[key] === 'number' ? previous[key] : null);

    renderKpi('kpiModules', modules, prev('modules'), 'Readable through the CRM connection');
    renderKpi('kpiWorkflows', workflows, prev('workflows'), `${withFn} call a custom function`);
    renderKpi('kpiFunctions', functions, prev('functions'), state.functionCatalogError ? 'Function list could not be read' : 'Deluge and other runtimes');
    renderKpi('kpiActive', active, prev('active'), workflows ? `${Math.round((active / workflows) * 100)}% of all rules` : 'No rules yet');

    localStorage.setItem(`${LAST_SCAN_KEY}.${conn()}`, JSON.stringify({ modules, workflows, functions, active, at: Date.now() }));
  }

  function moduleLabel(apiName) {
    const mod = state.crmModules.find(m => m.api_name === apiName);
    return (mod && (mod.plural_label || mod.singular_label)) || apiName;
  }

  function renderModuleTable() {
    const groups = new Map();
    state.allWorkflowsList.forEach((wf) => {
      const key = wf.module || 'Unknown';
      const g = groups.get(key) || { module: key, rules: 0, active: 0, withFn: 0 };
      g.rules += 1;
      if (wf.status === 'active') g.active += 1;
      if (wf.fnCount > 0) g.withFn += 1;
      groups.set(key, g);
    });
    const rows = [...groups.values()].sort((a, b) => b.rules - a.rules);
    const logReady = state.docLog && state.docLog.ok;
    dom.moduleTableBody.innerHTML = rows.length ? rows.map((g) => {
      const label = moduleLabel(g.module);
      const doc = logReady ? state.docLog.byModule[g.module] : null;
      // One line per cell so every row has the same height; the longer text is in the tooltip.
      const master = logReady ? state.docLog.byItem[moduleDocItemId(g.module)] : null;
      const docCell = !state.docLog ? '<span class="muted small">Loading…</span>'
        : !logReady ? '<span class="muted small">Log not available</span>'
          : master && master.id ? `<span class="cell-line">${docRecordLink(master)}<span class="cell-api">${escapeHtml(formatDate(master.Generated_At || master.Created_Time))}</span></span>`
          : doc ? `<span class="cell-line" title="${escapeHtml(`${doc.last.Item_Name || ''} · v${doc.last.Doc_Version || 1}`)}"><span class="cell-title">${escapeHtml(formatDate(doc.last.Generated_At || doc.last.Created_Time))}</span><span class="cell-api">v${escapeHtml(doc.last.Doc_Version || 1)} · ${plural(doc.count, 'record')}</span></span>`
            : '<span class="muted small">Not documented yet</span>';
      return `
      <tr class="clickable" data-module="${escapeHtml(g.module)}">
        <td><span class="cell-line" title="${escapeHtml(g.module)}"><span class="cell-title">${escapeHtml(label)}</span>${label !== g.module ? `<span class="cell-api">${escapeHtml(g.module)}</span>` : ''}</span></td>
        <td class="num">${g.rules}</td>
        <td class="num">${g.active}</td>
        <td class="num">${g.withFn}</td>
        <td>${docCell}</td>
        <td class="chevron">${ICON.chevron}</td>
      </tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="6">No workflow rules were returned by Zoho CRM.</td></tr>';
  }

  async function scanCrm(force) {
    if (!canUseZohoConnection()) {
      showToast('Open this widget inside Zoho CRM to load live data.', 'warning');
      return;
    }
    if (state.scanning) return;
    state.scanning = true;
    setBusy(dom.btnRescan, true);
    setKpisLoading(true);
    dom.scanStatus.textContent = 'Loading modules, workflow rules and functions from Zoho CRM…';
    dom.moduleTableBody.innerHTML = `<tr class="empty-row"><td colspan="6">${loadingBlock('Reading workflow rules…')}</td></tr>`;

    const docsConn = conn();
    const [modulesRes, rulesRes, catalogRes, orgRes] = await Promise.allSettled([
      state.crmModules.length && !force ? Promise.resolve(state.crmModules) : fetchCrmModules(docsConn),
      fetchAllWorkflowRulePages(docsConn).then(rules => enrichWorkflowRules(docsConn, rules)),
      fetchFunctionCatalog(docsConn),
      fetchOrgLabel(docsConn),
      loadDocLogs().catch(err => console.warn('[Living Docs] logs', err))
    ]);

    if (modulesRes.status === 'fulfilled') state.crmModules = modulesRes.value || [];
    if (catalogRes.status === 'fulfilled') {
      state.functionCatalog = catalogRes.value || [];
      state.functionCatalogError = '';
    } else {
      state.functionCatalog = [];
      state.functionCatalogError = catalogRes.reason?.message || String(catalogRes.reason);
    }
    if (orgRes.status === 'fulfilled' && orgRes.value) setOrg(orgRes.value, 'ok');

    if (rulesRes.status === 'fulfilled') {
      state.allWorkflowsList = normalizeZohoWorkflows(rulesRes.value || []).map(wf => ({ ...wf, fnCount: collectFunctionActions(wf).length }));
      renderKpis();
      renderModuleTable();
      populateModuleFilter();
      renderWorkflowTable();
      dom.scanStatus.textContent = '';
      if (state.maxStep < 2) limitSteps(2);
    } else {
      setKpisLoading(false);
      const message = rulesRes.reason?.message || String(rulesRes.reason);
      dom.scanStatus.textContent = 'Workflow rules could not be loaded.';
      dom.moduleTableBody.innerHTML = `<tr class="empty-row"><td colspan="6">${escapeHtml(message)}<br><span class="small">Check ZohoCRM.settings.workflow_rules.READ on "${escapeHtml(docsConn)}".</span></td></tr>`;
      showToast(message, 'error');
    }
    if (state.functionCatalogError) {
      showToast(`Function list failed: ${state.functionCatalogError}. Add ZohoCRM.settings.functions.READ.`, 'warning');
    }
    setBusy(dom.btnRescan, false);
    state.scanning = false;
  }

  // ==========================================
  // STEP 2: SELECT WORKFLOWS
  // ==========================================
  function populateModuleFilter() {
    const current = dom.wfModuleFilter.value;
    const modules = [...new Set(state.allWorkflowsList.map(wf => wf.module).filter(Boolean))].sort();
    dom.wfModuleFilter.innerHTML = '<option value="ALL">All modules</option>' +
      modules.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(moduleLabel(m))}</option>`).join('');
    if (modules.includes(current)) dom.wfModuleFilter.value = current;
  }

  function visibleWorkflows() {
    const q = dom.wfSearch.value.trim().toLowerCase();
    const mod = dom.wfModuleFilter.value;
    const status = dom.wfStatusFilter.value;
    const fnOnly = dom.wfFunctionsOnly.checked;
    return state.allWorkflowsList.filter((wf) => {
      if (mod !== 'ALL' && wf.module !== mod) return false;
      if (status !== 'ALL' && wf.status !== status) return false;
      if (fnOnly && !wf.fnCount) return false;
      if (!q) return true;
      return [wf.name, wf.criteria, (wf.actions || []).join(' '), wf.module].join(' ').toLowerCase().includes(q);
    });
  }

  function renderWorkflowTable() {
    const rows = visibleWorkflows();
    dom.wfTableBody.innerHTML = rows.length ? rows.map((wf) => {
      const selected = state.selectedWorkflowIds.has(wf.id);
      const actionCount = (wf.actions || []).length;
      return `
        <tr data-id="${escapeHtml(wf.id)}" class="${selected ? 'selected' : ''}">
          <td class="col-check"><input type="checkbox" ${selected ? 'checked' : ''} tabindex="-1" /></td>
          <td>
            <div class="cell-title">${escapeHtml(wf.name)}</div>
            <div class="cell-sub">${escapeHtml(wf.criteria || 'No criteria, runs on every matching record')}</div>
          </td>
          <td>${escapeHtml(moduleLabel(wf.module))}</td>
          <td>${escapeHtml(triggerLabel(wf.trigger_type))}</td>
          <td>
            <span class="muted">${actionCount} action${actionCount === 1 ? '' : 's'}</span>
            ${wf.fnCount ? `<span class="pill pill-blue">${wf.fnCount} function${wf.fnCount === 1 ? '' : 's'}</span>` : ''}
          </td>
          <td>${wf.status === 'active' ? '<span class="pill pill-green">Active</span>' : '<span class="pill pill-gray">Inactive</span>'}</td>
          <td>${workflowDocCell(wf)}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-show-rule="${escapeHtml(wf.id)}">Show workflow rule</button></td>
        </tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="8">No workflow rules match these filters.</td></tr>';
    updateSelectionUI(rows);
    renderModuleDocButton();
  }

  // A rule's own document gets the version and a link to its record. A rule covered only by its module's
  // master document shows "Documented"; that record's link is on the module row in the overview.
  function workflowDocCell(wf) {
    if (!state.docLog) return '<span class="muted small">Checking…</span>';
    if (!state.docLog.ok) return '<span class="muted small">Not available</span>';
    const own = state.docLog.byItem[String(wf.id)];
    if (own && own.id) return docRecordLink(own);
    const master = state.docLog.byItem[moduleDocItemId(wf.module)];
    if (master) {
      const when = formatDate(master.Generated_At || master.Created_Time);
      return `<span class="pill pill-green" title="${escapeHtml(`In the ${moduleLabel(wf.module)} master document, v${master.Doc_Version || 1}${when ? ` · ${when}` : ''}`)}">Documented</span>`;
    }
    return '<span class="muted small">Not documented</span>';
  }

  // Version badge plus "Open in CRM"; opens the Living_Docs_Documents record.
  function docRecordLink(rec) {
    const when = formatDate(rec.Generated_At || rec.Created_Time);
    return `<button type="button" class="doc-link" data-open-doc="${escapeHtml(rec.id)}" title="Open the documentation record in Zoho CRM${when ? ` (${escapeHtml(when)})` : ''}">
        <span class="pill pill-green">v${escapeHtml(rec.Doc_Version || 1)}</span>
        <span>Open in CRM</span>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>`;
  }

  function renderModuleDocButton() {
    const btn = $('btnModuleDoc');
    if (!btn) return;
    const mod = dom.wfModuleFilter.value;
    const count = mod && mod !== 'ALL' ? state.allWorkflowsList.filter(wf => wf.module === mod).length : 0;
    btn.hidden = !count;
    if (count && !btn.classList.contains('is-busy')) btn.textContent = `Generate ${moduleLabel(mod)} document (${plural(count, 'rule')})`;
  }

  function updateSelectionUI(rows) {
    const count = state.selectedWorkflowIds.size;
    dom.selectedCountPill.textContent = `${count} of ${MAX_BATCH} selected`;
    dom.btnToReview.disabled = count === 0;
    dom.btnToReview.textContent = count ? `Review ${count} selected` : 'Review selected';
    const visible = rows || visibleWorkflows();
    const picked = visible.filter(wf => state.selectedWorkflowIds.has(wf.id)).length;
    dom.wfCheckAll.checked = visible.length > 0 && picked === visible.length;
    dom.wfCheckAll.indeterminate = picked > 0 && picked < visible.length;
  }

  function selectionChanged() {
    state.docs = [];
    state.prompts = {};
    state.moduleRun = null;
    if (state.maxStep > 2) limitSteps(2);
    renderWorkflowTable();
  }

  // ==========================================
  // STEP 3: REVIEW CRITERIA AND CODE
  // ==========================================
  async function loadWorkflowsWithFunctionCode(workflows) {
    const hydrated = await Promise.all(workflows.map(wf => hydrateWorkflowRecord(wf)));
    return attachFunctionCodeToWorkflows(hydrated);
  }

  async function loadFieldsForModules(workflows) {
    const modules = [...new Set(workflows.map(wf => wf.module).filter(Boolean))].filter(m => !state.moduleFields[m]);
    await Promise.all(modules.map(async (mod) => {
      const fields = await fetchModuleFields(conn(), mod);
      state.moduleFields[mod] = fields.map(f => ({
        api_name: f.api_name,
        label: f.field_label || f.display_label || f.api_name,
        data_type: f.data_type
      }));
    }));
  }

  function promptSnapshot() {
    return {
      modules: Object.entries(state.moduleFields).map(([module, fields]) => ({ module, fields })),
      stats: {}
    };
  }

  async function startReview() {
    const selected = state.allWorkflowsList.filter(wf => state.selectedWorkflowIds.has(wf.id)).slice(0, MAX_BATCH);
    if (!selected.length) return;
    state.docs = [];
    state.prompts = {};
    state.moduleRun = null;
    state.reviewDocMode = 'details';
    limitSteps(3);
    goToStep(3);
    state.reviewWorkflows = [];
    dom.btnGenerate.disabled = true;
    dom.reviewTabs.innerHTML = '';
    dom.promptSystem.value = '';
    dom.promptUser.value = '';
    updatePromptStats();
    dom.reviewStatus.textContent = `Loading ${selected.length} rule${selected.length === 1 ? '' : 's'} and downloading function code…`;
    dom.reviewBody.innerHTML = loadingBlock('Processing…');
    try {
      const loaded = await loadWorkflowsWithFunctionCode(selected);
      await loadFieldsForModules(loaded).catch(() => null);
      state.reviewWorkflows = loaded;
      state.activeReviewId = loaded[0] && loaded[0].id;
      reviewFunctions(loaded);
      renderReview();
      loadDocLogs().then(() => detectExternalChanges(loaded)).catch(err => console.warn('[Living Docs] change detection', err));
      await buildPrompt();
    } catch (err) {
      dom.reviewStatus.textContent = 'The rules could not be loaded.';
      dom.reviewBody.innerHTML = `<div class="notice error">${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  function functionSummary(workflows) {
    const all = (workflows || []).flatMap(wf => wf.function_code || []);
    return { total: all.length, withSource: all.filter(fn => fn.source).length };
  }

  function actionCard(action, delay) {
    if (typeof action === 'string') {
      const split = action.indexOf(':');
      const kind = /function/i.test(action) ? 'fn' : /field/i.test(action) ? 'field' : /email/i.test(action) ? 'email' : 'other';
      if (split > 0) return { title: action.slice(split + 1).trim() || action, meta: action.slice(0, split).trim(), kind };
      return { title: action, meta: '', kind };
    }
    const typeRaw = action.type || action.action_type || '';
    const type = actionTypeLabel(typeRaw);
    const title = action.name || action.action_name || type;
    const timing = delay || (/function/i.test(typeRaw) ? 'Instant action' : 'Instant');
    const kind = /function/i.test(typeRaw) ? 'fn' : /field/i.test(typeRaw) ? 'field' : /email/i.test(typeRaw) ? 'email' : 'other';
    return { title, meta: `${type} · ${timing}`, kind };
  }

  function ruleBranches(wf) {
    const conditions = Array.isArray(wf.conditions) ? wf.conditions : [];
    if (!conditions.length) {
      return [{
        title: 'Condition 1',
        criteria: displayCriteria(readableCriteria(wf.criteria) || 'No criteria. Runs for every record that matches the trigger.'),
        actions: (wf.actions || []).map(a => actionCard(a))
      }];
    }
    return conditions.map((c, i) => {
      const raw = formatCriteria(c.criteria_details && c.criteria_details.criteria);
      const instant = (c.instant_actions && c.instant_actions.actions) || [];
      const scheduled = Array.isArray(c.scheduled_actions) ? c.scheduled_actions : [];
      const actions = instant.map(a => actionCard(a))
        .concat(scheduled.flatMap(g => (g.actions || []).map(a => actionCard(a, scheduleLabel(g)))));
      return {
        title: `Condition ${c.sequence_number || i + 1}`,
        criteria: displayCriteria(readableCriteria(raw) || 'No criteria. Runs for every record that matches the trigger.'),
        actions: actions.length ? actions : (wf.actions || []).map(a => actionCard(a))
      };
    });
  }

  // ---------- Flowchart ----------
  // Inline SVG so the screen and the PDF (html2canvas) draw the same shapes. Colours and fonts are attributes,
  // not CSS, because html2canvas renders the SVG as an image without the page styles.
  // Standard flowchart colours: green start/done, red stop, amber decision, process boxes coloured by action type.
  const FC = {
    width: 660, cx: 330, yesX: 120, noX: 540,
    diamondW: 300, boxW: 204, pillH: 36, gap: 26,
    line: '#64748b', yes: '#16a34a', no: '#dc2626',
    font: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
    start: { fill: '#dcfce7', stroke: '#16a34a', text: '#14532d' },
    done: { fill: '#dcfce7', stroke: '#16a34a', text: '#14532d' },
    stop: { fill: '#fee2e2', stroke: '#dc2626', text: '#7f1d1d' },
    decision: { fill: '#fef3c7', stroke: '#d97706', text: '#78350f', muted: '#92400e' },
    kinds: {
      fn: { label: 'Function', fill: '#ede9fe', stroke: '#7c3aed', text: '#4c1d95', muted: '#6d28d9' },
      field: { label: 'Field update', fill: '#dbeafe', stroke: '#2563eb', text: '#1e3a8a', muted: '#1d4ed8' },
      email: { label: 'Email', fill: '#ccfbf1', stroke: '#0d9488', text: '#134e4a', muted: '#0f766e' },
      other: { label: 'Other action', fill: '#f1f5f9', stroke: '#64748b', text: '#1e293b', muted: '#475569' }
    }
  };
  let fcSeq = 0;

  function fcWrap(value, max, maxLines) {
    const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    let cut = false;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length <= max) { line = next; continue; }
      if (line) lines.push(line);
      if (lines.length === maxLines) { cut = true; line = ''; break; }
      line = word.length > max ? `${word.slice(0, max - 1)}…` : word;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines.length = maxLines; cut = true; }
    if (cut) lines[maxLines - 1] = `${lines[maxLines - 1].replace(/…$/, '').slice(0, max - 1)}…`;
    return lines.length ? lines : [''];
  }

  // width: draw the SVG at this many pixels wide (the PDF); the layout stays the same and is scaled by viewBox.
  function renderFlowchart(wf, { width = FC.width } = {}) {
    const id = `fc${++fcSeq}`;
    const parts = [];
    const text = (x, y, value, { size = 12, weight = 400, color = '#1e293b', anchor = 'middle' } = {}) =>
      parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeHtml(value)}</text>`);
    // tone: 'line' | 'yes' | 'no'; each has its own arrowhead so the head matches the line.
    const path = (points, tone = 'line') =>
      parts.push(`<polyline points="${points.map(p => p.join(',')).join(' ')}" fill="none" stroke="${FC[tone]}" stroke-width="1.6" stroke-linejoin="round" marker-end="url(#${id}-${tone})"/>`);
    // Terminal: Start, Done, Stop.
    const pill = (x, y, label, look) => {
      const w = Math.min(230, Math.max(110, label.length * 7.4 + 44));
      parts.push(`<rect x="${x - w / 2}" y="${y}" width="${w}" height="${FC.pillH}" rx="${FC.pillH / 2}" fill="${look.fill}" stroke="${look.stroke}" stroke-width="1.6"/>`);
      text(x, y + 22.5, label, { size: 13, weight: 700, color: look.text });
      return y + FC.pillH;
    };
    // Process step: one workflow action, coloured by its type.
    const box = (x, y, action) => {
      const look = FC.kinds[action.kind] || FC.kinds.other;
      const titleLines = fcWrap(action.title, 28, 2);
      const metaLines = action.meta ? fcWrap(action.meta, 34, 2) : [];
      const h = 18 + titleLines.length * 17 + metaLines.length * 15;
      const left = x - FC.boxW / 2;
      parts.push(`<rect x="${left}" y="${y}" width="${FC.boxW}" height="${h}" rx="8" fill="${look.fill}" stroke="${look.stroke}" stroke-width="1.6"/>`);
      // Coloured strip on the left edge, the usual marker for the step type.
      parts.push(`<rect x="${left}" y="${y}" width="6" height="${h}" rx="3" fill="${look.stroke}"/>`);
      titleLines.forEach((l, i) => text(x + 3, y + 23 + i * 17, l, { size: 13, weight: 700, color: look.text }));
      metaLines.forEach((l, i) => text(x + 3, y + 23 + titleLines.length * 17 + i * 15, l, { size: 11.5, color: look.muted }));
      return y + h;
    };
    // Decision: one condition of the rule.
    const diamond = (top, title, criteria) => {
      const look = FC.decision;
      const lines = fcWrap(criteria, 30, 3);
      const h = 92 + lines.length * 14;
      const mid = top + h / 2;
      const half = FC.diamondW / 2;
      parts.push(`<polygon points="${FC.cx},${top} ${FC.cx + half},${mid} ${FC.cx},${top + h} ${FC.cx - half},${mid}" fill="${look.fill}" stroke="${look.stroke}" stroke-width="1.6" stroke-linejoin="round"/>`);
      const firstY = mid - (lines.length * 14) / 2 + 1;
      text(FC.cx, firstY, title, { size: 13, weight: 700, color: look.text });
      lines.forEach((l, i) => text(FC.cx, firstY + 17 + i * 14, l, { size: 11.5, color: look.muted }));
      return { mid, bottom: top + h, left: FC.cx - half, right: FC.cx + half };
    };
    // Yes / No tag on a branch, as a small filled badge.
    const branchLabel = (x1, x2, y, value) => {
      const color = value === 'Yes' ? FC.yes : FC.no;
      const x = (x1 + x2) / 2;
      parts.push(`<rect x="${x - 17}" y="${y - 22}" width="34" height="17" rx="8.5" fill="${color}"/>`);
      text(x, y - 9.5, value, { size: 11, weight: 700, color: '#ffffff' });
    };

    const branches = ruleBranches(wf);
    const kindsUsed = new Set();
    let y = pill(FC.cx, 14, `Start: ${triggerLabel(wf.trigger_type)}`, FC.start);
    let previous = null;
    branches.forEach((branch, index) => {
      const last = index === branches.length - 1;
      const top = y + FC.gap + 6;
      if (previous) {
        // "No" of the previous condition: right, down the side, then back into this condition.
        path([[previous.right, previous.mid], [FC.noX, previous.mid], [FC.noX, y + 8], [FC.cx, y + 8], [FC.cx, top]], 'no');
        branchLabel(previous.right, FC.noX, previous.mid, 'No');
      } else {
        path([[FC.cx, y], [FC.cx, top]]);
      }
      const d = diamond(top, branch.title, branch.criteria);

      // "Yes": left, then down through the actions to Done.
      let left = d.bottom + 18;
      path([[d.left, d.mid], [FC.yesX, d.mid], [FC.yesX, left]], 'yes');
      branchLabel(d.left, FC.yesX, d.mid, 'Yes');
      const actions = branch.actions.length ? branch.actions : [{ title: 'No actions', meta: 'Nothing runs for this condition', kind: 'other' }];
      actions.forEach((a, i) => {
        kindsUsed.add(FC.kinds[a.kind] ? a.kind : 'other');
        if (i) {
          path([[FC.yesX, left], [FC.yesX, left + FC.gap - 4]]);
          left += FC.gap - 4;
        }
        left = box(FC.yesX, left, a);
      });
      path([[FC.yesX, left], [FC.yesX, left + FC.gap - 4]]);
      left = pill(FC.yesX, left + FC.gap - 4, 'Done', FC.done);

      let right = d.mid;
      if (last) {
        path([[d.right, d.mid], [FC.noX, d.mid], [FC.noX, d.bottom + 18]], 'no');
        branchLabel(d.right, FC.noX, d.mid, 'No');
        right = pill(FC.noX, d.bottom + 18, 'Stop', FC.stop);
      }
      // The next condition starts below everything drawn for this one, so no lines cross.
      y = Math.max(left, right, d.bottom) + 10;
      previous = d;
    });

    // Legend: only the shapes and action types that appear in this chart.
    const legend = [
      { label: 'Start / Done', shape: 'pill', look: FC.start },
      { label: 'Stop', shape: 'pill', look: FC.stop },
      { label: 'Condition', shape: 'diamond', look: FC.decision },
      ...['fn', 'field', 'email', 'other'].filter(k => kindsUsed.has(k)).map(k => ({ label: FC.kinds[k].label, shape: 'box', look: FC.kinds[k] }))
    ];
    y += 14;
    parts.push(`<line x1="20" y1="${y}" x2="${FC.width - 20}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`);
    let lx = 24;
    let ly = y + 22;
    legend.forEach((item) => {
      const w = 26 + item.label.length * 6.6 + 18;
      if (lx + w > FC.width - 20) { lx = 24; ly += 22; }
      const sy = ly - 9;
      if (item.shape === 'pill') parts.push(`<rect x="${lx}" y="${sy}" width="18" height="11" rx="5.5" fill="${item.look.fill}" stroke="${item.look.stroke}" stroke-width="1.4"/>`);
      else if (item.shape === 'diamond') parts.push(`<polygon points="${lx + 9},${sy - 2} ${lx + 18},${sy + 5.5} ${lx + 9},${sy + 13} ${lx},${sy + 5.5}" fill="${item.look.fill}" stroke="${item.look.stroke}" stroke-width="1.4"/>`);
      else parts.push(`<rect x="${lx}" y="${sy}" width="18" height="11" rx="2.5" fill="${item.look.fill}" stroke="${item.look.stroke}" stroke-width="1.4"/>`);
      text(lx + 24, ly, item.label, { size: 11, weight: 600, color: '#475569', anchor: 'start' });
      lx += w;
    });
    const height = Math.ceil(ly + 12);
    const drawnHeight = Math.round(height * (width / FC.width));
    const marker = (tone) => `
            <marker id="${id}-${tone}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,1 L9,5 L0,9 z" fill="${FC[tone]}"/>
            </marker>`;
    return `
      <div class="fc">
        <svg viewBox="0 0 ${FC.width} ${height}" width="${width}" height="${drawnHeight}" font-family="${FC.font}" role="img" aria-label="${escapeHtml(`Flowchart of ${wf.name || 'the workflow rule'}`)}" xmlns="http://www.w3.org/2000/svg">
          <defs>${marker('line')}${marker('yes')}${marker('no')}
          </defs>
          ${parts.join('\n          ')}
        </svg>
      </div>`;
  }

  function renderCriteriaDetails(wf) {
    const branches = ruleBranches(wf);
    return branches.map((branch, index) => {
      const last = index === branches.length - 1;
      const otherwise = last
        ? 'If the record does not match, the rule stops.'
        : 'If the record does not match, the next condition is checked.';
      return `
      <article class="crit-card">
        <div class="crit-head">
          <span class="crit-num">${index + 1}</span>
          <div>
            <strong>${escapeHtml(branch.title)}</strong>
            <p>Matches when ${escapeHtml(branch.criteria)}</p>
          </div>
        </div>
        <p class="crit-when">When this matches, the actions below run and the rule is done. ${escapeHtml(otherwise)}</p>
        <ul class="crit-actions">
          ${branch.actions.length ? branch.actions.map(a => `
            <li>
              <span class="crit-kind ${escapeHtml(a.kind)}">${escapeHtml(a.kind === 'fn' ? 'Function' : a.kind === 'field' ? 'Field' : a.kind === 'email' ? 'Email' : 'Action')}</span>
              <div><strong>${escapeHtml(a.title)}</strong><span>${escapeHtml(a.meta || 'Runs when this criteria matches')}</span></div>
            </li>`).join('') : '<li class="muted">No actions for this criteria</li>'}
        </ul>
      </article>`;
    }).join('');
  }

  function renderStaticRuleDoc(wf) {
    const branches = ruleBranches(wf);
    const actionCount = branches.reduce((sum, b) => sum + b.actions.length, 0);
    const fnList = wf.function_code || [];
    const functions = fnList.map((fn) => {
      const title = fn.name || fn.api_name || 'Function';
      const when = fn.timing === 'scheduled' ? 'Scheduled action' : 'Instant action';
      const code = fn.source ? 'Code loaded' : 'Code not loaded';
      return `<li><span class="rd-fn-icon">ƒ</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(when)} · ${escapeHtml(code)}</span></div></li>`;
    }).join('');
    const active = wf.status === 'active';
    return `
      <article class="static-doc">
        <div class="rd-summary">
          <div class="rd-stat"><span>Module</span><strong>${escapeHtml(moduleLabel(wf.module))}</strong></div>
          <div class="rd-stat"><span>Trigger</span><strong>${escapeHtml(triggerLabel(wf.trigger_type))}</strong></div>
          <div class="rd-stat"><span>Status</span><strong class="${active ? 'rd-on' : 'rd-off'}">${active ? 'Active' : 'Inactive'}</strong></div>
          <div class="rd-stat"><span>Conditions</span><strong>${branches.length}</strong></div>
          <div class="rd-stat"><span>Actions</span><strong>${actionCount}</strong></div>
          <div class="rd-stat"><span>Functions</span><strong>${fnList.length}</strong></div>
        </div>
        ${wf.description ? `<p class="static-desc">${escapeHtml(wf.description)}</p>` : ''}
        <div class="rd-grid">
          <section class="rd-panel">
            <div class="rd-panel-head"><h4>Flow</h4><span>Click the chart to enlarge</span></div>
            <button type="button" class="fc-zoom" data-fc-zoom="${escapeHtml(wf.id)}" title="Click to enlarge">
              ${renderFlowchart(wf)}
              <span class="fc-zoom-hint" aria-hidden="true">⤢ Enlarge</span>
            </button>
          </section>
          <section class="rd-panel">
            <div class="rd-panel-head"><h4>Criteria and actions</h4><span>${plural(branches.length, 'condition')}</span></div>
            <div class="crit-list">${renderCriteriaDetails(wf)}</div>
            ${functions ? `<div class="rd-panel-head rd-sub"><h4>Functions on this rule</h4></div><ul class="fn-mini">${functions}</ul>` : ''}
          </section>
        </div>
      </article>`;
  }

  // ---------- Flowchart viewer ----------
  // Full-screen view of one rule's flowchart with zoom (buttons, Ctrl + mouse wheel, + / - keys) and scroll to pan.
  const FC_ZOOM_MIN = 0.4;
  const FC_ZOOM_MAX = 4;

  function openFlowchartViewer(wf) {
    closeFlowchartViewer();
    const box = document.createElement('div');
    box.className = 'fc-viewer';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', `Flowchart of ${wf.name || 'the workflow rule'}`);
    box.innerHTML = `
      <div class="fc-viewer-bar">
        <strong>${escapeHtml(wf.name || 'Workflow rule')}</strong>
        <div class="fc-viewer-tools">
          <span class="fc-viewer-help">Scroll to zoom · drag to move</span>
          <button type="button" class="btn btn-ghost btn-sm" data-fc-act="out" title="Zoom out (-)">−</button>
          <span class="fc-viewer-level">100%</span>
          <button type="button" class="btn btn-ghost btn-sm" data-fc-act="in" title="Zoom in (+)">+</button>
          <button type="button" class="btn btn-ghost btn-sm" data-fc-act="fit" title="Fit to screen">Fit</button>
          <button type="button" class="btn btn-secondary btn-sm" data-fc-act="close" title="Close (Esc)">Close</button>
        </div>
      </div>
      <div class="fc-viewer-stage">${renderFlowchart(wf)}</div>`;
    document.body.appendChild(box);
    const stage = box.querySelector('.fc-viewer-stage');
    const svg = stage.querySelector('svg');
    const level = box.querySelector('.fc-viewer-level');
    const baseW = Number(svg.getAttribute('width')) || FC.width;
    const baseH = Number(svg.getAttribute('height')) || FC.width;
    let zoom = 1;
    const apply = (next) => {
      zoom = Math.min(FC_ZOOM_MAX, Math.max(FC_ZOOM_MIN, next));
      svg.style.width = `${Math.round(baseW * zoom)}px`;
      svg.style.height = `${Math.round(baseH * zoom)}px`;
      level.textContent = `${Math.round(zoom * 100)}%`;
    };
    const fit = () => apply(Math.min((stage.clientWidth - 40) / baseW, (stage.clientHeight - 40) / baseH, 2));
    fit();
    box.addEventListener('click', (e) => {
      const act = e.target.closest('[data-fc-act]');
      if (!act) { if (e.target === box) closeFlowchartViewer(); return; }
      const a = act.dataset.fcAct;
      if (a === 'in') apply(zoom * 1.25);
      else if (a === 'out') apply(zoom / 1.25);
      else if (a === 'fit') fit();
      else closeFlowchartViewer();
    });
    // Mouse wheel zooms in and out around the pointer: the point under the cursor stays where it is.
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = svg.getBoundingClientRect();
      const px = (e.clientX - before.left) / before.width;
      const py = (e.clientY - before.top) / before.height;
      const prev = zoom;
      apply(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      if (zoom === prev) return;
      const after = svg.getBoundingClientRect();
      stage.scrollLeft += after.left + px * after.width - e.clientX;
      stage.scrollTop += after.top + py * after.height - e.clientY;
    }, { passive: false });
    // Drag to move around, since the wheel now zooms.
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* drag still works without capture */ }
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      stage.scrollLeft = drag.left - (e.clientX - drag.x);
      stage.scrollTop = drag.top - (e.clientY - drag.y);
    });
    const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    box._onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeFlowchartViewer(); }
      else if (e.key === '+' || e.key === '=') apply(zoom * 1.25);
      else if (e.key === '-') apply(zoom / 1.25);
    };
    document.addEventListener('keydown', box._onKey, true);
    box.querySelector('[data-fc-act="close"]').focus();
  }

  function closeFlowchartViewer() {
    const box = document.querySelector('.fc-viewer');
    if (!box) return;
    document.removeEventListener('keydown', box._onKey, true);
    box.remove();
  }

  function closeRuleDoc() {
    dom.ruleDocBackdrop.hidden = true;
  }

  function showWorkflowRule(id) {
    const wf = state.reviewWorkflows.find(w => String(w.id) === String(id))
      || state.allWorkflowsList.find(w => String(w.id) === String(id));
    if (!wf) return;
    dom.ruleDocTitle.textContent = wf.name || 'Workflow rule';
    dom.ruleDocBody.innerHTML = renderStaticRuleDoc(wf);
    dom.ruleDocBackdrop.hidden = false;
  }

  function openRuleView(mode) {
    if (mode === 'document') {
      if (state.docs.length) {
        if (state.maxStep < 4) limitSteps(4);
        goToStep(4);
        renderDocs();
        return;
      }
      generateDocument();
      return;
    }
    const wf = state.reviewWorkflows.find(w => String(w.id) === String(state.activeReviewId)) || state.reviewWorkflows[0];
    if (wf) showWorkflowRule(wf.id);
  }

  function renderActionItem(action, delay) {
    const type = action.type || action.action_type || '';
    const isFn = /function/i.test(type);
    return `<li><span class="action-type ${isFn ? 'fn' : ''}">${escapeHtml(actionTypeLabel(type))}</span>${escapeHtml(action.name || action.action_name || '')}${delay ? ` <span class="muted small">${escapeHtml(delay)}</span>` : ''}</li>`;
  }

  function scheduleLabel(group) {
    const after = group.execute_after || group.execute_at || {};
    if (after.unit && after.period) return `after ${after.unit} ${after.period}`;
    if (group.name) return group.name;
    return 'scheduled';
  }

  function renderConditions(wf) {
    const conditions = Array.isArray(wf.conditions) ? wf.conditions : [];
    if (!conditions.length) {
      return `
        <div class="condition">
          <div class="condition-title">Criteria</div>
          <div class="criteria-box">${escapeHtml(readableCriteria(wf.criteria) || 'No criteria. Runs for every record that matches the trigger.')}</div>
          <ul class="action-list">${(wf.actions || []).map(a => `<li>${escapeHtml(a)}</li>`).join('') || '<li class="muted">No actions returned</li>'}</ul>
        </div>`;
    }
    return conditions.map((c, i) => {
      const criteria = formatCriteria(c.criteria_details && c.criteria_details.criteria) || 'No criteria. Runs for every record that matches the trigger.';
      const instant = (c.instant_actions && c.instant_actions.actions) || [];
      const scheduled = Array.isArray(c.scheduled_actions) ? c.scheduled_actions : [];
      const items = instant.map(a => renderActionItem(a))
        .concat(scheduled.flatMap(g => (g.actions || []).map(a => renderActionItem(a, scheduleLabel(g)))));
      return `
        <div class="condition">
          <div class="condition-title">Condition ${c.sequence_number || i + 1}</div>
          <div class="criteria-box">${escapeHtml(readableCriteria(criteria))}</div>
          <ul class="action-list">${items.join('') || '<li class="muted">No actions on this condition</li>'}</ul>
        </div>`;
    }).join('');
  }

  function renderCode(source) {
    return `<pre class="code">${String(source).split('\n').map(line => `<span class="ln">${escapeHtml(line) || ' '}</span>`).join('')}</pre>`;
  }

  // ==========================================
  // STEP 3: FUNCTION REVIEW (mask secrets, check, improve, apply)
  // ==========================================
  const DR = window.DelugeReview;
  const LOCAL_BACKUP_PREFIX = 'livingdocs.fnBackups.';
  const LOCAL_BACKUP_LIMIT = 10;
  const SEVERITY_LABEL = { error: 'Risk', warning: 'Warning', info: 'Info' };
  let promptRebuildTimer = null;
  let tipLine = null;

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function fnKey(fn) {
    return String(fn.id || fn.api_name || fn.name || '');
  }

  function isDeluge(fn) {
    return !/(java|node|python)/i.test(`${fn.language || ''} ${fn.runtime || ''}`);
  }

  function fnReview(fn) {
    const key = fnKey(fn);
    if (!state.fnReviews[key]) {
      state.fnReviews[key] = { key, manual: [], ignore: [], tab: 'checks', result: null, improved: null, improving: false, applying: false, backups: null, changesOnly: false };
    }
    return state.fnReviews[key];
  }

  function runFnReview(fn) {
    const r = fnReview(fn);
    r.result = fn.source ? DR.review(fn.source, { manual: r.manual, ignore: r.ignore, lint: isDeluge(fn) }) : null;
    return r;
  }

  function uniqueFunctions(workflows) {
    const seen = new Map();
    (workflows || []).forEach(wf => (wf.function_code || []).forEach((fn) => {
      if (fn.source && !seen.has(fnKey(fn))) seen.set(fnKey(fn), fn);
    }));
    return [...seen.values()];
  }

  function reviewFunctions(workflows) {
    uniqueFunctions(workflows).forEach(fn => runFnReview(fn));
  }

  function findReviewFunction(key) {
    for (const wf of state.reviewWorkflows) {
      const fn = (wf.function_code || []).find(f => fnKey(f) === key);
      if (fn) return fn;
    }
    return null;
  }

  function allMaskEntries() {
    return Object.values(state.fnReviews).flatMap(r => (r.result ? r.result.mask.entries : []));
  }

  // The only copy of the workflows that is ever sent to the model.
  // Rule, criteria and code sent for documentation carry no record, workflow, function or org IDs.
  function scrubIdsForAI(value) {
    if (value == null) return value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.replace(/(?<![\w{])\d{9,}(?![\w}])/g, '{{ID}}');
  }

  function maskedWorkflowsForAI(workflows = state.reviewWorkflows) {
    return workflows.map(({ id, raw, ...wf }) => ({
      ...wf,
      criteria: scrubIdsForAI(wf.criteria),
      description: scrubIdsForAI(wf.description || ''),
      actions: (wf.actions || []).map(scrubIdsForAI),
      function_code: (wf.function_code || []).map((fn) => {
        const { id: fnId, ...rest } = fn;
        if (!fn.source) return { ...rest, error: scrubIdsForAI(fn.error || ''), note: scrubIdsForAI(fn.note || '') };
        const r = fnReview(fn);
        if (!r.result) runFnReview(fn);
        return { ...rest, description: scrubIdsForAI(fn.description || ''), source: r.result.mask.masked };
      })
    }));
  }

  function maskedValueCount() {
    return uniqueFunctions(state.reviewWorkflows).reduce((sum, fn) => sum + ((fnReview(fn).result?.mask.entries.length) || 0), 0);
  }

  function schedulePromptRebuild() {
    clearTimeout(promptRebuildTimer);
    promptRebuildTimer = setTimeout(() => buildPrompt(), 400);
  }

  function rerenderFnCard(fn) {
    const el = dom.reviewBody.querySelector(`.fn-card[data-fn="${CSS.escape(fnKey(fn))}"]`);
    if (el) el.outerHTML = renderFunctionCard(fn);
  }

  function renderFunctions(wf) {
    const fns = wf.function_code || [];
    if (!fns.length) {
      return '<div class="fn-missing muted small">This rule does not call a custom function.</div>';
    }
    return fns.map(fn => renderFunctionCard(fn)).join('');
  }

  function renderFunctionCard(fn) {
    const title = fn.name || fn.api_name || 'Function';
    const meta = [fn.api_name && fn.api_name !== title ? fn.api_name : '', fn.language || fn.runtime, fn.timing === 'scheduled' ? 'Scheduled action' : 'Instant action', fn.id ? `ID ${fn.id}` : '']
      .filter(Boolean).join(' · ');
    const args = (fn.arguments || []).map(a => (a && typeof a === 'object') ? `${a.name}${a.type ? ` (${a.type})` : ''}` : String(a)).join(', ');
    const head = (badges) => `
      <div class="fn-head">
        <div>
          <div class="fn-name">${escapeHtml(title)}</div>
          <div class="fn-meta">${escapeHtml(meta)}${args ? ` · Arguments: ${escapeHtml(args)}` : ''}</div>
        </div>
        <div class="fn-badges">${badges}</div>
      </div>`;

    if (!fn.source) {
      const attempts = (fn.attempts || []).length
        ? `<ul class="attempts">${fn.attempts.map(a => `<li><code>GET ${escapeHtml(a.endpoint)}</code> ${escapeHtml(a.result)}</li>`).join('')}</ul>`
        : '';
      return `
        <div class="fn-card" data-fn="${escapeHtml(fnKey(fn))}">
          ${head('<span class="pill pill-red">Code not available</span>')}
          <div class="fn-missing"><div class="notice error">${escapeHtml(fn.error || fn.note || 'Zoho returned no source for this function.')}</div>${attempts}</div>
        </div>`;
    }

    const r = fnReview(fn);
    if (!r.result) runFnReview(fn);
    const { counts, mask } = r.result;
    const deluge = isDeluge(fn);
    const badges = [
      deluge && counts.error ? `<span class="pill pill-red">${plural(counts.error, 'risk')}</span>` : '',
      deluge && counts.warning ? `<span class="pill pill-amber">${plural(counts.warning, 'warning')}</span>` : '',
      deluge && counts.info ? `<span class="pill pill-gray">${counts.info} info</span>` : '',
      deluge && !counts.error && !counts.warning && !counts.info ? '<span class="pill pill-green">No issues</span>' : '',
      `<span class="pill pill-blue">${mask.entries.length ? `${plural(mask.entries.length, 'value')} masked` : 'No secrets found'}</span>`,
      r.externalChange ? `<span class="pill pill-amber" title="The code differs from documented version ${escapeHtml(r.externalChange.version)}">Changed since v${escapeHtml(r.externalChange.version)}</span>`
        : r.docInfo ? `<span class="pill pill-gray" title="Documented ${escapeHtml(formatDate(r.docInfo.at))}">Documented v${escapeHtml(r.docInfo.version)}</span>` : ''
    ].join('');
    const issueTotal = counts.error + counts.warning + counts.info;
    const tabs = [
      ['checks', 'Checks', deluge ? issueTotal : null],
      ['preview', 'Sent to AI', mask.entries.length || null],
      ['improve', 'Improve and apply', null],
      ['history', 'Versions', r.backups ? r.backups.length : null]
    ].map(([id, label, count]) => `
      <button class="fn-tab ${r.tab === id ? 'active' : ''}" data-fn-tab="${id}" role="tab" aria-selected="${r.tab === id}">
        ${label}${count ? `<span class="fn-tab-count">${count}</span>` : ''}
      </button>`).join('');

    let body = '';
    if (r.tab === 'preview') body = renderPreviewTab(fn, r);
    else if (r.tab === 'improve') body = renderImproveTab(fn, r);
    else if (r.tab === 'history') body = renderHistoryTab(fn, r);
    else body = renderChecksTab(fn, r);

    return `
      <div class="fn-card" data-fn="${escapeHtml(fnKey(fn))}">
        ${head(badges)}
        <div class="fn-tabs" role="tablist">${tabs}</div>
        <div class="fn-tab-body">${body}</div>
      </div>`;
  }

  function renderAnnotatedCode(source, issues, spans) {
    const byLine = new Map();
    issues.forEach((i) => { const list = byLine.get(i.line) || []; list.push(i); byLine.set(i.line, list); });
    const secretsByLine = new Map();
    (spans || []).forEach((s) => { const list = secretsByLine.get(s.line) || []; list.push(s); secretsByLine.set(s.line, list); });
    const sevRank = { info: 1, warning: 2, error: 3 };
    const sevName = ['', 'info', 'warning', 'error'];
    const html = source.split('\n').map((text, k) => {
      const n = k + 1;
      const list = byLine.get(n) || [];
      const marks = new Uint8Array(text.length);
      (secretsByLine.get(n) || []).forEach((s) => {
        for (let c = s.col; c < Math.min(text.length, s.col + (s.end - s.start)); c++) marks[c] |= 1;
      });
      let top = 0;
      list.forEach((i) => {
        const sev = sevRank[i.severity];
        top = Math.max(top, sev);
        for (let c = i.start; c < Math.min(text.length, i.end); c++) {
          if (sev > (marks[c] >> 1)) marks[c] = (marks[c] & 1) | (sev << 1);
        }
      });
      let out = '';
      let c = 0;
      while (c < text.length) {
        let e = c;
        while (e < text.length && marks[e] === marks[c]) e++;
        const m = marks[c];
        const cls = [m & 1 ? 'secret' : '', m >> 1 ? `u-${sevName[m >> 1]}` : ''].filter(Boolean).join(' ');
        const seg = escapeHtml(text.slice(c, e));
        out += cls ? `<span class="${cls}">${seg}</span>` : seg;
        c = e;
      }
      return `<span class="ln${top ? ` has-issue sev-${sevName[top]}` : ''}" data-line="${n}">${out || ' '}</span>`;
    }).join('');
    return `<pre class="code annotated">${html}</pre>`;
  }

  function renderMaskedCode(masked) {
    return `<pre class="code">${masked.split('\n').map(line => `<span class="ln">${escapeHtml(line).replace(/\{\{[A-Z0-9_]+\}\}/g, '<span class="ph">$&</span>') || ' '}</span>`).join('')}</pre>`;
  }

  function renderChecksTab(fn, r) {
    const { issues, mask } = r.result;
    const deluge = isDeluge(fn);
    const sorted = issues.slice().sort((a, b) => (DR.SEVERITY_ORDER[a.severity] - DR.SEVERITY_ORDER[b.severity]) || (a.line - b.line));
    const list = !deluge
      ? '<div class="issue-none"><strong>Checks cover Deluge only</strong><span>Secrets in this function are still masked before anything is sent.</span></div>'
      : sorted.length
        ? sorted.map(i => `
          <button class="issue-item sev-${i.severity}" data-line="${i.line}">
            <span class="sev-dot"></span>
            <span class="issue-text">
              <span class="issue-title">Line ${i.line} · ${escapeHtml(i.title)}</span>
              <span class="issue-msg">${escapeHtml(i.message)}</span>
            </span>
          </button>`).join('')
        : `<div class="issue-none ok"><span class="issue-none-icon">${ICON.check}</span><strong>No issues found</strong><span>The function follows the Deluge checks.</span></div>`;
    const ext = r.externalChange;
    const extNotice = ext ? `
      <div class="notice warning">
        This function was changed after documentation version ${escapeHtml(ext.version)}${ext.by ? ` by ${escapeHtml(ext.by)}` : ''}${ext.at ? ` on ${escapeHtml(formatDate(ext.at))}` : ''}.
        Generate and save the document to publish a new version.
      </div>` : '';
    return `${extNotice}
      <div class="checks-grid">
        <div class="checks-code">
          ${renderAnnotatedCode(fn.source, deluge ? issues : [], mask.spans)}
          <div class="code-legend">
            <span><i class="lg lg-error"></i>Risk</span><span><i class="lg lg-warning"></i>Warning</span><span><i class="lg lg-info"></i>Info</span>
            <span><i class="lg lg-secret"></i>Masked before sending</span>
            <span class="muted">Hover a line for details. Select text to mask it.</span>
          </div>
          ${fn.source_truncated ? '<div class="notice warning">The code was longer than the download limit and is cut off here.</div>' : ''}
        </div>
        <aside class="issue-list">${list}</aside>
      </div>`;
  }

  function renderPreviewTab(fn, r) {
    const { mask } = r.result;
    const rows = mask.entries.map(e => `
      <li class="mask-item">
        <div class="mask-item-top">
          <span class="ph">${escapeHtml(e.placeholder)}</span>
          ${e.kind === 'manual'
            ? `<button class="link-btn" data-act="remove-manual" data-ph="${escapeHtml(e.placeholder)}">Remove</button>`
            : e.optional
              ? `<button class="link-btn" data-act="ignore" data-ph="${escapeHtml(e.placeholder)}">Send as is</button>`
              : '<span class="muted small">Always masked</span>'}
        </div>
        <div class="mask-item-meta">${escapeHtml(e.label)} · line ${e.lines.join(', ')} · <code>${escapeHtml(DR.maskPreview(e.value))}</code></div>
      </li>`).join('');
    const ignored = r.ignore.filter(v => fn.source.includes(v));
    return `
      <div class="notice info">This masked copy is the only version of the code that leaves your browser, for the improvement and in the documentation prompt. The real values are put back here after the AI answers.</div>
      <div class="preview-grid">
        <div>${renderMaskedCode(mask.masked)}</div>
        <aside class="mask-panel">
          <h4>Masked values</h4>
          ${rows ? `<ul class="mask-list">${rows}</ul>` : '<p class="muted small">No tokens, keys, org IDs or record IDs were found.</p>'}
          ${ignored.length ? `<div class="mask-ignored"><div class="muted small">Sent without masking</div>${ignored.map((v, i) => `
            <div class="mask-ignored-row"><code>${escapeHtml(DR.maskPreview(v))}</code><button class="link-btn" data-act="unignore" data-idx="${r.ignore.indexOf(v)}">Mask again</button></div>`).join('')}</div>` : ''}
          <div class="mask-add">
            <label class="field">
              <span>Mask another value</span>
              <input type="text" class="mask-input" placeholder="Paste a value from the code" autocomplete="off" spellcheck="false" />
            </label>
            <button class="btn btn-secondary btn-sm" data-act="add-manual">Mask value</button>
          </div>
          <p class="muted small">You can also select text in the code and choose Mask as secret.</p>
        </aside>
      </div>`;
  }

  function renderImproveTab(fn, r) {
    if (r.applying) return loadingBlock('Saving a backup and updating the function in Zoho CRM…');
    if (r.improving) {
      if (!state.hasApiKey) return loadingBlock('Adding review notes…');
      return loadingBlock(r.improveChars
        ? `${aiName()} is writing the improved code… ${r.improveChars.toLocaleString()} characters so far.`
        : `Sending the masked code to ${aiName()}…`);
    }
    const lastApply = r.lastApply ? `
      <div class="notice ${r.lastApply.verified === false ? 'warning' : 'info'} apply-done">
        <div>
          <strong>${escapeHtml(r.lastApply.message)}</strong> ${formatDate(r.lastApply.at)}.
          Backup saved ${escapeHtml(r.lastApply.where.join(' and '))}.
          ${r.lastApply.verified === false ? 'Zoho returned code that differs from what was sent. Open the function in CRM to check it.' : ''}
        </div>
        <button class="btn btn-secondary btn-sm" data-act="restore" data-id="${escapeHtml(r.lastApply.backupId)}">Roll back</button>
      </div>` : '';

    if (!r.improved) {
      const { counts } = r.result;
      return `${lastApply}
        ${r.improveError ? `<div class="notice error">${escapeHtml(r.improveError)}</div>` : ''}
        <div class="improve-empty">
          <h4>Get an improved version</h4>
          <p class="muted">The masked code and the ${plural(counts.error + counts.warning + counts.info, 'issue')} from Checks are sent to ${state.hasApiKey ? escapeHtml(aiName()) : 'the AI provider'}. The answer is unmasked in your browser and shown next to the current code, so you can compare before applying anything.</p>
          ${state.hasApiKey ? '' : '<p class="muted small">No AI provider is configured, so you will get the current code with a header and review notes as comments. Choose a provider in Settings for rewritten code.</p>'}
          <button class="btn btn-primary" data-act="improve">${state.hasApiKey ? 'Improve function' : 'Add review notes'}</button>
        </div>`;
    }

    const imp = r.improved;
    const blockers = applyBlockers(fn, r);
    const notices = [
      r.improveError ? `<div class="notice error">${escapeHtml(r.improveError)}</div>` : '',
      imp.unknown.length ? `<div class="notice error">The answer contains placeholders that were never masked: ${escapeHtml(imp.unknown.join(', '))}. Apply is blocked.</div>` : '',
      !imp.signatureOk ? '<div class="notice error">The declaration line changed. Zoho only accepts the original function name and category, so Apply is blocked.</div>' : '',
      imp.missing.length ? `<div class="notice info">The new code no longer uses ${escapeHtml(imp.missing.join(', '))}. Check that the value is not needed, for example because a connection replaced it.</div>` : ''
    ].join('');
    const before = r.result.counts;
    const after = imp.countsAfter;
    const countLine = after ? `Issues ${before.error + before.warning + before.info} before, ${after.error + after.warning + after.info} after` : '';
    return `${lastApply}
      <div class="improve-head">
        <div>
          <h4>${imp.mode === 'model' ? 'Suggested changes' : 'Review notes added'}</h4>
          <ul class="improve-summary">${(imp.summary || []).map(s => `<li>${escapeHtml(s)}</li>`).join('') || '<li class="muted">No summary returned.</li>'}</ul>
        </div>
        <div class="improve-stats">
          <span class="row gap-8"><span class="pill pill-green">+${imp.diff.added}</span><span class="pill pill-red">−${imp.diff.removed}</span></span>
          ${countLine ? `<span class="muted small">${countLine}</span>` : ''}
          ${imp.model ? `<span class="muted small">${escapeHtml(imp.model)}</span>` : ''}
        </div>
      </div>
      ${notices}
      <div class="diff-toolbar">
        <label class="check-inline"><input type="checkbox" data-act="changes-only" ${r.changesOnly ? 'checked' : ''} /> Changed lines only</label>
      </div>
      ${renderDiff(imp.diff, r.changesOnly)}
      <div class="improve-actions">
        <button class="btn btn-ghost btn-sm" data-act="discard">Discard</button>
        <div class="row gap-8">
          <button class="btn btn-ghost btn-sm" data-act="improve">Try again</button>
          <button class="btn btn-secondary btn-sm" data-act="copy-improved">Copy improved code</button>
          <button class="btn btn-primary btn-sm" data-act="apply" ${blockers.length ? `disabled title="${escapeHtml(blockers[0])}"` : ''}>Apply as main function</button>
        </div>
      </div>
      ${blockers.length ? `<p class="muted small apply-hint">${escapeHtml(blockers[0])}</p>` : ''}`;
  }

  function renderDiff(diff, changesOnly) {
    const rows = diff.rows;
    const keep = rows.map((row, i) => !changesOnly || row.type !== 'equal' || rows.slice(Math.max(0, i - 2), i + 3).some(x => x.type !== 'equal'));
    let html = '';
    let gap = 0;
    const gapRow = n => `<tr class="d-gap"><td colspan="4">${plural(n, 'unchanged line')}</td></tr>`;
    rows.forEach((row, i) => {
      if (!keep[i]) { gap++; return; }
      if (gap) { html += gapRow(gap); gap = 0; }
      let left = row.left ? escapeHtml(row.left.text) : '';
      let right = row.right ? escapeHtml(row.right.text) : '';
      if (row.type === 'change') {
        const d = DR.inlineDiff(row.left.text, row.right.text);
        left = `${escapeHtml(d.prefix)}${d.left ? `<mark>${escapeHtml(d.left)}</mark>` : ''}${escapeHtml(d.suffix)}`;
        right = `${escapeHtml(d.prefix)}${d.right ? `<mark>${escapeHtml(d.right)}</mark>` : ''}${escapeHtml(d.suffix)}`;
      }
      const changed = row.type !== 'equal';
      html += `<tr class="d-${row.type}">
        <td class="no">${row.left ? row.left.no : ''}</td><td class="src ${changed && row.left ? 'del' : ''} ${!row.left ? 'empty' : ''}">${left}</td>
        <td class="no">${row.right ? row.right.no : ''}</td><td class="src ${changed && row.right ? 'add' : ''} ${!row.right ? 'empty' : ''}">${right}</td>
      </tr>`;
    });
    if (gap) html += gapRow(gap);
    return `
      <div class="diff-wrap">
        <table class="diff">
          <colgroup><col class="c-no" /><col /><col class="c-no" /><col /></colgroup>
          <thead><tr><th colspan="2">Current in CRM</th><th colspan="2">Improved</th></tr></thead>
          <tbody>${html}</tbody>
        </table>
      </div>`;
  }

  function renderHistoryTab(fn, r) {
    if (r.backupsLoading) return loadingBlock('Loading saved versions…');
    const list = r.backups || [];
    const rows = list.map((b) => {
      const open = r.compareId === b.id;
      return `
        <div class="version-row ${open ? 'open' : ''}">
          <div class="version-main">
            <div>
              <div class="version-title">${escapeHtml(b.reason || 'Backup')}${b.changelog ? ` <span class="muted">· ${escapeHtml(b.changelog)}</span>` : ''}</div>
              <div class="muted small">${formatDate(b.at)} · ${plural(b.lines || b.source.split('\n').length, 'line')} · saved ${escapeHtml((b.where || []).join(' and ') || 'in this browser')}</div>
            </div>
            <div class="row gap-8">
              <button class="btn btn-ghost btn-sm" data-act="compare" data-id="${escapeHtml(b.id)}">${open ? 'Hide changes' : 'Compare with current'}</button>
              <button class="btn btn-ghost btn-sm" data-act="copy-backup" data-id="${escapeHtml(b.id)}">Copy</button>
              <button class="btn btn-secondary btn-sm" data-act="restore" data-id="${escapeHtml(b.id)}">Restore</button>
            </div>
          </div>
          ${open ? renderDiff(DR.diffLines(fn.source, b.source), true).replace('Current in CRM</th><th colspan="2">Improved', 'Current in CRM</th><th colspan="2">This version') : ''}
        </div>`;
    }).join('');
    return `
      ${r.backupsError ? `<div class="notice warning">${escapeHtml(r.backupsError)}</div>` : ''}
      ${rows ? `<div class="version-list">${rows}</div>` : '<div class="improve-empty"><h4>No saved versions yet</h4><p class="muted">The current code is backed up automatically every time you apply or restore a version.</p></div>'}
      <p class="muted small">Zoho CRM also keeps its own revision history for Deluge functions.</p>`;
  }

  // ---------- Masking actions ----------
  function masksChanged(fn, message) {
    const r = runFnReview(fn);
    r.improved = null;
    rerenderFnCard(fn);
    schedulePromptRebuild();
    if (message) showToast(message);
    return r;
  }

  function addManualSecret(fn, raw) {
    const value = String(raw || '').trim();
    const r = fnReview(fn);
    if (value.length < 3) { showToast('Pick at least 3 characters to mask.', 'warning'); return; }
    if (/\{\{[A-Z0-9_]+\}\}/.test(value)) { showToast('That text is already a placeholder.', 'warning'); return; }
    if (!fn.source.includes(value)) { showToast('That value is not in the function code.', 'warning'); return; }
    if (!r.manual.includes(value)) r.manual.push(value);
    masksChanged(fn, 'Value masked. The prompt was rebuilt with the new mask.');
  }

  function maskEntry(fn, placeholder) {
    const r = fnReview(fn);
    return r.result && r.result.mask.entries.find(e => e.placeholder === placeholder);
  }

  // ---------- Improve ----------
  async function improveFunction(fn) {
    if (!(await ensureAiConfigured('improve this function'))) return;
    const r = runFnReview(fn);
    const { mask, issues, signature } = r.result;
    const leftover = DR.detectSecrets(mask.masked);
    if (leftover.length) {
      showToast('Masking did not cover every secret or ID, so nothing was sent. Check Sent to AI.', 'error');
      return;
    }
    r.improving = true;
    r.improveError = '';
    r.tab = 'improve';
    rerenderFnCard(fn);
    const baseSource = fn.source;
    try {
      r.improveChars = 0;
      const resp = await window.LivingDocsAI.improveFunction(currentAiConfig(), {
        fn: { id: fn.id, name: fn.name, api_name: fn.api_name, language: fn.language || fn.runtime || 'deluge', signature: signature ? signature.text : '' },
        source: mask.masked,
        issues,
        placeholders: mask.entries.map(e => e.placeholder)
      }, ({ text }) => {
        r.improveChars = text.length;
        rerenderFnCard(fn);
      });
      const restored = DR.unmask(resp.code, mask.entries);
      const code = restored.text;
      const { missing, unknown } = restored;
      const summary = resp.summary;
      const deluge = isDeluge(fn);
      r.improved = {
        code,
        summary,
        mode: 'model',
        model: resp.model || '',
        generatedBy: `${resp.label} (${resp.model})`,
        missing,
        unknown,
        baseSource,
        signatureOk: !deluge || DR.sameSignature(signature, DR.signatureOf(code)),
        diff: DR.diffLines(baseSource, code),
        countsAfter: deluge ? DR.summarize(DR.lintDeluge(code)) : null
      };
    } catch (err) {
      r.improveError = `The improvement failed: ${err.message || err}`;
    } finally {
      r.improving = false;
      rerenderFnCard(fn);
    }
  }

  // ---------- Apply and rollback ----------
  function applyBlockers(fn, r) {
    const out = [];
    const imp = r.improved;
    if (!canUseZohoConnection()) out.push('Open the widget inside Zoho CRM to update functions.');
    if (!isDeluge(fn)) out.push('Only Deluge functions can be applied from here.');
    if (fn.source_truncated) out.push('The downloaded code was cut off, so applying would lose code.');
    if (!fn.id && !fn.api_name) out.push('The function id is unknown.');
    if (imp) {
      if (!imp.diff.changed) out.push('There are no changes to apply.');
      if (imp.unknown.length) out.push('The answer contains placeholders that were never masked.');
      if (!imp.signatureOk) out.push('The declaration line changed, and Zoho would reject it.');
      if (imp.baseSource !== fn.source) out.push('The function changed after this suggestion. Improve it again.');
    }
    return out;
  }

  function localBackupKey(fn) {
    return `${LOCAL_BACKUP_PREFIX}${fnKey(fn)}`;
  }

  function readLocalBackups(fn) {
    try { return JSON.parse(localStorage.getItem(localBackupKey(fn)) || '[]'); } catch (_) { return []; }
  }

  function writeLocalBackup(fn, entry) {
    try {
      const list = [entry, ...readLocalBackups(fn).filter(b => b.id !== entry.id)].slice(0, LOCAL_BACKUP_LIMIT);
      localStorage.setItem(localBackupKey(fn), JSON.stringify(list));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function saveFunctionBackup(fn, source, reason, changelog) {
    const entry = {
      function_id: fnKey(fn), api_name: fn.api_name || '', name: fn.name || '', source, reason, changelog,
      id: `bk_${Date.now()}`, lines: source.split('\n').length, at: new Date().toISOString()
    };
    if (!writeLocalBackup(fn, entry)) throw new Error('The backup could not be saved in this browser, so the function was not changed.');
    return { ...entry, where: ['in this browser'] };
  }

  function loadBackups(fn) {
    const r = fnReview(fn);
    r.backupsError = '';
    r.backups = readLocalBackups(fn)
      .map(b => ({ ...b, where: ['in this browser'] }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    r.backupsLoading = false;
    rerenderFnCard(fn);
  }

  // The update API only accepts multipart/form-data. CONNECTION.invoke cannot send files, so a small
  // standalone Deluge function does the PUT with invokeurl + files through the same connection.
  const UPDATE_HELPER_NAME = 'livingdocs_update_function';

  function updateHelperScript() {
    const connName = String(conn()).replace(/[^A-Za-z0-9_]/g, '');
    return `// Living Docs: updates a CRM function. Argument name: payload, type String. Return type: String.
// In the function Overview, turn on REST API and choose OAuth 2.0. Apply fails with INVALID_DATA until that is on.
inputText = ifnull(payload,"");
if(inputText.trim() == "")
{
	missing = Map();
	missing.put("code","MISSING_INPUT");
	missing.put("message","payload is required");
	return missing.toString();
}
requestData = inputText.toMap();
functionId = ifnull(requestData.get("functionId"),"");
code = ifnull(requestData.get("code"),"");
if(functionId == "" || code.trim() == "")
{
	missing = Map();
	missing.put("code","MISSING_INPUT");
	missing.put("message","functionId and code are required");
	return missing.toString();
}
domain = ifnull(requestData.get("apiDomain"),"https://www.zohoapis.com");
if(!domain.startsWith("https://www.zohoapis."))
{
	domain = "https://www.zohoapis.com";
}
fnEntry = Map();
fnEntry.put("_code",code);
fnList = List();
fnList.add(fnEntry);
metadata = Map();
metadata.put("functions",fnList);
publish = Map();
publish.put("changelog",ifnull(requestData.get("changelog"),"Updated by Living Docs"));
metadata.put("publish",publish);
metaPart = Map();
metaPart.put("paramName","metadata");
metaPart.put("content",metadata.toString());
metaPart.put("stringPart","true");
metaPart.put("contentType","application/json");
codeFile = code.toFile("function.ds");
codeFile.setParamName("code");
files = List();
files.add(metaPart);
files.add(codeFile);
response = invokeurl
[
	url :domain + "/crm/v8/settings/functions/" + functionId
	type :PUT
	files:files
	connection:"${connName}"
];
return response.toString();`;
  }

  function parseMaybeJson(value) {
    if (value == null) return {};
    if (typeof value === 'object') return value;
    const text = String(value).trim();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return { raw_text: text }; }
  }

  function helperResultFromRaw(raw) {
    const output = raw && raw.details && Object.prototype.hasOwnProperty.call(raw.details, 'output') ? raw.details.output : null;
    if (output != null && String(output).trim()) return { ran: true, body: parseMaybeJson(output) };
    const body = unwrapConnectionResponse(raw);
    if (body && body.details && Object.prototype.hasOwnProperty.call(body.details, 'output') && String(body.details.output).trim()) {
      return { ran: true, body: parseMaybeJson(body.details.output) };
    }
    if (body && Array.isArray(body.functions)) return { ran: true, body };
    const code = body && body.code;
    if (code && String(code).toLowerCase() !== 'success') {
      return { ran: false, reason: `${code}: ${body.message || code}` };
    }
    return { ran: false, reason: (raw && (raw.message || raw.code)) || 'the helper function did not run' };
  }

  // The helper ran but its payload argument arrived empty: this way of calling it does not pass arguments.
  function payloadMissing(parsed) {
    const body = parsed && parsed.body;
    const text = body && (body.code || body.raw_text || '');
    return Boolean(parsed && parsed.ran && /MISSING_INPUT/.test(String(text)));
  }

  async function updateViaHelper(identifier, source, changelog) {
    if (typeof ZOHO === 'undefined' || (!ZOHO.CRM?.FUNCTIONS?.execute && !ZOHO.CRM?.CONNECTION?.invoke)) {
      return { ran: false, reason: 'This widget is not running inside Zoho CRM.' };
    }
    const payloadObject = { functionId: String(identifier), code: source, changelog: changelog || 'Updated by Living Docs', apiDomain: getZohoApiDomain() };
    const payload = JSON.stringify(payloadObject);
    const reasons = [];
    const startedAt = Date.now();
    const executeUrl = version => `${payloadObject.apiDomain}/crm/${version}/functions/${UPDATE_HELPER_NAME}/actions/execute?auth_type=oauth`;
    const viaConnection = parameters => () => ZOHO.CRM.CONNECTION.invoke(conn(), {
      url: executeUrl(parameters.version),
      method: 'POST',
      param_type: 2,
      headers: { 'Content-Type': 'application/json' },
      parameters: parameters.body
    });

    // FUNCTIONS.execute first: it is how the AI gateway is called, and it hands "payload" to the function.
    // The REST calls through the connection are fallbacks; Zoho has dropped the argument on some of them.
    const attempts = [];
    if (ZOHO.CRM?.FUNCTIONS?.execute) {
      attempts.push({ label: 'FUNCTIONS.execute', run: () => ZOHO.CRM.FUNCTIONS.execute(UPDATE_HELPER_NAME, { arguments: JSON.stringify({ payload }) }) });
    }
    if (ZOHO.CRM?.CONNECTION?.invoke) {
      attempts.push(
        { label: 'REST v8 arguments object', run: viaConnection({ version: 'v8', body: { arguments: { payload } } }) },
        { label: 'REST v8 arguments string', run: viaConnection({ version: 'v8', body: { arguments: JSON.stringify({ payload }) } }) },
        { label: 'REST v2 arguments object', run: viaConnection({ version: 'v2', body: { arguments: { payload } } }) },
        { label: 'REST v2 payload field', run: viaConnection({ version: 'v2', body: { payload } }) }
      );
    }

    for (const attempt of attempts) {
      try {
        const raw = await withHardTimeout(attempt.run(), 90000, 'Function update');
        const parsed = helperResultFromRaw(raw);
        const missing = payloadMissing(parsed);
        debugLog(parsed.ran && !missing ? 'ok' : 'warn', conn(), 'EXECUTE', `${UPDATE_HELPER_NAME} (${attempt.label})`, { request: { functionId: identifier }, raw, ms: Date.now() - startedAt });
        if (missing) {
          reasons.push(`${attempt.label}: payload did not reach the function`);
          continue;
        }
        if (parsed.ran) return parsed;
        if (parsed.reason) reasons.push(`${attempt.label}: ${parsed.reason}`);
      } catch (err) {
        reasons.push(`${attempt.label}: ${describeSdkError(err)}`);
      }
    }

    const reason = reasons.find(item => item && !/EXPECTED_PARAM_MISSING|INVALID_REQUEST|did not reach/i.test(item)) || reasons.join('; ') || 'the helper function did not run';
    return { ran: false, reason };
  }

  async function updateViaConnection(url, source, changelog, safeName) {
    const metadata = { functions: [{ _code: source }] };
    if (changelog) metadata.publish = { changelog };
    const request = {
      url,
      method: 'PUT',
      param_type: 2,
      CONTENT_TYPE: 'multipart',
      PARTS: [{ headers: { 'Content-Disposition': 'form-data; name="metadata"', 'Content-Type': 'application/json' }, content: metadata }],
      FILE: { fileParam: 'code', file: new File([source], `${safeName}.ds`, { type: 'text/plain' }) }
    };
    const startedAt = Date.now();
    let raw;
    try {
      raw = await withHardTimeout(ZOHO.CRM.CONNECTION.invoke(conn(), request), 60000, 'Function update');
    } catch (err) {
      debugLog('error', conn(), 'PUT', url, { request, error: err, ms: Date.now() - startedAt });
      throw new Error(`The update request failed: ${describeSdkError(err)}`);
    }
    const body = unwrapConnectionResponse(raw);
    debugLog('ok', conn(), 'PUT', url, { request, raw, body, ms: Date.now() - startedAt });
    return body;
  }

  function updateHelperRequiredError(reason) {
    const detail = reason ? ` Zoho said: ${reason}.` : '';
    // The function ran every time but never got its argument: the argument itself is set up wrong.
    const fix = /did not reach/.test(reason || '')
      ? `Open that function, click Edit Arguments, and make sure there is exactly one argument named payload (lower case) of type String. Save, then apply again.`
      : 'Open that function, turn on REST API with OAuth 2.0, and paste the latest script from the setup steps. Then apply again.';
    const err = new Error(`Apply could not run "${UPDATE_HELPER_NAME}".${detail} ${fix}`);
    err.code = 'UPDATE_HELPER_REQUIRED';
    return err;
  }

  async function updateFunctionInCrm(fn, source, changelog) {
    const identifier = fn.id || fn.api_name;
    const helper = await updateViaHelper(identifier, source, changelog);
    if (!helper.ran) throw updateHelperRequiredError(helper.reason);
    const body = helper.body;
    if (body && body.raw_text && /INVALID_DATA|EXPECTED_PARAM_MISSING|MISSING_INPUT/.test(body.raw_text)) {
      throw updateHelperRequiredError(body.raw_text.slice(0, 400));
    }
    const row = Array.isArray(body.functions) ? body.functions[0] : null;
    if (row && String(row.status).toLowerCase() === 'success') return body;
    const err = row || body || {};
    const code = err.code || 'UPDATE_FAILED';
    if (code === 'EXPECTED_PARAM_MISSING' || code === 'INVALID_DATA' || code === 'MISSING_INPUT') {
      throw updateHelperRequiredError(`${code}: ${err.message || 'the helper did not send the new code as metadata _code'}`);
    }
    let message = err.message || 'Zoho did not confirm the update.';
    if (code === 'COMPILATION_ERROR') {
      const details = [].concat(err.details || []).map(d => [d.line_number || d.line ? `line ${d.line_number || d.line}` : '', d.message || ''].filter(Boolean).join(': ')).filter(Boolean);
      message = `Zoho could not compile the new code${details.length ? ` (${details.join('; ')})` : ''}. Nothing was changed.`;
    } else if (/SCOPE/i.test(code)) {
      message = `The connection "${conn()}" needs the ZohoCRM.settings.functions.UPDATE scope (or ZohoCRM.settings.functions.ALL).`;
    } else if (code === 'NO_PERMISSION') {
      message = 'Your CRM profile needs the Manage Automation permission.';
    }
    throw new Error(`${code}: ${message}`);
  }

  function setFunctionSource(fn, source) {
    const key = fnKey(fn);
    state.reviewWorkflows.forEach(wf => (wf.function_code || []).forEach((f) => {
      if (fnKey(f) === key) {
        f.source = source;
        f.source_truncated = false;
      }
    }));
    runFnReview(fn);
  }

  async function applySource(fn, newSource, { reason, changelog, doneMessage, changeType, changeReason, summary = [], aiLabel = '' }) {
    const r = fnReview(fn);
    r.applying = true;
    r.improveError = '';
    r.tab = 'improve';
    rerenderFnCard(fn);
    try {
      const oldSource = fn.source;
      const backup = await saveFunctionBackup(fn, oldSource, reason, changeReason || changelog);
      await updateFunctionInCrm(fn, newSource, changelog);
      let verified = null;
      try {
        const check = await downloadFunctionSource(conn(), { id: fn.id, api_name: fn.api_name });
        if (check.source) verified = check.source.replace(/\s+/g, '') === newSource.replace(/\s+/g, '');
      } catch (_) {}
      setFunctionSource(fn, newSource);
      r.improved = null;
      r.backups = null;
      r.externalChange = null;
      r.lastApply = { message: doneMessage, at: new Date().toISOString(), where: backup.where, backupId: backup.id, backup, verified };
      showToast(`${doneMessage}. The previous version is saved.`);
      schedulePromptRebuild();
    } catch (err) {
      r.improveError = err.message || String(err);
      if (err.code === 'UPDATE_HELPER_REQUIRED') {
        r.applying = false;
        rerenderFnCard(fn);
        if (await showUpdateHelperDialog()) return applySource(fn, newSource, { reason, changelog, doneMessage, changeType, changeReason, summary, aiLabel });
        return;
      }
      showToast('The function was not changed. See the details in the panel.', 'error');
    } finally {
      r.applying = false;
      rerenderFnCard(fn);
    }
  }

  function showUpdateHelperDialog() {
    const script = updateHelperScript();
    const pending = confirmDialog({
      title: 'One-time setup: function update helper',
      confirmLabel: 'I created it, apply again',
      html: `
        <p>Apply sends the new code through the standalone function <code>${UPDATE_HELPER_NAME}</code>. Zoho returns INVALID_DATA when that function is missing, the argument is not named <code>payload</code>, or REST API OAuth is turned off.</p>
        <ol class="helper-steps">
          <li>In Zoho CRM open <strong>Setup &gt; Developer Hub &gt; Functions</strong>. Create <code>${UPDATE_HELPER_NAME}</code> if it is not there, or open the existing one.</li>
          <li>Category <strong>Standalone</strong>. Display name <code>Living Docs update function</code>.</li>
          <li>Click <strong>Edit Arguments</strong> and keep one argument named <code>payload</code> of type <strong>String</strong>. Set the return type to <strong>String</strong>.</li>
          <li>Replace the function body with the script below, then click <strong>Save</strong>.</li>
          <li>Open the function overview. Under <strong>REST API</strong>, enable <strong>OAuth 2.0</strong> and save. Apply cannot call the function until OAuth is on.</li>
        </ol>
        <p class="muted small">The script uses the connection <code>${escapeHtml(conn())}</code>, which needs ZohoCRM.settings.functions.ALL and ZohoCRM.functions.execute.CREATE. Only users who can open this widget can run it.</p>
        <div class="helper-code-head"><span>Function body</span><button type="button" class="btn btn-ghost btn-sm" id="helperCopy">Copy code</button></div>
        <pre class="helper-code">${escapeHtml(script)}</pre>`
    });
    const copyBtn = $('helperCopy');
    if (copyBtn) copyBtn.addEventListener('click', () => copyText(script, copyBtn, 'Copy code'));
    return pending.then(Boolean);
  }

  // ==========================================
  // AI FUNCTIONS AND THE ENCRYPTED KEY STORE
  // livingdocs_save_api_key and livingdocs_llm_gateway share one random secret. Install writes both with a
  // fresh secret when either is missing or they no longer match, then stores the API keys again.
  // ==========================================
  function aiFunctionSpecs(secret, tag) {
    return [
      {
        key: 'save',
        name: LDF.SAVE_FN,
        display: 'Living Docs save API key',
        description: `Stores the Living Docs AI API keys AES-encrypted in the Org Variable ${LDF.VAR_NAME}. CRM Administrators only.`,
        script: LDF.saveKeyScript({ secret, tag, connection: conn() })
      },
      {
        key: 'gateway',
        name: LDF.GATEWAY_FN,
        display: 'Living Docs LLM gateway',
        description: 'Sends Living Docs prompts to Claude or Cursor with the encrypted key. The key never leaves CRM.',
        script: LDF.gatewayScript({ secret, tag, settingsModule: logModuleApi('settings') })
      }
    ];
  }

  // Both functions report a tag derived from their secret; equal tags mean the saved keys can be decrypted.
  async function aiFunctionHealth() {
    const out = { saveTag: '', gatewayTag: '', saveCode: '', gatewayCode: '', saveError: '', gatewayError: '', keyStatus: '', gatewayVersion: 0 };
    await Promise.all([
      window.LivingDocsAI.checkSaveFunction()
        .then((r) => { out.saveTag = r.secretTag; })
        .catch((e) => { out.saveCode = e.code || 'ERROR'; out.saveError = e.message || String(e); }),
      window.LivingDocsAI.keyStatus()
        .then((r) => { out.gatewayTag = r.secretTag; out.gatewayVersion = r.version; out.keyStatus = r.keyStatus; applyKeyState(r.keys); })
        .catch((e) => { out.gatewayCode = e.code || 'ERROR'; out.gatewayError = e.message || String(e); })
    ]);
    state.keyStoreStatus = out.keyStatus || 'unknown';
    out.mismatch = Boolean(out.saveTag && out.gatewayTag && out.saveTag !== out.gatewayTag);
    out.ready = Boolean(out.saveTag && out.saveTag === out.gatewayTag);
    out.outdated = out.ready && out.gatewayVersion < LDF.GATEWAY_VERSION;
    return out;
  }

  async function checkAiFunctions() {
    if (!canUseZohoConnection()) return { status: 'error', detail: 'Open this widget inside Zoho CRM.' };
    const health = await aiFunctionHealth();
    if (health.gatewayError) return { status: 'error', detail: `${LDF.GATEWAY_FN} is not ready: ${health.gatewayError}` };
    if (health.saveError) return { status: 'error', detail: `${LDF.SAVE_FN} is not ready: ${health.saveError}` };
    if (health.mismatch) return { status: 'error', detail: 'The two AI functions hold different secrets. Install rewrites both, then the API keys are saved again.' };
    if (health.keyStatus === 'unreadable') return { status: 'error', detail: 'The stored API keys cannot be decrypted. Run Install, then save the API keys again.' };
    // An error, not a note: notes do not stop at the setup screen, so the admin would never see the Submit button.
    if (health.outdated) {
      return { status: 'error', detail: `${LDF.GATEWAY_FN} is an older version (${health.gatewayVersion} of ${LDF.GATEWAY_VERSION}). An administrator should press Submit once to update it; the saved keys are kept.` };
    }
    if (state.legacyKeys.anthropic || state.legacyKeys.cursor) {
      return { status: 'warn', detail: 'API keys are still in plain text on Living_Docs_Settings. An administrator should press Submit once to move them into the encrypted store.' };
    }
    return { status: 'ok', detail: `Installed. API keys are stored AES-encrypted in the Org Variable ${LDF.VAR_NAME} and never reach the browser.` };
  }

  async function findAiFunctions() {
    const catalog = await fetchFunctionCatalog(conn());
    const pick = name => catalog.find(fn => [fn.api_name, fn.name].some(v => String(v || '').toLowerCase() === name)) || null;
    return { save: pick(LDF.SAVE_FN), gateway: pick(LDF.GATEWAY_FN) };
  }

  // Multi Line ("textarea") so the encrypted value is not cut. Its value is "unset" until a key is saved.
  async function ensureKeyVariable(log) {
    let vars = [];
    try {
      const body = await crmGet('/crm/v8/settings/variables', { timeoutMs: 15000 });
      vars = Array.isArray(body.variables) ? body.variables : [];
    } catch (err) {
      log(`Org Variables could not be read: ${err.message || err}. Add ZohoCRM.settings.variables.ALL to "${conn()}".`, 'error');
      return false;
    }
    const found = vars.find(v => v.api_name === LDF.VAR_NAME);
    if (found) {
      if (found.type && !/textarea/i.test(found.type)) log(`${LDF.VAR_NAME} is a ${found.type} variable. Change it to Multi Line, or the encrypted key may be cut.`, 'warn');
      else log(`Org Variable ${LDF.VAR_NAME} exists.`, 'ok');
      return true;
    }
    let group = { api_name: 'General' };
    try {
      const body = await crmGet('/crm/v8/settings/variable_groups', { timeoutMs: 15000 });
      const groups = Array.isArray(body.variable_groups) ? body.variable_groups : [];
      const general = groups.find(g => /^general$/i.test(g.api_name || g.name || '')) || groups[0];
      if (general && general.id) group = { id: general.id };
    } catch (_) { /* "General" is the default group */ }
    log(`Creating Org Variable ${LDF.VAR_NAME}…`, 'info');
    try {
      const resp = await withHardTimeout(invokeZohoConnectionAPI(conn(), {
        endpoint: '/crm/v8/settings/variables',
        method: 'POST',
        payload: {
          variables: [{
            name: 'Living Docs LLM Key',
            api_name: LDF.VAR_NAME,
            type: 'textarea',
            variable_group: group,
            value: 'unset',
            description: `Encrypted AI API keys for Living Docs. Written only by ${LDF.SAVE_FN}.`
          }]
        }
      }), 20000, `Create ${LDF.VAR_NAME}`);
      const row = resp?.variables?.[0] || resp || {};
      if (row.code === 'SUCCESS' || row.status === 'success' || row.code === 'DUPLICATE_DATA') {
        log(`Org Variable ${LDF.VAR_NAME} created.`, 'ok');
        return true;
      }
      log(`Org Variable ${LDF.VAR_NAME} was not created: ${row.message || row.code || JSON.stringify(resp).slice(0, 200)}`, 'error');
    } catch (err) {
      log(`Org Variable ${LDF.VAR_NAME} was not created: ${err.message || err}`, 'error');
    }
    return false;
  }

  // Same multipart shape as the function update API. Zoho does not document create, so the function list
  // decides whether it worked; when it did not, setup shows the scripts to paste instead.
  async function createDelugeFunction(spec) {
    const url = `${getZohoApiDomain()}/crm/v8/settings/functions`;
    const metadata = {
      functions: [{
        display_name: spec.display,
        api_name: spec.name,
        name: spec.name,
        description: spec.description,
        category: 'standalone',
        language: 'deluge',
        return_type: 'string',
        params: [{ name: 'payload', type: 'STRING' }],
        _code: spec.script
      }]
    };
    const request = {
      url,
      method: 'POST',
      param_type: 2,
      CONTENT_TYPE: 'multipart',
      PARTS: [{ headers: { 'Content-Disposition': 'form-data; name="metadata"', 'Content-Type': 'application/json' }, content: metadata }],
      FILE: { fileParam: 'code', file: new File([spec.script], `${spec.name}.ds`, { type: 'text/plain' }) }
    };
    const startedAt = Date.now();
    let body = null;
    let reason = '';
    try {
      const raw = await withHardTimeout(ZOHO.CRM.CONNECTION.invoke(conn(), request), 60000, `Create ${spec.name}`);
      body = unwrapConnectionResponse(raw);
      // The request holds the secret, so only the function name is logged.
      debugLog('ok', conn(), 'POST', url, { request: { name: spec.name }, body, ms: Date.now() - startedAt });
    } catch (err) {
      reason = describeSdkError(err);
    }
    const row = body && Array.isArray(body.functions) ? body.functions[0] : body;
    if (row && (String(row.status || '').toLowerCase() === 'success' || row.code === 'SUCCESS')) return row;
    await sleep(1500);
    const found = await findAiFunctions().catch(() => ({}));
    if (found[spec.key]) return found[spec.key];
    throw new Error(reason || (row && (row.message || row.code)) || 'Zoho did not create the function');
  }

  async function installAiFunctions(log) {
    log(`Checking the AI functions ${LDF.SAVE_FN} and ${LDF.GATEWAY_FN}…`, 'info');
    if (!(await ensureKeyVariable(log))) return { ok: false };
    const health = await aiFunctionHealth();
    if (health.ready) {
      log('Both AI functions are installed and share the same secret.', 'ok');
      if (health.outdated) await upgradeGateway(health, log);
      return { ok: true, rewritten: false };
    }
    let existing = { save: null, gateway: null };
    try {
      existing = await findAiFunctions();
    } catch (err) {
      log(`Functions could not be listed: ${err.message || err}`, 'warn');
    }
    // Both exist and nothing says they differ, yet neither answers: REST API (OAuth 2.0) is usually still off.
    const notDeployed = [health.saveCode, health.gatewayCode].includes('NOT_DEPLOYED');
    if (existing.save && existing.gateway && !health.mismatch && !notDeployed) {
      log('Both AI functions exist but could not be called. Turn on REST API with OAuth 2.0 for each.', 'warn');
      return showAiFunctionsDialog({ restOnly: true, log });
    }

    const secret = LDF.randomSecret();
    const tag = await LDF.secretTagOf(secret);
    const specs = aiFunctionSpecs(secret, tag);
    const manual = [];
    for (const spec of specs) {
      const fn = existing[spec.key];
      try {
        if (fn) {
          await updateFunctionInCrm(fn, spec.script, 'Living Docs: new key-store secret');
          log(`${spec.name} updated with a new secret.`, 'ok');
        } else {
          await createDelugeFunction(spec);
          log(`${spec.name} created.`, 'ok');
        }
      } catch (err) {
        manual.push(spec);
        log(`${spec.name} could not be ${fn ? 'updated' : 'created'} from the widget: ${err.message || err}`, 'warn');
      }
    }
    const after = await aiFunctionHealth();
    if (!after.ready) {
      return showAiFunctionsDialog({ specs: manual.length ? manual : [], restOnly: !manual.length, log });
    }
    log('Both AI functions are ready. Keys saved under the old secret cannot be read, so they are stored again now.', 'ok');
    return { ok: true, rewritten: true };
  }

  // A newer gateway script is written with the secret the installed one already holds, so stored keys stay readable.
  async function upgradeGateway(health, log) {
    log(`Updating ${LDF.GATEWAY_FN} from version ${health.gatewayVersion} to ${LDF.GATEWAY_VERSION}…`, 'info');
    let fn = null;
    try {
      fn = (await findAiFunctions()).gateway;
    } catch (err) {
      log(`Functions could not be listed: ${err.message || err}`, 'warn');
    }
    if (!fn) {
      log(`${LDF.GATEWAY_FN} was not found in the function list, so it was not updated.`, 'warn');
      return false;
    }
    const download = await downloadFunctionSource(conn(), { id: fn.id, api_name: fn.api_name });
    const match = /^\s*secret\s*=\s*"([A-Za-z0-9]{32,})"\s*;/m.exec(download.source || '');
    const secret = match ? match[1] : '';
    const tag = secret ? await LDF.secretTagOf(secret) : '';
    if (!secret || tag !== health.gatewayTag) {
      log(`The secret in ${LDF.GATEWAY_FN} could not be read (${download.note || 'no match'}). It keeps working, but without the newest fixes.`, 'warn');
      return false;
    }
    const spec = aiFunctionSpecs(secret, tag).find(s => s.key === 'gateway');
    try {
      await updateFunctionInCrm(fn, spec.script, `Living Docs: gateway version ${LDF.GATEWAY_VERSION}`);
    } catch (err) {
      log(`${LDF.GATEWAY_FN} could not be updated from the widget: ${err.message || err}`, 'warn');
      return (await showAiFunctionsDialog({ specs: [spec], log })).ok;
    }
    const after = await aiFunctionHealth();
    if (after.ready && !after.outdated) {
      log(`${LDF.GATEWAY_FN} updated to version ${LDF.GATEWAY_VERSION}. The saved keys still work.`, 'ok');
      return true;
    }
    log(`${LDF.GATEWAY_FN} was written but still reports version ${after.gatewayVersion}.`, 'warn');
    return false;
  }

  function aiFunctionsDialogHtml(specs, restOnly, note) {
    const names = [LDF.SAVE_FN, LDF.GATEWAY_FN].map(n => `<code>${n}</code>`).join(' and ');
    const steps = restOnly
      ? `<ol class="helper-steps">
          <li>In Zoho CRM open <strong>Setup &gt; Developer Hub &gt; Functions</strong>.</li>
          <li>For ${names}: open the function's menu, choose <strong>REST API</strong>, turn on <strong>OAuth 2.0</strong> and save.</li>
        </ol>`
      : `<ol class="helper-steps">
          <li>In Zoho CRM open <strong>Setup &gt; Developer Hub &gt; Functions</strong> and click <strong>New Function</strong> for each script below (or open the existing one).</li>
          <li>Function name exactly as shown, category <strong>Standalone</strong>.</li>
          <li><strong>Edit Arguments</strong>: one argument named <code>payload</code>, type <strong>String</strong>. Return type <strong>String</strong>.</li>
          <li>Replace the body with the script, then <strong>Save</strong>.</li>
          <li>Open the function's menu, choose <strong>REST API</strong>, turn on <strong>OAuth 2.0</strong> and save.</li>
        </ol>`;
    const blocks = specs.map(spec => `
        <div class="helper-code-head"><span><code>${spec.name}</code></span>
          <span class="row gap-8">
            <button type="button" class="btn btn-ghost btn-sm" data-ai-fn-copy="${spec.key}:name">Copy name</button>
            <button type="button" class="btn btn-ghost btn-sm" data-ai-fn-copy="${spec.key}:code">Copy code</button>
          </span>
        </div>
        <pre class="helper-code">${escapeHtml(spec.script)}</pre>`).join('');
    return `
      <p>${restOnly
        ? `The widget calls ${names} as the signed-in user, which Zoho allows only when REST API is on.`
        : 'Zoho did not let the widget write these functions. Create them once by hand; the scripts already contain the connection name and a new random secret.'}</p>
      ${note ? `<div class="notice error">${escapeHtml(note)}</div>` : ''}
      ${steps}
      ${blocks}
      ${specs.length ? '<p class="muted small">Both scripts share one secret that exists only in these two functions. Do not paste them anywhere else. If you only paste one, the other must be the one the widget just wrote.</p>' : ''}`;
  }

  async function showAiFunctionsDialog({ specs = [], restOnly = false, log = () => {} }) {
    let note = '';
    for (;;) {
      const pending = confirmDialog({
        title: restOnly ? 'Turn on REST API for the AI functions' : 'One-time setup: AI functions',
        confirmLabel: 'Done, check again',
        html: aiFunctionsDialogHtml(specs, restOnly, note)
      });
      dom.modalBody.querySelectorAll('[data-ai-fn-copy]').forEach((btn) => {
        const [key, what] = btn.dataset.aiFnCopy.split(':');
        const spec = specs.find(s => s.key === key);
        if (spec) btn.addEventListener('click', () => copyText(what === 'name' ? spec.name : spec.script, btn, what === 'name' ? 'Copy name' : 'Copy code'));
      });
      if (!(await pending)) {
        log('AI functions are not ready yet. Press Submit again when they are.', 'warn');
        return { ok: false };
      }
      const health = await aiFunctionHealth();
      if (health.ready) {
        log('Both AI functions answer and share the same secret.', 'ok');
        return { ok: true, rewritten: specs.length > 0 };
      }
      note = health.mismatch
        ? 'The two functions still hold different secrets. Paste the script shown here, exactly as it is.'
        : `Still not callable: ${health.saveError || health.gatewayError || 'no answer from Zoho'}`;
    }
  }

  // Typed keys go to livingdocs_save_api_key; plain-text keys from an older settings record are moved the same way.
  async function storeKeys(log) {
    const domain = getZohoApiDomain();
    for (const provider of ['anthropic', 'cursor']) {
      const label = (AI_PROVIDER_DEFAULTS[provider] || {}).label || provider;
      const typed = state.pendingKeys[provider];
      const legacy = state.legacyKeys[provider];
      const key = typed || (keyInfo(provider).set ? '' : legacy);
      if (key) {
        try {
          const res = await window.LivingDocsAI.saveApiKey(provider, key, domain);
          applyKeyState(res.keys);
          log(`${label} API key stored encrypted in ${LDF.VAR_NAME}${typed ? '' : ' (moved from Living_Docs_Settings)'}.`, 'ok');
        } catch (err) {
          log(`${label} API key was not stored: ${err.message || err}`, 'error');
        }
      }
      if (provider === state.ai.provider && !keyInfo(provider).set) {
        log(`No ${label} API key is stored yet. Paste it on the AI provider tab, then press Submit.`, 'warn');
      }
    }
    state.pendingKeys = { anthropic: '', cursor: '' };
    // Blank the old fields only when every plain-text key is safely in the encrypted store.
    const legacyProviders = ['anthropic', 'cursor'].filter(p => state.legacyKeys[p]);
    state.clearLegacyKeys = legacyProviders.length > 0 && legacyProviders.every(p => keyInfo(p).set);
  }

  async function applyImproved(fn) {
    const r = fnReview(fn);
    const imp = r.improved;
    if (!imp) return;
    const blockers = applyBlockers(fn, r);
    if (blockers.length) { showToast(blockers[0], 'warning'); return; }
    const answer = await confirmDialog({
      title: 'Apply as the main function?',
      confirmLabel: 'Apply to CRM',
      requireAck: 'I reviewed the side-by-side changes',
      html: `
        <p>This replaces the code of <strong>${escapeHtml(fn.name || fn.api_name)}</strong> in Zoho CRM. Every workflow rule that calls it runs the new code right away.</p>
        <dl class="facts compact">
          <div><dt>Function</dt><dd>${escapeHtml(fn.api_name || fn.name || '')}</dd></div>
          <div><dt>Function ID</dt><dd>${escapeHtml(fn.id || 'unknown')}</dd></div>
          <div><dt>Changes</dt><dd>+${imp.diff.added} / −${imp.diff.removed} lines</dd></div>
          <div><dt>Backup</dt><dd>The current code is saved first</dd></div>
        </dl>
        ${reasonFieldHtml('Why is this change needed? For example: the invoice sync failed silently when the API returned an error.')}
        <label class="field"><span>Change note in Zoho</span><input type="text" id="modalChangelog" maxlength="200" value="Improved with Living Docs function review" /></label>
        <p class="muted small">If Zoho finds a compile error, nothing changes and the error is shown. The previous code is kept as a backup in this browser, and Zoho CRM keeps its own revision history.</p>`
    });
    if (!answer) return;
    await applySource(fn, imp.code, {
      reason: 'Before apply',
      changelog: answer.changelog,
      doneMessage: 'Function updated in CRM',
      changeType: imp.mode === 'model' ? 'Improved with AI' : 'Review notes added',
      changeReason: answer.reason,
      summary: imp.summary || [],
      aiLabel: imp.generatedBy || ''
    });
  }

  function reasonFieldHtml(placeholder) {
    return `<label class="field"><span>Reason for the change <span class="req">required</span></span><textarea id="modalReason" rows="3" maxlength="1500" data-required placeholder="${escapeHtml(placeholder)}"></textarea></label>`;
  }

  async function restoreBackup(fn, backupId) {
    const r = fnReview(fn);
    const backup = (r.backups || []).find(b => b.id === backupId) || (r.lastApply && r.lastApply.backupId === backupId ? r.lastApply.backup : null)
      || readLocalBackups(fn).find(b => b.id === backupId);
    if (!backup) { showToast('That version could not be found.', 'warning'); return; }
    if (!canUseZohoConnection()) { showToast('Open the widget inside Zoho CRM to restore versions.', 'warning'); return; }
    const diff = DR.diffLines(fn.source, backup.source);
    if (!diff.changed) { showToast('This version is the same as the current code.', 'warning'); return; }
    const when = formatDate(backup.at);
    const answer = await confirmDialog({
      title: 'Restore this version?',
      confirmLabel: 'Restore in CRM',
      html: `
        <p>The code of <strong>${escapeHtml(fn.name || fn.api_name)}</strong> is replaced with the version saved on ${escapeHtml(when)}. The current code is backed up first.</p>
        <dl class="facts compact">
          <div><dt>Changes</dt><dd>+${diff.added} / −${diff.removed} lines</dd></div>
          <div><dt>Saved</dt><dd>${escapeHtml((backup.where || []).join(' and ') || 'in this browser')}</dd></div>
        </dl>
        ${reasonFieldHtml('Why roll back? For example: the new version broke the Deals workflow.')}
        <label class="field"><span>Change note in Zoho</span><input type="text" id="modalChangelog" maxlength="200" value="${escapeHtml(`Restored the version from ${when}`)}" /></label>`
    });
    if (!answer) return;
    await applySource(fn, backup.source, {
      reason: 'Before restore',
      changelog: answer.changelog,
      doneMessage: 'Previous version restored',
      changeType: 'Restored earlier version',
      changeReason: answer.reason,
      summary: [`Restored the version saved on ${when}${backup.changelog ? ` (${backup.changelog})` : ''}.`]
    });
  }

  // ---------- Dialog, tooltip, selection ----------
  function confirmDialog({ title, html, confirmLabel = 'Confirm', requireAck = '' }) {
    return new Promise((resolve) => {
      dom.modalTitle.textContent = title;
      dom.modalBody.innerHTML = html + (requireAck ? `<label class="check-inline modal-ack"><input type="checkbox" id="modalAck" /> ${escapeHtml(requireAck)}</label>` : '');
      dom.modalConfirm.textContent = confirmLabel;
      dom.modalBackdrop.hidden = false;
      const ack = $('modalAck');
      const required = [...dom.modalBody.querySelectorAll('[data-required]')];
      const refresh = () => {
        dom.modalConfirm.disabled = (ack && !ack.checked) || required.some(el => el.value.trim().length < 3);
      };
      refresh();
      if (ack) ack.addEventListener('change', refresh);
      required.forEach(el => el.addEventListener('input', refresh));
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      const onBackdrop = (e) => { if (e.target === dom.modalBackdrop) close(null); };
      function close(result) {
        dom.modalBackdrop.hidden = true;
        dom.modalConfirm.onclick = null;
        dom.modalCancel.onclick = null;
        document.removeEventListener('keydown', onKey);
        dom.modalBackdrop.removeEventListener('mousedown', onBackdrop);
        resolve(result);
      }
      document.addEventListener('keydown', onKey);
      dom.modalBackdrop.addEventListener('mousedown', onBackdrop);
      dom.modalCancel.onclick = () => close(null);
      dom.modalConfirm.onclick = () => {
        if (dom.modalConfirm.disabled) return;
        const note = $('modalChangelog');
        const reasonEl = $('modalReason');
        close({ changelog: note ? note.value.trim() : '', reason: reasonEl ? reasonEl.value.trim() : '' });
      };
      setTimeout(() => (required[0] || ack || dom.modalConfirm).focus(), 50);
    });
  }

  function showIssueTip(lineEl, clientX) {
    const card = lineEl.closest('.fn-card[data-fn]');
    const r = card && state.fnReviews[card.dataset.fn];
    if (!r || !r.result) return;
    const line = Number(lineEl.dataset.line);
    const list = r.result.issues.filter(i => i.line === line);
    if (!list.length) { hideIssueTip(); return; }
    tipLine = lineEl;
    const tip = dom.issueTip;
    tip.innerHTML = list.map(i => `
      <div class="tip-item">
        <div class="tip-head"><span class="sev-badge sev-${i.severity}">${SEVERITY_LABEL[i.severity]}</span><span>${escapeHtml(i.title)}</span></div>
        <div class="tip-msg">${escapeHtml(i.message)}</div>
        <div class="tip-fix"><span>Fix</span>${escapeHtml(i.fix)}</div>
      </div>`).join('');
    tip.hidden = false;
    const rect = lineEl.getBoundingClientRect();
    const x = typeof clientX === 'number' ? clientX : rect.left + 80;
    const left = Math.min(Math.max(8, x - 24), window.innerWidth - tip.offsetWidth - 8);
    let top = rect.bottom + 6;
    if (top + tip.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - tip.offsetHeight - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideIssueTip() {
    tipLine = null;
    dom.issueTip.hidden = true;
  }

  function scrollToIssueLine(card, line) {
    const el = card.querySelector(`.code.annotated .ln[data-line="${line}"]`);
    if (!el) return;
    const box = el.closest('.code');
    box.scrollTop = el.offsetTop - box.clientHeight / 2;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => showIssueTip(el), 150);
  }

  function onCodeSelection() {
    const btn = dom.maskSelBtn;
    const sel = window.getSelection();
    const text = sel && sel.rangeCount ? sel.toString() : '';
    const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
    const card = node && node.closest('.fn-card[data-fn]');
    if (!text.trim() || text.includes('\n') || text.length > 300 || !card || !node.closest('.code')) {
      btn.hidden = true;
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    btn.dataset.fn = card.dataset.fn;
    btn.dataset.value = text.trim();
    btn.style.top = `${rect.bottom + window.scrollY + 6}px`;
    btn.style.left = `${rect.left + window.scrollX}px`;
    btn.hidden = false;
  }

  function bindFunctionReviewEvents() {
    dom.reviewBody.addEventListener('click', (e) => {
      const more = e.target.closest('.review-more');
      if (!more) return;
      const card = more.closest('.review-crit');
      const body = card.querySelector('.review-crit-body');
      const open = !card.classList.contains('expanded');
      card.classList.toggle('expanded', open);
      if (open) {
        body.style.maxHeight = '';
        more.textContent = 'See less';
      } else {
        more.textContent = 'See more';
        fitReviewCards();
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    dom.reviewBody.addEventListener('click', (e) => {
      const card = e.target.closest('.fn-card[data-fn]');
      if (!card) return;
      const fn = findReviewFunction(card.dataset.fn);
      if (!fn) return;
      const r = fnReview(fn);

      const tab = e.target.closest('[data-fn-tab]');
      if (tab) {
        r.tab = tab.dataset.fnTab;
        hideIssueTip();
        rerenderFnCard(fn);
        if (r.tab === 'history' && !r.backups && !r.backupsLoading) loadBackups(fn);
        return;
      }
      const issue = e.target.closest('.issue-item[data-line]');
      if (issue) { scrollToIssueLine(card, Number(issue.dataset.line)); return; }

      const actEl = e.target.closest('[data-act]');
      if (!actEl || actEl.type === 'checkbox') return;
      const act = actEl.dataset.act;
      if (act === 'improve') improveFunction(fn);
      else if (act === 'apply') applyImproved(fn);
      else if (act === 'discard') { r.improved = null; r.improveError = ''; rerenderFnCard(fn); }
      else if (act === 'copy-improved' && r.improved) copyText(r.improved.code, actEl, 'Copy improved code');
      else if (act === 'restore') restoreBackup(fn, actEl.dataset.id);
      else if (act === 'compare') { r.compareId = r.compareId === actEl.dataset.id ? null : actEl.dataset.id; rerenderFnCard(fn); }
      else if (act === 'copy-backup') {
        const b = (r.backups || []).find(x => x.id === actEl.dataset.id);
        if (b) copyText(b.source, actEl, 'Copy');
      } else if (act === 'add-manual') addManualSecret(fn, card.querySelector('.mask-input')?.value);
      else if (act === 'remove-manual') {
        const entry = maskEntry(fn, actEl.dataset.ph);
        if (entry) r.manual = r.manual.filter(v => v !== entry.value);
        masksChanged(fn, 'Value removed from the mask. The prompt was rebuilt.');
      } else if (act === 'ignore') {
        const entry = maskEntry(fn, actEl.dataset.ph);
        if (entry && !r.ignore.includes(entry.value)) r.ignore.push(entry.value);
        masksChanged(fn, `${entry ? entry.placeholder : 'The value'} will be sent as is. The prompt was rebuilt.`);
      } else if (act === 'unignore') {
        r.ignore.splice(Number(actEl.dataset.idx), 1);
        masksChanged(fn, 'Value masked again. The prompt was rebuilt.');
      }
    });

    dom.reviewBody.addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'changes-only') return;
      const card = e.target.closest('.fn-card[data-fn]');
      const fn = card && findReviewFunction(card.dataset.fn);
      if (!fn) return;
      fnReview(fn).changesOnly = e.target.checked;
      rerenderFnCard(fn);
    });

    dom.reviewBody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.classList.contains('mask-input')) return;
      const card = e.target.closest('.fn-card[data-fn]');
      const fn = card && findReviewFunction(card.dataset.fn);
      if (fn) addManualSecret(fn, e.target.value);
    });

    dom.reviewBody.addEventListener('mouseover', (e) => {
      const ln = e.target.closest('.code.annotated .ln.has-issue');
      if (ln && ln !== tipLine) showIssueTip(ln, e.clientX);
    });
    dom.reviewBody.addEventListener('mouseout', (e) => {
      if (tipLine && !(e.relatedTarget && tipLine.contains(e.relatedTarget))) hideIssueTip();
    });
    window.addEventListener('scroll', hideIssueTip, true);

    dom.reviewBody.addEventListener('mouseup', () => setTimeout(onCodeSelection, 0));
    document.addEventListener('mousedown', (e) => {
      if (e.target !== dom.maskSelBtn) dom.maskSelBtn.hidden = true;
    });
    dom.maskSelBtn.addEventListener('mousedown', e => e.preventDefault());
    dom.maskSelBtn.addEventListener('click', () => {
      const fn = findReviewFunction(dom.maskSelBtn.dataset.fn);
      dom.maskSelBtn.hidden = true;
      if (fn) addManualSecret(fn, dom.maskSelBtn.dataset.value);
      window.getSelection()?.removeAllRanges();
    });
  }

  function renderReview() {
    const list = state.reviewWorkflows;
    const wf = list.find(w => String(w.id) === String(state.activeReviewId)) || list[0];
    if (!wf) {
      dom.reviewBody.innerHTML = '<div class="notice error">No workflow rule loaded.</div>';
      return;
    }
    dom.reviewTabs.innerHTML = list.length > 1 ? list.map(w => `
      <button class="review-tab ${w.id === wf.id ? 'active' : ''}" data-review-id="${escapeHtml(w.id)}">
        ${escapeHtml(w.name)}${(w.function_code || []).length ? `<span class="pill pill-blue">${w.function_code.length}</span>` : ''}
      </button>`).join('') : '';

    const modified = [formatDate(wf.modified_time), wf.modified_by && wf.modified_by.name].filter(Boolean).join(' by ');
    const lastDoc = state.docLog && state.docLog.byItem[String(wf.id)];
    const lastDocHtml = lastDoc
      ? `v${escapeHtml(lastDoc.Doc_Version || 1)} · ${escapeHtml(formatDate(lastDoc.Generated_At || lastDoc.Created_Time))}`
      : 'Not yet';
    dom.reviewBody.innerHTML = `
      <div class="review-grid">
        <div class="review-side">
          <div class="card">
            <div class="card-head"><h3>${escapeHtml(wf.name)}</h3></div>
            <dl class="facts">
              <div><dt>Module</dt><dd>${escapeHtml(moduleLabel(wf.module))}</dd></div>
              <div><dt>Trigger</dt><dd>${escapeHtml(triggerLabel(wf.trigger_type))}</dd></div>
              <div><dt>Status</dt><dd>${wf.status === 'active' ? '<span class="pill pill-green">Active</span>' : '<span class="pill pill-gray">Inactive</span>'}</dd></div>
              <div><dt>Functions</dt><dd>${(wf.function_code || []).length}</dd></div>
              ${modified ? `<div><dt>Last modified</dt><dd>${escapeHtml(modified)}</dd></div>` : ''}
              ${state.docLog && state.docLog.ok ? `<div><dt>Last documented</dt><dd>${lastDocHtml}</dd></div>` : ''}
            </dl>
          </div>
          ${wf.description ? `<div class="card"><div class="card-head"><h3>Description</h3></div><p class="condition">${escapeHtml(wf.description)}</p></div>` : ''}
        </div>
        <div class="review-main">
          <div class="card review-crit">
            <div class="card-head"><h3>Criteria and actions</h3></div>
            <div class="review-crit-body">${renderConditions(wf)}</div>
            <button type="button" class="review-more" hidden>See more</button>
          </div>
        </div>
      </div>
      <div class="card fn-section">
        <div class="card-head"><h3>Function code</h3><span class="muted small">Secrets are masked and the code is checked before anything is sent to the AI</span></div>
        ${renderFunctions(wf)}
      </div>`;
    fitReviewCards();
    showPromptFor(wf);
  }

  // The rule card and the criteria card end on the same line. A criteria card taller than the rule card is
  // cut to its height and gets "See more"; on narrow screens the cards stack and nothing is cut.
  function fitReviewCards() {
    const side = dom.reviewBody.querySelector('.review-side');
    const card = dom.reviewBody.querySelector('.review-crit');
    if (!side || !card) return;
    const body = card.querySelector('.review-crit-body');
    const more = card.querySelector('.review-more');
    if (card.classList.contains('expanded')) return;
    body.style.maxHeight = '';
    card.classList.remove('clamped');
    more.hidden = true;
    const sideBySide = Math.abs(side.getBoundingClientRect().top - card.getBoundingClientRect().top) < 4;
    if (!sideBySide) return;
    // The grid stretches the rule column to the criteria card, so its own height is read without stretching.
    side.style.alignSelf = 'start';
    const sideHeight = side.offsetHeight;
    side.style.alignSelf = '';
    const room = sideHeight - (card.offsetHeight - body.offsetHeight);
    // Only cut when it saves real space, so a card a few pixels too tall is shown whole.
    if (body.scrollHeight <= room + 40) return;
    card.classList.add('clamped');
    more.hidden = false;
    body.style.maxHeight = `${Math.max(120, room - more.offsetHeight)}px`;
  }

  let reviewFitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(reviewFitTimer);
    reviewFitTimer = setTimeout(fitReviewCards, 150);
  });

  function activeReviewWorkflow() {
    const list = state.reviewWorkflows;
    return list.find(w => String(w.id) === String(state.activeReviewId)) || list[0] || null;
  }

  function showPromptFor(wf) {
    const p = (wf && state.prompts[wf.id]) || { system: '', user: '' };
    dom.promptSystem.value = p.system || '';
    dom.promptUser.value = p.user || '';
    updatePromptStats();
  }

  // One prompt per rule, so every rule is documented by its own AI call.
  async function buildPrompt() {
    const list = state.reviewWorkflows;
    if (!list.length) return;
    setBusy(dom.btnRebuildPrompt, true);
    dom.btnGenerate.disabled = true;
    try {
      list.forEach((wf) => {
        const resp = window.LivingDocsAI.buildWorkflowPrompt(maskedWorkflowsForAI([wf]), promptSnapshot(), state.audience, state.docDetail);
        state.prompts[wf.id] = { system: resp.system || '', user: resp.user || '', maxTokens: resp.maxTokens };
      });
      showPromptFor(activeReviewWorkflow());
      const { total, withSource } = functionSummary(list);
      const masked = maskedValueCount();
      const docs = list.length > 1 ? ` Each of the ${list.length} rules gets its own document.` : '';
      dom.reviewStatus.textContent = total
        ? `${withSource} of ${total} function${total === 1 ? '' : 's'} loaded with code${masked ? `, ${plural(masked, 'secret value')} masked` : ''}.${docs} Check the criteria and code, then generate.`
        : `No custom functions on the selected rules. The document covers criteria and actions.${docs}`;
      dom.btnGenerate.textContent = list.length > 1 ? `Generate ${list.length} documents` : 'Generate documentation';
      dom.btnGenerate.disabled = false;
    } catch (err) {
      dom.reviewStatus.textContent = `The prompt could not be built: ${err.message || err}`;
    } finally {
      setBusy(dom.btnRebuildPrompt, false);
    }
  }

  function updatePromptStats() {
    const chars = dom.promptSystem.value.length + dom.promptUser.value.length;
    const wf = state.reviewWorkflows.length > 1 ? activeReviewWorkflow() : null;
    const forRule = wf ? `For ${wf.name}: ` : '';
    dom.promptStats.textContent = chars
      ? `${forRule}${chars.toLocaleString()} characters, about ${Math.ceil(chars / 4).toLocaleString()} tokens`
      : 'Built from the rule and its function code';
  }

  function promptAsText() {
    return `SYSTEM:\n${dom.promptSystem.value.trim()}\n\nUSER:\n${dom.promptUser.value.trim()}`;
  }

  // ==========================================
  // STEP 4: DOCUMENT
  // ==========================================
  function nextDocVersion(wf) {
    return Number(state.docLog.byItem?.[String(wf.id)]?.Doc_Version || 0) + 1;
  }

  function documentFileName(wf, version, at) {
    const slug = String(wf.name).replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'Workflow';
    const date = (at ? new Date(at) : new Date()).toISOString().slice(0, 10);
    return `Workflow_Documentation_${slug}_v${version || nextDocVersion(wf)}_${date}.pdf`;
  }

  function setDocButtons(enabled) {
    [dom.btnCopyMd, dom.btnDownloadMd, dom.btnDownloadPdf].forEach((btn) => { btn.disabled = !enabled; });
    renderSaveButton();
  }

  function activeDoc() {
    return state.docs.find(d => String(d.wf.id) === String(state.activeDocId)) || state.docs[0] || null;
  }

  function docStateLabel(doc) {
    if (doc.status === 'pending') return '<span class="pill pill-blue">Writing…</span>';
    if (doc.status === 'error') return '<span class="pill pill-red">Failed</span>';
    if (doc.saving) return '<span class="pill pill-blue">Saving…</span>';
    if (doc.saved && doc.saved.ok) return '<span class="pill pill-green">Saved</span>';
    if (doc.saved && !doc.saved.ok) return '<span class="pill pill-amber">Not saved</span>';
    return '<span class="pill pill-gray">Ready</span>';
  }

  function renderDocs() {
    const docs = state.docs;
    const doc = activeDoc();
    dom.docTabs.innerHTML = docs.length > 1 ? docs.map(d => `
      <button class="review-tab ${doc && d.wf.id === doc.wf.id ? 'active' : ''}" data-doc-id="${escapeHtml(d.wf.id)}">
        ${escapeHtml(d.wf.name)}${docStateLabel(d)}
      </button>`).join('') : '';
    dom.docNotice.hidden = true;
    if (!doc) {
      dom.docView.innerHTML = '';
      dom.docView.dataset.key = '';
      setDocButtons(false);
      return;
    }
    const finished = docs.filter(d => d.status !== 'pending').length;
    const progress = docs.length > 1 ? ` ${finished} of ${docs.length} documents finished.` : '';
    const key = `${doc.wf.id}:${doc.status}:${doc.generated ? doc.generated.at : ''}`;
    const redraw = dom.docView.dataset.key !== key;
    dom.docView.dataset.key = key;
    if (!redraw && doc.status === 'done') {
      dom.docStatus.textContent = `${doc.wf.name}: written by ${doc.generated.generatedBy}${doc.tokens}.${progress} Check the preview, then save it.`;
      if (doc.notes.length) {
        dom.docNotice.textContent = doc.notes.join(' ');
        dom.docNotice.hidden = false;
      }
      setDocButtons(true);
      return;
    }
    if (doc.status === 'pending') {
      const words = doc.partial ? doc.partial.trim().split(/\s+/).length : 0;
      dom.docStatus.textContent = `${aiName()} is writing the documentation for ${doc.wf.name}…${words ? ` ${words.toLocaleString()} words so far.` : ''}${progress}`;
      // The text so far is shown as it arrives, so the page never sits on a spinner.
      dom.docView.innerHTML = doc.partial
        ? renderMarkdown(window.LivingDocsAI.cleanMarkdown(doc.partial)) + loadingBlock('Still writing…')
        : loadingBlock(`Waiting for ${aiName()}'s first lines…`);
    } else if (doc.status === 'error') {
      dom.docStatus.textContent = `The document for ${doc.wf.name} could not be written.${progress}`;
      dom.docView.innerHTML = `<div class="notice error">${escapeHtml(doc.error)}</div>
        <button class="btn btn-secondary btn-sm" data-doc-retry="${escapeHtml(doc.wf.id)}">Try this rule again</button>`;
      const retry = dom.docView.querySelector('[data-doc-retry]');
      if (retry) retry.addEventListener('click', () => retryDocument(doc));
    } else {
      dom.docStatus.textContent = `${doc.wf.name}: written by ${doc.generated.generatedBy}${doc.tokens}.${progress} Check the preview, then save it.`;
      dom.docView.innerHTML = documentFlowSection(doc.wf) + renderMarkdown(doc.generated.markdown);
      if (doc.notes.length) {
        dom.docNotice.textContent = doc.notes.join(' ');
        dom.docNotice.hidden = false;
      }
    }
    setDocButtons(doc.status === 'done');
  }

  async function writeDocument(doc, entries) {
    const p = state.prompts[doc.wf.id] || {};
    const system = scrubIdsForAI(DR.scrubText(String(p.system || '').trim(), entries));
    const user = scrubIdsForAI(DR.scrubText(String(p.user || '').trim(), entries));
    try {
      const resp = await window.LivingDocsAI.callAi(currentAiConfig(), {
        system,
        user,
        onProgress: ({ text }) => {
          doc.partial = text;
          if (activeDoc() === doc) renderDocs();
        }
      });
      doc.partial = '';
      const markdown = window.LivingDocsAI.cleanMarkdown(resp.text);
      if (!markdown) throw new Error(`${resp.label} did not return a document.`);
      const at = new Date().toISOString();
      const version = nextDocVersion(doc.wf);
      doc.generated = {
        markdown,
        model: resp.model || '',
        generatedBy: `${resp.label} (${resp.model})`,
        at,
        version,
        fileName: documentFileName(doc.wf, version, at)
      };
      doc.tokens = resp.tokens_out ? `, ${Number(resp.tokens_in || 0).toLocaleString()} tokens in and ${Number(resp.tokens_out).toLocaleString()} out` : '';
      doc.notes = [];
      if (resp.redacted) doc.notes.push(`The final check replaced ${plural(resp.redacted, 'credential or ID')} in the prompt before sending it.`);
      if (entries.length && /\{\{[A-Z0-9_]+\}\}/.test(markdown)) {
        doc.notes.push('Secrets from the function code stay masked in this document, for example {{TOKEN_1}}, because the PDF is attached to a CRM record.');
      }
      doc.status = 'done';
    } catch (err) {
      doc.status = 'error';
      doc.error = err.message || String(err);
    }
  }

  // Loops over the reviewed rules and writes one document per rule, MAX_BATCH at a time. Finished documents are saved to CRM one by one.
  async function generateDocument() {
    const list = state.reviewWorkflows.slice(0, MAX_BATCH);
    if (!list.length) return;
    const empty = list.find(wf => !String(state.prompts[wf.id]?.user || '').trim());
    if (empty) {
      showToast(`The prompt for ${empty.name} is empty. Use Reset prompt to rebuild it.`, 'warning');
      return;
    }
    if (!(await ensureAiConfigured('generate documentation'))) return;
    state.moduleRun = null;
    const docs = list.map(wf => ({ wf, status: 'pending', generated: null, saved: null, saving: false, error: '', notes: [], tokens: '' }));
    state.docs = docs;
    state.activeDocId = docs[0].wf.id;
    limitSteps(4);
    goToStep(4);
    renderDocs();
    renderSaveCard();
    const entries = allMaskEntries();
    let saves = Promise.resolve();
    await mapPool(docs, MAX_BATCH, async (doc) => {
      await writeDocument(doc, entries);
      if (state.docs !== docs) return;
      renderDocs();
      if (doc.status === 'done') saves = saves.then(() => saveDoc(doc));
    });
    await saves;
    if (state.docs !== docs) return;
    finishRun(docs);
  }

  async function retryDocument(doc) {
    const docs = state.docs;
    Object.assign(doc, { status: 'pending', error: '', generated: null, saved: null, notes: [], tokens: '' });
    renderDocs();
    await writeDocument(doc, allMaskEntries());
    if (state.docs !== docs) return;
    renderDocs();
    if (state.moduleRun) {
      renderSaveCard();
      finishModuleRun(docs);
      return;
    }
    if (doc.status === 'done') await saveDoc(doc);
    finishRun(docs);
  }

  function finishRun(docs) {
    if (docs.some(d => d.status === 'pending')) return;
    limitSteps(5);
    renderSaveButton();
    renderSaveCard();
    const written = docs.filter(d => d.status === 'done');
    const saved = written.filter(d => d.saved && d.saved.ok).length;
    const failed = docs.length - written.length;
    const parts = [`${plural(written.length, 'document')} written`, `${saved} saved to CRM`];
    if (failed) parts.push(`${failed} failed`);
    showToast(`${parts.join(', ')}.`, failed || saved < written.length ? 'warning' : 'success');
  }

  let pdfQueue = Promise.resolve();
  // html2pdf renders through one hidden sheet at a time, so PDFs are made one after another.
  function docPdfBytes(doc) {
    if (!doc || !doc.generated) return Promise.reject(new Error('Generate the document first.'));
    if (doc.generated.pdfBytes) return Promise.resolve(doc.generated.pdfBytes);
    const job = pdfQueue.then(async () => {
      if (!doc.generated.pdfBytes) doc.generated.pdfBytes = await renderPdfBytes(doc);
      return doc.generated.pdfBytes;
    });
    pdfQueue = job.catch(() => null);
    return job;
  }

  async function downloadPdf(doc) {
    if (!doc || !doc.generated) return;
    setBusy(dom.btnDownloadPdf, true);
    try {
      downloadPdfBytes(await docPdfBytes(doc), doc.generated.fileName);
    } catch (err) {
      showToast(err.message || String(err), 'error');
    } finally {
      setBusy(dom.btnDownloadPdf, false);
      dom.btnDownloadPdf.disabled = !(activeDoc() && activeDoc().generated);
    }
  }

  function downloadMarkdown(doc) {
    if (!doc || !doc.generated) return;
    const blob = new Blob([doc.generated.markdown], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = doc.generated.fileName.replace(/\.pdf$/, '.md');
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let list = null;
    let code = null;
    let table = null;
    const inline = (text) => escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    const closeList = () => {
      if (list) { out.push(`</${list}>`); list = null; }
    };
    const closeTable = () => {
      if (!table) return;
      const [head, ...body] = table;
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      table = null;
    };
    const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

    lines.forEach((line) => {
      const fence = /^\s*(```|~~~)/.test(line);
      if (code !== null) {
        if (fence) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
        else code.push(line);
        return;
      }
      if (fence) { closeList(); closeTable(); code = []; return; }
      if (/^\s*\|/.test(line)) {
        closeList();
        if (/^\s*\|?\s*:?-{2,}/.test(line) && /^[\s|:-]+$/.test(line)) return;
        (table = table || []).push(cells(line));
        return;
      }
      closeTable();
      if (!line.trim()) { closeList(); return; }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length, 3);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        return;
      }
      const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        const kind = /\d/.test(item[1]) ? 'ol' : 'ul';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline(item[2])}</li>`);
        return;
      }
      closeList();
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); return; }
      if (/^\s*>/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); return; }
      out.push(`<p>${inline(line)}</p>`);
    });
    if (code !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    closeList();
    closeTable();
    return out.join('') || '<p class="muted">The model returned no text.</p>';
  }

  // ==========================================
  // STEP 5: SAVE TO CRM
  // ==========================================
  function writtenDocs() {
    return state.docs.filter(d => d.status === 'done');
  }

  function renderSaveButton() {
    const btn = dom.btnToSave;
    const written = writtenDocs();
    const run = state.moduleRun;
    if (run) {
      const pending = state.docs.some(d => d.status === 'pending');
      btn.disabled = !written.length || pending;
      btn.textContent = run.saving ? 'Saving to CRM…'
        : run.saved && run.saved.ok ? 'View saved record'
          : run.saved && run.saved.log && !run.saved.log.pending ? 'Save to CRM again'
            : 'Save module document';
      return;
    }
    btn.disabled = !written.length;
    if (!written.length) { btn.textContent = 'Save to CRM'; return; }
    if (written.some(d => d.saving)) btn.textContent = 'Saving to CRM…';
    else if (written.every(d => d.saved && d.saved.ok)) btn.textContent = 'View saved records';
    else if (written.some(d => d.saved && !d.saved.ok)) btn.textContent = 'Save to CRM again';
    else btn.textContent = 'Save to CRM';
  }

  async function onSaveButton() {
    if (state.moduleRun) {
      const run = state.moduleRun;
      limitSteps(5);
      goToStep(5);
      if (!(run.saved && run.saved.ok) && !run.saving) await saveModuleRun();
      return;
    }
    const written = writtenDocs();
    if (written.length && written.every(d => d.saved && d.saved.ok)) {
      limitSteps(5);
      goToStep(5);
      return;
    }
    saveDocumentToCrm();
  }

  // Saves every written document that is not in CRM yet, one after another, then opens the save step.
  async function saveDocumentToCrm() {
    for (const doc of writtenDocs()) {
      if (!(doc.saved && doc.saved.ok)) await saveDoc(doc);
    }
    limitSteps(5);
    goToStep(5);
  }

  async function saveDoc(doc) {
    if (!doc.generated || doc.saving) return;
    const docs = state.docs;
    doc.saving = true;
    doc.saved = { log: { pending: true } };
    renderDocs();
    renderSaveButton();
    renderSaveCard();
    let log;
    try {
      log = await logDocumentation(doc, await docPdfBytes(doc));
    } catch (err) {
      log = { ok: false, rows: [], message: err.message || String(err) };
    } finally {
      doc.saving = false;
    }
    doc.saved = { ok: log.ok, message: log.message, log, at: new Date() };
    if (state.docs !== docs) return;
    renderDocs();
    renderSaveButton();
    renderSaveCard();
  }

  function openCrmRecord(entity, id) {
    if (typeof ZOHO === 'undefined' || !ZOHO.CRM?.UI?.Record?.open) return;
    ZOHO.CRM.UI.Record.open({ Entity: entity, RecordID: id, Target: '_blank' }).catch(() => null);
  }

  function renderDocLogResult(log) {
    if (!log) return '';
    if (log.pending) return `<div class="doc-log">${loadingBlock(`Creating the PDF and writing ${logModuleApi('documents')}…`)}</div>`;
    const rows = (log.rows || []).map(r => `
      <li class="${r.ok ? 'ok' : 'failed'}">
        <span class="doc-log-name">${escapeHtml(r.label)}</span>
        <span class="muted small">${escapeHtml(r.type)} · ${escapeHtml(r.action === 'Updated' ? `updated to v${r.version}` : `created v${r.version}`)}</span>
        ${r.saved ? `<span class="pill ${r.action === 'Updated' ? 'pill-blue' : 'pill-green'}">${escapeHtml(r.action)}</span>` : `<span class="pill pill-red" title="${escapeHtml(r.message)}">Not saved</span>`}
        ${r.saved ? (r.attached ? '<span class="pill pill-green">PDF attached</span>' : `<span class="pill pill-red" title="${escapeHtml(r.message)}">PDF not attached</span>`) : ''}
        ${r.id && r.saved ? docRecordLink({ id: r.id, Doc_Version: r.version }) : ''}
      </li>`).join('');
    return `
      <div class="doc-log">
        <div class="doc-log-head">
          <strong>Documentation records</strong>
          <span class="muted small">${escapeHtml(log.entity || logModuleApi('documents'))}</span>
        </div>
        ${rows ? `<ul class="doc-log-list">${rows}</ul>` : ''}
        ${log.ok ? '' : `<div class="notice warning">${escapeHtml(log.message || 'Some records were not saved.')}</div>`}
      </div>`;
  }

  function renderSaveCard() {
    if (state.moduleRun) {
      renderModuleSaveCard();
      return;
    }
    const docs = state.docs;
    const entity = logModuleApi('documents');
    const written = docs.filter(d => d.status === 'done');
    const busy = docs.some(d => d.status === 'pending' || d.saving);
    const allSaved = written.length > 0 && written.length === docs.length && written.every(d => d.saved && d.saved.ok);
    const docBlocks = docs.map((d) => {
      const s = d.saved || {};
      const status = d.status === 'pending' ? 'Being written…'
        : d.status === 'error' ? `Not written: ${d.error}`
          : d.saving || (s.log && s.log.pending) ? 'Saving to CRM…'
            : s.ok ? 'Saved to CRM' : s.log ? `Not saved: ${s.message || 'CRM did not accept the record.'}` : 'Waiting to be saved';
      return `
        <div class="save-doc">
          <div class="save-meta">
            <div><span>Workflow rule</span><span>${escapeHtml(d.wf.name)}</span></div>
            ${d.generated ? `<div><span>File</span><span>${escapeHtml(d.generated.fileName)}</span></div>` : ''}
            ${d.generated ? `<div><span>Generated by</span><span>${escapeHtml(d.generated.generatedBy || '')}</span></div>` : ''}
            <div><span>Status</span><span>${escapeHtml(status)}</span></div>
          </div>
          ${s.log && !s.log.pending ? renderDocLogResult(s.log) : ''}
          ${d.generated ? `<div class="save-actions">
            ${s.log && !s.log.pending && !s.ok && !d.saving ? `<button class="btn btn-primary btn-sm" data-save-action="retry" data-doc="${escapeHtml(d.wf.id)}">Try again</button>` : ''}
            <button class="btn btn-secondary btn-sm" data-save-action="download" data-doc="${escapeHtml(d.wf.id)}">Download PDF</button>
          </div>` : ''}
        </div>`;
    }).join('');
    const head = busy ? `
      <h2>Saving to CRM</h2>
      <p class="muted">Each rule's document is written, turned into a PDF, and saved as its own record in ${escapeHtml(entity)}.</p>`
      : allSaved ? `
      <div class="save-icon ok">${ICON.check.replace('<svg ', '<svg width="26" height="26" ')}</div>
      <h2>Saved to CRM</h2>
      <p class="muted">Each workflow rule has one record in ${escapeHtml(entity)}, named after the workflow. Saving again updates that record to the next version and attaches the new PDF (v1, v2, v3 and so on), so earlier versions stay in its attachments.</p>`
        : `
      <div class="save-icon error">${ICON.cross.replace('<svg ', '<svg width="24" height="24" ')}</div>
      <h2>${docs.length > 1 ? 'Some documents were not saved to CRM' : 'The document was not saved to CRM'}</h2>
      <p class="muted">Check the details below and try again.</p>`;
    dom.saveCard.innerHTML = `${head}<div class="save-docs">${docBlocks}</div>`;
    dom.saveCard.querySelectorAll('[data-save-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const doc = state.docs.find(d => String(d.wf.id) === btn.dataset.doc);
        if (!doc) return;
        if (btn.dataset.saveAction === 'download') downloadPdf(doc);
        if (btn.dataset.saveAction === 'retry') saveDoc(doc);
      });
    });
    dom.saveCard.querySelectorAll('[data-open-doc]').forEach((btn) => {
      btn.addEventListener('click', () => openCrmRecord(entity, btn.dataset.openDoc));
    });
  }

  function startOver() {
    state.selectedWorkflowIds.clear();
    state.reviewWorkflows = [];
    state.docs = [];
    state.prompts = {};
    state.moduleRun = null;
    limitSteps(2);
    renderWorkflowTable();
    goToStep(2);
  }

  // ==========================================
  // MODULE MASTER DOCUMENT
  // ==========================================
  // Every workflow rule of one module is written by its own AI call (MAX_BATCH at a time), then all of
  // them go into one PDF on a single "<Module>_Master_Document" record. Later runs update that record
  // and attach the next version's PDF.
  const moduleDocItemId = module => `module:${module}`;

  function moduleDocName(module) {
    const slug = String(moduleLabel(module) || module).replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return `${slug || module}_Master_Document`;
  }

  function nextModuleVersion(module) {
    return Number(state.docLog.byItem?.[moduleDocItemId(module)]?.Doc_Version || 0) + 1;
  }

  function moduleFileName(module, version, at) {
    return `${moduleDocName(module)}_v${version}_${new Date(at || Date.now()).toISOString().slice(0, 10)}.pdf`;
  }

  async function loadModuleWorkflows(rules, onProgress) {
    const hydrated = new Array(rules.length);
    let done = 0;
    await mapPool(rules.map((wf, i) => ({ wf, i })), 4, async ({ wf, i }) => {
      hydrated[i] = await hydrateWorkflowRecord(wf);
      done += 1;
      if (onProgress) onProgress(done, rules.length);
    });
    return attachFunctionCodeToWorkflows(hydrated);
  }

  // A function used by several rules is sent with its code only once; later rules refer to that section.
  function moduleWorkflowsForAI(workflows) {
    const firstUse = new Map();
    return workflows.map((wf) => {
      const [masked] = maskedWorkflowsForAI([wf]);
      masked.function_code = (masked.function_code || []).map((fn, i) => {
        const original = (wf.function_code || [])[i] || fn;
        if (!fn.source) return fn;
        const key = fnKey(original);
        const owner = firstUse.get(key);
        if (!owner) {
          firstUse.set(key, wf.name);
          return fn;
        }
        const { source, ...rest } = fn;
        return { ...rest, shared: true, note: `Same function as in the workflow rule "${owner}", where its code is walked through. Describe it here in one line and refer to that rule.` };
      });
      return masked;
    });
  }

  async function generateModuleDocument(module) {
    if (!module || module === 'ALL') return;
    const rules = state.allWorkflowsList.filter(wf => wf.module === module);
    if (!rules.length) return;
    if (!(await ensureAiConfigured('generate documentation'))) return;
    const label = moduleLabel(module);
    const run = { module, label, generated: null, saved: null, saving: false };
    state.moduleRun = run;
    state.docs = [];
    state.prompts = {};
    state.selectedWorkflowIds.clear();
    limitSteps(4);
    goToStep(4);
    dom.docTabs.innerHTML = '';
    dom.docNotice.hidden = true;
    dom.docView.dataset.key = '';
    dom.docView.innerHTML = loadingBlock('Downloading the rules and their function code');
    dom.docStatus.textContent = `Loading ${plural(rules.length, 'workflow rule')} of ${label} with their function code…`;
    setDocButtons(false);
    renderSaveCard();

    let loaded;
    try {
      loaded = await loadModuleWorkflows(rules, (done, total) => {
        if (state.moduleRun === run) dom.docStatus.textContent = `Loading ${label}: ${done} of ${total} rules…`;
      });
      await loadFieldsForModules(loaded).catch(() => null);
    } catch (err) {
      if (state.moduleRun !== run) return;
      dom.docStatus.textContent = `The rules of ${label} could not be loaded.`;
      dom.docView.innerHTML = `<div class="notice error">${escapeHtml(err.message || String(err))}</div>`;
      return;
    }
    if (state.moduleRun !== run) return;

    state.reviewWorkflows = loaded;
    state.activeReviewId = loaded[0] && loaded[0].id;
    reviewFunctions(loaded);
    const forAI = moduleWorkflowsForAI(loaded);
    loaded.forEach((wf, i) => {
      const resp = window.LivingDocsAI.buildWorkflowPrompt([forAI[i]], promptSnapshot(), state.audience, state.docDetail);
      state.prompts[wf.id] = { system: resp.system || '', user: resp.user || '', maxTokens: resp.maxTokens };
    });
    renderReview();
    showPromptFor(activeReviewWorkflow());

    const docs = loaded.map(wf => ({ wf, status: 'pending', generated: null, saved: null, saving: false, error: '', notes: [], tokens: '' }));
    state.docs = docs;
    state.activeDocId = docs[0].wf.id;
    renderDocs();
    renderSaveCard();
    const entries = allMaskEntries();
    await mapPool(docs, MAX_BATCH, async (doc) => {
      await writeDocument(doc, entries);
      if (state.docs !== docs) return;
      renderDocs();
      renderSaveCard();
    });
    if (state.docs !== docs) return;
    finishModuleRun(docs);
  }

  // Saves on its own when every rule was written; with failures the user retries them or saves the rest.
  function finishModuleRun(docs) {
    const run = state.moduleRun;
    if (!run || docs.some(d => d.status === 'pending')) return;
    limitSteps(5);
    const failed = docs.filter(d => d.status !== 'done').length;
    renderSaveButton();
    renderSaveCard();
    if (!failed) {
      saveModuleRun();
      return;
    }
    showToast(`${plural(docs.length - failed, 'rule')} documented, ${failed} failed. Retry the failed rules, or save the module document without them.`, 'warning');
  }

  function modulePdfSections(run, docs) {
    const written = docs.filter(d => d.status === 'done');
    const missing = docs.filter(d => d.status !== 'done');
    const g = run.generated;
    const writers = [...new Set(written.map(d => d.generated.generatedBy).filter(Boolean))].join(', ');
    const cover = `
      <header class="pdf-cover">
        <div class="pdf-brand">${escapeHtml(run.label)} · master document · v${escapeHtml(g.version)} · ${escapeHtml(formatDate(g.at))} · ${written.length} rules · ${escapeHtml(writers || aiName())}</div>
        ${missing.length ? `<p class="pdf-missing">Not in this version: ${missing.map(d => escapeHtml(d.wf.name)).join(', ')}</p>` : ''}
      </header>`;
    return [cover, ...written.map(d => `<section class="pdf-rule">${documentFlowSection(d.wf, { pdf: true })}${renderMarkdown(d.generated.markdown)}</section>`)];
  }

  function modulePdfBytes(run, docs) {
    const g = run.generated;
    if (g.pdfBytes) return Promise.resolve(g.pdfBytes);
    const job = pdfQueue.then(async () => {
      if (!g.pdfBytes) g.pdfBytes = await renderSectionsPdf(modulePdfSections(run, docs), g.fileName, `${run.label} master document`, { continuous: true });
      return g.pdfBytes;
    });
    pdfQueue = job.catch(() => null);
    return job;
  }

  function prepareModuleGenerated(run, docs, version) {
    const written = docs.filter(d => d.status === 'done');
    const key = written.map(d => `${d.wf.id}:${d.generated.at}`).join('|');
    const g = run.generated;
    if (g && g.version === version && g.key === key) return g;
    const at = new Date().toISOString();
    run.generated = {
      at,
      key,
      version,
      fileName: moduleFileName(run.module, version, at),
      generatedBy: [...new Set(written.map(d => d.generated.generatedBy).filter(Boolean))].join(', ') || aiName(),
      pdfBytes: null
    };
    return run.generated;
  }

  async function logModuleDocumentation(run, docs) {
    if (!canWriteRecords()) return { ok: false, rows: [], message: 'Records are only written inside Zoho CRM. Use Download PDF to keep the file.' };
    await loadDocLogs().catch(() => null);
    if (!state.docLog.ok) {
      return { ok: false, rows: [], message: `${logModuleApi('documents')} could not be read (${state.docLog.error || 'unknown error'}). Run Install from the setup check.` };
    }
    const entity = logModuleApi('documents');
    const itemId = moduleDocItemId(run.module);
    // A retry after a failed attachment reuses the record and version this run already wrote. Once that
    // version is attached, changed content (for example retried rules) is saved as the next version.
    const contentKey = docs.filter(d => d.status === 'done').map(d => `${d.wf.id}:${d.generated.at}`).join('|');
    if (run.savedRecord && run.savedRecord.attached && run.savedRecord.key !== contentKey) run.savedRecord = null;
    const prev = run.savedRecord || null;
    const existingId = prev ? prev.id : (state.docLog.byItem[itemId]?.id || null);
    const version = prev ? prev.version : nextModuleVersion(run.module);
    const g = prepareModuleGenerated(run, docs, version);
    const pdfBytes = await modulePdfBytes(run, docs);
    const written = docs.filter(d => d.status === 'done');

    const seen = new Set();
    const hashLines = [];
    const snapshots = [`// Workflow rules: ${written.map(d => d.wf.name).join(', ')}`];
    let masked = 0;
    for (const d of written) {
      for (const fn of d.wf.function_code || []) {
        const key = fnKey(fn);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!fn.source) {
          hashLines.push(`${fn.api_name || fn.name || 'function'} [${key}] (code not loaded)`);
          continue;
        }
        const r = fnReview(fn).result ? fnReview(fn) : runFnReview(fn);
        hashLines.push(functionHashLine(fn, await sourceHash(fn.source)));
        masked += r.result.mask.entries.length;
        if (!fn.source_truncated) snapshots.push(`// ===== ${fn.api_name || fn.name} =====\n${r.result.mask.masked}`);
      }
    }
    const user = await currentUserInfo();
    const row = {
      Name: moduleDocName(run.module).slice(0, 120),
      Item_Type: 'Module',
      CRM_Module: run.module,
      Item_Name: run.label,
      Item_Id: itemId,
      Doc_Version: version,
      File_Name: g.fileName,
      Generated_By: clip(g.generatedBy, 150),
      Generated_At: zohoDateTime(g.at),
      Generated_By_User: userLabel(user),
      Audience: state.audience,
      Related_Items: clip(hashLines.join('\n'), 2000),
      Masked_Values: masked,
      Source_Hash: await sourceHash(written.flatMap(d => (d.wf.function_code || []).map(f => f.source || '')).join('\n')),
      Source_Snapshot: clip(snapshots.join('\n\n'))
    };

    let action = prev ? prev.action : (existingId ? 'Updated' : 'Created');
    let res = prev ? { ok: true, id: prev.id } : await writeDocRecord(entity, row, existingId);
    if (!prev && !res.ok && existingId && /not.?found|invalid.?id|INVALID_DATA|deleted|does not exist/i.test(res.message || '')) {
      res = await writeDocRecord(entity, row, null);
      action = 'Created';
    }
    if (res.ok && res.id && !prev) run.savedRecord = { id: res.id, version, action, attached: false, key: contentKey };
    const saved = run.savedRecord;
    const pdfFile = new File([pdfBytes], g.fileName, { type: 'application/pdf' });
    const attach = !res.ok || !res.id ? { ok: false, message: res.message }
      : saved.attached ? { ok: true, message: '' }
        : await attachPdfToRecord(entity, res.id, pdfFile);
    if (saved && attach.ok) saved.attached = true;
    const rows = [{
      label: row.Name,
      type: `${run.label} · ${plural(written.length, 'workflow rule')}`,
      version,
      action,
      id: res.id,
      ok: res.ok && attach.ok,
      saved: res.ok,
      attached: attach.ok,
      message: res.ok ? attach.message : res.message
    }];
    await loadDocLogs().catch(() => null);
    renderModuleTable();
    const failed = rows.filter(r => !r.ok);
    return { ok: !failed.length, rows, entity, message: failed.length ? `${failed[0].label}: ${failed[0].message}` : '' };
  }

  async function saveModuleRun() {
    const run = state.moduleRun;
    const docs = state.docs;
    if (!run || run.saving || !docs.some(d => d.status === 'done') || docs.some(d => d.status === 'pending')) return;
    run.saving = true;
    run.saved = { log: { pending: true } };
    renderSaveButton();
    renderSaveCard();
    let log;
    try {
      log = await logModuleDocumentation(run, docs);
    } catch (err) {
      log = { ok: false, rows: [], message: err.message || String(err) };
    } finally {
      run.saving = false;
    }
    run.saved = { ok: log.ok, message: log.message, log, at: new Date() };
    if (state.moduleRun !== run) return;
    renderSaveButton();
    renderSaveCard();
    showToast(log.ok ? `${moduleDocName(run.module)} v${run.generated.version} saved to CRM.` : (log.message || 'The module document was not saved.'), log.ok ? 'success' : 'error');
  }

  async function downloadModulePdf() {
    const run = state.moduleRun;
    if (!run || !state.docs.some(d => d.status === 'done')) return;
    try {
      const contentKey = state.docs.filter(d => d.status === 'done').map(d => `${d.wf.id}:${d.generated.at}`).join('|');
      const current = run.savedRecord && run.savedRecord.key === contentKey;
      prepareModuleGenerated(run, state.docs, current ? run.savedRecord.version : nextModuleVersion(run.module));
      downloadPdfBytes(await modulePdfBytes(run, state.docs), run.generated.fileName);
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  }

  function renderModuleSaveCard() {
    const run = state.moduleRun;
    const docs = state.docs;
    const entity = logModuleApi('documents');
    const written = docs.filter(d => d.status === 'done');
    const failedDocs = docs.filter(d => d.status === 'error');
    const pending = docs.filter(d => d.status === 'pending').length;
    const s = run.saved || {};
    const name = moduleDocName(run.module);
    const status = !docs.length ? 'Loading the workflow rules…'
      : pending ? `Writing ${written.length + failedDocs.length} of ${docs.length} rules…`
        : run.saving || (s.log && s.log.pending) ? 'Saving to CRM…'
          : s.ok ? 'Saved to CRM' : s.log ? `Not saved: ${s.message || 'CRM did not accept the record.'}` : 'Waiting to be saved';
    const head = s.ok ? `
      <div class="save-icon ok">${ICON.check.replace('<svg ', '<svg width="26" height="26" ')}</div>
      <h2>${escapeHtml(name)} saved</h2>
      <p class="muted">${escapeHtml(run.label)} has one record in ${escapeHtml(entity)}. Every new run updates it to the next version and attaches that version's PDF, so earlier versions stay in its attachments.</p>`
      : `
      <h2>${escapeHtml(run.label)} master document</h2>
      <p class="muted">Each workflow rule is written by its own AI call, ${MAX_BATCH} at a time. All of them are combined into one PDF on the ${escapeHtml(name)} record.</p>`;
    const done = !pending && docs.length && !run.saving;
    dom.saveCard.innerHTML = `${head}
      <div class="save-docs"><div class="save-doc">
        <div class="save-meta">
          <div><span>Record</span><span>${escapeHtml(name)}</span></div>
          <div><span>Workflow rules</span><span>${written.length} written${failedDocs.length ? `, ${failedDocs.length} failed` : ''}${pending ? `, ${pending} in progress` : ''} of ${docs.length}</span></div>
          ${run.generated ? `<div><span>File</span><span>${escapeHtml(run.generated.fileName)}</span></div>` : ''}
          <div><span>Status</span><span>${escapeHtml(status)}</span></div>
        </div>
        ${failedDocs.length && !pending ? `<div class="notice warning">Not written: ${failedDocs.map(d => `${escapeHtml(d.wf.name)} (${escapeHtml(d.error)})`).join('; ')}</div>` : ''}
        ${s.log && !s.log.pending ? renderDocLogResult(s.log) : ''}
        ${done && written.length ? `<div class="save-actions">
          ${failedDocs.length ? '<button class="btn btn-secondary btn-sm" data-module-action="retry-failed">Retry failed rules</button>' : ''}
          ${!s.ok ? `<button class="btn btn-primary btn-sm" data-module-action="save">${s.log ? 'Try again' : failedDocs.length ? `Save without ${plural(failedDocs.length, 'failed rule')}` : 'Save to CRM'}</button>` : ''}
          <button class="btn btn-secondary btn-sm" data-module-action="download">Download PDF</button>
        </div>` : ''}
      </div></div>`;
    dom.saveCard.querySelectorAll('[data-module-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.moduleAction;
        if (action === 'download') downloadModulePdf();
        if (action === 'save') saveModuleRun();
        if (action === 'retry-failed') {
          const list = state.docs;
          const retry = list.filter(d => d.status === 'error');
          retry.forEach(d => Object.assign(d, { status: 'pending', error: '', generated: null, notes: [], tokens: '' }));
          renderDocs();
          renderSaveCard();
          await mapPool(retry, MAX_BATCH, async (d) => {
            await writeDocument(d, allMaskEntries());
            if (state.docs === list) { renderDocs(); renderSaveCard(); }
          });
          if (state.docs === list) finishModuleRun(list);
        }
      });
    });
    dom.saveCard.querySelectorAll('[data-open-doc]').forEach((btn) => {
      btn.addEventListener('click', () => openCrmRecord(entity, btn.dataset.openDoc));
    });
  }

  // ==========================================
  // SETTINGS DRAWER
  // ==========================================
  function openSettings() {
    dom.settingsDocsConn.value = state.settings.docsAgentConnection || '';
    dom.settingsWdConn.value = state.settings.workdriveConnection || '';
    dom.settingsWorkDriveFolder.value = state.settings.workdriveFolder === 'folder_living_docs_crm' ? '' : (state.settings.workdriveFolder || '');
    dom.settingsAudience.value = state.audience;
    $('settingsDocDetail').value = state.docDetail;
    state.clearAiKey = false;
    dom.settingsAiProvider.value = state.ai.provider || '';
    dom.settingsAiLabel.value = state.ai.label || '';
    dom.settingsAiUrl.value = state.ai.apiUrl || '';
    fillModelSelect(dom.settingsAiModel, state.ai.provider, null, state.ai.model);
    $('settingsAiWorkspace').value = state.ai.workspaceId || '';
    dom.settingsAiKey.value = '';
    dom.settingsAiTestResult.hidden = true;
    renderAiFields(false);
    if (state.ai.provider && state.ai.hasApiKey) loadAiModels(aiFormValues(), dom.settingsAiModel);
    renderSettingsRecordStatus();
    dom.drawerBackdrop.hidden = false;
    dom.settingsDrawer.classList.add('open');
    dom.settingsDrawer.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    dom.settingsDrawer.classList.remove('open');
    dom.settingsDrawer.setAttribute('aria-hidden', 'true');
    dom.drawerBackdrop.hidden = true;
  }

  const AI_PROVIDER_DEFAULTS = window.LivingDocsAI.PROVIDERS;
  const AI_URL_HINTS = {
    anthropic: `Fixed. ${LDF.GATEWAY_FN} only sends the key to api.anthropic.com.`,
    cursor: `Fixed. ${LDF.GATEWAY_FN} only sends the key to api.cursor.com.`
  };
  const AI_KEY_HINTS = {
    anthropic: 'Create a key in the Anthropic console under Settings > API keys.',
    cursor: 'Create a user API key at cursor.com/dashboard/api. Each request runs a short cloud agent that is deleted afterwards.'
  };
  const KEY_STORE_NOTE = `Stored AES-encrypted in the CRM Org Variable ${LDF.VAR_NAME}, not in a module, and never shown again. Only a CRM Administrator can change it.`;
  // Shown until the provider returns the models this key can use.
  const AI_MODEL_OPTIONS = {
    anthropic: [
      { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1' },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-0', displayName: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-0', displayName: 'Claude Opus 4' },
      { id: 'claude-3-7-sonnet-latest', displayName: 'Claude Sonnet 3.7' },
      { id: 'claude-3-5-haiku-latest', displayName: 'Claude Haiku 3.5' }
    ],
    cursor: [
      { id: 'composer-2', displayName: 'Composer 2' },
      { id: 'claude-4.6-sonnet-thinking', displayName: 'Claude 4.6 Sonnet (thinking)' }
    ]
  };
  const aiModelCache = {};

  function fillModelSelect(selectEl, provider, models, wanted) {
    if (!selectEl) return;
    const list = (models && models.length ? models : AI_MODEL_OPTIONS[provider] || []).slice();
    const current = wanted || selectEl.value || aiPreset(provider).model || '';
    if (current && !list.some(m => m.id === current)) list.unshift({ id: current, displayName: `${current} (saved)` });
    selectEl.innerHTML = list.length
      ? list.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.displayName && m.displayName !== m.id ? `${m.displayName} · ${m.id}` : m.id)}</option>`).join('')
      : '<option value="">Choose a provider first</option>';
    selectEl.value = list.some(m => m.id === current) ? current : (list[0] ? list[0].id : '');
  }

  // Replaces the model options with the ones the saved key can use (GET /v1/models through the gateway).
  // Keeps the defaults on failure, and until a key is stored.
  async function loadAiModels(values, selectEl) {
    if (!selectEl || !values.aiProvider) return;
    const cfg = aiConfigFrom(values);
    const info = keyInfo(cfg.provider);
    if (!info.set) return;
    const cacheKey = `${cfg.provider}|${cfg.workspaceId || ''}|${info.hint}`;
    try {
      let models = aiModelCache[cacheKey];
      if (!models) models = await window.LivingDocsAI.listModels(cfg);
      if (models && models.length) {
        aiModelCache[cacheKey] = models;
        fillModelSelect(selectEl, cfg.provider, models, selectEl.value);
      }
    } catch (_) { /* the default options stay */ }
  }

  function aiPreset(provider) {
    return { ...(AI_PROVIDER_DEFAULTS[provider] || {}), ...(state.aiProviders[provider] || {}) };
  }

  function aiFormValues() {
    const provider = dom.settingsAiProvider.value;
    const preset = aiPreset(provider);
    return {
      aiProvider: provider,
      aiLabel: dom.settingsAiLabel.value.trim(),
      aiApiUrl: preset.editableUrl === false ? preset.apiUrl : dom.settingsAiUrl.value.trim(),
      aiModel: dom.settingsAiModel.value.trim(),
      aiWorkspaceId: provider === 'anthropic' ? $('settingsAiWorkspace').value.trim() : '',
      // Only a newly typed key; a stored one stays inside CRM.
      aiApiKey: dom.settingsAiKey.value.trim()
    };
  }

  function keySavedText(provider) {
    const info = keyInfo(provider);
    return info.set
      ? `Stored encrypted in CRM${info.hint ? `, ends in …${info.hint}` : ''}. Leave blank to keep it.`
      : `${AI_KEY_HINTS[provider] || ''} ${KEY_STORE_NOTE}`.trim();
  }

  function keyPlaceholder(provider, fallback) {
    const info = keyInfo(provider);
    return info.set ? `Stored encrypted${info.hint ? `, ends in …${info.hint}` : ''}` : fallback;
  }

  function fillSetupAiForm() {
    dom.setupAiProvider.value = state.ai.provider || '';
    dom.setupAiLabel.value = state.ai.label || '';
    dom.setupAiUrl.value = state.ai.apiUrl || '';
    fillModelSelect(dom.setupAiModel, state.ai.provider, null, state.ai.model);
    $('setupAiWorkspace').value = state.ai.workspaceId || '';
    dom.setupAiClaudeKey.value = '';
    dom.setupAiCursorKey.value = '';
    dom.setupAiTestResult.hidden = true;
    renderSetupAiFields(false);
    if (dom.setupAiSummary) dom.setupAiSummary.textContent = `${KEY_STORE_NOTE} Leave the key blank to keep the one already stored.`;
    if (state.ai.provider && keyInfo(state.ai.provider).set) loadAiModels(setupAiValues(), dom.setupAiModel);
  }

  function renderSetupAiFields(providerChanged) {
    const provider = dom.setupAiProvider.value;
    const preset = aiPreset(provider);
    if (providerChanged && provider) {
      dom.setupAiLabel.value = preset.label || '';
      dom.setupAiUrl.value = preset.apiUrl || '';
      dom.setupAiTestResult.hidden = true;
    }
    if (provider && !dom.setupAiUrl.value) dom.setupAiUrl.value = preset.apiUrl || '';
    const savedModel = provider === state.ai.provider ? state.ai.model : '';
    fillModelSelect(dom.setupAiModel, provider, null, providerChanged ? (savedModel || preset.model) : (dom.setupAiModel.value || savedModel || preset.model));
    if (providerChanged) loadAiModels(setupAiValues(), dom.setupAiModel);
    dom.setupAiLabel.placeholder = preset.label || 'Claude';
    if (dom.setupAiUrlField) dom.setupAiUrlField.hidden = Boolean(provider && preset.editableUrl === false);
    dom.setupAiUrlHint.textContent = AI_URL_HINTS[provider] || '';
    $('setupAiWorkspaceField').hidden = provider !== 'anthropic';
    $('setupAiClaudeField').hidden = provider !== 'anthropic';
    $('setupAiCursorField').hidden = provider !== 'cursor';
    dom.setupAiClaudeHint.textContent = keySavedText('anthropic');
    dom.setupAiCursorHint.textContent = keySavedText('cursor');
    dom.setupAiClaudeKey.placeholder = keyPlaceholder('anthropic', 'Paste the Claude API key');
    dom.setupAiCursorKey.placeholder = keyPlaceholder('cursor', 'Paste the Cursor API key');
  }

  function setupAiValues() {
    const provider = dom.setupAiProvider.value;
    const preset = aiPreset(provider);
    const typed = provider === 'cursor' ? dom.setupAiCursorKey.value.trim() : dom.setupAiClaudeKey.value.trim();
    return {
      aiProvider: provider,
      aiLabel: dom.setupAiLabel.value.trim() || preset.label || '',
      aiApiUrl: preset.editableUrl === false ? preset.apiUrl : (dom.setupAiUrl.value.trim() || preset.apiUrl || ''),
      aiModel: dom.setupAiModel.value.trim() || preset.model || '',
      aiWorkspaceId: provider === 'anthropic' ? $('setupAiWorkspace').value.trim() : '',
      aiApiKey: typed
    };
  }

  function captureSetupAi() {
    const provider = dom.setupAiProvider.value;
    const preset = aiPreset(provider);
    const claude = dom.setupAiClaudeKey.value.trim();
    const cursor = dom.setupAiCursorKey.value.trim();
    if (claude) state.pendingKeys.anthropic = claude;
    if (cursor) state.pendingKeys.cursor = cursor;
    if (provider) {
      state.ai.provider = provider;
      state.ai.label = dom.setupAiLabel.value.trim() || preset.label || '';
      state.ai.apiUrl = (preset.editableUrl === false ? preset.apiUrl : dom.setupAiUrl.value.trim()) || preset.apiUrl || '';
      state.ai.model = dom.setupAiModel.value.trim() || preset.model || '';
    }
    state.ai.workspaceId = $('setupAiWorkspace').value.trim();
    refreshAiFromKeys();
  }

  // Hands a typed key to livingdocs_save_api_key (admins only) or clears the stored one. Nothing is kept in the widget.
  async function storeProviderKey(provider, key, clear) {
    if (provider !== 'anthropic' && provider !== 'cursor') return;
    if (!key && !clear) return;
    const res = key
      ? await window.LivingDocsAI.saveApiKey(provider, key, getZohoApiDomain())
      : await window.LivingDocsAI.clearApiKey(provider, getZohoApiDomain());
    applyKeyState(res.keys);
    if (key && state.legacyKeys[provider]) {
      const legacyProviders = ['anthropic', 'cursor'].filter(p => state.legacyKeys[p]);
      state.clearLegacyKeys = legacyProviders.every(p => keyInfo(p).set);
    }
  }

  // providerChanged: fill in the defaults of the newly chosen provider.
  function renderAiFields(providerChanged) {
    const provider = dom.settingsAiProvider.value;
    const preset = aiPreset(provider);
    dom.settingsAiFields.hidden = !provider;
    if (providerChanged && provider) {
      state.clearAiKey = false;
      dom.settingsAiLabel.value = preset.label || '';
      dom.settingsAiUrl.value = preset.apiUrl || '';
      dom.settingsAiKey.value = '';
      dom.settingsAiTestResult.hidden = true;
    }
    if (provider && !dom.settingsAiUrl.value) dom.settingsAiUrl.value = preset.apiUrl || '';
    const savedModel = provider === state.ai.provider ? state.ai.model : '';
    fillModelSelect(dom.settingsAiModel, provider, null, providerChanged ? (savedModel || preset.model) : (dom.settingsAiModel.value || savedModel || preset.model));
    if (providerChanged) loadAiModels(aiFormValues(), dom.settingsAiModel);
    dom.settingsAiLabel.placeholder = preset.label || '';
    const urlField = dom.settingsAiUrl.closest('.field');
    if (urlField) urlField.hidden = preset.editableUrl === false;
    dom.settingsAiUrlHint.textContent = AI_URL_HINTS[provider] || '';
    $('settingsAiWorkspaceField').hidden = provider !== 'anthropic';
    const keySaved = keyInfo(provider).set && !state.clearAiKey;
    dom.settingsAiKey.placeholder = keySaved ? `${keyPlaceholder(provider, '')}. Leave blank to keep it.` : 'Paste the API key';
    dom.settingsAiKeyHint.textContent = keySaved ? keySavedText(provider) : `${AI_KEY_HINTS[provider] || ''} ${KEY_STORE_NOTE}`.trim();
    dom.btnClearAiKey.hidden = !keySaved;
  }

  function showAiTestResult(ok, text, el) {
    const node = el || dom.settingsAiTestResult;
    node.hidden = false;
    node.className = `small ai-test-result ${ok ? 'ok' : 'error'}`;
    node.textContent = text;
  }

  function aiConfigFrom(values) {
    const provider = values.aiProvider;
    const preset = aiPreset(provider);
    return {
      provider,
      label: values.aiLabel || preset.label || '',
      apiUrl: values.aiApiUrl || preset.apiUrl || '',
      model: values.aiModel || preset.model || '',
      workspaceId: provider === 'anthropic' ? String(values.aiWorkspaceId ?? state.ai.workspaceId ?? '').trim() : ''
    };
  }

  function currentAiConfig() {
    return aiConfigFrom({ aiProvider: state.ai.provider, aiLabel: state.ai.label, aiApiUrl: state.ai.apiUrl, aiModel: state.ai.model, aiWorkspaceId: state.ai.workspaceId });
  }

  function testProvider(values) {
    return window.LivingDocsAI.testConnection(aiConfigFrom(values));
  }

  async function testAiConnection(values, resultEl, button, listEl) {
    const formValues = values && values.aiProvider !== undefined ? values : aiFormValues();
    const result = resultEl || dom.settingsAiTestResult;
    const btn = button || dom.btnTestAi;
    const models = listEl || dom.settingsAiModel;
    if (!formValues.aiProvider) { showAiTestResult(false, 'Choose a provider first.', result); return; }
    if (!formValues.aiApiKey && !keyInfo(formValues.aiProvider).set) { showAiTestResult(false, 'Enter the API key.', result); return; }
    setBusy(btn, true);
    try {
      // The gateway tests the stored key, so a newly typed key is stored first.
      if (formValues.aiApiKey) {
        await storeProviderKey(formValues.aiProvider, formValues.aiApiKey, false);
        if (resultEl === dom.setupAiTestResult) {
          (formValues.aiProvider === 'cursor' ? dom.setupAiCursorKey : dom.setupAiClaudeKey).value = '';
          renderSetupAiFields(false);
        } else if (!resultEl) {
          dom.settingsAiKey.value = '';
          renderAiFields(false);
        }
      }
      const resp = await testProvider(formValues);
      const account = resp.account ? ` as ${resp.account}` : '';
      showAiTestResult(true, `Connected to ${resp.label} (${resp.model})${account} in ${(resp.ms / 1000).toFixed(1)}s.`, result);
      loadAiModels(formValues, models);
    } catch (err) {
      showAiTestResult(false, err.message || String(err), result);
    } finally {
      setBusy(btn, false);
    }
  }

  function aiIsConfigured() {
    return Boolean(state.ai.configured || state.hasApiKey) && Boolean(AI_PROVIDER_DEFAULTS[state.ai.provider]);
  }

  // AI actions wait here until Claude or Cursor is tested and saved. Resolves false if the user cancels.
  async function ensureAiConfigured(action) {
    if (aiIsConfigured()) return true;
    let values = {
      aiProvider: AI_PROVIDER_DEFAULTS[state.ai.provider] ? state.ai.provider : 'anthropic',
      aiModel: AI_PROVIDER_DEFAULTS[state.ai.provider] ? state.ai.model : '',
      aiApiKey: ''
    };
    let error = '';
    for (;;) {
      const next = await aiSetupDialog(action, values, error);
      if (!next) {
        showToast(`Set up Claude or Cursor to ${action}.`, 'warning');
        return false;
      }
      values = { ...next, aiApiKey: '' };
      try {
        await storeProviderKey(next.aiProvider, next.aiApiKey, false);
        const test = await testProvider(next);
        state.ai.provider = next.aiProvider;
        state.ai.label = next.aiLabel || aiPreset(next.aiProvider).label || '';
        state.ai.apiUrl = next.aiApiUrl || aiPreset(next.aiProvider).apiUrl || '';
        state.ai.model = next.aiModel || aiPreset(next.aiProvider).model || '';
        state.ai.workspaceId = next.aiWorkspaceId || '';
        refreshAiFromKeys();
        const saved = await saveSettingsRecord();
        if (!saved.ok) throw new Error(saved.message || 'Living_Docs_Settings could not be saved.');
        if (!aiIsConfigured()) throw new Error('No API key is stored for this provider yet.');
        showToast(`${test.label || aiName()} is connected (${test.model}).`);
        return true;
      } catch (err) {
        error = err.message || String(err);
      }
    }
  }

  function aiSetupDialog(action, values, error) {
    const providerOptions = Object.entries(AI_PROVIDER_DEFAULTS)
      .map(([id, p]) => `<option value="${id}"${id === values.aiProvider ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
    const pending = confirmDialog({
      title: 'Set up AI first',
      confirmLabel: 'Test and save',
      html: `
        <p>You need an AI provider to ${escapeHtml(action)}. Choose Claude or Cursor and paste an API key. ${escapeHtml(KEY_STORE_NOTE)}</p>
        ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
        <label class="field"><span>Provider</span><select id="aiSetupProvider">${providerOptions}</select></label>
        <label class="field" hidden><span>API URL</span><input type="url" id="aiSetupUrl" spellcheck="false" readonly value="${escapeHtml(values.aiApiUrl || '')}" /></label>
        <label class="field"><span>API key <span class="req">required</span></span><input type="password" id="aiSetupKey" autocomplete="off" data-required value="" /></label>
        <label class="field" id="aiSetupWorkspaceField"><span>Workspace ID <span class="muted">optional</span></span><input type="text" id="aiSetupWorkspace" spellcheck="false" autocomplete="off" placeholder="wrkspc_…" value="${escapeHtml(values.aiWorkspaceId ?? state.ai.workspaceId ?? '')}" /><small>Only needed when the key is not tied to a workspace.</small></label>
        <label class="field"><span>Model</span><select id="aiSetupModel"></select></label>
        <p class="muted small" id="aiSetupHint"></p>
        <p class="muted small">IDs, org IDs and tokens are masked before anything is sent to the AI.</p>`
    });
    const providerEl = $('aiSetupProvider');
    const modelEl = $('aiSetupModel');
    const keyEl = $('aiSetupKey');
    const urlEl = $('aiSetupUrl');
    const workspaceEl = $('aiSetupWorkspace');
    const current = { ...values };
    const sync = (providerChanged) => {
      const provider = providerEl.value;
      const preset = aiPreset(provider);
      if (providerChanged || !modelEl.options.length) {
        const saved = provider === values.aiProvider ? values.aiModel : '';
        fillModelSelect(modelEl, provider, null, saved || preset.model);
      }
      if (providerChanged || !urlEl.value.trim()) {
        urlEl.value = (provider === state.ai.provider && state.ai.apiUrl) || preset.apiUrl || '';
      }
      $('aiSetupWorkspaceField').hidden = provider !== 'anthropic';
      $('aiSetupHint').textContent = AI_KEY_HINTS[provider] || '';
      current.aiProvider = provider;
      current.aiLabel = preset.label;
      current.aiApiUrl = urlEl.value.trim() || preset.apiUrl;
      current.aiModel = modelEl.value || preset.model;
      current.aiWorkspaceId = provider === 'anthropic' ? workspaceEl.value.trim() : '';
      current.aiApiKey = keyEl.value.trim();
    };
    providerEl.addEventListener('change', () => { sync(true); loadAiModels(current, modelEl); });
    [keyEl, urlEl, workspaceEl].forEach(el => el.addEventListener('input', () => sync(false)));
    modelEl.addEventListener('change', () => sync(false));
    [keyEl, workspaceEl].forEach(el => el.addEventListener('change', () => { sync(false); loadAiModels(current, modelEl); }));
    sync(false);
    if (current.aiApiKey) loadAiModels(current, modelEl);
    return pending.then(answer => (answer ? { ...current } : null));
  }

  async function saveSettings() {
    state.settings.docsAgentConnection = dom.settingsDocsConn.value.trim() || 'docsagent_connection';
    state.settings.workdriveConnection = dom.settingsWdConn.value.trim() || 'workdrive_connection';
    state.settings.workdriveFolder = dom.settingsWorkDriveFolder.value.trim();
    state.audience = dom.settingsAudience.value;
    localStorage.setItem('livingdocs.audience', state.audience);
    state.docDetail = $('settingsDocDetail').value === 'detailed' ? 'detailed' : 'quick';
    localStorage.setItem('livingdocs.detail', state.docDetail);
    const ai = aiFormValues();
    if (ai.aiProvider && (!ai.aiApiUrl || !ai.aiModel)) {
      showToast('Enter the API URL and model for the AI provider.', 'warning');
      return;
    }

    setBusy(dom.btnSaveSettings, true);
    try {
      await storeProviderKey(ai.aiProvider, dom.settingsAiKey.value.trim(), state.clearAiKey);
      if (ai.aiProvider) {
        state.ai.provider = ai.aiProvider;
        state.ai.label = ai.aiLabel;
        state.ai.apiUrl = ai.aiApiUrl;
        state.ai.model = ai.aiModel;
        state.ai.workspaceId = ai.aiWorkspaceId;
        refreshAiFromKeys();
      }
      const saved = await saveSettingsRecord();
      if (!saved.ok) throw new Error(saved.message || 'Living_Docs_Settings could not be saved.');
      dom.settingsAiKey.value = '';
      state.clearAiKey = false;
      renderSettingsRecordStatus();
      renderAiFields(false);
      showToast(state.ai.provider && !state.ai.hasApiKey ? 'Settings saved. Add the API key to use the AI provider.' : 'Settings saved on Living_Docs_Settings.');
      closeSettings();
      if (state.reviewWorkflows.length) {
        renderReview();
        if (Object.keys(state.prompts).length) buildPrompt();
      }
    } catch (err) {
      showToast(err.message || String(err), 'error');
    } finally {
      setBusy(dom.btnSaveSettings, false);
    }
  }


  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
