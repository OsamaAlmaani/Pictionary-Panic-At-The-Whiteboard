import {
  SignInButton,
  useClerk,
  UserButton,
  useAuth,
  useUser,
} from '@clerk/clerk-react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/room/$code')({ component: RoomPage })

const CATEGORIES = [
  'easy',
  'medium',
  'difficult',
  'hard',
  'idioms',
  'characters',
  'movies',
] as const

type Category = (typeof CATEGORIES)[number]
type WordMode = 'single' | 'multiple' | 'random_all'
type DifficultyMode = 'mixed' | 'easy' | 'medium' | 'difficult' | 'hard'
const PLAYER_PRESENCE_HEARTBEAT_MS = 8_000

type ConfigDraft = {
  wordsPerTeamLimit: number
  timePerWordSeconds: number
  wordMode: WordMode
  selectedCategories: Category[]
  difficultyMode: DifficultyMode
}

function normalizeRoomCode(value: string) {
  return value.trim().toUpperCase()
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function gameStateLabel(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => titleCase(part))
    .join(' ')
}

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw
    .replace(/\[CONVEX[^\]]*\]\s*/g, '')
    .replace(/\[Request ID:[^\]]*\]\s*/g, '')
    .replace(/Server Error\s*/g, '')
  const marker = 'Uncaught Error:'
  const index = cleaned.indexOf(marker)
  if (index >= 0) {
    return cleaned.slice(index + marker.length).trim()
  }
  return cleaned.trim()
}

function tone({
  frequency,
  durationMs,
  type,
}: {
  frequency: number
  durationMs: number
  type: OscillatorType
}) {
  if (typeof window === 'undefined') {
    return
  }
  const AudioCtx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!AudioCtx) {
    return
  }
  const context = new AudioCtx()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = type
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0.001, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02)
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    context.currentTime + durationMs / 1000,
  )
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.onended = () => {
    void context.close()
  }
  oscillator.start()
  oscillator.stop(context.currentTime + durationMs / 1000 + 0.02)
}

function playSuccessSound() {
  tone({ frequency: 880, durationMs: 120, type: 'triangle' })
  window.setTimeout(() => {
    tone({ frequency: 1175, durationMs: 160, type: 'triangle' })
  }, 120)
}

function playTimeoutSound() {
  tone({ frequency: 220, durationMs: 230, type: 'sawtooth' })
  window.setTimeout(() => {
    tone({ frequency: 180, durationMs: 260, type: 'sawtooth' })
  }, 240)
}

function defaultConfig(): ConfigDraft {
  return {
    wordsPerTeamLimit: 5,
    timePerWordSeconds: 60,
    wordMode: 'random_all',
    selectedCategories: [...CATEGORIES],
    difficultyMode: 'mixed',
  }
}

function RoomPage() {
  const navigate = useNavigate()
  const { code: codeParam } = Route.useParams()
  const roomCode = normalizeRoomCode(codeParam)

  const clerk = useClerk()
  const { isSignedIn, user } = useUser()
  const { getToken } = useAuth()

  const [displayName, setDisplayName] = useState('')
  const [displayNameDirty, setDisplayNameDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [newTeamName, setNewTeamName] = useState('')
  const [configDraft, setConfigDraft] = useState<ConfigDraft>(defaultConfig)
  const [nowMs, setNowMs] = useState(Date.now())
  const [leaveIntent, setLeaveIntent] = useState<'leave' | 'logout' | null>(null)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const timeoutGuardRef = useRef<string | null>(null)
  const lastEventRef = useRef<string | null>(null)

  const roomView = useQuery(
    api.game.getRoomView,
    isSignedIn ? { code: roomCode } : 'skip',
  )
  const myProfile = useQuery(api.game.getMyProfile, isSignedIn ? {} : 'skip')
  const joinedView = roomView?.status === 'JOINED' ? roomView : null
  const joinedRoomCode = joinedView?.room.code ?? null

  const joinRoom = useMutation(api.game.joinRoom)
  const configureRoom = useMutation(api.game.configureRoom)
  const startGame = useMutation(api.game.startGame)
  const startRound = useMutation(api.game.startRound)
  const markRoundGuessed = useMutation(api.game.markRoundGuessed)
  const timeoutRound = useMutation(api.game.timeoutRound)
  const assignPlayerTeam = useMutation(api.game.assignPlayerTeam)
  const createTeam = useMutation(api.game.createTeam)
  const updateTeam = useMutation(api.game.updateTeam)
  const removeTeam = useMutation(api.game.removeTeam)
  const restartGame = useMutation(api.game.restartGame)
  const heartbeat = useMutation(api.game.heartbeat)
  const leaveRoom = useMutation(api.game.leaveRoom)

  useEffect(() => {
    if (!isSignedIn || !user) {
      return
    }
    if (displayNameDirty) {
      return
    }
    setDisplayName(
      myProfile?.preferredDisplayName ||
        user.fullName ||
        user.firstName ||
        user.username ||
        user.primaryEmailAddress?.emailAddress?.split('@')[0] ||
        '',
    )
  }, [displayNameDirty, isSignedIn, myProfile?.preferredDisplayName, user])

  const roomConfig = joinedView?.room.config ?? null
  const roomConfigKey = roomConfig ? JSON.stringify(roomConfig) : ''

  useEffect(() => {
    if (!roomConfig) {
      return
    }
    setConfigDraft({
      wordsPerTeamLimit: roomConfig.wordsPerTeamLimit,
      timePerWordSeconds: roomConfig.timePerWordSeconds,
      wordMode: roomConfig.wordMode,
      selectedCategories: roomConfig.selectedCategories,
      difficultyMode: roomConfig.difficultyMode,
    })
  }, [roomConfigKey])

  const currentRound = joinedView?.currentRound ?? null
  const remainingMs = currentRound ? Math.max(0, currentRound.endsAtMs - nowMs) : 0
  const isAdmin = !!joinedView?.me.isAdmin
  const isRoomFinished = joinedView?.room.state === 'FINISHED'
  const canEditConfig =
    isAdmin &&
    (joinedView?.room.state === 'LOBBY' || joinedView?.room.state === 'CONFIGURED')

  useEffect(() => {
    if (!currentRound) {
      return
    }
    const id = window.setInterval(() => {
      setNowMs(Date.now())
    }, 250)
    return () => window.clearInterval(id)
  }, [currentRound])

  useEffect(() => {
    if (!joinedView?.room.lastEvent) {
      return
    }
    const eventKey = `${joinedView.room.lastEvent.type}:${joinedView.room.lastEvent.atMs}`
    if (eventKey === lastEventRef.current) {
      return
    }
    lastEventRef.current = eventKey
    if (joinedView.room.lastEvent.type === 'ROUND_GUESSED') {
      playSuccessSound()
    }
    if (joinedView.room.lastEvent.type === 'ROUND_TIMEOUT') {
      playTimeoutSound()
    }
  }, [joinedView?.room.lastEvent])

  useEffect(() => {
    if (!joinedView || joinedView.room.state !== 'IN_PROGRESS' || !currentRound) {
      timeoutGuardRef.current = null
      return
    }
    if (remainingMs > 0) {
      return
    }
    if (timeoutGuardRef.current === currentRound.id) {
      return
    }
    timeoutGuardRef.current = currentRound.id
    void timeoutRound({ code: joinedView.room.code }).catch(() => {})
  }, [joinedView, currentRound, remainingMs, timeoutRound])

  useEffect(() => {
    if (!joinedRoomCode) {
      return
    }
    const ping = () => {
      void heartbeat({ code: joinedRoomCode }).catch(() => {})
    }
    ping()
    const id = window.setInterval(ping, PLAYER_PRESENCE_HEARTBEAT_MS)
    return () => window.clearInterval(id)
  }, [joinedRoomCode, heartbeat])

  useEffect(() => {
    if (!joinedRoomCode) {
      return
    }
    const onPageHide = () => {
      if (isAdmin) {
        return
      }
      void leaveRoom({ code: joinedRoomCode }).catch(() => {})
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [joinedRoomCode, isAdmin, leaveRoom])

  const isBusy = busy !== null

  async function ensureConvexToken() {
    const token = await getToken({ template: 'convex' }).catch(() => null)
    if (token) {
      return true
    }
    setError(
      'Clerk template "convex" token is unavailable. In Clerk JWT Templates, set name "convex" and audience "convex", then sign out/in.',
    )
    return false
  }

  async function runAction(action: string, fn: () => Promise<void>) {
    setBusy(action)
    setError(null)
    try {
      await fn()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleJoinNotJoined() {
    if (!isSignedIn) {
      setError('Sign in first')
      return
    }
    if (!(await ensureConvexToken())) {
      return
    }
    await runAction('join-room', async () => {
      await joinRoom({
        code: roomCode,
        displayName: displayName.trim() || undefined,
      })
    })
  }

  async function handleAssignTeam(playerId: Id<'players'>, teamId?: Id<'teams'>) {
    if (!joinedView) {
      return
    }
    await runAction(`assign-${playerId}`, async () => {
      await assignPlayerTeam({
        code: joinedView.room.code,
        playerId,
        teamId,
      })
    })
  }

  async function handleTeamRename(teamId: Id<'teams'>, name: string) {
    if (!joinedView) {
      return
    }
    await runAction(`rename-${teamId}`, async () => {
      await updateTeam({
        code: joinedView.room.code,
        teamId,
        name,
      })
    })
  }

  function toggleCategory(category: Category) {
    if (!canEditConfig) {
      return
    }
    setConfigDraft((current) => {
      if (current.wordMode === 'random_all') {
        return current
      }
      if (current.wordMode === 'single') {
        return { ...current, selectedCategories: [category] }
      }
      if (current.selectedCategories.includes(category)) {
        if (current.selectedCategories.length === 1) {
          return current
        }
        return {
          ...current,
          selectedCategories: current.selectedCategories.filter((item) => item !== category),
        }
      }
      return {
        ...current,
        selectedCategories: [...current.selectedCategories, category],
      }
    })
  }

  function openLeaveConfirm(intent: 'leave' | 'logout') {
    setError(null)
    setLeaveIntent(intent)
  }

  async function performLeave({
    intent,
    terminateIfAdmin,
  }: {
    intent: 'leave' | 'logout'
    terminateIfAdmin: boolean
  }) {
    if (!joinedRoomCode) {
      return
    }
    await leaveRoom({
      code: joinedRoomCode,
      terminateIfAdmin,
    })
    if (intent === 'logout') {
      await clerk.signOut({ redirectUrl: '/' })
      return
    }
    await navigate({ to: '/' })
  }

  function handleLeaveAction(intent: 'leave' | 'logout') {
    if (isRoomFinished) {
      void runAction(intent === 'logout' ? 'logout-room' : 'leave-room', async () => {
        await performLeave({
          intent,
          terminateIfAdmin: false,
        })
      })
      return
    }
    openLeaveConfirm(intent)
  }

  async function handleConfirmedLeave() {
    if (!leaveIntent || !joinedRoomCode) {
      return
    }
    setLeaveBusy(true)
    setError(null)
    try {
      await performLeave({
        intent: leaveIntent,
        terminateIfAdmin: isAdmin,
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLeaveBusy(false)
      setLeaveIntent(null)
    }
  }

  const startValidation = useMemo(() => {
    if (!joinedView) {
      return null
    }
    if (joinedView.room.state !== 'CONFIGURED') {
      return 'Save room configuration first.'
    }
    if (joinedView.teams.length < 2) {
      return 'At least two teams are required.'
    }

    const assignedPlayers = joinedView.players.filter(
      (player) => !!player.teamId && player.isOnline,
    )
    if (assignedPlayers.length < 2) {
      return 'At least two connected assigned players are required before starting.'
    }

    const teamsWithPlayers = joinedView.teams.filter((team) => team.onlinePlayerCount > 0)
    if (teamsWithPlayers.length < 2) {
      return 'Connected players must be distributed across at least two teams.'
    }

    const emptyTeams = joinedView.teams.filter((team) => team.onlinePlayerCount === 0)
    if (emptyTeams.length > 0) {
      return 'Every team needs at least one connected player before starting.'
    }

    return null
  }, [joinedView])

  const activeTeam = useMemo(() => {
    if (!joinedView?.activeTeamId) {
      return null
    }
    return joinedView.teams.find((team) => team.id === joinedView.activeTeamId) ?? null
  }, [joinedView])

  const finalMessage =
    joinedView?.room.state === 'FINISHED' ? joinedView.room.lastEvent?.message ?? null : null
  const canStartNewGame = useMemo(() => {
    if (!joinedView || joinedView.room.state !== 'FINISHED' || !isAdmin) {
      return false
    }

    const teamsWithOnlinePlayers = joinedView.teams.filter(
      (team) => team.onlinePlayerCount > 0,
    )
    if (teamsWithOnlinePlayers.length < 2) {
      return false
    }

    const hasEmptyTeam = joinedView.teams.some((team) => team.onlinePlayerCount === 0)
    if (hasEmptyTeam) {
      return false
    }

    const assignedOnlinePlayers = joinedView.players.filter(
      (player) => !!player.teamId && player.isOnline,
    )
    return assignedOnlinePlayers.length >= 2
  }, [joinedView, isAdmin])

  if (!isSignedIn) {
    return (
      <main className="page-wrap px-4 pb-16 pt-10">
        <section className="island-shell rounded-3xl p-6 sm:p-8">
          <h1 className="display-title m-0 text-4xl sm:text-5xl">Room {roomCode}</h1>
          <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
            Sign in to access this room.
          </p>
          <div className="mt-4 flex gap-2">
            <SignInButton mode="modal">
              <button type="button" className="bg-[var(--mint)] px-4 py-2 text-sm font-extrabold">
                Sign In
              </button>
            </SignInButton>
            <button
              type="button"
              className="bg-[var(--orange)] px-4 py-2 text-sm font-extrabold"
              onClick={() => {
                void navigate({ to: '/' })
              }}
            >
              Back Home
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (!roomView) {
    return (
      <main className="page-wrap px-4 pb-16 pt-10">
        <section className="island-shell rounded-3xl p-6 sm:p-8">
          <p className="text-sm font-semibold">Loading room...</p>
        </section>
      </main>
    )
  }

  if (roomView.status === 'NOT_FOUND') {
    return (
      <main className="page-wrap px-4 pb-16 pt-10">
        <section className="island-shell rounded-3xl p-6 sm:p-8">
          <h1 className="display-title m-0 text-4xl sm:text-5xl">Room Not Found</h1>
          <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
            Room code <strong>{roomCode}</strong> does not exist.
          </p>
          <button
            type="button"
            className="mt-4 bg-[var(--orange)] px-4 py-2 text-sm font-extrabold"
            onClick={() => {
              void navigate({ to: '/' })
            }}
          >
            Back Home
          </button>
        </section>
      </main>
    )
  }

  if (roomView.status === 'NOT_JOINED') {
    return (
      <main className="page-wrap px-4 pb-16 pt-10">
        <section className="island-shell rounded-3xl p-6 sm:p-8">
          <p className="island-kicker mb-2">Join Room</p>
          <h1 className="display-title m-0 text-4xl sm:text-5xl">Room {roomCode}</h1>
          <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
            You are signed in but not joined to this room yet.
          </p>

          <label className="mt-4 block text-sm font-semibold">
            Display name
            <input
              value={displayName}
              onChange={(event) => {
                setDisplayNameDirty(true)
                setDisplayName(event.target.value)
              }}
              className="mt-1 w-full px-3 py-2"
              placeholder="Your display name"
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isBusy}
              className="bg-[var(--mint)] px-4 py-2 text-sm font-extrabold disabled:opacity-60"
              onClick={() => {
                void handleJoinNotJoined()
              }}
            >
              Join Room
            </button>
            <button
              type="button"
              className="bg-[var(--orange)] px-4 py-2 text-sm font-extrabold"
              onClick={() => {
                void navigate({ to: '/' })
              }}
            >
              Back Home
            </button>
          </div>
        </section>

        {error ? (
          <section className="mt-4 rounded-2xl border-[3px] border-[var(--line)] bg-[rgba(255,136,200,0.25)] p-4 text-sm font-semibold text-[var(--line)]">
            {error}
          </section>
        ) : null}
      </main>
    )
  }

  const view = joinedView
  if (!view) {
    return (
      <main className="page-wrap px-4 pb-16 pt-10">
        <section className="island-shell rounded-3xl p-6 sm:p-8">
          <p className="text-sm font-semibold">Loading room...</p>
        </section>
      </main>
    )
  }

  return (
    <main className="page-wrap px-4 pb-16 pt-10">
      <section className="island-shell rounded-3xl p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="display-title m-0 text-3xl sm:text-4xl">Room {view.room.code}</h1>
          <span className="rounded-full border-[3px] border-[var(--line)] bg-white px-3 py-1 text-xs font-extrabold">
            {gameStateLabel(view.room.state)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <UserButton />
            <button
              type="button"
              className="bg-white px-3 py-1.5 text-sm font-extrabold"
              onClick={() => handleLeaveAction('logout')}
            >
              Logout
            </button>
            <button
              type="button"
              className="bg-[var(--orange)] px-3 py-1.5 text-sm font-extrabold"
              onClick={() => handleLeaveAction('leave')}
            >
              Leave Room
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <section className="mt-4 rounded-2xl border-[3px] border-[var(--line)] bg-[rgba(255,136,200,0.25)] p-4 text-sm font-semibold text-[var(--line)]">
          {error}
        </section>
      ) : null}

      {(view.room.state === 'LOBBY' || view.room.state === 'CONFIGURED') && (
        <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <article className="island-shell rounded-2xl p-5">
            <p className="island-kicker mb-1">Setup</p>
            <h2 className="m-0 text-2xl font-bold">Room Configuration</h2>
            <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
              Configure words and teams before the game starts.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                Words per team
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={configDraft.wordsPerTeamLimit}
                  disabled={!canEditConfig}
                  onChange={(event) =>
                    setConfigDraft((current) => ({
                      ...current,
                      wordsPerTeamLimit: Math.max(1, Number(event.target.value)),
                    }))
                  }
                  className="mt-1 w-full px-3 py-2"
                />
              </label>
              <label className="text-sm font-semibold">
                Time per word (seconds)
                <input
                  type="number"
                  min={10}
                  max={300}
                  value={configDraft.timePerWordSeconds}
                  disabled={!canEditConfig}
                  onChange={(event) =>
                    setConfigDraft((current) => ({
                      ...current,
                      timePerWordSeconds: Math.max(10, Number(event.target.value)),
                    }))
                  }
                  className="mt-1 w-full px-3 py-2"
                />
              </label>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                Word mode
                <select
                  value={configDraft.wordMode}
                  disabled={!canEditConfig}
                  onChange={(event) =>
                    setConfigDraft((current) => {
                      const mode = event.target.value as WordMode
                      if (mode === 'random_all') {
                        return {
                          ...current,
                          wordMode: mode,
                          selectedCategories: [...CATEGORIES],
                        }
                      }
                      if (mode === 'single') {
                        return {
                          ...current,
                          wordMode: mode,
                          selectedCategories: [current.selectedCategories[0] ?? 'easy'],
                        }
                      }
                      return {
                        ...current,
                        wordMode: mode,
                        selectedCategories:
                          current.selectedCategories.length > 0
                            ? current.selectedCategories
                            : ['easy', 'medium'],
                      }
                    })
                  }
                  className="mt-1 w-full px-3 py-2"
                >
                  <option value="single">Single Category</option>
                  <option value="multiple">Multiple Categories</option>
                  <option value="random_all">Random Across All</option>
                </select>
              </label>

              <label className="text-sm font-semibold">
                Difficulty mode
                <select
                  value={configDraft.difficultyMode}
                  disabled={!canEditConfig}
                  onChange={(event) =>
                    setConfigDraft((current) => ({
                      ...current,
                      difficultyMode: event.target.value as DifficultyMode,
                    }))
                  }
                  className="mt-1 w-full px-3 py-2"
                >
                  <option value="mixed">Mixed</option>
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="difficult">Difficult</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
            </div>

            <div className="mt-4">
              <p className="mb-2 text-sm font-semibold">Categories</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CATEGORIES.map((category) => {
                  const selected = configDraft.selectedCategories.includes(category)
                  return (
                    <button
                      key={category}
                      type="button"
                      disabled={!canEditConfig || configDraft.wordMode === 'random_all'}
                      onClick={() => toggleCategory(category)}
                      className={`px-3 py-2 text-sm font-semibold ${
                        selected
                          ? 'bg-[var(--mint)]'
                          : 'bg-white'
                      } disabled:opacity-50`}
                    >
                      {titleCase(category)}
                    </button>
                  )
                })}
              </div>
            </div>

            {isAdmin ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isBusy}
                  className="bg-[var(--mint)] px-4 py-2 text-sm font-extrabold disabled:opacity-60"
                  onClick={() => {
                    void runAction('configure', async () => {
                      await configureRoom({
                        code: view.room.code,
                        config: {
                          wordsPerTeamLimit: configDraft.wordsPerTeamLimit,
                          timePerWordSeconds: configDraft.timePerWordSeconds,
                          wordMode: configDraft.wordMode,
                          selectedCategories:
                            configDraft.wordMode === 'random_all'
                              ? [...CATEGORIES]
                              : configDraft.selectedCategories,
                          difficultyMode: configDraft.difficultyMode,
                        },
                      })
                    })
                  }}
                >
                  Save Configuration
                </button>

                <button
                  type="button"
                  disabled={isBusy || !!startValidation}
                  className="bg-[var(--orange)] px-4 py-2 text-sm font-extrabold disabled:opacity-60"
                  onClick={() => {
                    void runAction('start-game', async () => {
                      await startGame({ code: view.room.code })
                    })
                  }}
                >
                  Start Game
                </button>
              </div>
            ) : (
              <p className="mt-4 rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-3 text-sm font-semibold">
                Waiting for admin to configure and start the game.
              </p>
            )}

            {isAdmin && startValidation ? (
              <p className="mt-3 text-sm font-semibold text-[var(--line)]">{startValidation}</p>
            ) : null}
          </article>

          <article className="island-shell rounded-2xl p-5">
            <h3 className="m-0 text-lg font-semibold">Players</h3>

            <div className="mt-3 space-y-3">
              {view.players.map((player) => (
                <div
                  key={player.id}
                  className="rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="m-0 text-sm font-semibold">
                      {player.displayName}
                      {player.isAdmin ? ' (Admin)' : ''}
                    </p>
                    <span
                      className={`inline-flex rounded-full border-[3px] border-[var(--line)] px-2 py-0.5 text-[10px] font-extrabold ${
                        player.isOnline ? 'bg-[var(--mint)]' : 'bg-[var(--pink)]'
                      }`}
                    >
                      {player.isOnline ? 'Online' : 'Offline'}
                    </span>
                  </div>

                  {isAdmin ? (
                    <div className="mt-2 flex items-center gap-2">
                      <select
                        value={player.teamId ?? ''}
                        disabled={view.room.state !== 'LOBBY' && view.room.state !== 'CONFIGURED'}
                        onChange={(event) => {
                          const value = event.target.value
                          void handleAssignTeam(
                            player.id,
                            value ? (value as Id<'teams'>) : undefined,
                          )
                        }}
                        className="w-full px-2 py-1 text-sm"
                      >
                        <option value="">Unassigned</option>
                        {view.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <p className="mt-2 mb-0 text-xs font-semibold text-[var(--sea-ink-soft)]">
                      Team:{' '}
                      {player.teamId
                        ? (view.teams.find((team) => team.id === player.teamId)?.name ?? 'Unknown')
                        : 'Unassigned'}
                    </p>
                  )}

                  {!player.isOnline ? (
                    <p className="mt-2 mb-0 text-xs font-semibold text-[var(--line)]">
                      Disconnected player. They cannot be included in active turns.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <h3 className="mt-5 m-0 text-lg font-semibold">Teams</h3>

            {isAdmin ? (
              <>
                <div className="mt-3 flex gap-2">
                  <input
                    value={newTeamName}
                    onChange={(event) => setNewTeamName(event.target.value)}
                    placeholder="New team name"
                    className="w-full px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={isBusy || !newTeamName.trim()}
                    className="whitespace-nowrap bg-[var(--mint)] px-3 py-2 text-sm font-extrabold disabled:opacity-50"
                    onClick={() => {
                      void runAction('create-team', async () => {
                        await createTeam({
                          code: view.room.code,
                          name: newTeamName.trim(),
                        })
                        setNewTeamName('')
                      })
                    }}
                  >
                    Add
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {view.teams.map((team) => (
                    <form
                      key={team.id}
                      className="rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        const name = String(data.get(`team-${team.id}`) ?? '').trim()
                        if (!name || name === team.name) {
                          return
                        }
                        void handleTeamRename(team.id, name)
                      }}
                    >
                      <div className="flex gap-2">
                        <input
                          name={`team-${team.id}`}
                          defaultValue={team.name}
                          className="w-full px-2 py-1 text-sm"
                        />
                        <button
                          type="submit"
                          className="whitespace-nowrap bg-white px-2 py-1 text-xs font-extrabold"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          disabled={isBusy || view.teams.length <= 2}
                          className="whitespace-nowrap bg-[var(--pink)] px-2 py-1 text-xs font-extrabold disabled:opacity-50"
                          onClick={() => {
                            void runAction('remove-team', async () => {
                              await removeTeam({
                                code: view.room.code,
                                teamId: team.id,
                              })
                            })
                          }}
                        >
                          Remove
                        </button>
                      </div>
                      <p className="mt-1 mb-0 text-xs text-[var(--sea-ink-soft)]">
                        Players: {team.onlinePlayerCount}/{team.playerCount} online
                      </p>
                    </form>
                  ))}
                </div>
              </>
            ) : (
              <div className="mt-3 space-y-2">
                {view.teams.map((team) => (
                  <div
                    key={team.id}
                    className="rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-3"
                  >
                    <p className="m-0 text-sm font-bold">{team.name}</p>
                    <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                      Players: {team.onlinePlayerCount}/{team.playerCount} online
                    </p>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>
      )}

      {view.room.state === 'BETWEEN_ROUNDS' && (
        <section className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <article className="island-shell rounded-2xl p-6">
            <p className="island-kicker mb-1">Between Rounds</p>
            <h2 className="m-0 text-3xl font-bold">
              Next: {view.nextTurn?.playerName ?? 'No eligible player'}
            </h2>
            <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
              Team: {view.nextTurn?.teamName ?? 'N/A'}
            </p>

            {isAdmin ? (
              <button
                type="button"
                disabled={isBusy}
                className="mt-4 bg-[var(--orange)] px-4 py-2 text-sm font-extrabold disabled:opacity-60"
                onClick={() => {
                  void runAction('start-round', async () => {
                    await startRound({ code: view.room.code })
                  })
                }}
              >
                Start Next Round
              </button>
            ) : (
              <p className="mt-4 rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-3 text-sm font-semibold">
                Waiting for admin to start the next round.
              </p>
            )}
          </article>

          <article className="island-shell rounded-2xl p-5">
            <h3 className="m-0 text-lg font-semibold">Live Scoreboard</h3>
            <div className="mt-3 space-y-2">
              {view.teams.map((team) => (
                <div
                  key={team.id}
                  className="rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-3"
                >
                  <p className="m-0 text-sm font-bold">#{team.rank} {team.name}</p>
                  <p className="m-0 text-xs text-[var(--sea-ink-soft)]">Score: {team.score}</p>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {view.room.state === 'IN_PROGRESS' && (
        <section className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <article className="island-shell rounded-2xl p-6">
            <p className="island-kicker mb-1">Round {view.room.roundNumber}</p>
            <h2 className="m-0 text-3xl font-bold">{view.currentRound?.playerName ?? 'Player'}</h2>
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
              Team: {view.currentRound?.teamName ?? 'N/A'}
            </p>

            <div className="mt-4 rounded-2xl border-[3px] border-[var(--line)] bg-white/70 p-4 text-center">
              <p className="island-kicker mb-1">Timer</p>
              <p className="m-0 text-5xl font-extrabold tabular-nums">
                {currentRound
                  ? `${String(Math.floor(remainingMs / 60000)).padStart(2, '0')}:${String(
                      Math.floor((remainingMs % 60000) / 1000),
                    ).padStart(2, '0')}`
                  : '--:--'}
              </p>
            </div>

            <div className="mt-4 rounded-2xl border-[3px] border-[var(--line)] bg-white/70 p-4">
              <p className="island-kicker mb-1">Current Word</p>
              <p className="m-0 text-3xl font-extrabold">
                {view.currentRound?.word ??
                  `Hidden to everyone except ${view.currentRound?.playerName ?? 'the active player'}`}
              </p>
              <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
                Category: {view.currentRound ? titleCase(view.currentRound.category) : 'N/A'}
              </p>
            </div>

            {isAdmin ? (
              <button
                type="button"
                disabled={isBusy}
                className="mt-4 bg-[var(--mint)] px-4 py-2 text-sm font-extrabold disabled:opacity-60"
                onClick={() => {
                  void runAction('guessed', async () => {
                    await markRoundGuessed({ code: view.room.code })
                  })
                }}
              >
                Mark Guessed (+1)
              </button>
            ) : null}
          </article>

          <article className="island-shell rounded-2xl p-5">
            <h3 className="m-0 text-lg font-semibold">Live Scoreboard</h3>
            <div className="mt-3 space-y-2">
              {view.teams.map((team) => (
                <div
                  key={team.id}
                  className={`rounded-xl border-[3px] border-[var(--line)] p-3 ${
                    team.id === activeTeam?.id ? 'bg-[var(--mint)]' : 'bg-white/70'
                  }`}
                >
                  <p className="m-0 text-sm font-bold">#{team.rank} {team.name}</p>
                  <p className="m-0 text-xs text-[var(--sea-ink-soft)]">Score: {team.score}</p>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {view.room.state === 'FINISHED' && (
        <section className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <article className="island-shell rounded-2xl p-6">
            <p className="island-kicker mb-1">Game Finished</p>
            <h2 className="m-0 text-4xl font-extrabold">Final Leaderboard</h2>
            {finalMessage ? (
              <div className="mt-3 rounded-2xl border-[3px] border-[var(--line)] bg-[rgba(255,136,200,0.35)] p-3">
                <p className="m-0 text-sm font-extrabold text-[var(--line)]">
                  {finalMessage}
                </p>
              </div>
            ) : null}
            <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
              Teams ranked by score with player breakdown.
            </p>

            {canStartNewGame ? (
              <button
                type="button"
                disabled={isBusy}
                className="mt-3 bg-[var(--mint)] px-4 py-2 text-sm font-extrabold disabled:opacity-60"
                onClick={() => {
                  void runAction('restart-game', async () => {
                    await restartGame({ code: view.room.code })
                  })
                }}
              >
                Start New Game
              </button>
            ) : null}

            <div className="mt-4 space-y-3">
              {view.teams.map((team) => (
                <div
                  key={team.id}
                  className="rounded-2xl border-[3px] border-[var(--line)] bg-white/70 p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="m-0 text-lg font-extrabold">#{team.rank} {team.name}</p>
                    <p className="m-0 text-2xl font-extrabold">{team.score}</p>
                  </div>
                  <ul className="mt-2 space-y-1 pl-4">
                    {team.players.map((player) => (
                      <li key={player.id} className="text-sm font-semibold">
                        {player.displayName}: {player.score}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </article>

          <article className="island-shell rounded-2xl p-6">
            <h3 className="m-0 text-xl font-bold">Word History</h3>
            <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
              Completed rounds with guessed status.
            </p>
            <div className="mt-3 max-h-[34rem] space-y-2 overflow-y-auto pr-1">
              {view.history.length === 0 ? (
                <p className="text-sm text-[var(--sea-ink-soft)]">No rounds were completed.</p>
              ) : (
                view.history.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border-[3px] border-[var(--line)] bg-white/70 p-3"
                  >
                    <p className="m-0 text-sm font-extrabold">
                      #{entry.roundNumber} {entry.word}
                    </p>
                    <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                      {entry.teamName} • {entry.playerName} • {titleCase(entry.category)}
                    </p>
                    <p
                      className={`mt-1 mb-0 inline-flex rounded-full border-[3px] border-[var(--line)] px-2 py-0.5 text-xs font-extrabold ${
                        entry.guessed ? 'bg-[var(--mint)]' : 'bg-[var(--pink)]'
                      }`}
                    >
                      {entry.guessed ? 'Guessed' : 'Timeout'}
                    </p>
                  </div>
                ))
              )}
            </div>
          </article>
        </section>
      )}

      {leaveIntent && !isRoomFinished ? (
        <section className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(22,17,61,0.58)] p-4 sm:items-center">
          <article className="island-shell w-full max-w-lg rounded-3xl p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="island-kicker mb-1">Confirm Exit</p>
                <h3 className="m-0 text-2xl font-extrabold">
                  {isAdmin ? 'Leave Room And End Game?' : 'Leave Room?'}
                </h3>
              </div>
              <div className="rounded-2xl border-[3px] border-[var(--line)] bg-white px-3 py-2 text-xl font-extrabold leading-none">
                :(
              </div>
            </div>

            <p className="mt-3 text-sm font-semibold text-[var(--sea-ink-soft)]">
              {isAdmin
                ? 'If you continue, the game will be terminated for everyone in this room.'
                : 'If you leave now, your team loses its artist and chaos energy.'}
            </p>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={leaveBusy}
                className="bg-white px-4 py-2 text-sm font-extrabold"
                onClick={() => setLeaveIntent(null)}
              >
                Stay In Room
              </button>
              <button
                type="button"
                disabled={leaveBusy}
                className={`px-4 py-2 text-sm font-extrabold disabled:opacity-60 ${
                  isAdmin ? 'bg-[var(--pink)]' : 'bg-[var(--orange)]'
                }`}
                onClick={() => {
                  void handleConfirmedLeave()
                }}
              >
                {leaveBusy
                  ? 'Working...'
                  : leaveIntent === 'logout'
                    ? isAdmin
                      ? 'Terminate + Logout'
                      : 'Leave + Logout'
                    : isAdmin
                      ? 'Terminate Game'
                      : 'Leave Room'}
              </button>
            </div>
          </article>
        </section>
      ) : null}
    </main>
  )
}
