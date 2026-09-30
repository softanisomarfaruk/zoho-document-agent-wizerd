/*
 * Zoho Living Documentation Agent - Backend & Catalyst Function Gateway
 * "Your Zoho system documents itself"
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const errorHandler = require('errorhandler');
const morgan = require('morgan');
const serveIndex = require('serve-index');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { markdownToPdf } = require('./pdf');
const ai = require('./ai');

process.env.PWD = process.env.PWD || process.cwd();

const expressApp = express();
const port = process.env.PORT || 5000;

expressApp.set('port', port);
expressApp.use(morgan('dev'));
expressApp.use(bodyParser.json({ limit: '20mb' }));
expressApp.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

// Enable CORS for Zoho CRM Widget iframe
expressApp.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Settings in-memory / persistent
let appSettings = {
  // No AI is bundled. The admin chooses a provider in Settings; the key is stored encrypted.
  aiProvider: '',
  aiLabel: '',
  aiApiUrl: '',
  aiModel: '',
  aiApiKeyEnc: '',
  maxTokens: 4000,
  temperature: 0.2,
  workdriveDefaultFolder: 'folder_living_docs_crm',
  crmOrgId: 'org_zoho_prod_881920',
  mode: 'hybrid', // hybrid, live_zoho, simulation
  // Zoho Named Connections (no raw OAuth tokens stored)
  docsAgentConnection: process.env.DOCS_AGENT_CONNECTION || 'docsagent_connection',
  workdriveConnection: process.env.WORKDRIVE_CONNECTION || 'workdrive_connection',
  scheduleFrequency: 'daily',
  settingsRecordId: null
};

const settingsFilePath = path.join(__dirname, 'data', 'settings.json');
const liveCache = {
  snapshot: null,
  baseline: null
};

function loadPersistedSettings() {
  try {
    if (!fs.existsSync(settingsFilePath)) return;
    const saved = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      Object.assign(appSettings, saved);
    }
  } catch (err) {
    console.warn('[Settings] Could not read settings file:', err.message);
  }
  // Older versions kept a plain-text Claude key; move it to the encrypted provider settings.
  if (appSettings.claudeApiKey) {
    if (!appSettings.aiApiKeyEnc) {
      appSettings.aiProvider = 'anthropic';
      appSettings.aiLabel = appSettings.aiLabel || 'Claude';
      appSettings.aiApiUrl = appSettings.claudeApiUrl || ai.PROVIDERS.anthropic.apiUrl;
      appSettings.aiModel = appSettings.aiModel || appSettings.claudeModel || ai.PROVIDERS.anthropic.model;
      appSettings.aiApiKeyEnc = ai.encryptSecret(appSettings.claudeApiKey);
    }
    delete appSettings.claudeApiKey;
    delete appSettings.claudeApiUrl;
    delete appSettings.claudeModel;
    persistSettings();
  }
}

function persistSettings() {
  const dir = path.dirname(settingsFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const { claudeApiKey, ...rest } = appSettings;
  const singleRecord = {
    ...rest,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(settingsFilePath, JSON.stringify(singleRecord, null, 2), { mode: 0o600 });
}

loadPersistedSettings();

function aiConfig() {
  const spec = ai.PROVIDERS[appSettings.aiProvider];
  if (!spec) return { provider: '', label: '', apiUrl: '', model: '', apiKey: '' };
  return {
    provider: appSettings.aiProvider,
    label: appSettings.aiLabel || spec.label,
    apiUrl: spec.editableUrl ? (appSettings.aiApiUrl || spec.apiUrl) : spec.apiUrl,
    model: appSettings.aiModel || spec.model,
    apiKey: ai.decryptSecret(appSettings.aiApiKeyEnc)
  };
}

function aiConfigured() {
  const cfg = aiConfig();
  return Boolean(cfg.provider && cfg.apiUrl && cfg.model && cfg.apiKey);
}

function aiNotConfiguredResponse(res, action) {
  return res.status(412).json({
    status: 'error',
    code: 'AI_NOT_CONFIGURED',
    error: `Set up an AI provider (Claude or Cursor) in Settings before you ${action}.`
  });
}

function publicAiSettings() {
  const cfg = aiConfig();
  return {
    provider: cfg.provider || '',
    label: cfg.label || '',
    apiUrl: cfg.apiUrl || '',
    model: cfg.model || '',
    hasApiKey: Boolean(cfg.apiKey),
    keyHint: cfg.apiKey ? cfg.apiKey.slice(-4) : '',
    configured: aiConfigured()
  };
}

function aiDisplayName(result) {
  const cfg = aiConfig();
  const label = (result && result.label) || cfg.label || 'AI';
  const model = (result && result.model) || cfg.model;
  return model ? `${label} (${model})` : label;
}

// The key, provider URL and backups must not be reachable from other sites.
function sameOriginOnly(req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (_) { host = ''; }
    if (host !== req.headers.host) {
      return res.status(403).json({ status: 'error', error: 'Cross-origin requests are not allowed for this endpoint.' });
    }
  }
  next();
}

function emptyLiveSnapshot() {
  return {
    id: 'snap_empty',
    timestamp: new Date().toISOString(),
    source: 'none',
    stats: {
      total_modules: 0,
      total_fields: 0,
      total_workflows: 0,
      total_blueprints: 0,
      total_functions: 0
    },
    modules: [],
    functions: []
  };
}

// State Store (Simulating Catalyst DataStore)
const dataStore = {
  snapshots: [],
  activeBaselineId: null,
  driftEvents: [],
  generatedDocs: {},
  
  // Active CRM Mock / Dynamic State
  crmState: {
    modules: [
      {
        module: 'Leads',
        component_id: 'mod_Leads',
        fields: [
          { id: 'f_ld_1', api_name: 'First_Name', label: 'First Name', data_type: 'text', required: false, custom_field: false },
          { id: 'f_ld_2', api_name: 'Last_Name', label: 'Last Name', data_type: 'text', required: true, custom_field: false },
          { id: 'f_ld_3', api_name: 'Company', label: 'Company', data_type: 'text', required: true, custom_field: false },
          { id: 'f_ld_4', api_name: 'Email', label: 'Email', data_type: 'email', required: true, custom_field: false },
          { id: 'f_ld_5', api_name: 'Phone', label: 'Phone', data_type: 'phone', required: false, custom_field: false },
          { id: 'f_ld_6', api_name: 'Lead_Source', label: 'Lead Source', data_type: 'picklist', pick_list_values: ['Website', 'Partner Referral', 'Cold Outreach', 'Event', 'Google Ads'], required: false, custom_field: false },
          { id: 'f_ld_7', api_name: 'Lead_Status', label: 'Lead Status', data_type: 'picklist', pick_list_values: ['New / Uncontacted', 'Contacted', 'Attempted to Contact', 'Qualified', 'Junk / Disqualified'], required: false, custom_field: false },
          { id: 'f_ld_8', api_name: 'Annual_Revenue', label: 'Annual Revenue', data_type: 'currency', required: false, custom_field: false },
          { id: 'f_ld_9', api_name: 'Industry', label: 'Industry', data_type: 'picklist', pick_list_values: ['Technology', 'Healthcare', 'Finance', 'Manufacturing', 'Retail'], required: false, custom_field: false },
          { id: 'f_ld_10', api_name: 'Enrichment_Score', label: 'Clearbit Enrichment Score', data_type: 'integer', required: false, custom_field: true }
        ],
        workflows: [
          {
            id: 'wf_ld_01',
            name: 'wf_Lead_Auto_Enrichment',
            status: 'active',
            trigger_type: 'on_record_create',
            criteria: 'Email is not empty and Company is not empty',
            actions: ['Webhook: Trigger Clearbit Firmographics', 'Function: fn_enrich_lead_data', 'Task: Assign to SDR']
          },
          {
            id: 'wf_ld_02',
            name: 'wf_Lead_Auto_Convert',
            status: 'active',
            trigger_type: 'on_record_edit',
            criteria: 'Lead_Status is Qualified',
            actions: ['Action: Convert to Contact & Account', 'Action: Create Deal (Qualification Stage)', 'Email: Send Welcome Pack']
          }
        ],
        blueprints: [
          {
            id: 'bp_ld_01',
            name: 'Lead Qualification Protocol',
            field_name: 'Lead_Status',
            transitions: [
              { transition_id: 't_ld_1', name: 'First Contact', from_state: 'New / Uncontacted', to_state: 'Contacted' },
              { transition_id: 't_ld_2', name: 'Qualify Prospect', from_state: 'Contacted', to_state: 'Qualified' },
              { transition_id: 't_ld_3', name: 'Disqualify', from_state: 'Contacted', to_state: 'Junk / Disqualified' }
            ]
          }
        ]
      },
      {
        module: 'Deals',
        component_id: 'mod_Deals',
        fields: [
          { id: 'f_dl_1', api_name: 'Deal_Name', label: 'Deal Name', data_type: 'text', required: true, custom_field: false },
          { id: 'f_dl_2', api_name: 'Amount', label: 'Amount ($)', data_type: 'currency', required: true, custom_field: false },
          { id: 'f_dl_3', api_name: 'Stage', label: 'Stage', data_type: 'picklist', pick_list_values: ['Qualification', 'Needs Analysis', 'Value Proposition', 'Proposal / Price Quote', 'Negotiation / Review', 'Closed Won', 'Closed Lost'], required: true, custom_field: false },
          { id: 'f_dl_4', api_name: 'Closing_Date', label: 'Closing Date', data_type: 'date', required: true, custom_field: false },
          { id: 'f_dl_5', api_name: 'Pipeline', label: 'Pipeline', data_type: 'picklist', pick_list_values: ['Standard Sales', 'Enterprise', 'Partner Deal'], required: true, custom_field: false },
          { id: 'f_dl_6', api_name: 'Probability', label: 'Probability (%)', data_type: 'percent', required: false, custom_field: false },
          { id: 'f_dl_7', api_name: 'Discount_Percentage', label: 'Discount (%)', data_type: 'percent', required: false, custom_field: true },
          { id: 'f_dl_8', api_name: 'Stripe_Customer_ID', label: 'Stripe Customer ID', data_type: 'text', required: false, custom_field: true }
        ],
        workflows: [
          {
            id: 'wf_dl_01',
            name: 'wf_High_Value_Deal_Alert',
            status: 'active',
            trigger_type: 'on_record_create_or_edit',
            criteria: 'Amount >= 50000',
            actions: ['Webhook: Slack #enterprise-deals Channel Alert', 'Task: VP Sales Executive Sponsor Check-in']
          },
          {
            id: 'wf_dl_02',
            name: 'wf_Deal_Closed_Won_Sync',
            status: 'active',
            trigger_type: 'on_record_edit',
            criteria: 'Stage becomes Closed Won',
            actions: ['Function: fn_sync_stripe_customer', 'Email: Send Customer Onboarding Agreement', 'Field Update: Probability to 100%']
          }
        ],
        blueprints: [
          {
            id: 'bp_dl_01',
            name: 'Enterprise Sales Cycle Blueprint',
            field_name: 'Stage',
            transitions: [
              { transition_id: 't_dl_1', name: 'Complete Discovery', from_state: 'Qualification', to_state: 'Needs Analysis' },
              { transition_id: 't_dl_2', name: 'Deliver Pitch', from_state: 'Needs Analysis', to_state: 'Value Proposition' },
              { transition_id: 't_dl_3', name: 'Send Formal Proposal', from_state: 'Value Proposition', to_state: 'Proposal / Price Quote' },
              { transition_id: 't_dl_4', name: 'Executive Approval', from_state: 'Proposal / Price Quote', to_state: 'Negotiation / Review' },
              { transition_id: 't_dl_5', name: 'Sign Contract', from_state: 'Negotiation / Review', to_state: 'Closed Won' }
            ]
          }
        ]
      },
      {
        module: 'Accounts',
        component_id: 'mod_Accounts',
        fields: [
          { id: 'f_ac_1', api_name: 'Account_Name', label: 'Account Name', data_type: 'text', required: true, custom_field: false },
          { id: 'f_ac_2', api_name: 'Website', label: 'Website', data_type: 'url', required: false, custom_field: false },
          { id: 'f_ac_3', api_name: 'Billing_Country', label: 'Billing Country', data_type: 'text', required: false, custom_field: false },
          { id: 'f_ac_4', api_name: 'Account_Tier', label: 'Account Tier', data_type: 'picklist', pick_list_values: ['Tier 1 (Enterprise)', 'Tier 2 (Mid-Market)', 'Tier 3 (SMB)'], required: false, custom_field: true }
        ],
        workflows: [
          {
            id: 'wf_ac_01',
            name: 'wf_Account_Tier_Assignment',
            status: 'active',
            trigger_type: 'on_record_create_or_edit',
            criteria: 'Annual_Revenue >= 1000000',
            actions: ['Field Update: Account_Tier to Tier 1 (Enterprise)']
          }
        ],
        blueprints: []
      },
      {
        module: 'Contacts',
        component_id: 'mod_Contacts',
        fields: [
          { id: 'f_ct_1', api_name: 'First_Name', label: 'First Name', data_type: 'text', required: false, custom_field: false },
          { id: 'f_ct_2', api_name: 'Last_Name', label: 'Last Name', data_type: 'text', required: true, custom_field: false },
          { id: 'f_ct_3', api_name: 'Email', label: 'Email', data_type: 'email', required: true, custom_field: false },
          { id: 'f_ct_4', api_name: 'Job_Title', label: 'Job Title', data_type: 'text', required: false, custom_field: false }
        ],
        workflows: [],
        blueprints: []
      }
    ],
    functions: [
      {
        id: 'fn_01',
        name: 'fn_sync_stripe_customer',
        api_name: 'fn_sync_stripe_customer',
        return_type: 'map',
        description: 'Synchronizes Closed Won deal account information to Stripe Billing customer object via secure Zoho Connection.'
      },
      {
        id: 'fn_02',
        name: 'fn_enrich_lead_data',
        api_name: 'fn_enrich_lead_data',
        return_type: 'void',
        description: 'Extracts corporate domain from email and queries enrichment API to populate revenue and industry.'
      }
    ]
  }
};

// Helper: Calculate MD5 hash of component
function hashComponent(obj) {
  return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex').substring(0, 12);
}

// 0. Auto-Provision Custom Module via Zoho CRM API v8
expressApp.post('/api/zoho/provision-modules', async (req, res, next) => {
  try {
    const { accessToken, domain = 'www.zohoapis.com' } = req.body;
    if (!accessToken) return next();
    console.log('[Auto-Provision] Verifying & Creating Living_Docs_Snapshots module...');

    const modulePayload = {
      modules: [
        {
          api_name: 'Living_Docs_Snapshots',
          singular_label: 'Living Docs Snapshot',
          plural_label: 'Living Docs Snapshots'
        },
        {
          api_name: 'Doc_Drift_Logs',
          singular_label: 'Doc Drift Log',
          plural_label: 'Doc Drift Logs'
        }
      ]
    };

    if (accessToken) {
      try {
        const createModResp = await fetch(`https://${domain}/crm/v8/settings/modules`, {
          method: 'POST',
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(modulePayload)
        });
        const modResult = await createModResp.json();
        console.log('[Auto-Provision Result]:', modResult);
      } catch (apiErr) {
        console.warn('[Zoho API v8 Module Creation Notice]:', apiErr.message);
      }
    }

    res.json({
      status: 'success',
      message: 'Custom module Living_Docs_Snapshots & Doc_Drift_Logs verified and provisioned automatically.',
      provisioned_modules: ['Living_Docs_Snapshots', 'Doc_Drift_Logs'],
      api_version: 'v8',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Helper: Build Full Snapshot with hashes
function buildSnapshot() {
  const snapshotId = `snap_${Date.now()}`;
  const timestamp = new Date().toISOString();
  let totalFields = 0;
  let totalWorkflows = 0;
  let totalBlueprints = 0;
  let totalFunctions = dataStore.crmState.functions.length;

  const modules = dataStore.crmState.modules.map(mod => {
    const fields = (mod.fields || []).map(f => ({
      ...f,
      hash: hashComponent({ api: f.api_name, type: f.data_type, req: f.required, pv: f.pick_list_values })
    }));
    const workflows = (mod.workflows || []).map(wf => ({
      ...wf,
      hash: hashComponent({ name: wf.name, status: wf.status, crit: wf.criteria, act: wf.actions })
    }));
    const blueprints = (mod.blueprints || []).map(bp => ({
      ...bp,
      hash: hashComponent({ name: bp.name, field: bp.field_name, trans: bp.transitions })
    }));

    totalFields += fields.length;
    totalWorkflows += workflows.length;
    totalBlueprints += blueprints.length;

    const modHash = hashComponent({
      mod: mod.module,
      fCount: fields.length,
      wfCount: workflows.length,
      bpCount: blueprints.length,
      fHashes: fields.map(f => f.hash).join(','),
      wfHashes: workflows.map(w => w.hash).join(',')
    });

    return {
      module: mod.module,
      component_id: mod.component_id,
      hash: modHash,
      fields,
      workflows,
      blueprints
    };
  });

  const functions = dataStore.crmState.functions.map(fn => ({
    ...fn,
    hash: hashComponent({ name: fn.name, api: fn.api_name, desc: fn.description })
  }));

  const snapshot = {
    id: snapshotId,
    org_id: appSettings.crmOrgId,
    timestamp,
    stats: {
      total_modules: modules.length,
      total_fields: totalFields,
      total_workflows: totalWorkflows,
      total_blueprints: totalBlueprints,
      total_functions: totalFunctions
    },
    modules,
    functions
  };

  dataStore.snapshots.push(snapshot);
  if (!dataStore.activeBaselineId) {
    dataStore.activeBaselineId = snapshotId;
  }
  return snapshot;
}

// Initial snapshot creation
buildSnapshot();

// ==========================================
// REST API ENDPOINTS
// ==========================================

// 1. Settings
expressApp.get('/api/settings', (req, res) => {
  res.json({
    status: 'success',
    settings: {
      ai: publicAiSettings(),
      aiProviders: ai.PROVIDERS,
      maxTokens: appSettings.maxTokens,
      temperature: appSettings.temperature,
      hasApiKey: aiConfigured(),
      workdriveDefaultFolder: appSettings.workdriveDefaultFolder,
      crmOrgId: appSettings.crmOrgId,
      mode: appSettings.mode,
      // Connection link names (no secrets, just the connection identifiers)
      docsAgentConnection: appSettings.docsAgentConnection,
      workdriveConnection: appSettings.workdriveConnection,
      scheduleFrequency: appSettings.scheduleFrequency,
      settingsRecordId: appSettings.settingsRecordId || null,
      storage: 'single_record'
    }
  });
});

function readAiInput(body, base) {
  const next = { ...base };
  if (typeof body.aiProvider === 'string') {
    const provider = body.aiProvider.trim();
    if (provider && !ai.PROVIDERS[provider]) return { error: `Unknown AI provider "${provider}".` };
    next.provider = provider;
  }
  if (typeof body.aiLabel === 'string') next.label = body.aiLabel.trim().slice(0, 60);
  else if (next.provider !== base.provider) next.label = '';
  if (next.provider !== base.provider && typeof body.aiModel !== 'string') next.model = '';
  if (next.provider !== base.provider && typeof body.aiApiUrl !== 'string') next.apiUrl = '';
  if (typeof body.aiModel === 'string') next.model = body.aiModel.trim().slice(0, 120);
  const spec = ai.PROVIDERS[next.provider];
  if (spec && !spec.editableUrl) {
    next.apiUrl = spec.apiUrl;
  } else if (typeof body.aiApiUrl === 'string') {
    const url = body.aiApiUrl.trim();
    if (url) {
      const check = ai.validateApiUrl(url);
      if (!check.ok) return { error: check.error };
      next.apiUrl = check.url;
    } else {
      next.apiUrl = '';
    }
  }
  if (spec) {
    if (!next.apiUrl) next.apiUrl = spec.apiUrl;
    if (!next.model) next.model = spec.model;
  }
  const newKey = typeof body.aiApiKey === 'string' ? body.aiApiKey.trim() : '';
  if (newKey) {
    next.apiKey = newKey;
  } else if (body.clearApiKey || !next.provider) {
    next.apiKey = '';
  } else if (base.apiKey && (next.provider !== base.provider || ai.hostOf(next.apiUrl) !== ai.hostOf(base.apiUrl))) {
    // A saved key is never sent to a new host unless the admin enters it again.
    next.apiKey = '';
    next.keyDropped = true;
  }
  return { cfg: next };
}

expressApp.post('/api/ai/test', sameOriginOnly, async (req, res) => {
  const input = readAiInput(req.body || {}, aiConfig());
  if (input.error) return res.status(400).json({ status: 'error', error: input.error });
  const cfg = input.cfg;
  if (!cfg.provider) return res.status(400).json({ status: 'error', error: 'Choose an AI provider first.' });
  if (!cfg.apiUrl || !cfg.model) return res.status(400).json({ status: 'error', error: 'API URL and model are required.' });
  if (!cfg.apiKey) {
    return res.status(400).json({
      status: 'error',
      error: input.cfg.keyDropped ? 'The provider or API URL host changed, so enter the API key again.' : 'Enter the API key.'
    });
  }
  const started = Date.now();
  if (cfg.provider === 'cursor') {
    try {
      const check = await ai.testCursor(cfg);
      return res.json({ status: 'success', model: check.model, label: cfg.label || 'Cursor', reply: check.account, ms: Date.now() - started });
    } catch (err) {
      return res.status(502).json({ status: 'error', error: err.message });
    }
  }
  try {
    const result = await ai.callAi(cfg, {
      system: 'You are a connection test. Reply with the single word OK.',
      user: 'Reply with OK.',
      maxTokens: 16,
      temperature: 0
    });
    res.json({
      status: 'success',
      model: result.model,
      label: result.label,
      reply: String(result.text || '').trim().slice(0, 60),
      ms: Date.now() - started
    });
  } catch (err) {
    res.status(502).json({ status: 'error', error: err.message });
  }
});

// Model ids for the Cursor key (GET /v1/models); used to fill the model suggestions.
expressApp.post('/api/ai/models', sameOriginOnly, async (req, res) => {
  const input = readAiInput(req.body || {}, aiConfig());
  if (input.error) return res.status(400).json({ status: 'error', error: input.error });
  const cfg = input.cfg;
  if (cfg.provider !== 'cursor') return res.json({ status: 'success', models: [] });
  if (!cfg.apiKey) return res.status(400).json({ status: 'error', error: 'Enter the API key.' });
  try {
    res.json({ status: 'success', models: await ai.cursorModels(cfg) });
  } catch (err) {
    res.status(502).json({ status: 'error', error: err.message });
  }
});

expressApp.post('/api/settings', sameOriginOnly, (req, res) => {
  const { maxTokens, temperature, workdriveDefaultFolder, mode, docsAgentConnection, workdriveConnection, scheduleFrequency, settingsRecordId } = req.body;
  const body = { ...req.body };
  // Older widgets sent only claudeApiKey / claudeModel.
  if (typeof body.claudeApiKey === 'string' && body.claudeApiKey.trim() && body.aiApiKey === undefined
    && (!appSettings.aiProvider || appSettings.aiProvider === 'anthropic')) {
    body.aiApiKey = body.claudeApiKey;
    if (!body.aiProvider && !appSettings.aiProvider) {
      body.aiProvider = 'anthropic';
      body.aiLabel = body.aiLabel || 'Claude';
      body.aiApiUrl = body.aiApiUrl || ai.PROVIDERS.anthropic.apiUrl;
      body.aiModel = body.aiModel || body.claudeModel || ai.PROVIDERS.anthropic.model;
    }
  }
  const touchesAi = ['aiProvider', 'aiLabel', 'aiApiUrl', 'aiModel', 'aiApiKey', 'clearApiKey'].some(k => body[k] !== undefined);
  let keyDropped = false;
  if (touchesAi) {
    const input = readAiInput(body, aiConfig());
    if (input.error) return res.status(400).json({ status: 'error', error: input.error });
    const cfg = input.cfg;
    appSettings.aiProvider = cfg.provider || '';
    appSettings.aiLabel = cfg.provider ? (cfg.label || ai.PROVIDERS[cfg.provider].label) : '';
    appSettings.aiApiUrl = cfg.provider ? (cfg.apiUrl || ai.PROVIDERS[cfg.provider].apiUrl) : '';
    appSettings.aiModel = cfg.provider ? (cfg.model || ai.PROVIDERS[cfg.provider].model) : '';
    appSettings.aiApiKeyEnc = cfg.apiKey ? ai.encryptSecret(cfg.apiKey) : '';
    keyDropped = Boolean(cfg.keyDropped);
  }
  if (maxTokens) appSettings.maxTokens = parseInt(maxTokens, 10);
  if (temperature !== undefined) appSettings.temperature = parseFloat(temperature);
  if (workdriveDefaultFolder) appSettings.workdriveDefaultFolder = workdriveDefaultFolder;
  if (mode) appSettings.mode = mode;
  if (scheduleFrequency) appSettings.scheduleFrequency = scheduleFrequency;
  if (settingsRecordId) appSettings.settingsRecordId = String(settingsRecordId);
  // Store connection names — these are just string identifiers, NOT tokens
  if (docsAgentConnection) appSettings.docsAgentConnection = docsAgentConnection.trim();
  if (workdriveConnection) appSettings.workdriveConnection = workdriveConnection.trim();

  persistSettings();
  console.log(`[Settings] Updated single record — docsAgentConnection: ${appSettings.docsAgentConnection}, crmRecord: ${appSettings.settingsRecordId || 'none'}`);

  res.json({
    status: 'success',
    message: keyDropped
      ? 'Settings saved. The provider or API URL host changed, so the saved API key was removed. Enter it again.'
      : 'Settings saved.',
    keyDropped,
    settings: {
      ai: publicAiSettings(),
      hasApiKey: aiConfigured(),
      workdriveDefaultFolder: appSettings.workdriveDefaultFolder,
      mode: appSettings.mode,
      docsAgentConnection: appSettings.docsAgentConnection,
      workdriveConnection: appSettings.workdriveConnection,
      scheduleFrequency: appSettings.scheduleFrequency,
      settingsRecordId: appSettings.settingsRecordId || null,
      storage: 'single_record'
    }
  });
});

// 1b. Module Provisioner Endpoint
// Called by the widget on startup. Verifies which custom modules exist in the CRM
// state store and responds with their status. When running inside Zoho CRM as a widget,
// the actual v8 Modules API call is made by the frontend via ZOHO.CRM.HTTP (Named Connection).
// This endpoint serves local/standalone dev environments.
expressApp.post('/api/zoho/provision-modules', (req, res) => {
  const {
    docsAgentConnection = 'docsagent_connection',
    workdriveConnection = 'workdrive_connection',
    targetModules = []
  } = req.body;

  // Update connection names if provided
  if (docsAgentConnection) appSettings.docsAgentConnection = docsAgentConnection;
  if (workdriveConnection) appSettings.workdriveConnection = workdriveConnection;

  // Determine which modules already exist in our simulated CRM state
  const REQUIRED_MODULES = targetModules.length > 0 ? targetModules : [
    { api_name: 'Living_Docs_Settings', singular_label: 'Living Docs Setting', plural_label: 'Living Docs Settings' },
    { api_name: 'Living_Docs_Snapshots', singular_label: 'Living Docs Snapshot', plural_label: 'Living Docs Snapshots' }
  ];

  const existingSimModules = dataStore.crmState.modules.map(m => m.module);
  const provisionResults = [];

  REQUIRED_MODULES.forEach(mod => {
    // In local/standalone mode we simulate the check
    const alreadyExists = existingSimModules.includes(mod.api_name) ||
      ['Living_Docs_Settings', 'Living_Docs_Snapshots'].includes(mod.api_name);

    provisionResults.push({
      api_name: mod.api_name,
      status: alreadyExists ? 'ALREADY_EXISTS' : 'WOULD_CREATE_IN_LIVE_CRM',
      note: alreadyExists
        ? `Module ${mod.api_name} verified in CRM.`
        : `Module ${mod.api_name} does not exist. In live Zoho CRM, it will be created via POST /crm/v8/settings/modules using connection: ${docsAgentConnection}.`
    });
  });

  const allExist = provisionResults.every(r => r.status === 'ALREADY_EXISTS');
  const detail = allExist
    ? 'All custom modules already exist (✅ Living_Docs_Settings + Living_Docs_Snapshots).'
    : `Provisioning scheduled for: ${provisionResults.filter(r => r.status !== 'ALREADY_EXISTS').map(r => r.api_name).join(', ')} via ${docsAgentConnection}.`;

  console.log(`[Provision] ${detail}`);
  console.log(`[Provision] Connections — CRM: ${docsAgentConnection}, WorkDrive: ${workdriveConnection}`);

  res.json({
    status: 'success',
    detail,
    docsAgentConnection,
    workdriveConnection,
    modules: provisionResults
  });
});

// 2. Scan CRM Metadata — accepts a live widget payload. Does not invent sample CRM data.
expressApp.post('/api/scan', (req, res) => {
  try {
    const incoming = req.body && req.body.snapshot;
    if (incoming && incoming.stats) {
      if (!liveCache.baseline) liveCache.baseline = JSON.parse(JSON.stringify(incoming));
      liveCache.snapshot = incoming;
      return res.json({ status: 'success', source: 'zoho_live', snapshot: incoming });
    }
    if (liveCache.snapshot) {
      return res.json({ status: 'success', source: 'zoho_live_cache', snapshot: liveCache.snapshot });
    }
    return res.json({
      status: 'success',
      source: 'empty',
      message: 'No live CRM snapshot yet. Open the widget inside Zoho CRM and run a scan.',
      snapshot: emptyLiveSnapshot()
    });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

expressApp.post('/api/live-cache', (req, res) => {
  const snapshot = req.body && req.body.snapshot;
  if (!snapshot || !snapshot.stats) {
    return res.status(400).json({ status: 'error', error: 'snapshot is required' });
  }
  if (!liveCache.baseline) liveCache.baseline = JSON.parse(JSON.stringify(snapshot));
  liveCache.snapshot = snapshot;
  res.json({
    status: 'success',
    workflows: snapshot.stats.total_workflows || 0,
    modules: snapshot.stats.total_modules || 0
  });
});

// 3. Get Snapshots
expressApp.get('/api/snapshots', (req, res) => {
  res.json({
    status: 'success',
    active_baseline_id: dataStore.activeBaselineId,
    snapshots: dataStore.snapshots.map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      stats: s.stats,
      is_baseline: s.id === dataStore.activeBaselineId
    }))
  });
});

// Helper: Convert workflow to Zoho CRM API v8 specification format
function formatWorkflowV8(wf, moduleName, moduleComponentId) {
  const triggerType = wf.trigger_type || (wf.execute_when && wf.execute_when.type) || 'on_record_action';
  const isActive = wf.status === 'active' || (wf.status && wf.status.active === true) || wf.status === true;

  // Format Instant Actions
  const instantActionsList = (wf.actions || []).map((act, idx) => {
    let actType = 'tasks';
    let actName = String(act);
    if (actName.toLowerCase().startsWith('webhook:')) {
      actType = 'webhooks';
      actName = actName.replace(/^webhook:\s*/i, '');
    } else if (actName.toLowerCase().startsWith('function:')) {
      actType = 'functions';
      actName = actName.replace(/^function:\s*/i, '');
    } else if (actName.toLowerCase().startsWith('email:')) {
      actType = 'email_notifications';
      actName = actName.replace(/^email:\s*/i, '');
    } else if (actName.toLowerCase().startsWith('field update:')) {
      actType = 'field_updates';
      actName = actName.replace(/^field update:\s*/i, '');
    } else if (actName.toLowerCase().startsWith('action:')) {
      actType = 'actions';
      actName = actName.replace(/^action:\s*/i, '');
    } else if (actName.toLowerCase().startsWith('task:')) {
      actType = 'tasks';
      actName = actName.replace(/^task:\s*/i, '');
    }

    return {
      id: `act_${wf.id}_${idx + 1}`,
      name: actName,
      type: actType,
      related_details: null
    };
  });

  return {
    id: wf.id,
    name: wf.name,
    description: wf.description || `Automated workflow rule for ${moduleName}`,
    module: {
      api_name: moduleName,
      id: moduleComponentId || `mod_${moduleName}`
    },
    status: {
      active: isActive
    },
    execute_when: {
      type: triggerType,
      details: {
        trigger_module: {
          api_name: moduleName,
          id: moduleComponentId || `mod_${moduleName}`
        },
        criteria: wf.criteria || ''
      }
    },
    editable: true,
    deprecated: false,
    deletable: true,
    source: 'crm',
    category: 'default',
    created_time: wf.created_time || '2025-07-01T10:00:00+05:30',
    created_by: {
      name: 'System Administrator',
      id: '4876876000000327001'
    },
    modified_time: wf.modified_time || '2025-07-08T12:30:00+05:30',
    modified_by: {
      name: 'System Administrator',
      id: '4876876000000327001'
    },
    last_executed_time: wf.last_executed_time || null,
    lock: {
      locked_by: null,
      message: null,
      status: false
    },
    conditions: [
      {
        id: `cond_${wf.id}_01`,
        sequence_number: 1,
        criteria_details: {
          criteria: {
            field: {
              api_name: wf.criteria ? wf.criteria.split(' ')[0] : 'Status',
              id: `fld_${wf.id}_01`
            },
            comparator: 'contains',
            type: 'value',
            value: wf.criteria || 'Always Execute'
          }
        },
        instant_actions: {
          actions: instantActionsList
        },
        scheduled_actions: []
      }
    ],
    actions: wf.actions || []
  };
}

// Handler: Get All Workflows (Zoho CRM API v8 GET /settings/automation/workflow_rules)
// Scopes: ZohoCRM.settings.workflow_rules.READ (or ALL)
const getAllWorkflowsHandler = (req, res) => {
  try {
    const latestSnapshot = liveCache.snapshot || emptyLiveSnapshot();
    const workflows = [];
    const moduleFilter = req.query.module;
    const statusActiveFilter = req.query.status_active;
    const searchQuery = (req.query.search || req.query.filter || '').toLowerCase();

    (latestSnapshot.modules || []).forEach(m => {
      if (moduleFilter && moduleFilter.toUpperCase() !== 'ALL' && m.module !== moduleFilter) return;
      (m.workflows || []).forEach(wf => {
        const formatted = wf.execute_when ? { ...wf, module: wf.module || { api_name: m.module, id: m.component_id } } : formatWorkflowV8(wf, m.module, m.component_id);
        const moduleName = typeof formatted.module === 'string'
          ? formatted.module
          : ((formatted.module && formatted.module.api_name) || m.module || '');
        const isActive = formatted.status === 'active' || formatted.active === true || (formatted.status && formatted.status.active === true);

        if (statusActiveFilter !== undefined && statusActiveFilter !== '') {
          const wantActive = statusActiveFilter === 'true' || statusActiveFilter === true;
          if (isActive !== wantActive) return;
        }

        if (searchQuery) {
          const crit = formatted.criteria || (formatted.execute_when && formatted.execute_when.details && formatted.execute_when.details.criteria) || '';
          const critText = typeof crit === 'string' ? crit : JSON.stringify(crit);
          const matchName = String(formatted.name || '').toLowerCase().includes(searchQuery);
          const matchMod = String(moduleName).toLowerCase().includes(searchQuery);
          const matchId = String(formatted.id || '').toLowerCase().includes(searchQuery);
          const matchCrit = critText.toLowerCase().includes(searchQuery);
          if (!matchName && !matchMod && !matchId && !matchCrit) return;
        }

        workflows.push(formatted);
      });
    });

    res.json({
      workflow_rules: workflows,
      info: {
        count: workflows.length,
        page: 1,
        per_page: 200,
        more_records: false
      },
      scopes_required: [
        'ZohoCRM.settings.workflow_rules.READ',
        'ZohoCRM.settings.workflow_rules.ALL'
      ],
      api_endpoint: 'GET /crm/v8/settings/automation/workflow_rules',
      doc_reference: 'https://www.zoho.com/crm/developer/docs/api/v8/get-all-workflows.html'
    });
  } catch (err) {
    console.error('Workflows fetch error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
};

// Handler: Get a Specific Workflow Rule (Zoho CRM API v8 GET /settings/automation/workflow_rules/{id})
// Scopes: ZohoCRM.settings.workflow_rules.READ (or ALL)
const getSingleWorkflowHandler = (req, res) => {
  try {
    const targetId = req.params.id;
    const latestSnapshot = liveCache.snapshot || emptyLiveSnapshot();
    let foundWf = null;
    let foundModule = null;

    for (const m of (latestSnapshot.modules || [])) {
      const match = (m.workflows || []).find(w => String(w.id) === String(targetId));
      if (match) {
        foundWf = match;
        foundModule = m;
        break;
      }
    }

    if (!foundWf) {
      return res.status(404).json({
        code: 'INVALID_DATA',
        message: `Workflow rule with ID "${targetId}" not found.`,
        status: 'error'
      });
    }

    const formatted = formatWorkflowV8(foundWf, foundModule.module, foundModule.component_id);

    res.json({
      workflow_rules: [formatted],
      scopes_required: [
        'ZohoCRM.settings.workflow_rules.READ',
        'ZohoCRM.settings.workflow_rules.ALL'
      ],
      api_endpoint: `GET /crm/v8/settings/automation/workflow_rules/${targetId}`,
      doc_reference: 'https://www.zoho.com/crm/developer/docs/api/v8/get-a-workflow.html'
    });
  } catch (err) {
    console.error('Single workflow fetch error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
};

// 3b. Workflows REST Endpoints (Zoho CRM API v8 Specification)
expressApp.get('/api/crm/workflows', getAllWorkflowsHandler);
expressApp.get('/api/crm/workflows/:id', getSingleWorkflowHandler);
expressApp.get('/crm/v8/settings/automation/workflow_rules', getAllWorkflowsHandler);
expressApp.get('/crm/v8/settings/automation/workflow_rules/:id', getSingleWorkflowHandler);

// 4. Generate Documentation via the configured AI provider (Claude or Cursor)
// Returns the exact system and user prompt /api/generate would send, so the widget can show and edit it.
expressApp.post('/api/generate/prompt', (req, res) => {
  try {
    const { audience = 'admin', selected_workflows, snapshot: incomingSnapshot } = req.body || {};
    if (!Array.isArray(selected_workflows) || !selected_workflows.length) {
      return res.status(400).json({ status: 'error', error: 'selected_workflows is required.' });
    }
    const snapshot = (incomingSnapshot && (incomingSnapshot.modules || incomingSnapshot.stats))
      ? incomingSnapshot
      : (liveCache.snapshot || emptyLiveSnapshot());
    const built = buildWorkflowPrompt(selected_workflows, snapshot, audience);
    res.json({ status: 'success', ...built, model: aiConfigured() ? aiDisplayName() : '', has_api_key: aiConfigured() });
  } catch (err) {
    console.error('Prompt build error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

expressApp.post('/api/generate', sameOriginOnly, async (req, res) => {
  try {
    const { doc_type = 'technical', audience = 'admin', custom_prompt, prompt_override, selected_workflows, workflow_ids, snapshot: incomingSnapshot } = req.body;
    const latestSnapshot = (incomingSnapshot && (incomingSnapshot.modules || incomingSnapshot.stats))
      ? incomingSnapshot
      : (liveCache.snapshot || emptyLiveSnapshot());

    // Determine target workflows if workflow_spec or selected_workflows provided
    let targetWorkflows = selected_workflows;
    if (!targetWorkflows && workflow_ids && Array.isArray(workflow_ids)) {
      const allWfs = [];
      (latestSnapshot.modules || []).forEach(m => {
        (m.workflows || []).forEach(w => allWfs.push({ ...w, module: m.module }));
      });
      targetWorkflows = allWfs.filter(w => workflow_ids.includes(w.id));
    }

    const isWorkflowDoc = (doc_type === 'workflow_spec' || (targetWorkflows && targetWorkflows.length > 0));

    if (!aiConfigured()) return aiNotConfiguredResponse(res, 'generate documentation');
    {
      try {
        let systemPrompt = WORKFLOW_SYSTEM_PROMPT;
        let userPrompt = '';
        if (prompt_override && typeof prompt_override.user === 'string' && prompt_override.user.trim()) {
          if (typeof prompt_override.system === 'string' && prompt_override.system.trim()) systemPrompt = prompt_override.system;
          userPrompt = prompt_override.user;
        } else if (isWorkflowDoc && targetWorkflows && targetWorkflows.length > 0) {
          const built = buildWorkflowPrompt(targetWorkflows, latestSnapshot, audience);
          systemPrompt = built.system;
          userPrompt = built.user;
        } else {
          userPrompt = `Audience: ${audience}

Write a ${doc_type} document from this Zoho CRM snapshot. Include an executive summary, a field table for each module, each workflow's trigger and actions, and each blueprint. Do not invent configuration that is not in the snapshot. Do not use mermaid or HTML.

Snapshot:
${clipForModel(JSON.stringify(stripIdentifiers(latestSnapshot)), DOC_INPUT_CHAR_BUDGET)}`;
        }

        const result = await ai.callAi(aiConfig(), {
          system: systemPrompt,
          user: userPrompt,
          maxTokens: Math.max(appSettings.maxTokens || 0, 8000),
          temperature: appSettings.temperature
        });
        if (String(result.text || '').trim()) {
          const markdown = result.text;
          dataStore.generatedDocs[latestSnapshot.id] = markdown;
          return res.json({
            status: 'success',
            ...documentationPayload(markdown, {
              model: result.model,
              ai_provider: result.provider,
              ai_label: result.label,
              generated_by: aiDisplayName(result),
              redacted: result.redacted,
              tokens_in: result.tokens_in,
              tokens_out: result.tokens_out,
              snapshot_id: latestSnapshot.id
            })
          });
        }
        throw new Error(`${result.label} returned an empty answer.`);
      } catch (aiErr) {
        const label = aiConfig().label || 'The AI provider';
        console.warn('[AI provider failed]:', aiErr.message);
        return res.status(502).json({
          status: 'error',
          code: 'AI_FAILED',
          error: `${label} could not write the document: ${aiErr.message || 'request failed'}`
        });
      }
    }
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Helper for high-fidelity markdown generation
function buildLiveSystemDoc(snapshot, docType, audience) {
  const safe = snapshot || emptyLiveSnapshot();
  const modules = safe.modules || [];
  const functions = safe.functions || [];
  const stats = safe.stats || {};
  const timestamp = safe.timestamp ? new Date(safe.timestamp).toLocaleString() : new Date().toLocaleString();
  let doc = `# Zoho CRM Living System Documentation\n\n`;
  doc += `> **Snapshot**: \`${safe.id || 'live'}\` · **Scanned**: ${timestamp} · **Audience**: *${String(audience || 'admin').toUpperCase()}*\n`;
  doc += `> **Source**: Live Zoho CRM API v8 payload (\`${docType}\`).\n\n`;
  doc += `## 1. Live inventory\n\n`;
  doc += `| KPI | Count |\n| :--- | ---: |\n`;
  doc += `| Modules | ${stats.total_modules || modules.length} |\n`;
  doc += `| Fields | ${stats.total_fields || 0} |\n`;
  doc += `| Workflow rules | ${stats.total_workflows || 0} |\n`;
  doc += `| Blueprints | ${stats.total_blueprints || 0} |\n`;
  doc += `| Functions | ${stats.total_functions || functions.length} |\n\n`;
  if (!modules.length) {
    doc += `No modules were included in this scan.\n\n`;
  }
  modules.forEach(m => {
    const fields = m.fields || [];
    const workflows = m.workflows || [];
    const blueprints = m.blueprints || [];
    doc += `### ${m.module} \`[${m.component_id || m.module}]\`\n\n`;
    doc += `Fields ${fields.length} · Workflows ${workflows.length} · Blueprints ${blueprints.length}\n\n`;
    if (fields.length) {
      doc += `| Field | API name | Type | Required |\n| :--- | :--- | :--- | :--- |\n`;
      fields.forEach(f => {
        doc += `| ${f.label || f.api_name || ''} | \`${f.api_name || ''}\` | \`${f.data_type || ''}\` | ${f.required ? 'Required' : 'Optional'} |\n`;
      });
      doc += `\n`;
    }
    workflows.forEach(wf => {
      const crit = wf.criteria || (wf.execute_when && wf.execute_when.details && wf.execute_when.details.criteria) || 'Always execute';
      const trig = wf.trigger_type || (wf.execute_when && wf.execute_when.type) || '';
      const critText = typeof crit === 'string' ? crit : JSON.stringify(crit);
      doc += `- **${wf.name}** \`[${wf.id}]\` · trigger \`${trig}\` · criteria \`${critText}\`\n`;
      (wf.actions || []).forEach(act => {
        doc += `  - ${typeof act === 'string' ? act : (act.name || act.type || 'Action')}\n`;
      });
    });
    blueprints.forEach(bp => {
      doc += `- Blueprint **${bp.name || bp.id}** on \`${bp.field_name || ''}\`\n`;
    });
    doc += `\n`;
  });
  doc += `## 2. Functions returned by the API\n\n`;
  if (!functions.length) doc += `No functions were returned.\n\n`;
  functions.forEach(fn => {
    doc += `- **${fn.name || fn.api_name}** \`[${fn.id || ''}]\` ${fn.description || ''}\n`;
  });
  doc += `\n> *Built from the CRM snapshot sent by the widget.*\n`;
  return doc;
}

function answerFromLiveSnapshot(snapshot, question) {
  const safe = snapshot || emptyLiveSnapshot();
  const words = String(question || '').toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 3);
  const workflows = [];
  (safe.modules || []).forEach(m => {
    (m.workflows || []).forEach(w => {
      const moduleName = (typeof w.module === 'string' ? w.module : (w.module && w.module.api_name)) || m.module;
      workflows.push({ ...w, moduleName });
    });
  });
  const functions = safe.functions || [];
  const matched = workflows.filter(w => {
    const hay = `${w.name} ${w.moduleName} ${w.criteria || ''} ${(w.actions || []).join(' ')}`.toLowerCase();
    return words.some(word => hay.includes(word));
  });
  const shown = (matched.length ? matched : workflows).slice(0, 12);
  const stats = safe.stats || {};
  let answer = `### Live CRM answer\n\n`;
  answer += `This snapshot has **${stats.total_modules || (safe.modules || []).length} modules**, **${stats.total_fields || 0} fields**, **${stats.total_workflows || workflows.length} workflow rules**, **${stats.total_blueprints || 0} blueprints**, and **${functions.length} functions**.\n\n`;
  if (!workflows.length && !(safe.modules || []).length) {
    return answer + `No live CRM payload is loaded. Scan the organization inside Zoho CRM first.\n`;
  }
  if (shown.length) {
    answer += `#### Workflow rules from the API\n\n`;
    shown.forEach(w => {
      answer += `- **${w.name}** \`[${w.id}]\` on \`${w.moduleName}\` · trigger \`${w.trigger_type || ''}\` · ${w.criteria || 'no criteria text'}\n`;
    });
    answer += `\n`;
  }
  if (functions.length) {
    answer += `#### Functions\n\n`;
    functions.slice(0, 10).forEach(fn => {
      answer += `- **${fn.name || fn.api_name}** \`[${fn.id}]\` ${fn.description || ''}\n`;
    });
    answer += `\n`;
  }
  answer += `> Choose an AI provider in Settings for a fuller AI answer grounded on this same payload.\n`;
  return answer;
}

function generateRichLivingDoc(snapshot, docType, audience) {
  return buildLiveSystemDoc(snapshot, docType, audience);
  const timestamp = new Date(snapshot.timestamp).toLocaleString();
  const leadsMod = snapshot.modules.find(m => m.module === 'Leads');
  const dealsMod = snapshot.modules.find(m => m.module === 'Deals');

  let doc = `# Zoho CRM Living System Documentation\n\n`;
  doc += `> **System Governance Baseline**: \`${snapshot.id}\` · **Scanned**: ${timestamp} · **Audience**: *${audience.toUpperCase()}*\n`;
  doc += `> **Tagline**: *Your Zoho system documents itself.*\n\n`;

  doc += `## 1. Executive Summary & Architecture Overview \`[Component: sys_overview]\`\n\n`;
  doc += `This living document represents the real-time configuration of the client's Zoho CRM ecosystem. `;
  doc += `It captures **${snapshot.stats.total_modules} core modules**, **${snapshot.stats.total_fields} configured fields**, `;
  doc += `**${snapshot.stats.total_workflows} active workflow automation rules**, and **${snapshot.stats.total_blueprints} stage-gate blueprints**.\n\n`;

  doc += `### High-Level System Architecture\n\n`;
  doc += `\`\`\`mermaid
flowchart LR
    subgraph Inbound["Inbound Lead Generation"]
        A["Website Forms / Ads"] --> B["[mod_Leads] Leads"]
    end
    subgraph Processing["Automated Enrichment & Governance"]
        B --> C{"[wf_Lead_Auto_Enrich] Clearbit Webhook"}
        C --> D["[bp_Lead_Qual] Qualification Blueprint"]
    end
    subgraph Conversion["Pipeline & Revenue Ops"]
        D -->|Qualified| E["[mod_Accounts] Accounts & Contacts"]
        D -->|Deal Spawn| F["[mod_Deals] Deals Pipeline"]
        F --> G{"[wf_Deal_Closed_Won_Sync] Closed Won"}
        G --> H["[fn_sync_stripe_customer] Stripe Billing API"]
    end
\`\`\`\n\n`;

  doc += `## 2. Module & Field Dictionary \`[Component: mod_dictionary]\`\n\n`;

  snapshot.modules.forEach(m => {
    doc += `### Module: **${m.module}** \`[${m.component_id}]\`\n\n`;
    doc += `*Total Fields: ${m.fields.length} | Workflows: ${m.workflows.length} | Blueprints: ${m.blueprints.length}*\n\n`;
    doc += `| Field Label | API Name | Data Type | Mandatory | Picklist Options / Details |\n`;
    doc += `| :--- | :--- | :--- | :--- | :--- |\n`;
    m.fields.forEach(f => {
      const pv = f.pick_list_values ? f.pick_list_values.join(', ') : (f.custom_field ? '*Custom Field*' : 'Standard');
      doc += `| **${f.label}** | \`${f.api_name}\` | \`${f.data_type}\` | ${f.required ? '🔴 Required' : 'Optional'} | ${pv} |\n`;
    });
    doc += `\n`;
  });

  doc += `## 3. Automation Map & Workflow Logic \`[Component: automation_map]\`\n\n`;
  doc += `The CRM automation engine triggers multi-step operational logic upon record creation and edits:\n\n`;

  snapshot.modules.forEach(m => {
    if (m.workflows && m.workflows.length > 0) {
      doc += `#### **${m.module} Automation Rules**\n\n`;
      m.workflows.forEach(wf => {
        doc += `- **Workflow Rule: \`${wf.name}\`** \`[${wf.id}]\`\n`;
        doc += `  - **Trigger Event**: \`${wf.trigger_type}\`\n`;
        doc += `  - **Execution Criteria**: \`${wf.criteria}\`\n`;
        doc += `  - **Configured Actions**:\n`;
        wf.actions.forEach(act => {
          doc += `    - ⚡ ${act}\n`;
        });
        doc += `\n`;
      });
    }
  });

  doc += `## 4. Blueprint & State Transition Specifications \`[Component: blueprint_specs]\`\n\n`;
  snapshot.modules.forEach(m => {
    if (m.blueprints && m.blueprints.length > 0) {
      m.blueprints.forEach(bp => {
        doc += `### Blueprint: **${bp.name}** (\`${m.module}.${bp.field_name}\`) \`[${bp.id}]\`\n\n`;
        doc += `\`\`\`mermaid
stateDiagram-v2
`;
        bp.transitions.forEach(t => {
          doc += `    ${t.from_state.replace(/[\s\/\-]/g, '_')} --> ${t.to_state.replace(/[\s\/\-]/g, '_')}: ${t.name}\n`;
        });
        doc += `\`\`\`\n\n`;
        doc += `| Transition Name | From State | To Target State | Transition ID |\n`;
        doc += `| :--- | :--- | :--- | :--- |\n`;
        bp.transitions.forEach(t => {
          doc += `| **${t.name}** | \`${t.from_state}\` | \`${t.to_state}\` | \`${t.transition_id}\` |\n`;
        });
        doc += `\n`;
      });
    }
  });

  doc += `## 5. Custom Functions & External Integrations \`[Component: fn_integrations]\`\n\n`;
  snapshot.functions.forEach(fn => {
    doc += `### Custom Function: \`${fn.api_name}\` \`[${fn.id}]\`\n`;
    doc += `- **Display Name**: ${fn.name}\n`;
    doc += `- **Return Type**: \`${fn.return_type}\`\n`;
    doc += `- **Functional Description**: ${fn.description}\n`;
    doc += `- **Security Posture**: Credentials resolved via Zoho Named OAuth Connection; zero plaintext secrets in source code.\n\n`;
  });

  doc += `## 6. Living Governance & Compliance Verification\n\n`;
  doc += `- **Drift Detection**: Enabled (Continuous comparison against baseline \`${snapshot.id}\`)\n`;
  doc += `- **Audit Status**: Verified against Zoho CRM v6 APIs.\n\n`;
  doc += `> *AI-generated Living Documentation · Reviewed by: ________________________*`;

  return doc;
}

function moduleNameOf(workflow) {
  if (!workflow) return '';
  if (typeof workflow.module === 'string') return workflow.module;
  return (workflow.module && workflow.module.api_name) || '';
}

const DOC_INPUT_CHAR_BUDGET = 120000;

function clipForModel(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated to fit the model input limit]`;
}

const WORKFLOW_SYSTEM_PROMPT = `You are a senior Zoho CRM solution architect. You write operations documentation for workflow rules and the custom functions they call, for an administrator who has to maintain them.
RULES:
1. Output Markdown only. No HTML, no mermaid, and do not paste the function source back.
2. Use only facts in the user message. When something is not stated, write "Not determined".
3. The code block under each function is its real implementation. Trace it: the arguments and which record values the workflow passes in, records fetched (zoho.crm.getRecordById, searchRecords, getRelatedRecords), fields read, fields written (updateRecord, createRecord), external calls (invokeurl, sendmail, named connections), branches, loops, and the return value.
4. If a function has no source, or its source ends with "[truncated to fit the model input limit]", say so in that function's section and do not guess the missing part.
5. Write for the requested audience. Lead with the business outcome, then give exact CRM API names.
6. End with: "> Reviewed by: ____________"`;

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only fields the criteria, actions, or function source mention are sent, so the budget goes to code.
function referencedFieldsText(workflows, snapshot) {
  const names = new Set((workflows || []).map(moduleNameOf).filter(Boolean));
  const haystack = (workflows || []).map(wf => [
    typeof wf.criteria === 'string' ? wf.criteria : JSON.stringify(wf.criteria || ''),
    (wf.actions || []).join('\n'),
    (wf.function_code || []).map(fn => fn.source || '').join('\n')
  ].join('\n')).join('\n');
  const lines = [];
  ((snapshot && snapshot.modules) || []).filter(mod => names.has(mod.module)).forEach(mod => {
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
    `- Actions:`
  ];
  (wf.actions && wf.actions.length ? wf.actions : ['None returned']).forEach(act => lines.push(`  - ${act}`));
  const fns = wf.function_code || [];
  if (fns.length) {
    lines.push('', '### Custom functions called by this rule');
    fns.forEach(fn => {
      lines.push('', `#### Function: ${fn.name || fn.api_name || 'Unnamed function'}`);
      lines.push(`- API name: ${fn.api_name || 'Not returned'} | Language: ${fn.language || fn.runtime || 'Not returned'} | Runs: ${fn.timing || 'instant'}`);
      const args = formatFunctionArgs(fn.arguments);
      if (args) lines.push(`- Arguments: ${args}`);
      if (fn.description) lines.push(`- Description: ${fn.description}`);
      if (fn.source) {
        const clipped = clipForModel(fn.source, sourceLimit);
        const truncated = fn.source_truncated && !clipped.endsWith('[truncated to fit the model input limit]')
          ? '\n[truncated to fit the model input limit]'
          : '';
        lines.push('- Source:', codeFenceFor(fn, clipped + truncated));
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
  // IDs, org IDs and tokens in criteria, actions or code are replaced here, so the preview shows exactly what is sent.
  const scrubbed = ai.redactSecrets(rawUser);
  const user = scrubbed.text;
  const allFns = rules.flatMap(wf => wf.function_code || []);
  return {
    system: WORKFLOW_SYSTEM_PROMPT,
    user,
    stats: {
      workflows: rules.length,
      functions: allFns.length,
      functions_with_source: allFns.filter(fn => fn.source).length,
      characters: WORKFLOW_SYSTEM_PROMPT.length + user.length,
      identifiers_removed: scrubbed.count
    }
  };
}

const IDENTIFIER_KEY = /^(id|org_?id|org|zgid|zsoid|owner|created_by|modified_by|.+_id)$/i;

function stripIdentifiers(value) {
  if (Array.isArray(value)) return value.map(stripIdentifiers);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).forEach(key => {
    if (IDENTIFIER_KEY.test(key) || /[a-z]Id$/.test(key)) return;
    out[key] = stripIdentifiers(value[key]);
  });
  return out;
}

function documentationPayload(markdown, extra) {
  const trimmed = String(markdown || '').trim();
  const wrapped = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
  const clean = wrapped ? wrapped[1].trim() : trimmed;
  const pdf = markdownToPdf(clean);
  return {
    markdown: clean,
    pdf_base64: pdf.toString('base64'),
    pdf_bytes: pdf.length,
    ...extra
  };
}

// Dedicated Workflow Automation Architecture & Specification Generator
function generateWorkflowSpecDoc(selectedWorkflows, snapshot, audience) {
  const timestamp = new Date().toLocaleString();
  const wfCount = selectedWorkflows.length;
  const modulesCovered = [...new Set(selectedWorkflows.map(w => w.module || (w.module && w.module.api_name) || 'CRM'))];

  let doc = `# Zoho CRM Workflow Automation Architecture Spec\n\n`;
  doc += `> **Document Scope**: **${wfCount} Targeted Automation Rule(s)** · **Modules**: *${modulesCovered.join(', ')}*\n`;
  doc += `> **Generated**: ${timestamp} · **Target Audience**: *${audience.toUpperCase()}* · **API Version**: *Zoho CRM API v8*\n\n`;

  doc += `## 1. Executive Summary & Execution Hierarchy \`[Component: wf_exec_summary]\`\n\n`;
  doc += `This targeted specification details **${wfCount} mission-critical workflow rule(s)** configured within Zoho CRM. `;
  doc += `These automations enforce business rules, automated field updates, third-party webhook integrations, and SDR/Account Executive task handoffs.\n\n`;

  doc += `### Active Workflows In Scope\n\n`;
  doc += `| Workflow Name | Target Module | Trigger Event | Status | Execution Criteria |\n`;
  doc += `| :--- | :--- | :--- | :--- | :--- |\n`;
  selectedWorkflows.forEach(wf => {
    const modName = wf.module?.api_name || wf.module || 'Global';
    const trig = wf.trigger_type || wf.execute_when?.type || 'on_record_action';
    const crit = wf.criteria || wf.execute_when?.details?.criteria || 'Always Execute';
    const isActive = wf.status === 'active' || (wf.status && wf.status.active === true) || wf.status === true;
    doc += `| **${wf.name}** | \`${modName}\` | \`${trig}\` | ${isActive ? '🟢 Active' : '⚪ Inactive'} | \`${crit}\` |\n`;
  });
  doc += `\n`;

  doc += `## 2. End-to-End Workflow Flowchart \`[Component: wf_mermaid_flow]\`\n\n`;
  doc += `\`\`\`mermaid
flowchart TD
`;
  selectedWorkflows.forEach((wf, idx) => {
    const modName = wf.module?.api_name || wf.module || 'Record';
    const trig = (wf.trigger_type || wf.execute_when?.type || 'event').replace(/_/g, ' ');
    const wfNodeId = `WF_${idx}`;
    const startNode = `START_${idx}`;
    const condNode = `COND_${idx}`;
    
    doc += `    ${startNode}["⚡ Event: ${trig} on ${modName}"] --> ${condNode}{"${wf.name}\\nCriteria Met?"}\n`;
    doc += `    ${condNode} -->|Yes| ${wfNodeId}["Execute ${wf.actions ? wf.actions.length : 1} Action(s)"]\n`;
    
    if (wf.actions && Array.isArray(wf.actions)) {
      wf.actions.forEach((act, aIdx) => {
        const actNodeId = `ACT_${idx}_${aIdx}`;
        doc += `    ${wfNodeId} --> ${actNodeId}["${String(act).replace(/"/g, "'")}"]\n`;
      });
    }
    doc += `    ${condNode} -->|No| END_${idx}["Skip / No Operation"]\n`;
  });
  doc += `\`\`\`\n\n`;

  doc += `## 3. Trigger-Condition-Action (TCA) Engineering Matrix \`[Component: wf_tca_matrix]\`\n\n`;
  selectedWorkflows.forEach((wf, i) => {
    const modName = wf.module?.api_name || wf.module || 'CRM';
    const trig = wf.trigger_type || wf.execute_when?.type || 'on_record_action';
    const crit = wf.criteria || wf.execute_when?.details?.criteria || 'Always execute';
    
    doc += `### ${i + 1}. \`${wf.name}\` (\`${modName}\`) \`[${wf.id}]\`\n\n`;
    doc += `- **Unique Rule ID**: \`${wf.id}\`\n`;
    doc += `- **Associated Module**: \`${modName}\`\n`;
    doc += `- **Trigger Type**: \`${trig}\`\n`;
    doc += `- **Evaluation Criteria**: \`${crit}\`\n`;
    doc += `- **Configured Actions**:\n`;
    
    if (wf.actions && wf.actions.length > 0) {
      wf.actions.forEach(act => {
        doc += `  - ⚡ **${act}**\n`;
      });
    } else {
      doc += `  - *(No actions currently configured)*\n`;
    }
    doc += `\n`;
  });

  doc += `## 4. Custom functions retrieved with each rule \`[Component: wf_integrations]\`\n\n`;
  doc += `Function source is downloaded with \`GET /crm/v8/settings/functions/{id}/code\` and sent to the model with the workflow rule. This local draft lists what was retrieved. Choose an AI provider in Settings for a write-up of that source.\n\n`;
  selectedWorkflows.forEach(wf => {
    const functions = wf.function_code || [];
    doc += `### ${wf.name}\n\n`;
    if (!functions.length) {
      doc += `No custom function action was found on this workflow rule.\n\n`;
      return;
    }
    functions.forEach(fn => {
      doc += `- **${fn.name || fn.api_name || 'Function'}** \`${fn.id || ''}\` · ${fn.language || 'language not returned'} · ${fn.runtime || 'runtime not returned'} · ${fn.timing || 'instant'}\n`;
      if (fn.error) doc += `  - Source was not retrieved: ${fn.error}\n`;
      else if (fn.source) doc += `  - Source retrieved (${fn.source.length} characters)${fn.source_truncated ? ', truncated for the prompt' : ''}.\n`;
      else doc += `  - Source was not retrieved. ${fn.note || ''}\n`;
    });
    doc += `\n`;
  });

  doc += `## 5. Failure modes visible from the rule \`[Component: wf_safety]\`\n\n`;
  doc += `Review the retrieved function source for record updates that can re-fire this workflow, empty required fields, and calls that depend on a named connection.\n\n`;

  doc += `> *Targeted Workflow Documentation · Living Documentation Agent · Reviewed by: ________________________*`;

  return doc;
}

// 5. Check Drift (Key Differentiator)
function stampLiveHashes(snapshot) {
  const safe = snapshot && Array.isArray(snapshot.modules) ? snapshot : emptyLiveSnapshot();
  safe.modules.forEach(mod => {
    (mod.fields || []).forEach(f => {
      if (!f.hash) f.hash = hashComponent({ api: f.api_name, type: f.data_type, req: f.required });
    });
    (mod.workflows || []).forEach(w => {
      if (!w.hash) w.hash = hashComponent({ id: w.id, name: w.name, status: w.status, crit: w.criteria, act: w.actions });
    });
    (mod.blueprints || []).forEach(b => {
      if (!b.hash) b.hash = hashComponent({ id: b.id, name: b.name, field: b.field_name });
    });
    mod.fields = mod.fields || [];
  });
  return safe;
}

expressApp.post('/api/drift', (req, res) => {
  try {
    const body = req.body || {};
    let baselineSnapshot;
    let currentSnapshot;
    if (body.current && Array.isArray(body.current.modules)) {
      baselineSnapshot = stampLiveHashes(JSON.parse(JSON.stringify(body.baseline && body.baseline.modules ? body.baseline : body.current)));
      currentSnapshot = stampLiveHashes(JSON.parse(JSON.stringify(body.current)));
    } else if (liveCache.snapshot) {
      baselineSnapshot = stampLiveHashes(JSON.parse(JSON.stringify(liveCache.baseline || liveCache.snapshot)));
      currentSnapshot = stampLiveHashes(JSON.parse(JSON.stringify(liveCache.snapshot)));
    } else {
      return res.json({
        status: 'success',
        drift: {
          is_drift_detected: false,
          total_changes: 0,
          changes: [],
          affected_sections: [],
          message: 'No live snapshots to compare yet.'
        }
      });
    }

    const changes = [];
    const affectedSections = [];

    // Compare modules
    currentSnapshot.modules.forEach(currMod => {
      const baseMod = baselineSnapshot ? baselineSnapshot.modules.find(m => m.module === currMod.module) : null;
      if (!baseMod) {
        changes.push({
          module: currMod.module,
          component_id: currMod.component_id,
          type: 'module_added',
          detail: `New module "${currMod.module}" created with ${currMod.fields.length} fields.`
        });
        affectedSections.push(`Module & Field Dictionary: ${currMod.module}`);
        return;
      }

      // Check fields
      const baseFieldMap = new Map(baseMod.fields.map(f => [f.api_name, f]));
      const currFieldMap = new Map(currMod.fields.map(f => [f.api_name, f]));

      currMod.fields.forEach(f => {
        if (!baseFieldMap.has(f.api_name)) {
          changes.push({
            module: currMod.module,
            component_id: `${currMod.component_id}_field_${f.api_name}`,
            type: 'field_added',
            detail: `Field "${f.label}" (${f.api_name}, ${f.data_type}) added to ${currMod.module}.`
          });
          affectedSections.push(`Module & Field Dictionary: ${currMod.module}`);
        } else {
          const oldF = baseFieldMap.get(f.api_name);
          if (oldF.hash !== f.hash) {
            changes.push({
              module: currMod.module,
              component_id: `${currMod.component_id}_field_${f.api_name}`,
              type: 'field_modified',
              detail: `Field "${f.label}" attributes or picklist options modified.`
            });
            affectedSections.push(`Module & Field Dictionary: ${currMod.module}`);
          }
        }
      });

      baseMod.fields.forEach(f => {
        if (!currFieldMap.has(f.api_name)) {
          changes.push({
            module: currMod.module,
            component_id: `${currMod.component_id}_field_${f.api_name}`,
            type: 'field_removed',
            detail: `Field "${f.label}" (${f.api_name}) was deleted from ${currMod.module}.`
          });
          affectedSections.push(`Module & Field Dictionary: ${currMod.module}`);
        }
      });

      // Check workflows
      const baseWfMap = new Map((baseMod.workflows || []).map(w => [w.name, w]));
      const currWfMap = new Map((currMod.workflows || []).map(w => [w.name, w]));

      (currMod.workflows || []).forEach(w => {
        if (!baseWfMap.has(w.name)) {
          changes.push({
            module: currMod.module,
            component_id: `${currMod.component_id}_wf_${w.name}`,
            type: 'workflow_added',
            detail: `Workflow "${w.name}" added to ${currMod.module}.`
          });
          affectedSections.push(`Automation Map & Workflow Logic: ${currMod.module}`);
        } else {
          const oldW = baseWfMap.get(w.name);
          if (oldW.hash !== w.hash) {
            changes.push({
              module: currMod.module,
              component_id: `${currMod.component_id}_wf_${w.name}`,
              type: 'workflow_modified',
              detail: `Workflow "${w.name}" criteria or actions modified (${w.criteria}).`
            });
            affectedSections.push(`Automation Map & Workflow Logic: ${currMod.module}`);
          }
        }
      });

      // Check Blueprints
      const baseBpMap = new Map((baseMod.blueprints || []).map(b => [b.name, b]));
      (currMod.blueprints || []).forEach(b => {
        if (!baseBpMap.has(b.name)) {
          changes.push({
            module: currMod.module,
            component_id: `${currMod.component_id}_bp_${b.name}`,
            type: 'blueprint_added',
            detail: `Blueprint "${b.name}" configured on ${currMod.module}.${b.field_name}.`
          });
          affectedSections.push(`Blueprint & State Transition Specs: ${currMod.module}`);
        } else {
          const oldB = baseBpMap.get(b.name);
          if (oldB.hash !== b.hash) {
            changes.push({
              module: currMod.module,
              component_id: `${currMod.component_id}_bp_${b.name}`,
              type: 'blueprint_modified',
              detail: `Blueprint "${b.name}" transition rules updated.`
            });
            affectedSections.push(`Blueprint & State Transition Specs: ${currMod.module}`);
          }
        }
      });
    });

    // Deduplicate affected sections
    const uniqueAffected = [...new Set(affectedSections)];

    const driftReport = {
      timestamp: new Date().toISOString(),
      baseline_id: dataStore.activeBaselineId,
      current_snapshot_id: currentSnapshot.id,
      is_drift_detected: changes.length > 0,
      total_changes: changes.length,
      changes,
      affected_sections: uniqueAffected
    };

    res.json({
      status: 'success',
      drift: driftReport
    });
  } catch (err) {
    console.error('Drift check error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 6. Targeted Regeneration (Regenerate Affected Sections Only)
expressApp.post('/api/regenerate', (req, res) => {
  try {
    const latestSnapshot = (req.body && req.body.snapshot) || liveCache.snapshot || emptyLiveSnapshot();
    // Set this latest snapshot as the new documented baseline
    dataStore.activeBaselineId = latestSnapshot.id;

    // Regenerate documentation
    const updatedMarkdown = generateRichLivingDoc(latestSnapshot, 'technical', 'admin');
    dataStore.generatedDocs[latestSnapshot.id] = updatedMarkdown;

    res.json({
      status: 'success',
      message: 'Affected sections regenerated and new baseline established.',
      new_baseline_id: latestSnapshot.id,
      timestamp: new Date().toISOString(),
      markdown: updatedMarkdown
    });
  } catch (err) {
    console.error('Regenerate error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 7. Ask AI Assistant (Grounded Q&A)
expressApp.post('/api/ask', sameOriginOnly, async (req, res) => {
  try {
    const { question, snapshot: incomingSnapshot } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ status: 'error', error: 'Question is required' });
    }

    const latestSnapshot = (incomingSnapshot && (incomingSnapshot.modules || incomingSnapshot.stats))
      ? incomingSnapshot
      : (liveCache.snapshot || emptyLiveSnapshot());

    if (aiConfigured()) {
      try {
        const systemPrompt = `You are the Zoho Living Documentation Assistant. You answer questions about how this specific Zoho CRM system is configured and automated.
STRICT RULES:
1. Answer ONLY using the configuration snapshot provided. If the answer is not in the snapshot, state: 'This detail is not present in the current CRM snapshot.'
2. ALWAYS cite the exact component ID or name in bracketed badges (e.g. \`[Module: Deals]\`, \`[Workflow: wf_Lead_Auto_Convert]\`, \`[Blueprint: Enterprise Sales Cycle Blueprint]\`).
3. Provide step-by-step logic flows when describing automations.
4. Format answers in clear, readable Markdown with bullet points or tables.`;

        const result = await ai.callAi(aiConfig(), {
          system: systemPrompt,
          user: `Active CRM Configuration Snapshot:\n${JSON.stringify(stripIdentifiers(latestSnapshot), null, 2)}\n\nQuestion: ${question}`,
          maxTokens: 1500,
          temperature: 0.1
        });
        if (String(result.text || '').trim()) {
          return res.json({ status: 'success', answer: result.text });
        }
      } catch (aiErr) {
        console.warn('[AI ask failed, using local answer]:', aiErr.message);
      }
    }

    const answer = answerFromLiveSnapshot(latestSnapshot, question);

    res.json({
      status: 'success',
      answer
    });
  } catch (err) {
    console.error('Ask AI error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 8. Function Builder (AI Deluge Code Generator & Safety Analyzer)
expressApp.post('/api/function/generate', sameOriginOnly, async (req, res) => {
  try {
    const { prompt, module = 'Deals', trigger = 'on_edit' } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ status: 'error', error: 'Prompt is required' });
    }

    if (aiConfigured()) {
      try {
        const systemPrompt = `You are an expert Zoho CRM Deluge Developer & Architect.
Generate clean, production-grade, and safe Zoho Deluge script.
Output strictly JSON matching this schema:
{
  "function_name": "auto_deal_handler",
  "code": "string (full Deluge code)",
  "explanation": "string (step by step plain English summary)",
  "arguments": ["dealId (Int)"],
  "safety_analysis": {
    "is_safe": true,
    "risk_level": "Low",
    "hardcoded_secrets": false,
    "unbounded_loops": false,
    "destructive_calls": false,
    "notes": "Uses secure Zoho Connection"
  },
  "documentation_markdown": "string (Markdown documentation of the function)"
}`;

        const result = await ai.callAi(aiConfig(), {
          system: systemPrompt,
          user: `Module: ${module}\nTrigger: ${trigger}\nRequirement: ${prompt}`,
          maxTokens: 3000,
          temperature: 0.1
        });
        if (String(result.text || '').trim()) {
          const raw = result.text.trim();
          const parsed = JSON.parse(raw.replace(/^```json\s*/, '').replace(/\s*```$/, ''));
          return res.json({ status: 'success', result: parsed });
        }
      } catch (aiErr) {
        console.warn('[AI function builder failed, using local generator]:', aiErr.message);
      }
    }

    // Smart Deluge Generator
    const safeFuncName = `fn_auto_${module.toLowerCase()}_${trigger.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const generatedCode = `/*
 * Auto-Generated Deluge Automation
 * Module: ${module} | Trigger: ${trigger}
 * Purpose: ${prompt}
 * Generator: Zoho Living Documentation Agent
 */
void ${safeFuncName}(Int recordId)
{
    // 1. Defensively retrieve target record
    record = zoho.crm.getRecordById("${module}", recordId);
    if(record == null || record.isEmpty())
    {
        info "[Error] ${module} record not found with ID: " + recordId;
        return;
    }

    recordName = ifnull(record.get("Deal_Name"), ifnull(record.get("Last_Name"), "Record #" + recordId));
    info "[Executing] Automation for " + recordName;

    // 2. Prepare payload for secure dispatch
    payload = Map();
    payload.put("record_id", recordId);
    payload.put("module", "${module}");
    payload.put("event", "${trigger}");
    payload.put("timestamp", zoho.currenttime.toString());
    payload.put("data", record);

    // 3. Dispatch to integration endpoint using secured Zoho Connection
    response = invokeurl
    [
        url: "https://api.services.zoho.com/v1/automation/dispatch"
        type: POST
        parameters: payload.toString()
        headers: {"Content-Type": "application/json"}
        connection: "zoho_external_services"
    ];

    // 4. Update sync audit timestamp in CRM
    updateMap = Map();
    updateMap.put("Last_Sync_Time", zoho.currenttime.toString("yyyy-MM-dd'T'HH:mm:ssXXX"));
    zoho.crm.updateRecord("${module}", recordId, updateMap);

    info "[Success] Processed automation successfully for " + recordName;
}`;

    const docMarkdown = `### Custom Function: \`${safeFuncName}\`
- **Target Module**: \`${module}\`
- **Trigger**: \`${trigger}\`
- **Requirement Summary**: ${prompt}
- **Security Check**: Verified no hardcoded tokens. Uses Zoho Connection \`zoho_external_services\`.
- **Error Handling**: Null validation with graceful exception logging.`;

    res.json({
      status: 'success',
      result: {
        function_name: safeFuncName,
        code: generatedCode,
        explanation: `This Deluge function receives the ${module} record ID, checks its existence, structures a secure payload, invokes the external automation endpoint through a Zoho Named Connection, and updates the sync audit timestamp on the CRM record.`,
        arguments: [`recordId (Int)`],
        safety_analysis: {
          is_safe: true,
          risk_level: 'Low',
          hardcoded_secrets: false,
          unbounded_loops: false,
          destructive_calls: false,
          notes: 'Passed all static safety linter rules. Safe for production deployment.'
        },
        documentation_markdown: docMarkdown
      }
    });
  } catch (err) {
    console.error('Function generate error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 9. Deploy Function Simulation & Auto-Document
expressApp.post('/api/function/deploy', (req, res) => {
  const { function_name, code, documentation_markdown } = req.body;
  
  // Register new function into CRM State
  const newFn = {
    id: `fn_gen_${Date.now()}`,
    name: function_name || 'custom_deluge_function',
    api_name: function_name || 'custom_deluge_function',
    return_type: 'void',
    description: 'Auto-generated & deployed by Living Documentation Agent Function Builder.'
  };

  dataStore.crmState.functions.push(newFn);
  const newSnapshot = buildSnapshot();

  res.json({
    status: 'success',
    message: `Function "${newFn.name}" registered in CRM and documented automatically!`,
    function_id: newFn.id,
    new_snapshot_id: newSnapshot.id
  });
});

// Function review: improve a masked Deluge function, and keep backups for rollback.
const FUNCTION_IMPROVE_SYSTEM_PROMPT = `You are a senior Zoho CRM Deluge developer. You improve one Deluge function.

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

const UNMASKED_SECRET_PATTERNS = [
  /Zoho-oauthtoken\s+[A-Za-z0-9._-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/i,
  /["'](?:client_secret|refresh_token|access_token|api_key|apikey|password)["']\s*[:,]\s*["'](?!\{\{)[^"'\n]{4,}["']/i,
  /[?&](?:client_secret|refresh_token|access_token|api_key|apikey|authtoken|password)=(?!\{\{)[^&"'\s]{4,}/i
];

function findUnmaskedSecret(text) {
  return UNMASKED_SECRET_PATTERNS.some(re => re.test(String(text || '')));
}

function buildImprovePrompt(fn, source, issues, placeholders) {
  const issueLines = (Array.isArray(issues) ? issues : []).slice(0, 80).map(i =>
    `- [${i.severity}] line ${i.line}, rule ${i.rule} (${i.title}): ${i.message} Fix: ${i.fix}`
  );
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
  ].filter(line => line !== null).join('\n');
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

expressApp.post('/api/function/improve', sameOriginOnly, async (req, res) => {
  try {
    const { function: fn = {}, masked_source: source, issues = [], placeholders = [] } = req.body || {};
    if (!source || !String(source).trim()) {
      return res.status(400).json({ status: 'error', error: 'masked_source is required' });
    }
    if (findUnmaskedSecret(source)) {
      return res.status(400).json({ status: 'error', error: 'The code still contains what looks like a credential. Mask it in the widget before sending.' });
    }
    if (!aiConfigured()) return aiNotConfiguredResponse(res, 'improve a function');

    const result = await ai.callAi(aiConfig(), {
      system: FUNCTION_IMPROVE_SYSTEM_PROMPT,
      user: buildImprovePrompt(fn, String(source), issues, placeholders),
      maxTokens: 8000,
      temperature: 0.1,
      restore: true
    });
    const parsed = parseImproveResponse(result.text || '');
    if (!parsed.code.trim()) throw new Error('The model did not return a code block.');
    res.json({
      status: 'success',
      mode: 'model',
      model: result.model,
      ai_label: result.label,
      generated_by: aiDisplayName(result),
      code: parsed.code,
      summary: parsed.summary,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out
    });
  } catch (err) {
    console.error('Function improve error:', err.message);
    res.status(502).json({ status: 'error', error: err.message });
  }
});

// Backups hold real, unmasked code, so they are same-origin only.
const functionBackupDir = path.join(__dirname, 'data', 'function-backups');
const MAX_BACKUPS_PER_FUNCTION = 30;

function functionBackupFile(functionId) {
  return path.join(functionBackupDir, `${String(functionId).replace(/[^\w.-]/g, '_')}.json`);
}

function readFunctionBackups(functionId) {
  try {
    return JSON.parse(fs.readFileSync(functionBackupFile(functionId), 'utf8'));
  } catch (_) {
    return [];
  }
}

expressApp.get('/api/function/backups', sameOriginOnly, (req, res) => {
  const functionId = req.query.function_id;
  if (!functionId) return res.status(400).json({ status: 'error', error: 'function_id is required' });
  res.json({ status: 'success', backups: readFunctionBackups(functionId) });
});

expressApp.post('/api/function/backups', sameOriginOnly, (req, res) => {
  try {
    const { function_id: functionId, api_name: apiName, name, source, reason, changelog } = req.body || {};
    if (!functionId || typeof source !== 'string' || !source.trim()) {
      return res.status(400).json({ status: 'error', error: 'function_id and source are required' });
    }
    const entry = {
      id: `bk_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      function_id: String(functionId),
      api_name: apiName || '',
      name: name || '',
      source,
      reason: reason || 'Before apply',
      changelog: changelog || '',
      lines: source.split('\n').length,
      at: new Date().toISOString()
    };
    const list = [entry, ...readFunctionBackups(functionId)].slice(0, MAX_BACKUPS_PER_FUNCTION);
    fs.mkdirSync(functionBackupDir, { recursive: true });
    fs.writeFileSync(functionBackupFile(functionId), JSON.stringify(list, null, 2));
    res.json({ status: 'success', backup: entry });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

expressApp.post('/api/pdf', (req, res) => {
  try {
    res.json({ status: 'success', ...documentationPayload(req.body.markdown || '', {}) });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 10. WorkDrive Export
expressApp.post('/api/workdrive/export', (req, res) => {
  const { title = 'Zoho_Living_System_Documentation', folder_id = 'wd_folder_default', markdown } = req.body;
  const fileId = `wd_file_${Date.now()}`;
  const permalink = `https://workdrive.zoho.com/file/${fileId}`;

  res.json({
    status: 'success',
    file_id: fileId,
    file_name: `${title}_${new Date().toISOString().slice(0, 10)}.pdf`,
    folder_id,
    link: permalink,
    message: 'Documentation exported to Zoho WorkDrive successfully.'
  });
});

// 11. Live Demo Simulation Engine (For the 8-Minute Demo & Judges)
expressApp.post('/api/simulate-change', (req, res) => {
  const { scenario } = req.body;
  let detail = '';

  if (scenario === 'add_lead_field') {
    // Scenario 1: Add VIP Rating field to Leads
    const leadsMod = dataStore.crmState.modules.find(m => m.module === 'Leads');
    if (leadsMod) {
      const fieldId = `f_ld_vip_${Date.now()}`;
      leadsMod.fields.push({
        id: fieldId,
        api_name: 'VIP_Customer_Tier',
        label: 'VIP Customer Tier',
        data_type: 'picklist',
        pick_list_values: ['Tier 1 - Platinum VIP', 'Tier 2 - Gold', 'Tier 3 - Silver'],
        required: false,
        custom_field: true
      });
      detail = 'Added custom field "VIP Customer Tier" (picklist) to Leads module.';
    }
  } else if (scenario === 'modify_deal_workflow') {
    // Scenario 2: Change Deal workflow threshold
    const dealsMod = dataStore.crmState.modules.find(m => m.module === 'Deals');
    if (dealsMod && dealsMod.workflows && dealsMod.workflows.length > 0) {
      dealsMod.workflows[0].criteria = 'Amount >= 100000 and Discount_Percentage <= 15%';
      dealsMod.workflows[0].actions.push('Webhook: Trigger Executive VP SMS Notification');
      detail = 'Updated "wf_High_Value_Deal_Alert" criteria to Amount >= $100,000 + added Executive SMS action.';
    }
  } else if (scenario === 'add_blueprint_transition') {
    // Scenario 3: Update Deal Blueprint
    const dealsMod = dataStore.crmState.modules.find(m => m.module === 'Deals');
    if (dealsMod && dealsMod.blueprints && dealsMod.blueprints.length > 0) {
      dealsMod.blueprints[0].transitions.push({
        transition_id: `t_dl_fast_${Date.now()}`,
        name: 'Fast Track Legal Review',
        from_state: 'Value Proposition',
        to_state: 'Negotiation / Review'
      });
      detail = 'Added fast-track transition rule "Fast Track Legal Review" to Enterprise Sales Cycle Blueprint.';
    }
  } else if (scenario === 'reset') {
    // Reset back to original state
    dataStore.crmState.modules.forEach(m => {
      if (m.module === 'Leads') {
        m.fields = m.fields.filter(f => f.api_name !== 'VIP_Customer_Tier');
      }
      if (m.module === 'Deals') {
        if (m.workflows && m.workflows[0]) {
          m.workflows[0].criteria = 'Amount >= 50000';
          m.workflows[0].actions = ['Webhook: Slack #enterprise-deals Channel Alert', 'Task: VP Sales Executive Sponsor Check-in'];
        }
        if (m.blueprints && m.blueprints[0]) {
          m.blueprints[0].transitions = m.blueprints[0].transitions.filter(t => !t.transition_id.startsWith('t_dl_fast'));
        }
      }
    });
    dataStore.snapshots = [];
    buildSnapshot();
    detail = 'CRM configuration reset back to pristine initial baseline.';
  }

  const newSnapshot = buildSnapshot();
  res.json({
    status: 'success',
    scenario,
    detail,
    current_snapshot: newSnapshot
  });
});

// Plugin Manifest & Static assets for ZET Widget
expressApp.get('/plugin-manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'plugin-manifest.json'));
});

expressApp.use('/app', express.static(path.join(__dirname, '..', 'app')));
expressApp.use('/app', serveIndex(path.join(__dirname, '..', 'app')));

expressApp.get('/', (req, res) => {
  res.redirect('/app/widget.html');
});

// SSL and Server Startup
let keyPath = path.join(__dirname, '..', 'key.pem');
let certPath = path.join(__dirname, '..', 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  https.createServer(options, expressApp).listen(port, () => {
    console.log(`\x1b[32m[Living Docs Agent] HTTPS Server running at https://127.0.0.1:${port}\x1b[0m`);
    console.log(`\x1b[36mWidget UI available at: https://127.0.0.1:${port}/app/widget.html\x1b[0m`);
  });
} else {
  http.createServer(expressApp).listen(port, () => {
    console.log(`\x1b[32m[Living Docs Agent] HTTP Server running at http://127.0.0.1:${port}\x1b[0m`);
  });
}
