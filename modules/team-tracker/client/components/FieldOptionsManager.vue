<template>
  <div>
    <!-- List view -->
    <div v-if="!selectedOption && !showCreate && !showCreateNew">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Field Option Sets</h3>
        <div class="flex gap-2">
          <button
            @click="showCreateNew = true"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Create New
          </button>
          <button
            v-if="eligibleFields.length > 0"
            @click="showCreate = true"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 transition-colors"
          >
            Create from Existing Field
          </button>
        </div>
      </div>
      <div v-if="loading" class="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      <div v-else-if="options.length === 0" class="space-y-4">
        <p class="text-sm text-gray-500 dark:text-gray-400">
          No field option sets configured.
        </p>
        <div v-if="eligibleFields.length > 0" class="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <h4 class="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">Create a Shared Option Set</h4>
          <p class="text-sm text-blue-700 dark:text-blue-300 mb-3">
            Convert an existing field's values into a shared option set that can be used across both person and team fields.
          </p>
          <button
            @click="showCreate = true"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
          >
            Create from Existing Field
          </button>
        </div>
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Label</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Values</th>
            </tr>
          </thead>
          <tbody class="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            <tr
              v-for="opt in options"
              :key="opt.name"
              @click="selectOption(opt.name)"
              class="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
            >
              <td class="px-4 py-3 text-sm whitespace-nowrap">
                <span class="font-medium text-primary-600 dark:text-primary-400">{{ opt.label }}</span>
                <span
                  v-if="opt.source"
                  class="ml-2 inline-flex items-center px-1.5 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded"
                >{{ opt.source === 'jira' ? 'Jira' : opt.source }}</span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{{ opt.name }}</td>
              <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 text-right whitespace-nowrap">{{ opt.count }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create from existing field flow -->
    <div v-if="showCreate">
      <div class="flex items-center gap-3 mb-4">
        <button
          @click="resetCreate"
          class="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
        >
          &larr; Back
        </button>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Field Option Set</h3>
      </div>

      <!-- Step 1: Pick source field -->
      <div v-if="!createPreview" class="space-y-4">
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Select a field to extract its values into a shared option set. The field will be converted
          to use the shared options, and you can optionally create a matching field on the other scope.
        </p>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Field</label>
          <select
            v-model="createSourceFieldId"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          >
            <option value="">Select a field...</option>
            <optgroup label="Person Fields">
              <option v-for="f in eligiblePersonFields" :key="f.id" :value="f.id">
                {{ f.label }} ({{ f.type }}{{ f.multiValue ? ', multi' : '' }})
              </option>
            </optgroup>
            <optgroup label="Team Fields">
              <option v-for="f in eligibleTeamFields" :key="f.id" :value="f.id">
                {{ f.label }} ({{ f.type }}{{ f.multiValue ? ', multi' : '' }})
              </option>
            </optgroup>
          </select>
        </div>
        <button
          @click="loadPreview"
          :disabled="!createSourceFieldId || previewLoading"
          class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg v-if="previewLoading" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          {{ previewLoading ? 'Loading...' : 'Preview' }}
        </button>
      </div>

      <!-- Step 2: Preview and configure -->
      <div v-else class="space-y-4">
        <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
          <div class="text-sm">
            <span class="font-medium text-gray-700 dark:text-gray-300">Source:</span>
            <span class="ml-1 text-gray-900 dark:text-gray-100">{{ createPreview.field.label }}</span>
            <span class="ml-1 text-gray-500 dark:text-gray-400">({{ createPreview.scope }}-level)</span>
          </div>
          <div class="text-sm">
            <span class="font-medium text-gray-700 dark:text-gray-300">Values found:</span>
            <span class="ml-1 text-gray-900 dark:text-gray-100">{{ createPreview.uniqueValues.length }}</span>
            <span class="ml-1 text-gray-500 dark:text-gray-400">across {{ createPreview.recordCount }} records</span>
          </div>
          <div v-if="createPreview.uniqueValues.length > 0" class="mt-2">
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="val in createPreview.uniqueValues"
                :key="val"
                class="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded"
              >
                {{ val }}
              </span>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Option Set Name</label>
            <input
              v-model="createName"
              type="text"
              placeholder="e.g. components"
              class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Lowercase, hyphens, underscores only</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Display Label</label>
            <input
              v-model="createLabel"
              type="text"
              placeholder="e.g. Components"
              class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>

        <!-- Counterpart field option -->
        <div class="p-4 border border-gray-200 dark:border-gray-700 rounded-lg space-y-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              v-model="createCounterpart"
              class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
            />
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
              Also create a {{ createPreview.scope === 'person' ? 'team' : 'person' }}-level field using these options
            </span>
          </label>

          <div v-if="createCounterpart" class="ml-6 space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {{ createPreview.scope === 'person' ? 'Team' : 'Person' }} Field Label
              </label>
              <input
                v-model="counterpartLabel"
                type="text"
                :placeholder="createLabel"
                class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
              />
            </div>

            <label v-if="createPreview.scope === 'person'" class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                v-model="seedFromMembers"
                class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
              />
              <span class="text-sm text-gray-700 dark:text-gray-300">
                Pre-populate each team's values from its current members
              </span>
            </label>
          </div>
        </div>

        <div class="flex gap-2">
          <button
            @click="createPreview = null"
            class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
          >
            Back
          </button>
          <button
            @click="executeCreate"
            :disabled="!createName || !createLabel || executing"
            class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <svg v-if="executing" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            {{ executing ? 'Creating...' : 'Create Option Set' }}
          </button>
        </div>

        <p v-if="createResult" class="text-sm" :class="createError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
          {{ createResult }}
        </p>
      </div>
    </div>

    <!-- Create new (empty) option set -->
    <div v-if="showCreateNew">
      <div class="flex items-center gap-3 mb-4">
        <button
          @click="resetCreateNew"
          class="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
        >
          &larr; Back
        </button>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Create New Option Set</h3>
      </div>

      <div class="space-y-4">
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Create an empty option set. You can add values after creation.
        </p>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Option Set Name</label>
            <input
              v-model="newSetName"
              type="text"
              placeholder="e.g. regions"
              class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Lowercase, hyphens, underscores only</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Display Label</label>
            <input
              v-model="newSetLabel"
              type="text"
              placeholder="e.g. Regions"
              class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
        <button
          @click="executeCreateNew"
          :disabled="!newSetName || !newSetLabel || executingNew"
          class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {{ executingNew ? 'Creating...' : 'Create Option Set' }}
        </button>
        <p v-if="createNewResult" class="text-sm" :class="createNewError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
          {{ createNewResult }}
        </p>
      </div>
    </div>

    <!-- Detail view -->
    <div v-if="selectedOption && !showCreate">
      <div class="flex items-center gap-3 mb-4">
        <button
          @click="selectedOption = null"
          class="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
        >
          &larr; Back
        </button>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {{ detail?.label || selectedOption }}
        </h3>
      </div>

      <!-- External source banner -->
      <div v-if="detail?.source" class="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg flex items-start gap-2">
        <svg class="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="flex-1 text-sm text-blue-700 dark:text-blue-300">
          <p class="font-medium">Managed by {{ detail.source === 'jira' ? 'Jira' : detail.source }}</p>
          <p>
            This option set is synced from
            <template v-if="detail.sourceProject">
              project <span class="font-medium">{{ detail.sourceProject }}</span>
              <template v-if="detail.sourceConfig?.entityType"> ({{ detail.sourceConfig.entityType }})</template>.
            </template>
            <template v-else>an external source.</template>
            Values are updated automatically and cannot be manually edited.
            <template v-if="detail.syncedAt"> Last synced {{ formatSyncDate(detail.syncedAt) }}.</template>
          </p>
          <div class="flex gap-2 mt-2">
            <button
              @click="triggerSync"
              :disabled="syncing"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-800/40 border border-blue-300 dark:border-blue-700 rounded hover:bg-blue-200 dark:hover:bg-blue-800/60 disabled:opacity-50 transition-colors"
            >
              <svg v-if="syncing" class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ syncing ? 'Syncing...' : 'Sync Now' }}
            </button>
            <button
              @click="confirmUnlink"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
            >
              Unlink
            </button>
          </div>
          <p v-if="syncResult" class="mt-1 text-xs" :class="syncError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
            {{ syncResult }}
          </p>
        </div>
      </div>

      <!-- Link to Jira button (only for manually-managed sets) -->
      <div v-if="!detail?.source && !detailLoading" class="mb-4">
        <button
          @click="openLinkWizard"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          <svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          Link to Jira
        </button>
      </div>

      <!-- Orphaned values warning -->
      <div v-if="detail?.orphanedValues?.length > 0" class="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
        <h4 class="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-1">
          {{ detail.orphanedValues.length }} orphaned value{{ detail.orphanedValues.length !== 1 ? 's' : '' }}
        </h4>
        <p class="text-sm text-yellow-700 dark:text-yellow-300 mb-2">
          These values were removed from the source but are still assigned to people or teams.
        </p>
        <div class="flex flex-wrap gap-1.5 mb-2">
          <span
            v-for="val in detail.orphanedValues"
            :key="val"
            class="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-yellow-100 dark:bg-yellow-800/40 text-yellow-800 dark:text-yellow-200 rounded"
          >
            {{ val }}
          </span>
        </div>
        <button
          @click="openMigrationFlow"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-yellow-800 dark:text-yellow-200 bg-yellow-100 dark:bg-yellow-800/40 border border-yellow-300 dark:border-yellow-700 rounded-md hover:bg-yellow-200 dark:hover:bg-yellow-800/60 transition-colors"
        >
          Map to current values
        </button>
      </div>

      <!-- Jira component mapping warnings (specific to "components" option set) -->
      <div v-if="selectedOption === 'components' && !detail?.source && jiraWarnings.length > 0" class="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
        <h4 class="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-1">Jira Component Mapping Warnings</h4>
        <ul class="text-sm text-yellow-700 dark:text-yellow-300 list-disc list-inside space-y-0.5">
          <li v-for="w in jiraWarnings" :key="w">{{ w }}</li>
        </ul>
      </div>

      <div v-if="detailLoading" class="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      <template v-else>
        <!-- Add new values (hidden for externally-managed sets) -->
        <div v-if="!detail?.source" class="flex gap-2 mb-4">
          <input
            v-model="newValue"
            @keyup.enter="addValue"
            type="text"
            placeholder="Add a new value..."
            class="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <button
            @click="addValue"
            :disabled="!newValue.trim()"
            class="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>

        <!-- Search -->
        <div v-if="(detail?.values || []).length > 5" class="relative mb-3">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            v-model="optionSearch"
            type="text"
            placeholder="Search options..."
            class="w-full pl-10 pr-4 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>

        <!-- Values list -->
        <div v-if="(detail?.values || []).length === 0" class="text-sm text-gray-500 dark:text-gray-400">
          No values in this option set.
        </div>
        <div v-else-if="filteredValues.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
          No options match "{{ optionSearch }}"
        </div>
        <ul v-else class="space-y-1">
          <li
            v-for="val in filteredValues"
            :key="val"
            class="flex items-center justify-between px-3 py-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 group"
          >
            <!-- Rename mode (only for manually-managed sets) -->
            <template v-if="!detail?.source && renamingValue === val">
              <div class="flex items-center gap-2 flex-1 mr-2">
                <input
                  v-model="renameInput"
                  type="text"
                  class="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  @keyup.enter="executeRename"
                  @keyup.escape="cancelRename"
                />
                <button
                  @click="executeRename"
                  :disabled="!renameInput.trim() || renameInput.trim() === val || renaming"
                  class="px-2 py-1 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >{{ renaming ? 'Saving...' : 'Save' }}</button>
                <button
                  @click="cancelRename"
                  class="px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >Cancel</button>
              </div>
            </template>
            <!-- Display mode -->
            <template v-else>
              <span class="text-sm text-gray-900 dark:text-gray-100">{{ val }}</span>
              <div v-if="!detail?.source" class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  @click="startRename(val)"
                  class="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  Rename
                </button>
                <button
                  @click="confirmRemove(val)"
                  class="text-sm text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  Remove
                </button>
              </div>
            </template>
          </li>
        </ul>
        <p v-if="renameResult" class="mt-2 text-sm" :class="renameError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
          {{ renameResult }}
        </p>
      </template>
    </div>

    <!-- Migration mapping modal -->
    <div v-if="showMigration" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="showMigration = false">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[80vh] overflow-y-auto">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Map Orphaned Values</h3>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Map old values to current values, or choose to clear them. You can apply some now and come back for the rest later.
        </p>

        <div v-if="migrationLoading" class="text-sm text-gray-500 dark:text-gray-400 py-4">Loading usage data...</div>
        <template v-else>
          <div class="space-y-4">
            <div
              v-for="val in migrationPreview?.orphanedValues || []"
              :key="val"
              class="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg"
            >
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ val }}</span>
                <span class="text-xs text-gray-500 dark:text-gray-400">
                  {{ (migrationPreview?.orphanedUsage?.[val]?.people || []).length }} people,
                  {{ (migrationPreview?.orphanedUsage?.[val]?.teams || []).length }} teams
                </span>
              </div>
              <!-- Action selector -->
              <div class="flex gap-1 mt-2 mb-1">
                <button
                  @click="setMigrationAction(val, 'skip')"
                  class="px-2 py-1 text-xs font-medium rounded transition-colors"
                  :class="migrationActions[val] === 'skip'
                    ? 'bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'"
                >Skip for now</button>
                <button
                  @click="setMigrationAction(val, 'map')"
                  class="px-2 py-1 text-xs font-medium rounded transition-colors"
                  :class="migrationActions[val] === 'map'
                    ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'"
                >Map to...</button>
                <button
                  @click="setMigrationAction(val, 'remove')"
                  class="px-2 py-1 text-xs font-medium rounded transition-colors"
                  :class="migrationActions[val] === 'remove'
                    ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'"
                >Remove</button>
              </div>

              <!-- Map: type-ahead search -->
              <div v-if="migrationActions[val] === 'map'" class="relative">
                <input
                  :value="migrationSearchQueries[val] ?? migrationMappings[val] ?? ''"
                  @input="onMigrationInput(val, $event.target.value)"
                  @focus="activeMigrationDropdown = val"
                  @blur="onMigrationBlur(val)"
                  @keydown.down.prevent="migrationHighlights[val] = Math.min((migrationHighlights[val] || 0) + 1, filteredMigrationOptions(val).length - 1)"
                  @keydown.up.prevent="migrationHighlights[val] = Math.max((migrationHighlights[val] || 0) - 1, 0)"
                  @keydown.enter.prevent="selectMigrationOption(val, filteredMigrationOptions(val)[migrationHighlights[val] || 0])"
                  @keydown.escape="activeMigrationDropdown = null"
                  type="text"
                  autocomplete="off"
                  placeholder="Type to search..."
                  class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
                />
                <ul
                  v-if="activeMigrationDropdown === val && filteredMigrationOptions(val).length > 0"
                  class="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 shadow-lg"
                >
                  <li
                    v-for="(opt, idx) in filteredMigrationOptions(val)"
                    :key="opt"
                    @mousedown.prevent="selectMigrationOption(val, { value: opt, label: opt })"
                    @mouseenter="migrationHighlights[val] = idx"
                    class="px-3 py-1.5 text-sm cursor-pointer"
                    :class="(migrationHighlights[val] || 0) === idx
                      ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                      : 'text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-600'"
                  >{{ opt }}</li>
                </ul>
                <p
                  v-if="activeMigrationDropdown === val && (migrationSearchQueries[val] || '') && filteredMigrationOptions(val).length === 0"
                  class="absolute z-10 mt-1 w-full px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg"
                >No values match "{{ migrationSearchQueries[val] }}"</p>
              </div>

              <!-- Remove: warning -->
              <div v-if="migrationActions[val] === 'remove'" class="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300">
                This will remove "{{ val }}" from {{ (migrationPreview?.orphanedUsage?.[val]?.people || []).length }} people and {{ (migrationPreview?.orphanedUsage?.[val]?.teams || []).length }} teams. Their field will be left blank.
              </div>
            </div>
          </div>

          <div class="mt-6 flex items-center justify-between">
            <p v-if="migrationResult" class="text-sm" :class="migrationError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
              {{ migrationResult }}
            </p>
            <div class="flex gap-2 ml-auto">
              <button
                @click="showMigration = false"
                class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
              >Cancel</button>
              <button
                @click="applyMigration"
                :disabled="setMappingsCount === 0 || migrationApplying"
                class="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
              >{{ migrationApplying ? 'Applying...' : `Apply ${setMappingsCount} Change${setMappingsCount !== 1 ? 's' : ''}${removalsCount > 0 ? ` (${removalsCount} removal${removalsCount !== 1 ? 's' : ''})` : ''}` }}</button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Link to Jira wizard modal -->
    <div v-if="showLinkWizard" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="showLinkWizard = false">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[80vh]" :class="linkPreview ? 'overflow-y-auto' : 'overflow-visible'">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Link to Jira</h3>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Connect this option set to a Jira project. Values will be synced automatically and manual editing will be disabled.
        </p>

        <!-- Step 1: Select project and entity type -->
        <div v-if="!linkPreview" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Jira Project</label>
            <div class="relative">
              <input
                v-model="linkProjectQuery"
                type="text"
                placeholder="Type to search Jira projects..."
                autocomplete="off"
                @focus="linkProjectDropdownOpen = true"
                @blur="linkProjectDropdownOpen = false"
                @keydown.down.prevent="linkProjectHighlight = Math.min(linkProjectHighlight + 1, linkProjects.length - 1)"
                @keydown.up.prevent="linkProjectHighlight = Math.max(linkProjectHighlight - 1, 0)"
                @keydown.enter.prevent="selectLinkProject(linkProjects[linkProjectHighlight])"
                @keydown.escape="linkProjectDropdownOpen = false"
                class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
              />
              <svg v-if="linkProjectsLoading" class="absolute right-3 top-2.5 h-4 w-4 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <ul
                v-if="linkProjectDropdownOpen && !linkProjectsLoading && linkProjects.length > 0"
                class="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 shadow-lg"
              >
                <li
                  v-for="(p, idx) in linkProjects"
                  :key="p.key"
                  @mousedown.prevent="selectLinkProject(p)"
                  @mouseenter="linkProjectHighlight = idx"
                  class="px-3 py-2 text-sm cursor-pointer"
                  :class="idx === linkProjectHighlight
                    ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                    : 'text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-600'"
                >
                  <span class="font-medium">{{ p.key }}</span>
                  <span class="text-gray-500 dark:text-gray-400"> — {{ p.name }}</span>
                </li>
              </ul>
              <p v-if="linkProjectDropdownOpen && !linkProjectsLoading && linkProjectQuery && linkProjects.length === 0" class="absolute z-10 mt-1 w-full px-3 py-2 text-sm text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg">
                No projects match "{{ linkProjectQuery }}"
              </p>
              <p v-if="linkProjectsError" class="text-sm text-red-600 dark:text-red-400 mt-1">{{ linkProjectsError }}</p>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Entity Type</label>
            <select
              v-model="linkEntityType"
              class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            >
              <option value="components">Components</option>
            </select>
          </div>

          <div class="flex gap-2">
            <button
              @click="showLinkWizard = false"
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
            >Cancel</button>
            <button
              @click="loadLinkPreview"
              :disabled="!linkProjectKey || !linkEntityType || linkPreviewLoading"
              class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg v-if="linkPreviewLoading" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ linkPreviewLoading ? 'Loading...' : 'Preview' }}
            </button>
          </div>
        </div>

        <!-- Step 2: Preview and confirm -->
        <div v-else class="space-y-4">
          <div class="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg space-y-3">
            <div class="text-sm">
              <span class="font-medium text-gray-700 dark:text-gray-300">Project:</span>
              <span class="ml-1 text-gray-900 dark:text-gray-100">{{ linkPreview.projectKey }}</span>
            </div>
            <div class="text-sm">
              <span class="font-medium text-gray-700 dark:text-gray-300">Entity:</span>
              <span class="ml-1 text-gray-900 dark:text-gray-100">{{ linkPreview.entityType }}</span>
            </div>
            <div class="text-sm">
              <span class="font-medium text-gray-700 dark:text-gray-300">Values from Jira:</span>
              <span class="ml-1 text-gray-900 dark:text-gray-100">{{ linkPreview.values.length }}</span>
            </div>
          </div>

          <!-- Diff summary -->
          <div v-if="linkPreview.diff" class="space-y-2">
            <div v-if="linkPreview.diff.added.length > 0" class="text-sm">
              <span class="font-medium text-green-600 dark:text-green-400">Added ({{ linkPreview.diff.added.length }}):</span>
              <div class="flex flex-wrap gap-1 mt-1">
                <span v-for="v in linkPreview.diff.added" :key="v" class="inline-flex items-center px-1.5 py-0.5 text-xs bg-green-100 dark:bg-green-800/40 text-green-800 dark:text-green-200 rounded">{{ v }}</span>
              </div>
            </div>
            <div v-if="linkPreview.diff.removed.length > 0" class="text-sm">
              <span class="font-medium text-red-600 dark:text-red-400">Removed ({{ linkPreview.diff.removed.length }}):</span>
              <div class="mt-2 space-y-2">
                <div v-for="v in linkPreview.diff.removed" :key="v" class="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2">
                  <div class="flex items-start justify-between gap-2">
                    <span class="font-medium text-red-800 dark:text-red-200">{{ v }}</span>
                    <span v-if="linkPreview.removedSuggestions && linkPreview.removedSuggestions[v]" class="inline-flex items-center gap-1 text-xs text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded whitespace-nowrap" title="Suggested replacement — you can change this in the migration step after linking">
                      <svg class="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                      {{ linkPreview.removedSuggestions[v] }}
                      <svg class="h-3 w-3 flex-shrink-0 text-blue-400 dark:text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </span>
                  </div>
                  <template v-if="linkPreview.removedUsage && linkPreview.removedUsage[v]">
                    <div v-if="linkPreview.removedUsage[v].people.length > 0" class="mt-1 text-xs text-red-700 dark:text-red-300">
                      <span class="font-medium">People:</span> {{ linkPreview.removedUsage[v].people.join(', ') }}
                    </div>
                    <div v-if="linkPreview.removedUsage[v].teams.length > 0" class="mt-1 text-xs text-red-700 dark:text-red-300">
                      <span class="font-medium">Teams:</span> {{ linkPreview.removedUsage[v].teams.join(', ') }}
                    </div>
                  </template>
                  <div v-else class="mt-1 text-xs text-gray-500 dark:text-gray-400">Not assigned to anyone</div>
                </div>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Removed values that are still assigned to people or teams will be flagged as orphaned. You can map them afterward.
              </p>
            </div>
            <div v-if="linkPreview.diff.kept.length > 0" class="text-sm">
              <span class="font-medium text-gray-600 dark:text-gray-400">Unchanged ({{ linkPreview.diff.kept.length }}):</span>
              <div class="flex flex-wrap gap-1 mt-1">
                <span v-for="v in linkPreview.diff.kept" :key="v" class="inline-flex items-center px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded">{{ v }}</span>
              </div>
            </div>
          </div>

          <div class="flex gap-2">
            <button
              @click="linkPreview = null"
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
            >Back</button>
            <button
              @click="executeLink"
              :disabled="linkExecuting"
              class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg v-if="linkExecuting" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ linkExecuting ? 'Linking...' : 'Link & Sync' }}
            </button>
          </div>

          <p v-if="linkResult" class="text-sm" :class="linkError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
            {{ linkResult }}
          </p>
        </div>
      </div>
    </div>

    <!-- Unlink confirmation dialog -->
    <div v-if="showUnlinkConfirm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
        <h4 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Unlink from Jira</h4>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
          This will stop syncing values from Jira. Current values will be preserved and you'll be able to edit them manually again.
        </p>
        <div class="flex justify-end gap-2">
          <button
            @click="showUnlinkConfirm = false"
            class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
          >Cancel</button>
          <button
            @click="executeUnlink"
            class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md"
          >Unlink</button>
        </div>
      </div>
    </div>

    <!-- Confirm remove dialog -->
    <div v-if="removeTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
        <h4 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Remove Value</h4>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Are you sure you want to remove "{{ removeTarget }}" from the {{ detail?.label }} option set?
          Existing teams or people with this value will keep it, but it will show as a warning.
        </p>
        <div class="flex justify-end gap-2">
          <button
            @click="removeTarget = null"
            class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
          >
            Cancel
          </button>
          <button
            @click="removeValue"
            class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { apiRequest } from '@shared/client/services/api.js'

// ─── List view state ───
const options = ref([])
const loading = ref(true)
const selectedOption = ref(null)
const detail = ref(null)
const detailLoading = ref(false)
const newValue = ref('')
const removeTarget = ref(null)
const rfeConfig = ref(null)
const optionSearch = ref('')
const renamingValue = ref(null)
const renameInput = ref('')
const renaming = ref(false)
const renameResult = ref(null)
const renameError = ref(false)

// ─── Field definitions for the create flow ───
const fieldDefs = ref({ personFields: [], teamFields: [] })

const eligiblePersonFields = computed(() =>
  (fieldDefs.value.personFields || []).filter(f => !f.deleted && !f.optionsRef)
)
const eligibleTeamFields = computed(() =>
  (fieldDefs.value.teamFields || []).filter(f => !f.deleted && !f.optionsRef)
)
const eligibleFields = computed(() => [...eligiblePersonFields.value, ...eligibleTeamFields.value])

// ─── Create new (empty) state ───
const showCreateNew = ref(false)
const newSetName = ref('')
const newSetLabel = ref('')
const executingNew = ref(false)
const createNewResult = ref(null)
const createNewError = ref(false)

// ─── Create from existing field state ───
const showCreate = ref(false)
const createSourceFieldId = ref('')
const createPreview = ref(null)
const previewLoading = ref(false)
const createName = ref('')
const createLabel = ref('')
const createCounterpart = ref(false)
const counterpartLabel = ref('')
const seedFromMembers = ref(true)
const executing = ref(false)
const createResult = ref(null)
const createError = ref(false)

const filteredValues = computed(() => {
  const vals = detail.value?.values || []
  if (!optionSearch.value.trim()) return vals
  const q = optionSearch.value.toLowerCase()
  return vals.filter(v => v.toLowerCase().includes(q))
})

watch(selectedOption, () => { optionSearch.value = '' })

async function loadOptions() {
  loading.value = true
  try {
    const data = await apiRequest('/modules/team-tracker/field-options')
    options.value = data.options || []
  } catch {
    options.value = []
  } finally {
    loading.value = false
  }
}

async function loadFieldDefs() {
  try {
    const data = await apiRequest('/modules/team-tracker/structure/field-definitions')
    fieldDefs.value = data
  } catch {
    fieldDefs.value = { personFields: [], teamFields: [] }
  }
}

async function selectOption(name) {
  selectedOption.value = name
  detailLoading.value = true
  try {
    detail.value = await apiRequest(`/modules/team-tracker/field-options/${name}`)
    if (name === 'components') {
      try {
        rfeConfig.value = await apiRequest('/modules/team-tracker/rfe-config')
      } catch {
        rfeConfig.value = null
      }
    }
  } catch {
    detail.value = null
  } finally {
    detailLoading.value = false
  }
}

const jiraWarnings = computed(() => {
  if (selectedOption.value !== 'components' || !detail.value?.values || !rfeConfig.value) return []
  const mapping = rfeConfig.value.componentMapping || {}
  const warnings = []
  for (const val of detail.value.values) {
    if (!mapping[val] && Object.keys(mapping).length > 0) {
      warnings.push(`"${val}" has no Jira component mapping — it will be used as-is in RFE queries`)
    }
  }
  return warnings
})

async function addValue() {
  const val = newValue.value.trim()
  if (!val) return
  try {
    await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/values`, {
      method: 'POST',
      body: JSON.stringify({ values: [val] }),
      headers: { 'Content-Type': 'application/json' }
    })
    newValue.value = ''
    await selectOption(selectedOption.value)
    await loadOptions()
  } catch (err) {
    console.error('Failed to add value:', err)
  }
}

function confirmRemove(val) {
  removeTarget.value = val
}

async function removeValue() {
  const val = removeTarget.value
  removeTarget.value = null
  try {
    await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/values`, {
      method: 'DELETE',
      body: JSON.stringify({ values: [val] }),
      headers: { 'Content-Type': 'application/json' }
    })
    await selectOption(selectedOption.value)
    await loadOptions()
  } catch (err) {
    console.error('Failed to remove value:', err)
  }
}

// ─── Link to Jira wizard ───

const showLinkWizard = ref(false)
const linkProjects = ref([])
const linkProjectsLoading = ref(false)
const linkProjectKey = ref('')
const linkProjectQuery = ref('')
const linkProjectDropdownOpen = ref(false)
const linkProjectHighlight = ref(0)
const linkProjectsError = ref('')
const linkEntityType = ref('components')
const linkPreview = ref(null)
const linkPreviewLoading = ref(false)
const linkExecuting = ref(false)
const linkResult = ref(null)
const linkError = ref(false)

// Sync trigger + unlink
const syncing = ref(false)
const syncResult = ref(null)
const syncError = ref(false)
const showUnlinkConfirm = ref(false)

var linkSearchTimer = null
var linkSearchSeq = 0

watch(linkProjectQuery, (val) => {
  linkProjectHighlight.value = 0
  // Clear selection if user edits the text after selecting
  if (linkProjectKey.value) {
    const selected = linkProjects.value.find(p => p.key === linkProjectKey.value)
    if (selected && val !== selected.key + ' \u2014 ' + selected.name) {
      linkProjectKey.value = ''
    } else {
      return // Don't re-search when we just set the display text from selectLinkProject
    }
  }
  // Debounced search
  clearTimeout(linkSearchTimer)
  linkSearchTimer = setTimeout(() => searchLinkProjects(val.trim()), 300)
})

async function searchLinkProjects(query) {
  const seq = ++linkSearchSeq
  linkProjectsLoading.value = true
  linkProjectsError.value = ''
  try {
    const url = query
      ? '/modules/team-tracker/field-options/sync/jira-projects?query=' + encodeURIComponent(query)
      : '/modules/team-tracker/field-options/sync/jira-projects'
    const data = await apiRequest(url)
    if (seq !== linkSearchSeq) return // discard stale response
    linkProjects.value = data.projects || []
    linkProjectDropdownOpen.value = true
  } catch (err) {
    if (seq !== linkSearchSeq) return
    console.error('Failed to search Jira projects:', err)
    linkProjectsError.value = 'Failed to search projects: ' + (err.message || 'unknown error')
  } finally {
    if (seq === linkSearchSeq) linkProjectsLoading.value = false
  }
}

function selectLinkProject(project) {
  if (!project) return
  linkProjectKey.value = project.key
  linkProjectQuery.value = project.key + ' \u2014 ' + project.name
  linkProjectDropdownOpen.value = false
}

async function openLinkWizard() {
  showLinkWizard.value = true
  linkProjectKey.value = ''
  linkProjectQuery.value = ''
  linkProjectDropdownOpen.value = false
  linkProjectHighlight.value = 0
  linkEntityType.value = 'components'
  linkPreview.value = null
  linkResult.value = null
  linkError.value = false
  searchLinkProjects('')
}

async function loadLinkPreview() {
  linkPreviewLoading.value = true
  linkResult.value = null
  linkError.value = false
  try {
    linkPreview.value = await apiRequest(
      `/modules/team-tracker/field-options/${selectedOption.value}/sync/preview?projectKey=${encodeURIComponent(linkProjectKey.value)}&entityType=${encodeURIComponent(linkEntityType.value)}`
    )
  } catch (err) {
    console.error('Link preview failed:', err)
  } finally {
    linkPreviewLoading.value = false
  }
}

async function executeLink() {
  linkExecuting.value = true
  linkResult.value = null
  linkError.value = false
  try {
    const result = await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/sync/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectKey: linkProjectKey.value,
        entityType: linkEntityType.value
      })
    })
    linkResult.value = `Linked to ${result.projectKey} — ${result.valuesCount} values synced.`
    if (result.orphanedValues?.length > 0) {
      linkResult.value += ` ${result.orphanedValues.length} orphaned value(s) need mapping.`
    }
    // Save suggestions from preview for pre-populating migration mappings
    pendingSuggestions.value = (linkPreview.value && linkPreview.value.removedSuggestions) || {}
    const hasOrphans = result.orphanedValues?.length > 0
    setTimeout(async () => {
      showLinkWizard.value = false
      await selectOption(selectedOption.value)
      await loadOptions()
      if (hasOrphans) {
        openMigrationFlow()
      }
    }, 2000)
  } catch (err) {
    linkError.value = true
    linkResult.value = `Failed: ${err.message}`
  } finally {
    linkExecuting.value = false
  }
}

async function triggerSync() {
  syncing.value = true
  syncResult.value = null
  syncError.value = false
  try {
    const result = await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/sync/trigger`, {
      method: 'POST'
    })
    syncResult.value = `Synced ${result.valuesCount} values.`
    if (result.added?.length > 0) syncResult.value += ` ${result.added.length} added.`
    if (result.removed?.length > 0) syncResult.value += ` ${result.removed.length} removed.`
    await selectOption(selectedOption.value)
  } catch (err) {
    syncError.value = true
    syncResult.value = `Sync failed: ${err.message}`
  } finally {
    syncing.value = false
  }
}

function confirmUnlink() {
  showUnlinkConfirm.value = true
}

async function executeUnlink() {
  showUnlinkConfirm.value = false
  try {
    await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/sync/unlink`, {
      method: 'POST'
    })
    await selectOption(selectedOption.value)
    await loadOptions()
  } catch (err) {
    console.error('Unlink failed:', err)
  }
}

// ─── Migration flow (orphaned value mapping) ───

const showMigration = ref(false)
const migrationPreview = ref(null)
const migrationMappings = ref({})
const pendingSuggestions = ref({})
const migrationLoading = ref(false)
const migrationApplying = ref(false)
const migrationResult = ref(null)
const migrationError = ref(false)

const migrationActions = ref({}) // 'skip' | 'map' | 'remove'
const migrationSearchQueries = ref({})
const activeMigrationDropdown = ref(null)
const migrationHighlights = ref({})

function filteredMigrationOptions(val) {
  const q = (migrationSearchQueries.value[val] || '').toLowerCase().trim()
  const options = migrationPreview.value?.currentValues || []
  if (!q) return options
  return options.filter(o => o.toLowerCase().includes(q))
}

function onMigrationInput(val, text) {
  migrationSearchQueries.value[val] = text
  migrationHighlights.value[val] = 0
  activeMigrationDropdown.value = val
  // Clear the mapping — user is searching, hasn't picked yet
  migrationMappings.value[val] = ''
}

function selectMigrationOption(val, opt) {
  if (!opt) return
  if (opt.value === null) {
    migrationMappings.value[val] = null
    migrationSearchQueries.value[val] = ''
  } else {
    const v = typeof opt === 'string' ? opt : opt.value
    migrationMappings.value[val] = v
    migrationSearchQueries.value[val] = v
  }
  activeMigrationDropdown.value = null
}

function onMigrationBlur(val) {
  // Delay to allow mousedown on dropdown items to fire first
  setTimeout(() => {
    if (activeMigrationDropdown.value === val) {
      activeMigrationDropdown.value = null
    }
    // If user blurred without selecting and mapping is empty, reset search text
    if (migrationMappings.value[val] === '') {
      migrationSearchQueries.value[val] = ''
    }
  }, 150)
}

function setMigrationAction(val, action) {
  migrationActions.value[val] = action
  if (action === 'skip') {
    migrationMappings.value[val] = ''
    migrationSearchQueries.value[val] = ''
  } else if (action === 'remove') {
    migrationMappings.value[val] = null
    migrationSearchQueries.value[val] = ''
  } else if (action === 'map') {
    // Restore suggestion if available, otherwise empty
    if (migrationMappings.value[val] === null || migrationMappings.value[val] === '') {
      const serverSuggestions = migrationPreview.value?.suggestions || {}
      const suggestion = serverSuggestions[val] || ''
      const currentValues = new Set(migrationPreview.value?.currentValues || [])
      if (suggestion && currentValues.has(suggestion)) {
        migrationMappings.value[val] = suggestion
        migrationSearchQueries.value[val] = suggestion
      } else {
        migrationMappings.value[val] = ''
        migrationSearchQueries.value[val] = ''
      }
    }
  }
}

const setMappingsCount = computed(() => {
  const orphans = migrationPreview.value?.orphanedValues || []
  return orphans.filter(v => {
    const action = migrationActions.value[v]
    if (action === 'remove') return true
    if (action === 'map' && migrationMappings.value[v] && migrationMappings.value[v] !== '') return true
    return false
  }).length
})

const removalsCount = computed(() => {
  const orphans = migrationPreview.value?.orphanedValues || []
  return orphans.filter(v => migrationActions.value[v] === 'remove').length
})

async function openMigrationFlow() {
  showMigration.value = true
  migrationLoading.value = true
  migrationResult.value = null
  migrationError.value = false
  migrationMappings.value = {}
  migrationSearchQueries.value = {}
  migrationActions.value = {}
  activeMigrationDropdown.value = null
  migrationHighlights.value = {}
  try {
    migrationPreview.value = await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/migrate/preview`)
    const serverSuggestions = migrationPreview.value.suggestions || {}
    const currentValues = new Set(migrationPreview.value.currentValues || [])
    for (const val of migrationPreview.value.orphanedValues || []) {
      const suggestion = serverSuggestions[val] || pendingSuggestions.value[val] || ''
      if (suggestion && currentValues.has(suggestion)) {
        migrationMappings.value[val] = suggestion
        migrationSearchQueries.value[val] = suggestion
        migrationActions.value[val] = 'map'
      } else {
        migrationMappings.value[val] = ''
        migrationSearchQueries.value[val] = ''
        migrationActions.value[val] = 'skip'
      }
    }
    pendingSuggestions.value = {}
  } catch (err) {
    console.error('Migration preview failed:', err)
    showMigration.value = false
  } finally {
    migrationLoading.value = false
  }
}

async function applyMigration() {
  if (setMappingsCount.value === 0) return
  migrationApplying.value = true
  migrationResult.value = null
  migrationError.value = false
  try {
    // Only send mappings for 'map' and 'remove' actions, skip 'skip'
    const cleanMappings = {}
    for (const [oldVal, newVal] of Object.entries(migrationMappings.value)) {
      const action = migrationActions.value[oldVal]
      if (action === 'skip' || action === undefined) continue
      if (action === 'remove') { cleanMappings[oldVal] = null; continue; }
      if (action === 'map' && newVal && newVal !== '') { cleanMappings[oldVal] = newVal; }
    }
    const result = await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/migrate/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mappings: cleanMappings })
    })
    migrationResult.value = `Applied ${result.mappingsApplied} mapping${result.mappingsApplied !== 1 ? 's' : ''}, ${result.updated} record${result.updated !== 1 ? 's' : ''} updated.`
    // Refresh the detail view
    setTimeout(() => {
      showMigration.value = false
      selectOption(selectedOption.value)
    }, 2000)
  } catch (err) {
    migrationError.value = true
    migrationResult.value = `Failed: ${err.message}`
  } finally {
    migrationApplying.value = false
  }
}

function formatSyncDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// ─── Rename flow ───

function startRename(val) {
  renamingValue.value = val
  renameInput.value = val
  renameResult.value = null
  renameError.value = false
}

function cancelRename() {
  renamingValue.value = null
  renameInput.value = ''
}

async function executeRename() {
  const oldVal = renamingValue.value
  const newVal = renameInput.value.trim()
  if (!newVal || newVal === oldVal) return
  renaming.value = true
  renameResult.value = null
  renameError.value = false
  try {
    const result = await apiRequest(`/modules/team-tracker/field-options/${selectedOption.value}/values/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ oldValue: oldVal, newValue: newVal }),
      headers: { 'Content-Type': 'application/json' }
    })
    renameResult.value = `Renamed "${oldVal}" to "${newVal}" (${result.updated} record${result.updated === 1 ? '' : 's'} updated)`
    renamingValue.value = null
    renameInput.value = ''
    await selectOption(selectedOption.value)
  } catch (err) {
    renameError.value = true
    renameResult.value = `Failed: ${err.message}`
  } finally {
    renaming.value = false
  }
}

// ─── Create flow ───

async function loadPreview() {
  previewLoading.value = true
  try {
    const data = await apiRequest(`/modules/team-tracker/structure/migrate/field-to-options/preview?fieldId=${createSourceFieldId.value}`)
    createPreview.value = data
    // Default the name and label from the field label
    const label = data.field.label
    createLabel.value = label
    createName.value = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
    counterpartLabel.value = label
  } catch (err) {
    console.error('Preview failed:', err)
  } finally {
    previewLoading.value = false
  }
}

async function executeCreate() {
  executing.value = true
  createResult.value = null
  createError.value = false
  try {
    const result = await apiRequest('/modules/team-tracker/structure/migrate/field-to-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFieldId: createSourceFieldId.value,
        optionSetName: createName.value,
        optionSetLabel: createLabel.value,
        createCounterpart: createCounterpart.value,
        counterpartLabel: counterpartLabel.value || createLabel.value,
        seedFromMembers: seedFromMembers.value
      })
    })
    createResult.value = `Created "${result.optionSetCreated}" with ${result.valuesExtracted} values.` +
      (result.counterpartFieldCreated ? ' Counterpart field created.' : '') +
      (result.teamsSeeded > 0 ? ` ${result.teamsSeeded} teams pre-populated from members.` : '') +
      (result.valuesConverted > 0 ? ` ${result.valuesConverted} records converted.` : '')
    await loadOptions()
    await loadFieldDefs()
    // Auto-navigate to the new option set after a short delay
    setTimeout(() => {
      resetCreate()
      selectOption(createName.value)
    }, 2000)
  } catch (err) {
    createError.value = true
    createResult.value = `Failed: ${err.message}`
  } finally {
    executing.value = false
  }
}

// ─── Create new (empty) flow ───

async function executeCreateNew() {
  executingNew.value = true
  createNewResult.value = null
  createNewError.value = false
  try {
    await apiRequest(`/modules/team-tracker/field-options/${newSetName.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [], label: newSetLabel.value })
    })
    createNewResult.value = `Created "${newSetLabel.value}" option set.`
    await loadOptions()
    setTimeout(() => {
      const name = newSetName.value
      resetCreateNew()
      selectOption(name)
    }, 1000)
  } catch (err) {
    createNewError.value = true
    createNewResult.value = `Failed: ${err.message}`
  } finally {
    executingNew.value = false
  }
}

function resetCreateNew() {
  showCreateNew.value = false
  newSetName.value = ''
  newSetLabel.value = ''
  createNewResult.value = null
  createNewError.value = false
}

function resetCreate() {
  showCreate.value = false
  createSourceFieldId.value = ''
  createPreview.value = null
  createName.value = ''
  createLabel.value = ''
  createCounterpart.value = false
  counterpartLabel.value = ''
  seedFromMembers.value = true
  createResult.value = null
  createError.value = false
}

onMounted(() => {
  loadOptions()
  loadFieldDefs()
})
</script>
