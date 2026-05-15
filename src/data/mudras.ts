/**
 * Canonical mudra definitions for the practice UI (copy, timing, breathing, illustration asset paths).
 *
 * TODO: Wire `detectionRules` / `detectionProfileId` into landmark-based alignment so each mudra
 * uses its own geometry checks instead of the shared Gyan-style `computeGyanAlignment` heuristic.
 */

/** Public URL path under `public/` (e.g. `/illustrations/vayu-mudra.svg`). */
export type MudraIllustrationSrc = string

export type MudraBreathingPattern = {
  /** Opening line duration from session start */
  introSeconds: number
  introLine: string
  /** Seconds per line while rotating through `rotationLines` */
  rotationSlotSeconds: number
  rotationLines: readonly string[]
  /**
   * After intro: alternate between two labels in equal phases (e.g. in / out) with per-second count cues.
   * When omitted, `rotationLines` / `rotationSlotSeconds` are used instead.
   */
  pacedAlternation?: {
    phaseSeconds: number
    labels: readonly [string, string]
  }
}

export type Mudra = {
  id: string
  name: string
  description: string
  instructions: readonly string[]
  cameraGuidance: readonly string[]
  illustration: MudraIllustrationSrc
  durationSeconds: number
  breathingPattern: MudraBreathingPattern
  /** Small editorial label above the mudra name on the info card */
  infoEyebrow?: string
  /**
   * How many hands should be in frame for practice. Single-hand mudras use the clearer of two
   * detected hands; two-hand mudras expect both, with relaxed combined scoring.
   */
  handsRequired?: 1 | 2
  /** Reserved for future per-mudra MediaPipe rules */
  detectionRules?: Record<string, unknown>
}

export const DEFAULT_MUDRA_ID = 'vayu'

/** User-selected practice time after the 5s settle-in (seconds). */
export type PracticeDurationSeconds = 60 | 180 | 300 | 600 | 900

export const DEFAULT_PRACTICE_DURATION_SECONDS: PracticeDurationSeconds = 60

export const PRACTICE_DURATION_OPTIONS: readonly {
  seconds: PracticeDurationSeconds
  label: string
}[] = [
  { seconds: 60, label: '1 min' },
  { seconds: 180, label: '3 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 600, label: '10 min' },
  { seconds: 900, label: '15 min' },
] as const

/** Shared “How to practise” list — same for every mudra in the picker. */
export const HOW_TO_PRACTISE_STEPS = [
  'Place your hand inside the frame and stay relaxed',
  'Hold your hand steady until the status turns ready',
  'Start the practice and maintain a calm, stable posture',
] as const

/** Breathing pattern shared by all mudras (matches Vayu). */
const VAYU_BREATHING_PATTERN: MudraBreathingPattern = {
  introSeconds: 0,
  introLine: 'Breathe with ease',
  rotationSlotSeconds: 5.5,
  rotationLines: [
    'Breathe in',
    'Breathe out',
    'Soften through the chest',
    'Hold gently',
    'Slow, steady breath',
  ],
  pacedAlternation: {
    phaseSeconds: 5,
    labels: ['Breathe in', 'Breathe out'] as const,
  },
}

export const MUDRAS: readonly Mudra[] = [
  {
    id: 'vayu',
    name: 'Vayu Mudra',
    description:
      'A grounding mudra traditionally associated with calming excess movement and supporting balance. A short pause you can take at your desk.',
    instructions: [...HOW_TO_PRACTISE_STEPS],
    cameraGuidance: [
      'Keep your hand clearly visible.',
      'Face your palm slightly toward the camera.',
      'Move slowly so your position reads clearly.',
    ],
    illustration: '/illustrations/vayu-mudra.svg',
    infoEyebrow: "Today's pause",
    durationSeconds: 45,
    breathingPattern: VAYU_BREATHING_PATTERN,
    detectionRules: {
      // TODO: map to thumb–index ring + three fingers extended (current app still scores Gyan-style).
      profile: 'vayu',
    },
  },
  {
    id: 'apana',
    name: 'Apana Mudra',
    description:
      'A downward-flowing gesture often used for grounding and a sense of steady release — a calm reset when you need to settle.',
    instructions: [...HOW_TO_PRACTISE_STEPS],
    cameraGuidance: [
      'Keep your hand clearly visible.',
      'Face your palm slightly toward the camera.',
      'Move slowly so your position reads clearly.',
    ],
    illustration: '/illustrations/apana-mudra.svg',
    durationSeconds: 45,
    breathingPattern: VAYU_BREATHING_PATTERN,
    detectionRules: {
      profile: 'apana',
    },
  },
  {
    id: 'shuni',
    name: 'Shuni Mudra',
    description:
      'A gesture of patience and discernment: middle finger and thumb meet while the other fingers stay easy — helpful when you want quiet focus.',
    instructions: [...HOW_TO_PRACTISE_STEPS],
    cameraGuidance: [
      'Keep your hand clearly visible.',
      'Face your palm slightly toward the camera.',
      'Move slowly so your position reads clearly.',
    ],
    illustration: '/illustrations/shuni-mudra.svg',
    durationSeconds: 45,
    breathingPattern: VAYU_BREATHING_PATTERN,
    detectionRules: {
      profile: 'shuni',
    },
  },
  {
    id: 'shunya',
    name: 'Shunya Mudra',
    description:
      'A spacious mudra associated with openness and ease: the middle finger folds gently toward the palm — a brief pause to unclutter the mind.',
    instructions: [...HOW_TO_PRACTISE_STEPS],
    cameraGuidance: [
      'Keep your hand clearly visible.',
      'Face your palm slightly toward the camera.',
      'Move slowly so your position reads clearly.',
    ],
    illustration: '/illustrations/shunya-mudra.svg',
    durationSeconds: 45,
    breathingPattern: VAYU_BREATHING_PATTERN,
    detectionRules: {
      profile: 'shunya',
    },
  },
  {
    id: 'surya',
    name: 'Surya Mudra',
    description:
      'A sun-associated gesture linking ring finger and thumb — traditionally used for vitality and warmth. A bright, steady micro-pause at your desk.',
    instructions: [...HOW_TO_PRACTISE_STEPS],
    cameraGuidance: [
      'Keep your hand clearly visible.',
      'Face your palm slightly toward the camera.',
      'Move slowly so your position reads clearly.',
    ],
    illustration: '/illustrations/surya-mudra.svg',
    durationSeconds: 45,
    breathingPattern: VAYU_BREATHING_PATTERN,
    detectionRules: {
      profile: 'surya',
    },
  },
  {
    id: 'gyan',
    name: 'Gyan Mudra',
    description:
      'A familiar gesture of quiet focus: thumb and index meet lightly while the other fingers lengthen upward.',
    instructions: [...HOW_TO_PRACTISE_STEPS],
    cameraGuidance: [
      'Chest height, palm slightly toward the camera',
      'Fingers visible; move slowly',
      'Thumb and index meet lightly at the tips',
    ],
    illustration: '/illustrations/gyan-mudra.svg',
    durationSeconds: 45,
    breathingPattern: VAYU_BREATHING_PATTERN,
    detectionRules: {
      profile: 'gyan',
    },
  },
] as const

export function getMudraById(id: string): Mudra | undefined {
  return MUDRAS.find((m) => m.id === id)
}

export function listMudras(): readonly Mudra[] {
  return MUDRAS
}
