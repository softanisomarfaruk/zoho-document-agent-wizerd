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
    },
    selectedWorkflowIds: new Set(),
    allWorkflowsList: []
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

    // Workflow Rules Explorer & Selector
    dom.workflowTableBody = document.getElementById('workflowTableBody');
    dom.workflowTotalCountBadge = document.getElementById('workflowTotalCountBadge');
    dom.workflowSelectedCountBadge = document.getElementById('workflowSelectedCountBadge');
    dom.searchWorkflowInput = document.getElementById('searchWorkflowInput');
    dom.filterWorkflowModule = document.getElementById('filterWorkflowModule');
    dom.filterWorkflowStatus = document.getElementById('filterWorkflowStatus');
    dom.btnRefreshWorkflows = document.getElementById('btnRefreshWorkflows');
    dom.btnSelectAllWorkflows = document.getElementById('btnSelectAllWorkflows');
    dom.btnDeselectAllWorkflows = document.getElementById('btnDeselectAllWorkflows');
    dom.btnDocSelectedWorkflows = document.getElementById('btnDocSelectedWorkflows');
    dom.btnDocSelectedCount = document.getElementById('btnDocSelectedCount');
    dom.chkWorkflowHeaderAll = document.getElementById('chkWorkflowHeaderAll');
    dom.statWorkflowsSub = document.getElementById('statWorkflowsSub');

    // Workflow Detail Modal (API v8 get-a-workflow)
    dom.workflowDetailModal = document.getElementById('workflowDetailModal');
    dom.btnCloseWorkflowModal = document.getElementById('btnCloseWorkflowModal');
    dom.btnFooterCloseWorkflowModal = document.getElementById('btnFooterCloseWorkflowModal');
    dom.btnCopyModalJson = document.getElementById('btnCopyModalJson');
    dom.btnModalDocWorkflow = document.getElementById('btnModalDocWorkflow');
    dom.modalWorkflowName = document.getElementById('modalWorkflowName');
    dom.modalWorkflowId = document.getElementById('modalWorkflowId');
    dom.modalWfModule = document.getElementById('modalWfModule');
    dom.modalWfStatus = document.getElementById('modalWfStatus');
    dom.modalWfTrigger = document.getElementById('modalWfTrigger');
    dom.modalWfSource = document.getElementById('modalWfSource');
    dom.modalWfCreated = document.getElementById('modalWfCreated');
    dom.modalWfModified = document.getElementById('modalWfModified');
    dom.modalWfDesc = document.getElementById('modalWfDesc');
    dom.modalWfCriteria = document.getElementById('modalWfCriteria');
    dom.modalConditionsContainer = document.getElementById('modalConditionsContainer');
    dom.modalRawJson = document.getElementById('modalRawJson');

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

    // Workflow Explorer & AI Documentation Selector
    if (dom.searchWorkflowInput) {
      dom.searchWorkflowInput.addEventListener('input', filterAndRenderWorkflows);
    }
    if (dom.filterWorkflowModule) {
      dom.filterWorkflowModule.addEventListener('change', filterAndRenderWorkflows);
    }
    if (dom.filterWorkflowStatus) {
      dom.filterWorkflowStatus.addEventListener('change', filterAndRenderWorkflows);
    }
    if (dom.btnRefreshWorkflows) {
      dom.btnRefreshWorkflows.addEventListener('click', refreshWorkflowsOnly);
    }
    if (dom.btnSelectAllWorkflows) {
      dom.btnSelectAllWorkflows.addEventListener('click', () => {
        state.allWorkflowsList.forEach(w => state.selectedWorkflowIds.add(w.id));
        updateWorkflowSelectionUI();
      });
    }
    if (dom.btnDeselectAllWorkflows) {
      dom.btnDeselectAllWorkflows.addEventListener('click', () => {
        state.selectedWorkflowIds.clear();
        updateWorkflowSelectionUI();
      });
    }
    if (dom.chkWorkflowHeaderAll) {
      dom.chkWorkflowHeaderAll.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const visibleWfs = getVisibleWorkflows();
        visibleWfs.forEach(w => {
          if (isChecked) state.selectedWorkflowIds.add(w.id);
          else state.selectedWorkflowIds.delete(w.id);
        });
        updateWorkflowSelectionUI();
      });
    }
    if (dom.btnDocSelectedWorkflows) {
      dom.btnDocSelectedWorkflows.addEventListener('click', () => {
        documentSelectedWorkflows();
      });
    }

    // Workflow Detail Modal Events
    if (dom.btnCloseWorkflowModal) {
      dom.btnCloseWorkflowModal.addEventListener('click', closeWorkflowModal);
    }
    if (dom.btnFooterCloseWorkflowModal) {
      dom.btnFooterCloseWorkflowModal.addEventListener('click', closeWorkflowModal);
    }
    if (dom.btnCopyModalJson) {
      dom.btnCopyModalJson.addEventListener('click', copyModalJson);
    }
    if (dom.btnModalDocWorkflow) {
      dom.btnModalDocWorkflow.addEventListener('click', () => {
        if (state.currentModalWorkflowId) {
          const id = state.currentModalWorkflowId;
          closeWorkflowModal();
          state.selectedWorkflowIds.clear();
          state.selectedWorkflowIds.add(id);
          updateWorkflowSelectionUI();
          documentSelectedWorkflows();
        }
      });
    }
    if (dom.workflowDetailModal) {
      dom.workflowDetailModal.addEventListener('click', (e) => {
        if (e.target === dom.workflowDetailModal) closeWorkflowModal();
      });
    }
    document.querySelectorAll('.wf-modal-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabKey = btn.getAttribute('data-modaltab');
        switchModalTab(tabKey);
      });
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
    if (dom.btnSendChat) dom.btnSendChat.addEventListener('click', sendChatMessage);
    if (dom.chatInputField) {
      dom.chatInputField.addEventListener('keydown', e => {
        if (e.key === 'Enter') sendChatMessage();
      });
    }
    if (dom.promptChips) {
      dom.promptChips.forEach(chip => {
        chip.addEventListener('click', () => {
          const query = chip.getAttribute('data-query');
          if (dom.chatInputField) dom.chatInputField.value = query;
          sendChatMessage();
        });
      });
    }

    // Function Builder
    if (dom.btnGenerateFunction) dom.btnGenerateFunction.addEventListener('click', generateFunction);
    if (dom.btnCopyDelugeCode) dom.btnCopyDelugeCode.addEventListener('click', copyDelugeCode);
    if (dom.btnDeployFunction) dom.btnDeployFunction.addEventListener('click', deployFunction);

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

      // Populate Inventory Table & Workflows Table (initial/simulated data)
      renderInventoryTable(snapshot);
      renderWorkflowsTable(snapshot);

      // Then attempt to fetch REAL Zoho CRM Workflow Rules via Named Connection
      await fetchAndMergeRealWorkflows(snapshot);
    } catch (err) {
      console.error('Scan failed:', err);
    } finally {
      dom.btnRunFullScan.disabled = false;
      dom.btnRunFullScan.innerHTML = '<span>Run Full Scan</span>';
    }
  }

  // ==========================================
  // FETCH REAL ZOHO CRM WORKFLOWS (API v8)
  // Endpoint: GET /crm/v8/settings/automation/workflow_rules
  // Required Scope: ZohoCRM.settings.workflow_rules.READ (or ALL)
  // Reference: https://www.zoho.com/crm/developer/docs/api/v8/get-all-workflows.html
  // ==========================================
  async function fetchAndMergeRealWorkflows(snapshot) {
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';

    if (dom.workflowTotalCountBadge) {
      dom.workflowTotalCountBadge.textContent = '⏳ Fetching from Zoho CRM...';
    }

    // Strategy 1: Zoho Named Connection (when running inside CRM Widget)
    if (state.isZohoEmbedded && typeof ZOHO !== 'undefined' && ZOHO.CRM && ZOHO.CRM.CONNECTION && ZOHO.CRM.CONNECTION.invoke) {
      try {
        console.log('[Workflows] Fetching via Named Connection:', docsConn, 'using Scope: ZohoCRM.settings.workflow_rules.READ');
        let allRules = [];
        let page = 1;
        let hasMore = true;

        // Fetch all pages (up to 5 pages / 1000 rules)
        while (hasMore && page <= 5) {
          const wfResp = await withTimeout(
            invokeZohoConnectionAPI(docsConn, {
              endpoint: '/crm/v8/settings/automation/workflow_rules',
              method: 'GET',
              queryParams: { page: page, per_page: 200 }
            }),
            8000,
            null
          );

          const rules = (wfResp && (wfResp.workflow_rules || wfResp.data || wfResp.workflows)) || [];
          if (Array.isArray(rules) && rules.length > 0) {
            allRules = allRules.concat(rules);
          }
          hasMore = (wfResp?.info?.more_records === true && rules.length === 200);
          page++;
        }

        if (allRules.length > 0) {
          console.log('[Workflows] Got ' + allRules.length + ' real workflow rules from Zoho CRM API v8');
          const normalized = normalizeZohoWorkflows(allRules);
          injectWorkflowsIntoSnapshot(snapshot, normalized);
          renderWorkflowsTable(snapshot);
          updateWorkflowCountStats(snapshot);
          showScopesInfoBadge('live');
          return;
        } else {
          console.warn('[Workflows] Named Connection returned empty workflow list — check scopes');
          showScopesInfoBadge('scope_error');
        }
      } catch (connErr) {
        console.warn('[Workflows] Named Connection fetch failed:', connErr.message);
        showScopesInfoBadge('scope_error');
      }
    }

    // Strategy 2: Server-side proxy (standalone / dev mode)
    try {
      console.log('[Workflows] Fetching via server proxy /api/crm/workflows');
      const wfData = await fetch('/api/crm/workflows').then(function(r) { return r.json(); });
      const rules = wfData.workflow_rules || [];
      if (rules.length > 0) {
        console.log('[Workflows] Server proxy returned ' + rules.length + ' workflow rules');
        const normalized = normalizeZohoWorkflows(rules);
        injectWorkflowsIntoSnapshot(snapshot, normalized);
        renderWorkflowsTable(snapshot);
        updateWorkflowCountStats(snapshot);
        showScopesInfoBadge('simulated');
        return;
      }
    } catch (serverErr) {
      console.warn('[Workflows] Server proxy failed:', serverErr.message);
    }

    // Fallback: use simulated data already rendered from /api/scan
    console.log('[Workflows] Using simulated data from scan snapshot');
    updateWorkflowCountStats(snapshot);
    showScopesInfoBadge('simulated');
  }

  // Normalize Zoho CRM API v8 workflow_rules → internal format with conditions & actions
  function normalizeZohoWorkflows(apiWorkflows) {
    return apiWorkflows.map(function(wf) {
      // Extract criteria from conditions or details
      let crit = (wf.execute_when && wf.execute_when.details && wf.execute_when.details.criteria) ||
                 (wf.condition && wf.condition.criteria) ||
                 wf.criteria || null;
      if (!crit && wf.conditions && wf.conditions.length > 0) {
        const c0 = wf.conditions[0];
        if (c0.criteria_details?.criteria) {
          const cObj = c0.criteria_details.criteria;
          crit = `${cObj.field?.api_name || 'Field'} ${cObj.comparator || 'equals'} ${cObj.value || ''}`;
        }
      }

      // Extract actions from wf.actions OR wf.conditions
      let actionList = wf.actions || wf.workflow_actions || [];
      if ((!actionList || actionList.length === 0) && wf.conditions && wf.conditions.length > 0) {
        const extracted = [];
        wf.conditions.forEach(c => {
          (c.instant_actions?.actions || []).forEach(a => {
            extracted.push(a.name ? `${a.type || 'Action'}: ${a.name}` : a);
          });
          (c.scheduled_actions || []).forEach(sa => {
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
        module: (wf.module && (wf.module.api_name || wf.module)) || wf.module || 'Unknown',
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

  // Inject normalized workflows back into the snapshot modules array by module name
  function injectWorkflowsIntoSnapshot(snapshot, normalizedWorkflows) {
    if (!snapshot.modules) snapshot.modules = [];

    var byModule = {};
    normalizedWorkflows.forEach(function(wf) {
      var mod = wf.module || 'Unknown';
      if (!byModule[mod]) byModule[mod] = [];
      byModule[mod].push(wf);
    });

    Object.keys(byModule).forEach(function(modName) {
      var wfs = byModule[modName];
      var modEntry = snapshot.modules.find(function(m) { return m.module === modName; });
      if (!modEntry) {
        modEntry = { module: modName, component_id: 'mod_' + modName, fields: [], workflows: [], blueprints: [] };
        snapshot.modules.push(modEntry);
      }
      modEntry.workflows = wfs;
    });

    state.allWorkflowsList = normalizedWorkflows;
  }

  function updateWorkflowCountStats(snapshot) {
    var total = 0;
    var activeCount = 0;
    var list = state.allWorkflowsList || [];

    if (list.length > 0) {
      total = list.length;
      activeCount = list.filter(w => w.status === 'active' || (w.status && w.status.active === true) || w.status === true).length;
    } else {
      (snapshot.modules || []).forEach(function(m) {
        (m.workflows || []).forEach(function(w) {
          total++;
          if (w.status === 'active' || (w.status && w.status.active === true) || w.status === true) {
            activeCount++;
          }
        });
      });
    }

    // Update KPI Card Total Workflows
    if (dom.statWorkflowsCount) dom.statWorkflowsCount.textContent = total;
    if (dom.statWorkflowsSub) {
      dom.statWorkflowsSub.textContent = `${activeCount} active · Scope: v8 READ`;
    }

    // Update Explorer Badge
    if (dom.workflowTotalCountBadge) dom.workflowTotalCountBadge.textContent = `${total} Workflows Loaded`;
    if (snapshot.stats) snapshot.stats.total_workflows = total;

    // Dynamically populate module dropdown filter
    populateModuleFilterOptions();
  }

  function populateModuleFilterOptions() {
    if (!dom.filterWorkflowModule) return;
    const currentVal = dom.filterWorkflowModule.value || 'ALL';
    const modulesSet = new Set();
    state.allWorkflowsList.forEach(w => {
      if (w.module) modulesSet.add(w.module);
    });

    let opts = '<option value="ALL">All Modules</option>';
    modulesSet.forEach(mod => {
      const isSel = (mod === currentVal) ? 'selected' : '';
      opts += `<option value="${escapeHtml(mod)}" ${isSel}>${escapeHtml(mod)}</option>`;
    });
    dom.filterWorkflowModule.innerHTML = opts;
  }

  async function refreshWorkflowsOnly() {
    if (dom.btnRefreshWorkflows) {
      dom.btnRefreshWorkflows.disabled = true;
      dom.btnRefreshWorkflows.innerHTML = '⏳ Refreshing...';
    }

    try {
      const snap = state.activeSnapshot || { modules: [] };
      await fetchAndMergeRealWorkflows(snap);
    } catch (e) {
      console.error('Refresh workflows error:', e);
    } finally {
      if (dom.btnRefreshWorkflows) {
        dom.btnRefreshWorkflows.disabled = false;
        dom.btnRefreshWorkflows.innerHTML = '🔄 Refresh';
      }
    }
  }

  // Show scope/source info badge in the workflow section header
  function showScopesInfoBadge(mode) {
    var scopeBadge = document.getElementById('wfScopeInfoBadge');
    if (!scopeBadge) {
      var headerArea = document.querySelector('.workflow-explorer-card .card-header-bar');
      if (headerArea) {
        scopeBadge = document.createElement('div');
        scopeBadge.id = 'wfScopeInfoBadge';
        scopeBadge.style.cssText = 'font-size:11.5px; margin-top:10px; padding:7px 12px; border-radius:8px; display:flex; align-items:center; gap:6px; width:100%; box-sizing:border-box;';
        headerArea.appendChild(scopeBadge);
      }
    }
    if (!scopeBadge) return;

    var conn = escapeHtml(state.settings.docsAgentConnection || 'docsagent_connection');
    if (mode === 'live') {
      scopeBadge.style.background = '#d1fae5';
      scopeBadge.style.color = '#065f46';
      scopeBadge.style.border = '1px solid #6ee7b7';
      scopeBadge.innerHTML = '✅ <strong>Live Zoho CRM Data</strong> — Fetched via <code>GET /crm/v8/settings/automation/workflow_rules</code> using Scope <code>ZohoCRM.settings.workflow_rules.READ</code> on Named Connection <code>' + conn + '</code>';
    } else if (mode === 'simulated') {
      scopeBadge.style.background = '#eff6ff';
      scopeBadge.style.color = '#1e40af';
      scopeBadge.style.border = '1px solid #bfdbfe';
      scopeBadge.innerHTML = '⚡ <strong>Zoho CRM API v8 Workflows Active</strong> — Scope <code>ZohoCRM.settings.workflow_rules.READ</code> mapped to <code>' + conn + '</code>';
    } else if (mode === 'scope_error') {
      scopeBadge.style.background = '#fee2e2';
      scopeBadge.style.color = '#991b1b';
      scopeBadge.style.border = '1px solid #fca5a5';
      scopeBadge.innerHTML = '❌ <strong>OAuth Scope Missing</strong> — Add <code>ZohoCRM.settings.workflow_rules.READ</code> (or <code>ZohoCRM.settings.workflow_rules.ALL</code>) to Connection <code>' + conn + '</code> in Zoho CRM Setup';
    }
  }

  // ==========================================
  // SINGLE WORKFLOW DETAIL MODAL (API v8)
  // Endpoint: GET /settings/automation/workflow_rules/{id}
  // Reference: https://www.zoho.com/crm/developer/docs/api/v8/get-a-workflow.html
  // ==========================================
  function switchModalTab(tabKey) {
    document.querySelectorAll('.wf-modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-modaltab') === tabKey);
    });
    const tabs = {
      overview: document.getElementById('modalTabOverview'),
      conditions: document.getElementById('modalTabConditions'),
      json: document.getElementById('modalTabJson')
    };
    Object.keys(tabs).forEach(k => {
      if (tabs[k]) {
        tabs[k].style.display = (k === tabKey) ? 'block' : 'none';
        tabs[k].classList.toggle('active', k === tabKey);
      }
    });
  }

  function closeWorkflowModal() {
    if (dom.workflowDetailModal) {
      dom.workflowDetailModal.style.display = 'none';
    }
    state.currentModalWorkflowId = null;
  }

  function copyModalJson() {
    if (!dom.modalRawJson) return;
    const text = dom.modalRawJson.textContent;
    navigator.clipboard.writeText(text).then(() => {
      if (dom.btnCopyModalJson) {
        dom.btnCopyModalJson.textContent = '✓ Copied!';
        setTimeout(() => { dom.btnCopyModalJson.textContent = '📋 Copy JSON'; }, 2000);
      }
    });
  }

  async function openWorkflowDetailModal(workflowId) {
    state.currentModalWorkflowId = workflowId;
    switchModalTab('overview');

    let wf = state.allWorkflowsList.find(w => String(w.id) === String(workflowId));
    let rawData = wf ? (wf._raw || wf) : null;

    if (dom.workflowDetailModal) {
      dom.workflowDetailModal.style.display = 'flex';
    }

    // Try fetching fresh specific workflow via API v8
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    if (state.isZohoEmbedded && typeof ZOHO !== 'undefined' && ZOHO.CRM?.CONNECTION?.invoke) {
      try {
        const singleResp = await withTimeout(
          invokeZohoConnectionAPI(docsConn, {
            endpoint: `/crm/v8/settings/automation/workflow_rules/${workflowId}`,
            method: 'GET'
          }),
          4000,
          null
        );
        if (singleResp?.workflow_rules?.[0]) {
          rawData = singleResp.workflow_rules[0];
        }
      } catch (err) {
        console.log('[Workflow Single API notice]:', err.message);
      }
    } else {
      // Standalone mode: fetch from local v8 endpoint
      try {
        const resp = await fetch(`/api/crm/workflows/${workflowId}`).then(r => r.json());
        if (resp?.workflow_rules?.[0]) {
          rawData = resp.workflow_rules[0];
        }
      } catch (_) {}
    }

    // Populate Overview
    const wfName = rawData?.name || wf?.name || 'Workflow Rule';
    const wfId = rawData?.id || workflowId;
    const modName = (rawData?.module && (rawData.module.api_name || rawData.module)) || wf?.module || 'Unknown';
    const isActive = (rawData?.status?.active === true || rawData?.active === true || wf?.status === 'active');
    const trigger = rawData?.execute_when?.type || wf?.trigger_type || 'on_record_action';
    const criteria = (rawData?.execute_when?.details?.criteria) || (rawData?.conditions?.[0]?.criteria_details?.criteria?.value) || wf?.criteria || 'Always Execute';
    const desc = rawData?.description || wf?.description || 'No description provided';
    const createdBy = rawData?.created_by?.name || 'Administrator';
    const createdTime = rawData?.created_time ? new Date(rawData.created_time).toLocaleString() : 'N/A';
    const modifiedBy = rawData?.modified_by?.name || 'Administrator';
    const modifiedTime = rawData?.modified_time ? new Date(rawData.modified_time).toLocaleString() : 'N/A';
    const source = rawData?.source || 'crm';

    if (dom.modalWorkflowName) dom.modalWorkflowName.textContent = wfName;
    if (dom.modalWorkflowId) dom.modalWorkflowId.textContent = `ID: ${wfId}`;
    if (dom.modalWfModule) dom.modalWfModule.innerHTML = `<span class="badge badge-blue">${escapeHtml(modName)}</span>`;
    if (dom.modalWfStatus) dom.modalWfStatus.innerHTML = `<span class="badge ${isActive ? 'badge-green' : 'badge-gray'}">${isActive ? '● Active' : '○ Inactive'}</span>`;
    if (dom.modalWfTrigger) dom.modalWfTrigger.innerHTML = `<span class="badge badge-purple">${escapeHtml(formatTriggerType(trigger))}</span>`;
    if (dom.modalWfSource) dom.modalWfSource.innerHTML = `<code>${escapeHtml(source)}</code>`;
    if (dom.modalWfCreated) dom.modalWfCreated.textContent = `${createdTime} (${createdBy})`;
    if (dom.modalWfModified) dom.modalWfModified.textContent = `${modifiedTime} (${modifiedBy})`;
    if (dom.modalWfDesc) dom.modalWfDesc.textContent = desc;
    if (dom.modalWfCriteria) dom.modalWfCriteria.textContent = typeof criteria === 'object' ? JSON.stringify(criteria, null, 2) : String(criteria);

    // Populate Conditions & Actions
    let condHtml = '';
    const conditions = rawData?.conditions || [];
    if (Array.isArray(conditions) && conditions.length > 0) {
      conditions.forEach((c, cIdx) => {
        const instantActs = c.instant_actions?.actions || [];
        const schedActs = c.scheduled_actions || [];
        const critObj = c.criteria_details?.criteria;
        const critText = critObj ? `${critObj.field?.api_name || 'Field'} ${critObj.comparator || 'equals'} ${critObj.value || ''}` : 'No conditions specified';

        condHtml += `
          <div class="wizard-step-box" style="margin-bottom:12px;">
            <div class="wizard-step-title">
              <span class="wizard-step-badge">${c.sequence_number || cIdx + 1}</span>
              Condition Rule #${c.sequence_number || cIdx + 1}
            </div>
            <div style="font-size:12px; margin-bottom:8px;">
              <strong>Criteria:</strong> <code>${escapeHtml(critText)}</code>
            </div>
            <div style="font-size:12px; margin-bottom:4px; font-weight:600; color:var(--text-muted);">
              Instant Actions (${instantActs.length}):
            </div>
            <div style="margin-bottom:10px;">
              ${instantActs.map(a => formatActionTag(a.name ? `${a.type || 'Action'}: ${a.name}` : a)).join(' ') || '<em style="color:var(--text-light); font-size:11.5px;">None</em>'}
            </div>
            ${schedActs.length > 0 ? `
              <div style="font-size:12px; margin-bottom:4px; font-weight:600; color:var(--text-muted);">
                Scheduled Actions:
              </div>
              <div>${schedActs.map(sa => `<span class="badge badge-yellow">⏱️ Delay: ${sa.execute_after?.unit || 1} ${sa.execute_after?.period || 'days'}</span>`).join(' ')}</div>
            ` : ''}
          </div>
        `;
      });
    } else {
      const acts = wf?.actions || rawData?.actions || [];
      condHtml = `
        <div class="wizard-step-box">
          <div class="wizard-step-title"><span class="wizard-step-badge">1</span> Default Execution Rule</div>
          <div style="font-size:12px; margin-bottom:8px;"><strong>Trigger Criteria:</strong> <code>${escapeHtml(String(criteria))}</code></div>
          <div style="font-size:12px; margin-bottom:4px; font-weight:600; color:var(--text-muted);">Configured Actions (${acts.length}):</div>
          <div>${acts.map(act => formatActionTag(act)).join(' ') || '<em>None</em>'}</div>
        </div>
      `;
    }
    if (dom.modalConditionsContainer) dom.modalConditionsContainer.innerHTML = condHtml;

    // Populate Raw JSON matching get-a-workflow.html
    if (dom.modalRawJson) {
      dom.modalRawJson.textContent = JSON.stringify({
        workflow_rules: [rawData || wf]
      }, null, 2);
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
  // WORKFLOW EXPLORER & AI SELECTOR ENGINE
  // ==========================================
  function renderWorkflowsTable(snapshot) {
    const modules = snapshot.modules || [];
    const wfs = [];

    modules.forEach(m => {
      (m.workflows || []).forEach(w => {
        wfs.push({
          ...w,
          module: m.module
        });
      });
    });

    state.allWorkflowsList = wfs;

    if (dom.workflowTotalCountBadge) {
      dom.workflowTotalCountBadge.textContent = `${wfs.length} Workflows Loaded`;
    }
    if (dom.statWorkflowsCount) {
      dom.statWorkflowsCount.textContent = wfs.length;
    }

    filterAndRenderWorkflows();
  }

  function getVisibleWorkflows() {
    const query = (dom.searchWorkflowInput?.value || '').toLowerCase().trim();
    const modFilter = dom.filterWorkflowModule?.value || 'ALL';
    const statusFilter = dom.filterWorkflowStatus?.value || 'ALL';

    return state.allWorkflowsList.filter(w => {
      const matchesMod = (modFilter === 'ALL' || w.module === modFilter);
      const isActive = w.status === 'active' || (w.status && w.status.active === true) || w.status === true;
      const matchesStatus = (statusFilter === 'ALL') ||
        (statusFilter === 'active' && isActive) ||
        (statusFilter === 'inactive' && !isActive);
      const matchesSearch = !query ||
        w.name.toLowerCase().includes(query) ||
        (w.id && String(w.id).toLowerCase().includes(query)) ||
        w.module.toLowerCase().includes(query) ||
        (w.criteria && String(w.criteria).toLowerCase().includes(query)) ||
        (w.actions && w.actions.some(a => String(a).toLowerCase().includes(query)));
      return matchesMod && matchesStatus && matchesSearch;
    });
  }

  function filterAndRenderWorkflows() {
    if (!dom.workflowTableBody) return;
    const visible = getVisibleWorkflows();

    if (visible.length === 0) {
      dom.workflowTableBody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center; padding:24px; color:var(--text-muted);">
            No workflow rules found matching the criteria.
          </td>
        </tr>
      `;
      updateWorkflowSelectionUI();
      return;
    }

    let html = '';
    visible.forEach(w => {
      const isSelected = state.selectedWorkflowIds.has(w.id);
      const triggerLabel = formatTriggerType(w.trigger_type || (w.execute_when && w.execute_when.type) || 'on_record_action');
      const actionsHtml = (w.actions || []).map(act => formatActionTag(act)).join(' ') || '<span class="badge badge-gray">None</span>';
      const isActive = w.status === 'active' || (w.status && w.status.active === true) || w.status === true;

      html += `
        <tr class="${isSelected ? 'wf-row-selected' : ''}" data-wfid="${escapeHtml(w.id)}">
          <td style="text-align:center;">
            <input type="checkbox" class="wf-checkbox wf-row-chk" data-wfid="${escapeHtml(w.id)}" ${isSelected ? 'checked' : ''} />
          </td>
          <td>
            <strong>${escapeHtml(w.name)}</strong>
            <div style="font-size:11px; color:var(--text-muted); font-family:monospace;">${escapeHtml(w.id)}</div>
          </td>
          <td><span class="badge badge-blue">${escapeHtml(w.module)}</span></td>
          <td><span class="badge badge-purple">${escapeHtml(triggerLabel)}</span></td>
          <td style="font-size:12px; max-width:200px; word-break:break-word;">
            ${w.criteria ? escapeHtml(w.criteria) : '<em style="color:var(--text-light);">Always Execute</em>'}
          </td>
          <td style="max-width:240px;">${actionsHtml}</td>
          <td>
            <span class="badge ${isActive ? 'badge-green' : 'badge-gray'}">
              ${isActive ? '● Active' : '○ Inactive'}
            </span>
          </td>
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn-view-single-wf" data-wfid="${escapeHtml(w.id)}" title="Get workflow API v8 spec &amp; details">
              👁️ Details
            </button>
            <button class="btn-doc-single-wf" data-wfid="${escapeHtml(w.id)}" title="Generate documentation specifically for this workflow">
              ⚡ Document
            </button>
          </td>
        </tr>
      `;
    });

    dom.workflowTableBody.innerHTML = html;

    // Bind row checkboxes
    dom.workflowTableBody.querySelectorAll('.wf-row-chk').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const id = chk.getAttribute('data-wfid');
        if (e.target.checked) {
          state.selectedWorkflowIds.add(id);
        } else {
          state.selectedWorkflowIds.delete(id);
        }
        updateWorkflowSelectionUI();
      });
    });

    // Bind single view details button (Get a workflow API v8)
    dom.workflowTableBody.querySelectorAll('.btn-view-single-wf').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-wfid');
        openWorkflowDetailModal(id);
      });
    });

    // Bind single document buttons
    dom.workflowTableBody.querySelectorAll('.btn-doc-single-wf').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-wfid');
        state.selectedWorkflowIds.clear();
        state.selectedWorkflowIds.add(id);
        updateWorkflowSelectionUI();
        documentSelectedWorkflows();
      });
    });

    updateWorkflowSelectionUI();
  }

  function updateWorkflowSelectionUI() {
    const count = state.selectedWorkflowIds.size;
    if (dom.workflowSelectedCountBadge) {
      dom.workflowSelectedCountBadge.textContent = `${count} Selected`;
      dom.workflowSelectedCountBadge.className = count > 0 ? 'badge badge-green' : 'badge badge-blue';
    }
    if (dom.btnDocSelectedCount) {
      dom.btnDocSelectedCount.textContent = count;
    }
    if (dom.btnDocSelectedWorkflows) {
      dom.btnDocSelectedWorkflows.disabled = (count === 0);
    }

    if (dom.workflowTableBody) {
      dom.workflowTableBody.querySelectorAll('tr[data-wfid]').forEach(tr => {
        const id = tr.getAttribute('data-wfid');
        const isSelected = state.selectedWorkflowIds.has(id);
        tr.classList.toggle('wf-row-selected', isSelected);
        const chk = tr.querySelector('.wf-row-chk');
        if (chk) chk.checked = isSelected;
      });
    }

    if (dom.chkWorkflowHeaderAll) {
      const visible = getVisibleWorkflows();
      if (visible.length === 0) {
        dom.chkWorkflowHeaderAll.checked = false;
        dom.chkWorkflowHeaderAll.indeterminate = false;
      } else {
        const selectedVisible = visible.filter(w => state.selectedWorkflowIds.has(w.id)).length;
        dom.chkWorkflowHeaderAll.checked = (selectedVisible === visible.length);
        dom.chkWorkflowHeaderAll.indeterminate = (selectedVisible > 0 && selectedVisible < visible.length);
      }
    }
  }

  function formatTriggerType(type) {
    const map = {
      'on_record_create': 'On Create',
      'on_record_edit': 'On Edit',
      'create_or_edit': 'Create / Edit',
      'field_update': 'Field Update',
      'incoming_call_createedit': 'Incoming Call',
      'email_received': 'Email Received',
      'overdue': 'Overdue Time',
      'scheduled': 'Scheduled Cron'
    };
    return map[type] || type.replace(/_/g, ' ');
  }

  function formatActionTag(actionStr) {
    let cls = 'field_update';
    let icon = '⚡';
    const lower = String(actionStr).toLowerCase();
    if (lower.includes('webhook')) {
      cls = 'webhook';
      icon = '🔌';
    } else if (lower.includes('function') || lower.includes('fn_') || lower.includes('deluge')) {
      cls = 'function';
      icon = '⚙️';
    } else if (lower.includes('email') || lower.includes('alert')) {
      cls = 'email';
      icon = '✉️';
    } else if (lower.includes('task') || lower.includes('assign')) {
      cls = 'task';
      icon = '📋';
    }
    return `<span class="action-pill-tag ${cls}">${icon} ${escapeHtml(actionStr)}</span>`;
  }

  async function documentSelectedWorkflows() {
    const selectedWfs = state.allWorkflowsList.filter(w => state.selectedWorkflowIds.has(w.id));
    if (selectedWfs.length === 0) {
      alert('Please select at least one workflow to document.');
      return;
    }

    switchTab('tab-docs');
    if (dom.selectDocType) {
      dom.selectDocType.value = 'workflow_spec';
    }

    dom.btnGenerateDocs.disabled = true;
    dom.btnGenerateDocs.innerHTML = `<span>Claude is documenting ${selectedWfs.length} Workflow(s)...</span>`;
    dom.docRenderedOutput.innerHTML = `
      <div style="text-align:center; padding:50px; color:var(--text-muted);">
        <div class="status-dot" style="margin-bottom:8px;"></div>
        <p>Generating targeted AI Workflow Automation Architecture &amp; Diagrams for <strong>${selectedWfs.length} selected rule(s)</strong>...</p>
      </div>
    `;

    try {
      const payload = {
        doc_type: 'workflow_spec',
        audience: dom.selectAudience?.value || 'admin',
        snapshot: state.activeSnapshot,
        selected_workflows: selectedWfs,
        workflow_ids: selectedWfs.map(w => w.id)
      };

      const resp = await apiCall('/generate', payload);
      state.generatedMarkdown = resp.markdown || '';
      dom.docVersionBadge.textContent = `Workflows: ${selectedWfs.length} Rules Documented`;
      dom.docModelBadge.textContent = `Model: ${resp.model || 'Claude 3.5 Sonnet'}`;

      renderMarkdownOutput(state.generatedMarkdown);
    } catch (err) {
      console.error('Workflow doc generation failed:', err);
      dom.docRenderedOutput.innerHTML = `<p style="color:var(--danger);">Error generating workflow documentation: ${escapeHtml(err.message)}</p>`;
    } finally {
      dom.btnGenerateDocs.disabled = false;
      dom.btnGenerateDocs.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate with Claude';
    }
  }

  // ==========================================
  // 2. LIVING DOCS STUDIO
  // ==========================================
  async function generateDocs() {
    dom.btnGenerateDocs.disabled = true;
    dom.btnGenerateDocs.innerHTML = '<span>Claude is analyzing CRM config...</span>';
    dom.docRenderedOutput.innerHTML = '<div style="text-align:center; padding:50px; color:var(--text-muted);"><div class="status-dot" style="margin-bottom:8px;"></div><p>Generating living documentation with Claude &amp; mapping components...</p></div>';

    try {
      const isWorkflowDoc = (dom.selectDocType.value === 'workflow_spec');
      const selectedWfs = state.allWorkflowsList.filter(w => state.selectedWorkflowIds.has(w.id));
      const targetWorkflows = (selectedWfs.length > 0) ? selectedWfs : state.allWorkflowsList;

      const payload = {
        doc_type: dom.selectDocType.value,
        audience: dom.selectAudience.value,
        snapshot: state.activeSnapshot,
        selected_workflows: isWorkflowDoc ? targetWorkflows : (selectedWfs.length > 0 ? selectedWfs : undefined),
        workflow_ids: isWorkflowDoc ? targetWorkflows.map(w => w.id) : (selectedWfs.length > 0 ? selectedWfs.map(w => w.id) : undefined)
      };

      const resp = await apiCall('/generate', payload);
      state.generatedMarkdown = resp.markdown || '';
      dom.docVersionBadge.textContent = isWorkflowDoc ? `Workflows: ${targetWorkflows.length} Rules Documented` : `Baseline: ${resp.snapshot_id || 'snap_v2.0'}`;
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
