/**
 * config.example.gs — reference for the Script Properties the agent expects.
 *
 * DO NOT commit real values. This file exists only to document the keys and to
 * offer a one-shot helper you can run ONCE from the Apps Script editor to seed
 * your Script Properties. Secrets live ONLY in Script Properties, never in code.
 *
 * To use: copy this file's `setupPropertiesExample` body, replace the
 * placeholders with your real values, run it once from the editor, then remove
 * the real values again (or just set the properties by hand in
 * Project Settings > Script Properties).
 *
 * Keys
 * ----
 *  GCP_PROJECT_ID        Your Google Cloud project id (e.g. "your-gcp-project").
 *  GCP_LOCATION          Vertex AI region (e.g. "europe-west1" or "us-central1").
 *  RENDERER_URL          Base URL of your deployed Cloud Run renderer
 *                        (e.g. "https://social-post-renderer-xxxx.run.app").
 *  CHAT_SA_CREDENTIALS   JSON of a service-account key with the Chat Bot role,
 *                        as a single string. Used to post messages/cards as the app.
 *  CHAT_SPACE            The Chat space to post the weekly proposal into
 *                        (e.g. "spaces/AAAAAAAAAAA").
 *  SYSTEM_PROMPT         (optional) Overrides the built-in system prompt at runtime.
 *                        If unset, the agent uses SYSTEM_PROMPT_TEXT_ from
 *                        system-prompt-text.gs.
 *  GOOGLE_SEARCH_API_KEY (optional) Google Programmable Search / Custom Search API key.
 *                        If set together with GOOGLE_SEARCH_CX, news search uses it;
 *                        otherwise the agent falls back to the built-in RSS feeds.
 *  GOOGLE_SEARCH_CX      (optional) Custom Search engine id (cx).
 */
function setupPropertiesExample() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    GCP_PROJECT_ID: 'your-gcp-project',
    GCP_LOCATION: 'europe-west1',
    RENDERER_URL: 'https://your-renderer-xxxxxxxx.run.app',
    CHAT_SA_CREDENTIALS: '{"client_email":"...","private_key":"..."}',
    CHAT_SPACE: 'spaces/YOUR_SPACE_ID'
    // Optional:
    // SYSTEM_PROMPT: '...',
    // GOOGLE_SEARCH_API_KEY: 'your-custom-search-api-key',
    // GOOGLE_SEARCH_CX: 'your-custom-search-cx'
  });
  Logger.log('Script Properties set. Remember to remove real secrets from this file.');
}
