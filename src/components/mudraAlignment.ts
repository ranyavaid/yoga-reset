import type { FingerName, FingerStates } from './fingerDetection'

export type MudraLandmark = { x: number; y: number; z?: number; visibility?: number }

export type MudraAlignmentMatch = {
  alignment: number
  touchMatched: boolean
  touchScore: number
  matchedFingers: FingerName[]
  incorrectFingers: FingerName[]
}

export type MudraDetectionProfile =
  | 'vayu'
  | 'gyan'
  | 'apana'
  | 'shuni'
  | 'shunya'
  | 'surya'
  | 'kali'

const DETECTION_PROFILES: readonly MudraDetectionProfile[] = [
  'vayu',
  'gyan',
  'apana',
  'shuni',
  'shunya',
  'surya',
  'kali',
]

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function distance2(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

function tipDistance(a: MudraLandmark, b: MudraLandmark) {
  const dz = (a.z ?? 0) - (b.z ?? 0)
  return Math.hypot(a.x - b.x, a.y - b.y, dz * 0.5)
}

function handScale(landmarks: MudraLandmark[]) {
  const wrist = landmarks[0]
  const indexMcp = landmarks[5]
  const pinkyMcp = landmarks[17]
  return Math.max(0.12, (distance2(wrist, indexMcp) + distance2(wrist, pinkyMcp)) / 2)
}

function proximityScore(dist: number, handSize: number, tightRatio: number, softRatio: number) {
  const tight = handSize * tightRatio
  const soft = handSize * softRatio
  return clamp01(1 - (dist - tight) / Math.max(0.025, soft - tight))
}

export function emptyMudraMatch(): MudraAlignmentMatch {
  return {
    alignment: 0,
    touchMatched: false,
    touchScore: 0,
    matchedFingers: [],
    incorrectFingers: [],
  }
}

function scoreFingersOpen(
  fingers: FingerStates,
  expected: readonly FingerName[],
  openOk = 0.3,
): { score: number; matched: FingerName[]; incorrect: FingerName[] } {
  const matched: FingerName[] = []
  const incorrect: FingerName[] = []
  let sum = 0
  for (const finger of expected) {
    const openScore = clamp01(fingers[finger].openScore)
    sum += openScore
    if (openScore >= openOk) matched.push(finger)
    else incorrect.push(finger)
  }
  return { score: sum / Math.max(1, expected.length), matched, incorrect }
}

/** High when the finger reads folded / not extended (forgiving threshold). */
function scoreFingerFolded(fingers: FingerStates, finger: FingerName) {
  const open = clamp01(fingers[finger].openScore)
  return clamp01((0.52 - open) / 0.38)
}

function mergeFingerLists(
  matched: FingerName[],
  incorrect: FingerName[],
): Pick<MudraAlignmentMatch, 'matchedFingers' | 'incorrectFingers'> {
  return { matchedFingers: matched, incorrectFingers: incorrect }
}

function finalizeMatch(
  gestureScore: number,
  touchScore: number,
  openScore: number,
  touchMatched: boolean,
  matched: FingerName[],
  incorrect: FingerName[],
  weights: { gesture?: number; touch?: number; open?: number } = {},
): MudraAlignmentMatch {
  const wg = weights.gesture ?? 0.35
  const wt = weights.touch ?? 0.35
  const wo = weights.open ?? 0.3
  const alignment = clamp01(gestureScore * wg + touchScore * wt + openScore * wo) * 100
  return {
    alignment,
    touchMatched,
    touchScore,
    ...mergeFingerLists(matched, incorrect),
  }
}

export function computeGyanAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const handSize = handScale(landmarks)
  const thumbTip = landmarks[4]
  const indexTip = landmarks[8]
  const middleTip = landmarks[12]
  const ringTip = landmarks[16]

  const dThumbIndex = tipDistance(thumbTip, indexTip)
  const dThumbMiddle = tipDistance(thumbTip, middleTip)
  const dThumbRing = tipDistance(thumbTip, ringTip)

  const closeEnough = dThumbIndex <= handSize * 0.152
  const indexPreferredOverMiddle = dThumbIndex < dThumbMiddle * 0.94
  const indexPreferredOverRing = dThumbIndex < dThumbRing * 0.84
  const relaxedPinch = dThumbIndex <= handSize * 0.19

  const open = scoreFingersOpen(fingers, ['middle', 'ring', 'pinky'])
  const touchMatchedStrict =
    closeEnough && indexPreferredOverMiddle && indexPreferredOverRing
  const touchMatchedRelaxed =
    relaxedPinch && indexPreferredOverMiddle && open.score >= 0.38 && open.incorrect.length <= 1
  const touchMatched = touchMatchedStrict || touchMatchedRelaxed

  let touchScore = proximityScore(dThumbIndex, handSize, 0.07, 0.14)
  if (!indexPreferredOverMiddle) touchScore *= 0.78
  if (!indexPreferredOverRing) touchScore *= 0.78
  if (touchMatchedRelaxed && !touchMatchedStrict) touchScore = Math.min(1, touchScore * 1.06 + 0.08)

  const gestureScore = touchMatched ? 1 : touchScore
  return finalizeMatch(gestureScore, touchScore, open.score, touchMatched, ['thumb', 'index', ...open.matched], open.incorrect)
}

export function computeVayuAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const handSize = handScale(landmarks)
  const thumbTip = landmarks[4]
  const indexMcp = landmarks[5]
  const indexPip = landmarks[6]
  const indexTip = landmarks[8]

  const indexFold = scoreFingerFolded(fingers, 'index')
  const dThumbIndexMcp = tipDistance(thumbTip, indexMcp)
  const dThumbIndexPip = tipDistance(thumbTip, indexPip)
  const dThumbIndexTip = tipDistance(thumbTip, indexTip)
  const thumbCover = Math.max(
    proximityScore(dThumbIndexMcp, handSize, 0.06, 0.2),
    proximityScore(dThumbIndexPip, handSize, 0.07, 0.22),
    proximityScore(dThumbIndexTip, handSize, 0.08, 0.24) * 0.85,
  )

  const open = scoreFingersOpen(fingers, ['middle', 'ring', 'pinky'], 0.28)
  const touchMatched =
    indexFold >= 0.32 && thumbCover >= 0.38 && open.score >= 0.34 && open.incorrect.length <= 1
  const gestureScore = clamp01(indexFold * 0.45 + thumbCover * 0.55)

  return finalizeMatch(
    gestureScore,
    thumbCover,
    open.score,
    touchMatched,
    indexFold >= 0.28 ? ['index', 'thumb', ...open.matched] : open.matched,
    indexFold < 0.28 ? ['index', ...open.incorrect] : open.incorrect,
  )
}

export function computeApanaAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const handSize = handScale(landmarks)
  const thumbTip = landmarks[4]
  const middleTip = landmarks[12]
  const ringTip = landmarks[16]

  const thumbMiddle = proximityScore(tipDistance(thumbTip, middleTip), handSize, 0.07, 0.17)
  const thumbRing = proximityScore(tipDistance(thumbTip, ringTip), handSize, 0.07, 0.18)
  const touchScore = clamp01(thumbMiddle * 0.52 + thumbRing * 0.48)

  const open = scoreFingersOpen(fingers, ['index', 'pinky'], 0.28)
  const touchMatched = touchScore >= 0.42 && open.score >= 0.36 && open.incorrect.length <= 1

  return finalizeMatch(touchScore, touchScore, open.score, touchMatched, ['thumb', ...open.matched], open.incorrect)
}

export function computeShuniAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const handSize = handScale(landmarks)
  const thumbTip = landmarks[4]
  const middleTip = landmarks[12]
  const dThumbMiddle = tipDistance(thumbTip, middleTip)

  const touchScore = proximityScore(dThumbMiddle, handSize, 0.07, 0.16)
  const open = scoreFingersOpen(fingers, ['index', 'ring', 'pinky'], 0.28)
  const touchMatched = touchScore >= 0.44 && open.score >= 0.36 && open.incorrect.length <= 1

  return finalizeMatch(touchScore, touchScore, open.score, touchMatched, ['thumb', 'middle', ...open.matched], open.incorrect)
}

export function computeShunyaAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const handSize = handScale(landmarks)
  const thumbTip = landmarks[4]
  const middleMcp = landmarks[9]
  const middlePip = landmarks[10]
  const middleTip = landmarks[12]

  const middleFold = scoreFingerFolded(fingers, 'middle')
  const thumbCover = Math.max(
    proximityScore(tipDistance(thumbTip, middleMcp), handSize, 0.06, 0.2),
    proximityScore(tipDistance(thumbTip, middlePip), handSize, 0.07, 0.22),
    proximityScore(tipDistance(thumbTip, middleTip), handSize, 0.08, 0.24) * 0.82,
  )

  const open = scoreFingersOpen(fingers, ['index', 'ring', 'pinky'], 0.28)
  const touchMatched =
    middleFold >= 0.32 && thumbCover >= 0.38 && open.score >= 0.34 && open.incorrect.length <= 1
  const gestureScore = clamp01(middleFold * 0.45 + thumbCover * 0.55)

  return finalizeMatch(
    gestureScore,
    thumbCover,
    open.score,
    touchMatched,
    middleFold >= 0.28 ? ['middle', 'thumb', ...open.matched] : open.matched,
    middleFold < 0.28 ? ['middle', ...open.incorrect] : open.incorrect,
  )
}

export function computeSuryaAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const handSize = handScale(landmarks)
  const thumbTip = landmarks[4]
  const ringMcp = landmarks[13]
  const ringPip = landmarks[14]
  const ringTip = landmarks[16]

  const ringFold = scoreFingerFolded(fingers, 'ring')
  const thumbCover = Math.max(
    proximityScore(tipDistance(thumbTip, ringMcp), handSize, 0.06, 0.2),
    proximityScore(tipDistance(thumbTip, ringPip), handSize, 0.07, 0.22),
    proximityScore(tipDistance(thumbTip, ringTip), handSize, 0.08, 0.24) * 0.82,
  )

  const open = scoreFingersOpen(fingers, ['index', 'middle', 'pinky'], 0.28)
  const touchMatched =
    ringFold >= 0.32 && thumbCover >= 0.38 && open.score >= 0.34 && open.incorrect.length <= 1
  const gestureScore = clamp01(ringFold * 0.45 + thumbCover * 0.55)

  return finalizeMatch(
    gestureScore,
    thumbCover,
    open.score,
    touchMatched,
    ringFold >= 0.28 ? ['ring', 'thumb', ...open.matched] : open.matched,
    ringFold < 0.28 ? ['ring', ...open.incorrect] : open.incorrect,
  )
}

/** Per-hand Kali: index extended; other fingers relaxed / interlaced — gentle gate. */
export function computeKaliAlignment(
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  if (!fingers || !landmarks || landmarks.length < 18) return emptyMudraMatch()

  const hs = handScale(landmarks)
  const indexOpen = clamp01(fingers.index.openScore)
  const reach =
    (distance2(landmarks[0], landmarks[8]) - distance2(landmarks[0], landmarks[6])) / Math.max(hs, 0.12)
  const indexReach = clamp01((reach + 0.05) / 0.4)
  const indexScore = clamp01(indexOpen * 0.72 + indexReach * 0.28)

  const support =
    (clamp01(fingers.middle.openScore) + clamp01(fingers.ring.openScore) + clamp01(fingers.pinky.openScore)) / 3
  const touchMatched = indexScore >= 0.4
  const touchScore = indexScore

  return finalizeMatch(
    indexScore,
    touchScore,
    support,
    touchMatched,
    indexScore >= 0.35 ? ['index'] : [],
    indexScore < 0.35 ? ['index'] : [],
    { gesture: 0.55, touch: 0.35, open: 0.1 },
  )
}

export function isMudraDetectionProfile(value: unknown): value is MudraDetectionProfile {
  return typeof value === 'string' && (DETECTION_PROFILES as readonly string[]).includes(value)
}

export function getMudraDetectionProfile(mudra: {
  detectionRules?: Record<string, unknown>
}): MudraDetectionProfile {
  const profile = mudra.detectionRules?.profile
  if (isMudraDetectionProfile(profile)) return profile
  return 'gyan'
}

export function computeMudraAlignment(
  profile: MudraDetectionProfile,
  fingers: FingerStates | null,
  landmarks: MudraLandmark[] | null,
): MudraAlignmentMatch {
  switch (profile) {
    case 'vayu':
      return computeVayuAlignment(fingers, landmarks)
    case 'gyan':
      return computeGyanAlignment(fingers, landmarks)
    case 'apana':
      return computeApanaAlignment(fingers, landmarks)
    case 'shuni':
      return computeShuniAlignment(fingers, landmarks)
    case 'shunya':
      return computeShunyaAlignment(fingers, landmarks)
    case 'surya':
      return computeSuryaAlignment(fingers, landmarks)
    case 'kali':
      return computeKaliAlignment(fingers, landmarks)
    default:
      return computeGyanAlignment(fingers, landmarks)
  }
}

export function combineTwoHandMatch(a: MudraAlignmentMatch, b: MudraAlignmentMatch): MudraAlignmentMatch {
  const alignment = 0.38 * Math.min(a.alignment, b.alignment) + 0.62 * ((a.alignment + b.alignment) / 2)
  const touchMatched = a.touchMatched && b.touchMatched
  const touchScore = (a.touchScore + b.touchScore) / 2
  const incorrectFingers = [...new Set([...a.incorrectFingers, ...b.incorrectFingers])]
  return {
    alignment,
    touchMatched,
    touchScore,
    matchedFingers: a.matchedFingers.length >= b.matchedFingers.length ? a.matchedFingers : b.matchedFingers,
    incorrectFingers,
  }
}

function pickBetterMatch(a: MudraAlignmentMatch, b: MudraAlignmentMatch): MudraAlignmentMatch {
  return a.alignment >= b.alignment ? a : b
}

export function resolveSessionMudraMatch(
  handsRequired: 1 | 2,
  m0: MudraAlignmentMatch,
  m1: MudraAlignmentMatch,
  stable: [boolean, boolean],
): MudraAlignmentMatch {
  const s0 = stable[0]
  const s1 = stable[1]
  if (handsRequired === 1) {
    if (s0 && !s1) return m0
    if (!s0 && s1) return m1
    if (s0 && s1) return pickBetterMatch(m0, m1)
    return emptyMudraMatch()
  }
  if (!s0 && !s1) return emptyMudraMatch()
  if (s0 && !s1) return m0
  if (!s0 && s1) return m1
  return combineTwoHandMatch(m0, m1)
}
