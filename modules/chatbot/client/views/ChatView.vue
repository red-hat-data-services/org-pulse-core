<template>
  <div class="fixed bottom-6 right-6 z-40 flex flex-col items-end">
    <!-- Chat panel -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 translate-y-4 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 translate-y-4 scale-95"
    >
      <div
        v-if="open"
        class="mb-3 w-[calc(100vw-3rem)] max-w-[400px] h-[min(560px,70vh)] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden"
      >
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div class="flex items-center gap-2">
            <img src="/bot-avatar.png" alt="" class="w-7 h-7" />
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">AI Assistant</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              v-if="messages.length > 0"
              @click="clearMessages"
              title="New conversation"
              class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              @click="open = false"
              class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div ref="messagesContainer" class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <!-- Empty state -->
          <div v-if="messages.length === 0" class="flex flex-col items-center justify-center h-full text-center">
            <img src="/bot-avatar.png" alt="" class="w-14 h-14 mb-3" />
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">Ask me about your team's data</p>
            <div class="space-y-1.5 w-full">
              <button
                v-for="suggestion in suggestions"
                :key="suggestion"
                @click="sendMessage(suggestion)"
                class="block w-full text-left text-xs px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-primary-300 dark:hover:border-primary-600 transition-colors"
              >
                {{ suggestion }}
              </button>
            </div>
          </div>

          <!-- Message list -->
          <template v-for="(msg, i) in messages" :key="i">
            <!-- User -->
            <div v-if="msg.role === 'user'" class="flex justify-end">
              <div class="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm bg-primary-600 text-white text-xs leading-relaxed">
                {{ msg.content }}
              </div>
            </div>

            <!-- Assistant -->
            <div v-else class="flex justify-start">
              <div class="max-w-[90%]">
                <!-- Tool calls -->
                <div v-if="msg.toolCalls?.length" class="mb-1.5 space-y-0.5">
                  <div
                    v-for="(tc, j) in msg.toolCalls"
                    :key="j"
                  >
                    <button
                      @click="toggleToolCall(i, j)"
                      class="flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      <span v-if="tc.status === 'running' || tc.status === 'completing'" class="inline-block w-2.5 h-2.5 border-[1.5px] border-primary-500 border-t-transparent rounded-full animate-spin"></span>
                      <svg v-else class="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <span>{{ formatToolName(tc.tool) }}</span>
                      <span v-if="tc.status === 'done' && tc.duration_ms != null" class="opacity-60">{{ formatDuration(tc.duration_ms) }}</span>
                      <span v-if="tc.arguments && Object.keys(tc.arguments).length" class="opacity-60">{{ expandedToolCalls.has(`${i}-${j}`) ? '▴' : '▾' }}</span>
                    </button>
                    <div
                      v-if="expandedToolCalls.has(`${i}-${j}`) && tc.arguments && Object.keys(tc.arguments).length"
                      class="ml-4 mt-0.5 px-2 py-1 rounded bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-[9px] text-gray-500 dark:text-gray-400 font-mono"
                    >
                      <div v-for="(val, key) in tc.arguments" :key="key">
                        <span class="text-gray-400 dark:text-gray-500">{{ key }}:</span> {{ val }}
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Content -->
                <div
                  v-if="msg.content"
                  class="px-3 py-2 rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-800 text-xs leading-relaxed text-gray-900 dark:text-gray-100 prose prose-xs dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-table:my-1.5 prose-headings:text-xs"
                  v-html="renderMarkdown(msg.content)"
                ></div>

                <!-- Streaming cursor -->
                <div v-else-if="isStreaming && i === messages.length - 1" class="px-3 py-2 rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-800">
                  <span class="inline-block w-1.5 h-3.5 bg-gray-400 dark:bg-gray-500 animate-pulse"></span>
                  <span class="text-[9px] text-gray-400 ml-2">Thinking...</span>
                </div>

                <!-- Trace -->
                <div v-if="msg.trace" class="mt-0.5 px-1.5">
                  <button
                    @click="toggleTrace(i)"
                    class="text-[9px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                  >
                    {{ Math.round(msg.trace.total_ms) }}ms
                    <template v-if="msg.trace.tool_calls_count"> &middot; {{ msg.trace.tool_calls_count }} tool{{ msg.trace.tool_calls_count === 1 ? '' : 's' }}</template>
                    <template v-if="msg.trace.model"> &middot; {{ msg.trace.model }}</template>
                    <span class="ml-0.5 opacity-60">{{ expandedTraces.has(i) ? '▴' : '▾' }}</span>
                  </button>
                  <div v-if="expandedTraces.has(i)" class="mt-1 px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 text-[9px] text-gray-500 dark:text-gray-400 space-y-1">
                    <div class="grid grid-cols-2 gap-x-4 gap-y-0.5">
                      <span>Total</span><span class="text-right">{{ Math.round(msg.trace.total_ms) }}ms</span>
                      <template v-if="msg.trace.gate_ms"><span>Gate</span><span class="text-right">{{ Math.round(msg.trace.gate_ms) }}ms<template v-if="msg.trace.gate_confidence != null"> ({{ (msg.trace.gate_confidence * 100).toFixed(0) }}%)</template></span></template>
                      <template v-if="msg.trace.inference_ms"><span>Inference</span><span class="text-right">{{ Math.round(msg.trace.inference_ms) }}ms</span></template>
                      <template v-if="msg.trace.input_tokens"><span>Input tokens</span><span class="text-right">{{ msg.trace.input_tokens.toLocaleString() }}</span></template>
                      <template v-if="msg.trace.output_tokens"><span>Output tokens</span><span class="text-right">{{ msg.trace.output_tokens.toLocaleString() }}</span></template>
                      <template v-if="msg.trace.effective_tps"><span>Speed</span><span class="text-right">{{ msg.trace.effective_tps }} tok/s</span></template>
                    </div>
                    <div v-if="msg.trace.steps?.length" class="pt-1 border-t border-gray-200 dark:border-gray-700 space-y-0.5">
                      <div v-for="(step, si) in msg.trace.steps" :key="si" class="flex justify-between">
                        <span :class="step.type === 'tool' ? 'pl-2' : 'font-medium'">{{ step.label }}</span>
                        <span>{{ Math.round(step.duration_ms) }}ms</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Error -->
        <div v-if="error" class="mx-4 mb-2 px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p class="text-red-600 dark:text-red-400 text-[10px]">{{ error }}</p>
        </div>

        <!-- Input -->
        <div class="px-3 py-3 border-t border-gray-200 dark:border-gray-700">
          <form @submit.prevent="handleSubmit" class="flex gap-2">
            <input
              ref="inputEl"
              v-model="input"
              :disabled="isStreaming"
              placeholder="Ask about your team..."
              class="flex-1 px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50"
              @keydown.escape="open = false"
            />
            <button
              type="submit"
              :disabled="!input.trim() || isStreaming"
              class="px-3 py-2 bg-primary-600 text-white rounded-xl text-xs font-medium hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </Transition>

    <!-- Floating button -->
    <button
      @click="toggleChat"
      class="w-12 h-12 rounded-full bg-white dark:bg-gray-800 shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center border border-gray-200 dark:border-gray-700"
      :class="{ 'ring-2 ring-primary-400 ring-offset-2 dark:ring-offset-gray-900': open }"
    >
      <img v-if="!open" src="/bot-avatar.png" alt="AI Assistant" class="w-8 h-8" />
      <svg v-else class="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useChat } from '../composables/useChat.js'

const { messages, isStreaming, error, sendMessage, clearMessages } = useChat()
const open = ref(false)
const input = ref('')
const inputEl = ref(null)
const messagesContainer = ref(null)
const expandedTraces = ref(new Set())
const expandedToolCalls = ref(new Set())

const suggestions = [
  'How many story points did we close?',
  'Who has the most GitHub contributions and what\'s their role?',
  'Compare team sizes and cycle times',
  'Show me the Platform team members',
]

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }))
}

function formatToolName(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatDuration(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function toggleToolCall(msgIndex, toolIndex) {
  const key = `${msgIndex}-${toolIndex}`
  const s = new Set(expandedToolCalls.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  expandedToolCalls.value = s
}

function toggleTrace(index) {
  const s = new Set(expandedTraces.value)
  if (s.has(index)) s.delete(index)
  else s.add(index)
  expandedTraces.value = s
}

function toggleChat() {
  open.value = !open.value
}

function handleSubmit() {
  if (!input.value.trim() || isStreaming.value) return
  const text = input.value
  input.value = ''
  sendMessage(text)
}

watch(open, (isOpen) => {
  if (isOpen) {
    nextTick(() => inputEl.value?.focus())
  }
})

watch(
  () => messages.value[messages.value.length - 1]?.content,
  () => {
    nextTick(() => {
      const el = messagesContainer.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

watch(isStreaming, (streaming) => {
  if (!streaming) {
    nextTick(() => inputEl.value?.focus())
  }
})
</script>
