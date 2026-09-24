/**
 * Cyborg data source adapter for roster sync.
 * Validates and parses external Cyborg JSON snapshots into normalized
 * enrichment records keyed by UID.
 *
 * Does NOT import external Python libraries or connect directly to GCS.
 * Reads atomically promoted snapshot files via Org Pulse storage abstractions.
 */

const DEFAULT_SNAPSHOT_KEY = 'team-data/cyborg/enrichment.json';
const MAX_FUTURE_DRIFT_MS = 15 * 60 * 1000; // 15 minutes tolerance for clock drift
const ALLOWED_SNAPSHOT_FIELDS = new Set(['schemaVersion', 'source', 'generatedAt', 'scope', 'people']);
const ALLOWED_SCOPE_FIELDS = new Set(['name', 'type']);
const ALLOWED_PERSON_FIELDS = new Set([
  'uid', 'fullName', 'name', 'email', 'jobTitle', 'title', 'managerUid',
  'teams', 'githubUsername', 'repositories', 'jira', 'slackChannels'
]);

function hasOnlyAllowedFields(value, allowedFields) {
  return Object.keys(value).every(function(key) { return allowedFields.has(key); });
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Normalize a UID for deterministic lookup.
 * Trims whitespace, Unicode-normalizes (NFD), and lowercases.
 *
 * @param {string} uid
 * @returns {string}
 */
function normalizeUid(uid) {
  if (typeof uid !== 'string') return '';
  return uid
    .normalize('NFD')
    .trim()
    .toLowerCase();
}

/**
 * Convert a normalized Cyborg entry into the person shape used by the registry.
 * Cyborg is the complete roster in this mode; no LDAP person is required.
 */
function cyborgEntryToPerson(entry) {
  const teams = Array.isArray(entry.teams) ? [...entry.teams] : [];
  return {
    uid: entry.uid,
    name: entry.name || entry.uid,
    email: entry.email || '',
    title: entry.title || '',
    managerUid: entry.managerUid || null,
    githubUsername: entry.githubUsername || null,
    teams,
    _teamGrouping: teams.length > 0
      ? teams.join(', ')
      : undefined,
    additionalAssignments: teams.length > 1
      ? teams.slice(1).map(function(team) { return { team }; })
      : undefined,
    repositories: Array.isArray(entry.repositories) ? [...entry.repositories] : [],
    jira: Array.isArray(entry.jira) ? entry.jira.map(function(item) { return Object.assign({}, item); }) : [],
    slackChannels: Array.isArray(entry.slackChannels) ? [...entry.slackChannels] : []
  };
}

/**
 * Validate a Cyborg snapshot against schema v1 and freshness constraints.
 *
 * @param {object} snapshot - Raw parsed JSON snapshot
 * @param {object} [options]
 * @param {number} [options.maxStalenessMinutes] - Staleness threshold (0 or undefined disables check)
 * @param {number} [options.now] - Current timestamp (ms) for testing
 * @returns {{ valid: boolean, error?: { code: string, message: string, retryable: boolean, ageMinutes?: number }, entries?: Map }}
 */
function validateSnapshot(snapshot, options) {
  const opts = options || {};
  const now = opts.now !== undefined ? opts.now : Date.now();

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID',
        message: 'Snapshot must be a non-null JSON object',
        retryable: true
      }
    };
  }

  if (!hasOnlyAllowedFields(snapshot, ALLOWED_SNAPSHOT_FIELDS)) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_UNKNOWN_FIELD',
        message: 'Snapshot contains an unsupported top-level field',
        retryable: false
      }
    };
  }

  // Schema version
  if (snapshot.schemaVersion !== 1) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_UNSUPPORTED_VERSION',
        message: 'Unsupported snapshot schemaVersion; only version 1 is supported',
        retryable: false
      }
    };
  }

  // Source identifier
  if (snapshot.source !== 'cyborg') {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_SOURCE',
        message: 'Snapshot source must be "cyborg"',
        retryable: false
      }
    };
  }

  // Timestamp validation
  if (!snapshot.generatedAt || typeof snapshot.generatedAt !== 'string') {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_MISSING_TIMESTAMP',
        message: 'Snapshot missing required generatedAt timestamp',
        retryable: true
      }
    };
  }

  const generatedTime = Date.parse(snapshot.generatedAt);
  const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(snapshot.generatedAt);
  if (isNaN(generatedTime) || !utcTimestamp) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_TIMESTAMP',
        message: 'Snapshot generatedAt is not a valid ISO date string',
        retryable: true
      }
    };
  }

  if (generatedTime > now + MAX_FUTURE_DRIFT_MS) {
    return {
      valid: false,
      error: {
        code: 'SNAPSHOT_FUTURE_TIMESTAMP',
        message: 'Snapshot generatedAt timestamp is unreasonably in the future',
        retryable: true
      }
    };
  }

  // Staleness check
  const ageMs = Math.max(0, now - generatedTime);
  const ageMinutes = ageMs / (60 * 1000);
  if (opts.maxStalenessMinutes && opts.maxStalenessMinutes > 0 && ageMinutes > opts.maxStalenessMinutes) {
    return {
      valid: false,
      error: {
        code: 'SNAPSHOT_STALE',
        message: `Cyborg snapshot is ${Math.round(ageMinutes)}m old, exceeding maximum staleness of ${opts.maxStalenessMinutes}m`,
        retryable: true,
        ageMinutes: Math.round(ageMinutes)
      }
    };
  }

  // Scope validation
  if (!snapshot.scope || typeof snapshot.scope !== 'object' || Array.isArray(snapshot.scope)) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_SCOPE',
        message: 'Snapshot scope must be an object with name and type',
        retryable: true
      }
    };
  }
  if (!hasOnlyAllowedFields(snapshot.scope, ALLOWED_SCOPE_FIELDS)) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_SCOPE',
        message: 'Snapshot scope contains an unsupported field',
        retryable: false
      }
    };
  }
  if (!snapshot.scope.name || typeof snapshot.scope.name !== 'string' || !snapshot.scope.name.trim()) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_SCOPE',
        message: 'Snapshot scope.name must be a non-empty string',
        retryable: true
      }
    };
  }
  if (!snapshot.scope.type || typeof snapshot.scope.type !== 'string' || !snapshot.scope.type.trim()) {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_SCOPE',
        message: 'Snapshot scope.type must be a non-empty string',
        retryable: true
      }
    };
  }

  if ((opts.expectedScopeName && snapshot.scope.name.trim() !== opts.expectedScopeName) ||
      (opts.expectedScopeType && snapshot.scope.type.trim() !== opts.expectedScopeType)) {
    return {
      valid: false,
      error: {
        code: 'SNAPSHOT_SCOPE_MISMATCH',
        message: 'Snapshot scope does not match the configured scope',
        retryable: false
      }
    };
  }

  // People may be an array in the complete-roster contract. The object form
  // remains accepted for the older enrichment snapshot during migration.
  if (!snapshot.people || typeof snapshot.people !== 'object') {
    return {
      valid: false,
      error: {
        code: 'SCHEMA_INVALID_PEOPLE',
        message: 'Snapshot people must be an array or UID-keyed object',
        retryable: true
      }
    };
  }

  const people = Array.isArray(snapshot.people)
    ? snapshot.people.map(function(person) {
      return { key: person && person.uid, person };
    })
    : Object.keys(snapshot.people).map(function(key) {
      return { key, person: snapshot.people[key] };
    });

  if (people.length === 0) {
    return {
      valid: false,
      error: {
        code: 'SNAPSHOT_EMPTY',
        message: 'Snapshot contains no people and was not applied',
        retryable: true
      }
    };
  }
  const peopleMap = new Map();
  const seenNormalizedKeys = new Map(); // normalizedUid -> rawKey

  for (let i = 0; i < people.length; i++) {
    const rawKey = people[i].key;
    const person = people[i].person;
    const normalized = normalizeUid(rawKey);

    if (!normalized) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_UID',
          message: 'Empty or blank UID found in people map',
          retryable: true
        }
      };
    }

    if (seenNormalizedKeys.has(normalized)) {
      return {
        valid: false,
        error: {
          code: 'UID_COLLISION',
          message: 'UID collision detected after normalization',
          retryable: true
        }
      };
    }
    seenNormalizedKeys.set(normalized, rawKey);

    if (!person || typeof person !== 'object' || Array.isArray(person)) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_PERSON_ENTRY',
          message: `Person entry for UID must be an object`,
          retryable: true
        }
      };
    }

    if (!hasOnlyAllowedFields(person, ALLOWED_PERSON_FIELDS)) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_UNKNOWN_FIELD',
          message: 'Person entry contains an unsupported field',
          retryable: false
        }
      };
    }

    if (Array.isArray(snapshot.people) && normalizeUid(person.uid) !== normalized) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_UID',
          message: 'Person uid must be a non-empty string',
          retryable: true
        }
      };
    }

    for (const field of ['fullName', 'name', 'email', 'jobTitle', 'title', 'managerUid']) {
      if (person[field] !== undefined && person[field] !== null && typeof person[field] !== 'string') {
        return {
          valid: false,
          error: {
            code: 'SCHEMA_INVALID_PERSON_FIELD',
            message: `${field} must be a string when provided`,
            retryable: true
          }
        };
      }
    }

    // A direct member of the configured scope may have no descendant team.
    if (!Array.isArray(person.teams)) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_TEAMS',
        message: `Person entry must contain a teams array`,
          retryable: true
        }
      };
    }

    // The legacy UID-keyed enrichment form required at least one team. Keep
    // that validation while the complete array form supports direct members.
    if (!Array.isArray(snapshot.people) && person.teams.length === 0) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_TEAMS',
          message: 'Person entry has no non-empty team names',
          retryable: true
        }
      };
    }

    const cleanTeams = [];
    const seenTeams = new Set();
    for (let t = 0; t < person.teams.length; t++) {
      const teamName = person.teams[t];
      if (typeof teamName !== 'string' || !teamName.trim()) {
        return {
          valid: false,
          error: {
            code: 'SCHEMA_INVALID_TEAMS',
            message: `Team name in teams array must be a non-empty string`,
            retryable: true
          }
        };
      }
      const trimmed = teamName.trim();
      if (!seenTeams.has(trimmed)) {
        seenTeams.add(trimmed);
        cleanTeams.push(trimmed);
      }
    }

    if (person.githubUsername !== undefined &&
        person.githubUsername !== null &&
        (typeof person.githubUsername !== 'string' || !person.githubUsername.trim())) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_GITHUB_USERNAME',
          message: 'githubUsername must be a non-empty string when provided',
          retryable: true
        }
      };
    }

    const optionalStringArrays = ['repositories', 'slackChannels'];
    for (const field of optionalStringArrays) {
      if (person[field] !== undefined &&
          (!Array.isArray(person[field]) || person[field].some(v => typeof v !== 'string' || !v.trim()))) {
        return {
          valid: false,
          error: {
            code: 'SCHEMA_INVALID_OPTIONAL_FIELD',
            message: `${field} must be an array of non-empty strings`,
            retryable: true
          }
        };
      }
    }

    if (person.repositories) {
      const invalidUrl = person.repositories.some(function(value) {
        try {
          const url = new URL(value);
          return url.protocol !== 'https:' && url.protocol !== 'http:';
        } catch {
          return true;
        }
      });
      if (invalidUrl) {
        return {
          valid: false,
          error: {
            code: 'SCHEMA_INVALID_REPOSITORY',
            message: 'repositories must contain valid HTTP or HTTPS URLs',
            retryable: true
          }
        };
      }
    }

    if (person.jira !== undefined &&
        (!Array.isArray(person.jira) || person.jira.some(function(item) {
          return !item || typeof item !== 'object' || Array.isArray(item) ||
            (!item.project && !item.boardId);
        }))) {
      return {
        valid: false,
        error: {
          code: 'SCHEMA_INVALID_JIRA',
          message: 'jira must be an array of objects containing project or boardId',
          retryable: true
        }
      };
    }

    const repositories = uniqueStrings(person.repositories || []);
    const jira = (person.jira || []).map(function(item) { return Object.assign({}, item); });
    const slackChannels = uniqueStrings(person.slackChannels || []);

    const entry = {
      uid: normalized,
      name: String(person.name || person.fullName || '').trim(),
      email: String(person.email || '').trim(),
      title: String(person.title || person.jobTitle || '').trim(),
      managerUid: person.managerUid === null ? null : normalizeUid(person.managerUid || '') || null,
      teams: cleanTeams,
      _teamGrouping: cleanTeams.join(', '),
      githubUsername: typeof person.githubUsername === 'string' && person.githubUsername.trim()
        ? person.githubUsername.trim()
        : null,
      hasGithubUsername: Object.prototype.hasOwnProperty.call(person, 'githubUsername'),
      repositories,
      jira,
      slackChannels
    };

    peopleMap.set(normalized, entry);
  }

  return {
    valid: true,
    entries: peopleMap,
    ageMinutes: Math.round(ageMinutes)
  };
}

/**
 * Fetch and validate Cyborg data through storage abstraction.
 *
 * @param {object} storage - Storage module with readFromStorage
 * @param {object} [cyborgConfig] - Configuration object
 * @param {string} [cyborgConfig.snapshotKey] - Path under storage (default: team-data/cyborg/enrichment.json)
 * @param {number} [cyborgConfig.maxStalenessMinutes] - Freshness limit in minutes
 * @param {object} [testOptions] - Optional options for deterministic testing (e.g. { now })
 * @returns {Promise<object>} Structured result envelope
 */
async function fetchCyborgData(storage, cyborgConfig, testOptions) {
  if (!storage || typeof storage.readFromStorage !== 'function') {
    return {
      status: 'error',
      source: 'cyborg',
      code: 'STORAGE_UNAVAILABLE',
      message: 'Storage reader is not available',
      retryable: true,
      fetchedAt: new Date().toISOString()
    };
  }

  const config = cyborgConfig || {};
  const snapshotKey = (config.snapshotKey || DEFAULT_SNAPSHOT_KEY).trim();

  // Path traversal protection
  if (snapshotKey.includes('..') || snapshotKey.startsWith('/') || snapshotKey.startsWith('\\')) {
    return {
      status: 'error',
      source: 'cyborg',
      code: 'INVALID_SNAPSHOT_KEY',
      message: 'Snapshot key cannot contain path traversal sequences or leading slashes',
      retryable: false,
      fetchedAt: new Date().toISOString()
    };
  }

  let snapshot;
  try {
    snapshot = await storage.readFromStorage(snapshotKey);
  } catch {
    return {
      status: 'error',
      source: 'cyborg',
      code: 'STORAGE_READ_ERROR',
      message: 'Failed to read the Cyborg snapshot from storage',
      retryable: true,
      fetchedAt: new Date().toISOString()
    };
  }

  if (!snapshot) {
    return {
      status: 'error',
      source: 'cyborg',
      code: 'SNAPSHOT_NOT_FOUND',
      message: 'Cyborg snapshot was not found at the configured storage key',
      retryable: true,
      fetchedAt: new Date().toISOString()
    };
  }

  const validation = validateSnapshot(snapshot, {
    maxStalenessMinutes: config.maxStalenessMinutes,
    expectedScopeName: config.scopeName,
    expectedScopeType: config.scopeType,
    now: testOptions?.now
  });

  if (!validation.valid) {
    return {
      status: 'error',
      source: 'cyborg',
      code: validation.error.code,
      message: validation.error.message,
      retryable: validation.error.retryable,
      ageMinutes: validation.error.ageMinutes,
      generatedAt: snapshot.generatedAt || null,
      fetchedAt: new Date().toISOString()
    };
  }

  return {
    status: 'ok',
    source: 'cyborg',
    matchBy: 'uid',
    entries: validation.entries,
    generatedAt: snapshot.generatedAt,
    scope: snapshot.scope,
    metadata: {
      totalEntries: validation.entries.size,
      ageMinutes: validation.ageMinutes
    },
    fetchedAt: new Date().toISOString()
  };
}

module.exports = {
  DEFAULT_SNAPSHOT_KEY,
  normalizeUid,
  cyborgEntryToPerson,
  validateSnapshot,
  fetchCyborgData
};
