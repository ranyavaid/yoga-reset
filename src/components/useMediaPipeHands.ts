import { useEffect, useRef, useState } from 'react'
import {
  loadMediaPipeHandsRuntime,
  mediapipeHandsLocateFile,
  type MediaPipeHandsRuntime,
  type NormalizedLandmark,
} from '../lib/mediapipeLoader'

export type { NormalizedLandmark }

export type HandsStatus =
  | { kind: 'idle' }
  | { kind: 'initializing' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }

/** Screen-order slots (left → right in the mirrored selfie view). Up to two hands. */
export type HandSlotLandmarks = [NormalizedLandmark[] | null, NormalizedLandmark[] | null]

export type UseMediaPipeHandsResult = {
  status: HandsStatus
  /** True if at least one hand is currently tracked */
  hasHand: boolean
  /** Number of raw detections this frame (0–2), before slot smoothing */
  rawHandCount: number
  /** Mirrored-view horizontal centres (0–1) for each slot, for continuity */
  handSlots: HandSlotLandmarks
  /** First occupied slot in screen order — for legacy single-hand consumers */
  landmarks: NormalizedLandmark[] | null
}

type HandsResults = {
  multiHandLandmarks?: NormalizedLandmark[][]
}

function mirroredMeanX(landmarks: NormalizedLandmark[]): number {
  let s = 0
  for (const p of landmarks) s += 1 - p.x
  return s / landmarks.length
}

function assignHandsToSlots(
  detected: NormalizedLandmark[][],
  prevCenters: [number | null, number | null],
): HandSlotLandmarks {
  const empty: HandSlotLandmarks = [null, null]

  if (detected.length === 0) return empty

  if (detected.length === 1) {
    const lm = detected[0]!
    const cx = mirroredMeanX(lm)
    const [p0, p1] = prevCenters
    if (p0 == null && p1 == null) {
      return [lm, null]
    }
    if (p0 != null && p1 == null) {
      return Math.abs(cx - p0) <= 0.18 ? [lm, null] : [null, lm]
    }
    if (p0 == null && p1 != null) {
      return Math.abs(cx - p1) <= 0.18 ? [null, lm] : [lm, null]
    }
    const d0 = Math.abs(cx - (p0 ?? 0.5))
    const d1 = Math.abs(cx - (p1 ?? 0.5))
    return d0 <= d1 ? [lm, null] : [null, lm]
  }

  const sorted = [...detected].sort((a, b) => mirroredMeanX(a) - mirroredMeanX(b))
  return [sorted[0] ?? null, sorted[1] ?? null]
}

function createResizeObserver(
  el: HTMLElement,
  onResize: (rect: DOMRectReadOnly) => void,
): () => void {
  const ro = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (entry) onResize(entry.contentRect)
  })
  ro.observe(el)
  return () => ro.disconnect()
}

function syncCanvasToElement(canvas: HTMLCanvasElement, el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(rect.width))
  const height = Math.max(1, Math.floor(rect.height))

  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const nextW = Math.round(width * dpr)
  const nextH = Math.round(height * dpr)
  if (canvas.width !== nextW) canvas.width = nextW
  if (canvas.height !== nextH) canvas.height = nextH
}

function friendlyInitError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Failed to initialize hand tracking.'
  const anyErr = err as { message?: string; name?: string }
  return anyErr.message?.trim() || anyErr.name || 'Failed to initialize hand tracking.'
}

export type VideoObjectFitMode = 'cover' | 'contain'

function drawHandSkeleton(
  ctx: CanvasRenderingContext2D,
  handLandmarks: NormalizedLandmark[],
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  objectFit: VideoObjectFitMode,
  HAND_CONNECTIONS: Array<[number, number]>,
  drawConnectors: MediaPipeHandsRuntime['drawConnectors'],
  drawLandmarks: MediaPipeHandsRuntime['drawLandmarks'],
) {
  const vw = video.videoWidth || 0
  const vh = video.videoHeight || 0
  const cw = canvas.clientWidth || 0
  const ch = canvas.clientHeight || 0

  if (vw > 0 && vh > 0 && cw > 0 && ch > 0) {
    const dprX = canvas.width / cw
    const dprY = canvas.height / ch

    const scale =
      objectFit === 'contain' ? Math.min(cw / vw, ch / vh) : Math.max(cw / vw, ch / vh)
    const scaledW = vw * scale
    const scaledH = vh * scale
    const offsetX = (cw - scaledW) / 2
    const offsetY = (ch - scaledH) / 2

    const a = (vw * scale) / cw
    const d = (vh * scale) / ch
    const e = offsetX * dprX
    const f = offsetY * dprY

    ctx.save()
    ctx.setTransform(a, 0, 0, d, e, f)

    drawConnectors(ctx, handLandmarks, HAND_CONNECTIONS, {
      color: 'rgba(168, 188, 172, 0.42)',
      lineWidth: 1.35,
    })
    drawLandmarks(ctx, handLandmarks, {
      color: 'rgba(210, 220, 212, 0.55)',
      fillColor: 'rgba(12, 16, 14, 0.45)',
      radius: 1.4,
    })

    ctx.restore()
  } else {
    drawConnectors(ctx, handLandmarks, HAND_CONNECTIONS, {
      color: 'rgba(168, 188, 172, 0.42)',
      lineWidth: 1.35,
    })
    drawLandmarks(ctx, handLandmarks, {
      color: 'rgba(210, 220, 212, 0.55)',
      fillColor: 'rgba(12, 16, 14, 0.45)',
      radius: 1.4,
    })
  }
}

/**
 * Runs MediaPipe Hands on the provided <video> element and draws landmarks
 * into the provided <canvas> overlay.
 *
 * Tracks up to two hands (screen-order slots) for dual-hand mudras while
 * remaining compatible with single-hand scoring in the practice layer.
 */
export function useMediaPipeHands(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
  objectFit: VideoObjectFitMode = 'cover',
): UseMediaPipeHandsResult {
  const [status, setStatus] = useState<HandsStatus>({ kind: 'idle' })
  const [hasHand, setHasHand] = useState(false)
  const [rawHandCount, setRawHandCount] = useState(0)
  const [handSlots, setHandSlots] = useState<HandSlotLandmarks>([null, null])
  const [landmarks, setLandmarks] = useState<NormalizedLandmark[] | null>(null)

  const handsRef = useRef<{ close: () => void } | null>(null)
  const objectFitRef = useRef(objectFit)
  const enabledRef = useRef(enabled)
  const rafRef = useRef<number | null>(null)
  const sendingRef = useRef(false)
  const lastLandmarksUpdateRef = useRef(0)
  const lastHasHandRef = useRef(false)
  const slotCenterRef = useRef<[number | null, number | null]>([null, null])

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    objectFitRef.current = objectFit
  }, [objectFit])

  useEffect(() => {
    if (!enabled) return

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    let cancelled = false

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setStatus({ kind: 'error', message: 'Canvas 2D context is not available.' })
      return
    }

    setStatus({ kind: 'initializing' })

    const ensureCanvasSized = () => syncCanvasToElement(canvas, video)
    ensureCanvasSized()

    const cleanupResize =
      typeof ResizeObserver !== 'undefined'
        ? createResizeObserver(video, () => ensureCanvasSized())
        : () => {}

    void loadMediaPipeHandsRuntime()
      .then((mp) => {
        if (cancelled) return

        const { Hands: HandsCtor, HAND_CONNECTIONS, drawConnectors, drawLandmarks } = mp

        const hands = new HandsCtor({ locateFile: mediapipeHandsLocateFile })
        handsRef.current = hands
        hands.setOptions({
          selfieMode: false,
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.48,
          minTrackingConfidence: 0.48,
        })

        hands.onResults((results: HandsResults) => {
          if (!enabledRef.current) return

          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, canvas.width, canvas.height)

          const raw = results.multiHandLandmarks ?? []
          const n = raw.length
          const slots = assignHandsToSlots(raw, slotCenterRef.current)

          slotCenterRef.current = [
            slots[0] ? mirroredMeanX(slots[0]) : null,
            slots[1] ? mirroredMeanX(slots[1]) : null,
          ]

          for (const lm of raw) {
            drawHandSkeleton(
              ctx,
              lm,
              video,
              canvas,
              objectFitRef.current,
              HAND_CONNECTIONS,
              drawConnectors,
              drawLandmarks,
            )
          }

          if (n === 0) {
            if (lastHasHandRef.current) {
              setHasHand(false)
              setRawHandCount(0)
              setHandSlots([null, null])
              setLandmarks(null)
              lastHasHandRef.current = false
            }
            return
          }

          const now = performance.now()
          if (now - lastLandmarksUpdateRef.current < 120) return
          lastLandmarksUpdateRef.current = now

          setHasHand(true)
          lastHasHandRef.current = true
          setRawHandCount(n)
          const copy0 = slots[0] ? [...slots[0]] : null
          const copy1 = slots[1] ? [...slots[1]] : null
          setHandSlots([copy0, copy1])
          setLandmarks(copy0 ?? copy1)
        })

        const tick = () => {
          if (cancelled || !enabledRef.current) return

          rafRef.current = window.requestAnimationFrame(tick)

          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
          if (sendingRef.current) return

          sendingRef.current = true
          ensureCanvasSized()

          hands
            .send({ image: video })
            .catch((err) => {
              if (cancelled) return
              setStatus({ kind: 'error', message: friendlyInitError(err) })
            })
            .finally(() => {
              sendingRef.current = false
            })
        }

        rafRef.current = window.requestAnimationFrame(tick)
        setStatus({ kind: 'running' })
      })
      .catch((err) => {
        if (cancelled) return
        setStatus({
          kind: 'error',
          message:
            err instanceof Error && err.message
              ? err.message
              : 'MediaPipe libraries failed to load. Check your connection and reload the page.',
        })
      })

    return () => {
      cancelled = true
      cleanupResize()
      setHasHand(false)
      setRawHandCount(0)
      setHandSlots([null, null])
      setLandmarks(null)
      slotCenterRef.current = [null, null]
      sendingRef.current = false

      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }

      try {
        handsRef.current?.close()
      } catch {
        // ignore
      } finally {
        handsRef.current = null
      }
    }
  }, [canvasRef, enabled, videoRef])

  return { status, hasHand, rawHandCount, handSlots, landmarks }
}
