import { describe, expect, it } from 'vitest'

import type { TabOpenSample } from './tab-open-perf'
import { isSlowSample, resourcePath } from './tab-open-perf'

const sample = (patch: Partial<TabOpenSample> = {}): TabOpenSample => ({
  sessionId: '20261108_120000_abcdef',
  sameSession: false,
  trigger: 'pointer',
  clickToActivate: 12,
  activateToFrame: 40,
  total: 120,
  blocked: 0,
  worstGap: 18,
  resource: null,
  frames: [],
  messages: 42,
  at: 0,
  ...patch
})

describe('resourcePath', () => {
  it('strips origin and query', () => {
    expect(resourcePath('http://127.0.0.1:34999/api/sessions/abc/messages?limit=500&inline_images=true')).toBe(
      '/api/sessions/abc/messages'
    )
  })

  it('accepts a relative url', () => {
    expect(resourcePath('/api/sessions?limit=50')).toBe('/api/sessions')
  })
})

describe('isSlowSample', () => {
  it('keeps a healthy open out of desktop.log', () => {
    expect(isSlowSample(sample())).toBe(false)
  })

  it('logs a slow open on total', () => {
    expect(isSlowSample(sample({ total: 5120 }))).toBe(true)
  })

  it('logs an open whose main thread was blocked even when it finished fast', () => {
    expect(isSlowSample(sample({ total: 300, blocked: 240 }))).toBe(true)
  })
})
