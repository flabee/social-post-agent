// ─── Per-thread history ───────────────────────────────────────────────────────
// Stored under hist_<threadId>. Text turns only, last HISTORY_MAX_TURNS_.

var HISTORY_MAX_TURNS_ = 12;

function getThreadHistory_(threadId) {
  const raw = PropertiesService.getScriptProperties().getProperty('hist_' + threadId);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Filters to text turns only, truncates to the last HISTORY_MAX_TURNS_, saves.
function saveThreadHistory_(threadId, turns) {
  const textOnly = (turns || []).filter(function(t) {
    return t && t.parts && t.parts.length > 0 && t.parts[0].text !== undefined;
  });
  const truncated = textOnly.slice(-HISTORY_MAX_TURNS_);
  PropertiesService.getScriptProperties().setProperty('hist_' + threadId, JSON.stringify(truncated));
}

// ─── Job queue ────────────────────────────────────────────────────────────────

function putJob_(job) {
  const jobId = 'job_' + Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(jobId, JSON.stringify(job));
  return jobId;
}

function getJob_(jobId) {
  const raw = PropertiesService.getScriptProperties().getProperty(jobId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function deleteJob_(jobId) {
  PropertiesService.getScriptProperties().deleteProperty(jobId);
}

// ─── Posting to Google Chat as the app ────────────────────────────────────────
// App authentication via service account (CHAT_SA_CREDENTIALS) + the OAuth2 library.
// The advanced Chat service (Chat) must be enabled in the manifest.

var CHAT_BOT_SCOPE_ = 'https://www.googleapis.com/auth/chat.bot';

// Builds the OAuth2 service for the service account. Returns the service or null.
function chatAppService_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CHAT_SA_CREDENTIALS');
  if (!raw) return null;
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!creds.client_email || !creds.private_key) return null;

  // Construction can throw if the private_key is malformed: treat it as invalid
  // credentials (null), consistent with the "never throw" contract.
  try {
    return OAuth2.createService(creds.client_email)
      .setTokenUrl('https://oauth2.googleapis.com/token')
      .setPrivateKey(creds.private_key)
      .setIssuer(creds.client_email)
      .setSubject(creds.client_email)
      .setScope(CHAT_BOT_SCOPE_)
      .setPropertyStore(PropertiesService.getScriptProperties());
  } catch (e) {
    return null;
  }
}

// Posts a card with an image (image widget) and optional text. imageUrl must be a
// public URL that returns an image (e.g. the Cloud Run renderer). Same thread rules
// as postMessage_. Returns { thread_name } or { error }.
function postCard_(spaceName, threadName, text, imageUrl, altText) {
  const service = chatAppService_();
  if (!service) {
    return { error: 'CHAT_SA_CREDENTIALS missing or invalid in Script Properties' };
  }
  let token;
  try {
    token = service.getAccessToken();
  } catch (e) {
    return { error: 'Service-account OAuth failed: ' + (e && e.message ? e.message : e) };
  }
  if (!token) {
    return { error: 'App token not obtained (check CHAT_SA_CREDENTIALS)' };
  }

  const message = {
    cardsV2: [{
      cardId: 'post-card',
      card: { sections: [{ widgets: [{ image: { imageUrl: imageUrl, altText: altText || 'post', onClick: { openLink: { url: imageUrl } } } }] }] }
    }]
  };
  if (text) message.text = text;

  const params = {};
  if (threadName) {
    message.thread = { name: threadName };
    params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }

  try {
    const created = Chat.Spaces.Messages.create(
      message,
      spaceName,
      params,
      { Authorization: 'Bearer ' + token }
    );
    const tn = (created && created.thread && created.thread.name) ? created.thread.name : threadName;
    return { thread_name: tn };
  } catch (e) {
    return { error: 'Chat API create (card) failed: ' + (e && e.message ? e.message : e) };
  }
}

// Posts a text message into the space. If threadName is given, replies in that
// thread; if null, creates a new thread. Returns { thread_name } or { error }.
function postMessage_(spaceName, threadName, text) {
  const service = chatAppService_();
  if (!service) {
    return { error: 'CHAT_SA_CREDENTIALS missing or invalid in Script Properties' };
  }

  let token;
  try {
    token = service.getAccessToken();
  } catch (e) {
    return { error: 'Service-account OAuth failed: ' + (e && e.message ? e.message : e) };
  }
  if (!token) {
    return { error: 'App token not obtained (check CHAT_SA_CREDENTIALS)' };
  }

  const message = { text: text };
  const params = {};
  if (threadName) {
    message.thread = { name: threadName };
    params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }

  try {
    const created = Chat.Spaces.Messages.create(
      message,
      spaceName,
      params,
      { Authorization: 'Bearer ' + token }
    );
    const tn = (created && created.thread && created.thread.name) ? created.thread.name : threadName;
    return { thread_name: tn };
  } catch (e) {
    return { error: 'Chat API create failed: ' + (e && e.message ? e.message : e) };
  }
}
