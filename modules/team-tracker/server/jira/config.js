/**
 * Jira sync configuration stored on PVC.
 * Manages project key filtering for JQL queries.
 */

const CONFIG_KEY = 'jira-sync-config.json';

async function loadConfig(storage) {
  return await storage.readFromStorage(CONFIG_KEY);
}

async function saveConfig(storage, config) {
  await storage.writeToStorage(CONFIG_KEY, config);
}

async function getProjectKeys(storage) {
  const config = await loadConfig(storage);
  return config?.projectKeys || [];
}

module.exports = { loadConfig, saveConfig, getProjectKeys };
