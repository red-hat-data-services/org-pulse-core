import { describe, it, expect } from 'vitest'

// enrichPerson is CJS — require it after vitest sets up the module graph
const { enrichPerson } = require('../merge')

function makeSheetsMap(entries) {
  const map = new Map()
  for (const [name, data] of entries) {
    const key = name.toLowerCase().trim()
    if (map.has(key)) {
      const existing = map.get(key)
      if (Array.isArray(existing)) {
        existing.push(data)
      } else {
        map.set(key, [existing, data])
      }
    } else {
      map.set(key, data)
    }
  }
  return map
}

describe('enrichPerson — multi-row _teamGrouping aggregation', () => {
  it('aggregates two different projects from multiple rows', () => {
    const person = { name: 'Alice Smith' }
    const sheetsMap = makeSheetsMap([
      ['alice smith', { _teamGrouping: 'Alpha', sourceSheet: 'Sheet1' }],
      ['alice smith', { _teamGrouping: 'Beta', sourceSheet: 'Sheet1' }]
    ])

    enrichPerson(person, sheetsMap, 'Org')

    expect(person._teamGrouping).toBe('Alpha, Beta')
  })

  it('deduplicates same project from multiple rows', () => {
    const person = { name: 'Bob Jones' }
    const sheetsMap = makeSheetsMap([
      ['bob jones', { _teamGrouping: 'Alpha', sourceSheet: 'Sheet1' }],
      ['bob jones', { _teamGrouping: 'Alpha', sourceSheet: 'Sheet1' }]
    ])

    enrichPerson(person, sheetsMap, 'Org')

    expect(person._teamGrouping).toBe('Alpha')
  })

  it('filters out null _teamGrouping entries', () => {
    const person = { name: 'Carol White' }
    const sheetsMap = makeSheetsMap([
      ['carol white', { _teamGrouping: 'Alpha', sourceSheet: 'Sheet1' }],
      ['carol white', { _teamGrouping: null, sourceSheet: 'Sheet1' }]
    ])

    enrichPerson(person, sheetsMap, 'Org')

    expect(person._teamGrouping).toBe('Alpha')
  })

  it('preserves single-row person unchanged (regression)', () => {
    const person = { name: 'Dave Brown' }
    const sheetsMap = makeSheetsMap([
      ['dave brown', { _teamGrouping: 'Alpha', sourceSheet: 'Sheet1' }]
    ])

    enrichPerson(person, sheetsMap, 'Org')

    expect(person._teamGrouping).toBe('Alpha')
    expect(person.additionalAssignments).toBeUndefined()
  })

  it('preserves single-row comma-separated value unchanged (regression)', () => {
    const person = { name: 'Eve Green' }
    const sheetsMap = makeSheetsMap([
      ['eve green', { _teamGrouping: 'Alpha, Beta', sourceSheet: 'Sheet1' }]
    ])

    enrichPerson(person, sheetsMap, 'Org')

    expect(person._teamGrouping).toBe('Alpha, Beta')
    expect(person.additionalAssignments).toBeUndefined()
  })

  it('strips _teamGrouping from additionalAssignments', () => {
    const person = { name: 'Frank Lee' }
    const sheetsMap = makeSheetsMap([
      ['frank lee', { _teamGrouping: 'Alpha', role: 'Dev', sourceSheet: 'Sheet1' }],
      ['frank lee', { _teamGrouping: 'Beta', role: 'Lead', sourceSheet: 'Sheet1' }]
    ])

    enrichPerson(person, sheetsMap, 'Org')

    expect(person.additionalAssignments).toHaveLength(1)
    expect(person.additionalAssignments[0]).toEqual({ role: 'Lead' })
    expect(person.additionalAssignments[0]._teamGrouping).toBeUndefined()
  })
})
