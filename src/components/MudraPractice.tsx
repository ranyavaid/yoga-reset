import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import WebcamFeed, {
  type PracticeCameraState,
  type WebcamFeedHandle,
  type WebcamTrackingPayload,
} from './WebcamFeed'
import type { VideoObjectFitMode } from './useMediaPipeHands'
import type { FingerName, FingerStates } from './fingerDetection'
import {
  DEFAULT_MUDRA_ID,
  DEFAULT_PRACTICE_DURATION_SECONDS,
  getMudraById,
  HOW_TO_PRACTISE_STEPS,
  listMudras,
  PRACTICE_DURATION_OPTIONS,
  type Mudra,
  type PracticeDurationSeconds,
} from '../data/mudras'
import {
  AMBIENT_SOUND_OPTIONS,
  usePracticeAmbientSound,
} from '../hooks/usePracticeAmbientSound'
import {
  computeMudraAlignment,
  emptyMudraMatch,
  getMudraDetectionProfile,
  resolveSessionMudraMatch,
  type MudraAlignmentMatch,
  type MudraLandmark,
} from './mudraAlignment'
import './MudraPractice.css'
import '../styles/glassSurfaces.css'

/** Start practice when shape reads as ~“confident enough” (~75% on the meter). */
const START_ALIGNMENT_MIN = 75
const ALIGN_LOST_ABORT_MS = 14000
/** Hand missing during active practice: return to setup after this long (ms). */
const HAND_ABSENT_RESET_MS = 8000
const HAND_PRESENT_CONFIRM_FRAMES = 1
const HAND_MISSING_CONFIRM_FRAMES = 2
/** Line shown on the orb for the first `SESSION_PREAMBLE_SECONDS` after Start. */
const PREAMBLE_SETTLE_LINE = 'Settle into the mudra'

/** After Start: settle copy for this many seconds before the selected practice timer runs. */
const SESSION_PREAMBLE_SECONDS = 5

function sessionTargetFromPracticeDuration(practiceDurationSec: number): number {
  return SESSION_PREAMBLE_SECONDS + practiceDurationSec
}

/** Duration (ms) the session card stays in `finishing` while the fade-out runs; must be ≥ CSS fade length. */
const SESSION_FINISH_HOLD_MS = 800

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

type PracticePhase = 'idle' | 'active' | 'finishing' | 'completed'

type Landmark = MudraLandmark

/** Dual-hand mudras: each side may sit a little lower; combined gate stays gentle. */
const DUAL_EACH_SOFT_MIN = 58
const DUAL_COMBINED_MIN = 73

function getMudraHandsRequired(mudra: { handsRequired?: 1 | 2 }): 1 | 2 {
  return mudra.handsRequired ?? 1
}

/** Per-frame presence for session pause (no debounce); chips still use stable slots. */
function frameHandsSatisfyRequirement(
  hasHandSlot: [boolean, boolean],
  handsRequired: 1 | 2,
): boolean {
  return handsRequired === 1 ? hasHandSlot[0] || hasHandSlot[1] : hasHandSlot[0] && hasHandSlot[1]
}

function getPauseFrameGuidance(handsRequired: 1 | 2): string {
  return handsRequired === 2
    ? 'Bring both hands back into frame'
    : 'Bring your hand back into frame'
}

function getHandPresenceCalloutMessage(
  handsRequired: 1 | 2,
  stableSlot: [boolean, boolean],
  rawHandCount: number,
): string | null {
  if (handsRequired === 1) {
    if (!stableSlot[0] && !stableSlot[1]) {
      if (rawHandCount === 0) return 'No hands detected'
      return null
    }
    return null
  }
  if (stableSlot[0] && stableSlot[1]) return null
  if (!stableSlot[0] && !stableSlot[1]) {
    if (rawHandCount === 0) return 'No hands detected'
    if (rawHandCount === 1) return '1 hand detected'
    return null
  }
  return '1 hand detected'
}

type PracticeStatusChipKind = 'noHand' | 'improving' | 'stable'

/** Unified status chip for pre-session, active practice, and brief tracking gaps (same labels + visuals). */
function getPracticeStatusChip(
  hasHand: boolean,
  match: MudraAlignmentMatch,
  ctx: { phase: 'idle'; canStart: boolean } | { phase: 'active' },
): { kind: PracticeStatusChipKind; label: string } {
  if (!hasHand) {
    return { kind: 'noHand', label: 'No hands detected' }
  }

  const stableGate =
    match.touchMatched &&
    match.incorrectFingers.length <= 1 &&
    match.alignment >= START_ALIGNMENT_MIN

  if (ctx.phase === 'idle') {
    if (ctx.canStart || stableGate) return { kind: 'stable', label: 'Stable' }
    return { kind: 'improving', label: 'Improving' }
  }

  if (stableGate) return { kind: 'stable', label: 'Stable' }
  return { kind: 'improving', label: 'Improving' }
}

/** Narrow single-column layouts: `contain` shows full frame; laptop+ uses `cover` for immersion. */
const PRACTICE_WEBCAM_CONTAIN_MQ = '(max-width: 1024px)'

function useEmbeddedPracticeObjectFit(): VideoObjectFitMode {
  const [fit, setFit] = useState<VideoObjectFitMode>(() =>
    typeof window !== 'undefined' && window.matchMedia(PRACTICE_WEBCAM_CONTAIN_MQ).matches
      ? 'contain'
      : 'cover',
  )

  useEffect(() => {
    const mq = window.matchMedia(PRACTICE_WEBCAM_CONTAIN_MQ)
    const apply = () => setFit(mq.matches ? 'contain' : 'cover')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  return fit
}

type VideoLayoutRect = { cw: number; ch: number; vw: number; vh: number }

/**
 * Map MediaPipe normalized coords (full frame) into the visible `object-fit: cover|contain` region,
 * then mirror horizontally to match the selfie `scaleX(-1)` video (same math as the tracking canvas).
 */
function videoMirrorNormalizedToPercent(
  nx: number,
  ny: number,
  vw: number,
  vh: number,
  cw: number,
  ch: number,
  objectFit: VideoObjectFitMode,
): { xPct: number; yPct: number } {
  if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) {
    return { xPct: (1 - nx) * 100, yPct: ny * 100 }
  }
  const scale =
    objectFit === 'contain' ? Math.min(cw / vw, ch / vh) : Math.max(cw / vw, ch / vh)
  const scaledW = vw * scale
  const scaledH = vh * scale
  const offsetX = (cw - scaledW) / 2
  const offsetY = (ch - scaledH) / 2
  const uX = offsetX + nx * scaledW
  const uY = offsetY + ny * scaledH
  const mX = cw - uX
  return { xPct: (mX / cw) * 100, yPct: (uY / ch) * 100 }
}

/** Anchor (%, %): horizontal center of hand bbox, top of bbox (chip sits above via CSS transform). */
function computeHandChipAnchorPercent(
  hasHand: boolean,
  landmarks: Landmark[] | null,
  layout: VideoLayoutRect,
  objectFit: VideoObjectFitMode,
): { cx: number; cy: number } {
  if (!hasHand || !landmarks || landmarks.length < 4) {
    return { cx: 50, cy: 22 }
  }
  const { cw, ch, vw, vh } = layout
  let minXp = Infinity
  let maxXp = -Infinity
  let minYp = Infinity
  for (const p of landmarks) {
    const { xPct, yPct } = videoMirrorNormalizedToPercent(p.x, p.y, vw, vh, cw, ch, objectFit)
    minXp = Math.min(minXp, xPct)
    maxXp = Math.max(maxXp, xPct)
    minYp = Math.min(minYp, yPct)
  }
  return { cx: (minXp + maxXp) / 2, cy: minYp }
}

function useWebcamWrapLayout(containerRef: RefObject<HTMLDivElement | null>, enabled: boolean): VideoLayoutRect {
  const [layout, setLayout] = useState<VideoLayoutRect>({ cw: 0, ch: 0, vw: 0, vh: 0 })

  useLayoutEffect(() => {
    if (!enabled) return
    const el = containerRef.current
    if (!el) return

    const read = () => {
      const rect = el.getBoundingClientRect()
      const video = el.querySelector('video')
      const vw = video?.videoWidth ?? 0
      const vh = video?.videoHeight ?? 0
      const cw = rect.width
      const ch = rect.height
      setLayout((prev) =>
        prev.cw === cw && prev.ch === ch && prev.vw === vw && prev.vh === vh ? prev : { cw, ch, vw, vh },
      )
    }

    read()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => read()) : null
    ro?.observe(el)
    const video = el.querySelector('video')
    video?.addEventListener('loadedmetadata', read)
    video?.addEventListener('loadeddata', read)
    return () => {
      ro?.disconnect()
      video?.removeEventListener('loadedmetadata', read)
      video?.removeEventListener('loadeddata', read)
    }
  }, [containerRef, enabled])

  return layout
}

/** One frosted chip above a single tracked hand slot. */
function HandAlignmentSlotChip(props: {
  show: boolean
  phase: PracticePhase
  hasSlotHand: boolean
  landmarks: Landmark[] | null
  match: MudraAlignmentMatch
  canStart: boolean
  containerRef: RefObject<HTMLDivElement | null>
  videoObjectFit: VideoObjectFitMode
}) {
  const { show, phase, hasSlotHand, landmarks, match, canStart, containerRef, videoObjectFit } =
    props

  const layout = useWebcamWrapLayout(containerRef, show && hasSlotHand)

  const statusChip = useMemo(() => {
    if (phase === 'idle' || phase === 'completed') {
      return getPracticeStatusChip(hasSlotHand, match, { phase: 'idle', canStart })
    }
    return getPracticeStatusChip(hasSlotHand, match, { phase: 'active' })
  }, [phase, hasSlotHand, match, canStart])

  const displayPctRef = useRef(0)
  const displayPct = useMemo(() => {
    const raw = Number.isFinite(match.alignment) ? match.alignment : 0
    displayPctRef.current = lerp(displayPctRef.current, raw, 0.08)
    return Math.round(displayPctRef.current)
  }, [match.alignment])

  const posRef = useRef({ cx: 50, cy: 22 })
  const pos = useMemo(() => {
    const t = computeHandChipAnchorPercent(hasSlotHand, landmarks, layout, videoObjectFit)
    posRef.current.cx = lerp(posRef.current.cx, t.cx, 0.14)
    posRef.current.cy = lerp(posRef.current.cy, t.cy, 0.14)
    return { cx: posRef.current.cx, cy: posRef.current.cy }
  }, [hasSlotHand, landmarks, layout, videoObjectFit])

  const pillMod =
    statusChip.kind === 'improving' ? 'handAlignGlassPill--improving' : 'handAlignGlassPill--stable'

  if (!show || !hasSlotHand) return null

  return (
    <div
      className="handAlignFloatingChip"
      style={{ left: `${pos.cx}%`, top: `${pos.cy}%` }}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className={`handAlignGlassPill glassFrostPill ${pillMod}`}>
        {statusChip.label} · {displayPct}%
      </span>
    </div>
  )
}

function HandAlignmentHandChips(props: {
  show: boolean
  phase: PracticePhase
  stableSlot: [boolean, boolean]
  slotLandmarks: [Landmark[] | null, Landmark[] | null]
  matchSlots: readonly [MudraAlignmentMatch, MudraAlignmentMatch]
  canStart: boolean
  containerRef: RefObject<HTMLDivElement | null>
  videoObjectFit: VideoObjectFitMode
}) {
  const { show, phase, stableSlot, slotLandmarks, matchSlots, canStart, containerRef, videoObjectFit } =
    props

  return (
    <>
      {[0, 1].map((idx) => (
        <HandAlignmentSlotChip
          key={idx}
          show={show}
          phase={phase}
          hasSlotHand={stableSlot[idx as 0 | 1] && !!slotLandmarks[idx as 0 | 1]}
          landmarks={slotLandmarks[idx as 0 | 1]}
          match={matchSlots[idx as 0 | 1]}
          canStart={canStart}
          containerRef={containerRef}
          videoObjectFit={videoObjectFit}
        />
      ))}
    </>
  )
}

function HandNoHandCallout(props: { message: string }) {
  return (
    <div className="handAlignGlassPill glassFrostPill handAlignGlassPill--anchored" role="status" aria-live="polite" aria-atomic="true">
      {props.message}
    </div>
  )
}

type BreathingOverlay =
  | { kind: 'none' }
  | { kind: 'preambleSettle'; line: string }
  | { kind: 'intro'; line: string }
  | { kind: 'paced'; line: string; counts: readonly number[]; activeIndex: number }
  | { kind: 'rotate'; line: string }

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function smoothLandmarks(prev: Landmark[] | null, next: Landmark[] | null, alpha: number) {
  if (!next) return null
  if (!prev || prev.length !== next.length) return next
  return next.map((p, i) => {
    const q = prev[i]!
    return {
      x: lerp(q.x, p.x, alpha),
      y: lerp(q.y, p.y, alpha),
      z: p.z == null || q.z == null ? p.z : lerp(q.z, p.z, alpha),
      visibility: p.visibility,
    }
  })
}

type FingerStable = {
  score: number
  isOpen: boolean
}

function smoothFingerStates(
  prev: Record<FingerName, FingerStable> | null,
  next: FingerStates | null,
  alpha: number,
) {
  if (!next) return null
  const out: Record<FingerName, FingerStable> = (prev
    ? { ...prev }
    : ({} as Record<FingerName, FingerStable>)) as Record<FingerName, FingerStable>

  const openOn = 0.46
  const openOff = 0.4
  ;(['thumb', 'index', 'middle', 'ring', 'pinky'] as FingerName[]).forEach((finger) => {
    const nextScore = clamp01(next[finger].openScore)
    const prevStable = prev?.[finger]
    const score = prevStable ? lerp(prevStable.score, nextScore, alpha) : nextScore
    const wasOpen = prevStable ? prevStable.isOpen : next[finger].isOpen
    const isOpen = wasOpen ? score >= openOff : score >= openOn
    out[finger] = { score, isOpen }
  })
  return out
}

function toFingerStates(stable: Record<FingerName, FingerStable> | null): FingerStates | null {
  if (!stable) return null
  return {
    thumb: { isOpen: stable.thumb.isOpen, openScore: stable.thumb.score },
    index: { isOpen: stable.index.isOpen, openScore: stable.index.score },
    middle: { isOpen: stable.middle.isOpen, openScore: stable.middle.score },
    ring: { isOpen: stable.ring.isOpen, openScore: stable.ring.score },
    pinky: { isOpen: stable.pinky.isOpen, openScore: stable.pinky.score },
  }
}

function getBreathingOverlay(
  practiceElapsedSec: number,
  phase: PracticePhase,
  mudra: Mudra,
  sessionTargetSeconds: number,
): BreathingOverlay {
  const total = sessionTargetSeconds
  if (phase !== 'active' || practiceElapsedSec >= total) return { kind: 'none' }

  const preamble = Math.min(SESSION_PREAMBLE_SECONDS, Math.max(0, total - 1))
  if (practiceElapsedSec < preamble) {
    return { kind: 'preambleSettle', line: PREAMBLE_SETTLE_LINE }
  }

  const bp = mudra.breathingPattern
  const t0 = practiceElapsedSec - preamble
  if (t0 < bp.introSeconds) {
    return { kind: 'intro', line: bp.introLine }
  }
  const alt = bp.pacedAlternation
  if (alt) {
    const t = t0 - bp.introSeconds
    const { phaseSeconds, labels } = alt
    const cycle = 2 * phaseSeconds
    const pos = t % cycle
    const firstPhase = pos < phaseSeconds
    const line = firstPhase ? labels[0] : labels[1]
    const intoPhase = firstPhase ? pos : pos - phaseSeconds
    const activeIndex = Math.min(phaseSeconds - 1, Math.max(0, Math.floor(intoPhase)))
    const counts = Array.from({ length: phaseSeconds }, (_, i) => i + 1)
    return { kind: 'paced', line, counts, activeIndex }
  }
  const t = t0 - bp.introSeconds
  const slot = Math.floor(t / bp.rotationSlotSeconds) % bp.rotationLines.length
  return { kind: 'rotate', line: bp.rotationLines[slot] ?? '' }
}

function getBreathOrbScaleMode(
  overlay: BreathingOverlay,
  mudra: Mudra,
  handPaused: boolean,
): 'in' | 'out' | 'neutral' {
  if (handPaused) return 'neutral'
  if (overlay.kind === 'preambleSettle') return 'neutral'
  const pa = mudra.breathingPattern.pacedAlternation
  if (overlay.kind === 'paced' && pa) {
    return overlay.line === pa.labels[0] ? 'in' : 'out'
  }
  if (overlay.kind === 'rotate') {
    const low = overlay.line.toLowerCase()
    if (low.includes('breathe in') || low.includes('breath in')) return 'in'
    if (low.includes('breathe out') || low.includes('breath out')) return 'out'
  }
  return 'neutral'
}

function getBreathScaleTransitionSec(overlay: BreathingOverlay, mudra: Mudra): number {
  const bp = mudra.breathingPattern
  if (overlay.kind === 'preambleSettle') return 2.5
  if (overlay.kind === 'paced' && bp.pacedAlternation) return bp.pacedAlternation.phaseSeconds
  if (overlay.kind === 'intro') return Math.max(0.9, bp.introSeconds)
  if (overlay.kind === 'rotate') return bp.rotationSlotSeconds
  return 3.5
}

function WebcamRitualHud(props: {
  mudra: Mudra
  phase: PracticePhase
  practiceElapsedSec: number
  sessionTargetSeconds: number
  breathingOverlay: BreathingOverlay
  breathAssistiveLine: string
  sessionHandsPresent: boolean
}) {
  const {
    mudra,
    phase,
    practiceElapsedSec,
    sessionTargetSeconds,
    breathingOverlay,
    breathAssistiveLine,
    sessionHandsPresent,
  } = props

  const ringGradId = useId().replace(/:/g, '')

  const handsRequired = getMudraHandsRequired(mudra)
  const handLostActive = phase === 'active' && !sessionHandsPresent

  const preambleSec = Math.min(SESSION_PREAMBLE_SECONDS, Math.max(0, sessionTargetSeconds - 1))
  const guidedSec = Math.max(1, sessionTargetSeconds - preambleSec)

  const remainingSecs = useMemo(() => {
    if (phase === 'active' && !handLostActive && practiceElapsedSec < preambleSec) {
      return guidedSec
    }
    return Math.max(0, Math.ceil(sessionTargetSeconds - practiceElapsedSec))
  }, [phase, handLostActive, practiceElapsedSec, preambleSec, guidedSec, sessionTargetSeconds])

  const remainingClock = useMemo(() => {
    const totalSec = Math.max(0, Math.ceil(remainingSecs))
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }, [remainingSecs])

  const hudFinishing = phase === 'finishing'

  const pauseGuidance = getPauseFrameGuidance(handsRequired)
  const pauseAssistive = `${pauseGuidance}. Session and breath paused.`

  const showBreathingStack =
    breathingOverlay.kind !== 'none' && (phase === 'active' || phase === 'finishing')

  const breathOrbMode = useMemo(
    () => getBreathOrbScaleMode(breathingOverlay, mudra, handLostActive),
    [breathingOverlay, mudra, handLostActive],
  )

  const breathTransitionSec = useMemo(
    () => getBreathScaleTransitionSec(breathingOverlay, mudra),
    [breathingOverlay, mudra],
  )

  const sessionProgress = useMemo(() => {
    if (practiceElapsedSec < preambleSec) return 0
    return Math.min(1, (practiceElapsedSec - preambleSec) / Math.max(0.001, guidedSec))
  }, [practiceElapsedSec, preambleSec, guidedSec])

  const ringR = 58
  const ringC = 2 * Math.PI * ringR
  const dashVisible = sessionProgress * ringC

  const centerLabel = breathingOverlay.kind !== 'none' ? breathingOverlay.line : ''
  const centerTimer = handLostActive ? 'Paused' : remainingClock

  return (
    <div className={`webcamRitualHud webcamRitualHudActive ${handLostActive ? 'webcamRitualHudPaused' : ''}`}>
      {showBreathingStack ? (
        <div
          className={`breathOrbHudShell${hudFinishing ? ' breathOrbHudShell--sessionFinishing' : ''}`}
          aria-hidden="true"
        >
          <div
            className={`breathOrbHud${handLostActive ? ' breathOrbHud--paused' : ''}`}
            style={
              {
                '--breath-scale-dur': `${breathTransitionSec}s`,
              } as CSSProperties
            }
          >
            <svg className="breathOrbRingSvg" viewBox="0 0 140 140" aria-hidden="true">
              <defs>
                <linearGradient id={ringGradId} x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="rgba(150, 205, 175, 0.92)" />
                  <stop offset="45%" stopColor="rgba(110, 175, 135, 0.95)" />
                  <stop offset="100%" stopColor="rgba(85, 150, 118, 0.96)" />
                </linearGradient>
              </defs>
              <circle
                className="breathOrbRingTrack"
                cx="70"
                cy="70"
                r={ringR}
                fill="none"
                stroke="rgba(255, 255, 255, 0.5)"
                strokeWidth="4.5"
                strokeLinecap="round"
              />
              <circle
                className="breathOrbRingProgressUnder"
                cx="70"
                cy="70"
                r={ringR}
                fill="none"
                stroke={`url(#${ringGradId})`}
                strokeWidth="7"
                strokeOpacity="0.26"
                strokeLinecap="round"
                transform="rotate(-90 70 70)"
                strokeDasharray={`${dashVisible} ${ringC}`}
              />
              <circle
                className="breathOrbRingProgress"
                cx="70"
                cy="70"
                r={ringR}
                fill="none"
                stroke={`url(#${ringGradId})`}
                strokeWidth="4"
                strokeLinecap="round"
                transform="rotate(-90 70 70)"
                strokeDasharray={`${dashVisible} ${ringC}`}
              />
            </svg>
            <div className={`breathOrbCore breathOrbCore--${breathOrbMode}`}>
              <div className="breathOrbCoreDisk" aria-hidden="true" />
              <div className="breathOrbCoreContent">
                <p className="breathOrbCoreTimer">{centerTimer}</p>
                <p className="breathOrbCoreLabel">{centerLabel}</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <span className="breathAssistiveOnly">
        {handLostActive ? pauseAssistive : breathAssistiveLine}
      </span>
    </div>
  )
}

function WebcamCameraGateHud(props: {
  title: string
  body: string
  showEnableButton: boolean
  onEnableCamera: () => void
}) {
  const { title, body, showEnableButton, onEnableCamera } = props
  return (
    <div className="webcamRitualHud webcamRitualHudReady webcamRitualHudCameraGate">
      <div className="webcamRitualHudCard glassFrostRitualCard glassFrostRitualCard--strong" aria-hidden="true">
        <div className="webcamCameraGateRow">
          <div className="webcamCameraGateCopy">
            <p className="webcamRitualHudReadySupporting webcamCameraGateText">{body}</p>
          </div>
          {showEnableButton && (
            <div className="webcamCameraGateActions">
              <button type="button" className="ritualPrimaryBtn ritualPrimaryBtnReadyInCard" onClick={onEnableCamera}>
                Enable camera
              </button>
            </div>
          )}
        </div>
      </div>
      <span className="breathAssistiveOnly" role="status" aria-live="polite" aria-atomic="true">
        {title ? `${title}. ${body}` : body}
      </span>
    </div>
  )
}

function WebcamReadyHud(props: {
  handsRequired: 1 | 2
  hasHand: boolean
  canStart: boolean
  onStart: () => void
}) {
  const { handsRequired, hasHand, canStart, onStart } = props

  const assistiveStatus = useMemo(() => {
    if (!hasHand) {
      return handsRequired === 2
        ? 'No hands detected yet. Bring both hands into the frame to begin.'
        : 'No hands detected. Gently bring your hand into the frame to begin.'
    }
    if (canStart) {
      return "You're ready to begin your reset when you like."
    }
    return handsRequired === 2 ? 'Keep easing both hands into the mudra.' : 'Keep easing into the mudra.'
  }, [canStart, hasHand, handsRequired])

  return (
    <div className="webcamRitualHud webcamRitualHudReady">
      <div className="webcamRitualHudCard glassFrostRitualCard">
        <div className="webcamRitualHudReadyRow">
          <div className="webcamRitualHudReadyLead">
            <p className="webcamRitualHudReadySupporting">
              {handsRequired === 2
                ? 'Settle both hands into the mudra gently, then begin your short reset.'
                : 'Settle into the mudra gently, then begin your short reset.'}
            </p>
          </div>
          <div className="webcamRitualHudReadyStart">
            <button
              type="button"
              className="ritualPrimaryBtn ritualPrimaryBtnReadyInCard"
              onClick={onStart}
            >
              Start reset
            </button>
          </div>
        </div>
      </div>
      <span className="breathAssistiveOnly" role="status" aria-live="polite" aria-atomic="true">
        {assistiveStatus}
      </span>
    </div>
  )
}

function WebcamCompletedHud(props: { onStartAgain: () => void }) {
  const { onStartAgain } = props

  return (
    <div className="webcamRitualHud webcamRitualHudReady">
      <div className="webcamRitualHudCard glassFrostRitualCard">
        <div className="webcamRitualHudReadyRow">
          <div className="webcamRitualHudReadyLead">
            <p className="webcamRitualHudReadySupporting">
              Practise Complete! start again, or try another mudra from the list.
            </p>
          </div>
          <div className="webcamRitualHudReadyStart">
            <button type="button" className="ritualPrimaryBtn ritualPrimaryBtnReadyInCard" onClick={onStartAgain}>
              Start again
            </button>
          </div>
        </div>
      </div>
      <span className="breathAssistiveOnly" role="status" aria-live="polite" aria-atomic="true">
        Practise completed. Start again, or choose another mudra from the list.
      </span>
    </div>
  )
}

type PracticeClock = {
  startedAt: number
  pausedMs: number
  pauseSince: number | null
}

export default function MudraPractice() {
  const embeddedWebcamObjectFit = useEmbeddedPracticeObjectFit()
  const webcamRef = useRef<WebcamFeedHandle | null>(null)
  const webcamWrapRef = useRef<HTMLDivElement | null>(null)
  const [practiceCam, setPracticeCam] = useState<PracticeCameraState>({
    permission: { kind: 'idle' },
    isPlaying: false,
    handsStatus: { kind: 'idle' },
  })
  const onPracticeCameraState = useCallback((s: PracticeCameraState) => {
    setPracticeCam(s)
  }, [])

  const trackingReady = useMemo(
    () =>
      practiceCam.permission.kind === 'granted' &&
      practiceCam.isPlaying &&
      practiceCam.handsStatus.kind === 'running',
    [practiceCam],
  )

  const cameraGateUi = useMemo(() => {
    if (trackingReady) return null
    const c = practiceCam
    if (c.permission.kind === 'idle') {
      return {
        title: 'Turn on your camera',
        body: 'Yoga Reset uses your camera to only read your hand position for the mudra practice. No data is stored.',
        showEnableButton: true,
      }
    }
    if (c.permission.kind === 'loading') return null
    if (c.permission.kind === 'granted' && !c.isPlaying) return null
    if (c.permission.kind === 'granted' && c.handsStatus.kind === 'initializing') return null
    if (c.permission.kind === 'granted' && c.handsStatus.kind === 'idle') return null
    if (c.permission.kind === 'denied') {
      return {
        title: 'Turn on your camera',
        body: c.permission.message,
        showEnableButton: true,
      }
    }
    if (c.permission.kind === 'unsupported') {
      return {
        title: 'Camera unavailable',
        body: c.permission.message,
        showEnableButton: false,
      }
    }
    if (c.permission.kind === 'granted' && c.handsStatus.kind === 'error') {
      return {
        title: 'Hand tracking paused',
        body: `${c.handsStatus.message} You can try again if you like.`,
        showEnableButton: true,
      }
    }
    return null
  }, [practiceCam, trackingReady])

  const [selectedMudraId, setSelectedMudraId] = useState(DEFAULT_MUDRA_ID)
  const [selectedPracticeDurationSec, setSelectedPracticeDurationSec] =
    useState<PracticeDurationSeconds>(DEFAULT_PRACTICE_DURATION_SECONDS)
  const [slotLandmarks, setSlotLandmarks] = useState<[Landmark[] | null, Landmark[] | null]>([null, null])
  const [slotFingerStates, setSlotFingerStates] = useState<[FingerStates | null, FingerStates | null]>([
    null,
    null,
  ])
  const [stableSlot, setStableSlot] = useState<[boolean, boolean]>([false, false])
  const [rawHandCount, setRawHandCount] = useState(0)
  /** True when at least one slot is stably present (chips + coarse UI). */
  const [hasHand, setHasHand] = useState(false)
  /** Elapsed in-frame practice time (real seconds; frozen while hand is absent during active). */
  const [practiceElapsedSec, setPracticeElapsedSec] = useState(0)
  const [phase, setPhase] = useState<PracticePhase>('idle')
  const [gentleNotice, setGentleNotice] = useState<string | null>(null)
  const [windDownOverlay, setWindDownOverlay] = useState<BreathingOverlay | null>(null)
  const [practiceToast, setPracticeToast] = useState<{ id: number; text: string } | null>(null)

  const ambient = usePracticeAmbientSound()

  const currentMudra = useMemo(() => getMudraById(selectedMudraId)!, [selectedMudraId])
  const sessionTargetSeconds = useMemo(
    () => sessionTargetFromPracticeDuration(selectedPracticeDurationSec),
    [selectedPracticeDurationSec],
  )

  const phaseRef = useRef(phase)
  const sessionTargetRef = useRef(sessionTargetSeconds)
  const trackingRef = useRef({
    match: emptyMudraMatch(),
  })
  const frameHandsPresentRef = useRef(false)
  const selectedMudraIdRef = useRef(selectedMudraId)
  selectedMudraIdRef.current = selectedMudraId
  const [sessionHandsPresent, setSessionHandsPresent] = useState(false)
  const [frameHandSlots, setFrameHandSlots] = useState<[boolean, boolean]>([false, false])
  const abortAccumRef = useRef({ badAlign: 0 })
  const handGoneSinceRef = useRef<number | null>(null)
  const practiceClockRef = useRef<PracticeClock>({
    startedAt: 0,
    pausedMs: 0,
    pauseSince: null,
  })
  const smoothingRef = useRef({
    slotPresentFrames: [0, 0] as [number, number],
    slotMissingFrames: [0, 0] as [number, number],
    stableSlot: [false, false] as [boolean, boolean],
    smoothedSlotLandmarks: [null, null] as [Landmark[] | null, Landmark[] | null],
    smoothedSlotFingers: [null, null] as [
      Record<FingerName, FingerStable> | null,
      Record<FingerName, FingerStable> | null,
    ],
    _align: undefined as number | undefined,
  })

  const onTrackingDataChangeStable = useCallback((payload: WebcamTrackingPayload) => {
    const s = smoothingRef.current

    for (let i = 0; i < 2; i++) {
      if (payload.hasHandSlot[i]) {
        s.slotPresentFrames[i] += 1
        s.slotMissingFrames[i] = 0
      } else {
        s.slotMissingFrames[i] += 1
        s.slotPresentFrames[i] = 0
      }

      if (!s.stableSlot[i] && s.slotPresentFrames[i] >= HAND_PRESENT_CONFIRM_FRAMES) {
        s.stableSlot[i] = true
      }
      if (s.stableSlot[i] && s.slotMissingFrames[i] >= HAND_MISSING_CONFIRM_FRAMES) {
        s.stableSlot[i] = false
        s.smoothedSlotLandmarks[i] = null
        s.smoothedSlotFingers[i] = null
      }

      const lmAlpha = 0.36
      const fsAlpha = 0.22
      s.smoothedSlotLandmarks[i] = smoothLandmarks(
        s.smoothedSlotLandmarks[i],
        payload.handSlotLandmarks[i],
        lmAlpha,
      )
      s.smoothedSlotFingers[i] = smoothFingerStates(
        s.smoothedSlotFingers[i],
        payload.handSlotFingerStates[i],
        fsAlpha,
      )
    }

    const stable = s.stableSlot
    const lmOut: [Landmark[] | null, Landmark[] | null] = [
      s.smoothedSlotLandmarks[0],
      s.smoothedSlotLandmarks[1],
    ]
    const fsOut: [FingerStates | null, FingerStates | null] = [
      toFingerStates(s.smoothedSlotFingers[0]),
      toFingerStates(s.smoothedSlotFingers[1]),
    ]

    setStableSlot([stable[0], stable[1]])
    setSlotLandmarks(lmOut)
    setSlotFingerStates(fsOut)
    setRawHandCount(payload.rawHandCount)
    setHasHand(stable[0] || stable[1])
    setFrameHandSlots([payload.hasHandSlot[0], payload.hasHandSlot[1]])

    const mudraForFrame = getMudraById(selectedMudraIdRef.current)
    const req = getMudraHandsRequired(mudraForFrame ?? { handsRequired: 1 })
    const present = frameHandsSatisfyRequirement(
      [payload.hasHandSlot[0], payload.hasHandSlot[1]],
      req,
    )
    frameHandsPresentRef.current = present
    setSessionHandsPresent((prev) => (prev === present ? prev : present))
  }, [])

  const breathLastOverlayRef = useRef<BreathingOverlay>({ kind: 'rotate', line: 'Breathe out' })
  const windDownStartRef = useRef<number | null>(null)
  const sessionEndScheduledRef = useRef(false)

  sessionTargetRef.current = sessionTargetSeconds

  const detectionProfile = useMemo(() => getMudraDetectionProfile(currentMudra), [currentMudra])

  const matchSlots = useMemo(
    () =>
      [
        computeMudraAlignment(detectionProfile, slotFingerStates[0], slotLandmarks[0]),
        computeMudraAlignment(detectionProfile, slotFingerStates[1], slotLandmarks[1]),
      ] as const,
    [detectionProfile, slotFingerStates, slotLandmarks],
  )

  const sessionMatch = useMemo(
    () =>
      resolveSessionMudraMatch(
        getMudraHandsRequired(currentMudra),
        matchSlots[0],
        matchSlots[1],
        stableSlot,
      ),
    [currentMudra, matchSlots, stableSlot],
  )

  const filteredMatch = useMemo(() => {
    const prev = smoothingRef.current._align ?? sessionMatch.alignment
    const next = lerp(prev, sessionMatch.alignment, 0.14)
    smoothingRef.current._align = next
    return { ...sessionMatch, alignment: next }
  }, [sessionMatch])

  const sessionHandsOk = useMemo(() => {
    const req = getMudraHandsRequired(currentMudra)
    return req === 1 ? stableSlot[0] || stableSlot[1] : stableSlot[0] && stableSlot[1]
  }, [currentMudra, stableSlot])

  const handPresenceMessage = useMemo(
    () => getHandPresenceCalloutMessage(getMudraHandsRequired(currentMudra), stableSlot, rawHandCount),
    [currentMudra, rawHandCount, stableSlot],
  )

  /** During active pause: frame-accurate chip (e.g. “No hands detected”); idle uses stable debounce. */
  const sessionHandCallout = useMemo(() => {
    const req = getMudraHandsRequired(currentMudra)
    if (phase === 'active' && !sessionHandsPresent) {
      return (
        getHandPresenceCalloutMessage(req, frameHandSlots, rawHandCount) ?? 'No hands detected'
      )
    }
    return handPresenceMessage
  }, [phase, sessionHandsPresent, currentMudra, frameHandSlots, rawHandCount, handPresenceMessage])

  phaseRef.current = phase
  trackingRef.current.match = filteredMatch

  const canStart = useMemo(() => {
    if (!sessionHandsOk) return false

    const req = getMudraHandsRequired(currentMudra)
    if (req === 2) {
      const eachOk =
        matchSlots[0].alignment >= DUAL_EACH_SOFT_MIN && matchSlots[1].alignment >= DUAL_EACH_SOFT_MIN
      const combinedOk =
        filteredMatch.touchMatched &&
        filteredMatch.incorrectFingers.length <= 2 &&
        filteredMatch.alignment >= DUAL_COMBINED_MIN
      return eachOk && combinedOk
    }

    return (
      filteredMatch.touchMatched &&
      filteredMatch.incorrectFingers.length <= 1 &&
      filteredMatch.alignment >= START_ALIGNMENT_MIN
    )
  }, [currentMudra, filteredMatch, matchSlots, sessionHandsOk])

  /** Camera + MediaPipe running — required before starting. Alignment uses `canStart` only as UI feedback. */
  const trackingReadyRef = useRef(trackingReady)
  trackingReadyRef.current = trackingReady

  /** Clears timers, smoothing, and slot UI; does not change `phase` (caller sets idle or active). */
  const applyPracticeEntryReset = useCallback(() => {
    setGentleNotice(null)
    abortAccumRef.current = { badAlign: 0 }
    handGoneSinceRef.current = null
    windDownStartRef.current = null
    setWindDownOverlay(null)
    sessionEndScheduledRef.current = false
    setPracticeToast(null)
    practiceClockRef.current = { startedAt: 0, pausedMs: 0, pauseSince: null }
    setPracticeElapsedSec(0)
    smoothingRef.current = {
      slotPresentFrames: [0, 0],
      slotMissingFrames: [0, 0],
      stableSlot: [false, false],
      smoothedSlotLandmarks: [null, null],
      smoothedSlotFingers: [null, null],
      _align: undefined,
    }
    setSlotLandmarks([null, null])
    setSlotFingerStates([null, null])
    setStableSlot([false, false])
    setRawHandCount(0)
    setHasHand(false)
  }, [])

  const resetPracticeEntry = useCallback(() => {
    applyPracticeEntryReset()
    phaseRef.current = 'idle'
    setPhase('idle')
  }, [applyPracticeEntryReset])

  const resetIfSessionInProgress = useCallback(() => {
    if (phaseRef.current !== 'idle') resetPracticeEntry()
  }, [resetPracticeEntry])

  const onMudraSelect = useCallback(
    (nextId: string) => {
      if (nextId === selectedMudraId) return
      setSelectedMudraId(nextId)
      resetIfSessionInProgress()
    },
    [selectedMudraId, resetIfSessionInProgress],
  )

  const onPracticeDurationSelect = useCallback(
    (nextSec: PracticeDurationSeconds) => {
      if (nextSec === selectedPracticeDurationSec) return
      setSelectedPracticeDurationSec(nextSec)
      resetIfSessionInProgress()
    },
    [selectedPracticeDurationSec, resetIfSessionInProgress],
  )

  /** From completion card: go straight into an active session (timer + breath orb), skip idle/ready. */
  const startAgainFromCompleted = useCallback(() => {
    if (!trackingReadyRef.current) return
    applyPracticeEntryReset()
    const now = performance.now()
    practiceClockRef.current = {
      startedAt: now,
      pausedMs: 0,
      pauseSince: null,
    }
    setPracticeElapsedSec(0)
    frameHandsPresentRef.current = true
    setSessionHandsPresent(true)
    phaseRef.current = 'active'
    setPhase('active')
  }, [applyPracticeEntryReset])

  const breathingOverlay = useMemo(
    () => getBreathingOverlay(practiceElapsedSec, phase, currentMudra, sessionTargetSeconds),
    [phase, practiceElapsedSec, currentMudra, sessionTargetSeconds],
  )

  useEffect(() => {
    if (phase === 'active' && sessionHandsPresent && breathingOverlay.kind !== 'none') {
      breathLastOverlayRef.current = breathingOverlay
    }
  }, [phase, breathingOverlay, sessionHandsPresent])

  const overlayForHud = useMemo((): BreathingOverlay => {
    if (phase === 'finishing') {
      if (windDownOverlay && windDownOverlay.kind !== 'none') return windDownOverlay
      return breathLastOverlayRef.current.kind !== 'none'
        ? breathLastOverlayRef.current
        : { kind: 'rotate', line: 'Breathe out' }
    }
    return breathingOverlay
  }, [phase, windDownOverlay, breathingOverlay])

  const breathAssistiveLine = useMemo(() => {
    if (phase === 'finishing') {
      return 'Session closing softly.'
    }
    if (breathingOverlay.kind === 'none') return ''
    if (breathingOverlay.kind === 'preambleSettle')
      return `${breathingOverlay.line}. Breathing cues begin after five seconds.`
    if (breathingOverlay.kind === 'intro') return breathingOverlay.line
    if (breathingOverlay.kind === 'rotate') return breathingOverlay.line
    const { line, counts, activeIndex } = breathingOverlay
    return `${line}. Beat ${activeIndex + 1} of ${counts.length}.`
  }, [breathingOverlay, phase])

  const dismissPracticeToast = useCallback(() => {
    setPracticeToast(null)
  }, [])

  useEffect(() => {
    if (!practiceToast) return
    const t = window.setTimeout(() => dismissPracticeToast(), 3600)
    return () => window.clearTimeout(t)
  }, [practiceToast, dismissPracticeToast])

  const applyPracticeEntryResetRef = useRef(applyPracticeEntryReset)
  applyPracticeEntryResetRef.current = applyPracticeEntryReset

  const startPractice = useCallback(() => {
    if (!trackingReadyRef.current) return
    const ph = phaseRef.current
    if (ph !== 'idle' && ph !== 'completed') return
    setGentleNotice(null)
    abortAccumRef.current = { badAlign: 0 }
    handGoneSinceRef.current = null
    windDownStartRef.current = null
    setWindDownOverlay(null)
    sessionEndScheduledRef.current = false
    setPracticeToast(null)
    phaseRef.current = 'active'
    const now = performance.now()
    practiceClockRef.current = {
      startedAt: now,
      pausedMs: 0,
      pauseSince: null,
    }
    setPracticeElapsedSec(0)
    frameHandsPresentRef.current = sessionHandsOk
    setSessionHandsPresent(sessionHandsOk)
    setPhase('active')
  }, [sessionHandsOk])

  useEffect(() => {
    const stepMs = 80
    const id = window.setInterval(() => {
      const ph = phaseRef.current
      const shPresent = frameHandsPresentRef.current
      const m = trackingRef.current.match
      const target = sessionTargetRef.current
      const now = performance.now()
      const clk = practiceClockRef.current

      if (ph === 'finishing') {
        const start = windDownStartRef.current
        if (start !== null && now - start >= SESSION_FINISH_HOLD_MS) {
          windDownStartRef.current = null
          queueMicrotask(() => {
            sessionEndScheduledRef.current = false
            practiceClockRef.current = { startedAt: 0, pausedMs: 0, pauseSince: null }
            setPracticeElapsedSec(0)
            setWindDownOverlay(null)
            phaseRef.current = 'completed'
            setPhase('completed')
          })
        }
        return
      }

      if (ph === 'active') {
        const acc = abortAccumRef.current

        if (!shPresent) {
          if (clk.pauseSince === null) clk.pauseSince = now
          if (handGoneSinceRef.current === null) handGoneSinceRef.current = now
          else if (now - handGoneSinceRef.current >= HAND_ABSENT_RESET_MS) {
            handGoneSinceRef.current = null
            acc.badAlign = 0
            sessionEndScheduledRef.current = false
            queueMicrotask(() => {
              applyPracticeEntryResetRef.current()
              phaseRef.current = 'idle'
              setPhase('idle')
            })
            return
          }
        } else {
          if (clk.pauseSince !== null) {
            clk.pausedMs += now - clk.pauseSince
            clk.pauseSince = null
          }
          handGoneSinceRef.current = null
        }

        if (shPresent) {
          const severe =
            m.alignment < 22 ||
            (!m.touchMatched && m.alignment < 32) ||
            m.incorrectFingers.length >= 3
          if (severe) acc.badAlign += stepMs
          else acc.badAlign = Math.max(0, acc.badAlign - stepMs * 0.35)
        } else {
          acc.badAlign = Math.max(0, acc.badAlign - stepMs * 0.25)
        }

        if (acc.badAlign >= ALIGN_LOST_ABORT_MS && shPresent) {
          acc.badAlign = 0
          handGoneSinceRef.current = null
          sessionEndScheduledRef.current = false
          practiceClockRef.current = { startedAt: 0, pausedMs: 0, pauseSince: null }
          setPracticeElapsedSec(0)
          setPhase('idle')
          setGentleNotice('Relax and realign')
          return
        }

        let elapsed = 0
        if (clk.startedAt > 0) {
          let pauseExtra = 0
          if (clk.pauseSince !== null) pauseExtra = now - clk.pauseSince
          elapsed = (now - clk.startedAt - clk.pausedMs - pauseExtra) / 1000
        }
        const capped = Math.min(target, Math.max(0, elapsed))
        setPracticeElapsedSec(capped)
        if (capped < target) {
          sessionEndScheduledRef.current = false
        }
        if (capped >= target && clk.startedAt > 0 && !sessionEndScheduledRef.current) {
          sessionEndScheduledRef.current = true
          queueMicrotask(() => {
            phaseRef.current = 'finishing'
            setWindDownOverlay(
              breathLastOverlayRef.current.kind !== 'none'
                ? breathLastOverlayRef.current
                : { kind: 'rotate', line: 'Breathe out' },
            )
            windDownStartRef.current = performance.now()
            setPhase('finishing')
          })
        }
        return
      }

      if (ph === 'completed') {
        return
      }

      if (ph === 'idle') {
        handGoneSinceRef.current = null
        windDownStartRef.current = null
        sessionEndScheduledRef.current = false
        setWindDownOverlay((prev) => (prev === null ? prev : null))
        practiceClockRef.current = { startedAt: 0, pausedMs: 0, pauseSince: null }
        setPracticeElapsedSec((prev) => (prev === 0 ? prev : 0))
      }
    }, stepMs)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!gentleNotice) return
    const t = window.setTimeout(() => setGentleNotice(null), 7000)
    return () => window.clearTimeout(t)
  }, [gentleNotice])

  const mudraCatalog = useMemo(() => listMudras(), [])

  const showHandFeedbackLayer =
    practiceCam.permission.kind === 'granted' &&
    practiceCam.isPlaying &&
    !(phase === 'idle' && cameraGateUi)

  return (
    <div className="puppetChallengeRoot">
      <div className="pageContainer">
        <header className="siteIntro">
          <p className="siteIntroLabel">A QUIET PAUSE</p>
          <h1 className="siteIntroTitle">Yoga Reset</h1>
          <p className="siteIntroText">
            A guided mudra practice to soften your shoulders, steady your breath, and bring you back
            to the moment right where you are.
          </p>
        </header>
        <main className="puppetMain">
        <aside className="puppetLeft">
          <div className="mudraPickerCard">
            <p className="mudraPickerLabel" id="mudra-duration-picker-label">
              Select Mudra &amp; Duration
            </p>
            <div
              className="mudraPickerRow"
              role="group"
              aria-labelledby="mudra-duration-picker-label"
            >
              <div className="mudraPickerField mudraPickerFieldMudra">
                <div className="mudraPickerShell">
                  <select
                    id="mudra-practice-select"
                    className="mudraPickerSelect"
                    aria-label="Mudra"
                    value={selectedMudraId}
                    disabled={phase === 'active' || phase === 'finishing'}
                    onChange={(e) => onMudraSelect(e.target.value)}
                  >
                    {mudraCatalog.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mudraPickerField mudraPickerFieldDuration">
                <div className="mudraPickerShell">
                  <select
                    id="practice-duration-select"
                    className="mudraPickerSelect mudraPickerSelectDuration"
                    aria-label="Duration"
                    value={selectedPracticeDurationSec}
                    disabled={phase === 'active' || phase === 'finishing'}
                    onChange={(e) =>
                      onPracticeDurationSelect(Number(e.target.value) as PracticeDurationSeconds)
                    }
                  >
                    {PRACTICE_DURATION_OPTIONS.map((opt) => (
                      <option key={opt.seconds} value={opt.seconds}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
          <article className="mudraInfoCard" aria-labelledby="mudra-info-card-title">
            <div className="mudraInfoCardTop">
              <figure className="mudraInfoCardFigure">
                <img
                  className="mudraInfoCardImg"
                  src={currentMudra.illustration}
                  alt={`Illustration: ${currentMudra.name}`}
                  width={220}
                  height={268}
                  decoding="async"
                />
              </figure>
            </div>
            <div className="mudraInfoCardBody">
              <h2 id="mudra-info-card-title" className="mudraInfoCardTitle">
                {currentMudra.name}
              </h2>
              <p className="mudraInfoCardDesc">{currentMudra.description}</p>
            </div>
          </article>

          <div className="practiceStepsCard practiceStepsCardHow">
            <h2 className="practiceStepsTitle">How to practise</h2>
            <ol className="practiceStepsList">
              {HOW_TO_PRACTISE_STEPS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
        </aside>

        <section className="puppetRight">
          <div className="practiceAmbientPanel" role="group" aria-labelledby="practice-ambient-heading">
            <p id="practice-ambient-heading" className="practiceAmbientPanelLabel">
              Soundscape
            </p>
            <div className="practiceAmbientTabs" role="tablist" aria-label="Ambient soundscape">
              {AMBIENT_SOUND_OPTIONS.map((opt) => {
                const selected = ambient.ambientSelection === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`practiceAmbientTab${selected ? ' practiceAmbientTab--active' : ''}`}
                    onClick={() => ambient.setAmbientSelection(opt.id)}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="webcamStage">
            <div ref={webcamWrapRef} className="webcamWrap">
              <div className="webcamVideoLayer">
                <WebcamFeed
                  ref={webcamRef}
                  mode="embedded"
                  autoStart={false}
                  embeddedObjectFit={embeddedWebcamObjectFit}
                  onPracticeCameraState={onPracticeCameraState}
                  onTrackingDataChange={onTrackingDataChangeStable}
                />
              </div>

              <HandAlignmentHandChips
                show={showHandFeedbackLayer}
                phase={phase}
                stableSlot={stableSlot}
                slotLandmarks={slotLandmarks}
                matchSlots={matchSlots}
                canStart={canStart}
                containerRef={webcamWrapRef}
                videoObjectFit={embeddedWebcamObjectFit}
              />

              <div className="webcamOverlayUi">
                {phase === 'idle' && cameraGateUi && (
                  <div className="webcamRitualHudWrap">
                    <WebcamCameraGateHud
                      title={cameraGateUi.title}
                      body={cameraGateUi.body}
                      showEnableButton={cameraGateUi.showEnableButton}
                      onEnableCamera={() => webcamRef.current?.requestCamera()}
                    />
                  </div>
                )}
                {phase === 'idle' && trackingReady && (
                  <div className="webcamRitualHudColumn">
                    <div className="webcamRitualHudWrap">
                      <WebcamReadyHud
                        handsRequired={getMudraHandsRequired(currentMudra)}
                        hasHand={hasHand}
                        canStart={canStart}
                        onStart={startPractice}
                      />
                    </div>
                    {showHandFeedbackLayer && handPresenceMessage && (
                      <HandNoHandCallout message={handPresenceMessage} />
                    )}
                  </div>
                )}
                {phase === 'completed' && trackingReady && (
                  <div className="webcamRitualHudColumn webcamRitualHudColumn--completeEnter">
                    <div className="webcamRitualHudWrap">
                      <WebcamCompletedHud onStartAgain={startAgainFromCompleted} />
                    </div>
                    {showHandFeedbackLayer && handPresenceMessage && (
                      <HandNoHandCallout message={handPresenceMessage} />
                    )}
                  </div>
                )}
                {(phase === 'active' || phase === 'finishing') && trackingReady && (
                  <div className="webcamRitualHudColumn">
                    <div
                      className="webcamRitualHudWrap"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      <WebcamRitualHud
                        mudra={currentMudra}
                        phase={phase}
                        practiceElapsedSec={practiceElapsedSec}
                        sessionTargetSeconds={sessionTargetSeconds}
                        breathingOverlay={overlayForHud}
                        breathAssistiveLine={breathAssistiveLine}
                        sessionHandsPresent={sessionHandsPresent}
                      />
                    </div>
                    {showHandFeedbackLayer && sessionHandCallout && (
                      <HandNoHandCallout message={sessionHandCallout} />
                    )}
                  </div>
                )}
              </div>
              {practiceToast && (
                <div
                  key={practiceToast.id}
                  className="practiceToast"
                  role="status"
                  aria-live="polite"
                  onAnimationEnd={(e) => {
                    if (
                      e.animationName === 'practiceToastLife' ||
                      e.animationName.includes('practiceToast')
                    ) {
                      dismissPracticeToast()
                    }
                  }}
                >
                  {practiceToast.text}
                </div>
              )}
            </div>
          </div>

          <footer className="practiceFooter">
            <p className="practiceFooterText">
              {phase === 'finishing'
                ? 'Let this quiet settle in.'
                : phase === 'active'
                  ? 'Let the camera hold your attention lightly.'
                  : phase === 'completed'
                    ? 'Take a breath before you begin again, if you like.'
                    : 'The view in front of you is the practice space.'}
            </p>
          </footer>
        </section>
        </main>
      </div>
    </div>
  )
}
