import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SecretGroupCard from '../components/settings/SecretGroupCard.vue'

const mockApiRequest = vi.fn()

vi.mock('@shared/client/services/api', () => ({
  apiRequest: (...args) => mockApiRequest(...args)
}))

const MASK = '••••••••'

const secrets = [
  { key: 'JIRA_EMAIL', description: 'Jira account email', required: true, configured: true },
  { key: 'JIRA_TOKEN', description: 'Jira API token', required: true, configured: false }
]

async function openModal() {
  const wrapper = mount(SecretGroupCard, { props: { title: 'Jira', secrets } })
  const configure = wrapper.findAll('button').find(b => b.text() === 'Configure')
  await configure.trigger('click')
  await flushPromises()
  return wrapper
}

function input(wrapper, key) {
  return wrapper.find(`input[aria-label="${key}"]`)
}

async function save(wrapper) {
  const button = wrapper.findAll('button').find(b => b.text() === 'Save')
  await button.trigger('click')
  await flushPromises()
}

function sentSecrets() {
  expect(mockApiRequest).toHaveBeenCalledTimes(1)
  const [path, opts] = mockApiRequest.mock.calls[0]
  expect(path).toBe('/admin/secrets/update')
  expect(opts.method).toBe('POST')
  expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
  return JSON.parse(opts.body).secrets
}

describe('SecretGroupCard edit modal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockApiRequest.mockResolvedValue({ success: true })
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pre-fills configured secrets with a mask and leaves unset secrets empty', async () => {
    const wrapper = await openModal()
    expect(input(wrapper, 'JIRA_EMAIL').element.value).toBe(MASK)
    expect(input(wrapper, 'JIRA_TOKEN').element.value).toBe('')
    expect(wrapper.text()).toContain('Delete the masked value to enter a new one')
  })

  it('sends only the changed field and keeps masked fields untouched', async () => {
    const wrapper = await openModal()
    await input(wrapper, 'JIRA_TOKEN').setValue('  new-token  ')
    await save(wrapper)
    expect(sentSecrets()).toEqual({ JIRA_TOKEN: 'new-token' })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('treats a cleared configured field as keep existing', async () => {
    const wrapper = await openModal()
    await input(wrapper, 'JIRA_EMAIL').setValue('')
    expect(wrapper.text()).toContain('Existing value will be kept')
    await input(wrapper, 'JIRA_TOKEN').setValue('tok')
    await save(wrapper)
    expect(sentSecrets()).toEqual({ JIRA_TOKEN: 'tok' })
  })

  it('replaces a configured value when the mask is deleted and a new value typed', async () => {
    const wrapper = await openModal()
    await input(wrapper, 'JIRA_EMAIL').setValue('svc@redhat.com')
    expect(wrapper.text()).toContain('Existing value will be replaced on save')
    await save(wrapper)
    expect(sentSecrets()).toEqual({ JIRA_EMAIL: 'svc@redhat.com' })
  })

  it('reports no changes when every field is masked or blank', async () => {
    const wrapper = await openModal()
    await save(wrapper)
    expect(mockApiRequest).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('No changes to save')
    expect(wrapper.find('.text-red-600').exists()).toBe(false)
  })

  it('rejects a value typed around the mask instead of sending mask characters', async () => {
    const wrapper = await openModal()
    await input(wrapper, 'JIRA_EMAIL').setValue(MASK + 'x')
    await save(wrapper)
    expect(mockApiRequest).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('JIRA_EMAIL still contains the mask placeholder')
  })

  it('selects the mask on focus so typing replaces it', async () => {
    const wrapper = await openModal()
    const el = input(wrapper, 'JIRA_EMAIL').element
    const select = vi.spyOn(el, 'select')
    await input(wrapper, 'JIRA_EMAIL').trigger('focus')
    expect(select).toHaveBeenCalledTimes(1)
    const tokenEl = input(wrapper, 'JIRA_TOKEN').element
    const tokenSelect = vi.spyOn(tokenEl, 'select')
    await input(wrapper, 'JIRA_TOKEN').trigger('focus')
    expect(tokenSelect).not.toHaveBeenCalled()
  })
})
