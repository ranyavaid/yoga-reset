export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'

export type FingerState = {
  isOpen: boolean
  openScore: number // 0..1, how "open" / extended the finger looks
}

export type FingerStates = Record<FingerName, FingerState>

type NormalizedLandmark = { x: number; y: number; z?: number; visibility?: number }

const FINGER_CHAIN: Record<
  Exclude<FingerName, 'thumb'>,
  { mcp: number; pip: number; dip: number; tip: number }
> = {
  index: { mcp: 5, pip: 6, dip: 7, tip: 8 },
  middle: { mcp: 9, pip: 10, dip: 11, tip: 12 },
  ring: { mcp: 13, pip: 14, dip: 15, tip: 16 },
  pinky: { mcp: 17, pip: 18, dip: 19, tip: 20 },
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

/**
 * Non-thumb extension: combines chain straightness (mcp→tip vs mcp→pip→dip→tip)
 * with reach past the PIP joint so partially bent fingers score lower than fully extended.
 */
function fingerExtensionScore(
  landmarks: NormalizedLandmark[],
  chain: { mcp: number; pip: number; dip: number; tip: number },
  wrist: NormalizedLandmark,
  handSize: number,
) {
  const mcp = landmarks[chain.mcp]
  const pip = landmarks[chain.pip]
  const dip = landmarks[chain.dip]
  const tip = landmarks[chain.tip]

  const segmentLen = distance(mcp, pip) + distance(pip, dip) + distance(dip, tip)
  const chord = distance(mcp, tip)
  // Colinear chain → ratio ≈ 1; bent finger → ratio clearly < 1
  const ratio = segmentLen > 1e-6 ? chord / segmentLen : 0
  const straightness = clamp01((ratio - 0.76) / 0.22)

  const reach = (distance(wrist, tip) - distance(wrist, pip)) / Math.max(handSize, 0.08)
  const reachScore = clamp01((reach + 0.02) / 0.38)

  // Slight downward opening in screen space still counts if straight + long
  const tipAbovePip = pip.y - tip.y
  const liftScore = clamp01((tipAbovePip + handSize * 0.02) / (handSize * 0.2))

  return clamp01(straightness * 0.5 + reachScore * 0.35 + liftScore * 0.15)
}

/**
 * Lightweight finger state from landmarks — tuned for desk webcam (palm often angled).
 */
export function detectFingerStatesFromLandmarks(
  landmarks: NormalizedLandmark[],
): FingerStates {
  const wrist = landmarks[0]
  const indexMcp = landmarks[5]
  const pinkyMcp = landmarks[17]

  const handSize = Math.max(0.1, (distance(wrist, indexMcp) + distance(wrist, pinkyMcp)) / 2)

  const palmCenterX = (indexMcp.x + pinkyMcp.x) / 2

  const thumbTip = landmarks[4]
  const thumbIp = landmarks[3]
  const thumbOutward = Math.abs(thumbTip.x - palmCenterX)
  const thumbBase = Math.abs(thumbIp.x - palmCenterX)
  const thumbRaw = thumbOutward - thumbBase
  const thumbThreshold = handSize * 0.09
  const thumbOpenScore = clamp01(thumbRaw / (thumbThreshold * 2.2))
  const thumbIsOpen = thumbOpenScore >= 0.42

  const result: Partial<FingerStates> = {
    thumb: { isOpen: thumbIsOpen, openScore: thumbOpenScore },
  }

  ;(Object.keys(FINGER_CHAIN) as Array<Exclude<FingerName, 'thumb'>>).forEach((finger) => {
    const openScore = fingerExtensionScore(landmarks, FINGER_CHAIN[finger], wrist, handSize)
    const isOpen = openScore >= 0.48
    result[finger] = { isOpen, openScore }
  })

  return result as FingerStates
}
