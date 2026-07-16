import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createSmartsheetClient } = require('../smartsheet')

describe('createSmartsheetClient', () => {
  it('creates a client with apiToken and default sheetId', () => {
    const client = createSmartsheetClient({ apiToken: 'test-token' })
    expect(client.isConfigured()).toBe(true)
    expect(client.SMARTSHEET_SHEET_ID).toBe('3025228340193156')
    expect(client.discoverReleases).toBeInstanceOf(Function)
    expect(client.discoverReleasesWithFreezes).toBeInstanceOf(Function)
    expect(client.discoverReleasesPartial).toBeInstanceOf(Function)
  })

  it('creates a client with custom sheetId', () => {
    const client = createSmartsheetClient({ apiToken: 'tok', sheetId: 'custom-123' })
    expect(client.SMARTSHEET_SHEET_ID).toBe('custom-123')
  })

  it('coerces undefined apiToken to empty string', () => {
    const client = createSmartsheetClient({ apiToken: undefined })
    expect(client.isConfigured()).toBe(false)
  })

  it('isConfigured returns false with no token', () => {
    const client = createSmartsheetClient({})
    expect(client.isConfigured()).toBe(false)
  })

  it('two instances with different credentials are independent', () => {
    const client1 = createSmartsheetClient({ apiToken: 'tok1', sheetId: 'sheet1' })
    const client2 = createSmartsheetClient({ apiToken: 'tok2', sheetId: 'sheet2' })

    expect(client1.SMARTSHEET_SHEET_ID).toBe('sheet1')
    expect(client2.SMARTSHEET_SHEET_ID).toBe('sheet2')
    expect(client1.isConfigured()).toBe(true)
    expect(client2.isConfigured()).toBe(true)
  })

  it('fetchSheet throws when not configured', async () => {
    const client = createSmartsheetClient({})
    await expect(client.discoverReleases()).rejects.toThrow('not available')
  })
})

describe('SmartSheet regex patterns', () => {
  function buildMockSheet(taskNames) {
    return {
      columns: [
        { title: 'Task Name', id: 1 },
        { title: 'Start', id: 2 }
      ],
      rows: taskNames.map((name, i) => ({
        cells: [
          { columnId: 1, value: name },
          { columnId: 2, value: `2026-0${i + 1}-15T00:00:00` }
        ]
      }))
    }
  }

  function createMockClient(taskNames) {
    const client = createSmartsheetClient({ apiToken: 'test' })
    const mockSheet = buildMockSheet(taskNames)
    const https = require('https')
    vi.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      const res = {
        statusCode: 200,
        on: (event, handler) => {
          if (event === 'data') handler(JSON.stringify(mockSheet))
          if (event === 'end') handler()
        }
      }
      cb(res)
      return { on: () => {}, destroy: () => {} }
    })
    return client
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses dot-separated EA format (3.6.EA1)', async () => {
    const client = createMockClient([
      '3.6.EA1 RHOAI Code Freeze',
      '3.6.EA1 RHOAI RELEASE',
      '3.6.EA2 RHOAI Code Freeze',
      '3.6.EA2 RHOAI RELEASE',
      '3.6 RHOAI Code Freeze',
      '3.6 RHOAI GA'
    ])
    const releases = await client.discoverReleases()
    expect(releases).toHaveLength(1)
    expect(releases[0].version).toBe('3.6')
    expect(releases[0].ea1Target).toBe('2026-02-15')
    expect(releases[0].ea2Target).toBe('2026-04-15')
    expect(releases[0].gaTarget).toBe('2026-06-15')
  })

  it('parses space-separated EA format (3.6 EA1)', async () => {
    const client = createMockClient([
      '3.6 EA1 RHOAI Code Freeze',
      '3.6 EA1 RHOAI RELEASE',
      '3.6 EA2 RHOAI Code Freeze',
      '3.6 EA2 RHOAI RELEASE',
      '3.6 RHOAI Code Freeze',
      '3.6 RHOAI GA'
    ])
    const releases = await client.discoverReleases()
    expect(releases).toHaveLength(1)
    expect(releases[0].version).toBe('3.6')
    expect(releases[0].ea1Target).toBe('2026-02-15')
    expect(releases[0].ea2Target).toBe('2026-04-15')
    expect(releases[0].gaTarget).toBe('2026-06-15')
  })

  it('parses RHAII product variant', async () => {
    const client = createMockClient([
      '3.6 EA1 RHAII Code Freeze',
      '3.6 EA1 RHAII RELEASE',
      '3.6 EA2 RHAII Code Freeze',
      '3.6 EA2 RHAII RELEASE',
      '3.6 RHAII Code Freeze',
      '3.6 RHAII GA'
    ])
    const releases = await client.discoverReleases()
    expect(releases).toHaveLength(1)
    expect(releases[0].version).toBe('3.6')
  })

  it('parses without product prefix', async () => {
    const client = createMockClient([
      '3.6 EA1 Code Freeze',
      '3.6 EA1 RELEASE',
      '3.6 EA2 Code Freeze',
      '3.6 EA2 RELEASE',
      '3.6 Code Freeze',
      '3.6 GA'
    ])
    const releases = await client.discoverReleases()
    expect(releases).toHaveLength(1)
    expect(releases[0].version).toBe('3.6')
  })
})
