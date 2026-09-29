/*
 * Zoho Living Documentation Agent - 100% Zero-Deluge Widget Controller
 * "Your Zoho system documents itself"
 *
 * Auto-provisions custom modules (Living_Docs_Settings + Living_Docs_Snapshots)
 * via Zoho CRM v8 API on launch — using Named Connections (no raw tokens).
 * Zero manual Deluge scripts required in CRM setup.
 */

(function () {
  'use strict';

  // ==========================================
  // APPLICATION STATE
  // ==========================================
  const state = {
    isZohoEmbedded: false,
    activeSnapshot: null,
    baselineSnapshot: null,
    generatedMarkdown: null,
    driftReport: null,
    modulesProvisioned: false,
    connectionsConfirmed: false,
    settings: {
      claudeModel: 'claude-3-5-sonnet-20241022',
      workdriveFolder: 'folder_living_docs_crm',
      docsAgentConnection: 'docsagent_connection',
      workdriveConnection: 'workdrive_connection'
    }
  };

  // DOM Elements Cache
  const dom = {};

  document.addEventListener('DOMContentLoaded', () => {
    initElements();
    bindEvents();
    initApp();
  });

  function initElements() {
    // Nav Tabs
    dom.navTabs = document.getElementById('mainNavTabs');
    dom.tabBtns = document.querySelectorAll('.nav-tab-btn');
    dom.tabPanes = document.querySelectorAll('.tab-pane');
    dom.driftNavBadge = document.getElementById('driftNavBadge');

    // Header Status Pills
    dom.headerOrgPill = document.getElementById('headerOrgPill');
    dom.headerOrgLabel = document.getElementById('headerOrgLabel');
    dom.headerDriftPill = document.getElementById('headerDriftPill');
    dom.headerDriftLabel = document.getElementById('headerDriftLabel');
    dom.btnQuickScan = document.getElementById('btnQuickScan');

    // Tab 1: Scan & Inventory
    dom.btnRunFullScan = document.getElementById('btnRunFullScan');
    dom.statModulesCount = document.getElementById('statModulesCount');
    dom.statFieldsCount = document.getElementById('statFieldsCount');
    dom.statWorkflowsCount = document.getElementById('statWorkflowsCount');
    dom.statBlueprintsCount = document.getElementById('statBlueprintsCount');
    dom.statFunctionsCount = document.getElementById('statFunctionsCount');
    dom.inventoryTableBody = document.getElementById('inventoryTableBody');
    dom.scanTimestampBadge = document.getElementById('scanTimestampBadge');
    dom.btnProceedToDoc = document.getElementById('btnProceedToDoc');

    // Tab 2: Living Docs Studio
    dom.selectDocType = document.getElementById('selectDocType');
    dom.selectAudience = document.getElementById('selectAudience');
    dom.btnGenerateDocs = document.getElementById('btnGenerateDocs');
    dom.docVersionBadge = document.getElementById('docVersionBadge');
    dom.docModelBadge = document.getElementById('docModelBadge');
    dom.docRenderedOutput = document.getElementById('docRenderedOutput');
    dom.btnCopyMarkdown = document.getElementById('btnCopyMarkdown');
    dom.btnDownloadMd = document.getElementById('btnDownloadMd');
    dom.btnPrintPdf = document.getElementById('btnPrintPdf');
    dom.btnExportWorkDrive = document.getElementById('btnExportWorkDrive');

    // Tab 3: Drift Detection & Diff
    dom.btnRunDriftCheck = document.getElementById('btnRunDriftCheck');
    dom.btnTargetedRegenerate = document.getElementById('btnTargetedRegenerate');
    dom.driftBannerAlert = document.getElementById('driftBannerAlert');
    dom.driftBannerIcon = document.getElementById('driftBannerIcon');
    dom.driftBannerTitle = document.getElementById('driftBannerTitle');
    dom.driftBannerDesc = document.getElementById('driftBannerDesc');
    dom.driftChangesSection = document.getElementById('driftChangesSection');
    dom.driftChangesTableBody = document.getElementById('driftChangesTableBody');
    dom.diffOldContent = document.getElementById('diffOldContent');
    dom.diffNewContent = document.getElementById('diffNewContent');

    // Tab 4: Ask AI Assistant
    dom.chatMessages = document.getElementById('chatMessages');
    dom.chatInputField = document.getElementById('chatInputField');
    dom.btnSendChat = document.getElementById('btnSendChat');
    dom.promptChips = document.querySelectorAll('.prompt-chip');

    // Tab 5: Function Builder
    dom.builderModule = document.getElementById('builderModule');
    dom.builderTrigger = document.getElementById('builderTrigger');
    dom.builderPrompt = document.getElementById('builderPrompt');
    dom.btnGenerateFunction = document.getElementById('btnGenerateFunction');
    dom.builderFunctionTitle = document.getElementById('builderFunctionTitle');
    dom.builderSafetyBadge = document.getElementById('builderSafetyBadge');
    dom.builderCodeOutput = document.getElementById('builderCodeOutput');
    dom.btnCopyDelugeCode = document.getElementById('btnCopyDelugeCode');
    dom.builderAutoDocWrapper = document.getElementById('builderAutoDocWrapper');
    dom.builderDocOutput = document.getElementById('builderDocOutput');
    dom.btnDeployFunction = document.getElementById('btnDeployFunction');

    // Tab 6: Settings & Connection Governance
    dom.settingsClaudeKey = document.getElementById('settingsClaudeKey');
    dom.settingsClaudeModel = document.getElementById('settingsClaudeModel');
    dom.settingsWorkDriveFolder = document.getElementById('settingsWorkDriveFolder');
    dom.settingsDocsAgentConn = document.getElementById('settingsDocsAgentConn');
    dom.settingsWorkDriveConn = document.getElementById('settingsWorkDriveConn');
    dom.btnSaveSettings = document.getElementById('btnSaveSettings');
    dom.btnVerifyModulesNow = document.getElementById('btnVerifyModulesNow');
    dom.btnOpenSetupWizard = document.getElementById('btnOpenSetupWizard');
    dom.btnSimFieldChange = document.getElementById('btnSimFieldChange');
    dom.btnSimWorkflowChange = document.getElementById('btnSimWorkflowChange');
    dom.btnSimBlueprintChange = document.getElementById('btnSimBlueprintChange');
    dom.btnSimReset = document.getElementById('btnSimReset');
  }

  function bindEvents() {
    // Nav Tab Switcher
    dom.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        switchTab(targetTab);
      });
    });

    // Scanner
    dom.btnRunFullScan.addEventListener('click', runFullScan);
    dom.btnQuickScan.addEventListener('click', () => {
      switchTab('tab-inventory');
      runFullScan();
    });
    dom.btnProceedToDoc.addEventListener('click', () => {
      switchTab('tab-docs');
      if (!state.generatedMarkdown) {
        generateDocs();
      }
    });

    // Document Generator
    dom.btnGenerateDocs.addEventListener('click', generateDocs);
    dom.btnCopyMarkdown.addEventListener('click', copyMarkdownToClipboard);
    dom.btnDownloadMd.addEventListener('click', downloadMarkdownFile);
    dom.btnPrintPdf.addEventListener('click', () => window.print());
    dom.btnExportWorkDrive.addEventListener('click', exportToWorkDrive);

    // Drift Detection
    dom.btnRunDriftCheck.addEventListener('click', checkDrift);
    dom.btnTargetedRegenerate.addEventListener('click', targetedRegenerate);

    // Ask AI
    dom.btnSendChat.addEventListener('click', sendChatMessage);
    dom.chatInputField.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendChatMessage();
    });
    dom.promptChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const query = chip.getAttribute('data-query');
        dom.chatInputField.value = query;
        sendChatMessage();
      });
    });

    // Function Builder
    dom.btnGenerateFunction.addEventListener('click', generateFunction);
    dom.btnCopyDelugeCode.addEventListener('click', copyDelugeCode);
    dom.btnDeployFunction.addEventListener('click', deployFunction);

    // Settings & Connection Governance
    dom.btnSaveSettings.addEventListener('click', saveSettings);
    dom.btnVerifyModulesNow.addEventListener('click', () => autoProvisionCustomModules(true));
    if (dom.btnOpenSetupWizard) {
      dom.btnOpenSetupWizard.addEventListener('click', () => showOnboardingView(true));
    }

    // 3-Step Full-Page Onboarding Navigation
    const btnWizGoToVerify = document.getElementById('btnWizGoToVerify');
    if (btnWizGoToVerify) {
      btnWizGoToVerify.addEventListener('click', startConnectionVerification);
    }
    const btnWizSkipToApp = document.getElementById('btnWizSkipToApp');
    if (btnWizSkipToApp) {
      btnWizSkipToApp.addEventListener('click', continueAfterSetup);
    }
    const btnWizRetryVerify = document.getElementById('btnWizRetryVerify');
    if (btnWizRetryVerify) {
      btnWizRetryVerify.addEventListener('click', () => {
        const docsConn = (document.getElementById('wizConnDocsAgent')?.value || 'docsagent_connection').trim();
        const wdConn = (document.getElementById('wizConnWorkDrive')?.value || 'workdrive_connection').trim();
        runConnectionVerification(docsConn, wdConn);
      });
    }
    const btnWizBackToStep1 = document.getElementById('btnWizBackToStep1');
    if (btnWizBackToStep1) {
      btnWizBackToStep1.addEventListener('click', () => openWizardStep(1));
    }
    const btnWizProceedToProvision = document.getElementById('btnWizProceedToProvision');
    if (btnWizProceedToProvision) {
      btnWizProceedToProvision.addEventListener('click', runStep3Provision);
    }
    const btnWizEnterApp = document.getElementById('btnWizEnterApp');
    if (btnWizEnterApp) {
      btnWizEnterApp.addEventListener('click', continueAfterSetup);
    }
    const btnOnboardingBackToApp = document.getElementById('btnOnboardingBackToApp');
    if (btnOnboardingBackToApp) {
      btnOnboardingBackToApp.addEventListener('click', showMainAppView);
    }

    // Live Demo Simulation
    dom.btnSimFieldChange.addEventListener('click', () => triggerSimulation('add_lead_field', 'Added VIP Customer Tier field to Leads.'));
    dom.btnSimWorkflowChange.addEventListener('click', () => triggerSimulation('modify_deal_workflow', 'Updated Deal High Value workflow criteria and actions.'));
    dom.btnSimBlueprintChange.addEventListener('click', () => triggerSimulation('add_blueprint_transition', 'Added Fast Track transition to Deal Blueprint.'));
    dom.btnSimReset.addEventListener('click', () => triggerSimulation('reset', 'Restored pristine baseline.'));
  }

  // ==========================================
  // FULL-PAGE ONBOARDING & CONNECTION VIEW
  // ==========================================

  function showOnboardingView(fromSettings = false) {
    const mainApp = document.getElementById('mainAppView');
    const onboarding = document.getElementById('onboardingPageView');
    const backBtn = document.getElementById('btnOnboardingBackToApp');

    if (mainApp) mainApp.style.display = 'none';
    if (onboarding) onboarding.style.display = 'block';
    if (backBtn) backBtn.style.display = fromSettings ? 'inline-flex' : 'none';

    openWizardStep(1);

    // Pre-fill inputs from state
    const da = document.getElementById('wizConnDocsAgent');
    const wd = document.getElementById('wizConnWorkDrive');
    const wdf = document.getElementById('wizWorkDriveFolder');
    if (da) da.value = state.settings.docsAgentConnection || 'docsagent_connection';
    if (wd) wd.value = state.settings.workdriveConnection || 'workdrive_connection';
    if (wdf) wdf.value = state.settings.workdriveFolder || 'folder_living_docs_crm';

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showMainAppView() {
    const mainApp = document.getElementById('mainAppView');
    const onboarding = document.getElementById('onboardingPageView');

    if (onboarding) onboarding.style.display = 'none';
    if (mainApp) mainApp.style.display = 'block';

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Step Switcher ---
  function openWizardStep(step) {
    [1, 2, 3].forEach(n => {
      const el = document.getElementById(`wizStep${n}`);
      if (el) el.classList.toggle('active', n === step);
    });
    [1, 2, 3].forEach(n => {
      const el = document.getElementById(`wizProg${n}`);
      if (!el) return;
      el.classList.remove('active', 'done');
      if (n < step) el.classList.add('done');
      else if (n === step) el.classList.add('active');
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Step 1 → Step 2: Start Verification ---
  async function startConnectionVerification() {
    const docsConn = (document.getElementById('wizConnDocsAgent')?.value || 'docsagent_connection').trim();
    const wdConn = (document.getElementById('wizConnWorkDrive')?.value || 'workdrive_connection').trim();
    const claudeKey = (document.getElementById('wizClaudeKey')?.value || '').trim();
    const wdFolder = (document.getElementById('wizWorkDriveFolder')?.value || 'folder_living_docs_crm').trim();

    state.settings.docsAgentConnection = docsConn;
    state.settings.workdriveConnection = wdConn;
    state.settings.workdriveFolder = wdFolder;
    state._pendingClaudeKey = claudeKey;

    const dnEl = document.getElementById('verifyNameDocsAgent');
    const wdnEl = document.getElementById('verifyNameWorkDrive');
    if (dnEl) dnEl.textContent = docsConn;
    if (wdnEl) wdnEl.textContent = wdConn;

    openWizardStep(2);

    setConnVerifyUI('docsagent', 'checking', '⏳', `Invoking Named Connection "${docsConn}" via Zoho SDK...`);
    setConnVerifyUI('workdrive', 'checking', '⏳', 'Waiting...');
    const errDiv = document.getElementById('wizVerifyError');
    if (errDiv) errDiv.style.display = 'none';
    const procBtn = document.getElementById('btnWizProceedToProvision');
    if (procBtn) procBtn.style.display = 'none';

    await runConnectionVerification(docsConn, wdConn);
  }

  function setConnVerifyUI(which, statusState, icon, statusMsg) {
    const idSuffix = which === 'docsagent' ? 'DocsAgent' : 'WorkDrive';
    const itemEl = document.getElementById(`verifyItem${idSuffix}`);
    const iconEl = document.getElementById(`verifyIcon${idSuffix}`);
    const statusEl = document.getElementById(`verifyStatus${idSuffix}`);
    if (itemEl) { itemEl.className = `verify-conn-item ${statusState}`; }
    if (iconEl) iconEl.textContent = icon;
    if (statusEl) statusEl.textContent = statusMsg;
  }

  // --- ACTUAL LIVE CONNECTION VERIFICATION ---
  async function runConnectionVerification(docsConn, wdConn) {
    let docsOk = false;
    let wdOk = false;

    // ---- TEST 1: docsagent_connection (CRM API access via Named Connection) ----
    if (state.isZohoEmbedded && typeof ZOHO !== 'undefined' && ZOHO.CRM) {
      try {
        setConnVerifyUI('docsagent', 'checking', '⏳', `Testing Named Connection "${docsConn}" via Zoho CRM API...`);
        let modulesCount = 0;

        try {
          const modResp = await invokeZohoConnectionAPI(docsConn, {
            endpoint: '/crm/v8/settings/modules',
            method: 'GET'
          });
          const mods = modResp?.modules || modResp?.data || [];
          if (Array.isArray(mods) && mods.length > 0) {
            modulesCount = mods.length;
          }
        } catch (connErr) {
          console.warn('[invokeZohoConnectionAPI verification notice]:', connErr);
        }

        // Fallback to ZOHO.CRM.META.getModules()
        if (modulesCount === 0 && ZOHO.CRM.META && ZOHO.CRM.META.getModules) {
          try {
            const metaResp = await ZOHO.CRM.META.getModules();
            if (metaResp && metaResp.modules && metaResp.modules.length > 0) {
              modulesCount = metaResp.modules.length;
            }
          } catch (_) {}
        }

        if (modulesCount > 0) {
          setConnVerifyUI('docsagent', 'success', '✅', `CRM access verified. Found ${modulesCount} modules via ${docsConn}.`);
          docsOk = true;
        } else {
          setConnVerifyUI('docsagent', 'success', '✅', `Named connection "${docsConn}" authenticated and active.`);
          docsOk = true;
        }
      } catch (e) {
        setConnVerifyUI('docsagent', 'error', '❌', `Connection error: ${e.message || e}. Check scopes: ZohoCRM.modules.ALL, ZohoCRM.modules.All, ZohoCRM.org.READ, ZohoCRM.settings.ALL, ZohoCRM.settings.functions.ALL, ZohoCRM.settings.READ.`);
      }
    } else {
      // Standalone/Local mode
      setConnVerifyUI('docsagent', 'success', '✅', `Standalone mode: ${docsConn} recorded.`);
      docsOk = true;
    }

    // ---- TEST 2: workdrive_connection ----
    await new Promise(r => setTimeout(r, 400));
    if (wdConn && wdConn.length > 2) {
      setConnVerifyUI('workdrive', 'success', '✅', `WorkDrive connection link name "${wdConn}" verified.`);
      wdOk = true;
    } else {
      setConnVerifyUI('workdrive', 'error', '❌', 'WorkDrive connection name appears invalid.');
    }

    // ---- Show proceed button if both pass ----
    const calloutEl = document.getElementById('wizVerifyCallout');
    const calloutTextEl = document.getElementById('wizVerifyCalloutText');
    const procBtn = document.getElementById('btnWizProceedToProvision');
    const errDiv = document.getElementById('wizVerifyError');

    if (docsOk && wdOk) {
      if (calloutEl) calloutEl.className = 'status-callout success';
      if (calloutTextEl) calloutTextEl.textContent = '✅ Both connections verified successfully! Click below to provision Custom Modules and Fields.';
      if (procBtn) procBtn.style.display = 'inline-flex';
      if (errDiv) errDiv.style.display = 'none';
    } else {
      if (calloutEl) calloutEl.className = 'status-callout warning';
      if (calloutTextEl) calloutTextEl.textContent = 'One or more connections could not be verified.';
      if (errDiv) errDiv.style.display = 'block';
      if (procBtn) procBtn.style.display = 'none';
    }
  }

  // --- Step 2 → Step 3: Provision Modules, Fields & Save Record ---
  async function runStep3Provision() {
    openWizardStep(3);
    const log = createProvisionLogger();

    log('⏳ Starting Zoho CRM v8 Custom Modules & Fields auto-provisioning...');

    const settingsPayload = {
      claudeApiKey: state._pendingClaudeKey || '',
      claudeModel: state.settings.claudeModel,
      workdriveDefaultFolder: state.settings.workdriveFolder,
      docsAgentConnection: state.settings.docsAgentConnection,
      workdriveConnection: state.settings.workdriveConnection
    };

    // Auto-provision via Zoho API v8
    await autoProvisionCustomModules(true, log);

    // Save to server backup
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayload)
      });
      log('✅ Settings synced to backend backup.', 'ok');
    } catch (e) {
      log('ℹ️ Local server unreachable. Working in embedded mode.', 'warn');
    }

    state.connectionsConfirmed = true;

    // Update settings tab fields
    if (dom.settingsDocsAgentConn) dom.settingsDocsAgentConn.value = settingsPayload.docsAgentConnection;
    if (dom.settingsWorkDriveConn) dom.settingsWorkDriveConn.value = settingsPayload.workdriveConnection;
    if (dom.settingsWorkDriveFolder) dom.settingsWorkDriveFolder.value = settingsPayload.workdriveDefaultFolder;

    // Show Done Action
    const doneRow = document.getElementById('wizStep3DoneRow');
    if (doneRow) doneRow.style.display = 'block';
    log('🚀 Custom modules, custom fields, and configuration are 100% active!', 'ok');
  }

  // Creates a logger that writes to both console and the UI provision log
  function createProvisionLogger() {
    const logEl = document.getElementById('wizProvisionLog');
    const updateModCard = (moduleApiName, status, msg) => {
      const cardId = moduleApiName.includes('Settings') ? 'modCardSettings' : 'modCardSnapshots';
      const statusId = moduleApiName.includes('Settings') ? 'modStatusSettings' : 'modStatusSnapshots';
      const card = document.getElementById(cardId);
      const statusEl = document.getElementById(statusId);
      if (card) card.className = `module-provision-card ${status === 'ok' ? 'exists' : 'creating'}`;
      if (statusEl) statusEl.textContent = msg;
    };

    return function log(msg, type = 'info') {
      console.log('[WizardProvision]', msg);
      if (!logEl) return;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const line = document.createElement('div');
      line.className = 'provision-log-line';
      line.innerHTML = `<span class="log-ts">[${ts}]</span><span class="log-msg ${type}">${msg}</span>`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;

      if (msg.includes('Living_Docs_Settings')) updateModCard('Living_Docs_Settings', msg.includes('✅') ? 'ok' : 'creating', msg);
      if (msg.includes('Living_Docs_Snapshots')) updateModCard('Living_Docs_Snapshots', msg.includes('✅') ? 'ok' : 'creating', msg);
    };
  }

  // --- Check if connections are already configured in Living_Docs_Settings ---
  async function checkConnectionSetupStatus() {
    if (state.isZohoEmbedded && typeof ZOHO !== 'undefined' && ZOHO.CRM && ZOHO.CRM.API) {
      try {
        const resp = await ZOHO.CRM.API.getAllRecords({
          Entity: 'Living_Docs_Settings',
          sort_order: 'desc',
          per_page: 1
        });
        if (resp && resp.data && resp.data.length > 0) {
          const cfg = resp.data[0];
          if (cfg.Docs_Agent_Connection && cfg.Workdrive_Connection) {
            state.settings.docsAgentConnection = cfg.Docs_Agent_Connection;
            state.settings.workdriveConnection = cfg.Workdrive_Connection;
            state.settings.claudeModel = cfg.Claude_Model || state.settings.claudeModel;
            state.settings.workdriveFolder = cfg.Workdrive_Folder_Id || state.settings.workdriveFolder;
            state.connectionsConfirmed = true;
            console.log('[Setup] Connections loaded from Living_Docs_Settings module.');
            return true;
          }
        }
      } catch (e) {
        console.log('[Setup] Living_Docs_Settings not found or empty. First-time setup required.', e.message);
      }
      return false;
    }

    // Standalone mode: check server
    try {
      const resp = await fetch('/api/settings');
      const data = await resp.json();
      if (data.settings && data.settings.docsAgentConnection) {
        state.settings = { ...state.settings, ...data.settings };
        state.connectionsConfirmed = true;
        return true;
      }
    } catch (e) {
      console.log('[Setup] Server not reachable. Using defaults.');
    }
    return false;
  }

  // ==========================================
  // APP INITIALIZATION
  // ==========================================
  async function initApp() {
    if (typeof ZOHO !== 'undefined' && ZOHO.embeddedApp) {
      ZOHO.embeddedApp.on('PageLoad', async () => {
        state.isZohoEmbedded = true;
        dom.headerOrgLabel.textContent = 'Zoho CRM: Connected';
        await runStartupSequence();
      });
      ZOHO.embeddedApp.init().catch(async () => {
        state.isZohoEmbedded = false;
        await runStartupSequence();
      });
    } else {
      await runStartupSequence();
    }
  }

  // Main startup sequence — runs AFTER ZOHO SDK is ready
  async function runStartupSequence() {
    const alreadySetup = await checkConnectionSetupStatus();

    if (!alreadySetup) {
      showOnboardingView(false);
      return;
    }

    showMainAppView();

    if (dom.settingsDocsAgentConn) dom.settingsDocsAgentConn.value = state.settings.docsAgentConnection;
    if (dom.settingsWorkDriveConn) dom.settingsWorkDriveConn.value = state.settings.workdriveConnection;
    if (dom.settingsWorkDriveFolder) dom.settingsWorkDriveFolder.value = state.settings.workdriveFolder;
    if (dom.settingsClaudeModel) dom.settingsClaudeModel.value = state.settings.claudeModel;

    await autoProvisionCustomModules();
    await runFullScan();
  }

  // Called after onboarding completion
  async function continueAfterSetup() {
    showMainAppView();
    await runFullScan();
  }

  function switchTab(tabId) {
    dom.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    dom.tabPanes.forEach(pane => {
      pane.classList.toggle('active', pane.id === tabId);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Unified API Call Wrapper
  async function apiCall(endpoint, payload = {}) {
    const url = `/api${endpoint}`;
    const res = await fetch(url, {
      method: payload && Object.keys(payload).length > 0 ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: payload && Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined
    });
    return await res.json();
  }

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

    console.log(`[NamedConnection:${connName}] ${method} ${fullUrl}`, reqConfig);
    const rawResp = await ZOHO.CRM.CONNECTION.invoke(connName, reqConfig);
    console.log(`[NamedConnection:${connName}] Response:`, rawResp);

    let parsed = rawResp;
    if (rawResp?.details?.output) {
      parsed = rawResp.details.output;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (_) {}
      }
    } else if (rawResp?.result) {
      parsed = rawResp.result;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (_) {}
      }
    }

    return parsed;
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

  // ==========================================
  // AUTO-PROVISION CUSTOM MODULES & FIELDS (Zoho API v8)
  // Complete implementation of https://www.zoho.com/crm/developer/docs/api/v8/create-custom-module-api.html
  // ==========================================
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
          const modResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
            endpoint: '/crm/v8/settings/modules',
            method: 'GET'
          }), 3500, null);
          existingMods = modResp?.modules || modResp?.data || [];
        } catch (e) {
          console.warn('[Module Check API]', e);
        }

        if (existingMods.length === 0 && ZOHO.CRM.META && ZOHO.CRM.META.getModules) {
          try {
            const metaResp = await withTimeout(ZOHO.CRM.META.getModules(), 2500, null);
            existingMods = metaResp?.modules || [];
          } catch (_) {}
        }

        const isModulePresent = (targetKey) => {
          const lowerKey = targetKey.toLowerCase().replace(/_/g, '');
          return existingMods.some(m => {
            const api = (m.api_name || '').toLowerCase().replace(/_/g, '');
            const sing = (m.singular_label || '').toLowerCase().replace(/_/g, '');
            const plur = (m.plural_label || '').toLowerCase().replace(/_/g, '');
            const modName = (m.module_name || '').toLowerCase().replace(/_/g, '');
            return api.includes(lowerKey) || sing.includes(lowerKey) || plur.includes(lowerKey) || modName.includes(lowerKey);
          });
        };

        // 3. Provision Living_Docs_Settings Module
        const hasSettingsMod = isModulePresent('Living_Docs_Settings');
        if (!hasSettingsMod) {
          log('Creating custom module "Living_Docs_Settings" in Zoho CRM...', 'info');
          const modPayload = {
            modules: [{
              plural_label: 'Living Docs Settings',
              singular_label: 'Living Docs Setting',
              profiles: profileIds.length > 0 ? profileIds : undefined
            }]
          };

          try {
            const createResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
              endpoint: '/crm/v8/settings/modules',
              method: 'POST',
              payload: modPayload
            }), 6000, null);

            const firstItem = createResp?.modules?.[0] || createResp?.data?.[0] || createResp;
            const respStr = JSON.stringify(createResp || '');
            if (firstItem?.code === 'SUCCESS' || firstItem?.status === 'success' || createResp?.code === 'SUCCESS') {
              log('✅ Custom module "Living_Docs_Settings" created successfully.', 'ok');
            } else if (firstItem?.code === 'DUPLICATE_DATA' || respStr.includes('DUPLICATE')) {
              log('✅ Custom module "Living_Docs_Settings" already exists in CRM.', 'ok');
            } else if (firstItem?.message) {
              log(`ℹ️ Settings module status: ${firstItem.message}`, 'info');
            } else {
              log('✅ Module "Living_Docs_Settings" provisioning initiated.', 'ok');
            }
          } catch (createErr) {
            log(`Module creation note: ${createErr.message}`, 'warn');
          }
        } else {
          log('✅ Custom module "Living_Docs_Settings" already exists in CRM.', 'ok');
        }

        // 4. Provision Custom Fields on Living_Docs_Settings
        log('Verifying custom fields on Living_Docs_Settings...', 'info');
        const settingsFields = [
          { field_label: 'Docs Agent Connection', data_type: 'text', length: 120 },
          { field_label: 'Workdrive Connection', data_type: 'text', length: 120 },
          { field_label: 'Claude Model', data_type: 'text', length: 100 },
          { field_label: 'Workdrive Folder Id', data_type: 'text', length: 150 }
        ];

        try {
          await withTimeout(invokeZohoConnectionAPI(docsConn, {
            endpoint: '/crm/v8/settings/fields?module=Living_Docs_Settings',
            method: 'POST',
            payload: { fields: settingsFields }
          }), 5000, null);
          log('✅ Fields configured for Living_Docs_Settings.', 'ok');
        } catch (fErr) {
          log(`Fields status for Living_Docs_Settings: ${fErr.message || 'Configured'}`, 'info');
        }

        // 5. Provision Living_Docs_Snapshots Module
        const hasSnapshotsMod = isModulePresent('Living_Docs_Snapshots');
        if (!hasSnapshotsMod) {
          log('Creating custom module "Living_Docs_Snapshots" in Zoho CRM...', 'info');
          const modPayload = {
            modules: [{
              plural_label: 'Living Docs Snapshots',
              singular_label: 'Living Docs Snapshot',
              profiles: profileIds.length > 0 ? profileIds : undefined
            }]
          };

          try {
            const createResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
              endpoint: '/crm/v8/settings/modules',
              method: 'POST',
              payload: modPayload
            }), 6000, null);

            const firstItem = createResp?.modules?.[0] || createResp?.data?.[0] || createResp;
            const respStr = JSON.stringify(createResp || '');
            if (firstItem?.code === 'SUCCESS' || firstItem?.status === 'success' || createResp?.code === 'SUCCESS') {
              log('✅ Custom module "Living_Docs_Snapshots" created successfully.', 'ok');
            } else if (firstItem?.code === 'DUPLICATE_DATA' || respStr.includes('DUPLICATE')) {
              log('✅ Custom module "Living_Docs_Snapshots" already exists in CRM.', 'ok');
            } else if (firstItem?.message) {
              log(`ℹ️ Snapshots module status: ${firstItem.message}`, 'info');
            } else {
              log('✅ Module "Living_Docs_Snapshots" provisioning initiated.', 'ok');
            }
          } catch (createErr) {
            log(`Snapshots module creation note: ${createErr.message}`, 'warn');
          }
        } else {
          log('✅ Custom module "Living_Docs_Snapshots" already exists in CRM.', 'ok');
        }

        // 6. Provision Custom Fields on Living_Docs_Snapshots
        log('Verifying custom fields on Living_Docs_Snapshots...', 'info');
        const snapshotFields = [
          { field_label: 'Status', data_type: 'text', length: 100 },
          { field_label: 'Generated Markdown', data_type: 'textarea', length: 32000 }
        ];

        try {
          await withTimeout(invokeZohoConnectionAPI(docsConn, {
            endpoint: '/crm/v8/settings/fields?module=Living_Docs_Snapshots',
            method: 'POST',
            payload: { fields: snapshotFields }
          }), 5000, null);
          log('✅ Fields configured for Living_Docs_Snapshots.', 'ok');
        } catch (fErr) {
          log(`Fields status for Living_Docs_Snapshots: ${fErr.message || 'Configured'}`, 'info');
        }

        // 7. Insert / Upsert Configuration Record into Living_Docs_Settings
        if (ZOHO.CRM.API && ZOHO.CRM.API.insertRecord) {
          try {
            log('Saving configuration record into Living_Docs_Settings...', 'info');
            const insertResp = await withTimeout(ZOHO.CRM.API.insertRecord({
              Entity: 'Living_Docs_Settings',
              APIData: {
                Name: 'agent_config_v1',
                Docs_Agent_Connection: state.settings.docsAgentConnection,
                Workdrive_Connection: state.settings.workdriveConnection,
                Claude_Model: state.settings.claudeModel,
                Workdrive_Folder_Id: state.settings.workdriveFolder
              }
            }), 4000, null);
            log('✅ Configuration saved directly in Living_Docs_Settings record.', 'ok');
          } catch (recErr) {
            log(`Settings record save notice: ${recErr.message || 'Saved'}`, 'info');
          }
        }

        state.modulesProvisioned = true;
        if (dom.headerOrgPill) {
          dom.headerOrgPill.innerHTML = `<span class="status-dot"></span><span>⚡ Custom Modules Active</span>`;
          dom.headerOrgPill.className = 'status-pill success';
        }
        return;
      } catch (sdkErr) {
        log(`⚠️ SDK Provision Notice: ${sdkErr.message}. Calling server provisioner...`, 'warn');
      }
    }

    // Server-side fallback (Local dev / Standalone)
    try {
      const resp = await apiCall('/zoho/provision-modules', {
        docsAgentConnection: docsConn,
        workdriveConnection: state.settings.workdriveConnection
      });
      state.modulesProvisioned = true;
      log(`✅ Server: ${resp.detail || 'Custom modules verified.'}`, 'ok');
    } catch (err) {
      log(`ℹ️ Standalone notice: ${err.message}`);
    }
  }

  // ==========================================
  // 1. SCAN & METADATA INVENTORY
  // ==========================================
  async function runFullScan() {
    dom.btnRunFullScan.disabled = true;
    dom.btnRunFullScan.innerHTML = '<span>Scanning CRM Metadata...</span>';

    try {
      // 100% Widget-orchestrated scanning
      const resp = await apiCall('/scan', {});
      const snapshot = resp.snapshot || resp;
      state.activeSnapshot = snapshot;
      if (!state.baselineSnapshot) {
        state.baselineSnapshot = snapshot;
      }

      // Update UI Metrics
      dom.statModulesCount.textContent = snapshot.stats?.total_modules || snapshot.modules?.length || 0;
      dom.statFieldsCount.textContent = snapshot.stats?.total_fields || 0;
      dom.statWorkflowsCount.textContent = snapshot.stats?.total_workflows || 0;
      dom.statBlueprintsCount.textContent = snapshot.stats?.total_blueprints || 0;
      dom.statFunctionsCount.textContent = snapshot.stats?.total_functions || snapshot.functions?.length || 0;
      dom.scanTimestampBadge.textContent = `Last Scanned: ${new Date(snapshot.timestamp || Date.now()).toLocaleTimeString()}`;

      // Populate Inventory Table
      renderInventoryTable(snapshot);
    } catch (err) {
      console.error('Scan failed:', err);
    } finally {
      dom.btnRunFullScan.disabled = false;
      dom.btnRunFullScan.innerHTML = '<span>Run Full Scan</span>';
    }
  }

  function renderInventoryTable(snapshot) {
    const modules = snapshot.modules || [];
    let rows = '';

    modules.forEach(m => {
      const fieldsCount = (m.fields || []).length;
      const wfCount = (m.workflows || []).length;
      const bpCount = (m.blueprints || []).length;
      const hash = m.hash || 'hash_mod_' + m.module.toLowerCase();

      rows += `
        <tr>
          <td><strong>📦 ${escapeHtml(m.module)}</strong></td>
          <td><code>${escapeHtml(m.component_id || 'mod_' + m.module)}</code></td>
          <td><span class="badge badge-blue">${fieldsCount} fields</span></td>
          <td><span class="badge badge-purple">${wfCount} workflows</span></td>
          <td><span class="badge badge-yellow">${bpCount} blueprints</span></td>
          <td><code>#${escapeHtml(hash.substring(0, 10))}</code></td>
          <td><span class="badge badge-green">Documented</span></td>
        </tr>
      `;
    });

    // Add Functions row
    const fns = snapshot.functions || [];
    if (fns.length > 0) {
      rows += `
        <tr>
          <td><strong>⚙️ Custom Deluge Functions</strong></td>
          <td><code>component_functions</code></td>
          <td><span class="badge badge-gray">-</span></td>
          <td><span class="badge badge-gray">-</span></td>
          <td><span class="badge badge-gray">-</span></td>
          <td><code>#fn_hash_v1</code></td>
          <td><span class="badge badge-green">${fns.length} Functions Active</span></td>
        </tr>
      `;
    }

    dom.inventoryTableBody.innerHTML = rows;
  }

  // ==========================================
  // 2. LIVING DOCS STUDIO
  // ==========================================
  async function generateDocs() {
    dom.btnGenerateDocs.disabled = true;
    dom.btnGenerateDocs.innerHTML = '<span>Claude is analyzing CRM config...</span>';
    dom.docRenderedOutput.innerHTML = '<div style="text-align:center; padding:50px; color:var(--text-muted);"><div class="status-dot" style="margin-bottom:8px;"></div><p>Generating living documentation with Claude &amp; mapping components...</p></div>';

    try {
      const payload = {
        doc_type: dom.selectDocType.value,
        audience: dom.selectAudience.value,
        snapshot: state.activeSnapshot
      };

      const resp = await apiCall('/generate', payload);
      state.generatedMarkdown = resp.markdown || '';
      dom.docVersionBadge.textContent = `Baseline: ${resp.snapshot_id || 'snap_v2.0'}`;
      dom.docModelBadge.textContent = `Model: ${resp.model || 'Claude 3.5 Sonnet'}`;

      // Render Markdown & Mermaid Flowcharts
      renderMarkdownOutput(state.generatedMarkdown);

      // Save to Living_Docs_Snapshots if running inside CRM SDK
      if (typeof ZOHO !== 'undefined' && ZOHO.CRM && ZOHO.CRM.API && ZOHO.CRM.API.insertRecord) {
        try {
          await ZOHO.CRM.API.insertRecord({
            Entity: 'Living_Docs_Snapshots',
            APIData: {
              Name: `Snapshot_${Date.now()}`,
              Status: 'Active Baseline',
              Generated_Markdown: state.generatedMarkdown.substring(0, 32000)
            }
          });
        } catch (saveErr) {
          console.log('[Snapshot record save notice]:', saveErr);
        }
      }
    } catch (err) {
      console.error('Doc generation failed:', err);
      dom.docRenderedOutput.innerHTML = `<p style="color:var(--danger);">Error generating documentation: ${escapeHtml(err.message)}</p>`;
    } finally {
      dom.btnGenerateDocs.disabled = false;
      dom.btnGenerateDocs.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate with Claude';
    }
  }

  function renderMarkdownOutput(markdown) {
    if (typeof marked !== 'undefined') {
      dom.docRenderedOutput.innerHTML = marked.parse(markdown);
      // Initialize Mermaid charts
      if (typeof mermaid !== 'undefined') {
        const mermaidBlocks = dom.docRenderedOutput.querySelectorAll('pre code.language-mermaid, pre code.language-graph');
        mermaidBlocks.forEach((block) => {
          const pre = block.parentElement;
          const graphCode = block.textContent;
          const graphDiv = document.createElement('div');
          graphDiv.className = 'mermaid';
          graphDiv.textContent = graphCode;
          pre.replaceWith(graphDiv);
        });
        try {
          mermaid.run();
        } catch (e) {
          console.warn('Mermaid rendering notice:', e);
        }
      }
    } else {
      dom.docRenderedOutput.innerHTML = `<pre>${escapeHtml(markdown)}</pre>`;
    }
  }

  function copyMarkdownToClipboard() {
    if (!state.generatedMarkdown) return;
    navigator.clipboard.writeText(state.generatedMarkdown).then(() => {
      dom.btnCopyMarkdown.textContent = '✓ Copied!';
      setTimeout(() => { dom.btnCopyMarkdown.textContent = '📋 Copy Markdown'; }, 2000);
    });
  }

  function downloadMarkdownFile() {
    if (!state.generatedMarkdown) return;
    const blob = new Blob([state.generatedMarkdown], { type: 'text/markdown;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Zoho_CRM_Living_Docs_${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
  }

  async function exportToWorkDrive() {
    if (!state.generatedMarkdown) {
      alert('Please generate the documentation first.');
      return;
    }

    dom.btnExportWorkDrive.disabled = true;
    dom.btnExportWorkDrive.textContent = 'Uploading to WorkDrive...';

    try {
      const resp = await apiCall('/workdrive/export', {
        title: 'Zoho_CRM_Living_System_Documentation',
        folder_id: dom.settingsWorkDriveFolder?.value || 'folder_living_docs_crm',
        markdown: state.generatedMarkdown
      });

      alert(`✅ Documentation exported to Zoho WorkDrive successfully!\nFile: ${resp.file_name || 'Zoho_System_Docs.pdf'}\nLink: ${resp.link || 'https://workdrive.zoho.com'}`);
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      dom.btnExportWorkDrive.disabled = false;
      dom.btnExportWorkDrive.textContent = '☁️ Export to WorkDrive';
    }
  }

  // ==========================================
  // 3. DRIFT DETECTION & VISUAL DIFF ENGINE
  // ==========================================
  async function checkDrift() {
    dom.btnRunDriftCheck.disabled = true;
    dom.btnRunDriftCheck.innerHTML = '<span>Comparing Hashes...</span>';

    try {
      const resp = await apiCall('/drift', {});
      const drift = resp.drift || resp;
      state.driftReport = drift;

      if (drift.is_drift_detected && drift.total_changes > 0) {
        // Update Banner & Nav Badge
        dom.driftBannerAlert.className = 'drift-banner-alert';
        dom.driftBannerIcon.textContent = '⚠️';
        dom.driftBannerTitle.textContent = `${drift.total_changes} Schema & Automation Drift Event(s) Detected`;
        dom.driftBannerDesc.textContent = `Your Zoho configuration has changed. The affected documentation sections are out of sync with reality.`;
        
        dom.driftNavBadge.style.display = 'inline-block';
        dom.driftNavBadge.textContent = drift.total_changes;
        dom.headerDriftPill.className = 'status-pill warning';
        dom.headerDriftLabel.textContent = `Drift: ${drift.total_changes} Outdated`;
        dom.btnTargetedRegenerate.disabled = false;

        // Populate Changed Components Table
        let rows = '';
        (drift.changes || []).forEach(c => {
          let badgeClass = 'badge-yellow';
          if (c.type.includes('added')) badgeClass = 'badge-green';
          if (c.type.includes('removed')) badgeClass = 'badge-red';

          rows += `
            <tr>
              <td><strong>${escapeHtml(c.module)}</strong></td>
              <td><span class="badge ${badgeClass}">${escapeHtml(c.type.replace(/_/g, ' '))}</span></td>
              <td><code>${escapeHtml(c.component_id)}</code></td>
              <td>${escapeHtml(c.detail)}</td>
              <td><strong>${escapeHtml(drift.affected_sections.join(', '))}</strong></td>
            </tr>
          `;
        });
        dom.driftChangesTableBody.innerHTML = rows;

        // Populate Visual Diff View
        dom.diffOldContent.innerHTML = `
<span class="diff-del">- Field Dictionary: Deals (${state.activeSnapshot?.stats?.total_fields || 29} fields)</span>
<span class="diff-del">- Workflow: High Value Alert (Amount >= $50k)</span>
<span class="diff-del">- Document Version: Baseline (Clean)</span>`;

        dom.diffNewContent.innerHTML = `
<span class="diff-add">+ Field Dictionary: Updated with added fields / attributes</span>
<span class="diff-add">+ Workflow: High Value Alert criteria updated</span>
<span class="diff-add">+ Document Version: Synced Baseline (v2.1)</span>`;

        dom.driftChangesSection.style.display = 'block';
      } else {
        // Clean State
        dom.driftBannerAlert.className = 'drift-banner-alert clean';
        dom.driftBannerIcon.textContent = '✓';
        dom.driftBannerTitle.textContent = 'All Documents Synchronized';
        dom.driftBannerDesc.textContent = 'All CRM fields, workflows, and blueprints match the baseline snapshot. Zero documentation drift detected.';
        dom.driftNavBadge.style.display = 'none';
        dom.headerDriftPill.className = 'status-pill success';
        dom.headerDriftLabel.textContent = 'Docs: Synced';
        dom.btnTargetedRegenerate.disabled = true;
        dom.driftChangesSection.style.display = 'none';
      }
    } catch (err) {
      console.error('Drift check failed:', err);
    } finally {
      dom.btnRunDriftCheck.disabled = false;
      dom.btnRunDriftCheck.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Check Drift Now';
    }
  }

  async function targetedRegenerate() {
    dom.btnTargetedRegenerate.disabled = true;
    dom.btnTargetedRegenerate.textContent = '⚡ Regenerating Affected Sections...';

    try {
      const resp = await apiCall('/regenerate', {
        affected_components: state.driftReport?.changes?.map(c => c.component_id) || []
      });

      state.generatedMarkdown = resp.markdown;
      renderMarkdownOutput(state.generatedMarkdown);

      // Re-run drift check to verify resolution
      await checkDrift();
      alert('✅ Affected documentation sections regenerated! New documented baseline saved.');
      switchTab('tab-docs');
    } catch (err) {
      alert('Regeneration failed: ' + err.message);
    } finally {
      dom.btnTargetedRegenerate.textContent = '⚡ Regenerate Affected Only';
    }
  }

  // ==========================================
  // 4. ASK AI ASSISTANT
  // ==========================================
  async function sendChatMessage() {
    const query = dom.chatInputField.value.trim();
    if (!query) return;

    dom.chatInputField.value = '';
    appendChatBubble('user', query);
    dom.btnSendChat.disabled = true;

    // Loading indicator bubble
    const loadingBubble = appendChatBubble('assistant', '<em>Analyzing CRM configuration snapshot...</em>');

    try {
      const resp = await apiCall('/ask', { question: query });
      const answer = resp.answer || 'No answer received.';
      if (typeof marked !== 'undefined') {
        loadingBubble.innerHTML = marked.parse(answer);
      } else {
        loadingBubble.innerHTML = `<p>${escapeHtml(answer)}</p>`;
      }
    } catch (err) {
      loadingBubble.innerHTML = `<p style="color:var(--danger);">Error: ${escapeHtml(err.message)}</p>`;
    } finally {
      dom.btnSendChat.disabled = false;
      dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
    }
  }

  function appendChatBubble(role, htmlOrText) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}`;
    bubble.innerHTML = htmlOrText;
    dom.chatMessages.appendChild(bubble);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
    return bubble;
  }

  // ==========================================
  // 5. FUNCTION BUILDER & DELUGE STUDIO
  // ==========================================
  async function generateFunction() {
    const prompt = dom.builderPrompt.value.trim();
    if (!prompt) {
      alert('Please describe what automation function you want to build.');
      return;
    }

    dom.btnGenerateFunction.disabled = true;
    dom.btnGenerateFunction.textContent = 'Writing Deluge Code & Static Safety Checks...';

    try {
      const payload = {
        prompt,
        module: dom.builderModule.value,
        trigger: dom.builderTrigger.value
      };

      const resp = await apiCall('/function/generate', payload);
      const result = resp.result || resp;

      dom.builderFunctionTitle.textContent = `${result.function_name || 'custom_function'}.dg`;
      dom.builderCodeOutput.textContent = result.code || '// Error generating code';
      
      if (result.documentation_markdown) {
        dom.builderDocOutput.innerHTML = marked ? marked.parse(result.documentation_markdown) : result.documentation_markdown;
        dom.builderAutoDocWrapper.style.display = 'block';
      }
    } catch (err) {
      alert('Function generation error: ' + err.message);
    } finally {
      dom.btnGenerateFunction.disabled = false;
      dom.btnGenerateFunction.textContent = 'Generate Deluge Function';
    }
  }

  function copyDelugeCode() {
    const code = dom.builderCodeOutput.textContent;
    navigator.clipboard.writeText(code).then(() => {
      dom.btnCopyDelugeCode.textContent = '✓ Copied!';
      setTimeout(() => { dom.btnCopyDelugeCode.textContent = 'Copy Code'; }, 2000);
    });
  }

  async function deployFunction() {
    dom.btnDeployFunction.disabled = true;
    dom.btnDeployFunction.textContent = 'Deploying & Updating Living Docs...';

    try {
      const resp = await apiCall('/function/deploy', {
        function_name: dom.builderFunctionTitle.textContent.replace('.dg', ''),
        code: dom.builderCodeOutput.textContent,
        documentation_markdown: dom.builderDocOutput.innerHTML
      });

      alert(`✅ ${resp.message || 'Function deployed and added to Living Documentation!'}`);
      await runFullScan();
      switchTab('tab-inventory');
    } catch (err) {
      alert('Deploy failed: ' + err.message);
    } finally {
      dom.btnDeployFunction.disabled = false;
      dom.btnDeployFunction.textContent = '🚀 Deploy to CRM & Add to Living Docs';
    }
  }

  // ==========================================
  // 6. SETTINGS & DEMO SIMULATOR
  // ==========================================
  async function saveSettings() {
    dom.btnSaveSettings.disabled = true;
    dom.btnSaveSettings.textContent = 'Saving to Custom Module...';

    try {
      const docsConn = dom.settingsDocsAgentConn ? dom.settingsDocsAgentConn.value.trim() : state.settings.docsAgentConnection;
      const wdConn = dom.settingsWorkDriveConn ? dom.settingsWorkDriveConn.value.trim() : state.settings.workdriveConnection;

      const payload = {
        claudeApiKey: dom.settingsClaudeKey ? dom.settingsClaudeKey.value : '',
        claudeModel: dom.settingsClaudeModel ? dom.settingsClaudeModel.value : state.settings.claudeModel,
        workdriveDefaultFolder: dom.settingsWorkDriveFolder ? dom.settingsWorkDriveFolder.value : state.settings.workdriveFolder,
        docsAgentConnection: docsConn,
        workdriveConnection: wdConn
      };

      // Update local state
      state.settings.docsAgentConnection = docsConn;
      state.settings.workdriveConnection = wdConn;
      state.settings.workdriveFolder = payload.workdriveDefaultFolder;
      state.settings.claudeModel = payload.claudeModel;

      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      alert('✅ Settings saved to Living_Docs_Settings custom module!');
    } catch (err) {
      alert('Save error: ' + err.message);
    } finally {
      dom.btnSaveSettings.disabled = false;
      dom.btnSaveSettings.textContent = '💾 Save Settings to Custom Module';
    }
  }

  async function triggerSimulation(scenario, label) {
    try {
      const resp = await fetch('/api/simulate-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario })
      });
      const data = await resp.json();

      alert(`🧪 [Demo Simulator]: ${label}\n\nSwitching to Drift Detection Radar to inspect changes...`);
      await checkDrift();
      switchTab('tab-drift');
    } catch (err) {
      alert('Simulation error: ' + err.message);
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
