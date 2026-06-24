import { describe, it, expect, vi } from 'vitest'

const {
  escapeLdapFilter,
  searchPeople,
  extractAllGithubCandidates,
  extractAllGitlabCandidates,
  pickBestCandidate,
  extractGithubUsername,
  entryToPerson
} = require('../ipa-client')

describe('escapeLdapFilter', () => {
  it('returns empty string for falsy input', () => {
    expect(escapeLdapFilter(null)).toBe('')
    expect(escapeLdapFilter(undefined)).toBe('')
    expect(escapeLdapFilter('')).toBe('')
  })

  it('passes through safe strings unchanged', () => {
    expect(escapeLdapFilter('jdoe')).toBe('jdoe')
    expect(escapeLdapFilter('jane.doe')).toBe('jane.doe')
    expect(escapeLdapFilter('user123')).toBe('user123')
  })

  it('escapes backslash', () => {
    expect(escapeLdapFilter('a\\b')).toBe('a\\5cb')
  })

  it('escapes asterisk', () => {
    expect(escapeLdapFilter('a*b')).toBe('a\\2ab')
  })

  it('escapes parentheses', () => {
    expect(escapeLdapFilter('a(b)c')).toBe('a\\28b\\29c')
  })

  it('escapes NUL byte', () => {
    expect(escapeLdapFilter('a\x00b')).toBe('a\\00b')
  })

  it('escapes multiple special chars', () => {
    expect(escapeLdapFilter('*()\\\x00')).toBe('\\2a\\28\\29\\5c\\00')
  })

  it('converts non-string input to string', () => {
    expect(escapeLdapFilter(42)).toBe('42')
  })
})

describe('searchPeople', () => {
  function makeMockClient(entries) {
    return {
      search: vi.fn(function(_baseDn, opts, cb) {
        var events = {}
        cb(null, {
          on: function(event, handler) {
            events[event] = handler
            if (event === 'end') {
              // Emit entries then end
              setTimeout(function() {
                var limited = entries
                if (opts.sizeLimit) limited = entries.slice(0, opts.sizeLimit)
                for (var i = 0; i < limited.length; i++) {
                  events.searchEntry({
                    attributes: Object.keys(limited[i]).map(function(k) {
                      return { type: k, values: [limited[i][k]] }
                    })
                  })
                }
                events.end()
              }, 0)
            }
          }
        })
      })
    }
  }

  it('returns empty array for empty query', async () => {
    var client = makeMockClient([])
    var results = await searchPeople(client, 'dc=test', '', 10)
    expect(results).toEqual([])
    expect(client.search).not.toHaveBeenCalled()
  })

  it('returns empty array for null query', async () => {
    var results = await searchPeople(makeMockClient([]), 'dc=test', null, 10)
    expect(results).toEqual([])
  })

  it('builds multi-field filter with cn, uid, and mail', async () => {
    var client = makeMockClient([])
    await searchPeople(client, 'dc=test', 'john', 10)
    var searchCall = client.search.mock.calls[0]
    var filter = searchCall[1].filter
    expect(filter).toContain('(cn=*john*)')
    expect(filter).toContain('(uid=*john*)')
    expect(filter).toContain('(mail=*john*)')
    expect(filter).toMatch(/^\(\|/)
  })

  it('passes sizeLimit to search options', async () => {
    var client = makeMockClient([])
    await searchPeople(client, 'dc=test', 'jane', 5)
    var searchCall = client.search.mock.calls[0]
    expect(searchCall[1].sizeLimit).toBe(5)
  })

  it('defaults sizeLimit to 10', async () => {
    var client = makeMockClient([])
    await searchPeople(client, 'dc=test', 'jane')
    var searchCall = client.search.mock.calls[0]
    expect(searchCall[1].sizeLimit).toBe(10)
  })

  it('returns entryToPerson results', async () => {
    var entries = [
      { uid: 'jdoe', cn: 'John Doe', mail: 'jdoe@test.com', title: 'Engineer' }
    ]
    var client = makeMockClient(entries)
    var results = await searchPeople(client, 'dc=test', 'john', 10)
    expect(results).toHaveLength(1)
    expect(results[0].uid).toBe('jdoe')
    expect(results[0].name).toBe('John Doe')
    expect(results[0].email).toBe('jdoe@test.com')
  })

  it('escapes special characters in query', async () => {
    var client = makeMockClient([])
    await searchPeople(client, 'dc=test', 'a*b(c)', 10)
    var filter = client.search.mock.calls[0][1].filter
    expect(filter).toContain('a\\2ab\\28c\\29')
    expect(filter).not.toContain('a*b(c)')
  })
})

describe('extractAllGithubCandidates', () => {
  it('returns empty array when no rhatSocialUrl', () => {
    expect(extractAllGithubCandidates({})).toEqual([])
  })

  it('extracts single GitHub username', () => {
    var entry = { rhatSocialUrl: 'Github->https://github.com/jdoe' }
    expect(extractAllGithubCandidates(entry)).toEqual(['jdoe'])
  })

  it('extracts multiple GitHub candidates from array', () => {
    var entry = {
      rhatSocialUrl: [
        'Github->https://github.com/project-koku',
        'Github->https://github.com/chambridge'
      ]
    }
    expect(extractAllGithubCandidates(entry)).toEqual(['project-koku', 'chambridge'])
  })

  it('ignores non-GitHub social URLs', () => {
    var entry = {
      rhatSocialUrl: [
        'Gitlab->https://gitlab.com/jdoe',
        'Github->https://github.com/jdoe',
        'Twitter->https://twitter.com/jdoe'
      ]
    }
    expect(extractAllGithubCandidates(entry)).toEqual(['jdoe'])
  })

  it('handles trailing slash', () => {
    var entry = { rhatSocialUrl: 'Github->https://github.com/jdoe/' }
    expect(extractAllGithubCandidates(entry)).toEqual(['jdoe'])
  })
})

describe('extractAllGitlabCandidates', () => {
  it('returns empty array when no rhatSocialUrl', () => {
    expect(extractAllGitlabCandidates({})).toEqual([])
  })

  it('extracts GitLab username', () => {
    var entry = { rhatSocialUrl: 'Gitlab->https://gitlab.com/jdoe' }
    expect(extractAllGitlabCandidates(entry)).toEqual(['jdoe'])
  })

  it('extracts multiple GitLab candidates', () => {
    var entry = {
      rhatSocialUrl: [
        'Gitlab->https://gitlab.com/some-group',
        'Gitlab->https://gitlab.com/jdoe'
      ]
    }
    expect(extractAllGitlabCandidates(entry)).toEqual(['some-group', 'jdoe'])
  })
})

describe('pickBestCandidate', () => {
  it('returns null for empty candidates', () => {
    var result = pickBestCandidate([], { uid: 'jdoe', cn: 'John Doe' })
    expect(result).toEqual({ username: null, needsValidation: false })
  })

  it('flags single candidate for validation when it does not match uid/name', () => {
    var result = pickBestCandidate(['project-koku'], { uid: 'chambrid', cn: 'Chris Hambridge' })
    expect(result.username).toBe('project-koku')
    expect(result.needsValidation).toBe(true)
    expect(result.candidates).toEqual(['project-koku'])
  })

  it('accepts single candidate without validation when it matches uid', () => {
    var result = pickBestCandidate(['chambrid'], { uid: 'chambrid', cn: 'Chris Hambridge' })
    expect(result).toEqual({ username: 'chambrid', needsValidation: false })
  })

  it('picks candidate matching uid from multiple options', () => {
    var result = pickBestCandidate(
      ['project-koku', 'chambrid'],
      { uid: 'chambrid', cn: 'Chris Hambridge' }
    )
    expect(result).toEqual({ username: 'chambrid', needsValidation: false })
  })

  it('picks candidate matching firstname+lastname pattern', () => {
    var result = pickBestCandidate(
      ['some-org', 'chrishambridge'],
      { uid: 'chambrid', cn: 'Chris Hambridge' }
    )
    expect(result).toEqual({ username: 'chrishambridge', needsValidation: false })
  })

  it('picks candidate matching first initial + lastname', () => {
    var result = pickBestCandidate(
      ['some-org', 'chambridge'],
      { uid: 'chambrid', cn: 'Chris Hambridge' }
    )
    expect(result).toEqual({ username: 'chambridge', needsValidation: false })
  })

  it('picks candidate matching firstname-lastname pattern', () => {
    var result = pickBestCandidate(
      ['some-org', 'chris-hambridge'],
      { uid: 'chambrid', cn: 'Chris Hambridge' }
    )
    expect(result).toEqual({ username: 'chris-hambridge', needsValidation: false })
  })

  it('flags for validation when no candidate matches heuristics', () => {
    var result = pickBestCandidate(
      ['project-koku', 'cost-management'],
      { uid: 'chambrid', cn: 'Chris Hambridge' }
    )
    expect(result.needsValidation).toBe(true)
    expect(result.candidates).toEqual(['project-koku', 'cost-management'])
  })

  it('is case-insensitive for matching', () => {
    var result = pickBestCandidate(
      ['CHAMBRID'],
      { uid: 'chambrid', cn: 'Chris Hambridge' }
    )
    expect(result).toEqual({ username: 'CHAMBRID', needsValidation: false })
  })
})

describe('entryToPerson - username validation metadata', () => {
  it('attaches _usernameValidation when GitHub candidates are ambiguous', () => {
    var entry = {
      uid: 'chambrid',
      cn: 'Chris Hambridge',
      mail: 'chambrid@redhat.com',
      rhatSocialUrl: ['Github->https://github.com/project-koku']
    }
    var person = entryToPerson(entry)
    expect(person._usernameValidation).toBeDefined()
    expect(person._usernameValidation.github).toEqual(['project-koku'])
    expect(person.githubUsername).toBe('project-koku')
  })

  it('does not attach _usernameValidation when candidate matches uid', () => {
    var entry = {
      uid: 'jdoe',
      cn: 'John Doe',
      mail: 'jdoe@test.com',
      rhatSocialUrl: 'Github->https://github.com/jdoe'
    }
    var person = entryToPerson(entry)
    expect(person._usernameValidation).toBeUndefined()
    expect(person.githubUsername).toBe('jdoe')
  })

  it('does not attach _usernameValidation when no social URLs', () => {
    var entry = { uid: 'jdoe', cn: 'John Doe' }
    var person = entryToPerson(entry)
    expect(person._usernameValidation).toBeUndefined()
    expect(person.githubUsername).toBeNull()
  })
})

describe('extractGithubUsername (backward compat)', () => {
  it('returns username when it matches uid', () => {
    var entry = {
      uid: 'jdoe',
      cn: 'John Doe',
      rhatSocialUrl: 'Github->https://github.com/jdoe'
    }
    expect(extractGithubUsername(entry)).toBe('jdoe')
  })

  it('returns first candidate when ambiguous (legacy behavior)', () => {
    var entry = {
      uid: 'chambrid',
      cn: 'Chris Hambridge',
      rhatSocialUrl: ['Github->https://github.com/project-koku']
    }
    // extractGithubUsername still returns the first candidate for backward compat,
    // but entryToPerson flags it for validation
    expect(extractGithubUsername(entry)).toBe('project-koku')
  })

  it('returns null when no URLs', () => {
    expect(extractGithubUsername({})).toBeNull()
  })
})
