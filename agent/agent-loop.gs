var GEMINI_MODEL_ = 'gemini-2.5-flash';
var MAX_TOOL_ROUNDS_ = 10;  // cap on tool rounds per turn, to avoid infinite loops

/**
 * Builds the Vertex AI generateContent endpoint from the project and region set
 * in Script Properties (GCP_PROJECT_ID, GCP_LOCATION).
 * Returns null if either property is missing.
 */
function geminiEndpoint_() {
  const props = PropertiesService.getScriptProperties();
  const project = props.getProperty('GCP_PROJECT_ID');
  const location = props.getProperty('GCP_LOCATION');
  if (!project || !location) return null;
  return 'https://' + location + '-aiplatform.googleapis.com/v1/projects/' + project
       + '/locations/' + location + '/publishers/google/models/' + GEMINI_MODEL_ + ':generateContent';
}

/**
 * Runs the LLM loop for one conversation turn.
 *
 * @param {string} userMessage  - The user's message.
 * @param {Array}  history      - Array of {role, parts} from previous turns.
 * @returns {object} { text: string, history: Array } or { error: string }
 */
function runAgentLoop(userMessage, history) {
  const endpoint = geminiEndpoint_();
  if (!endpoint) {
    return { error: 'GCP_PROJECT_ID and/or GCP_LOCATION not set in Script Properties' };
  }

  const systemPrompt = loadSystemPrompt_();
  const messages = buildMessages_(history, userMessage);

  var anyTool = false;     // whether a tool has already run this turn
  var forcedRetries = 0;   // how many times we forced a tool call
  var forceCall = false;   // if true, next round uses toolConfig=ANY (forces a tool)

  for (let round = 0; round < MAX_TOOL_ROUNDS_; round++) {
    // Vertex AI uses camelCase: systemInstruction, tools.functionDeclarations.
    const requestBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      generationConfig: { temperature: 0.7 }
    };
    // Anti-"announce without acting": force a tool call when the model merely
    // described what it would do instead of doing it.
    if (forceCall) {
      requestBody.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    }
    forceCall = false;

    let resp;
    try {
      // Vertex AI auth: OAuth bearer token of the identity running the script.
      // Requires the cloud-platform scope in appsscript.json and the Vertex AI
      // User role on the project.
      resp = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      });
    } catch (e) {
      return { error: 'Vertex AI unreachable: ' + e.message };
    }

    if (resp.getResponseCode() !== 200) {
      return { error: 'Gemini HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 300) };
    }

    let geminiResp;
    try {
      geminiResp = JSON.parse(resp.getContentText());
    } catch (e) {
      return { error: 'Gemini: non-JSON response: ' + resp.getContentText().slice(0, 200) };
    }

    const candidate = geminiResp.candidates && geminiResp.candidates[0];
    if (!candidate) {
      return { error: 'Gemini: no candidate in response. promptFeedback: ' + JSON.stringify(geminiResp.promptFeedback || {}) };
    }

    const parts = (candidate.content && candidate.content.parts) || [];

    // No parts and the model did not stop normally => something went wrong
    // (e.g. SAFETY or MAX_TOKENS): report it rather than returning empty text.
    if (parts.length === 0 && candidate.finishReason && candidate.finishReason !== 'STOP') {
      return { error: 'Gemini stopped without content. finishReason: ' + candidate.finishReason };
    }

    // If Gemini called one or more tools
    const functionCalls = parts.filter(function(p) { return p.functionCall; });
    if (functionCalls.length > 0) {
      anyTool = true;
      // Add the model's response to the history
      messages.push({ role: 'model', parts: parts });

      // Run every tool call and add the results
      const toolResults = functionCalls.map(function(part) {
        const call   = part.functionCall;
        const result = dispatchToolCall_({ name: call.name, args: call.args || {} });
        Logger.log('[Tool] ' + call.name + ' -> ' + JSON.stringify(result).slice(0, 200));
        // Gemini requires functionResponse.response to be an OBJECT (struct), not an
        // array or primitive: wrap arrays (e.g. search_news) in { results }.
        const responseObj = (result !== null && typeof result === 'object' && !Array.isArray(result))
          ? result
          : { results: result };
        return {
          functionResponse: {
            name: call.name,
            response: responseObj
          }
        };
      });

      // The generativelanguage API accepts only 'user' and 'model' roles:
      // functionResponse parts go back with role 'user', not 'function'.
      messages.push({ role: 'user', parts: toolResults });
      continue;  // next round
    }

    // No tool call: final text response
    const textParts = parts.filter(function(p) { return p.text; });
    const text = textParts.map(function(p) { return p.text; }).join('');

    // Force a tool call (max 2 times) if the model failed to act when it should have:
    //  (a) it only ANNOUNCED an action (searching / one moment / here's a proposal / generating), or
    //  (b) the user gave ASSENT in an ongoing conversation (e.g. "ok generate") but the model
    //      answered in words instead of generating the draft.
    // Patterns are bilingual (English + Italian) so the behaviour survives either UI language.
    const announce = /(one moment|just a moment|let me search|i'?ll search|i'?m searching|i'?ll look|here'?s a proposal|i'?ll propose|give me a moment|now i'?ll|i'?m preparing|generating|un attimo|fammi cerc|sto cercando|ti propongo|preparo |genero )/i.test(text);
    const assent = (history && history.length > 0) &&
        /^\s*(ok|okay|yes|sure|great|perfect|go|go ahead|proceed|generate|make it|approv|confirm|s[iì]|va bene|certo|procedi|vai|genera)\b/i.test(userMessage || '');
    if (!anyTool && forcedRetries < 2 && (announce || assent)) {
      forcedRetries++;
      forceCall = true;
      Logger.log('[Loop] no action (' + (announce ? 'announce' : 'assent') + '), forcing a tool (attempt ' + forcedRetries + ')');
      continue;
    }

    // `messages` already contains: prior history + user message + any tool turns
    // (functionCall/functionResponse). Add the model's final turn so the returned
    // history preserves the full context for subsequent turns.
    messages.push({ role: 'model', parts: parts });

    return { text: text, history: messages };
  }

  return { error: 'Loop ended after ' + MAX_TOOL_ROUNDS_ + ' rounds without a final response' };
}

/**
 * Dispatches a functionCall to the right handler.
 * @param {{ name: string, args: object }} call
 * @returns {object}
 */
function dispatchToolCall_(call) {
  switch (call.name) {
    case 'search_news':        return searchNews(call.args);
    case 'generate_post_news': return generatePostNews_(call.args);
    case 'generate_post_event': return generatePostEvent_(call.args);
    case 'generate_post_hiring': return generatePostHiring_(call.args);
    default:
      return { error: 'Unknown tool: ' + call.name };
  }
}

/**
 * Returns the agent's system prompt.
 * Optional override: if the Script Property SYSTEM_PROMPT is set, it wins.
 * Otherwise uses the built-in constant SYSTEM_PROMPT_TEXT_ (from system-prompt-text.gs).
 */
function loadSystemPrompt_() {
  const stored = PropertiesService.getScriptProperties().getProperty('SYSTEM_PROMPT');
  if (stored) return stored;
  return SYSTEM_PROMPT_TEXT_;
}

/**
 * Builds the `contents` array for the Gemini API from history + the new message.
 */
function buildMessages_(history, userMessage) {
  const messages = history.slice();  // shallow copy
  messages.push({ role: 'user', parts: [{ text: userMessage }] });
  return messages;
}
