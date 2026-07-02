// Manual tests + diagnostics, run from the Apps Script editor (Run menu > pick a
// function, then read the execution log). Tests that need live credentials
// (Vertex AI, Custom Search) SKIP gracefully when they're not configured.

function test_config_getConfig() {
  PropertiesService.getScriptProperties().setProperty('__TEST_KEY__', 'test_value');

  const value = getConfig('__TEST_KEY__');
  if (value !== 'test_value') {
    throw new Error('FAIL: expected "test_value", got "' + value + '"');
  }

  PropertiesService.getScriptProperties().deleteProperty('__TEST_KEY__');
  Logger.log('PASS test_config_getConfig');
}

function test_config_getConfig_missing() {
  try {
    getConfig('KEY_THAT_NEVER_EXISTS');
    throw new Error('FAIL: expected an error, none thrown');
  } catch (e) {
    if (e.message.indexOf('FAIL') === 0) throw e;
    Logger.log('PASS test_config_getConfig_missing: ' + e.message);
  }
}

function test_toolDeclarations_structure() {
  if (!Array.isArray(TOOL_DECLARATIONS)) throw new Error('FAIL: TOOL_DECLARATIONS is not an array');
  if (TOOL_DECLARATIONS.length !== 4) throw new Error('FAIL: expected 4 tools, found ' + TOOL_DECLARATIONS.length);

  const names = TOOL_DECLARATIONS.map(function(t) { return t.name; });
  const expected = ['search_news', 'generate_post_news', 'generate_post_event', 'generate_post_hiring'];
  expected.forEach(function(name) {
    if (names.indexOf(name) === -1) throw new Error('FAIL: missing tool: ' + name);
  });

  TOOL_DECLARATIONS.forEach(function(tool) {
    if (!tool.description) throw new Error('FAIL: missing description in ' + tool.name);
    if (!tool.parameters)  throw new Error('FAIL: missing parameters in ' + tool.name);
    if (!tool.parameters.required || !Array.isArray(tool.parameters.required)) {
      throw new Error('FAIL: missing required[] in ' + tool.name);
    }
  });

  Logger.log('PASS test_toolDeclarations_structure');
}

function test_dispatchTool_unknown() {
  const result = dispatchToolCall_({ name: 'nonexistent_tool', args: {} });
  if (!result.error) throw new Error('FAIL: expected an error for unknown tool');
  Logger.log('PASS test_dispatchTool_unknown: ' + result.error);
}

function test_searchNews_returns_array() {
  // "Live" test: uses Custom Search if configured, otherwise RSS fallback.
  const result = searchNews({ query: 'artificial intelligence', max_results: 2 });
  if (result && result.error) {
    Logger.log('SKIP (search unavailable): ' + result.error);
    return;
  }
  if (!Array.isArray(result)) throw new Error('FAIL: expected array, got: ' + typeof result);
  if (result.length === 0) throw new Error('FAIL: expected at least one result');
  const first = result[0];
  if (!first.title)        throw new Error('FAIL: missing title in result');
  if (!first.url)          throw new Error('FAIL: missing url in result');
  if (!first.published_at) throw new Error('FAIL: missing published_at');
  Logger.log('PASS test_searchNews_returns_array: ' + first.title);
}

function test_searchNews_rss_fallback() {
  // Forces the RSS fallback path.
  const result = searchNewsRss_('artificial intelligence', 3, []);
  if (result && result.error) {
    Logger.log('SKIP (RSS feeds unreachable): ' + result.error);
    return;
  }
  if (!Array.isArray(result)) throw new Error('FAIL: expected array');
  Logger.log('PASS test_searchNews_rss_fallback: ' + result.length + ' results');
}

function test_filterExcluded() {
  const items = [
    { title: 'New model tops benchmarks', url: 'https://example.com/a' },
    { title: 'Record funding round', url: 'https://example.com/b' }
  ];
  const out = filterExcluded_(items, ['https://example.com/a']);
  if (out.length !== 1) throw new Error('FAIL: expected 1 item after exclusion, got ' + out.length);
  if (out[0].url !== 'https://example.com/b') throw new Error('FAIL: wrong item kept');
  Logger.log('PASS test_filterExcluded');
}

function test_runAgentLoop_simple_reply() {
  const result = runAgentLoop('Hi, how are you?', []);
  if (result.error) {
    Logger.log('SKIP test_runAgentLoop_simple_reply: ' + result.error);
    return;
  }
  if (!result.text) throw new Error('FAIL: no text in response');
  if (typeof result.text !== 'string') throw new Error('FAIL: text is not a string');
  Logger.log('PASS test_runAgentLoop_simple_reply: ' + result.text.slice(0, 80));
}

// Diagnostic: reports whether a SYSTEM_PROMPT override exists and how long the
// effective prompt is. Run from the editor and read the log.
function diag_system_prompt() {
  const override = PropertiesService.getScriptProperties().getProperty('SYSTEM_PROMPT');
  const eff = loadSystemPrompt_();
  Logger.log('SYSTEM_PROMPT override set: ' + (override ? 'YES (length ' + override.length + ') — it overrides the code!' : 'no (using the code constant)'));
  Logger.log('Effective prompt: length ' + eff.length);
  Logger.log('--- first 200 chars ---');
  Logger.log(eff.slice(0, 200));
}

// Diagnostic: clears conversation history (hist_* properties) and any queued jobs.
// Useful to start fresh when a conversation gets "stuck".
function diag_reset_history() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let hist = 0, jobs = 0;
  for (const k in all) {
    if (k.indexOf('hist_') === 0) { props.deleteProperty(k); hist++; }
    else if (k.indexOf('job_') === 0) { props.deleteProperty(k); jobs++; }
  }
  Logger.log('Reset done: ' + hist + ' histories and ' + jobs + ' queued jobs removed.');
}

// Diagnostic: live news search. Prints article titles if search works.
function diag_searchNews_live() {
  const props = PropertiesService.getScriptProperties();
  const hasKey = !!props.getProperty('GOOGLE_SEARCH_API_KEY');
  const hasCx  = !!props.getProperty('GOOGLE_SEARCH_CX');
  Logger.log('GOOGLE_SEARCH_API_KEY set: ' + hasKey + ' | GOOGLE_SEARCH_CX set: ' + hasCx + ' (if not, RSS fallback is used)');

  const out = searchNews({ query: 'artificial intelligence', max_results: 3 });

  if (out && out.error) {
    Logger.log('RESULT ERROR: ' + out.error);
    return;
  }
  if (!Array.isArray(out) || out.length === 0) {
    Logger.log('No results (out=' + JSON.stringify(out) + ')');
    return;
  }
  Logger.log('Found ' + out.length + ' results:');
  out.forEach(function(r, i) {
    Logger.log((i + 1) + ') [' + r.source + '] ' + r.title + ' — ' + r.url + (r.image ? '  [IMG]' : '  [no img]'));
  });
}
