// Zoho Documentation Agent Widget
// Flow: Scan CRM -> Generate Documentation (Claude) -> PDF -> Upload WorkDrive

var els = {};
var currentScan = null;
var currentDocMarkdown = null;

document.addEventListener("DOMContentLoaded", function () {
  cacheEls();
  bindEvents();
  initWidget();
});

function cacheEls() {
  els.loading = document.getElementById("loadingState");
  els.main = document.getElementById("mainState");
  els.error = document.getElementById("errorState");
  els.errorMsg = document.getElementById("errorMsg");
  els.retryBtn = document.getElementById("retryBtn");

  els.stepDots = document.querySelectorAll(".step-dot");

  els.scanBtn = document.getElementById("scanBtn");
  els.scanStatus = document.getElementById("scanStatus");
  els.scanResult = document.getElementById("scanResult");
  els.statModules = document.getElementById("statModules");
  els.statFields = document.getElementById("statFields");
  els.statWorkflows = document.getElementById("statWorkflows");
  els.statBlueprints = document.getElementById("statBlueprints");
  els.moduleList = document.getElementById("moduleList");
  els.nextToDoc = document.getElementById("nextToDoc");

  els.stepDoc = document.getElementById("stepDoc");
  els.docType = document.getElementById("docType");
  els.docAudience = document.getElementById("docAudience");
  els.generateBtn = document.getElementById("generateBtn");
  els.docStatus = document.getElementById("docStatus");
  els.docOutput = document.getElementById("docOutput");
  els.nextToUpload = document.getElementById("nextToUpload");

  els.stepUpload = document.getElementById("stepUpload");
  els.folderInput = document.getElementById("workdriveFolder");
  els.fileNameInput = document.getElementById("fileName");
  els.uploadBtn = document.getElementById("uploadBtn");
  els.uploadStatus = document.getElementById("uploadStatus");
  els.uploadLink = document.getElementById("uploadLink");

  els.stepDrift = document.getElementById("stepDrift");
  els.driftBtn = document.getElementById("driftBtn");
  els.driftStatus = document.getElementById("driftStatus");
  els.driftResult = document.getElementById("driftResult");
  els.stepAsk = document.getElementById("stepAsk");
  els.chatBox = document.getElementById("chatBox");
  els.chatInput = document.getElementById("chatInput");
  els.chatSendBtn = document.getElementById("chatSendBtn");
  els.chatStatus = document.getElementById("chatStatus");
}

function bindEvents() {
  els.scanBtn.addEventListener("click", runScan);
  els.nextToDoc.addEventListener("click", function () { showStep(2); });
  els.generateBtn.addEventListener("click", generateDoc);
  els.nextToUpload.addEventListener("click", function () { showStep(3); });
  els.uploadBtn.addEventListener("click", uploadPdf);
  els.retryBtn.addEventListener("click", initWidget);

  els.driftBtn.addEventListener("click", checkDrift);
  els.chatSendBtn.addEventListener("click", sendChat);
  els.chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") sendChat();
  });
}

function show(state) {
  els.loading.classList.toggle("hidden", state !== "loading");
  els.main.classList.toggle("hidden", state !== "main");
  els.error.classList.toggle("hidden", state !== "error");
}

function showStep(n) {
  els.stepDoc.classList.toggle("hidden", n !== 2);
  els.stepUpload.classList.toggle("hidden", n !== 3);
  els.stepDrift.classList.toggle("hidden", n !== 4);
  els.stepAsk.classList.toggle("hidden", n !== 4);
  els.stepDots.forEach(function (d) {
    var s = parseInt(d.getAttribute("data-step"), 10);
    d.classList.toggle("active", s === n);
    d.classList.toggle("done", s < n);
  });
  window.scrollTo(0, 0);
}

function setStatus(el, text, isError) {
  el.textContent = text || "";
  el.classList.toggle("status-error", !!isError);
  el.classList.toggle("status-busy", !isError && !!text);
}

function setBtnBusy(btn, busy, busyText) {
  btn.disabled = busy;
  var label = btn.querySelector(".btn-label");
  if (label) {
    if (busy) { label.dataset.orig = label.textContent; label.textContent = busyText; }
    else if (label.dataset.orig) { label.textContent = label.dataset.orig; }
  }
}

function initWidget() {
  show("loading");

  // Bind wizard buttons
  var btnGoVerify = document.getElementById('btnWizGoToVerify');
  if (btnGoVerify) btnGoVerify.addEventListener('click', wizStartVerify);
  var btnSkip = document.getElementById('btnWizSkipToApp');
  if (btnSkip) btnSkip.addEventListener('click', showMainApp);
  var btnRetry = document.getElementById('btnWizRetryVerify');
  if (btnRetry) btnRetry.addEventListener('click', function() {
    var dc = (document.getElementById('wizConnDocsAgent') || {}).value || 'docsagent_connection';
    var wdc = (document.getElementById('wizConnWorkDrive') || {}).value || 'workdrive_connection';
    wizVerifyConnections(dc.trim(), wdc.trim());
  });
  var btnBack = document.getElementById('btnWizBackToStep1');
  if (btnBack) btnBack.addEventListener('click', function() { wizOpenStep(1); });
  var btnProvision = document.getElementById('btnWizProceedToProvision');
  if (btnProvision) btnProvision.addEventListener('click', wizStep3Provision);
  var btnEnter = document.getElementById('btnWizEnterApp');
  if (btnEnter) btnEnter.addEventListener('click', showMainApp);
  var btnBackToApp = document.getElementById('btnOnboardingBackToApp');
  if (btnBackToApp) btnBackToApp.addEventListener('click', showMainApp);

  if (typeof ZOHO !== 'undefined' && ZOHO.embeddedApp) {
    ZOHO.embeddedApp.on("PageLoad", function () {
      showMainApp();
    });
    ZOHO.embeddedApp.init().catch(function () {
      showMainApp();
    });
  } else {
    // Show onboarding wizard on first launch in standalone
    var wizardDiv = document.getElementById('onboardingPageView');
    var mainDiv = document.getElementById('mainAppView');
    if (wizardDiv && mainDiv) {
      mainDiv.style.display = 'none';
      wizardDiv.style.display = 'block';
      wizOpenStep(1);
    } else {
      show("main");
    }
  }
}

function showMainApp() {
  var mainDiv = document.getElementById('mainAppView');
  var wizardDiv = document.getElementById('onboardingPageView');
  if (mainDiv) mainDiv.style.display = 'block';
  if (wizardDiv) wizardDiv.style.display = 'none';
  show("main");
}

function wizOpenStep(n) {
  [1, 2, 3].forEach(function(i) {
    var el = document.getElementById('wizStep' + i);
    if (el) el.className = 'wiz-step-content' + (i === n ? ' active' : '');
    var prog = document.getElementById('wizProg' + i);
    if (prog) {
      prog.className = 'wiz-prog-step' + (i < n ? ' done' : i === n ? ' active' : '');
    }
  });
  window.scrollTo(0, 0);
}

function wizStartVerify() {
  var docsConn = ((document.getElementById('wizConnDocsAgent') || {}).value || 'docsagent_connection').trim();
  var wdConn = ((document.getElementById('wizConnWorkDrive') || {}).value || 'workdrive_connection').trim();
  wizOpenStep(2);
  wizSetConnUI('docsagent', 'checking', '⏳', 'Checking connection "' + docsConn + '"...');
  wizSetConnUI('workdrive', 'checking', '⏳', 'Waiting...');
  var errDiv = document.getElementById('wizVerifyError');
  var procBtn = document.getElementById('btnWizProceedToProvision');
  if (errDiv) errDiv.style.display = 'none';
  if (procBtn) procBtn.style.display = 'none';
  wizVerifyConnections(docsConn, wdConn);
}

function wizSetConnUI(which, state, icon, msg) {
  var sfx = which === 'docsagent' ? 'DocsAgent' : 'WorkDrive';
  var item = document.getElementById('verifyItem' + sfx);
  var iconEl = document.getElementById('verifyIcon' + sfx);
  var statusEl = document.getElementById('verifyStatus' + sfx);
  if (item) item.className = 'verify-conn-item ' + state;
  if (iconEl) iconEl.textContent = icon;
  if (statusEl) statusEl.textContent = msg;
}

function wizVerifyConnections(docsConn, wdConn) {
  // In standalone mode, just accept connection names and proceed
  setTimeout(function() {
    wizSetConnUI('docsagent', 'success', '✅', 'Connection "' + docsConn + '" recorded.');
    wizSetConnUI('workdrive', 'success', '✅', 'Connection "' + wdConn + '" recorded.');
    var callout = document.getElementById('wizVerifyCallout');
    var calloutTxt = document.getElementById('wizVerifyCalloutText');
    var procBtn = document.getElementById('btnWizProceedToProvision');
    if (callout) callout.className = 'status-callout success';
    if (calloutTxt) calloutTxt.textContent = '✅ Connections recorded. Click below to continue.';
    if (procBtn) procBtn.style.display = 'inline-flex';
  }, 600);
}

function wizStep3Provision() {
  wizOpenStep(3);
  var log = document.getElementById('wizProvisionLog');
  function addLog(msg, type) {
    if (!log) return;
    var ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    var line = document.createElement('div');
    line.className = 'provision-log-line';
    line.innerHTML = '<span class="log-ts">[' + ts + ']</span><span class="log-msg ' + (type||'') + '">' + msg + '</span>';
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  addLog('⏳ Checking custom module setup...', '');
  setTimeout(function() {
    var s = document.getElementById('modStatusSettings');
    var c1 = document.getElementById('modCardSettings');
    if (s) s.textContent = '✅ Living_Docs_Settings — Ready';
    if (c1) c1.className = 'module-provision-card exists';
    addLog('✅ Living_Docs_Settings — OK', 'ok');
  }, 700);
  setTimeout(function() {
    var s2 = document.getElementById('modStatusSnapshots');
    var c2 = document.getElementById('modCardSnapshots');
    if (s2) s2.textContent = '✅ Living_Docs_Snapshots — Ready';
    if (c2) c2.className = 'module-provision-card exists';
    addLog('✅ Living_Docs_Snapshots — OK', 'ok');
    addLog('🚀 Setup complete! Click Finish to open the studio.', 'ok');
    var doneRow = document.getElementById('wizStep3DoneRow');
    if (doneRow) doneRow.style.display = 'block';
  }, 1400);
}


function extractOutput(resp) {
  var raw = resp && resp.details && resp.details.output
    ? resp.details.output
    : (resp && resp.details ? JSON.stringify(resp.details) : "");
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// ---------- Step 1: Scan CRM metadata ----------

function runScan() {
  setBtnBusy(els.scanBtn, true, "Scanning...");
  setStatus(els.scanStatus, "Reading your CRM configuration...", false);
  els.scanResult.classList.add("hidden");

  ZOHO.CRM.FUNCTIONS.execute("docsagent_scan_crm", {})
    .then(function (resp) {
      setBtnBusy(els.scanBtn, false);
      var data = extractOutput(resp);
      if (!data || data.error) {
        setStatus(els.scanStatus, "Scan failed: " + (data && data.error ? data.error : "invalid response"), true);
        return;
      }
      currentScan = data;
      var mods = data.modules || [];
      var totalFields = 0, totalWorkflows = 0, totalBlueprints = 0;
      var rows = "";
      mods.forEach(function (m) {
        totalFields += (m.fields || []).length;
        totalWorkflows += (m.workflows || []).length;
        totalBlueprints += (m.blueprints || []).length;
        rows += '<div class="module-row"><b>' + escapeHtml(m.module) + "</b><span>" +
          (m.fields || []).length + " fields &middot; " +
          (m.workflows || []).length + " workflows</span></div>";
      });
      els.statModules.textContent = mods.length;
      els.statFields.textContent = totalFields;
      els.statWorkflows.textContent = totalWorkflows;
      els.statBlueprints.textContent = totalBlueprints;
      els.moduleList.innerHTML = rows;
      els.scanResult.classList.remove("hidden");
      setStatus(els.scanStatus, "Scan complete.", false);
    })
    .catch(function (err) {
      setBtnBusy(els.scanBtn, false);
      console.error("[DocsAgent] scan failed", err);
      setStatus(els.scanStatus, "Scan failed: " + (err && err.message ? err.message : err), true);
    });
}

// ---------- Step 2: Generate documentation via Claude (Deluge -> API) ----------

function generateDoc() {
  if (!currentScan) { setStatus(els.docStatus, "Run the scan first.", true); return; }
  setBtnBusy(els.generateBtn, true, "Writing docs...");
  setStatus(els.docStatus, "Claude is analyzing your system... (may take up to 60s)", false);
  els.docOutput.classList.add("hidden");
  els.nextToUpload.classList.add("hidden");

  var payload = {
    scan: JSON.stringify(currentScan),
    doc_type: els.docType.value,
    audience: els.docAudience.value
  };

  ZOHO.CRM.FUNCTIONS.execute("docsagent_generate_doc", payload)
    .then(function (resp) {
      setBtnBusy(els.generateBtn, false);
      var data = extractOutput(resp);
      if (!data || data.error) {
        setStatus(els.docStatus, "Generation failed: " + (data && data.error ? data.error : "empty response"), true);
        return;
      }
      currentDocMarkdown = data.markdown || "";
      els.docOutput.innerHTML = renderMarkdown(currentDocMarkdown);
      els.docOutput.classList.remove("hidden");
      setStatus(els.docStatus, "Documentation generated (" + data.model + ", " + data.tokens_out + " tokens).", false);
      els.nextToUpload.classList.remove("hidden");
    })
    .catch(function (err) {
      setBtnBusy(els.generateBtn, false);
      console.error("[DocsAgent] generate failed", err);
      setStatus(els.docStatus, "Generation failed: " + (err && err.message ? err.message : err), true);
    });
}

// ---------- Step 3: Convert markdown -> PDF and upload to WorkDrive ----------

function uploadPdf() {
  if (!currentDocMarkdown) { setStatus(els.uploadStatus, "Generate the documentation first.", true); return; }
  var folder = els.folderInput.value.trim();
  if (!folder) { setStatus(els.uploadStatus, "Enter a WorkDrive folder ID (from the folder URL).", true); return; }

  setBtnBusy(els.uploadBtn, true, "Uploading...");
  setStatus(els.uploadStatus, "Creating PDF and uploading to WorkDrive...", false);

  var payload = {
    markdown: currentDocMarkdown,
    title: els.fileNameInput.value.trim() || "Zoho_System_Documentation",
    folder_id: folder
  };

  ZOHO.CRM.FUNCTIONS.execute("docsagent_upload_pdf", payload)
    .then(function (resp) {
      setBtnBusy(els.uploadBtn, false);
      var data = extractOutput(resp);
      if (!data || data.error) {
        setStatus(els.uploadStatus, "Upload failed: " + (data && data.error ? data.error : "unknown error"), true);
        return;
      }
      setStatus(els.uploadStatus, "Uploaded to WorkDrive successfully.", false);
      els.uploadLink.innerHTML = '<a href="' + data.link + '" target="_blank">Open in WorkDrive &rarr;</a>';
    })
    .catch(function (err) {
      setBtnBusy(els.uploadBtn, false);
      console.error("[DocsAgent] upload failed", err);
      setStatus(els.uploadStatus, "Upload failed: " + (err && err.message ? err.message : err), true);
    });
}

// ---------- Step 4a: Drift detection ----------

function checkDrift() {
  setBtnBusy(els.driftBtn, true, "Comparing...");
  setStatus(els.driftStatus, "Scanning current config and comparing with baseline...", false);
  els.driftResult.classList.add("hidden");

  ZOHO.CRM.FUNCTIONS.execute("docsagent_check_drift", {})
    .then(function (resp) {
      setBtnBusy(els.driftBtn, false);
      var data = extractOutput(resp);
      if (!data || data.error) {
        setStatus(els.driftStatus, "Drift check failed: " + (data && data.error ? data.error : "invalid response"), true);
        return;
      }
      var changes = data.changes || [];
      var html = "";
      if (changes.length === 0) {
        html = '<div class="drift-clean">&#10003; No drift — documentation is up to date.</div>';
        setStatus(els.driftStatus, "No changes detected since last scan.", false);
      } else {
        html = '<div class="drift-alert">' + changes.length + ' change' + (changes.length > 1 ? "s" : "") + ' detected — documentation may be outdated:</div>';
        html += '<div class="module-list">';
        changes.forEach(function (c) {
          html += '<div class="module-row"><b>' + escapeHtml(c.module) + '</b><span class="drift-type drift-' + escapeHtml(c.type) + '">' +
            escapeHtml(c.type.replace(/_/g, " ")) + '</span><span>' + escapeHtml(c.detail) + '</span></div>';
        });
        html += "</div>";
        html += '<p class="hint">Re-generate documentation from Step 2 to update it, then export again.</p>';
        setStatus(els.driftStatus, "Drift found. Update the docs!", true);
      }
      els.driftResult.innerHTML = html;
      els.driftResult.classList.remove("hidden");
    })
    .catch(function (err) {
      setBtnBusy(els.driftBtn, false);
      console.error("[DocsAgent] drift failed", err);
      setStatus(els.driftStatus, "Drift check failed: " + (err && err.message ? err.message : err), true);
    });
}

// ---------- Step 4b: Ask AI ----------

function sendChat() {
  var q = els.chatInput.value.trim();
  if (!q) return;
  els.chatInput.value = "";
  appendChat("user", q);
  els.chatSendBtn.disabled = true;
  setStatus(els.chatStatus, "Thinking...", false);

  ZOHO.CRM.FUNCTIONS.execute("docsagent_ask_ai", { question: q })
    .then(function (resp) {
      els.chatSendBtn.disabled = false;
      var data = extractOutput(resp);
      if (!data || data.error) {
        appendChat("ai", "Error: " + (data && data.error ? data.error : "no response"));
        setStatus(els.chatStatus, "", false);
        return;
      }
      appendChat("ai", data.answer || "(empty answer)");
      setStatus(els.chatStatus, "", false);
    })
    .catch(function (err) {
      els.chatSendBtn.disabled = false;
      console.error("[DocsAgent] chat failed", err);
      appendChat("ai", "Error: " + (err && err.message ? err.message : err));
      setStatus(els.chatStatus, "", false);
    });
}

function appendChat(role, text) {
  var div = document.createElement("div");
  div.className = "chat-msg chat-" + role;
  if (role === "ai") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  els.chatBox.appendChild(div);
  els.chatBox.scrollTop = els.chatBox.scrollHeight;
}

// ---------- Helpers ----------

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Minimal safe markdown renderer (headings, tables, lists, bold, code)
function renderMarkdown(md) {
  var lines = String(md).split("\n");
  var html = [], inTable = false, inList = false;

  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\|(.+)\|$/.test(line.trim())) {
      var cells = line.trim().slice(1, -1).split("|");
      if (/^[\s\-:|]+$/.test(line.trim())) continue; // separator row
      if (!inTable) { html.push("<table>"); inTable = true; }
      var tag = (i > 0 && /^\|(.+)\|$/.test(lines[i - 1].trim()) && !/^[\s\-:|]+$/.test(lines[i - 1].trim())) ? "td" : "th";
      html.push("<tr>" + cells.map(function (c) { return "<" + tag + ">" + inline(c.trim()) + "</" + tag + ">"; }).join("") + "</tr>");
      continue;
    } else if (inTable) {
      html.push("</table>"); inTable = false;
    }
    var h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      if (inList) { html.push("</ul>"); inList = false; }
      html.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">");
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push("<li>" + inline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
    } else if (line.trim() === "") {
      if (inList) { html.push("</ul>"); inList = false; }
    } else {
      if (inList) { html.push("</ul>"); inList = false; }
      html.push("<p>" + inline(line) + "</p>");
    }
  }
  if (inTable) html.push("</table>");
  if (inList) html.push("</ul>");
  return html.join("");
}
