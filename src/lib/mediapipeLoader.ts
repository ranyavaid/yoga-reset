/** Pinned to package.json versions so WASM/assets match the JS API. */
const MEDIAPIPE_HANDS_VERSION = '0.4.1675469240'
const MEDIAPIPE_DRAWING_UTILS_VERSION = '0.3.1675466124'

export const MEDIAPIPE_HANDS_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_HANDS_VERSION}/`
const MEDIAPIPE_DRAWING_UTILS_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@${MEDIAPIPE_DRAWING_UTILS_VERSION}/`

export type NormalizedLandmark = { x: number; y: number; z?: number; visibility?: number }

export type MediaPipeHandsRuntime = {
  Hands: new (opts: { locateFile?: (file: string) => string }) => {
    setOptions: (opts: Record<string, unknown>) => void
    onResults: (cb: (r: { multiHandLandmarks?: NormalizedLandmark[][] }) => void) => void
    send: (input: { image: HTMLVideoElement }) => Promise<void>
    close: () => void
  }
  HAND_CONNECTIONS: Array<[number, number]>
  drawConnectors: (
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmark[],
    connections: Array<[number, number]>,
    style?: Record<string, unknown>,
  ) => void
  drawLandmarks: (
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmark[],
    style?: Record<string, unknown>,
  ) => void
}

function getMediaPipeWindow(): MediaPipeHandsRuntime | null {
  const w = window as Window & Partial<MediaPipeHandsRuntime>
  if (!w.Hands || !w.HAND_CONNECTIONS || !w.drawConnectors || !w.drawLandmarks) return null
  return w as MediaPipeHandsRuntime
}

export function mediapipeHandsLocateFile(file: string): string {
  return `${MEDIAPIPE_HANDS_CDN}${file}`
}

function loadClassicScript(src: string): Promise<void> {
  const marker = `script[data-mediapipe="${src}"]`
  const existing = document.querySelector(marker) as HTMLScriptElement | null
  if (existing?.dataset.mediapipeLoaded === 'true') {
    return Promise.resolve()
  }
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      })
    })
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.crossOrigin = 'anonymous'
    script.setAttribute('data-mediapipe', src)
    script.onload = () => {
      script.dataset.mediapipeLoaded = 'true'
      resolve()
    }
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(script)
  })
}

let runtimeLoadPromise: Promise<MediaPipeHandsRuntime> | null = null

/**
 * Loads MediaPipe Hands + drawing utils from jsDelivr (classic scripts attach to `window`).
 * Safe to call multiple times; resolves when globals are ready.
 */
export function loadMediaPipeHandsRuntime(): Promise<MediaPipeHandsRuntime> {
  const ready = getMediaPipeWindow()
  if (ready) return Promise.resolve(ready)

  if (!runtimeLoadPromise) {
    runtimeLoadPromise = (async () => {
      await loadClassicScript(`${MEDIAPIPE_DRAWING_UTILS_CDN}drawing_utils.js`)
      await loadClassicScript(`${MEDIAPIPE_HANDS_CDN}hands.js`)
      const runtime = getMediaPipeWindow()
      if (!runtime) {
        throw new Error('MediaPipe scripts loaded but globals are missing.')
      }
      return runtime
    })().catch((err) => {
      runtimeLoadPromise = null
      throw err
    })
  }

  return runtimeLoadPromise
}
