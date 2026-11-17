import { defineAsyncComponent, defineComponent, h, inject, onMounted } from 'vue'

export function withTracking(moduleSlug, viewId, loader) {
  const AsyncComp = defineAsyncComponent(loader)
  return defineComponent({
    name: `Tracked_${moduleSlug}_${viewId}`,
    setup(_, { attrs, slots }) {
      const tracker = inject('usageTracker', null)
      onMounted(function () {
        if (tracker) tracker.trackView(moduleSlug, viewId)
      })
      return function () {
        return h(AsyncComp, attrs, slots)
      }
    }
  })
}
