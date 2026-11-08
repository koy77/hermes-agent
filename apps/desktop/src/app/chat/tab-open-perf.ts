/**
 * Tab-open latency probe.
 *
 * "Switching a tab takes seconds" has three possible owners — the HTTP payload,
 * the renderer's parse+paint, or the machine underneath — and none of them can
 * be blamed from a stopwatch. This module times ONE user-visible interaction:
 *
 *   pointerdown / keydown        → t0
 *   the view flips to a session  → activation ($activeSessionId or
 *                                  $selectedStoredSessionId changed)
 *   renderer quiet, no in-flight
 *   /api/sessions/... request    → settled. This is the number the user feels.
 *
 * The settled boundary is deliberately store-agnostic: stacked tiles render
 * their own transcript, so watching `$messages` alone would report a fast open
 * for a slow tile switch. Frame gaps, long tasks and in-flight requests are
 * what the user actually waits on, whichever component does the work.
 *
 * Every sample carries the `/api/sessions/...` response it overlapped (path,
 * transfer size, duration) and the long-task total, so a 5 s open can be
 * attributed instead of guessed at.
 *
 * Cost when nothing is slow: one capture-phase pointerdown listener, one
 * keydown listener, two store subscriptions, a `fetch` pass-through that only
 * timestamps `/api/sessions/` URLs, a buffered resource/longtask
 * PerformanceObserver, and a rAF loop that runs only while a sample is open.
 * Samples live in a ring buffer (`window.__TAB_PERF__`) always; they reach
 * desktop.log — through `electron/renderer-log.ts`'s `[perf]` passthrough —
 * only when the open crosses `SLOW_TOTAL_MS`, so a healthy app stays quiet.
 *
 * Devtools (F12) gets the rest:
 *
 *   __TAB_PERF__.report()   // every buffered sample, newest last
 *   __TAB_PERF__.summary()  // p50/p95/max per trigger
 *   __TAB_PERF__.clear()
 */

import { $activeSessionId, $messages, $selectedStoredSessionId, $sessionResumeRequest } from '@/store/session'

export type TabOpenTrigger = 'keyboard' | 'pointer' | 'programmatic'

export interface TabOpenResource {
  /** Path with the origin and query stripped, e.g. `/api/sessions/<id>/messages`. */
  path: string
  /** Response timing in ms, or -1 when the entry carried no duration. */
  ms: number
  /** Response body size in KB (decoded, falling back to encoded). */
  kb: number
}

/** One long animation frame inside a slow open, with the scripts it ran. */
export interface TabOpenFrame {
  /** Frame start, ms after the click. */
  at: number
  /** Whole frame, ms. */
  duration: number
  /** Time the main thread was blocked inside it, ms. */
  blocking: number
  /** Heaviest scripts the frame attributes (Chromium LoAF `scripts`). */
  scripts: { fn: string; url: string; ms: number }[]
}

export interface TabOpenSample {
  /** Session the view flipped to; `null` for a fresh draft. */
  sessionId: null | string
  /**
   * True when the activated session was ALREADY the one on screen — the
   * "click the active tab/row" case, which re-resumes the same transcript
   * instead of loading a different one. Kept apart because the two do
   * different work: a switch mounts new content, a reselect re-renders the
   * content that is already there.
   */
  sameSession: boolean
  trigger: TabOpenTrigger
  /** t0 → the view switched. */
  clickToActivate: number
  /** Activation → first painted frame after it. */
  activateToFrame: number
  /** t0 → renderer quiet again. This is the number the user feels. */
  total: number
  /** Sum of long-task time inside the window (blocked main thread). */
  blocked: number
  /** Longest single frame gap inside the window. */
  worstGap: number
  /** The `/api/sessions/...` request this open waited on, if any. */
  resource: null | TabOpenResource
  /** Slowest long animation frames of the window, with script attribution. */
  frames: TabOpenFrame[]
  /** Transcript length when the sample closed (main-pane swaps only). */
  messages: number
  /** Wall clock (ms since epoch), for correlating with desktop.log. */
  at: number
}

const SLOW_TOTAL_MS = 500
const BLOCKED_LOG_MS = 200
const QUIET_FRAME_MS = 50
const QUIET_TAIL_MS = 150
// A floor wide enough to catch a request that starts a beat after the click
// (route change → effect → fetch), short enough that a local switch reads as
// ~250 ms instead of masquerading as a stall.
const MIN_WINDOW_MS = 250
const MAX_WINDOW_MS = 30_000
const RING_SIZE = 100

const round = (value: number): number => Math.round(value * 10) / 10

/** Strip origin and query so samples group by endpoint, not by session id. */
export function resourcePath(url: string): string {
  try {
    return new URL(url, 'http://x').pathname
  } catch {
    return url.slice(0, 120)
  }
}

/** Should this sample reach desktop.log? Fast opens stay in the ring buffer. */
export function isSlowSample(sample: TabOpenSample): boolean {
  return sample.total >= SLOW_TOTAL_MS || sample.blocked >= BLOCKED_LOG_MS
}

interface Pending {
  trigger: TabOpenTrigger
  t0: number
  activatedAt: number
  sessionId: null | string
  sameSession: boolean
  frames: number
  firstFrameAt: number
  lastFrameAt: number
  worstGap: number
  resource: null | TabOpenResource
  frame: number
}

const samples: TabOpenSample[] = []
const resourceEntries: PerformanceEntry[] = []
const longTasks: PerformanceEntry[] = []
const longFrames: PerformanceEntry[] = []
const inFlight = new Map<string, number>()
let pending: Pending | null = null
let installed = false
let lastPointerAt = -1
let lastTrigger: TabOpenTrigger = 'programmatic'
let lastActivatedSessionId: null | string = null

declare global {
  interface Window {
    __TAB_PERF__?: {
      samples: TabOpenSample[]
      clear: () => void
      report: () => TabOpenSample[]
      summary: () => Record<string, { count: number; max: number; p50: number; p95: number }>
    }
  }
}

function push<T>(list: T[], entry: T, cap: number) {
  list.push(entry)

  if (list.length > cap) {
    list.splice(0, list.length - cap)
  }
}

function installObservers() {
  if (typeof PerformanceObserver === 'undefined') {
    return
  }

  try {
    new PerformanceObserver(list => list.getEntries().forEach(entry => push(resourceEntries, entry, 500))).observe({
      type: 'resource',
      buffered: true
    })
  } catch {
    // Older Chromium without buffered resource observers: `resource` stays null.
  }

  try {
    new PerformanceObserver(list => list.getEntries().forEach(entry => push(longTasks, entry, 500))).observe({
      type: 'longtask',
      buffered: true
    })
  } catch {
    // `longtask` is optional; `blocked` stays 0 rather than reporting a lie.
  }

  // Long Animation Frames carry the one thing a duration cannot: WHICH script
  // ate the frame (`scripts[].invoker/sourceFunctionName`). This is what turns
  // "activation takes 2 s" into "this function takes 2 s".
  try {
    new PerformanceObserver(list => list.getEntries().forEach(entry => push(longFrames, entry, 200))).observe({
      type: 'long-animation-frame',
      buffered: true
    })
  } catch {
    // Chromium < 123 has no LoAF; `frames` stays empty on such a build.
  }
}

/** Timestamp session requests without touching their result or rejection. */
function installFetchProbe() {
  if (typeof window.fetch !== 'function') {
    return
  }

  const original = window.fetch

  window.fetch = function probe(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url ?? '')

    if (!url.includes('/api/sessions')) {
      return original.call(window, input as RequestInfo, init)
    }

    const key = `${url}#${String(init?.method ?? 'GET')}`
    const started = performance.now()

    inFlight.set(key, started)

    const done = () => {
      if (inFlight.get(key) === started) {
        inFlight.delete(key)
      }
    }

    let result: Promise<Response>

    try {
      result = original.call(window, input as RequestInfo, init)
    } catch (error) {
      done()
      throw error
    }

    result.then(done, done)

    return result
  } as typeof window.fetch
}

/** Largest `/api/sessions/...` response that started inside the window. */
function pickResource(t0: number): null | TabOpenResource {
  let best: null | PerformanceEntry = null

  for (const entry of resourceEntries) {
    if (entry.startTime < t0 || !entry.name.includes('/api/sessions')) {
      continue
    }

    if (!best || entry.duration > best.duration) {
      best = entry
    }
  }

  if (!best) {
    return null
  }

  const sized = best as PerformanceEntry & { decodedBodySize?: number; encodedBodySize?: number; transferSize?: number }
  const bytes = sized.decodedBodySize || sized.encodedBodySize || sized.transferSize || 0

  return { path: resourcePath(best.name), ms: round(best.duration), kb: Math.round(bytes / 102.4) / 10 }
}

function blockedIn(t0: number, t1: number): number {
  let total = 0

  for (const entry of longTasks) {
    if (entry.startTime + entry.duration < t0 || entry.startTime > t1) {
      continue
    }

    total += Math.min(entry.startTime + entry.duration, t1) - Math.max(entry.startTime, t0)
  }

  return total
}

/** Slowest long animation frames of the window, each with its heaviest scripts. */
function framesFor(t0: number, t1: number): TabOpenFrame[] {
  const out: TabOpenFrame[] = []

  for (const raw of longFrames) {
    if (raw.startTime + raw.duration < t0 || raw.startTime > t1) {
      continue
    }

    const entry = raw as PerformanceEntry & {
      blockingDuration?: number
      scripts?: { duration?: number; invoker?: string; sourceFunctionName?: string; sourceURL?: string }[]
    }

    const scripts = [...(entry.scripts ?? [])]
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, 3)
      .map(script => ({
        fn: script.sourceFunctionName || script.invoker || '(anonymous)',
        url: resourcePath(script.sourceURL ?? ''),
        ms: round(script.duration ?? 0)
      }))

    out.push({
      at: round(raw.startTime - t0),
      duration: round(raw.duration),
      blocking: round(entry.blockingDuration ?? 0),
      scripts
    })
  }

  return out.sort((a, b) => b.duration - a.duration).slice(0, 3)
}

function report(record: TabOpenSample) {
  push(samples, record, RING_SIZE)

  if (isSlowSample(record)) {
    // `[perf]` is the passthrough prefix electron/renderer-log.ts forwards to
    // desktop.log at any level (it otherwise keeps only renderer errors).
    console.info(`[perf] tab-open ${JSON.stringify(record)}`)
  }
}

function finish(sample: Pending, at: number) {
  report({
    sessionId: sample.sessionId,
    sameSession: sample.sameSession,
    trigger: sample.trigger,
    clickToActivate: round(Math.max(0, sample.activatedAt - sample.t0)),
    activateToFrame: sample.firstFrameAt ? round(Math.max(0, sample.firstFrameAt - sample.activatedAt)) : -1,
    total: round(at - sample.t0),
    blocked: round(blockedIn(sample.t0, at)),
    worstGap: round(sample.worstGap),
    resource: sample.resource,
    frames: framesFor(sample.t0, at),
    messages: $messages.get().length,
    at: Date.now()
  })
}

function tick() {
  const sample = pending

  if (!sample) {
    return
  }

  const now = performance.now()
  const gap = sample.lastFrameAt ? now - sample.lastFrameAt : 0

  sample.frames += 1

  if (gap > sample.worstGap) {
    sample.worstGap = gap
  }

  if (!sample.firstFrameAt) {
    sample.firstFrameAt = now
  }

  sample.lastFrameAt = now
  sample.resource = sample.resource ?? pickResource(sample.t0)

  const elapsed = now - sample.t0
  const quiet = gap <= QUIET_FRAME_MS && blockedIn(now - QUIET_TAIL_MS, now) === 0
  const settled = elapsed >= MIN_WINDOW_MS && sample.frames >= 2 && quiet && inFlight.size === 0

  if (settled || elapsed >= MAX_WINDOW_MS) {
    pending = null
    finish(sample, now)

    return
  }

  sample.frame = requestAnimationFrame(tick)
}

/** A view flip: freeze the activation instant and start settling it. */
function activate() {
  if (pending) {
    // A second flip inside one window (route + selection both landing) belongs
    // to the same open.
    return
  }

  const now = performance.now()
  const clicked = lastPointerAt > 0 && now - lastPointerAt <= 2_000
  const current = $activeSessionId.get() ?? $selectedStoredSessionId.get()

  pending = {
    trigger: clicked ? lastTrigger : 'programmatic',
    t0: clicked ? lastPointerAt : now,
    activatedAt: now,
    sessionId: current,
    sameSession: lastActivatedSessionId !== null && lastActivatedSessionId === current,
    frames: 0,
    firstFrameAt: 0,
    lastFrameAt: 0,
    worstGap: 0,
    resource: null,
    frame: requestAnimationFrame(tick)
  }

  lastActivatedSessionId = current
}

export function installTabOpenPerf(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }

  installed = true
  installObservers()
  installFetchProbe()

  // One boot line is the proof that renderer console reaches desktop.log
  // through electron/renderer-log.ts — without it, "no [perf] lines" would be
  // equally consistent with a silent probe and with a broken passthrough.
  console.info('[perf] tab-open-probe ready')

  window.__TAB_PERF__ = {
    samples,
    clear: () => {
      samples.length = 0
    },
    report: () => [...samples],
    summary: () => {
      const byTrigger = new Map<string, number[]>()
      const out: Record<string, { count: number; max: number; p50: number; p95: number }> = {}

      for (const sample of samples) {
        const list = byTrigger.get(sample.trigger) ?? []

        list.push(sample.total)
        byTrigger.set(sample.trigger, list)
      }

      for (const [trigger, list] of byTrigger) {
        list.sort((a, b) => a - b)
        out[trigger] = {
          count: list.length,
          max: round(list[list.length - 1]),
          p50: round(list[Math.floor(list.length * 0.5)]),
          p95: round(list[Math.floor(list.length * 0.95)])
        }
      }

      return out
    }
  }

  document.addEventListener(
    'pointerdown',
    () => {
      lastPointerAt = performance.now()
      lastTrigger = 'pointer'
    },
    { capture: true, passive: true }
  )

  // Keyboard opens (Enter on a sidebar row, ⌘K) have no pointerdown.
  document.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Enter' && !event.isComposing) {
        lastPointerAt = performance.now()
        lastTrigger = 'keyboard'
      }
    },
    { capture: true, passive: true }
  )

  $activeSessionId.subscribe(() => activate())
  $selectedStoredSessionId.subscribe(() => activate())
  // Re-clicking the chat that is ALREADY on screen is an explicit reselect: the
  // sidebar/picker path queues a resume, so the transcript is refetched and
  // re-rendered even though no atom "changed". That is the slow case a plain
  // active-session observer would miss entirely.
  $sessionResumeRequest.subscribe(() => activate())
}
