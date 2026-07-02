// Google Chat front-end. Entry points: doPost (reactive), weeklyProposal_
// (proactive), processQueue_ (async worker), setupChatApp.
//
// Async via a queue + recurring worker: doPost enqueues the message and returns
// immediately; a recurring trigger (processQueue_, created by setupChatApp in the
// editor's authorized context) drains the queue every minute and posts the replies.
// This avoids creating triggers at runtime, which an anonymous web app cannot do
// reliably.

var ACK_TEXT_ = '🤔 Working on it, one moment...';

// Endpoint called by Google Chat on every event.
function doPost(e) {
  let event;
  try {
    event = JSON.parse(e.postData.contents);
  } catch (err) {
    return chatResponse_('');
  }

  // Supports TWO event formats:
  //  - Classic Chat:     { type:'MESSAGE', message:{...}, space:{...} }
  //  - Workspace add-on: { chat:{ messagePayload:{ message:{...}, space:{...} }, user:{...} } }
  // Extracts the message wherever it is; if there is no message (ADDED_TO_SPACE,
  // button click, ...) it returns empty without crashing.
  const payload = (event && event.chat && event.chat.messagePayload) || event || {};
  const message = payload.message;
  if (!message) {
    Logger.log('doPost: no message in event (keys: ' + Object.keys(event || {}).join(',') + ')');
    return chatResponse_('');
  }

  const text       = message.text || '';
  const spaceName  = (payload.space && payload.space.name)
                  || (message.space && message.space.name) || '';
  const threadName = (message.thread && message.thread.name) || '';
  const userName   = (message.sender && message.sender.displayName)
                  || (event.chat && event.chat.user && event.chat.user.displayName) || 'user';

  Logger.log('doPost: MESSAGE space=' + spaceName + ' thread=' + threadName + ' text=' + text);

  // Immediate ack posted by the service account (its own token, independent of the
  // doPost context), so the user gets feedback right away while the worker prepares
  // the real reply.
  postMessage_(spaceName, threadName, ACK_TEXT_);

  // Enqueue the message; the recurring worker processQueue_ will handle it.
  putJob_({ space: spaceName, thread: threadName, text: text, userName: userName });

  // Synchronous NO-OP response ({}): the app runs in Workspace add-on mode, where
  // the classic Message format ({text}) is not accepted. {} avoids the "app not
  // responding" state without posting anything — the ack and the real reply arrive
  // via the service account.
  return chatResponse_('');
}

// Builds the synchronous response for Google Chat.
// The app is a Chat app in Workspace add-on mode: the response must be a DataActions
// object, not a plain { text }. Empty text -> no action (non-MESSAGE events), so we
// don't try to post an empty message.
function chatResponse_(text) {
  let body;
  if (text) {
    body = {
      dataActions: [
        { chatDataActionMarkup: { createMessageAction: { message: { text: text } } } }
      ]
    };
  } else {
    body = {};
  }
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

// Queue worker, launched by the recurring trigger (created by setupChatApp).
// Iterates over all pending jobs, runs them and removes them. It runs in the
// trigger's authorized context, so it is reliable (unlike triggers created at runtime).
function processQueue_() {
  // Lock: a job (search + carousel render) can take more than 60s, but the trigger
  // fires every minute. Without a lock, the next tick would find the same job still
  // queued (removed only when done) and reprocess it => DOUBLE draft/captions.
  // tryLock(0): if another worker is already running, exit immediately (retry next tick).
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('processQueue_: a worker is already running, skipping this tick.');
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const all = props.getProperties();
    for (const k in all) {
      if (k.indexOf('job_') !== 0) continue;
      let job = null;
      try {
        job = JSON.parse(all[k]);
      } catch (e) {
        props.deleteProperty(k);  // unreadable job: discard it
        continue;
      }
      // Claim the job by removing it BEFORE processing: even if two workers somehow
      // ran together, the job would be taken only once.
      props.deleteProperty(k);
      try {
        runJob_(job);
      } catch (err) {
        Logger.log('processQueue_ error on ' + k + ': ' + (err && err.message ? err.message : err));
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// Testable core: runs runAgentLoop for a job, saves the history, posts the result.
// Returns { ok } or { error }. Uses the job thread's history.
function runJob_(job) {
  const threadId = job.space || job.thread;  // per-SPACE history (survives thread changes)
  const history  = getThreadHistory_(threadId);
  Logger.log('runJob_: space=' + job.space + ' thread=' + job.thread);

  setChatContext_(job.space, job.thread);  // where generate_post_* tools post the draft
  const result = runAgentLoop(job.text, history);

  if (result.error) {
    Logger.log('runJob_: runAgentLoop ERROR: ' + result.error);
    const postErr = postMessage_(job.space, job.thread, 'Sorry, I hit a problem: ' + result.error);
    Logger.log('runJob_: posting (error) result: ' + JSON.stringify(postErr));
    return { error: 'runAgentLoop: ' + result.error };
  }

  Logger.log('runJob_: runAgentLoop OK, text length=' + (result.text || '').length);

  // saveThreadHistory_ filters to text turns only.
  saveThreadHistory_(threadId, result.history);

  const post = postMessage_(job.space, job.thread, result.text);
  Logger.log('runJob_: posting result: ' + JSON.stringify(post));
  return { ok: true };
}

var WEEKLY_TRIGGER_PROMPT_ = 'It is the start of the week. Propose ONE post idea for this week, ' +
  'choosing the most sensible type yourself (News, Event or Hiring). Briefly explain the angle and ' +
  'why it is worth publishing. Do not prepare the content yet: wait until we agree on the idea.';

// Weekly trigger handler: the agent proactively proposes in a new thread.
// Returns { ok } or { error }.
function weeklyProposal_() {
  const spaceName = PropertiesService.getScriptProperties().getProperty('CHAT_SPACE');
  if (!spaceName) {
    return { error: 'CHAT_SPACE not set in Script Properties' };
  }

  setChatContext_(spaceName, null);  // generate_post_* tools will post into the space
  const result = runAgentLoop(WEEKLY_TRIGGER_PROMPT_, []);
  if (result.error) {
    return { error: 'runAgentLoop: ' + result.error };
  }

  // New thread: threadName null -> postMessage_ creates a new one.
  const post = postMessage_(spaceName, null, result.text);
  if (post.error) {
    return { error: 'posting: ' + post.error };
  }

  // Save the per-space history so the team's confirmation finds it (see runJob_).
  saveThreadHistory_(spaceName, result.history);
  return { ok: true };
}

// Run ONCE by hand from the editor (authorized context -> triggers can fire).
// Creates: (1) the queue worker every minute, (2) the Monday 08:00 proposal.
function setupChatApp() {
  // Remove any pre-existing triggers for our handlers, for idempotency.
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const fn = triggers[i].getHandlerFunction();
    if (fn === 'weeklyProposal_' || fn === 'processQueue_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Queue worker: every minute, drain pending messages and post the replies.
  ScriptApp.newTrigger('processQueue_')
    .timeBased()
    .everyMinutes(1)
    .create();

  // Proactive proposal: Monday morning. Adjust the timezone in appsscript.json.
  ScriptApp.newTrigger('weeklyProposal_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();

  Logger.log('Triggers created: processQueue_ every minute + weeklyProposal_ Monday 08:00.');
}

// Public wrapper to run the weekly proposal by hand from the editor
// (the Run menu may not list functions ending with "_").
function testWeeklyProposal() {
  const result = weeklyProposal_();
  Logger.log('testWeeklyProposal result: ' + JSON.stringify(result));
  return result;
}
