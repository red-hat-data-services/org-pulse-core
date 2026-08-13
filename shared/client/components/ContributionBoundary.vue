<template>
  <div>
    <div
      v-if="failed || !resolvedComponent"
      class="p-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg"
    >
      <p class="font-medium text-gray-600 dark:text-gray-300 mb-1">This extension failed to load</p>
      <p>{{ label ? `"${label}" could not be displayed.` : 'The contributed content could not be displayed.' }}</p>
    </div>
    <component :is="resolvedComponent" v-else v-bind="componentProps" />
  </div>
</template>

<script setup>
import { ref, shallowRef, watchEffect, onErrorCaptured, defineAsyncComponent, h } from 'vue'
import { resolveRenderDescriptor } from '../contributions/index.js'

/**
 * Generic fault-isolation wrapper for a contributed component.
 *
 * - Accepts a `render` *descriptor* (not a raw component) so it is
 *   forward-compatible with remote/declarative delivery. The descriptor is
 *   resolved via the shared `resolveRenderDescriptor` (the single `type`
 *   switch). Only `{ type: 'component', load }` is renderable today; anything
 *   else shows the fallback.
 * - A failure to load the async component shows the fallback (async
 *   `errorComponent`).
 * - A runtime error thrown while the contributed component renders is caught
 *   via `onErrorCaptured` and shows the fallback, without breaking the rest of
 *   the host page.
 */
const props = defineProps({
  render: { type: Object, required: true },
  componentProps: { type: Object, default: () => ({}) },
  label: { type: String, default: '' }
})

const failed = ref(false)
const resolvedComponent = shallowRef(null)

const Fallback = {
  name: 'ContributionLoadFallback',
  setup() {
    return () => h(
      'div',
      { class: 'p-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg' },
      'This extension failed to load'
    )
  }
}

const LoadingIndicator = {
  name: 'ContributionLoading',
  setup() {
    return () => h(
      'div',
      { class: 'flex items-center justify-center py-12' },
      h('div', { class: 'animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600' })
    )
  }
}

watchEffect(() => {
  failed.value = false
  const resolved = resolveRenderDescriptor(props.render)
  if (resolved.type === 'component') {
    resolvedComponent.value = defineAsyncComponent({
      loader: resolved.loader,
      loadingComponent: LoadingIndicator,
      errorComponent: Fallback,
      delay: 150,
      timeout: 15000,
      onError(err, retry, fail) {
        console.error(`[contribution] "${props.label || 'unknown'}" failed to load`, err)
        // Give up on load failures/timeouts so the errorComponent (fallback) renders.
        fail()
      }
    })
  } else {
    // Unknown / unsupported descriptor type — degrade gracefully.
    resolvedComponent.value = null
    failed.value = true
  }
})

onErrorCaptured((err) => {
  console.error(`[contribution] "${props.label || 'unknown'}" threw during render`, err)
  failed.value = true
  return false
})
</script>
