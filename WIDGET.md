# Living Docs for Zoho CRM

- Zoho CRM widget that reads workflow rules and custom functions, writes documentation with AI, and saves a PDF on a CRM record.
- Runs inside Zoho CRM. Live CRM data is only available there.
- AI providers are Claude and Cursor. There is no local AI fallback.
- Secrets, record IDs, org IDs, tokens, and credentials are masked in the browser before any prompt is sent. The server checks the prompt again.

## Features

### Setup

- Checks that the widget is open inside Zoho CRM, that settings exist, that the custom modules are installed, and that an AI provider is configured.
- Shows the CRM connection name `docsagent_connection` and the scopes to add, with copy buttons.
- Installs the custom modules if they are missing:
  - `Living_Docs_Settings`
  - `Living_Docs_Snapshots`
  - `Living_Docs_Documents`
  - `Living_Docs_Changes`
- Settings cover the CRM connection, AI provider, model, API URL, encrypted API key, and the audience (CRM administrator, developer, or business owner).
- The API key is stored encrypted on the documentation server. It is not saved in CRM and is not shown again.

### Overview

- Scans modules, workflow rules, and custom functions through the CRM connection.
- Shows counts for modules, workflow rules, custom functions, and active rules.
- Lists rules by module, with active count, how many call a function, last documented version, and how many changes are logged.
- Reload scans CRM again.

### Select workflows

- Pick one rule or several. Selected rules go into one document.
- Search by name, criteria, or action.
- Filter by module, status (active or inactive), and “only rules that call a function”.
- Select all visible rows, or clear the selection.

### Review

- Loads the full rule and the function source for each selected workflow.
- **Details** opens the rule:
  - Summary of module, trigger, status, conditions, actions, and functions.
  - Flowchart from top to bottom: Start, each condition, Yes and No, actions, then Done or the next condition.
  - Criteria text and the actions on each branch (function, field update, email, or other).
- Each function has four tabs:
  - **Checks** — Deluge lint with errors, warnings, and info on the code.
  - **Sent to AI** — the masked code that will be sent. Select text and choose **Mask as secret** to hide more.
  - **Improve and apply** — asks the AI for a better version, then **Apply as main function** writes it back to the CRM function through `livingdocs_update_function`.
  - **Versions** — earlier copies of the function kept by the widget. Zoho also keeps its own Deluge revision history.
- Shows whether the function changed since the last documented version.
- The prompt is built from the rule, criteria, and masked code. You can edit it, reset it, or copy it before generating.

### Document

- AI writes the documentation in markdown from the prompt.
- On screen you can switch between the written document and the rule details.
- Copy the text, download a `.md` file, or download a PDF.
- The PDF uses the same layout as the on-screen document: cover (title, module, date, author) and a page footer.

### Save to CRM

- After the AI responds, the widget saves on its own.
- One documentation record per workflow and per function in `Living_Docs_Documents`.
- If a record for that item already exists, it is updated. Otherwise a new record is created.
- The PDF is attached to that record.
- Step 5 shows Created or Updated, whether the PDF attached, and a button to open the CRM record.
- If save fails, you can retry or download the PDF.
- A snapshot of the markdown is also stored, and function edits are written to `Living_Docs_Changes`.

## How it works

- Open the widget from inside a Zoho CRM record or the CRM app.
- The widget calls Zoho through `docsagent_connection`. It does not use a separate WorkDrive upload.
- Setup must pass before the five steps are available.

1. **Overview**
   - Reads modules, workflow rules, and functions.
   - Shows the counts and the module table.

2. **Select workflows**
   - You choose the rules to document.
   - Several rules become one document.

3. **Review criteria and code**
   - Loads each rule’s conditions, actions, and function code.
   - Masks secrets and IDs.
   - Optionally reviews Deluge, improves a function, and applies that code back to CRM.
   - Builds the prompt you can still edit.

4. **Document**
   - Sends the masked prompt to Claude or Cursor.
   - Shows the markdown.
   - Builds the PDF in the browser from that same design.

5. **Save to CRM**
   - Creates or updates the documentation record.
   - Attaches the PDF to the record.
   - You can open the record in CRM or start again with other workflows.

## What you need in Zoho

- Connection link name `docsagent_connection` with the CRM scopes listed on the setup screen, including modules, settings, workflow rules, functions, and function execute.
- Custom modules above, created by **Install and verify** or already present.
- An AI provider saved in Settings, with a working API key.
- On `Living_Docs_Documents`, attachments must be allowed, or the PDF cannot be attached.
- For **Apply as main function**, the standalone function `livingdocs_update_function` must exist, its argument must be named `payload`, and REST API with OAuth 2.0 must be turned on for that function.
