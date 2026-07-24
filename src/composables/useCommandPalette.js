import { ref, computed } from 'vue'
import discoveredNav from 'virtual:nav-discovery'

const ACTIONS = [
  { type: 'action', id: 'toggle-theme', label: 'Toggle Theme', sublabel: 'Switch between light, dark, and system', icon: 'Sun', keywords: ['dark', 'light', 'mode', 'theme'] },
  { type: 'action', id: 'toggle-sidebar', label: 'Toggle Sidebar', sublabel: 'Collapse or expand the sidebar', icon: 'PanelLeftClose', keywords: ['collapse', 'expand', 'sidebar', 'panel'] },
  { type: 'action', id: 'go-settings', label: 'Open Settings', sublabel: 'App configuration', icon: 'Settings', keywords: ['settings', 'config', 'preferences'] },
  { type: 'action', id: 'go-about', label: 'About', sublabel: 'App info and documentation', icon: 'Info', keywords: ['about', 'help', 'docs', 'version'] },
  { type: 'action', id: 'go-home', label: 'Go Home', sublabel: 'Return to the landing page', icon: 'Home', keywords: ['home', 'dashboard', 'landing'] }
]

const MAX_RESULTS = 50
const MIN_SCORE = 50
const HISTORY_KEY = 'orgpulse_search_history'
const MAX_HISTORY = 20

function fuzzyScore(query, text) {
  if (!text) return 0
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  if (lower === q) return 100
  if (lower.startsWith(q)) return 90
  if (lower.includes(q)) return 70
  const tokens = q.split(/[^a-z0-9]+/).filter(t => t.length > 0)
  if (tokens.length > 1 && tokens.every(t => lower.includes(t))) return 60
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++
  }
  if (qi === q.length) return 30 + (q.length / lower.length * 20)
  return 0
}

const TYPE_BONUS = { page: 3, data: 0, action: 1, 'module-search': 5 }
const MAX_KEYWORD_ONLY = 3
const MAX_MODULE_SEARCH_SUGGESTIONS = 4


function scoreItem(query, item) {
  const labelScore = fuzzyScore(query, item.label)
  const rawSublabelScore = fuzzyScore(query, item.sublabel)
  const sublabelScore = rawSublabelScore >= 70 ? rawSublabelScore : 0
  let bestKeywordScore = 0
  let matchedKeyword = null
  if (item.keywords) {
    for (const kw of item.keywords) {
      const s = fuzzyScore(query, kw)
      if (s >= 70 && s > bestKeywordScore) {
        bestKeywordScore = s
        matchedKeyword = kw
      }
    }
  }
  const primaryScore = Math.max(labelScore, sublabelScore)
  const best = Math.max(primaryScore, bestKeywordScore)
  const score = best + (TYPE_BONUS[item.type] || 0)
  const keywordOnly = primaryScore === 0 && bestKeywordScore > 0
  return { score, matchedKeyword: keywordOnly ? matchedKeyword : null, keywordOnly }
}

function isNavItemVisible(item, { isAdmin, roles, isTeamAdmin, isManager, teamDataSource }) {
  if (item.disabled) return false
  if (item.requireCondition === 'in-app-mode' && teamDataSource !== 'in-app') return false
  if (!item.requireRole) return true
  if (isAdmin) return true
  if (roles.includes(item.requireRole)) return true
  if (item.requireRole === 'manager' && (isTeamAdmin || isManager)) return true
  if (item.requireRole === 'team-admin' && isTeamAdmin) return true
  return false
}

function historyKey(scope) {
  if (!scope) return HISTORY_KEY
  return HISTORY_KEY + '::' + scope.slug + '::' + scope.viewId
}

function loadHistory(scope) {
  try {
    const raw = localStorage.getItem(historyKey(scope))
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function persistHistory(history, scope) {
  try { localStorage.setItem(historyKey(scope), JSON.stringify(history)) } catch { /* storage unavailable */ }
}

export function useCommandPalette({ manifests, isAdmin, roles, isTeamAdmin, isManager, teamDataSource, searchIndexItems }) {
  const searchQuery = ref('')
  const selectedIndex = ref(0)
  const searchHistory = ref(loadHistory())
  const historyIndex = ref(-1)
  let pendingQuery = ''
  const scopedModule = ref(null)

  const pageItems = computed(() => {
    const items = []
    const manifestList = manifests.value || manifests
    for (const manifest of manifestList) {
      const navItems = manifest.client?.navItems || []
      for (const item of navItems) {
        if (!isNavItemVisible(item, {
          isAdmin: isAdmin.value ?? isAdmin,
          roles: roles.value ?? roles,
          isTeamAdmin: isTeamAdmin.value ?? isTeamAdmin,
          isManager: isManager.value ?? isManager,
          teamDataSource: teamDataSource.value ?? teamDataSource
        })) continue
        items.push({
          type: 'page',
          id: manifest.slug + '::' + item.id,
          label: item.label,
          sublabel: manifest.name,
          icon: item.icon,
          slug: manifest.slug,
          viewId: item.id,
          keywords: []
        })
      }
    }
    return items
  })

  const dataItems = computed(() => {
    const raw = searchIndexItems?.value ?? searchIndexItems ?? []
    return raw.map((item, idx) => ({
      type: 'data',
      id: (item.module || 'data') + '::data::' + (item.params ? Object.values(item.params).join('-') : idx) + '::' + item.label,
      label: item.label,
      sublabel: item.context,
      module: item.module,
      viewId: item.viewId,
      params: item.params,
      keywords: item.keywords || []
    }))
  })

  const discoveredItems = discoveredNav.map(entry => ({
    type: 'page',
    id: entry.slug + '::tab::' + entry.viewId + '::' + (entry.params.tab || entry.params.report),
    label: entry.label,
    sublabel: entry.context,
    slug: entry.slug,
    viewId: entry.viewId,
    params: entry.params,
    keywords: []
  }))

  const allItems = computed(() => {
    return [...pageItems.value, ...discoveredItems, ...dataItems.value, ...ACTIONS]
  })

  const searchCapableViews = computed(() => {
    const views = []
    const manifestList = manifests.value || manifests
    for (const m of manifestList) {
      if (!m.search?.enabled) continue
      const navItems = m.client?.navItems || []
      const viewList = m.search.views || []
      for (const v of viewList) {
        const navItem = navItems.find(n => n.id === v.viewId)
        views.push({
          slug: m.slug,
          moduleName: m.name,
          viewId: v.viewId,
          viewLabel: navItem?.label || v.viewId,
          paramName: v.paramName || 'q',
          placeholder: v.placeholder || 'Search in ' + m.name + '...',
          keywords: m.search.keywords || []
        })
      }
    }
    return views
  })

  function buildModuleSearchItem(mod, searchTerm) {
    return {
      type: 'module-search',
      id: 'module-search::' + mod.slug + '::' + mod.viewId,
      label: mod.moduleName + ' → ' + mod.viewLabel,
      sublabel: mod.placeholder,
      slug: mod.slug,
      moduleName: mod.moduleName,
      viewId: mod.viewId,
      viewLabel: mod.viewLabel,
      paramName: mod.paramName,
      placeholder: mod.placeholder,
      params: searchTerm ? { [mod.paramName]: searchTerm } : {},
      searchTerm: searchTerm || ''
    }
  }


  function buildModuleSearchSuggestions(query, views) {
    const results = []
    for (const v of views) {
      const nameScore = fuzzyScore(query, v.moduleName)
      const slugScore = fuzzyScore(query, v.slug)
      const viewScore = fuzzyScore(query, v.viewLabel)
      let best = Math.max(nameScore, slugScore, viewScore)
      let matchBonus = 0
      for (const s of [nameScore, slugScore, viewScore]) {
        if (s >= MIN_SCORE) matchBonus++
      }
      for (const kw of v.keywords) {
        const kwScore = fuzzyScore(query, kw)
        best = Math.max(best, kwScore)
        if (kwScore >= MIN_SCORE) matchBonus++
      }
      if (best >= MIN_SCORE) {
        results.push({ score: best + matchBonus, view: v })
      }
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MODULE_SEARCH_SUGGESTIONS)
      .map(r => buildModuleSearchItem(r.view, query))
  }

  const filteredResults = computed(() => {
    if (scopedModule.value) {
      const q = searchQuery.value.trim()
      if (!q) return []
      return [{
        type: 'scoped-go',
        id: 'scoped-go',
        label: 'Go to results',
        slug: scopedModule.value.slug,
        viewId: scopedModule.value.viewId,
        params: { [scopedModule.value.paramName]: q }
      }]
    }

    const q = searchQuery.value.trim()
    if (!q) {
      return []
    }

    const searchQ = q

    const scored = allItems.value
      .map(item => {
        const { score, matchedKeyword, keywordOnly } = scoreItem(searchQ, item)
        return { item, score, matchedKeyword, keywordOnly }
      })
      .filter(entry => entry.score >= MIN_SCORE)
      .sort((a, b) => {
        if (a.keywordOnly !== b.keywordOnly) return a.keywordOnly ? 1 : -1
        return b.score - a.score
      })

    const results = []
    let kwOnlyCount = 0
    for (const entry of scored) {
      if (entry.keywordOnly) {
        if (kwOnlyCount >= MAX_KEYWORD_ONLY) continue
        kwOnlyCount++
      }
      results.push(entry.matchedKeyword ? { ...entry.item, matchedKeyword: entry.matchedKeyword } : entry.item)
      if (results.length >= MAX_RESULTS) break
    }

    const moduleSearchItems = buildModuleSearchSuggestions(q, searchCapableViews.value)
    if (moduleSearchItems.length > 0) {
      results.unshift(...moduleSearchItems)
    }

    return results
  })

  function selectNext() {
    const len = filteredResults.value.length
    if (len === 0) return
    selectedIndex.value = (selectedIndex.value + 1) % len
  }

  function selectPrev() {
    const len = filteredResults.value.length
    if (len === 0) return
    selectedIndex.value = (selectedIndex.value - 1 + len) % len
  }

  function saveQuery(query) {
    const q = (query || '').trim()
    if (!q) return
    const h = searchHistory.value.filter(item => item !== q)
    h.unshift(q)
    if (h.length > MAX_HISTORY) h.length = MAX_HISTORY
    searchHistory.value = h
    persistHistory(h, scopedModule.value)
  }

  function historyPrev() {
    if (searchHistory.value.length === 0) return false
    if (historyIndex.value === -1) pendingQuery = searchQuery.value
    if (historyIndex.value < searchHistory.value.length - 1) {
      historyIndex.value++
      searchQuery.value = searchHistory.value[historyIndex.value]
      return true
    }
    return false
  }

  function historyNext() {
    if (historyIndex.value <= -1) return false
    historyIndex.value--
    if (historyIndex.value === -1) {
      searchQuery.value = pendingQuery
    } else {
      searchQuery.value = searchHistory.value[historyIndex.value]
    }
    return true
  }

  function resetSelection() {
    selectedIndex.value = 0
    searchQuery.value = ''
    historyIndex.value = -1
    pendingQuery = ''
    scopedModule.value = null
    searchHistory.value = loadHistory(null)
  }

  function enterScope(viewConfig, initialQuery) {
    scopedModule.value = {
      slug: viewConfig.slug,
      moduleName: viewConfig.moduleName,
      viewId: viewConfig.viewId,
      viewLabel: viewConfig.viewLabel,
      paramName: viewConfig.paramName,
      placeholder: viewConfig.placeholder
    }
    searchHistory.value = loadHistory(scopedModule.value)
    historyIndex.value = -1
    pendingQuery = ''
    searchQuery.value = initialQuery || ''
    selectedIndex.value = 0
  }

  function exitScope() {
    scopedModule.value = null
    searchHistory.value = loadHistory(null)
    historyIndex.value = -1
    pendingQuery = ''
    searchQuery.value = ''
    selectedIndex.value = 0
  }

  return {
    searchQuery,
    selectedIndex,
    filteredResults,
    allItems,
    searchHistory,
    historyIndex,
    scopedModule,
    selectNext,
    selectPrev,
    resetSelection,
    saveQuery,
    historyPrev,
    historyNext,
    enterScope,
    exitScope
  }
}
