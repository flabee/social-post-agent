// Tests for the Chat front-end and storage layer. Run from the Apps Script editor.

function test_history_empty_for_new_thread() {
  const tid = '__test_thread_empty__';
  PropertiesService.getScriptProperties().deleteProperty('hist_' + tid);
  const h = getThreadHistory_(tid);
  if (!Array.isArray(h)) throw new Error('FAIL: expected array');
  if (h.length !== 0) throw new Error('FAIL: expected empty for new thread, len=' + h.length);
  Logger.log('PASS test_history_empty_for_new_thread');
}

function test_history_append_and_read() {
  const tid = '__test_thread_rw__';
  PropertiesService.getScriptProperties().deleteProperty('hist_' + tid);
  saveThreadHistory_(tid, [
    { role: 'user',  parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hi there' }] }
  ]);
  const h = getThreadHistory_(tid);
  if (h.length !== 2) throw new Error('FAIL: expected 2 turns, got ' + h.length);
  if (h[1].parts[0].text !== 'hi there') throw new Error('FAIL: wrong content');
  PropertiesService.getScriptProperties().deleteProperty('hist_' + tid);
  Logger.log('PASS test_history_append_and_read');
}

function test_history_cap_last_12() {
  const tid = '__test_thread_cap__';
  const turns = [];
  for (let i = 0; i < 20; i++) {
    turns.push({ role: 'user', parts: [{ text: 'm' + i }] });
  }
  saveThreadHistory_(tid, turns);
  const h = getThreadHistory_(tid);
  if (h.length !== 12) throw new Error('FAIL: expected cap at 12, got ' + h.length);
  if (h[0].parts[0].text !== 'm8') throw new Error('FAIL: first turn expected m8, got ' + h[0].parts[0].text);
  if (h[11].parts[0].text !== 'm19') throw new Error('FAIL: last turn expected m19, got ' + h[11].parts[0].text);
  PropertiesService.getScriptProperties().deleteProperty('hist_' + tid);
  Logger.log('PASS test_history_cap_last_12');
}

function test_history_text_turns_only() {
  const tid = '__test_thread_textonly__';
  PropertiesService.getScriptProperties().deleteProperty('hist_' + tid);
  saveThreadHistory_(tid, [
    { role: 'user',  parts: [{ text: 'search news' }] },
    { role: 'model', parts: [{ functionCall: { name: 'search_news', args: {} } }] },
    { role: 'user',  parts: [{ functionResponse: { name: 'search_news', response: { big: 'payload' } } }] },
    { role: 'model', parts: [{ text: 'here is the proposal' }] }
  ]);
  const h = getThreadHistory_(tid);
  if (h.length !== 2) throw new Error('FAIL: expected 2 text turns, got ' + h.length);
  if (h[0].parts[0].text !== 'search news') throw new Error('FAIL: wrong first text');
  if (h[1].parts[0].text !== 'here is the proposal') throw new Error('FAIL: wrong second text');
  PropertiesService.getScriptProperties().deleteProperty('hist_' + tid);
  Logger.log('PASS test_history_text_turns_only');
}

function test_job_put_get_delete() {
  const job = { space: 'spaces/AAA', thread: 'spaces/AAA/threads/T', text: 'hi', userName: 'Sam' };
  const jobId = putJob_(job);
  if (!jobId) throw new Error('FAIL: putJob_ did not return an id');

  const read = getJob_(jobId);
  if (!read) throw new Error('FAIL: getJob_ did not find the job');
  if (read.text !== 'hi') throw new Error('FAIL: wrong text: ' + read.text);
  if (read.space !== 'spaces/AAA') throw new Error('FAIL: wrong space');

  deleteJob_(jobId);
  const after = getJob_(jobId);
  if (after !== null) throw new Error('FAIL: job not removed');
  Logger.log('PASS test_job_put_get_delete');
}

function test_job_get_nonexistent() {
  const r = getJob_('job_does_not_exist');
  if (r !== null) throw new Error('FAIL: expected null for nonexistent job');
  Logger.log('PASS test_job_get_nonexistent');
}

// Guard: with no credentials, must return {error}, not throw.
function test_postMessage_without_credentials() {
  const props = PropertiesService.getScriptProperties();
  const backup = props.getProperty('CHAT_SA_CREDENTIALS');
  props.deleteProperty('CHAT_SA_CREDENTIALS');

  const r = postMessage_('spaces/AAA', null, 'hi');
  props.deleteProperty('CHAT_SA_CREDENTIALS');
  if (backup) props.setProperty('CHAT_SA_CREDENTIALS', backup);

  if (!r || !r.error) throw new Error('FAIL: expected {error} without credentials');
  Logger.log('PASS test_postMessage_without_credentials: ' + r.error);
}

function test_doPost_message_creates_job() {
  const event = {
    type: 'MESSAGE',
    message: {
      text: 'I want a post about the webinar',
      sender: { displayName: 'Sam Rivers' },
      thread: { name: 'spaces/AAA/threads/T1' }
    },
    space: { name: 'spaces/AAA' }
  };

  const resp = doPost({ postData: { contents: JSON.stringify(event) } });
  const body = JSON.parse(resp.getContent());

  // Synchronous NO-OP response: {} (the ack is posted separately via service account).
  if (body.dataActions) throw new Error('FAIL: expected synchronous {}, found dataActions');

  const all = PropertiesService.getScriptProperties().getProperties();
  let found = false;
  for (const k in all) {
    if (k.indexOf('job_') === 0 && JSON.parse(all[k]).text === 'I want a post about the webinar') found = true;
  }
  if (!found) throw new Error('FAIL: no job created for the message');
  Logger.log('PASS test_doPost_message_creates_job');
}

// Workspace add-on format: the message is in chat.messagePayload.
function test_doPost_addon_format_creates_job() {
  const event = {
    chat: {
      user: { displayName: 'Sam Rivers' },
      messagePayload: {
        message: {
          text: 'Add-on post',
          thread: { name: 'spaces/BBB/threads/T9' }
        },
        space: { name: 'spaces/BBB' }
      }
    }
  };

  const resp = doPost({ postData: { contents: JSON.stringify(event) } });
  const body = JSON.parse(resp.getContent());
  if (body.dataActions) throw new Error('FAIL: expected synchronous {} for add-on format');

  const all = PropertiesService.getScriptProperties().getProperties();
  let found = false;
  for (const k in all) {
    if (k.indexOf('job_') === 0 && JSON.parse(all[k]).text === 'Add-on post') found = true;
  }
  if (!found) throw new Error('FAIL: no job created from the add-on format');
  Logger.log('PASS test_doPost_addon_format_creates_job');
}

function test_doPost_non_message_event() {
  const event = { type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' } };
  const resp = doPost({ postData: { contents: JSON.stringify(event) } });
  if (!resp || typeof resp.getContent !== 'function') throw new Error('FAIL: invalid response');
  Logger.log('PASS test_doPost_non_message_event');
}

// processQueue_ must drain the queue: enqueue a fake job and verify it is removed.
// (runJob_ may fail/SKIP without Vertex, but the job must still be removed.)
function test_processQueue_drains() {
  const jobId = putJob_({ space: 'spaces/TESTQ', thread: 'spaces/TESTQ/threads/X', text: 'ping', userName: 'T' });
  processQueue_();
  const after = getJob_(jobId);
  if (after !== null) throw new Error('FAIL: job not removed from the queue');
  Logger.log('PASS test_processQueue_drains');
}

// Guard: without CHAT_SPACE, weeklyProposal_ does not proceed and does not throw.
function test_weeklyProposal_without_space() {
  const props = PropertiesService.getScriptProperties();
  const backup = props.getProperty('CHAT_SPACE');
  props.deleteProperty('CHAT_SPACE');

  const r = weeklyProposal_();
  if (backup) props.setProperty('CHAT_SPACE', backup);

  if (!r || !r.error) throw new Error('FAIL: expected {error} without CHAT_SPACE');
  if (r.error.indexOf('CHAT_SPACE') === -1) throw new Error('FAIL: unexpected error: ' + r.error);
  Logger.log('PASS test_weeklyProposal_without_space');
}
