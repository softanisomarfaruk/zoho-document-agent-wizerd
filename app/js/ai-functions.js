/*
 * Living Docs AI functions. Builds the two standalone Deluge functions the widget installs in CRM:
 *   livingdocs_save_api_key  - admins save or clear the Claude / Cursor key. It is stored AES-encrypted in the
 *                              Org Variable livingdocs_llm_key and never written to a module.
 *   livingdocs_llm_gateway   - decrypts the key inside CRM and calls the provider. The widget only sees the answer.
 * Both scripts carry the same random secret, generated in the browser at install time and kept nowhere else.
 */
(function () {
  'use strict';

  const SAVE_FN = 'livingdocs_save_api_key';
  const GATEWAY_FN = 'livingdocs_llm_gateway';
  const VAR_NAME = 'livingdocs_llm_key';
  const USAGE_RECORD = 'livingdocs_usage';
  // Requests per user per day; 0 turns the limit off (off for now, at the user's request).
  const DAILY_LIMIT = 0;
  // Bump when the gateway script changes; setup then rewrites the gateway and keeps its secret.
  const GATEWAY_VERSION = 5;

  const API_DOMAINS = [
    'https://www.zohoapis.com', 'https://www.zohoapis.eu', 'https://www.zohoapis.in', 'https://www.zohoapis.com.au',
    'https://www.zohoapis.jp', 'https://www.zohoapis.ca', 'https://www.zohoapis.sa', 'https://www.zohoapis.com.cn',
    'https://www.zohoapis.uk'
  ];

  // Same idea as the widget's redaction: a credential that slipped through is masked once more inside CRM.
  // No backslashes, so the patterns survive Deluge string literals unchanged.
  const SERVER_REDACT = [
    'Zoho-oauthtoken[ ]+[A-Za-z0-9._-]{16,}',
    'Bearer[ ]+[A-Za-z0-9._~+/=-]{16,}',
    '1000[.][a-fA-F0-9]{32}[.][a-fA-F0-9]{32}',
    'sk-ant-[A-Za-z0-9_-]{20,}',
    'sk-[A-Za-z0-9_-]{32,}',
    'key_[A-Za-z0-9_-]{32,}'
  ];

  function randomSecret(length = 40) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  }

  // Lets the widget see that both functions hold the same secret without reading it back.
  async function secretTagOf(secret) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`livingdocs:${secret}`));
    return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const deluge = value => String(value).replace(/[^A-Za-z0-9_.:/-]/g, '');
  const list = values => `{${values.map(v => `"${v}"`).join(',')}}`;

  // ---------------------------------------------------------------------------
  // livingdocs_save_api_key
  // ---------------------------------------------------------------------------
  function saveKeyScript({ secret, tag, connection }) {
    const conn = deluge(connection || 'docsagent_connection');
    return `// Living Docs: saves the AI API keys, AES-encrypted, in the Org Variable ${VAR_NAME}.
// Argument: payload (String). Return type: String. Installed by the Living Docs widget.
// The secret below is also in ${GATEWAY_FN}. Change both or neither, then save the keys again.
secret = "${deluge(secret)}";
secretTag = "${deluge(tag)}";
varName = "${VAR_NAME}";
allowedProfiles = {"Administrator"};
apiDomains = ${list(API_DOMAINS)};
providers = {"anthropic","cursor"};
actions = {"check","save","clear"};
result = Map();
err = Map();
result.put("secretTag",secretTag);
args = null;
try
{
	args = ifnull(payload,"{}").toMap();
}
catch (e)
{
	args = null;
}
if(args == null)
{
	args = Map();
}
action = ifnull(args.get("action"),"check").toString();
apiDomain = ifnull(args.get("apiDomain"),"").toString();
result.put("action",action);
if(!actions.contains(action))
{
	err.put("code","BAD_ACTION");
	err.put("message","action must be check, save or clear.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
if(secret.length() < 32)
{
	err.put("code","NOT_DEPLOYED");
	err.put("message","${SAVE_FN} has no secret. Run Install on the Living Docs setup page again.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
// ---------- current keys ----------
stored = ifnull(zoho.crm.getOrgVariable(varName),"").toString().trim();
keys = Map();
readable = true;
if(stored != "" && stored != "unset")
{
	try
	{
		keys = zoho.encryption.aesDecode(secret,stored).toMap();
	}
	catch (e)
	{
		keys = null;
	}
	if(keys == null)
	{
		keys = Map();
		readable = false;
	}
}
result.put("readable",readable);
keyState = Map();
for each  p in providers
{
	one = Map();
	entry = keys.get(p);
	one.put("set",entry != null && ifnull(entry.get("key"),"") != "");
	if(entry != null)
	{
		one.put("hint",ifnull(entry.get("hint"),""));
	}
	keyState.put(p,one);
}
result.put("keys",keyState);
if(action == "check")
{
	result.put("ok",true);
	return result.toString();
}
// ---------- save and clear: CRM Administrator only ----------
if(!apiDomains.contains(apiDomain))
{
	err.put("code","BAD_DOMAIN");
	err.put("message","apiDomain is not a Zoho data centre.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
caller = ifnull(zoho.loginuserid,"").toString().toLowerCase();
callerProfile = "";
found = false;
pages = {1,2,3,4,5,6,7,8,9,10};
for each  pg in pages
{
	if(!found)
	{
		usersResp = invokeurl
		[
			url :apiDomain + "/crm/v8/users"
			type :GET
			parameters:{"type":"ActiveUsers","per_page":200,"page":pg}
			connection:"${conn}"
		];
		userRows = ifnull(usersResp.get("users"),List());
		for each  u in userRows
		{
			if(ifnull(u.get("email"),"").toString().toLowerCase() == caller)
			{
				prof = u.get("profile");
				if(prof != null)
				{
					callerProfile = ifnull(prof.get("name"),"").toString();
				}
				found = true;
			}
		}
		if(userRows.size() < 200)
		{
			found = true;
		}
	}
}
if(caller == "" || !allowedProfiles.contains(callerProfile))
{
	err.put("code","NOT_ALLOWED");
	err.put("message","Only a CRM Administrator can change the AI keys.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
vars = invokeurl
[
	url :apiDomain + "/crm/v8/settings/variables"
	type :GET
	connection:"${conn}"
];
varId = null;
for each  v in ifnull(vars.get("variables"),List())
{
	if(v.get("api_name") == varName)
	{
		varId = v.get("id");
	}
}
if(varId == null)
{
	err.put("code","VARIABLE_MISSING");
	err.put("message","The Org Variable " + varName + " does not exist. Run Install on the Living Docs setup page.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
provider = ifnull(args.get("provider"),"").toString();
if(action == "save")
{
	newKey = ifnull(args.get("key"),"").toString().trim();
	if(!providers.contains(provider))
	{
		err.put("code","BAD_PROVIDER");
		err.put("message","Unknown provider: " + provider);
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	if(newKey.length() < 10 || newKey.length() > 500 || newKey.contains(" "))
	{
		err.put("code","BAD_KEY");
		err.put("message","That does not look like an API key (10 to 500 characters, no spaces).");
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	entry = Map();
	entry.put("key",newKey);
	entry.put("hint",newKey.subString(newKey.length() - 4,newKey.length()));
	entry.put("savedBy",caller);
	entry.put("savedAt",zoho.currenttime.toString("yyyy-MM-dd HH:mm:ss"));
	keys.put(provider,entry);
}
else if(provider == "")
{
	keys = Map();
}
else
{
	keys.remove(provider);
}
newValue = "unset";
if(keys.size() > 0)
{
	newValue = zoho.encryption.aesEncode(secret,keys.toString());
}
item = Map();
item.put("id",varId);
item.put("value",newValue);
items = List();
items.add(item);
body = Map();
body.put("variables",items);
hdr = Map();
hdr.put("Content-Type","application/json");
resp = invokeurl
[
	url :apiDomain + "/crm/v8/settings/variables/" + varId
	type :PUT
	parameters:body.toString()
	headers:hdr
	detailed:true
	connection:"${conn}"
];
code = ifnull(resp.get("responseCode"),0).toLong();
// Action and status only, never the key.
info "${SAVE_FN} action=" + action + " provider=" + provider + " status=" + code;
if(code < 200 || code >= 300)
{
	err.put("code","WRITE_FAILED");
	err.put("message","CRM did not store the value (HTTP " + code + ").");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
// A variable type that is too short cuts the value, which would make the key unreadable later.
after = ifnull(zoho.crm.getOrgVariable(varName),"").toString().trim();
if(after != newValue)
{
	err.put("code","STORED_VALUE_CUT");
	err.put("message","CRM stored " + after.length() + " of " + newValue.length() + " characters. Change " + varName + " to a Multi Line variable.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
keyState = Map();
for each  p in providers
{
	one = Map();
	entry = keys.get(p);
	one.put("set",entry != null && ifnull(entry.get("key"),"") != "");
	if(entry != null)
	{
		one.put("hint",ifnull(entry.get("hint"),""));
	}
	keyState.put(p,one);
}
result.put("keys",keyState);
result.put("readable",true);
result.put("ok",true);
return result.toString();`;
  }

  // ---------------------------------------------------------------------------
  // livingdocs_llm_gateway
  // ---------------------------------------------------------------------------
  function gatewayScript({ secret, tag, settingsModule }) {
    const module = deluge(settingsModule || 'Living_Docs_Settings');
    return `// Living Docs: sends widget prompts to Claude or Cursor with the key stored in the Org Variable ${VAR_NAME}.
// Argument: payload (String). Return type: String. Installed by the Living Docs widget.
// The key is decrypted here and never returned. Provider hosts are fixed, so a changed setting cannot send it elsewhere.
// The secret below is also in ${SAVE_FN}. Change both or neither, then save the keys again.
secret = "${deluge(secret)}";
secretTag = "${deluge(tag)}";
dailyLimit = ${DAILY_LIMIT};
// Per call. The widget asks for pieces that finish inside Zoho's time limit and joins them.
maxTokensCap = 16000;
started = zoho.currenttime.toLong();
result = Map();
err = Map();
result.put("secretTag",secretTag);
result.put("version",${GATEWAY_VERSION});
raw = ifnull(payload,"");
req = null;
try
{
	req = raw.toMap();
}
catch (e)
{
	req = null;
}
if(req == null)
{
	err.put("code","BAD_REQUEST");
	err.put("message","payload must be a JSON object.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
action = ifnull(req.get("action"),"").toString();
actions = {"ping","status","test","models","start","poll","cancel","find"};
result.put("action",action);
if(!actions.contains(action))
{
	err.put("code","BAD_ACTION");
	err.put("message","Action is not allowed: " + action);
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
if(action == "ping")
{
	result.put("ok",true);
	return result.toString();
}
if(secret.length() < 32)
{
	err.put("code","NOT_DEPLOYED");
	err.put("message","${GATEWAY_FN} has no secret. Run Install on the Living Docs setup page again.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
// ---------- stored keys ----------
providers = {"anthropic","cursor"};
stored = ifnull(zoho.crm.getOrgVariable("${VAR_NAME}"),"").toString().trim();
keys = Map();
keyStatus = "not_set";
if(stored != "" && stored != "unset")
{
	try
	{
		keys = zoho.encryption.aesDecode(secret,stored).toMap();
	}
	catch (e)
	{
		keys = null;
	}
	if(keys == null)
	{
		keys = Map();
		keyStatus = "unreadable";
	}
	else
	{
		keyStatus = "set";
	}
}
result.put("keyStatus",keyStatus);
if(action == "status")
{
	keyState = Map();
	for each  p in providers
	{
		one = Map();
		entry = keys.get(p);
		one.put("set",entry != null && ifnull(entry.get("key"),"") != "");
		if(entry != null)
		{
			one.put("hint",ifnull(entry.get("hint"),""));
		}
		keyState.put(p,one);
	}
	result.put("keys",keyState);
	result.put("ok",true);
	return result.toString();
}
if(keyStatus == "unreadable")
{
	err.put("code","KEY_UNREADABLE");
	err.put("message","The saved keys cannot be decrypted. The two Living Docs functions hold different secrets. Run Install again, then save the keys again.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
provider = ifnull(req.get("provider"),"").toString();
if(!providers.contains(provider))
{
	err.put("code","UNSUPPORTED_PROVIDER");
	err.put("message","Unknown provider: " + provider);
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
result.put("provider",provider);
entry = keys.get(provider);
if(entry == null || ifnull(entry.get("key"),"") == "")
{
	err.put("code","KEY_NOT_SET");
	err.put("message","No " + provider + " API key is saved. An administrator can add it on the Living Docs setup page.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
apiKey = entry.get("key").toString();
model = ifnull(req.get("model"),"").toString().trim();
if(model != "" && !model.matches("[A-Za-z0-9._:/-]{1,120}"))
{
	err.put("code","INVALID_MODEL");
	err.put("message","The model ID contains characters that are not allowed.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
if(model == "" && (action == "test" || action == "start"))
{
	err.put("code","INVALID_MODEL");
	err.put("message","Choose a model first.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
result.put("model",model);
hdr = Map();
if(provider == "anthropic")
{
	baseUrl = "https://api.anthropic.com";
	hdr.put("x-api-key",apiKey);
	hdr.put("anthropic-version","2023-06-01");
	workspaceId = ifnull(req.get("workspaceId"),"").toString().trim();
	if(workspaceId != "")
	{
		if(!workspaceId.matches("wrkspc_[A-Za-z0-9]{4,80}"))
		{
			err.put("code","BAD_WORKSPACE");
			err.put("message","The Claude workspace ID should start with wrkspc_.");
			result.put("ok",false);
			result.put("error",err);
			return result.toString();
		}
		hdr.put("anthropic-workspace-id",workspaceId);
	}
}
else
{
	baseUrl = "https://api.cursor.com";
	hdr.put("Authorization","Basic " + zoho.encryption.base64Encode(apiKey + ":"));
	hdr.put("Accept","application/json");
}
// ---------- daily limit, counted when a generation starts (dailyLimit 0 = off) ----------
if(action == "start" && dailyLimit > 0)
{
	who = ifnull(zoho.loginuserid,"").toString().toLowerCase();
	if(who == "")
	{
		who = ifnull(zoho.loginuser,"unknown").toString();
	}
	day = zoho.currenttime.toString("yyyy-MM-dd");
	usageRec = null;
	usageRows = zoho.crm.searchRecords("${module}","(Name:equals:${USAGE_RECORD})");
	if(usageRows != null && usageRows.size() > 0)
	{
		usageRec = usageRows.get(0);
	}
	counts = Map();
	if(usageRec != null)
	{
		rawUsage = ifnull(usageRec.get("Usage_JSON"),"").toString();
		if(rawUsage != "")
		{
			storedUsage = rawUsage.toMap();
			if(storedUsage != null && ifnull(storedUsage.get("date"),"").toString() == day && storedUsage.get("counts") != null)
			{
				counts = storedUsage.get("counts");
			}
		}
	}
	used = ifnull(counts.get(who),0).toLong();
	if(used >= dailyLimit)
	{
		err.put("code","DAILY_LIMIT");
		err.put("message","Today's limit of " + dailyLimit + " AI requests is used up. It resets tomorrow.");
		result.put("ok",false);
		result.put("error",err);
		info "${GATEWAY_FN} action=start status=DAILY_LIMIT";
		return result.toString();
	}
	counts.put(who,used + 1);
	savedUsage = Map();
	savedUsage.put("date",day);
	savedUsage.put("counts",counts);
	usageData = Map();
	usageData.put("Name","${USAGE_RECORD}");
	usageData.put("Usage_JSON",savedUsage.toString());
	wrote = null;
	writeError = "";
	try
	{
		if(usageRec == null)
		{
			wrote = zoho.crm.createRecord("${module}",usageData);
		}
		else
		{
			wrote = zoho.crm.updateRecord("${module}",usageRec.get("id").toLong(),usageData);
		}
	}
	catch (e)
	{
		wrote = null;
		writeError = e.toString();
	}
	// createRecord / updateRecord return {id:...} on success; status "error" is a real failure.
	writeOk = false;
	if(wrote != null)
	{
		wroteStatus = ifnull(wrote.get("status"),"").toString().toLowerCase();
		wroteId = ifnull(wrote.get("id"),"").toString();
		if(wroteStatus == "success" || wroteId != "" && wroteStatus != "error")
		{
			writeOk = true;
		}
	}
	if(!writeOk)
	{
		failText = "The daily limit could not be recorded, so the request was not sent.";
		if(wrote != null && ifnull(wrote.get("message"),"").toString() != "")
		{
			failText = failText + " CRM said: " + wrote.get("message").toString();
		}
		else if(writeError != "")
		{
			if(writeError.length() > 300)
			{
				writeError = writeError.subString(0,300);
			}
			failText = failText + " CRM said: " + writeError;
		}
		err.put("code","USAGE_NOT_RECORDED");
		err.put("message",failText);
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
}
// ---------- request ----------
// mode: "direct" answers now, "batch" / "agent" return a job the widget polls.
mode = "";
job = Map();
resp = null;
if(action == "models")
{
	if(provider == "anthropic")
	{
		resp = invokeurl
		[
			url :baseUrl + "/v1/models?limit=100"
			type :GET
			headers:hdr
			detailed:true
		];
	}
	else
	{
		resp = invokeurl
		[
			url :baseUrl + "/v1/models"
			type :GET
			headers:hdr
			detailed:true
		];
	}
}
else if(action == "test" && provider == "cursor")
{
	resp = invokeurl
	[
		url :baseUrl + "/v1/me"
		type :GET
		headers:hdr
		detailed:true
	];
}
else if(action == "test" || action == "start")
{
	// Set by the widget so a run whose start call timed out can be found again (action find).
	requestId = ifnull(req.get("requestId"),"").toString();
	if(!requestId.matches("[A-Za-z0-9-]{8,64}"))
	{
		requestId = "r" + started;
	}
	system = ifnull(req.get("system"),"").toString();
	userText = ifnull(req.get("user"),"").toString();
	maxTokens = ifnull(req.get("maxTokens"),3000).toLong();
	if(action == "test")
	{
		system = "You are a connection test. Reply with the single word OK.";
		userText = "Reply with OK.";
		maxTokens = 16;
	}
	if(maxTokens < 16)
	{
		maxTokens = 16;
	}
	if(maxTokens > maxTokensCap)
	{
		maxTokens = maxTokensCap;
	}
	if(userText.trim() == "")
	{
		err.put("code","BAD_REQUEST");
		err.put("message","The prompt is empty.");
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	redact = ${list(SERVER_REDACT)};
	for each  pattern in redact
	{
		system = system.replaceAll(pattern,"{{SECRET_MASKED}}");
		userText = userText.replaceAll(pattern,"{{SECRET_MASKED}}");
	}
	hdr.put("Content-Type","application/json");
	if(provider == "anthropic")
	{
		msg = Map();
		msg.put("role","user");
		msg.put("content",userText);
		msgs = List();
		msgs.add(msg);
		// Text already written by earlier calls. Claude gets it back and continues from where it stopped.
		partial = ifnull(req.get("partial"),"").toString();
		if(partial.trim() != "")
		{
			prev = Map();
			prev.put("role","assistant");
			prev.put("content",partial);
			msgs.add(prev);
			more = Map();
			more.put("role","user");
			more.put("content","Continue exactly where your previous message stopped, in the middle of a word or line if needed. Do not repeat anything, do not add a preface or a closing note.");
			msgs.add(more);
		}
		params = Map();
		params.put("model",model);
		params.put("max_tokens",maxTokens);
		params.put("messages",msgs);
		if(system != "")
		{
			params.put("system",system);
		}
		// Always a direct call: fast, and the widget keeps each piece short enough for Zoho's time limit.
		mode = "direct";
		resp = invokeurl
		[
			url :baseUrl + "/v1/messages"
			type :POST
			parameters:params.toString()
			headers:hdr
			detailed:true
		];
	}
	else
	{
		mode = "agent";
		promptText = userText;
		if(system != "")
		{
			promptText = system + "\\n\\n" + userText;
		}
		prompt = Map();
		prompt.put("text",promptText);
		modelInfo = Map();
		modelInfo.put("id",model);
		body = Map();
		body.put("prompt",prompt);
		body.put("model",modelInfo);
		body.put("name","Living Docs " + requestId);
		body.put("mode","agent");
		resp = invokeurl
		[
			url :baseUrl + "/v1/agents"
			type :POST
			parameters:body.toString()
			headers:hdr
			detailed:true
		];
	}
}
else if(action == "find")
{
	requestId = ifnull(req.get("requestId"),"").toString();
	if(!requestId.matches("[A-Za-z0-9-]{8,64}"))
	{
		err.put("code","BAD_JOB");
		err.put("message","Unknown request ID.");
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	// Creating a Claude batch is quick, so only a Cursor agent can outlive the start call.
	if(provider != "cursor")
	{
		result.put("found",false);
		result.put("ok",true);
		return result.toString();
	}
	resp = invokeurl
	[
		url :baseUrl + "/v1/agents?limit=25"
		type :GET
		headers:hdr
		detailed:true
	];
}
else
{
	// poll and cancel. Job IDs come from the widget, so only their format is trusted, never a URL.
	jobIn = req.get("job");
	if(jobIn == null)
	{
		err.put("code","BAD_JOB");
		err.put("message","job is required.");
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	if(provider == "anthropic")
	{
		batchId = ifnull(jobIn.get("id"),"").toString();
		if(!batchId.matches("msgbatch_[A-Za-z0-9]{4,80}"))
		{
			err.put("code","BAD_JOB");
			err.put("message","Unknown batch ID.");
			result.put("ok",false);
			result.put("error",err);
			return result.toString();
		}
		job.put("id",batchId);
		job.put("customId",ifnull(jobIn.get("customId"),"").toString());
		if(action == "cancel")
		{
			hdr.put("Content-Type","application/json");
			resp = invokeurl
			[
				url :baseUrl + "/v1/messages/batches/" + batchId + "/cancel"
				type :POST
				parameters:"{}"
				headers:hdr
				detailed:true
			];
		}
		else
		{
			mode = "batch";
			resp = invokeurl
			[
				url :baseUrl + "/v1/messages/batches/" + batchId
				type :GET
				headers:hdr
				detailed:true
			];
		}
	}
	else
	{
		agentId = ifnull(jobIn.get("agentId"),"").toString();
		runId = ifnull(jobIn.get("runId"),"").toString();
		if(!agentId.matches("[A-Za-z0-9_-]{4,120}") || !runId.matches("[A-Za-z0-9_-]{4,120}"))
		{
			err.put("code","BAD_JOB");
			err.put("message","Unknown agent run.");
			result.put("ok",false);
			result.put("error",err);
			return result.toString();
		}
		job.put("agentId",agentId);
		job.put("runId",runId);
		if(action == "cancel")
		{
			hdr.put("Content-Type","application/json");
			resp = invokeurl
			[
				url :baseUrl + "/v1/agents/" + agentId + "/runs/" + runId + "/cancel"
				type :POST
				parameters:"{}"
				headers:hdr
				detailed:true
			];
			cleanup = invokeurl
			[
				url :baseUrl + "/v1/agents/" + agentId
				type :DELETE
				headers:hdr
				detailed:true
			];
		}
		else
		{
			mode = "agent";
			resp = invokeurl
			[
				url :baseUrl + "/v1/agents/" + agentId + "/runs/" + runId
				type :GET
				headers:hdr
				detailed:true
			];
		}
	}
}
code = ifnull(resp.get("responseCode"),0).toLong();
responseText = ifnull(resp.get("responseText"),"").toString();
result.put("httpStatus",code);
// Status and timing only, never prompts, replies or keys.
// Deluge joins the string before it subtracts, even inside brackets, so the time is worked out first.
elapsed = zoho.currenttime.toLong() - started;
info "${GATEWAY_FN} action=" + action + " provider=" + provider + " status=" + code + " ms=" + elapsed;
if(code < 200 || code >= 300)
{
	providerMessage = "";
	providerType = "";
	errorBody = null;
	try
	{
		errorBody = responseText.toMap();
	}
	catch (e)
	{
		errorBody = null;
	}
	if(errorBody != null)
	{
		pe = errorBody.get("error");
		if(pe != null && pe.toString().startsWith("{"))
		{
			providerMessage = ifnull(pe.get("message"),"").toString();
			providerType = ifnull(pe.get("type"),"").toString();
		}
		else if(pe != null)
		{
			providerMessage = pe.toString();
		}
		else
		{
			providerMessage = ifnull(errorBody.get("message"),"").toString();
		}
	}
	if(providerMessage.length() > 400)
	{
		providerMessage = providerMessage.subString(0,400);
	}
	errCode = "PROVIDER_ERROR";
	if(providerMessage.containsIgnoreCase("workspace"))
	{
		errCode = "WORKSPACE_REQUIRED";
	}
	else if(providerMessage.containsIgnoreCase("credit balance"))
	{
		errCode = "BILLING";
	}
	else if(code == 401)
	{
		errCode = "KEY_REJECTED";
	}
	else if(code == 403)
	{
		errCode = "PERMISSION";
	}
	else if(code == 404)
	{
		errCode = "NOT_FOUND";
	}
	else if(code == 413)
	{
		errCode = "TOO_LARGE";
	}
	else if(code == 429)
	{
		errCode = "RATE_LIMITED";
	}
	else if(code == 529 || code == 503 || code == 502 || code == 500)
	{
		errCode = "OVERLOADED";
	}
	err.put("code",errCode);
	err.put("status",code);
	err.put("type",providerType);
	err.put("message",providerMessage);
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
reply = null;
try
{
	reply = responseText.toMap();
}
catch (e)
{
	reply = null;
}
if(action == "cancel")
{
	result.put("ok",true);
	return result.toString();
}
if(action == "find")
{
	agentId = "";
	agentRows = null;
	if(reply != null)
	{
		agentRows = ifnull(reply.get("items"),ifnull(reply.get("agents"),reply.get("data")));
	}
	for each  a in ifnull(agentRows,List())
	{
		if(ifnull(a.get("name"),"").toString() == "Living Docs " + requestId)
		{
			agentId = ifnull(a.get("id"),"").toString();
		}
	}
	runId = "";
	if(agentId.matches("[A-Za-z0-9_-]{4,120}"))
	{
		runsResp = invokeurl
		[
			url :baseUrl + "/v1/agents/" + agentId + "/runs?limit=5"
			type :GET
			headers:hdr
			detailed:true
		];
		runsBody = null;
		try
		{
			runsBody = ifnull(runsResp.get("responseText"),"").toString().toMap();
		}
		catch (e)
		{
			runsBody = null;
		}
		if(runsBody != null)
		{
			for each  r in ifnull(runsBody.get("items"),ifnull(runsBody.get("runs"),ifnull(runsBody.get("data"),List())))
			{
				if(runId == "")
				{
					runId = ifnull(r.get("id"),"").toString();
				}
			}
		}
	}
	if(runId == "")
	{
		result.put("found",false);
		result.put("ok",true);
		return result.toString();
	}
	job.put("provider","cursor");
	job.put("agentId",agentId);
	job.put("runId",runId);
	result.put("found",true);
	result.put("done",false);
	result.put("job",job);
	result.put("ok",true);
	return result.toString();
}
if(action == "models")
{
	models = List();
	if(reply != null)
	{
		rows = reply.get("data");
		if(provider == "cursor")
		{
			rows = reply.get("items");
		}
		for each  m in ifnull(rows,List())
		{
			row = Map();
			row.put("id",ifnull(m.get("id"),""));
			row.put("displayName",ifnull(m.get("display_name"),ifnull(m.get("displayName"),m.get("id"))));
			row.put("aliases",ifnull(m.get("aliases"),List()));
			models.add(row);
		}
	}
	result.put("models",models);
	result.put("ok",true);
	return result.toString();
}
if(action == "test" && provider == "cursor")
{
	account = "Cursor API key";
	if(reply != null)
	{
		account = ifnull(reply.get("userEmail"),ifnull(reply.get("apiKeyName"),account));
	}
	result.put("account",account);
	result.put("latencyMs",elapsed);
	result.put("ok",true);
	return result.toString();
}
if(reply == null && mode != "batch")
{
	err.put("code","BAD_REPLY");
	err.put("message","The provider answer could not be read.");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
// ---------- Claude direct answer ----------
if(mode == "direct")
{
	answer = "";
	for each  block in ifnull(reply.get("content"),List())
	{
		if(block.get("type") == "text")
		{
			answer = answer + ifnull(block.get("text"),"");
		}
	}
	result.put("done",true);
	result.put("text",answer);
	result.put("stopReason",ifnull(reply.get("stop_reason"),""));
	result.put("model",ifnull(reply.get("model"),model));
	usage = reply.get("usage");
	if(usage != null)
	{
		result.put("tokensIn",ifnull(usage.get("input_tokens"),0));
		result.put("tokensOut",ifnull(usage.get("output_tokens"),0));
	}
	result.put("latencyMs",elapsed);
	result.put("ok",true);
	return result.toString();
}
// ---------- Claude Message Batch ----------
if(mode == "batch")
{
	if(action == "start")
	{
		job.put("id",ifnull(reply.get("id"),""));
		job.put("provider","anthropic");
		result.put("done",false);
		result.put("status",ifnull(reply.get("processing_status"),"in_progress"));
		result.put("job",job);
		result.put("ok",true);
		return result.toString();
	}
	processing = ifnull(reply.get("processing_status"),"").toString();
	result.put("status",processing);
	if(processing != "ended")
	{
		result.put("done",false);
		result.put("ok",true);
		return result.toString();
	}
	// The results URL is built here, not taken from the reply, so the key only ever goes to api.anthropic.com.
	results = invokeurl
	[
		url :baseUrl + "/v1/messages/batches/" + job.get("id") + "/results"
		type :GET
		headers:hdr
		detailed:true
	];
	resultsText = ifnull(results.get("responseText"),"").toString();
	row = null;
	for each  line in resultsText.toList("\\n")
	{
		if(line.trim() != "")
		{
			parsed = null;
			try
			{
				parsed = line.trim().toMap();
			}
			catch (e)
			{
				parsed = null;
			}
			if(parsed != null && (row == null || parsed.get("custom_id") == job.get("customId")))
			{
				row = parsed;
			}
		}
	}
	if(row == null || row.get("result") == null)
	{
		err.put("code","BAD_REPLY");
		err.put("message","Claude finished but the batch result could not be read.");
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	outcome = row.get("result");
	outcomeType = ifnull(outcome.get("type"),"").toString();
	if(outcomeType != "succeeded")
	{
		message = "Claude request ended as " + outcomeType + ".";
		errType = "";
		oe = outcome.get("error");
		if(oe != null)
		{
			inner = oe.get("error");
			if(inner != null)
			{
				message = ifnull(inner.get("message"),message).toString();
				errType = ifnull(inner.get("type"),"").toString();
			}
		}
		err.put("code","PROVIDER_ERROR");
		if(errType == "authentication_error")
		{
			err.put("code","KEY_REJECTED");
		}
		else if(errType == "not_found_error")
		{
			err.put("code","NOT_FOUND");
		}
		else if(message.containsIgnoreCase("credit balance"))
		{
			err.put("code","BILLING");
		}
		err.put("type",errType);
		err.put("message",message);
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	msgOut = outcome.get("message");
	answer = "";
	for each  block in ifnull(msgOut.get("content"),List())
	{
		if(block.get("type") == "text")
		{
			answer = answer + ifnull(block.get("text"),"");
		}
	}
	result.put("done",true);
	result.put("text",answer);
	result.put("stopReason",ifnull(msgOut.get("stop_reason"),""));
	result.put("model",ifnull(msgOut.get("model"),model));
	usage = msgOut.get("usage");
	if(usage != null)
	{
		result.put("tokensIn",ifnull(usage.get("input_tokens"),0));
		result.put("tokensOut",ifnull(usage.get("output_tokens"),0));
	}
	result.put("ok",true);
	return result.toString();
}
// ---------- Cursor agent run ----------
if(action == "start")
{
	agentInfo = reply.get("agent");
	runInfo = reply.get("run");
	if(agentInfo == null || runInfo == null)
	{
		err.put("code","BAD_REPLY");
		err.put("message","Cursor did not return an agent run.");
		result.put("ok",false);
		result.put("error",err);
		return result.toString();
	}
	job.put("provider","cursor");
	job.put("agentId",ifnull(agentInfo.get("id"),""));
	job.put("runId",ifnull(runInfo.get("id"),""));
	result.put("done",false);
	result.put("status",ifnull(runInfo.get("status"),"CREATING"));
	result.put("job",job);
	result.put("ok",true);
	return result.toString();
}
runStatus = ifnull(reply.get("status"),"").toString().toUpperCase();
result.put("status",runStatus);
terminal = {"FINISHED","ERROR","CANCELLED","EXPIRED"};
if(!terminal.contains(runStatus))
{
	result.put("done",false);
	result.put("ok",true);
	return result.toString();
}
answer = "";
runResult = reply.get("result");
if(runResult != null)
{
	resultText = runResult.toString();
	if(resultText.startsWith("{"))
	{
		answer = ifnull(runResult.get("text"),ifnull(runResult.get("message"),ifnull(runResult.get("content"),""))).toString();
	}
	else
	{
		answer = resultText;
	}
}
// The final message is sometimes attached a moment after FINISHED; the widget asks again before accepting a short one.
if(runStatus == "FINISHED" && answer.trim().length() < 200 && ifnull(req.get("acceptShort"),false) != true)
{
	result.put("done",false);
	result.put("status","FINALIZING");
	result.put("ok",true);
	return result.toString();
}
cleanup = invokeurl
[
	url :baseUrl + "/v1/agents/" + job.get("agentId")
	type :DELETE
	headers:hdr
	detailed:true
];
if(runStatus != "FINISHED")
{
	err.put("code","PROVIDER_ERROR");
	err.put("message","Cursor run ended with status " + runStatus + ".");
	result.put("ok",false);
	result.put("error",err);
	return result.toString();
}
result.put("done",true);
result.put("text",answer);
result.put("ok",true);
return result.toString();`;
  }

  window.LivingDocsFunctions = {
    SAVE_FN,
    GATEWAY_FN,
    VAR_NAME,
    USAGE_RECORD,
    DAILY_LIMIT,
    GATEWAY_VERSION,
    API_DOMAINS,
    randomSecret,
    secretTagOf,
    saveKeyScript,
    gatewayScript
  };
})();
