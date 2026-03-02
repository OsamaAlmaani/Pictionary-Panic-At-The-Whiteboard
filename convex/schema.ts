import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

const gameState = v.union(
  v.literal('LOBBY'),
  v.literal('CONFIGURED'),
  v.literal('IN_PROGRESS'),
  v.literal('BETWEEN_ROUNDS'),
  v.literal('FINISHED'),
  v.literal('CANCELED'),
)

const wordMode = v.union(
  v.literal('single'),
  v.literal('multiple'),
  v.literal('random_all'),
)

const difficultyMode = v.union(
  v.literal('mixed'),
  v.literal('easy'),
  v.literal('medium'),
  v.literal('difficult'),
  v.literal('hard'),
)

const wordCategory = v.union(
  v.literal('easy'),
  v.literal('medium'),
  v.literal('difficult'),
  v.literal('hard'),
  v.literal('idioms'),
  v.literal('characters'),
  v.literal('movies'),
)

const roomEventType = v.union(
  v.literal('ROUND_STARTED'),
  v.literal('ROUND_GUESSED'),
  v.literal('ROUND_TIMEOUT'),
  v.literal('SCORE_ADJUSTED'),
  v.literal('GAME_STARTED'),
  v.literal('GAME_FINISHED'),
  v.literal('GAME_CANCELED'),
  v.literal('GAME_TERMINATED'),
)

export default defineSchema({
  products: defineTable({
    title: v.string(),
    imageId: v.string(),
    price: v.number(),
  }),
  todos: defineTable({
    text: v.string(),
    completed: v.boolean(),
  }),
  rooms: defineTable({
    code: v.string(),
    adminTokenIdentifier: v.string(),
    adminPlayerId: v.optional(v.id('players')),
    state: gameState,
    createdAtMs: v.number(),
    startedAtMs: v.optional(v.number()),
    finishedAtMs: v.optional(v.number()),
    config: v.object({
      wordsPerTeamLimit: v.number(),
      timePerWordSeconds: v.number(),
      wordMode,
      selectedCategories: v.array(wordCategory),
      difficultyMode,
    }),
    wordSeed: v.string(),
    wordDeck: v.array(
      v.object({
        key: v.string(),
        word: v.string(),
        category: wordCategory,
      }),
    ),
    wordCursor: v.number(),
    turnOrder: v.array(v.id('players')),
    turnCursor: v.number(),
    roundNumber: v.number(),
    activeRoundId: v.optional(v.id('rounds')),
    nextRoomCode: v.optional(v.string()),
    lastEvent: v.optional(
      v.object({
        type: roomEventType,
        atMs: v.number(),
        roundId: v.optional(v.id('rounds')),
        actorName: v.optional(v.string()),
        message: v.optional(v.string()),
      }),
    ),
  }).index('by_code', ['code']),
  players: defineTable({
    roomId: v.id('rooms'),
    tokenIdentifier: v.string(),
    subject: v.string(),
    displayName: v.string(),
    imageUrl: v.optional(v.string()),
    isAdmin: v.boolean(),
    joinedAtMs: v.number(),
    lastSeenAtMs: v.optional(v.number()),
    teamId: v.optional(v.id('teams')),
    score: v.number(),
  })
    .index('by_room', ['roomId'])
    .index('by_room_token', ['roomId', 'tokenIdentifier'])
    .index('by_token', ['tokenIdentifier'])
    .index('by_room_team', ['roomId', 'teamId']),
  userProfiles: defineTable({
    tokenIdentifier: v.string(),
    subject: v.string(),
    preferredDisplayName: v.string(),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  }).index('by_token', ['tokenIdentifier']),
  teams: defineTable({
    roomId: v.id('rooms'),
    name: v.string(),
    color: v.string(),
    position: v.number(),
    score: v.number(),
    roundsPlayed: v.number(),
    createdAtMs: v.number(),
  })
    .index('by_room', ['roomId'])
    .index('by_room_position', ['roomId', 'position']),
  rounds: defineTable({
    roomId: v.id('rooms'),
    roundNumber: v.number(),
    teamId: v.id('teams'),
    playerId: v.id('players'),
    word: v.string(),
    wordKey: v.string(),
    category: wordCategory,
    guessed: v.boolean(),
    status: v.union(v.literal('ACTIVE'), v.literal('COMPLETED')),
    startedAtMs: v.number(),
    endsAtMs: v.number(),
    endedAtMs: v.optional(v.number()),
    endedReason: v.optional(v.union(v.literal('GUESSED'), v.literal('TIMEOUT'))),
    pointsAwarded: v.number(),
  })
    .index('by_room', ['roomId'])
    .index('by_room_round_number', ['roomId', 'roundNumber']),
  usedWords: defineTable({
    roomId: v.id('rooms'),
    wordKey: v.string(),
    word: v.string(),
    category: wordCategory,
    roundId: v.id('rounds'),
    usedAtMs: v.number(),
  })
    .index('by_room', ['roomId'])
    .index('by_room_word_key', ['roomId', 'wordKey']),
})
