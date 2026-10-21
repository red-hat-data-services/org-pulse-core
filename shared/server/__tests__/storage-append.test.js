// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { initStorage, appendToStorage, readRawFromStorage, listAllStorageFiles, writeRawToStorage } from '../storage.js'

describe('storage append methods', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'))
    initStorage({ dataDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('appendToStorage', () => {
    it('creates file and appends content', async () => {
      await appendToStorage('test/events.jsonl', '{"line":1}\n')
      const content = await readRawFromStorage('test/events.jsonl')
      expect(content).toBe('{"line":1}\n')
    })

    it('appends to existing file', async () => {
      await appendToStorage('test/events.jsonl', '{"line":1}\n')
      await appendToStorage('test/events.jsonl', '{"line":2}\n')
      const content = await readRawFromStorage('test/events.jsonl')
      expect(content).toBe('{"line":1}\n{"line":2}\n')
    })

    it('creates subdirectories automatically', async () => {
      await appendToStorage('deep/nested/dir/file.txt', 'hello')
      const content = await readRawFromStorage('deep/nested/dir/file.txt')
      expect(content).toBe('hello')
    })

    it('blocks path traversal', async () => {
      await appendToStorage('../escape.txt', 'bad')
      const exists = fs.existsSync(path.join(path.dirname(tmpDir), 'escape.txt'))
      expect(exists).toBe(false)
    })
  })

  describe('readRawFromStorage', () => {
    it('reads raw text without JSON parsing', async () => {
      const text = 'line1\nline2\nline3'
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'test', 'data.txt'), text)
      const content = await readRawFromStorage('test/data.txt')
      expect(content).toBe(text)
    })

    it('returns null for missing files', async () => {
      const content = await readRawFromStorage('nonexistent.txt')
      expect(content).toBeNull()
    })

    it('blocks path traversal', async () => {
      const content = await readRawFromStorage('../../../etc/passwd')
      expect(content).toBeNull()
    })
  })

  describe('writeRawToStorage', () => {
    it('writes raw text without JSON serialization', async () => {
      await writeRawToStorage('test/report.txt', 'Hello World')
      const content = await readRawFromStorage('test/report.txt')
      expect(content).toBe('Hello World')
    })
  })

  describe('listAllStorageFiles', () => {
    it('lists all files including non-JSON', async () => {
      const dir = path.join(tmpDir, 'usage')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'events-2026-10-12.jsonl'), '')
      fs.writeFileSync(path.join(dir, 'report.txt'), '')
      fs.writeFileSync(path.join(dir, 'config.json'), '{}')

      const files = await listAllStorageFiles('usage')
      expect(files).toContain('events-2026-10-12.jsonl')
      expect(files).toContain('report.txt')
      expect(files).toContain('config.json')
    })

    it('returns empty array for missing directory', async () => {
      const files = await listAllStorageFiles('nonexistent')
      expect(files).toEqual([])
    })
  })
})
