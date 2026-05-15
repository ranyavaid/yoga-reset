import type { CSSProperties } from 'react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  useMediaPipeHands,
  type HandSlotLandmarks,
  type HandsStatus,
  type NormalizedLandmark,
  type VideoObjectFitMode,
} from './useMediaPipeHands'
import {
  detectFingerStatesFromLandmarks,
  type FingerStates,
} from './fingerDetection'

export type PermissionState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'granted' }
  | { kind: 'denied'; message: string }
  | { kind: 'unsupported'; message: string }

export type PracticeCameraState = {
  permission: PermissionState
  isPlaying: boolean
  handsStatus: HandsStatus
}

export type WebcamFeedHandle = {
  requestCamera: () => void
}

function getFriendlyError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Could not access the camera.'
  const anyErr = err as { name?: string; message?: string }
  const name = anyErr.name ?? ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission was blocked. Allow camera access in your browser settings and reload.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found on this device.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Your camera is already in use by another app.'
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'This camera does not support the requested settings.'
  }
  if (name === 'SecurityError') {
    return 'Camera access is only allowed in secure contexts (HTTPS or localhost).'
  }
  return anyErr.message?.trim() || 'Could not access the camera.'
}

const TRACKING_EMIT_MS = 100

function slotLandmarksSig(lm: NormalizedLandmark[] | null): string {
  if (!lm?.length) return 'x'
  const p = (i: number) => {
    const q = lm[i]!
    return `${q.x.toFixed(3)},${q.y.toFixed(3)}`
  }
  return `${p(0)}|${p(5)}|${p(9)}|${p(17)}`
}

function fingerStatesSig(fs: FingerStates | null): string {
  if (!fs) return 'x'
  return (Object.keys(fs) as (keyof FingerStates)[])
    .sort()
    .map((k) => `${k}:${fs[k].isOpen ? 1 : 0}:${fs[k].openScore.toFixed(2)}`)
    .join(',')
}

function trackingPayloadFingerprint(
  rawHandCount: number,
  hasHandSlot: [boolean, boolean],
  hasHand: boolean,
  lm0: NormalizedLandmark[] | null,
  lm1: NormalizedLandmark[] | null,
  fs0: FingerStates | null,
  fs1: FingerStates | null,
): string {
  return [
    rawHandCount,
    hasHandSlot[0] ? 1 : 0,
    hasHandSlot[1] ? 1 : 0,
    hasHand ? 1 : 0,
    slotLandmarksSig(lm0),
    slotLandmarksSig(lm1),
    fingerStatesSig(fs0),
    fingerStatesSig(fs1),
  ].join('#')
}

function cloneSlotLandmarks(slots: HandSlotLandmarks): HandSlotLandmarks {
  const c0 = slots[0] ? slots[0].map((p) => ({ ...p })) : null
  const c1 = slots[1] ? slots[1].map((p) => ({ ...p })) : null
  return [c0, c1]
}

export type WebcamTrackingPayload = {
  handSlotLandmarks: HandSlotLandmarks
  handSlotFingerStates: [FingerStates | null, FingerStates | null]
  hasHandSlot: [boolean, boolean]
  rawHandCount: number
  fingerStates: FingerStates | null
  landmarks: Array<{ x: number; y: number; z?: number; visibility?: number }> | null
  hasHand: boolean
}

export type WebcamFeedProps = {
  mode?: 'fullscreen' | 'embedded'
  /** When false, camera starts only after `requestCamera()` (via ref). Embedded practice uses this. */
  autoStart?: boolean
  /**
   * How the video fills the embedded container. Use `contain` on narrow viewports so more of the
   * camera frame is visible; skeleton overlay uses the same mapping.
   */
  embeddedObjectFit?: VideoObjectFitMode
  onPracticeCameraState?: (state: PracticeCameraState) => void
  onFingerStatesChange?: (states: FingerStates | null) => void
  onTrackingDataChange?: (payload: WebcamTrackingPayload) => void
}

const WebcamFeed = forwardRef<WebcamFeedHandle, WebcamFeedProps>(function WebcamFeed(
  {
    mode = 'fullscreen',
    autoStart = true,
    embeddedObjectFit = 'cover',
    onPracticeCameraState,
    onFingerStatesChange,
    onTrackingDataChange,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [permission, setPermission] = useState<PermissionState>({ kind: 'idle' })
  const [isPlaying, setIsPlaying] = useState(false)

  const handsEnabled = permission.kind === 'granted' && isPlaying
  const videoObjectFit: VideoObjectFitMode = mode === 'embedded' ? embeddedObjectFit : 'cover'
  const hands = useMediaPipeHands(videoRef, canvasRef, handsEnabled, videoObjectFit)

  const handsRef = useRef(hands)
  handsRef.current = hands

  const permissionRef = useRef(permission)
  permissionRef.current = permission

  const onFingerStatesChangeRef = useRef(onFingerStatesChange)
  onFingerStatesChangeRef.current = onFingerStatesChange

  const onTrackingDataChangeRef = useRef(onTrackingDataChange)
  onTrackingDataChangeRef.current = onTrackingDataChange

  const trackingFingerprintRef = useRef('')

  const canUseCamera = useMemo(() => {
    return (
      typeof window !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    )
  }, [])

  const stopStream = () => {
    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
  }

  const start = async () => {
    if (!canUseCamera) {
      setPermission({
        kind: 'unsupported',
        message: 'Your browser does not support webcam access (getUserMedia).',
      })
      return
    }

    setIsPlaying(false)
    setPermission({ kind: 'loading' })

    try {
      stopStream()

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          aspectRatio: 16 / 9,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })

      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        // Autoplay can be blocked unless muted; playsInline improves iOS behavior.
        await video.play()
      }

      setPermission({ kind: 'granted' })
      setIsPlaying(true)
    } catch (err) {
      stopStream()
      setPermission({ kind: 'denied', message: getFriendlyError(err) })
    }
  }

  useImperativeHandle(ref, () => ({
    requestCamera: () => {
      void start()
    },
  }))

  useEffect(() => {
    return () => stopStream()
  }, [])

  useEffect(() => {
    if (!autoStart) return
    queueMicrotask(() => {
      void start()
    })
    // Intentionally run once on mount when autoStart; omit start from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart])

  useEffect(() => {
    onPracticeCameraState?.({
      permission,
      isPlaying,
      handsStatus: hands.status,
    })
  }, [permission, isPlaying, hands.status, onPracticeCameraState])

  /**
   * Push tracking + finger state to parents on a fixed cadence (~100ms). Callback identities and
   * landmark arrays are not effect deps (they are unstable); we read latest values from refs and
   * skip emits when a compact fingerprint is unchanged to avoid render loops.
   */
  useEffect(() => {
    trackingFingerprintRef.current = ''
    if (!handsEnabled) return

    const tick = () => {
      const h = handsRef.current
      const granted = permissionRef.current.kind === 'granted'
      const lm0 = granted && h.handSlots[0] ? h.handSlots[0] : null
      const lm1 = granted && h.handSlots[1] ? h.handSlots[1] : null
      const fs0 = lm0 ? detectFingerStatesFromLandmarks(lm0) : null
      const fs1 = lm1 ? detectFingerStatesFromLandmarks(lm1) : null
      const hasSlot: [boolean, boolean] = [!!lm0, !!lm1]
      const hasHand = hasSlot[0] || hasSlot[1]

      const fp = trackingPayloadFingerprint(
        h.rawHandCount,
        hasSlot,
        hasHand,
        lm0,
        lm1,
        fs0,
        fs1,
      )
      if (fp === trackingFingerprintRef.current) return
      trackingFingerprintRef.current = fp

      const payload: WebcamTrackingPayload = {
        handSlotLandmarks: cloneSlotLandmarks([lm0, lm1]),
        handSlotFingerStates: [fs0, fs1],
        hasHandSlot: hasSlot,
        rawHandCount: h.rawHandCount,
        fingerStates: fs0 ?? fs1 ?? null,
        landmarks: h.landmarks ? h.landmarks.map((p) => ({ ...p })) : null,
        hasHand,
      }

      onFingerStatesChangeRef.current?.(fs0 ?? fs1 ?? null)
      onTrackingDataChangeRef.current?.(payload)
    }

    tick()
    const id = window.setInterval(tick, TRACKING_EMIT_MS)
    return () => window.clearInterval(id)
  }, [handsEnabled])

  const suppressBuiltInPermissionUi = mode === 'embedded' && autoStart === false

  const videoStyle =
    mode === 'embedded'
      ? { ...styles.video, objectFit: videoObjectFit }
      : styles.video
  const canvasStyle = styles.canvas

  return (
    <div style={mode === 'fullscreen' ? styles.rootFullscreen : styles.rootEmbedded}>
      <video
        ref={videoRef}
        style={videoStyle}
        muted
        playsInline
        autoPlay
      />

      <canvas ref={canvasRef} style={canvasStyle} />

      <div
        style={mode === 'embedded' ? styles.vignetteEmbedded : styles.vignette}
        aria-hidden="true"
      />

      <div style={mode === 'embedded' ? styles.uiEmbedded : styles.ui}>
        {mode === 'fullscreen' && (
          <div style={styles.brandRow}>
            <div style={styles.dot} aria-hidden="true" />
            <div style={styles.title}>Webcam Feed</div>
          </div>
        )}

        {!suppressBuiltInPermissionUi && permission.kind === 'loading' && (
          <div style={styles.card} role="status" aria-live="polite">
            <div style={styles.cardTitle}>Starting camera…</div>
            <div style={styles.cardBody}>
              If you see a prompt, allow camera access.
            </div>
          </div>
        )}

        {!suppressBuiltInPermissionUi && permission.kind === 'granted' && hands.status.kind === 'initializing' && (
          <div style={styles.card} role="status" aria-live="polite">
            <div style={styles.cardTitle}>Initializing hand tracking…</div>
            <div style={styles.cardBody}>
              Loading the model and warming up. This should take a moment.
            </div>
          </div>
        )}

        {!suppressBuiltInPermissionUi && permission.kind === 'granted' && hands.status.kind === 'error' && (
          <div style={styles.card} role="alert">
            <div style={styles.cardTitle}>Hand tracking unavailable</div>
            <div style={styles.cardBody}>{hands.status.message}</div>
          </div>
        )}

        {!suppressBuiltInPermissionUi && permission.kind === 'unsupported' && (
          <div style={styles.card} role="status" aria-live="polite">
            <div style={styles.cardTitle}>Unsupported</div>
            <div style={styles.cardBody}>{permission.message}</div>
          </div>
        )}

        {!suppressBuiltInPermissionUi && permission.kind === 'denied' && (
          <div style={styles.card} role="alert">
            <div style={styles.cardTitle}>Camera unavailable</div>
            <div style={styles.cardBody}>{permission.message}</div>
            <div style={styles.actions}>
              <button type="button" onClick={() => void start()} style={styles.button}>
                Try again
              </button>
            </div>
          </div>
        )}

        {!suppressBuiltInPermissionUi && permission.kind === 'granted' && !isPlaying && (
          <div style={styles.card} role="status" aria-live="polite">
            <div style={styles.cardTitle}>Almost there…</div>
            <div style={styles.cardBody}>Waiting for the video to start.</div>
          </div>
        )}
      </div>
    </div>
  )
})

export default WebcamFeed

const styles: Record<string, CSSProperties> = {
  rootFullscreen: {
    position: 'fixed',
    inset: 0,
    background: '#0b0c10',
    overflow: 'hidden',
    color: 'rgba(255,255,255,0.92)',
  },
  rootEmbedded: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '100%',
    minWidth: 0,
    background: '#0b0c10',
    overflow: 'hidden',
    borderRadius: 18,
    color: 'rgba(255,255,255,0.92)',
  },
  video: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    transform: 'scaleX(-1)', // mirror for "selfie" camera UX
    filter: 'saturate(1.05) contrast(1.05)',
  },
  canvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    transform: 'scaleX(-1)', // mirror overlay to match the video
  },
  vignette: {
    position: 'absolute',
    inset: 0,
    background:
      'radial-gradient(1200px 800px at 50% 35%, rgba(0,0,0,0.20), rgba(0,0,0,0.72))',
    pointerEvents: 'none',
  },
  vignetteEmbedded: {
    position: 'absolute',
    inset: 0,
    background:
      'radial-gradient(900px 600px at 50% 40%, rgba(0,0,0,0.06), rgba(0,0,0,0.38))',
    pointerEvents: 'none',
  },
  ui: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: 'max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))',
    boxSizing: 'border-box',
    gap: 12,
  },
  uiEmbedded: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-start',
    alignItems: 'center',
    padding:
      'max(16px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))',
    boxSizing: 'border-box',
    gap: 8,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    background: 'rgba(10, 12, 18, 0.35)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 14,
    padding: '10px 12px',
    width: 'fit-content',
    boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: 'linear-gradient(180deg, rgba(192,132,252,1), rgba(170,59,255,1))',
    boxShadow: '0 0 0 6px rgba(192,132,252,0.15)',
  },
  title: {
    fontFamily: 'system-ui, Segoe UI, Roboto, sans-serif',
    fontWeight: 600,
    letterSpacing: 0.2,
    fontSize: 14,
    color: 'rgba(255,255,255,0.92)',
  },
  card: {
    width: 'min(520px, 100%)',
    alignSelf: 'center',
    textAlign: 'left',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    background: 'rgba(10, 12, 18, 0.55)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 18,
    padding: 16,
    boxShadow: '0 24px 90px rgba(0,0,0,0.45)',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 650,
    color: 'rgba(255,255,255,0.95)',
    marginBottom: 6,
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 1.45,
    color: 'rgba(255,255,255,0.78)',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  button: {
    appearance: 'none',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(192,132,252,0.16)',
    color: 'rgba(255,255,255,0.95)',
    padding: '10px 12px',
    borderRadius: 12,
    fontWeight: 650,
    cursor: 'pointer',
  },
}
