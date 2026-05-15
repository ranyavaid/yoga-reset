import { useCallback, useEffect, useRef, useState } from 'react'

/** Ambient bed selection; playback starts only after the user uses this control (no autoplay). */
export type AmbientSoundId = 'off' | 'rain' | 'river' | 'birds'

export const AMBIENT_SOUND_OPTIONS: { id: AmbientSoundId; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'rain', label: 'Rainfall' },
  { id: 'river', label: 'River Flow' },
  { id: 'birds', label: 'Morning Birds' },
]

const AMBIENT_URLS: Record<Exclude<AmbientSoundId, 'off'>, string> = {
  rain: '/audio/rain.mp3',
  river: '/audio/river.mp3',
  birds: '/audio/birds.mp3',
}

/** ~20% perceived level */
const TARGET_VOLUME = 0.22
const CROSSFADE_MS = 520

function smoothstep01(t: number) {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

function slotIsAudible(el: HTMLAudioElement | null) {
  return Boolean(el && el.src && (!el.paused || el.volume > 0.001))
}

export type PracticeAmbientApi = {
  ambientSelection: AmbientSoundId
  setAmbientSelection: (id: AmbientSoundId) => void
}

/**
 * Two-slot crossfade between looping beds; no playback until `setAmbientSelection` runs from UI.
 */
export function usePracticeAmbientSound(): PracticeAmbientApi {
  const [ambientSelection, setAmbientSelectionState] = useState<AmbientSoundId>('off')
  const slotsRef = useRef<[HTMLAudioElement | null, HTMLAudioElement | null]>([null, null])
  const audibleSlotRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const playingIdRef = useRef<AmbientSoundId>('off')

  const ensureSlot = useCallback((index: 0 | 1) => {
    if (typeof window === 'undefined') return null
    let el = slotsRef.current[index]
    if (!el) {
      el = new Audio()
      el.preload = 'none'
      el.loop = true
      slotsRef.current[index] = el
    }
    return el
  }, [])

  const cancelFade = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const hardStopSlot = useCallback((index: 0 | 1) => {
    const el = slotsRef.current[index]
    if (!el) return
    el.pause()
    el.volume = 0
    el.removeAttribute('src')
    el.load()
  }, [])

  const silenceSlotsAndRefs = useCallback(() => {
    hardStopSlot(0)
    hardStopSlot(1)
    audibleSlotRef.current = null
    playingIdRef.current = 'off'
  }, [hardStopSlot])

  const hardStopAll = useCallback(() => {
    cancelFade()
    silenceSlotsAndRefs()
  }, [cancelFade, silenceSlotsAndRefs])

  const runCrossfade = useCallback(
    (fromIndex: number | null, toIndex: 0 | 1, soundId: Exclude<AmbientSoundId, 'off'>) => {
      const incoming = ensureSlot(toIndex)
      if (!incoming) return

      const url = AMBIENT_URLS[soundId]
      incoming.src = url
      incoming.volume = 0

      const outgoing =
        fromIndex !== null && fromIndex !== toIndex ? slotsRef.current[fromIndex] : null

      void incoming.play().catch(() => {
        // Missing asset or policy — selection still updates; audio may stay silent.
      })

      const fromStartVol = outgoing && fromIndex !== null ? outgoing.volume : 0
      const start = performance.now()

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / CROSSFADE_MS)
        const k = smoothstep01(t)
        if (outgoing && fromIndex !== null) {
          outgoing.volume = fromStartVol * (1 - k)
        }
        incoming.volume = TARGET_VOLUME * k
        if (t < 1) {
          rafRef.current = requestAnimationFrame(tick)
        } else {
          rafRef.current = null
          if (outgoing && fromIndex !== null) {
            outgoing.pause()
            outgoing.volume = 0
            outgoing.removeAttribute('src')
            outgoing.load()
          }
          incoming.volume = TARGET_VOLUME
          audibleSlotRef.current = toIndex
          playingIdRef.current = soundId
        }
      }

      cancelFade()
      rafRef.current = requestAnimationFrame(tick)
    },
    [cancelFade, ensureSlot],
  )

  const runFadeOut = useCallback(() => {
    cancelFade()
    const s = slotsRef.current
    const active: { el: HTMLAudioElement; startVol: number }[] = []
    for (let i = 0; i < 2; i++) {
      const el = s[i]
      if (slotIsAudible(el)) {
        active.push({ el: el!, startVol: el!.volume })
      }
    }
    if (active.length === 0) {
      silenceSlotsAndRefs()
      return
    }

    const startVols = active.map((a) => a.startVol)
    const start = performance.now()

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / CROSSFADE_MS)
      const k = smoothstep01(t)
      active.forEach((a, i) => {
        a.el.volume = startVols[i] * (1 - k)
      })
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        active.forEach((a) => {
          a.el.pause()
          a.el.volume = 0
          a.el.removeAttribute('src')
          a.el.load()
        })
        audibleSlotRef.current = null
        playingIdRef.current = 'off'
      }
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [cancelFade, silenceSlotsAndRefs])

  const applySelection = useCallback(
    (next: AmbientSoundId) => {
      if (next !== 'off' && next === playingIdRef.current && rafRef.current === null) {
        return
      }

      if (next === 'off') {
        const s = slotsRef.current
        const anyAudible = s.some((el) => slotIsAudible(el))
        if (!anyAudible && playingIdRef.current === 'off') {
          return
        }
        runFadeOut()
        return
      }

      if (rafRef.current !== null) {
        cancelFade()
        hardStopSlot(0)
        hardStopSlot(1)
        audibleSlotRef.current = null
        playingIdRef.current = 'off'
      }

      const fromIdx = audibleSlotRef.current
      const toIdx: 0 | 1 = fromIdx === 0 ? 1 : 0
      runCrossfade(fromIdx, toIdx, next)
    },
    [cancelFade, hardStopSlot, runCrossfade, runFadeOut],
  )

  const setAmbientSelection = useCallback(
    (id: AmbientSoundId) => {
      setAmbientSelectionState(id)
      applySelection(id)
    },
    [applySelection],
  )

  useEffect(() => {
    return () => {
      hardStopAll()
    }
  }, [hardStopAll])

  return {
    ambientSelection,
    setAmbientSelection,
  }
}
