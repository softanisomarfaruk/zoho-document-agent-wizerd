# Zoho Connections & OAuth Permissions Guide

To allow the Living Documentation Agent Deluge functions and Catalyst backend to read system metadata, automations, and export documents to Zoho WorkDrive, configure the following Zoho Connections inside **Zoho CRM -> Setup -> Developer Space -> Connections**.

---

## 1. CRM Metadata Connection (`docsagent_connection` / `zoho_crm_conn`)
- **Connection Name**: `docsagent_connection`
- **Service Name**: `Zoho OAuth`
- **Scope list**:
  - `ZohoCRM.modules.ALL`
  - `ZohoCRM.modules.All`
  - `ZohoCRM.org.READ`
  - `ZohoCRM.settings.ALL`
  - `ZohoCRM.settings.functions.ALL`
  - `ZohoCRM.settings.READ`

---

## 2. WorkDrive Connection (`zoho_workdrive_conn`)
- **Connection Name**: `zoho_workdrive_conn`
- **Service Name**: `Zoho OAuth`
- **Scope list**:
  - `WorkDrive.workspace.ALL`
  - `WorkDrive.files.ALL`
  - `WorkDrive.team.READ`

---

## 3. How to create in Zoho CRM:
1. Go to **Setup** (gear icon) -> **Developer Space** -> **Connections**.
2. Click **Add Connection** -> Select **Zoho OAuth**.
3. Name your connection `zoho_crm_conn` or `zoho_workdrive_conn`.
4. Select the check-boxes for the scopes listed above.
5. Click **Create and Connect** -> Authorize the prompt.
