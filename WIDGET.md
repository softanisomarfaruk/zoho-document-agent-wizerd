# Living Docs for Zoho CRM

Zoho CRM widget that reads workflow rules and custom functions, writes documentation with AI, and saves a PDF on a `Living_Docs_Documents` record.

- Runs inside Zoho CRM. Live CRM data is only available there.
- AI providers are Claude and Cursor. There is no local AI fallback.
- Secrets, record IDs, org IDs, tokens, and credentials are masked in the browser before any prompt is sent. The gateway function masks credentials again inside CRM.
- AI API keys never reach the browser. They are stored AES-encrypted in a CRM Org Variable, and prompts go to the provider through a Deluge function (see **AI key security**).

## Full flow

Open the widget from inside Zoho CRM (a web tab or a record). The page shows a loading skeleton, then runs the setup check. CRM calls go through the connection `docsagent_connection`. There is no separate WorkDrive upload.

### 0. Setup check

Five checks run on every launch:

1. **Zoho CRM connection** — `GET /crm/v8/settings/modules` with `docsagent_connection`.
2. **Saved settings** — a `Living_Docs_Settings` record (connection name, provider, model, API URL, Claude workspace ID, audience). This record holds no API keys.
3. **Documentation modules** — `Living_Docs_Settings` and `Living_Docs_Documents`.
4. **AI functions and encrypted key store** — `livingdocs_save_api_key`, `livingdocs_llm_gateway`, and the Org Variable `livingdocs_llm_key`.
5. **AI provider** — Claude or Cursor, with a key already stored encrypted in CRM.

If every check passes, the checklist is skipped and the widget opens **Overview** and scans CRM. The checklist is shown only when something is missing, or when **Run setup check** is used from Settings.

When something is missing, setup has two tabs:

1. **Connection** — the link name `docsagent_connection` and the scopes to add, with copy buttons.
2. **AI provider** — Claude or Cursor, display name, model, API URL, API key, and an optional Claude workspace ID. **Test connection** checks the key. Leave the key blank to keep the one already stored.

**Next** moves from Connection to AI provider. **Submit** then:

1. Creates the two custom modules if they are missing.
2. Installs the Org Variable and the two AI functions. If Zoho refuses, the installation log shows the scripts to paste.
3. Stores the typed API key encrypted. Plain-text keys left on an older settings record are moved and those fields are emptied.
4. Creates or updates the `Living_Docs_Settings` record.
5. Runs the check again. **Continue** enters the five steps.

### 1. Overview

Scans modules, workflow rules, and custom functions.

- Four counts: modules, workflow rules, custom functions, active rules. Each count shows the change against the last scan on this browser.
- A table of rules by module: rule count, active count, how many call a function, and the last documented version (with **Open in CRM** when a master document or a workflow document exists).
- Click a module row to open **Select workflows** filtered to that module.
- **Rescan** in the top bar loads CRM again.
- **Select workflows** goes to step 2.

### 2. Select workflows

Pick **up to 3** rules. Each selected rule becomes its own document. They are written in parallel, not merged into one file.

- Search by name, criteria, or action.
- Filter by module, status (active or inactive), and “only rules that call a function”.
- Select all visible rows (still capped at 3), or clear the selection.
- Each row shows whether that rule is already documented, the version, and a link to the CRM record.
- **Review selected** goes to step 3. Changing the selection after a review drops back to this step.

**Module document** (separate path): filter to one module. **Generate &lt;module&gt; document** appears and documents every rule of that module. See **Module document** below. It does not use the 3-rule selection.

### 3. Review criteria and code

Loads the full rule and the function source for each selected workflow, then builds the prompt.

- One tab per selected rule.
- **Details** opens the rule:
  - Summary of module, trigger, status, conditions, actions, and functions.
  - Flowchart from top to bottom: Start, each condition, Yes and No, actions, then Done or the next condition.
  - Criteria text and the actions on each branch (function, field update, email, or other).
- Each function has four tabs:
  - **Checks** — Deluge lint with errors, warnings, and info on the code.
  - **Sent to AI** — the masked code that will be sent. Select text and choose **Mask as secret** to hide more. Record IDs, org IDs, tokens, and credentials stay masked.
  - **Improve and apply** — asks the AI for a better version, shows it next to the current code, then **Apply as main function** writes it back through `livingdocs_update_function`.
  - **Versions** — earlier copies of the function kept by the widget. Zoho also keeps its own Deluge revision history.
- If the function source changed since the last saved document, the review says so.
- **Prompt** is collapsed under the review. It has two boxes: instructions, and the rule, criteria, and masked code. Edit either box, **Reset prompt**, or **Copy prompt**.
- **Generate documentation** goes to step 4. The prompt for every selected rule must be non-empty, and an AI provider must be configured.

The prompt uses the saved audience (CRM administrator, developer, or business owner; default administrator) and document detail (quick or detailed; default quick). Those two controls are not shown in Settings right now; the saved values still apply.

### 4. Document

Writes one markdown document per selected rule, up to 3 at a time. As each reply finishes, that document is turned into a PDF and saved to CRM on its own. Saving of several documents happens one after another, because the PDF renderer uses one hidden sheet.

- Tabs switch between the rules in this run.
- **Document** shows the markdown. **Details** shows the same rule view as step 3.
- The text fills in on screen as each piece of the reply arrives.
- **Copy text**, **Download .md**, and **Download PDF** work per rule once that rule’s document exists.
- A failed rule can be retried from this step.
- The footer button follows the save:
  - **Save to CRM** while a written document is not in CRM yet.
  - **Saving to CRM…** while a PDF is being attached.
  - **View saved records** when every written document saved.
  - **Save to CRM again** when a save failed.

### 5. View saved records

Shows one block per rule in the run: workflow name, file name, who generated it, and whether the CRM write succeeded.

For each rule the widget writes **one** `Living_Docs_Documents` record (`Item_Type` = Workflow), named after the workflow:

- The first save **creates** version 1 and attaches the PDF.
- A later save **updates** that same record to the next version (v2, v3, …) and attaches the new PDF. Older PDFs stay on the record.
- The record stores the masked function source (`Source_Snapshot`), a hash of the source, the related function hashes, who generated it, and when.
- Each row shows Created or Updated, whether the PDF attached, and **Open in CRM**.
- If a save fails, **Try again** or **Download PDF**.
- **Document other workflows** clears the selection and returns to step 2. **Back to document** returns to step 4.

### Module document

From step 2, with one module filtered:

1. Every workflow rule of that module is loaded with its function code.
2. Each rule gets its own AI call, 3 at a time. A function used by several rules is sent with its source only on the first rule; later rules refer back to that section.
3. The written sections are combined into **one PDF**.
4. That PDF is saved on a single `Living_Docs_Documents` record named `<Module>_Master_Document` (`Item_Id` = `module:<api name>`). Later runs update that record and attach the next version.
5. If every rule was written, the save starts on its own. If some failed, retry those rules or save the master document without them.
6. Step 5 shows that one master record. The footer button is **Save module document**, then **View saved record**.

## What you need in Zoho

- Connection link name `docsagent_connection` with the scopes listed on the setup screen (also listed below).
- Custom modules `Living_Docs_Settings` and `Living_Docs_Documents`, created by **Submit** or already present.
- An AI provider saved in Settings, with a working API key stored through setup.
- The Org Variable `livingdocs_llm_key` (Multi Line) and the standalone functions `livingdocs_save_api_key` and `livingdocs_llm_gateway`, each with one String argument `payload` and REST API (OAuth 2.0) turned on. Submit creates them; if Zoho refuses, setup shows the scripts to paste.
- On `Living_Docs_Documents`, attachments must be allowed, or the PDF cannot be attached.
- For **Apply as main function**, the standalone function `livingdocs_update_function` must exist, its argument must be named `payload`, and REST API with OAuth 2.0 must be turned on for that function.

## AI key security

```
Widget ──FUNCTIONS.execute──► livingdocs_save_api_key   (CRM Administrator only)
  │   key sent once, not kept           └─► Org Variable livingdocs_llm_key  (AES-encrypted map: anthropic, cursor)
  │
  └──FUNCTIONS.execute──► livingdocs_llm_gateway
         decrypt in CRM → api.anthropic.com / api.cursor.com → answer back to the widget
```

- Both functions contain the same random 40-character secret. Setup generates it in the browser when it writes the functions and keeps it nowhere else. Each function returns a short tag derived from the secret, so setup can tell whether the two still match. If they don't match, Submit writes both again with a new secret, and the keys have to be saved again.
- Provider hosts are fixed inside the gateway. Changing `AI API URL` in settings cannot send the key anywhere else. Batch and agent IDs are checked by format, and the batch results URL is built in Deluge, not taken from the reply.
- Claude is called directly, in pieces. Each gateway call is sized from the speed measured so far so it finishes inside Zoho's invokeurl time limit. When Claude stops at `max_tokens`, the widget sends the text so far and Claude continues from there. If Zoho cuts a call off, the next piece is smaller. The document fills in on screen as each piece arrives. Cursor runs as a cloud agent that the widget polls every 3 seconds.
- No input or output length limit for now: the whole function source is sent, and Claude writes until it is done (safety stop at 64,000 tokens).
- Daily limit per user: off for now (`DAILY_LIMIT = 0` in `app/js/ai-functions.js`). Set a number to turn it on. The counter is the `livingdocs_usage` row on `Living_Docs_Settings` (`Usage_JSON`).
- Logs contain the action, provider, HTTP status, and time. They never contain prompts, replies, or keys.
- Restrict `Living_Docs_Settings` to the Administrator profile. Only admins and developers can see function code, and that code is where the secret lives.

## Connection scopes (`docsagent_connection`)

```
ZohoCRM.modules.ALL
ZohoCRM.settings.READ
ZohoCRM.settings.modules.ALL
ZohoCRM.settings.modules.READ
ZohoCRM.settings.ALL
ZohoCRM.org.READ
ZohoCRM.settings.workflow_rules.ALL
ZohoCRM.settings.workflow_rules.READ
ZohoCRM.settings.functions.ALL
ZohoCRM.functions.execute.READ
ZohoCRM.functions.execute.CREATE
ZohoCRM.settings.variables.ALL
ZohoCRM.users.READ
```
