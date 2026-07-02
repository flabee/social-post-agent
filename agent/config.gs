/**
 * Reads a key from PropertiesService (Script Properties).
 * Throws if the key is missing — never silently return undefined.
 *
 * Secrets and per-deployment values (GCP project, renderer URL, service-account
 * credentials, ...) live ONLY in Script Properties, never in code. See
 * config.example.gs for the full list of keys the agent expects.
 */
function getConfig(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (value === null) {
    throw new Error('Config key not found: ' + key + '. Set it in Script Properties (Project Settings > Script Properties).');
  }
  return value;
}
