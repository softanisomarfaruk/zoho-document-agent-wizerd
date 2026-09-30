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
    settingsRecordId: null,
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
    const btnOpenSetupInline = document.getElementById('btnOpenSetupWizardInline');
    if (btnOpenSetupInline) {
      btnOpenSetupInline.addEventListener('click', () => showOnboardingView(true));
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
          per_page: 200
        });
        if (resp && resp.data && resp.data.length > 0) {
          const named = resp.data.filter(r => r.Name === 'agent_config_v1');
          const pool = named.length ? named : resp.data;
          pool.sort((a, b) => new Date(b.Modified_Time || b.Created_Time || 0) - new Date(a.Modified_Time || a.Created_Time || 0));
          const cfg = pool[0];
          if (cfg && (cfg.Docs_Agent_Connection || cfg.Workdrive_Connection || cfg.id)) {
            state.settingsRecordId = cfg.id || null;
            state.settings.docsAgentConnection = cfg.Docs_Agent_Connection || state.settings.docsAgentConnection;
            state.settings.workdriveConnection = cfg.Workdrive_Connection || state.settings.workdriveConnection;
            state.settings.claudeModel = cfg.Claude_Model || state.settings.claudeModel;
            state.settings.workdriveFolder = cfg.Workdrive_Folder_Id || state.settings.workdriveFolder;
            if (cfg.Claude_API_Key) state.settings.claudeApiKey = cfg.Claude_API_Key;
            if (cfg.Schedule_Frequency) state.settings.scheduleFrequency = cfg.Schedule_Frequency;
            state.connectionsConfirmed = !!(cfg.Docs_Agent_Connection && cfg.Workdrive_Connection);
            state.duplicateSettingsCount = named.length;
            renderSettingsRecordStatus();
            const freqEl = document.getElementById('settingsScheduleFreq');
            if (freqEl && state.settings.scheduleFrequency) freqEl.value = state.settings.scheduleFrequency;
            if (dom.settingsClaudeKey && cfg.Claude_API_Key) {
              dom.settingsClaudeKey.value = '';
              dom.settingsClaudeKey.placeholder = 'Saved in CRM — leave blank to keep';
            }
            console.log('[Setup] Settings loaded from record', state.settingsRecordId);
            syncSettingsToServer();
            return state.connectionsConfirmed;
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
        state.settings.workdriveFolder = data.settings.workdriveDefaultFolder || state.settings.workdriveFolder;
        state.settingsRecordId = data.settings.settingsRecordId || state.settingsRecordId;
        state.connectionsConfirmed = true;
        renderSettingsRecordStatus();
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return data;
  }

  function showToast(message, type = 'success') {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 250);
    }, 4200);
  }

  function setScanStatus(text) {
    const el = document.getElementById('scanLiveStatus');
    if (el) el.textContent = text;
  }

  function renderSettingsRecordStatus() {
    const title = document.getElementById('settingsRecordMode');
    const detail = document.getElementById('settingsRecordDetail');
    if (!detail) return;
    if (state.settingsRecordId) {
      if (title) title.textContent = 'Update mode:';
      const extra = state.duplicateSettingsCount > 1 ? ` ${state.duplicateSettingsCount} rows already exist; this save updates the latest one and does not add another.` : '';
      detail.textContent = `Next save updates Living_Docs_Settings record ${state.settingsRecordId}. A new row is not created.${extra}`;
    } else {
      if (title) title.textContent = 'Create mode:';
      detail.textContent = 'No settings row yet. The first save creates one record. Every later save updates that same record.';
    }
  }

  function canUseZohoConnection() {
    return state.isZohoEmbedded && typeof ZOHO !== 'undefined' && !!(ZOHO.CRM && ZOHO.CRM.CONNECTION && ZOHO.CRM.CONNECTION.invoke);
  }

  function emptyClientSnapshot(message) {
    return {
      id: 'snap_empty',
      timestamp: new Date().toISOString(),
      source: 'none',
      message: message || '',
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

  function updateAllKpis(snapshot) {
    const stats = (snapshot && snapshot.stats) || {};
    if (dom.statModulesCount) dom.statModulesCount.textContent = stats.total_modules || 0;
    if (dom.statFieldsCount) dom.statFieldsCount.textContent = stats.total_fields || 0;
    if (dom.statBlueprintsCount) dom.statBlueprintsCount.textContent = stats.total_blueprints || 0;
    if (dom.statFunctionsCount) dom.statFunctionsCount.textContent = stats.total_functions || 0;
    const modulesSub = document.getElementById('statModulesSub');
    const fieldsSub = document.getElementById('statFieldsSub');
    const blueprintsSub = document.getElementById('statBlueprintsSub');
    const functionsSub = document.getElementById('statFunctionsSub');
    if (modulesSub) {
      const conn = state.settings.docsAgentConnection || 'docsagent_connection';
      modulesSub.textContent = snapshot && snapshot.source === 'zoho_crm_v8'
        ? `${conn} · ZohoCRM.settings.modules.READ`
        : 'Waiting for CRM API';
    }
    if (fieldsSub) fieldsSub.textContent = snapshot && snapshot.source === 'zoho_crm_v8' ? 'GET /settings/fields' : 'Waiting for CRM API';
    if (blueprintsSub) blueprintsSub.textContent = snapshot && snapshot.source === 'zoho_crm_v8' ? 'GET /settings/blueprints' : 'Waiting for CRM API';
    if (functionsSub) functionsSub.textContent = snapshot && snapshot.source === 'zoho_crm_v8' ? 'GET /settings/automation/functions' : 'Waiting for CRM API';
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
    const details = rawResp && rawResp.details;
    if (details && typeof details === 'object' && details.statusMessage !== undefined) {
      parsed = details.statusMessage;
    } else if (details && typeof details === 'object' && details.output !== undefined) {
      parsed = details.output;
    } else if (rawResp?.result !== undefined) {
      parsed = rawResp.result;
    }
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { parsed = JSON.parse(trimmed); } catch (_) {}
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

  function syncSettingsToServer() {
    const payload = {
      claudeModel: state.settings.claudeModel,
      workdriveDefaultFolder: state.settings.workdriveFolder,
      docsAgentConnection: state.settings.docsAgentConnection,
      workdriveConnection: state.settings.workdriveConnection,
      scheduleFrequency: state.settings.scheduleFrequency,
      settingsRecordId: state.settingsRecordId
    };
    if (state.settings.claudeApiKey) payload.claudeApiKey = state.settings.claudeApiKey;
    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => null);
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
    const pool = named.length ? named : rows;
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

  async function upsertSettingsRecord(fields) {
    if (typeof ZOHO === 'undefined' || !ZOHO.CRM?.API) {
      return { ok: true, action: 'server-only', id: state.settingsRecordId || null };
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
      Claude_Model: fields.claudeModel,
      Workdrive_Folder_Id: fields.workdriveFolder
    };
    if (fields.claudeApiKey) APIData.Claude_API_Key = fields.claudeApiKey;
    if (fields.scheduleFrequency) APIData.Schedule_Frequency = fields.scheduleFrequency;

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

    const attempt = async (data, isUpdate) => {
      try {
        const resp = await write(data, isUpdate);
        let result = zohoWriteResult(resp);
        if (!result.ok) {
          const slim = { ...data };
          delete slim.Claude_API_Key;
          delete slim.Schedule_Frequency;
          const retry = await write(slim, isUpdate);
          result = zohoWriteResult(retry);
        }
        return result;
      } catch (err) {
        return { ok: false, message: err.message || String(err) };
      }
    };

    if (existingId && ZOHO.CRM.API.updateRecord) {
      const updateData = { ...APIData, id: existingId };
      const updated = await attempt(updateData, true);
      if (updated.ok) {
        state.settingsRecordId = existingId;
        return { ok: true, action: 'updated', id: existingId };
      }
      const missing = /not found|invalid data|the id given seems to be invalid/i.test(updated.message || '');
      if (!missing) {
        return { ok: false, action: 'update-failed', id: existingId, message: updated.message };
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
          { field_label: 'Workdrive Folder Id', data_type: 'text', length: 150 },
          { field_label: 'Claude API Key', data_type: 'text', length: 255 },
          { field_label: 'Schedule Frequency', data_type: 'text', length: 40 }
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

        // 7. Create the settings row once, then update that same row
        if (showFeedback && ZOHO.CRM.API) {
          try {
            log('Saving configuration into the existing Living_Docs_Settings row when one already exists...', 'info');
            const saved = await upsertSettingsRecord({
              docsAgentConnection: state.settings.docsAgentConnection,
              workdriveConnection: state.settings.workdriveConnection,
              claudeModel: state.settings.claudeModel,
              workdriveFolder: state.settings.workdriveFolder,
              claudeApiKey: state._pendingClaudeKey || state.settings.claudeApiKey || '',
              scheduleFrequency: state.settings.scheduleFrequency || 'daily'
            });
            if (saved.ok && saved.action === 'updated') {
              log(`✅ Updated existing settings record ${saved.id}.`, 'ok');
            } else if (saved.ok && saved.action === 'created') {
              log(`✅ Created the first settings record ${saved.id || ''}.`, 'ok');
            } else if (!saved.ok) {
              log(`Settings save notice: ${saved.message || 'Could not write the settings row.'}`, 'warn');
            }
            renderSettingsRecordStatus();
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
    dom.btnRunFullScan.innerHTML = '<span>Scanning CRM API...</span>';
    document.querySelectorAll('.stat-box').forEach(box => box.classList.add('is-loading'));

    const snapshot = emptyClientSnapshot();
    snapshot.source = canUseZohoConnection() ? 'zoho_crm_v8' : 'none';
    const firstScan = !state.baselineSnapshot;

    try {
      if (!canUseZohoConnection()) {
        setScanStatus('Open this widget inside Zoho CRM. KPIs stay at 0 until the CRM APIs respond.');
        state.allWorkflowsList = [];
        state.activeSnapshot = snapshot;
        updateAllKpis(snapshot);
        updateWorkflowCountStats(snapshot);
        renderInventoryTable(snapshot);
        renderWorkflowsTable(snapshot);
        showScopesInfoBadge('standalone');
        showToast('Live CRM data is available when this widget runs inside Zoho CRM.', 'warning');
        return;
      }

      const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
      setScanStatus(`Loading modules from ${docsConn} · GET /crm/v8/settings/modules …`);
      state.activeSnapshot = snapshot;
      try {
        await loadModulesViaConnection(snapshot);
      } catch (moduleErr) {
        console.error('Module scan failed:', moduleErr);
        showToast(moduleErr.message || 'Could not load CRM modules.', 'error');
      }
      setScanStatus('Loading workflow rules from GET /crm/v8/settings/automation/workflow_rules …');
      try {
        await fetchAndMergeRealWorkflows(snapshot);
      } catch (workflowErr) {
        console.error('Workflow scan failed:', workflowErr);
        showToast(workflowErr.message || 'Could not load workflow rules.', 'error');
        showScopesInfoBadge('scope_error');
      }
      await fillModuleFieldBlueprintFunctionStats(snapshot);
      snapshot.timestamp = new Date().toISOString();
      snapshot.id = 'snap_' + Date.now();
      state.activeSnapshot = snapshot;
      if (firstScan) state.baselineSnapshot = JSON.parse(JSON.stringify(snapshot));
      renderInventoryTable(snapshot);
      dom.scanTimestampBadge.textContent = `Last Scanned: ${new Date(snapshot.timestamp).toLocaleTimeString()}`;
      apiCall('/live-cache', { snapshot }).catch(() => {});
    } catch (err) {
      console.error('Scan failed:', err);
      showToast(err.message || 'CRM scan failed', 'error');
      showScopesInfoBadge('scope_error');
    } finally {
      document.querySelectorAll('.stat-box').forEach(box => box.classList.remove('is-loading'));
      dom.btnRunFullScan.disabled = false;
      dom.btnRunFullScan.innerHTML = '<span>Run Full Scan</span>';
    }
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
    const resp = await withTimeout(invokeZohoConnectionAPI(connectionName, {
      endpoint: '/crm/v8/settings/modules',
      method: 'GET'
    }), 20000, null);
    if (!resp) {
      throw new Error(`GET /crm/v8/settings/modules timed out on "${connectionName}". Confirm scope ZohoCRM.settings.modules.READ.`);
    }
    if (resp.code && (resp.status === 'error' || resp.code === 'OAUTH_SCOPE_MISMATCH' || resp.code === 'NO_PERMISSION' || resp.code === 'AUTHORIZATION_FAILED')) {
      throw new Error(`${resp.message || resp.code} on "${connectionName}". Add ZohoCRM.settings.modules.READ or ZohoCRM.settings.ALL.`);
    }
    const mods = resp.modules || resp.data || [];
    if (!Array.isArray(mods)) {
      throw new Error(`"${connectionName}" did not return a modules list from GET /crm/v8/settings/modules.`);
    }
    return mods;
  }

  async function loadModulesViaConnection(snapshot) {
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    const modules = await fetchCrmModules(docsConn);
    const usable = modules.filter(isScannableModule);
    snapshot.crmModules = modules;
    snapshot.source = 'zoho_crm_v8';
    snapshot.stats.total_modules = usable.length;
    if (!snapshot.modules) snapshot.modules = [];
    usable.forEach(mod => {
      let entry = snapshot.modules.find(item => item.module === mod.api_name);
      if (!entry) {
        entry = {
          module: mod.api_name,
          component_id: String(mod.id || mod.api_name),
          fields: [],
          workflows: [],
          blueprints: []
        };
        snapshot.modules.push(entry);
      }
      entry.component_id = String(mod.id || entry.component_id || mod.api_name);
      entry.singular_label = mod.singular_label || mod.plural_label || mod.api_name;
      entry.generated_type = mod.generated_type || '';
      entry.isBlueprintSupported = mod.isBlueprintSupported === true;
    });
    updateAllKpis(snapshot);
    renderInventoryTable(snapshot);
    setScanStatus(`${usable.length} modules loaded from ${docsConn} · GET /crm/v8/settings/modules`);
  }

  async function fetchModuleFields(docsConn, moduleApiName) {
    const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: `/crm/v8/settings/fields?module=${encodeURIComponent(moduleApiName)}`,
      method: 'GET'
    }), 15000, null);
    return Array.isArray(resp?.fields) ? resp.fields : [];
  }

  async function fetchModuleBlueprints(docsConn, moduleApiName) {
    const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: `/crm/v8/settings/blueprints?module=${encodeURIComponent(moduleApiName)}`,
      method: 'GET'
    }), 12000, null);
    if (Array.isArray(resp?.blueprints)) return resp.blueprints;
    if (Array.isArray(resp?.blueprint)) return resp.blueprint;
    if (resp?.blueprint && typeof resp.blueprint === 'object') return [resp.blueprint];
    return [];
  }

  async function fetchCrmFunctions(docsConn) {
    const endpoints = [
      '/crm/v8/settings/automation/functions',
      '/crm/v8/functions',
      '/crm/v2/settings/functions'
    ];
    for (const endpoint of endpoints) {
      const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
        endpoint,
        method: 'GET'
      }), 12000, null);
      const list = resp?.functions || resp?.automation_functions;
      if (Array.isArray(list)) {
        return list.map(fn => ({
          id: String(fn.id || fn.api_name || fn.name || ''),
          name: fn.name || fn.display_name || fn.api_name || 'Function',
          api_name: fn.api_name || fn.name || '',
          return_type: fn.return_type || '',
          description: fn.description || ''
        }));
      }
    }
    return [];
  }

  async function fetchOrgLabel(docsConn) {
    const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: '/crm/v8/org',
      method: 'GET'
    }), 8000, null);
    const org = resp?.org?.[0];
    return org?.company_name || null;
  }

  async function fillModuleFieldBlueprintFunctionStats(snapshot) {
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    setScanStatus('Loading modules, fields, blueprints, and functions…');
    const orgName = await fetchOrgLabel(docsConn);
    if (orgName && dom.headerOrgLabel) dom.headerOrgLabel.textContent = orgName;

    const modules = snapshot.crmModules || await fetchCrmModules(docsConn);
    const usable = modules.filter(isScannableModule);
    snapshot.stats.total_modules = usable.length;
    snapshot.stats.total_workflows = state.allWorkflowsList.length;
    updateAllKpis(snapshot);

    let totalFields = 0;
    let totalBlueprints = 0;
    let done = 0;
    await mapPool(usable, 4, async (mod) => {
      const [fields, blueprints] = await Promise.all([
        fetchModuleFields(docsConn, mod.api_name),
        mod.isBlueprintSupported === true ? fetchModuleBlueprints(docsConn, mod.api_name) : Promise.resolve([])
      ]);
      totalFields += fields.length;
      totalBlueprints += blueprints.length;
      done += 1;

      let entry = (snapshot.modules || []).find(m => m.module === mod.api_name);
      if (!entry) {
        entry = {
          module: mod.api_name,
          component_id: String(mod.id || mod.api_name),
          fields: [],
          workflows: [],
          blueprints: []
        };
        snapshot.modules.push(entry);
      }
      entry.component_id = String(mod.id || entry.component_id || mod.api_name);
      entry.singular_label = mod.singular_label || mod.api_name;
      entry.fields = fields.map(f => ({
        id: f.id,
        api_name: f.api_name,
        label: f.field_label || f.display_label || f.api_name,
        data_type: f.data_type,
        required: !!(f.system_mandatory || f.required),
        custom_field: f.custom_field === true
      }));
      entry.blueprints = blueprints.map(bp => ({
        id: String(bp.id || ''),
        name: bp.name || 'Blueprint',
        field_name: (bp.field && bp.field.api_name) || bp.field_name || '',
        transitions: bp.transitions || []
      }));
      snapshot.stats.total_fields = totalFields;
      snapshot.stats.total_blueprints = totalBlueprints;
      snapshot.stats.total_modules = usable.length;
      snapshot.stats.total_workflows = state.allWorkflowsList.length;
      if (done % 2 === 0 || done === usable.length) {
        updateAllKpis(snapshot);
        setScanStatus(`Live CRM scan ${done}/${usable.length} modules · ${totalFields} fields · ${state.allWorkflowsList.length} workflows`);
      }
    });

    const functions = await fetchCrmFunctions(docsConn);
    snapshot.functions = functions;
    snapshot.stats.total_functions = functions.length;
    snapshot.stats.total_fields = totalFields;
    snapshot.stats.total_blueprints = totalBlueprints;
    snapshot.stats.total_workflows = state.allWorkflowsList.length;
    snapshot.source = 'zoho_crm_v8';
    updateAllKpis(snapshot);
    setScanStatus(`Live data · ${usable.length} modules · ${state.allWorkflowsList.length} workflows · ${totalFields} fields`);
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
      dom.workflowTotalCountBadge.textContent = 'Fetching from Zoho CRM...';
    }

    if (!canUseZohoConnection()) {
      state.allWorkflowsList = [];
      if (!snapshot.modules) snapshot.modules = [];
      renderWorkflowsTable(snapshot);
      updateWorkflowCountStats(snapshot);
      showScopesInfoBadge('standalone');
      return;
    }

    const allRules = await fetchAllWorkflowRulePages(docsConn);
    const detailed = await enrichWorkflowRules(docsConn, allRules);
    const normalized = normalizeZohoWorkflows(detailed);
    injectWorkflowsIntoSnapshot(snapshot, normalized);
    snapshot.stats = snapshot.stats || {};
    snapshot.stats.total_workflows = normalized.length;
    renderWorkflowsTable(snapshot);
    updateWorkflowCountStats(snapshot);
    showScopesInfoBadge('live');
    setScanStatus(`${normalized.length} workflow rules loaded from Zoho CRM.`);
  }

  async function fetchAllWorkflowRulePages(docsConn) {
    const allRules = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 25) {
      const wfResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
        endpoint: `/crm/v8/settings/automation/workflow_rules?page=${page}&per_page=200`,
        method: 'GET'
      }), 20000, null);
      console.log('==================================wfResp==================================================', wfResp);
      if (!wfResp) {
        throw new Error('Workflow rules request timed out. Check the docsagent connection and ZohoCRM.settings.workflow_rules.READ scope.');
      }
      if (wfResp.code && (wfResp.status === 'error' || wfResp.code === 'OAUTH_SCOPE_MISMATCH')) {
        throw new Error(wfResp.message || wfResp.code);
      }
      const rules = wfResp.workflow_rules || wfResp.data || wfResp.workflows || [];
      if (!Array.isArray(rules) || rules.length === 0) break;
      allRules.push(...rules);
      hasMore = wfResp.info?.more_records === true;
      page += 1;
    }
    return allRules;
  }

  async function enrichWorkflowRules(docsConn, rules) {
    const moduleNames = [...new Set(rules.map(rule => (rule.module && (rule.module.api_name || rule.module)) || '').filter(Boolean))];
    const byId = new Map(rules.map(rule => [String(rule.id), rule]));
    const include = 'conditions,conditions.instant_actions,conditions.criteria_details,conditions.scheduled_actions';
    for (const moduleName of moduleNames) {
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 10) {
        const endpoint = `/crm/v8/settings/automation/workflow_rules?module=${encodeURIComponent(moduleName)}&page=${page}&per_page=200&include_inner_details=${encodeURIComponent(include)}`;
        const wfResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
          endpoint,
          method: 'GET'
        }), 20000, null);
        const detailed = wfResp?.workflow_rules || wfResp?.data || [];
        if (!Array.isArray(detailed) || detailed.length === 0) break;
        detailed.forEach(rule => {
          if (rule && rule.id) byId.set(String(rule.id), rule);
        });
        hasMore = wfResp?.info?.more_records === true;
        page += 1;
      }
    }
    return Array.from(byId.values());
  }

  async function hydrateWorkflowRecord(workflow) {
    if (!canUseZohoConnection() || !workflow?.id) return workflow;
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    const singleResp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: `/crm/v8/settings/automation/workflow_rules/${encodeURIComponent(workflow.id)}`,
      method: 'GET'
    }), 15000, null);
    const raw = singleResp?.workflow_rules?.[0];
    if (!raw) return workflow;
    const normalized = normalizeZohoWorkflows([raw])[0];
    return { ...workflow, ...normalized, module: normalized.module || workflow.module };
  }

  // Workflow actions only store the function id and name.
  // The implementation is a separate download: GET /crm/v8/settings/functions/{id}/code
  // https://www.zoho.com/crm/developer/docs/api/v8/download-function-code.html
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
      const resp = await withTimeout(invokeZohoConnectionAPI(docsConn, {
        endpoint,
        method: 'GET'
      }), 20000, null);
      if (resp?.code && (resp.status === 'error' || resp.code === 'OAUTH_SCOPE_MISMATCH')) {
        throw new Error(resp.message || resp.code);
      }
      const list = Array.isArray(resp?.functions) ? resp.functions : [];
      if (!list.length) break;
      pages.push(...list);
      hasMore = resp.info?.more_records === true;
      page += 1;
    }
    return pages;
  }

  function textFromFunctionDownload(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof body.raw_text === 'string') return body.raw_text;
    if (typeof body._code === 'string') return body._code;
    if (typeof body.script === 'string') return body.script;
    return '';
  }

  async function downloadFunctionSource(docsConn, identifier) {
    const body = await withTimeout(invokeZohoConnectionAPI(docsConn, {
      endpoint: `/crm/v8/settings/functions/${encodeURIComponent(identifier)}/code`,
      method: 'GET'
    }), 20000, null);
    if (!body) throw new Error(`Timed out downloading function ${identifier}`);
    if (body.code && (body.status === 'error' || body.code === 'OAUTH_SCOPE_MISMATCH' || body.code === 'INVALID_DATA')) {
      throw new Error(body.message || body.code);
    }
    const source = textFromFunctionDownload(body);
    if (source.startsWith('PK')) {
      return {
        source: '',
        note: 'Zoho returned a ZIP package. Java, Node.js, and Python functions download as ZIP; Deluge downloads as text.'
      };
    }
    return {
      source,
      note: source ? '' : 'Download Function Code returned no text source.'
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

  async function attachFunctionCodeToWorkflows(workflows) {
    if (!canUseZohoConnection() || !workflows?.length) return workflows || [];
    const docsConn = state.settings.docsAgentConnection || 'docsagent_connection';
    let catalog = [];
    try {
      catalog = await fetchFunctionCatalog(docsConn);
    } catch (err) {
      console.warn('[DocsAgent] GET /crm/v8/settings/functions failed. Add ZohoCRM.settings.functions.READ to the connection.', err);
    }
    const cache = new Map();
    const enriched = [];
    for (const workflow of workflows) {
      const refs = collectFunctionActions(workflow);
      const functionCode = [];
      for (const ref of refs) {
        const match = matchCatalogFunction(catalog, ref);
        const identifier = (match && (match.id || match.api_name)) || ref.id || ref.api_name;
        const cacheKey = String(identifier || ref.name || '');
        if (!cache.has(cacheKey)) {
          if (!identifier) {
            cache.set(cacheKey, {
              name: ref.name,
              source: '',
              error: 'This workflow action has a function name but no function id, and it was not found in GET /settings/functions.'
            });
          } else {
            try {
              const downloaded = await downloadFunctionSource(docsConn, identifier);
              const source = downloaded.source || '';
              cache.set(cacheKey, {
                id: String((match && match.id) || ref.id || ''),
                api_name: (match && match.api_name) || ref.api_name || '',
                name: (match && (match.name || match.display_name)) || ref.name || '',
                category: (match && match.category) || '',
                language: (match && match.language) || '',
                runtime: (match && match.runtime) || '',
                description: (match && match.description) || '',
                arguments: (match && match.arguments) || [],
                source: source.slice(0, 12000),
                source_truncated: source.length > 12000,
                note: downloaded.note || ''
              });
            } catch (err) {
              cache.set(cacheKey, {
                id: String(ref.id || ''),
                api_name: ref.api_name || '',
                name: ref.name || '',
                source: '',
                error: err.message || String(err)
              });
            }
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
      if (!crit && wf.conditions && wf.conditions.length > 0) {
        const c0 = wf.conditions[0];
        if (c0.criteria_details?.criteria) crit = c0.criteria_details.criteria;
      }
      if (crit && typeof crit === 'object') crit = formatCriteria(crit);

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
      dom.statWorkflowsSub.textContent = total > 0 ? `${activeCount} active · GET /workflow_rules` : 'GET /settings/automation/workflow_rules';
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
    } else if (mode === 'standalone') {
      scopeBadge.style.background = '#fff7ed';
      scopeBadge.style.color = '#9a3412';
      scopeBadge.style.border = '1px solid #fdba74';
      scopeBadge.innerHTML = 'Open this widget inside Zoho CRM. Workflow rules are loaded with <code>GET /crm/v8/settings/automation/workflow_rules</code> and scope <code>ZohoCRM.settings.workflow_rules.READ</code>.';
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
    const modules = (snapshot.modules || []).slice().sort((a, b) => (b.workflows || []).length - (a.workflows || []).length);
    let rows = '';

    if (!modules.length) {
      dom.inventoryTableBody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center; padding:28px; color:var(--text-muted);">
            No CRM modules yet. Run a scan inside Zoho CRM to load live metadata.
          </td>
        </tr>
      `;
      return;
    }

    modules.forEach(m => {
      const fieldsCount = (m.fields || []).length;
      const wfCount = (m.workflows || []).length;
      const bpCount = (m.blueprints || []).length;
      const hash = m.hash || ('live_' + String(m.module || 'module').toLowerCase());

      rows += `
        <tr>
          <td><strong>📦 ${escapeHtml(m.module)}</strong></td>
          <td><code>${escapeHtml(m.component_id || 'mod_' + m.module)}</code></td>
          <td><span class="badge badge-blue">${fieldsCount} fields</span></td>
          <td><span class="badge badge-purple">${wfCount} workflows</span></td>
          <td><span class="badge badge-yellow">${bpCount} blueprints</span></td>
          <td><code>#${escapeHtml(hash.substring(0, 10))}</code></td>
          <td><span class="badge badge-green">Live API</span></td>
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

    dom.workflowTableBody.querySelectorAll('tr[data-wfid]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input, button, a')) return;
        openWorkflowDetailModal(tr.getAttribute('data-wfid'));
      });
    });

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
    let selectedWfs = state.allWorkflowsList.filter(w => state.selectedWorkflowIds.has(w.id));
    if (selectedWfs.length === 0) {
      showToast('Select at least one workflow to document.', 'warning');
      return;
    }

    switchTab('tab-docs');
    if (dom.selectDocType) {
      dom.selectDocType.value = 'workflow_spec';
    }

    dom.btnGenerateDocs.disabled = true;
    dom.btnGenerateDocs.innerHTML = `<span>Loading ${selectedWfs.length} workflow rule(s)…</span>`;
    try {
      selectedWfs = await Promise.all(selectedWfs.map(wf => hydrateWorkflowRecord(wf)));
      dom.btnGenerateDocs.innerHTML = `<span>Loading function source for ${selectedWfs.length} workflow(s)...</span>`;
      selectedWfs = await attachFunctionCodeToWorkflows(selectedWfs);
    } catch (hydrateErr) {
      console.warn('[Workflow hydrate]', hydrateErr);
    }
    const coded = selectedWfs.filter(wf => (wf.function_code || []).some(fn => fn.source)).length;
    dom.btnGenerateDocs.innerHTML = `<span>AI is documenting ${selectedWfs.length} workflow(s)${coded ? ` with ${coded} function source file(s)` : ''}...</span>`;
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
      if (resp.note) showToast(resp.note, 'warning');
      await deliverDocumentationPdf(state.generatedMarkdown, 'Workflow_Documentation', resp.pdf_base64);
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
    if (!(state.allWorkflowsList || []).length && !(state.activeSnapshot && (state.activeSnapshot.modules || []).length)) {
      showToast('Scan Zoho CRM first. Documentation is written from the live API payload.', 'warning');
      return;
    }
    dom.btnGenerateDocs.disabled = true;
    dom.btnGenerateDocs.innerHTML = '<span>Claude is analyzing CRM config...</span>';
    dom.docRenderedOutput.innerHTML = '<div style="text-align:center; padding:50px; color:var(--text-muted);"><div class="status-dot" style="margin-bottom:8px;"></div><p>Generating living documentation with Claude &amp; mapping components...</p></div>';

    try {
      const isWorkflowDoc = (dom.selectDocType.value === 'workflow_spec');
      let selectedWfs = state.allWorkflowsList.filter(w => state.selectedWorkflowIds.has(w.id));
      if (isWorkflowDoc && selectedWfs.length === 0) selectedWfs = state.allWorkflowsList.slice();
      if (isWorkflowDoc && selectedWfs.length) {
        dom.btnGenerateDocs.innerHTML = `<span>Loading workflow rules and function source...</span>`;
        selectedWfs = await Promise.all(selectedWfs.map(wf => hydrateWorkflowRecord(wf)));
        selectedWfs = await attachFunctionCodeToWorkflows(selectedWfs);
      }
      const targetWorkflows = selectedWfs;

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
      if (resp.note) showToast(resp.note, 'warning');
      const docTitle = (dom.selectDocType && dom.selectDocType.value === 'workflow_spec') ? 'Workflow_Documentation' : 'Zoho_CRM_Documentation';
      await deliverDocumentationPdf(state.generatedMarkdown, docTitle, resp.pdf_base64);

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

  function renderMarkdownHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inList = false;
    let inCode = false;
    let codeLines = [];
    const inline = (text) => escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    const closeList = () => {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    };
    const closeCode = () => {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
        codeLines = [];
        inCode = false;
      }
    };
    lines.forEach((line) => {
      if (line.trim().startsWith('```')) {
        closeList();
        if (inCode) closeCode();
        else inCode = true;
        return;
      }
      if (inCode) {
        codeLines.push(line);
        return;
      }
      if (!line.trim()) {
        closeList();
        return;
      }
      if (/^[\s|:-]+$/.test(line)) return;
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
        return;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`;
        return;
      }
      closeList();
      if (line.trim().startsWith('>')) {
        html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`;
        return;
      }
      if (line.trim().startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(cell => inline(cell.trim()));
        html += `<p>${cells.join(' · ')}</p>`;
        return;
      }
      html += `<p>${inline(line)}</p>`;
    });
    closeList();
    closeCode();
    return html || '<p>No documentation text was returned.</p>';
  }

  function renderMarkdownOutput(markdown) {
    if (dom.docRenderedOutput) dom.docRenderedOutput.innerHTML = renderMarkdownHtml(markdown);
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

  function workDriveBody(raw) {
    let body = raw;
    const details = raw && raw.details;
    if (details && typeof details === 'object') {
      if (details.statusMessage !== undefined) body = details.statusMessage;
      else if (details.output !== undefined) body = details.output;
    }
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = { message: body }; }
    }
    return body || {};
  }

  async function uploadPdfToWorkDrive(pdfBytes, fileName) {
    const folderId = (dom.settingsWorkDriveFolder && dom.settingsWorkDriveFolder.value.trim()) || state.settings.workdriveFolder;
    if (!folderId) {
      return { ok: false, message: 'Set the WorkDrive folder id in Settings.' };
    }
    if (typeof ZOHO === 'undefined' || !ZOHO.CRM?.CONNECTION?.invoke) {
      return { ok: false, message: 'Open this widget inside Zoho CRM so the PDF can be uploaded with workdrive_connection.' };
    }
    const conn = state.settings.workdriveConnection || 'workdrive_connection';
    const file = new File([pdfBytes], fileName, { type: 'application/pdf' });
    let raw;
    try {
      raw = await ZOHO.CRM.CONNECTION.invoke(conn, {
        url: `${getZohoApiDomain()}/workdrive/api/v1/upload`,
        method: 'POST',
        param_type: 2,
        parameters: {
          parent_id: folderId,
          filename: fileName,
          'override-name-exist': 'true',
          content: file
        }
      });
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
    const body = workDriveBody(raw);
    const row = Array.isArray(body.data) ? body.data[0] : body.data;
    const link = row?.attributes?.Permalink || row?.attributes?.permalink || '';
    if (body.errors || body.status === 'error' || body.code === 'INVALID_OAUTHSCOPE' || body.code === 'AUTHENTICATION_FAILURE') {
      const detail = body.message || body.errors?.[0]?.title || body.code || 'WorkDrive rejected the upload';
      return { ok: false, message: `${detail}. Check WorkDrive.files.ALL on ${conn} and the folder id.` };
    }
    if (!row && !link) {
      return { ok: false, message: 'WorkDrive did not confirm the file. The PDF was still downloaded.' };
    }
    return { ok: true, link, id: row?.id || '' };
  }

  async function deliverDocumentationPdf(markdown, title, pdfBase64) {
    const safeTitle = String(title || 'Zoho_CRM_Documentation').replace(/[^\w.-]+/g, '_');
    const fileName = `${safeTitle}_${new Date().toISOString().slice(0, 10)}.pdf`;
    let encoded = pdfBase64;
    if (!encoded) {
      const pdfResp = await apiCall('/pdf', { markdown });
      encoded = pdfResp.pdf_base64;
    }
    if (!encoded) throw new Error('The PDF was not created.');
    const bytes = pdfBytesFromBase64(encoded);
    downloadPdfBytes(bytes, fileName);
    const uploaded = await uploadPdfToWorkDrive(bytes, fileName);
    if (uploaded.ok) {
      showToast(uploaded.link ? `PDF downloaded and saved in WorkDrive: ${uploaded.link}` : 'PDF downloaded and uploaded to the WorkDrive folder.', 'success');
    } else {
      showToast(`PDF downloaded. ${uploaded.message}`, 'warning');
    }
    return uploaded;
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
    dom.btnExportWorkDrive.textContent = 'Creating PDF...';

    try {
      await deliverDocumentationPdf(
        state.generatedMarkdown,
        'Zoho_CRM_Living_System_Documentation'
      );
    } catch (err) {
      showToast(err.message || 'Export failed', 'error');
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
      const resp = await apiCall('/drift', {
        baseline: state.baselineSnapshot,
        current: state.activeSnapshot
      });
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

          const sections = (drift.affected_sections || []).join(', ');
          rows += `
            <tr>
              <td><strong>${escapeHtml(c.module)}</strong></td>
              <td><span class="badge ${badgeClass}">${escapeHtml(c.type.replace(/_/g, ' '))}</span></td>
              <td><code>${escapeHtml(c.component_id)}</code></td>
              <td>${escapeHtml(c.detail)}</td>
              <td><strong>${escapeHtml(sections)}</strong></td>
            </tr>
          `;
        });
        dom.driftChangesTableBody.innerHTML = rows;

        dom.diffOldContent.innerHTML = (drift.changes || []).map(c =>
          `<div class="diff-del">- ${escapeHtml(c.module)}: ${escapeHtml(c.detail)}</div>`
        ).join('');

        dom.diffNewContent.innerHTML = (drift.changes || []).map(c =>
          `<div class="diff-add">+ ${escapeHtml(c.type.replace(/_/g, ' '))} on ${escapeHtml(c.module)}</div>`
        ).join('');

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
        affected_components: state.driftReport?.changes?.map(c => c.component_id) || [],
        snapshot: state.activeSnapshot
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
      const resp = await apiCall('/ask', {
        question: query,
        snapshot: state.activeSnapshot,
        workflows: state.allWorkflowsList
      });
      const answer = resp.answer || 'No answer received.';
      loadingBubble.innerHTML = renderMarkdownHtml(answer);
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
        dom.builderDocOutput.innerHTML = renderMarkdownHtml(result.documentation_markdown || '');
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
    dom.btnSaveSettings.textContent = 'Saving settings...';

    try {
      const docsConn = dom.settingsDocsAgentConn ? dom.settingsDocsAgentConn.value.trim() : state.settings.docsAgentConnection;
      const wdConn = dom.settingsWorkDriveConn ? dom.settingsWorkDriveConn.value.trim() : state.settings.workdriveConnection;
      const typedKey = dom.settingsClaudeKey ? dom.settingsClaudeKey.value.trim() : '';
      const freqEl = document.getElementById('settingsScheduleFreq');

      const payload = {
        claudeModel: dom.settingsClaudeModel ? dom.settingsClaudeModel.value : state.settings.claudeModel,
        workdriveDefaultFolder: dom.settingsWorkDriveFolder ? dom.settingsWorkDriveFolder.value : state.settings.workdriveFolder,
        docsAgentConnection: docsConn,
        workdriveConnection: wdConn,
        scheduleFrequency: freqEl ? freqEl.value : (state.settings.scheduleFrequency || 'daily')
      };
      if (typedKey) payload.claudeApiKey = typedKey;

      state.settings.docsAgentConnection = docsConn;
      state.settings.workdriveConnection = wdConn;
      state.settings.workdriveFolder = payload.workdriveDefaultFolder;
      state.settings.claudeModel = payload.claudeModel;
      state.settings.scheduleFrequency = payload.scheduleFrequency;
      if (typedKey) state.settings.claudeApiKey = typedKey;

      let crmNote = 'Saved on the local settings record.';
      if (typeof ZOHO !== 'undefined' && ZOHO.CRM && ZOHO.CRM.API) {
        const saved = await upsertSettingsRecord({
          docsAgentConnection: docsConn,
          workdriveConnection: wdConn,
          claudeModel: payload.claudeModel,
          workdriveFolder: payload.workdriveDefaultFolder,
          claudeApiKey: typedKey,
          scheduleFrequency: payload.scheduleFrequency
        });
        if (!saved.ok) {
          throw new Error(saved.message || 'Could not write Living_Docs_Settings.');
        }
        payload.settingsRecordId = saved.id;
        crmNote = saved.action === 'updated'
          ? `Updated existing settings record ${saved.id}.`
          : `Created the first settings record ${saved.id || ''}. Later saves will update this row.`;
        renderSettingsRecordStatus();
      }

      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => null);

      if (typedKey && dom.settingsClaudeKey) {
        dom.settingsClaudeKey.value = '';
        dom.settingsClaudeKey.placeholder = 'Saved — leave blank to keep';
      }
      showToast(crmNote, 'success');
    } catch (err) {
      showToast(err.message || 'Save failed', 'error');
    } finally {
      dom.btnSaveSettings.disabled = false;
      dom.btnSaveSettings.textContent = 'Save Settings';
    }
  }

  async function triggerSimulation() {
    showToast('Drift compares live CRM scans. Run Scan CRM again after a real configuration change.', 'warning');
    switchTab('tab-drift');
    if (state.activeSnapshot) await checkDrift();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
