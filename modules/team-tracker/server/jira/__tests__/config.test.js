import { describe, it, expect, vi } from 'vitest'
import { loadConfig, saveConfig, getProjectKeys } from '../config'

function createMockStorage(data = {}) {
  const store = { ...data }
  return {
    readFromStorage: vi.fn(async (key) => store[key] || null),
    writeToStorage: vi.fn(async (key, value) => { store[key] = value })
  }
}

describe('jira sync config', () => {
  it('loadConfig returns null when no config exists', async () => {
    const storage = createMockStorage()
    expect(await loadConfig(storage)).toBeNull()
  })

  it('loadConfig returns stored config', async () => {
    const config = { projectKeys: ['RHOAIENG'], lastConfigChangedAt: '2026-01-01T00:00:00Z' }
    const storage = createMockStorage({ 'jira-sync-config.json': config })
    expect(await loadConfig(storage)).toEqual(config)
  })

  it('saveConfig writes config to storage', async () => {
    const storage = createMockStorage()
    const config = { projectKeys: ['ODH'], lastConfigChangedAt: '2026-01-01T00:00:00Z' }
    await saveConfig(storage, config)
    expect(storage.writeToStorage).toHaveBeenCalledWith('jira-sync-config.json', config)
  })

  it('getProjectKeys returns empty array when no config', async () => {
    const storage = createMockStorage()
    expect(await getProjectKeys(storage)).toEqual([])
  })

  it('getProjectKeys returns project keys from config', async () => {
    const storage = createMockStorage({
      'jira-sync-config.json': { projectKeys: ['RHOAIENG', 'ODH'] }
    })
    expect(await getProjectKeys(storage)).toEqual(['RHOAIENG', 'ODH'])
  })
})
