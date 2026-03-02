import type { Doc, Id } from './_generated/dataModel'
import pictionaryWords from '../src/assets/words/pictionary.json'

export const WORD_CATEGORIES = [
  'easy',
  'medium',
  'difficult',
  'hard',
  'idioms',
  'characters',
  'movies',
] as const

export const DIFFICULTY_CATEGORIES = [
  'easy',
  'medium',
  'difficult',
  'hard',
] as const

export type WordCategory = (typeof WORD_CATEGORIES)[number]
export type DifficultyMode = 'mixed' | (typeof DIFFICULTY_CATEGORIES)[number]
export type WordMode = 'single' | 'multiple' | 'random_all'
export type GameState =
  | 'LOBBY'
  | 'CONFIGURED'
  | 'IN_PROGRESS'
  | 'BETWEEN_ROUNDS'
  | 'FINISHED'

export type WordDeckEntry = {
  key: string
  word: string
  category: WordCategory
}

export type RoomConfig = {
  wordsPerTeamLimit: number
  timePerWordSeconds: number
  wordMode: WordMode
  selectedCategories: WordCategory[]
  difficultyMode: DifficultyMode
}

const WORDS = pictionaryWords as Record<WordCategory, string[]>

const DIFFICULTY_SET = new Set<string>(DIFFICULTY_CATEGORIES)

export function normalizeWord(word: string) {
  return word.trim().toLocaleLowerCase()
}

function assertValidConfig(config: RoomConfig) {
  if (config.wordsPerTeamLimit < 1) {
    throw new Error('Words per team must be at least 1')
  }
  if (config.timePerWordSeconds < 10 || config.timePerWordSeconds > 300) {
    throw new Error('Time per word must be between 10 and 300 seconds')
  }
}

function resolveCategories(config: RoomConfig): WordCategory[] {
  const selected = config.selectedCategories.filter((category) =>
    WORD_CATEGORIES.includes(category),
  )
  let categories: WordCategory[]

  if (config.wordMode === 'random_all') {
    categories = [...WORD_CATEGORIES]
  } else if (config.wordMode === 'single') {
    if (selected.length !== 1) {
      throw new Error('Single category mode requires exactly one category')
    }
    categories = [selected[0]]
  } else {
    if (selected.length < 1) {
      throw new Error('Multiple category mode requires at least one category')
    }
    categories = Array.from(new Set(selected))
  }

  if (config.difficultyMode !== 'mixed') {
    if (!categories.includes(config.difficultyMode)) {
      throw new Error(
        `Difficulty "${config.difficultyMode}" must be included in selected categories`,
      )
    }
    categories = [config.difficultyMode]
  }

  return categories
}

function hashString(input: string) {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function seededRandom(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let x = Math.imul(t ^ (t >>> 15), t | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleDeterministic<T>(items: T[], seed: string) {
  const random = seededRandom(hashString(seed))
  const clone = [...items]
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[clone[i], clone[j]] = [clone[j], clone[i]]
  }
  return clone
}

export function buildWordDeck(config: RoomConfig, seed: string): WordDeckEntry[] {
  assertValidConfig(config)
  const categories = resolveCategories(config)
  const deduped = new Map<string, WordDeckEntry>()

  for (const category of categories) {
    const words = WORDS[category] ?? []
    for (const rawWord of words) {
      const word = rawWord.trim()
      if (!word) {
        continue
      }
      const key = normalizeWord(word)
      if (!deduped.has(key)) {
        deduped.set(key, { key, word, category })
      }
    }
  }

  const deck = shuffleDeterministic(
    Array.from(deduped.values()),
    `${seed}|${categories.join(',')}|${config.difficultyMode}`,
  )

  if (deck.length === 0) {
    const modeHint =
      config.difficultyMode === 'mixed'
        ? 'selected categories'
        : `difficulty "${config.difficultyMode}"`
    throw new Error(`No words available for ${modeHint}`)
  }

  return deck
}

export function generateWordSeed(roomCode: string, createdAtMs: number) {
  return `${roomCode}:${createdAtMs}`
}

export function isDifficultyCategory(category: WordCategory) {
  return DIFFICULTY_SET.has(category)
}

export function buildDeterministicTurnOrder(
  players: Doc<'players'>[],
): Id<'players'>[] {
  return [...players]
    .sort((a, b) => {
      if (a.joinedAtMs !== b.joinedAtMs) {
        return a.joinedAtMs - b.joinedAtMs
      }
      if (a._creationTime !== b._creationTime) {
        return a._creationTime - b._creationTime
      }
      return a._id.localeCompare(b._id)
    })
    .map((player) => player._id)
}

type FindNextTurnArgs = {
  turnOrder: Id<'players'>[]
  startCursor: number
  wordsPerTeamLimit: number
  playersById: Map<Id<'players'>, Doc<'players'>>
  teamsById: Map<Id<'teams'>, Doc<'teams'>>
  minimumLastSeenAtMs?: number
}

export function findNextEligibleTurn({
  turnOrder,
  startCursor,
  wordsPerTeamLimit,
  playersById,
  teamsById,
  minimumLastSeenAtMs,
}: FindNextTurnArgs): { playerId: Id<'players'>; cursor: number } | null {
  if (turnOrder.length === 0) {
    return null
  }

  const normalizedCursor = ((startCursor % turnOrder.length) + turnOrder.length) % turnOrder.length

  for (let offset = 0; offset < turnOrder.length; offset += 1) {
    const cursor = (normalizedCursor + offset) % turnOrder.length
    const playerId = turnOrder[cursor]
    const player = playersById.get(playerId)
    if (!player?.teamId) {
      continue
    }
    if (
      minimumLastSeenAtMs !== undefined &&
      (player.lastSeenAtMs ?? 0) < minimumLastSeenAtMs
    ) {
      continue
    }
    const team = teamsById.get(player.teamId)
    if (!team) {
      continue
    }
    if (team.roundsPlayed >= wordsPerTeamLimit) {
      continue
    }
    return { playerId, cursor }
  }

  return null
}
