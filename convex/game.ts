import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import {
  WORD_CATEGORIES,
  buildDeterministicTurnOrder,
  buildWordDeck,
  findNextEligibleTurn,
  generateWordSeed,
  type RoomConfig,
  type WordCategory,
} from './gameEngine'

const GAME_STATES = [
  'LOBBY',
  'CONFIGURED',
  'IN_PROGRESS',
  'BETWEEN_ROUNDS',
  'FINISHED',
  'CANCELED',
] as const
const WORD_MODES = ['single', 'multiple', 'random_all'] as const
const DIFFICULTY_MODES = ['mixed', 'easy', 'medium', 'difficult', 'hard'] as const
const PLAYER_PRESENCE_TIMEOUT_MS = 25_000
const NEXT_ROOM_START_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_GAME_HISTORY_LIMIT = 12
const MAX_GAME_HISTORY_LIMIT = 30

const wordCategoryValidator = v.union(
  v.literal('easy'),
  v.literal('medium'),
  v.literal('difficult'),
  v.literal('hard'),
  v.literal('idioms'),
  v.literal('characters'),
  v.literal('movies'),
)

const roomConfigValidator = v.object({
  wordsPerTeamLimit: v.number(),
  timePerWordSeconds: v.number(),
  wordMode: v.union(
    v.literal('single'),
    v.literal('multiple'),
    v.literal('random_all'),
  ),
  selectedCategories: v.array(wordCategoryValidator),
  difficultyMode: v.union(
    v.literal('mixed'),
    v.literal('easy'),
    v.literal('medium'),
    v.literal('difficult'),
    v.literal('hard'),
  ),
})

function normalizeCode(code: string) {
  return code.trim().toUpperCase()
}

function defaultConfig(): RoomConfig {
  return {
    wordsPerTeamLimit: 5,
    timePerWordSeconds: 60,
    wordMode: 'random_all',
    selectedCategories: [...WORD_CATEGORIES],
    difficultyMode: 'mixed',
  }
}

function defaultDisplayName({
  identity,
  fallback,
}: {
  identity: Identity
  fallback: string
}) {
  return (
    identity.name ??
    identity.preferredUsername ??
    identity.email?.split('@')[0] ??
    fallback
  )
}

type Ctx = MutationCtx | QueryCtx
type Identity = NonNullable<
  Awaited<ReturnType<MutationCtx['auth']['getUserIdentity']>>
>

async function requireIdentity(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    throw new Error('You must be signed in to perform this action')
  }
  return identity
}

async function getRoomByCode(ctx: Ctx, code: string): Promise<Doc<'rooms'> | null> {
  return await ctx.db
    .query('rooms')
    .withIndex('by_code', (q) => q.eq('code', normalizeCode(code)))
    .unique()
}

async function getRoomPlayerByToken({
  ctx,
  roomId,
  tokenIdentifier,
}: {
  ctx: Ctx
  roomId: Id<'rooms'>
  tokenIdentifier: string
}): Promise<Doc<'players'> | null> {
  return await ctx.db
    .query('players')
    .withIndex('by_room_token', (q) =>
      q.eq('roomId', roomId).eq('tokenIdentifier', tokenIdentifier),
    )
    .unique()
}

async function getUserProfileByToken({
  ctx,
  tokenIdentifier,
}: {
  ctx: Ctx
  tokenIdentifier: string
}) {
  return await ctx.db
    .query('userProfiles')
    .withIndex('by_token', (q) => q.eq('tokenIdentifier', tokenIdentifier))
    .unique()
}

async function resolveDisplayName({
  ctx,
  identity,
  explicitDisplayName,
  fallback,
}: {
  ctx: Ctx
  identity: Identity
  explicitDisplayName?: string
  fallback: string
}) {
  const explicitName = explicitDisplayName?.trim()
  if (explicitName) {
    return explicitName
  }

  const profile = await getUserProfileByToken({
    ctx,
    tokenIdentifier: identity.tokenIdentifier,
  })
  const preferredName = profile?.preferredDisplayName?.trim()
  if (preferredName) {
    return preferredName
  }

  return defaultDisplayName({ identity, fallback })
}

async function upsertPreferredDisplayName({
  ctx,
  identity,
  displayName,
}: {
  ctx: MutationCtx
  identity: Identity
  displayName?: string
}) {
  const preferredDisplayName = displayName?.trim()
  if (!preferredDisplayName) {
    return
  }

  const now = Date.now()
  const existing = await getUserProfileByToken({
    ctx,
    tokenIdentifier: identity.tokenIdentifier,
  })
  if (existing) {
    await ctx.db.patch(existing._id, {
      preferredDisplayName,
      updatedAtMs: now,
    })
    return
  }

  await ctx.db.insert('userProfiles', {
    tokenIdentifier: identity.tokenIdentifier,
    subject: identity.subject,
    preferredDisplayName,
    createdAtMs: now,
    updatedAtMs: now,
  })
}

function assertAdmin(player: Doc<'players'>) {
  if (!player.isAdmin) {
    throw new Error('Only room admin can perform this action')
  }
}

function assertState(
  room: Doc<'rooms'>,
  allowedStates: ReadonlyArray<(typeof GAME_STATES)[number]>,
) {
  if (!allowedStates.includes(room.state)) {
    throw new Error(
      `Action is only allowed in: ${allowedStates.join(', ')} (current: ${room.state})`,
    )
  }
}

async function loadRoomContext(ctx: Ctx, roomId: Id<'rooms'>) {
  const [players, teams] = await Promise.all([
    ctx.db
      .query('players')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect() as Promise<Doc<'players'>[]>,
    ctx.db
      .query('teams')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect() as Promise<Doc<'teams'>[]>,
  ])

  const playersById = new Map<Id<'players'>, Doc<'players'>>(
    players.map((player) => [player._id, player]),
  )
  const teamsById = new Map<Id<'teams'>, Doc<'teams'>>(
    teams.map((team) => [team._id, team]),
  )

  return { players, teams, playersById, teamsById }
}

function teamColorForPosition(position: number) {
  const colors = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6']
  return colors[position % colors.length]
}

function isPlayerOnline(player: Doc<'players'>, nowMs: number) {
  const lastSeenAtMs = player.lastSeenAtMs ?? player.joinedAtMs
  return nowMs - lastSeenAtMs <= PLAYER_PRESENCE_TIMEOUT_MS
}

async function finishRoom({
  ctx,
  room,
  atMs,
}: {
  ctx: MutationCtx
  room: Doc<'rooms'>
  atMs: number
}) {
  await ctx.db.patch(room._id, {
    state: 'FINISHED',
    activeRoundId: undefined,
    finishedAtMs: atMs,
    lastEvent: {
      type: 'GAME_FINISHED',
      atMs,
    },
  })
}

async function endActiveRound({
  ctx,
  room,
  reason,
}: {
  ctx: MutationCtx
  room: Doc<'rooms'>
  reason: 'GUESSED' | 'TIMEOUT'
}) {
  if (!room.activeRoundId) {
    throw new Error('No active round')
  }

  const round = await ctx.db.get(room.activeRoundId)
  if (!round || round.status !== 'ACTIVE') {
    throw new Error('Round is already resolved')
  }

  const now = Date.now()
  if (reason === 'TIMEOUT' && now < round.endsAtMs) {
    throw new Error('Round has not timed out yet')
  }

  const [player, team] = await Promise.all([
    ctx.db.get(round.playerId),
    ctx.db.get(round.teamId),
  ])
  if (!player || !team) {
    throw new Error('Round references missing player/team')
  }

  const pointsAwarded = reason === 'GUESSED' ? 1 : 0

  await ctx.db.patch(round._id, {
    status: 'COMPLETED',
    guessed: reason === 'GUESSED',
    endedAtMs: now,
    endedReason: reason,
    pointsAwarded,
  })

  if (pointsAwarded > 0) {
    await Promise.all([
      ctx.db.patch(player._id, { score: player.score + pointsAwarded }),
      ctx.db.patch(team._id, { score: team.score + pointsAwarded }),
    ])
  }

  await ctx.db.patch(team._id, { roundsPlayed: team.roundsPlayed + 1 })

  const [teams, players] = await Promise.all([
    ctx.db
      .query('teams')
      .withIndex('by_room', (q) => q.eq('roomId', room._id))
      .collect(),
    ctx.db
      .query('players')
      .withIndex('by_room', (q) => q.eq('roomId', room._id))
      .collect(),
  ])

  const playersById = new Map(players.map((player) => [player._id, player]))
  const activeTeamIds = new Set<Id<'teams'>>()
  for (const playerId of room.turnOrder) {
    const turnPlayer = playersById.get(playerId)
    if (turnPlayer?.teamId) {
      activeTeamIds.add(turnPlayer.teamId)
    }
  }
  const teamsInPlay = teams.filter((item) => activeTeamIds.has(item._id))

  const allTeamsReachedLimit =
    teamsInPlay.length > 0 &&
    teamsInPlay.every(
      (item: Doc<'teams'>) => item.roundsPlayed >= room.config.wordsPerTeamLimit,
    )
  const wordPoolExhausted = room.wordCursor >= room.wordDeck.length

  if (allTeamsReachedLimit || wordPoolExhausted) {
    await ctx.db.patch(room._id, {
      state: 'FINISHED',
      activeRoundId: undefined,
      finishedAtMs: now,
      lastEvent: {
        type: reason === 'GUESSED' ? 'ROUND_GUESSED' : 'ROUND_TIMEOUT',
        atMs: now,
        roundId: round._id,
      },
    })
    return
  }

  await ctx.db.patch(room._id, {
    state: 'BETWEEN_ROUNDS',
    activeRoundId: undefined,
    lastEvent: {
      type: reason === 'GUESSED' ? 'ROUND_GUESSED' : 'ROUND_TIMEOUT',
      atMs: now,
      roundId: round._id,
    },
  })
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateRoomCode() {
  let result = ''
  for (let i = 0; i < 6; i += 1) {
    const index = Math.floor(Math.random() * ROOM_ALPHABET.length)
    result += ROOM_ALPHABET[index]
  }
  return result
}

async function generateUniqueRoomCode(ctx: Ctx) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const code = generateRoomCode()
    const existing = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!existing) {
      return code
    }
  }
  throw new Error('Failed to generate a unique room code')
}

export const createRoom = mutation({
  args: {
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const resolvedDisplayName = await resolveDisplayName({
      ctx,
      identity,
      explicitDisplayName: args.displayName,
      fallback: 'Admin',
    })
    await upsertPreferredDisplayName({
      ctx,
      identity,
      displayName: resolvedDisplayName,
    })
    const now = Date.now()

    const code = await generateUniqueRoomCode(ctx)

    const config = defaultConfig()
    const wordSeed = generateWordSeed(code, now)
    const wordDeck = buildWordDeck(config, wordSeed)

    const roomId = await ctx.db.insert('rooms', {
      code,
      adminTokenIdentifier: identity.tokenIdentifier,
      adminPlayerId: undefined,
      state: 'LOBBY',
      createdAtMs: now,
      startedAtMs: undefined,
      finishedAtMs: undefined,
      config,
      wordSeed,
      wordDeck,
      wordCursor: 0,
      turnOrder: [],
      turnCursor: 0,
      roundNumber: 0,
      activeRoundId: undefined,
      nextRoomCode: undefined,
      lastEvent: undefined,
    })

    const teamAId = await ctx.db.insert('teams', {
      roomId,
      name: 'Team A',
      color: teamColorForPosition(0),
      position: 0,
      score: 0,
      roundsPlayed: 0,
      createdAtMs: now,
    })

    await ctx.db.insert('teams', {
      roomId,
      name: 'Team B',
      color: teamColorForPosition(1),
      position: 1,
      score: 0,
      roundsPlayed: 0,
      createdAtMs: now,
    })

    const adminPlayerId = await ctx.db.insert('players', {
      roomId,
      tokenIdentifier: identity.tokenIdentifier,
      subject: identity.subject,
      displayName: resolvedDisplayName,
      imageUrl: identity.pictureUrl,
      isAdmin: true,
      joinedAtMs: now,
      lastSeenAtMs: now,
      teamId: teamAId,
      score: 0,
    })

    await ctx.db.patch(roomId, { adminPlayerId })

    return {
      roomCode: code,
      roomId,
    }
  },
})

export const joinRoom = mutation({
  args: {
    code: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }

    const existingPlayer = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (existingPlayer) {
      const resolvedDisplayName =
        args.displayName?.trim() ||
        existingPlayer.displayName ||
        defaultDisplayName({
          identity,
          fallback: `Player-${identity.subject.slice(0, 5)}`,
        })
      await upsertPreferredDisplayName({
        ctx,
        identity,
        displayName: resolvedDisplayName,
      })
      await ctx.db.patch(existingPlayer._id, {
        lastSeenAtMs: Date.now(),
        displayName: resolvedDisplayName,
      })
      return {
        roomCode: room.code,
        roomId: room._id,
        playerId: existingPlayer._id,
      }
    }

    if (
      room.state === 'IN_PROGRESS' ||
      room.state === 'BETWEEN_ROUNDS' ||
      room.state === 'FINISHED' ||
      room.state === 'CANCELED'
    ) {
      throw new Error('This game session is closed and you are not part of it')
    }

    const resolvedDisplayName = await resolveDisplayName({
      ctx,
      identity,
      explicitDisplayName: args.displayName,
      fallback: `Player-${identity.subject.slice(0, 5)}`,
    })
    await upsertPreferredDisplayName({
      ctx,
      identity,
      displayName: resolvedDisplayName,
    })

    const now = Date.now()
    const playerId = await ctx.db.insert('players', {
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
      subject: identity.subject,
      displayName: resolvedDisplayName,
      imageUrl: identity.pictureUrl,
      isAdmin: identity.tokenIdentifier === room.adminTokenIdentifier,
      joinedAtMs: now,
      lastSeenAtMs: now,
      teamId: undefined,
      score: 0,
    })

    return {
      roomCode: room.code,
      roomId: room._id,
      playerId,
    }
  },
})

export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx)
    const profile = await getUserProfileByToken({
      ctx,
      tokenIdentifier: identity.tokenIdentifier,
    })
    return {
      preferredDisplayName: profile?.preferredDisplayName ?? null,
    }
  },
})

export const getMyGameHistory = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const requestedLimit = Math.floor(args.limit ?? DEFAULT_GAME_HISTORY_LIMIT)
    const limit = Math.min(
      MAX_GAME_HISTORY_LIMIT,
      Math.max(
        1,
        Number.isFinite(requestedLimit)
          ? requestedLimit
          : DEFAULT_GAME_HISTORY_LIMIT,
      ),
    )

    const playerRows = await ctx.db
      .query('players')
      .withIndex('by_token', (q) => q.eq('tokenIdentifier', identity.tokenIdentifier))
      .collect()
    if (playerRows.length < 1) {
      return []
    }

    const latestPlayerByRoomId = new Map<Id<'rooms'>, Doc<'players'>>()
    const sortedPlayers = [...playerRows].sort((a, b) => {
      if (a.joinedAtMs !== b.joinedAtMs) {
        return b.joinedAtMs - a.joinedAtMs
      }
      return b._id.localeCompare(a._id)
    })
    for (const player of sortedPlayers) {
      if (latestPlayerByRoomId.has(player.roomId)) {
        continue
      }
      latestPlayerByRoomId.set(player.roomId, player)
    }

    const roomEntries = (
      await Promise.all(
        [...latestPlayerByRoomId.values()].map(async (player) => {
          const room = await ctx.db.get(player.roomId)
          if (!room) {
            return null
          }
          return { player, room }
        }),
      )
    )
      .filter((entry): entry is { player: Doc<'players'>; room: Doc<'rooms'> } => !!entry)
      .filter(
        ({ room }) =>
          !!room.startedAtMs ||
          room.state === 'IN_PROGRESS' ||
          room.state === 'BETWEEN_ROUNDS' ||
          room.state === 'FINISHED' ||
          room.state === 'CANCELED' ||
          room.roundNumber > 0,
      )
      .sort((a, b) => b.room.createdAtMs - a.room.createdAtMs)
      .slice(0, limit)

    return await Promise.all(
      roomEntries.map(async ({ player, room }) => {
        const teams = await ctx.db
          .query('teams')
          .withIndex('by_room', (q) => q.eq('roomId', room._id))
          .collect()
        const rankedTeams = [...teams].sort((a, b) => {
          if (a.score !== b.score) {
            return b.score - a.score
          }
          if (a.roundsPlayed !== b.roundsPlayed) {
            return a.roundsPlayed - b.roundsPlayed
          }
          return a.position - b.position
        })
        const myTeam = player.teamId
          ? teams.find((team) => team._id === player.teamId) ?? null
          : null
        const myTeamRank = myTeam
          ? rankedTeams.findIndex((team) => team._id === myTeam._id) + 1
          : null
        const topScore =
          teams.length > 0
            ? teams.reduce(
                (maxScore, team) => Math.max(maxScore, team.score),
                Number.NEGATIVE_INFINITY,
              )
            : null
        const topTeamCount =
          topScore === null
            ? 0
            : teams.filter((team) => team.score === topScore).length

        const result =
          room.state === 'CANCELED'
            ? null
            : room.state !== 'FINISHED'
              ? 'ONGOING'
              : !myTeam || topScore === null
                ? 'NO_TEAM'
                : myTeam.score === topScore
                  ? topTeamCount > 1
                    ? 'DRAW'
                    : 'WON'
                  : 'LOST'

        return {
          roomId: room._id,
          roomCode: room.code,
          state: room.state,
          createdAtMs: room.createdAtMs,
          startedAtMs: room.startedAtMs ?? null,
          finishedAtMs: room.finishedAtMs ?? null,
          isAdmin: player.isAdmin,
          myScore: player.score,
          myTeamName: myTeam?.name ?? null,
          myTeamRank,
          teamCount: teams.length,
          roundCount: room.roundNumber,
          wordsUsedCount: room.wordCursor,
          result,
          endMessage:
            room.state === 'FINISHED' || room.state === 'CANCELED'
              ? room.lastEvent?.message ?? null
              : null,
        }
      }),
    )
  },
})

export const configureRoom = mutation({
  args: {
    code: v.string(),
    config: roomConfigValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['LOBBY', 'CONFIGURED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    if (!WORD_MODES.includes(args.config.wordMode)) {
      throw new Error('Invalid word mode')
    }
    if (!DIFFICULTY_MODES.includes(args.config.difficultyMode)) {
      throw new Error('Invalid difficulty mode')
    }

    const selectedCategories =
      args.config.wordMode === 'random_all'
        ? [...WORD_CATEGORIES]
        : Array.from(new Set(args.config.selectedCategories))

    const config: RoomConfig = {
      wordsPerTeamLimit: Math.floor(args.config.wordsPerTeamLimit),
      timePerWordSeconds: Math.floor(args.config.timePerWordSeconds),
      wordMode: args.config.wordMode,
      selectedCategories: selectedCategories as WordCategory[],
      difficultyMode: args.config.difficultyMode,
    }

    const wordDeck = buildWordDeck(config, room.wordSeed)

    const [players, teams, rounds, usedWords] = await Promise.all([
      ctx.db
        .query('players')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('teams')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('rounds')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('usedWords')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
    ])

    await Promise.all([
      ...players.map((player) => ctx.db.patch(player._id, { score: 0 })),
      ...teams.map((team) =>
        ctx.db.patch(team._id, {
          score: 0,
          roundsPlayed: 0,
        }),
      ),
      ...rounds.map((round) => ctx.db.delete(round._id)),
      ...usedWords.map((usedWord) => ctx.db.delete(usedWord._id)),
    ])

    await ctx.db.patch(room._id, {
      config,
      wordDeck,
      wordCursor: 0,
      state: 'CONFIGURED',
      turnOrder: [],
      turnCursor: 0,
      roundNumber: 0,
      activeRoundId: undefined,
      startedAtMs: undefined,
      finishedAtMs: undefined,
    })

    return {
      success: true,
      totalWordsInDeck: wordDeck.length,
    }
  },
})

export const startGame = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['CONFIGURED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    const { players, teams } = await loadRoomContext(ctx, room._id)
    const now = Date.now()
    const eligiblePlayers = players.filter(
      (player) => !!player.teamId && isPlayerOnline(player, now),
    )

    if (eligiblePlayers.length < 2) {
      throw new Error('At least two connected assigned players are required to start')
    }

    const playersPerTeam = new Map<Id<'teams'>, number>(teams.map((team) => [team._id, 0]))
    for (const player of eligiblePlayers) {
      if (!player.teamId) {
        continue
      }
      const current = playersPerTeam.get(player.teamId)
      if (current === undefined) {
        continue
      }
      playersPerTeam.set(player.teamId, current + 1)
    }
    const emptyTeams = teams.filter(
      (team) => (playersPerTeam.get(team._id) ?? 0) === 0,
    )
    if (emptyTeams.length > 0) {
      throw new Error(
        'Every team must have at least one connected player. Remove empty teams or reconnect players.',
      )
    }

    const activeTeamIds = new Set(
      eligiblePlayers
        .map((player) => player.teamId)
        .filter((teamId): teamId is Id<'teams'> => !!teamId),
    )
    if (activeTeamIds.size < 2) {
      throw new Error('Players must be distributed across at least two teams')
    }

    const turnOrder = buildDeterministicTurnOrder(eligiblePlayers)
    if (room.wordDeck.length < 1) {
      throw new Error('Word pool is empty. Configure the room first')
    }

    const [rounds, usedWords] = await Promise.all([
      ctx.db
        .query('rounds')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('usedWords')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
    ])

    await Promise.all([
      ...players.map((player) => ctx.db.patch(player._id, { score: 0 })),
      ...teams.map((team) =>
        ctx.db.patch(team._id, {
          score: 0,
          roundsPlayed: 0,
        }),
      ),
      ...rounds.map((round) => ctx.db.delete(round._id)),
      ...usedWords.map((usedWord) => ctx.db.delete(usedWord._id)),
    ])

    await ctx.db.patch(room._id, {
      state: 'BETWEEN_ROUNDS',
      startedAtMs: now,
      finishedAtMs: undefined,
      turnOrder,
      turnCursor: 0,
      roundNumber: 0,
      activeRoundId: undefined,
      wordCursor: 0,
      lastEvent: {
        type: 'GAME_STARTED',
        atMs: now,
      },
    })

    return { success: true }
  },
})

export const startRound = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['BETWEEN_ROUNDS'])
    if (room.activeRoundId) {
      throw new Error('A round is already active')
    }

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    if (room.wordCursor >= room.wordDeck.length) {
      await finishRoom({ ctx, room, atMs: Date.now() })
      return { finished: true, reason: 'WORD_POOL_EXHAUSTED' as const }
    }

    const { playersById, teamsById } = await loadRoomContext(ctx, room._id)
    const now = Date.now()
    const minimumLastSeenAtMs = now - PLAYER_PRESENCE_TIMEOUT_MS
    const nextTurn = findNextEligibleTurn({
      turnOrder: room.turnOrder,
      startCursor: room.turnCursor,
      wordsPerTeamLimit: room.config.wordsPerTeamLimit,
      playersById,
      teamsById,
      minimumLastSeenAtMs,
    })

    if (!nextTurn) {
      const nextWithoutPresence = findNextEligibleTurn({
        turnOrder: room.turnOrder,
        startCursor: room.turnCursor,
        wordsPerTeamLimit: room.config.wordsPerTeamLimit,
        playersById,
        teamsById,
      })
      if (nextWithoutPresence) {
        throw new Error('No connected players available to start round')
      }
      await finishRoom({ ctx, room, atMs: now })
      return { finished: true, reason: 'TEAM_LIMIT_REACHED' as const }
    }

    const player = playersById.get(nextTurn.playerId)
    if (!player?.teamId) {
      throw new Error('Selected player has no team')
    }

    const wordEntry = room.wordDeck[room.wordCursor]
    if (!wordEntry) {
      await finishRoom({ ctx, room, atMs: Date.now() })
      return { finished: true, reason: 'WORD_POOL_EXHAUSTED' as const }
    }

    const endsAtMs = now + room.config.timePerWordSeconds * 1000

    const roundId = await ctx.db.insert('rounds', {
      roomId: room._id,
      roundNumber: room.roundNumber + 1,
      teamId: player.teamId,
      playerId: player._id,
      word: wordEntry.word,
      wordKey: wordEntry.key,
      category: wordEntry.category,
      guessed: false,
      status: 'ACTIVE',
      startedAtMs: now,
      endsAtMs,
      endedAtMs: undefined,
      endedReason: undefined,
      pointsAwarded: 0,
    })

    await ctx.db.insert('usedWords', {
      roomId: room._id,
      wordKey: wordEntry.key,
      word: wordEntry.word,
      category: wordEntry.category,
      roundId,
      usedAtMs: now,
    })

    await ctx.db.patch(room._id, {
      state: 'IN_PROGRESS',
      activeRoundId: roundId,
      roundNumber: room.roundNumber + 1,
      wordCursor: room.wordCursor + 1,
      turnCursor: (nextTurn.cursor + 1) % room.turnOrder.length,
      lastEvent: {
        type: 'ROUND_STARTED',
        atMs: now,
        roundId,
      },
    })

    return {
      success: true,
      roundId,
    }
  },
})

export const markRoundGuessed = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['IN_PROGRESS'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    await endActiveRound({ ctx, room, reason: 'GUESSED' })
    return { success: true }
  },
})

export const timeoutRound = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['IN_PROGRESS'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }

    await endActiveRound({ ctx, room, reason: 'TIMEOUT' })
    return { success: true }
  },
})

export const assignPlayerTeam = mutation({
  args: {
    code: v.string(),
    playerId: v.id('players'),
    teamId: v.optional(v.id('teams')),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['LOBBY', 'CONFIGURED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    const player = await ctx.db.get(args.playerId)
    if (!player || player.roomId !== room._id) {
      throw new Error('Player not found in room')
    }

    if (args.teamId) {
      const team = await ctx.db.get(args.teamId)
      if (!team || team.roomId !== room._id) {
        throw new Error('Team not found in room')
      }
    }

    await ctx.db.patch(player._id, {
      teamId: args.teamId,
    })
    return { success: true }
  },
})

export const createTeam = mutation({
  args: {
    code: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['LOBBY', 'CONFIGURED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    const teams = await ctx.db
      .query('teams')
      .withIndex('by_room', (q) => q.eq('roomId', room._id))
      .collect()

    const position = teams.length
    const teamId = await ctx.db.insert('teams', {
      roomId: room._id,
      name: args.name.trim() || `Team ${position + 1}`,
      color: teamColorForPosition(position),
      position,
      score: 0,
      roundsPlayed: 0,
      createdAtMs: Date.now(),
    })

    return { teamId }
  },
})

export const heartbeat = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    await ctx.db.patch(me._id, {
      lastSeenAtMs: Date.now(),
    })
    return { success: true }
  },
})

export const leaveRoom = mutation({
  args: {
    code: v.string(),
    terminateIfAdmin: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      return { success: true }
    }
    if (me.isAdmin) {
      const now = Date.now()
      const shouldTerminate = !!args.terminateIfAdmin

      if (shouldTerminate && room.state !== 'FINISHED' && room.state !== 'CANCELED') {
        const activeRound = room.activeRoundId ? await ctx.db.get(room.activeRoundId) : null
        if (activeRound && activeRound.status === 'ACTIVE') {
          await ctx.db.patch(activeRound._id, {
            status: 'COMPLETED',
            guessed: false,
            endedAtMs: now,
            endedReason: 'TIMEOUT',
            pointsAwarded: 0,
          })
        }

        const neverStarted =
          room.state === 'LOBBY' || (room.state === 'CONFIGURED' && !room.startedAtMs)
        const message = neverStarted
          ? `Game canceled by ${me.displayName} before the first marker touched the board.`
          : `Your beloved admin ${me.displayName} terminated the game.`
        await ctx.db.patch(room._id, {
          state: neverStarted ? 'CANCELED' : 'FINISHED',
          activeRoundId: undefined,
          finishedAtMs: now,
          lastEvent: {
            type: neverStarted ? 'GAME_CANCELED' : 'GAME_TERMINATED',
            atMs: now,
            actorName: me.displayName,
            message,
          },
        })
      }

      await ctx.db.patch(me._id, { lastSeenAtMs: now - PLAYER_PRESENCE_TIMEOUT_MS - 1 })
      return { success: true, terminated: shouldTerminate }
    }
    const latestRoom = await ctx.db.get(room._id)
    if (!latestRoom) {
      return { success: true }
    }
    const now = Date.now()
    if (latestRoom.state === 'FINISHED' || latestRoom.state === 'CANCELED') {
      // Preserve finished-session participants so past games remain re-openable and
      // visible in player history.
      await ctx.db.patch(me._id, { lastSeenAtMs: now - PLAYER_PRESENCE_TIMEOUT_MS - 1 })
      return { success: true }
    }

    await ctx.db.delete(me._id)

    if (latestRoom.state === 'LOBBY' || latestRoom.state === 'CONFIGURED') {
      return { success: true }
    }

    const [remainingPlayers, teams] = await Promise.all([
      ctx.db
        .query('players')
        .withIndex('by_room', (q) => q.eq('roomId', latestRoom._id))
        .collect(),
      ctx.db
        .query('teams')
        .withIndex('by_room', (q) => q.eq('roomId', latestRoom._id))
        .collect(),
    ])

    const teamsWithOnlinePlayers = new Set<Id<'teams'>>()
    for (const player of remainingPlayers) {
      if (player.teamId && isPlayerOnline(player, now)) {
        teamsWithOnlinePlayers.add(player.teamId)
      }
    }

    if (teamsWithOnlinePlayers.size <= 1) {
      const activeRound = latestRoom.activeRoundId
        ? await ctx.db.get(latestRoom.activeRoundId)
        : null
      if (activeRound && activeRound.status === 'ACTIVE') {
        await ctx.db.patch(activeRound._id, {
          status: 'COMPLETED',
          guessed: false,
          endedAtMs: now,
          endedReason: 'TIMEOUT',
          pointsAwarded: 0,
        })
      }

      const survivingTeamId = Array.from(teamsWithOnlinePlayers)[0] ?? null
      const survivingTeamName =
        survivingTeamId
          ? teams.find((team) => team._id === survivingTeamId)?.name ?? 'your team'
          : null
      const message = survivingTeamName
        ? `All other teams disappeared in a puff of marker smoke. ${survivingTeamName} wins by simply staying in the room.`
        : 'Everyone left the room, including the competition. Game over.'

      await ctx.db.patch(latestRoom._id, {
        state: 'FINISHED',
        activeRoundId: undefined,
        finishedAtMs: now,
        lastEvent: {
          type: 'GAME_FINISHED',
          atMs: now,
          message,
        },
      })
      return { success: true, endedByLeavers: true }
    }

    return { success: true }
  },
})

export const startNextRoomSession = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['FINISHED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    const now = Date.now()
    if (!room.finishedAtMs || now - room.finishedAtMs > NEXT_ROOM_START_WINDOW_MS) {
      throw new Error('This game ended a while ago. Start a fresh game from home.')
    }

    if (room.nextRoomCode) {
      const existingNextRoom = await getRoomByCode(ctx, room.nextRoomCode)
      if (existingNextRoom) {
        return {
          success: true,
          roomCode: existingNextRoom.code,
          roomId: existingNextRoom._id,
          reused: true,
        }
      }
    }

    const { players, teams } = await loadRoomContext(ctx, room._id)
    const nextRoomCode = await generateUniqueRoomCode(ctx)
    const wordSeed = generateWordSeed(nextRoomCode, now)
    const wordDeck = buildWordDeck(room.config, wordSeed)
    if (wordDeck.length < 1) {
      throw new Error('Word pool is empty. Configure the room first')
    }

    const nextRoomId = await ctx.db.insert('rooms', {
      code: nextRoomCode,
      adminTokenIdentifier: room.adminTokenIdentifier,
      adminPlayerId: undefined,
      state: 'CONFIGURED',
      createdAtMs: now,
      startedAtMs: undefined,
      finishedAtMs: undefined,
      config: room.config,
      wordSeed,
      wordDeck,
      wordCursor: 0,
      turnOrder: [],
      turnCursor: 0,
      roundNumber: 0,
      activeRoundId: undefined,
      nextRoomCode: undefined,
      lastEvent: undefined,
    })

    const teamIdMap = new Map<Id<'teams'>, Id<'teams'>>()
    const sortedTeams = [...teams].sort((a, b) => a.position - b.position)
    for (const team of sortedTeams) {
      const nextTeamId = await ctx.db.insert('teams', {
        roomId: nextRoomId,
        name: team.name,
        color: team.color,
        position: team.position,
        score: 0,
        roundsPlayed: 0,
        createdAtMs: now,
      })
      teamIdMap.set(team._id, nextTeamId)
    }

    const sortedPlayers = [...players].sort((a, b) => {
      if (a.joinedAtMs !== b.joinedAtMs) {
        return a.joinedAtMs - b.joinedAtMs
      }
      return a._id.localeCompare(b._id)
    })
    let nextAdminPlayerId: Id<'players'> | null = null
    for (const [index, player] of sortedPlayers.entries()) {
      const nextPlayerId = await ctx.db.insert('players', {
        roomId: nextRoomId,
        tokenIdentifier: player.tokenIdentifier,
        subject: player.subject,
        displayName: player.displayName,
        imageUrl: player.imageUrl,
        isAdmin: player.isAdmin,
        joinedAtMs: now + index,
        lastSeenAtMs: player.lastSeenAtMs ?? now,
        teamId: player.teamId ? teamIdMap.get(player.teamId) : undefined,
        score: 0,
      })
      if (player.isAdmin) {
        nextAdminPlayerId = nextPlayerId
      }
    }

    if (!nextAdminPlayerId) {
      throw new Error('Failed to create next room admin player')
    }

    await Promise.all([
      ctx.db.patch(nextRoomId, {
        adminPlayerId: nextAdminPlayerId,
      }),
      ctx.db.patch(room._id, {
        nextRoomCode,
      }),
    ])

    return {
      success: true,
      roomCode: nextRoomCode,
      roomId: nextRoomId,
    }
  },
})

export const removeTeam = mutation({
  args: {
    code: v.string(),
    teamId: v.id('teams'),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['LOBBY', 'CONFIGURED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    const [team, teams, playersInTeam] = await Promise.all([
      ctx.db.get(args.teamId),
      ctx.db
        .query('teams')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('players')
        .withIndex('by_room_team', (q) =>
          q.eq('roomId', room._id).eq('teamId', args.teamId),
        )
        .collect(),
    ])

    if (!team || team.roomId !== room._id) {
      throw new Error('Team not found in room')
    }
    if (teams.length <= 2) {
      throw new Error('At least two teams are required')
    }

    await Promise.all(
      playersInTeam.map((player) => ctx.db.patch(player._id, { teamId: undefined })),
    )
    await ctx.db.delete(team._id)

    return { success: true }
  },
})

export const updateTeam = mutation({
  args: {
    code: v.string(),
    teamId: v.id('teams'),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      throw new Error('Room not found')
    }
    assertState(room, ['LOBBY', 'CONFIGURED'])

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      throw new Error('Join the room first')
    }
    assertAdmin(me)

    const team = await ctx.db.get(args.teamId)
    if (!team || team.roomId !== room._id) {
      throw new Error('Team not found in room')
    }

    await ctx.db.patch(team._id, {
      name: args.name?.trim() || team.name,
    })

    return { success: true }
  },
})

export const getRoomView = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const room = await getRoomByCode(ctx, args.code)
    if (!room) {
      return { status: 'NOT_FOUND' as const }
    }

    const me = await getRoomPlayerByToken({
      ctx,
      roomId: room._id,
      tokenIdentifier: identity.tokenIdentifier,
    })
    if (!me) {
      return {
        status: 'NOT_JOINED' as const,
        roomCode: room.code,
        roomState: room.state,
        nextRoomCode: room.nextRoomCode ?? null,
      }
    }

    const [players, teams, rounds] = await Promise.all([
      ctx.db
        .query('players')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('teams')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
      ctx.db
        .query('rounds')
        .withIndex('by_room', (q) => q.eq('roomId', room._id))
        .collect(),
    ])

    const playersById = new Map(players.map((player) => [player._id, player]))
    const teamsById = new Map(teams.map((team) => [team._id, team]))
    const activeRound = room.activeRoundId ? await ctx.db.get(room.activeRoundId) : null
    const viewerIsActivePlayer = !!(
      activeRound &&
      activeRound.status === 'ACTIVE' &&
      activeRound.playerId === me._id
    )

    const now = Date.now()
    const nextTurn = findNextEligibleTurn({
      turnOrder: room.turnOrder,
      startCursor: room.turnCursor,
      wordsPerTeamLimit: room.config.wordsPerTeamLimit,
      playersById,
      teamsById,
      minimumLastSeenAtMs: now - PLAYER_PRESENCE_TIMEOUT_MS,
    })
    const nextPlayer = nextTurn ? playersById.get(nextTurn.playerId) : null
    const nextTeam =
      nextPlayer?.teamId ? teamsById.get(nextPlayer.teamId) ?? null : null

    const playersSorted = [...players].sort((a, b) => {
      if (a.joinedAtMs !== b.joinedAtMs) {
        return a.joinedAtMs - b.joinedAtMs
      }
      return a._id.localeCompare(b._id)
    })

    const rankedTeams = [...teams]
      .sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score
        }
        if (a.roundsPlayed !== b.roundsPlayed) {
          return a.roundsPlayed - b.roundsPlayed
        }
        return a.position - b.position
      })
      .map((team, index) => {
        const teamPlayers = playersSorted
          .filter((player) => player.teamId === team._id)
          .map((player) => ({
            id: player._id,
            displayName: player.displayName,
            imageUrl: player.imageUrl ?? null,
            score: player.score,
            isAdmin: player.isAdmin,
            isOnline: isPlayerOnline(player, now),
            lastSeenAtMs: player.lastSeenAtMs ?? player.joinedAtMs,
          }))
        return {
          id: team._id,
          name: team.name,
          color: team.color,
          score: team.score,
          roundsPlayed: team.roundsPlayed,
          rank: index + 1,
          playerCount: teamPlayers.length,
          onlinePlayerCount: teamPlayers.filter((player) => player.isOnline).length,
          players: teamPlayers,
        }
      })

    const unassignedPlayers = playersSorted
      .filter((player) => !player.teamId)
      .map((player) => ({
        id: player._id,
        displayName: player.displayName,
        imageUrl: player.imageUrl ?? null,
        score: player.score,
        isAdmin: player.isAdmin,
        isOnline: isPlayerOnline(player, now),
        lastSeenAtMs: player.lastSeenAtMs ?? player.joinedAtMs,
      }))

    const history = [...rounds]
      .filter((round) => round.status === 'COMPLETED')
      .sort((a, b) => a.roundNumber - b.roundNumber)
      .map((round) => {
        const roundPlayer = playersById.get(round.playerId)
        const roundTeam = teamsById.get(round.teamId)
        return {
          id: round._id,
          roundNumber: round.roundNumber,
          word: round.word,
          category: round.category,
          guessed: round.guessed,
          pointsAwarded: round.pointsAwarded,
          playerName: roundPlayer?.displayName ?? 'Unknown',
          teamName: roundTeam?.name ?? 'Unknown',
          endedReason: round.endedReason ?? null,
          startedAtMs: round.startedAtMs,
          endedAtMs: round.endedAtMs ?? null,
        }
      })

    const currentRound =
      activeRound && activeRound.status === 'ACTIVE'
        ? {
            id: activeRound._id,
            roundNumber: activeRound.roundNumber,
            category: activeRound.category,
            word: viewerIsActivePlayer ? activeRound.word : null,
            startedAtMs: activeRound.startedAtMs,
            endsAtMs: activeRound.endsAtMs,
            playerId: activeRound.playerId,
            teamId: activeRound.teamId,
            playerName: playersById.get(activeRound.playerId)?.displayName ?? 'Unknown',
            teamName: teamsById.get(activeRound.teamId)?.name ?? 'Unknown',
          }
        : null

    return {
      status: 'JOINED' as const,
      room: {
        id: room._id,
        code: room.code,
        state: room.state,
        createdAtMs: room.createdAtMs,
        startedAtMs: room.startedAtMs ?? null,
        finishedAtMs: room.finishedAtMs ?? null,
        roundNumber: room.roundNumber,
        wordPoolSize: room.wordDeck.length,
        usedWordsCount: room.wordCursor,
        remainingWordsCount: Math.max(0, room.wordDeck.length - room.wordCursor),
        nextRoomCode: room.nextRoomCode ?? null,
        config: room.config,
        lastEvent: room.lastEvent ?? null,
      },
      me: {
        id: me._id,
        displayName: me.displayName,
        isAdmin: me.isAdmin,
        score: me.score,
        teamId: me.teamId ?? null,
      },
      nextTurn: nextPlayer
        ? {
            playerId: nextPlayer._id,
            playerName: nextPlayer.displayName,
            teamId: nextPlayer.teamId ?? null,
            teamName: nextTeam?.name ?? null,
          }
        : null,
      currentRound,
      activePlayerId: currentRound?.playerId ?? null,
      activeTeamId: currentRound?.teamId ?? null,
      teams: rankedTeams,
      unassignedPlayers,
      history,
      players: playersSorted.map((player) => ({
        id: player._id,
        displayName: player.displayName,
        imageUrl: player.imageUrl ?? null,
        score: player.score,
        isAdmin: player.isAdmin,
        isOnline: isPlayerOnline(player, now),
        lastSeenAtMs: player.lastSeenAtMs ?? player.joinedAtMs,
        teamId: player.teamId ?? null,
      })),
    }
  },
})

export const roomExists = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await getRoomByCode(ctx, args.code)
    return !!room
  },
})
