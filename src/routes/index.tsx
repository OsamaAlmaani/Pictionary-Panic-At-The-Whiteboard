import {
  SignInButton,
  SignOutButton,
  UserButton,
  useAuth,
  useUser,
} from '@clerk/clerk-react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState } from 'react'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/')({ component: HomePage })

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

function gameResultLabel(value: string | null) {
  switch (value) {
    case 'WON':
      return 'Won'
    case 'LOST':
      return 'Lost'
    case 'DRAW':
      return 'Draw'
    case 'NO_TEAM':
      return 'No Team'
    default:
      return 'Ongoing'
  }
}

function gameResultClasses(value: string | null) {
  switch (value) {
    case 'WON':
      return 'bg-[var(--mint)]'
    case 'LOST':
      return 'bg-[rgba(255,136,200,0.45)]'
    case 'DRAW':
      return 'bg-[var(--orange)]'
    case 'NO_TEAM':
      return 'bg-white/80'
    default:
      return 'bg-[var(--paper)]'
  }
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
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

function HomePage() {
  const navigate = useNavigate()
  const { isSignedIn, user } = useUser()
  const { getToken } = useAuth()

  const [displayName, setDisplayName] = useState('')
  const [displayNameDirty, setDisplayNameDirty] = useState(false)
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const createRoom = useMutation(api.game.createRoom)
  const joinRoom = useMutation(api.game.joinRoom)
  const myProfile = useQuery(api.game.getMyProfile, isSignedIn ? {} : 'skip')
  const myGameHistory = useQuery(
    api.game.getMyGameHistory,
    isSignedIn ? { limit: 12 } : 'skip',
  )

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

  async function handleCreate() {
    if (!isSignedIn) {
      setError('Sign in first')
      return
    }
    if (!(await ensureConvexToken())) {
      return
    }

    await runAction('create', async () => {
      const created = await createRoom({
        displayName: displayName.trim() || undefined,
      })
      await navigate({
        to: '/room/$code',
        params: { code: created.roomCode },
      })
    })
  }

  async function handleJoin() {
    if (!isSignedIn) {
      setError('Sign in first')
      return
    }
    if (!(await ensureConvexToken())) {
      return
    }

    const code = normalizeRoomCode(roomCodeInput)
    if (!code) {
      setError('Enter a game code')
      return
    }

    await runAction('join', async () => {
      await joinRoom({
        code,
        displayName: displayName.trim() || undefined,
      })
      await navigate({
        to: '/room/$code',
        params: { code },
      })
    })
  }

  return (
    <main className="page-wrap px-4 pb-16 pt-10">
      <section className="island-shell rounded-3xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Pictionary</p>
        <h1 className="display-title m-0 text-5xl leading-tight sm:text-6xl">
          Panic At The Whiteboard
        </h1>
        <p className="hero-subtitle mt-2" aria-label="Bad Art Great Vibes">
          <span className="hero-subtitle-word hero-subtitle-word-bad">Bad</span>
          <span className="hero-subtitle-word hero-subtitle-word-art">Art</span>
          <span className="hero-subtitle-word hero-subtitle-word-great">Great</span>
          <span className="hero-subtitle-word hero-subtitle-word-vibes">Vibes</span>
        </p>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <article className="island-shell rounded-2xl p-5">
          <h2 className="m-0 text-lg font-semibold">Account</h2>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            {isSignedIn
              ? `Signed in as ${user?.fullName ?? user?.username ?? 'Player'}`
              : 'Sign in with Clerk to continue'}
          </p>

          {!isSignedIn ? (
            <div className="mt-4">
              <SignInButton mode="modal">
                <button
                  type="button"
                  className="rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold"
                >
                  Sign In
                </button>
              </SignInButton>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-3">
              <UserButton />
              <SignOutButton>
                <button
                  type="button"
                  className="rounded-xl border border-[var(--line)] bg-white/85 px-3 py-1.5 text-sm font-semibold"
                >
                  Logout
                </button>
              </SignOutButton>
            </div>
          )}

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
        </article>

        <article className="island-shell rounded-2xl p-5">
          <h2 className="m-0 text-lg font-semibold">Choose Your Move</h2>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy !== null || !isSignedIn}
              onClick={() => {
                void handleCreate()
              }}
              className="rounded-xl border border-[var(--line)] bg-[var(--mint)] px-4 py-3 text-sm font-extrabold"
            >
              Create Game
            </button>

            <button
              type="button"
              disabled={busy !== null || !isSignedIn}
              onClick={() => {
                void handleJoin()
              }}
              className="rounded-xl border border-[var(--line)] bg-[var(--orange)] px-4 py-3 text-sm font-extrabold"
            >
              Join Game
            </button>
          </div>

          <label className="mt-4 block text-sm font-semibold">
            Game code (for join)
            <input
              value={roomCodeInput}
              onChange={(event) => setRoomCodeInput(normalizeRoomCode(event.target.value))}
              className="mt-1 w-full px-3 py-2 tracking-widest uppercase"
              placeholder="ABC123"
              maxLength={6}
            />
          </label>

        </article>
      </section>

      <section className="mt-4">
        <article className="island-shell rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-lg font-semibold">Your Game History</h2>
            {isSignedIn && myGameHistory ? (
              <p className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
                {myGameHistory.length} sessions
              </p>
            ) : null}
          </div>

          {!isSignedIn ? (
            <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
              Sign in to see your played games.
            </p>
          ) : myGameHistory === undefined ? (
            <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">Loading history...</p>
          ) : myGameHistory.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
              No games yet. Start one and make a masterpiece disaster.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {myGameHistory.map((session) => (
                <article
                  key={session.roomId}
                  className="rounded-2xl border-2 border-[var(--line)] bg-white/70 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="m-0 text-xs font-extrabold uppercase tracking-[0.08em] text-[var(--sea-ink-soft)]">
                        Game {session.roomCode}
                      </p>
                      <p className="m-0 text-sm font-semibold">
                        {session.isAdmin ? 'Admin' : 'Player'}
                        {session.myTeamName ? ` • ${session.myTeamName}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <span className="rounded-full border-2 border-[var(--line)] bg-[var(--paper)] px-2 py-0.5 text-xs font-bold">
                        {gameStateLabel(session.state)}
                      </span>
                      {session.result ? (
                        <span
                          className={`rounded-full border-2 border-[var(--line)] px-2 py-0.5 text-xs font-bold ${gameResultClasses(session.result)}`}
                        >
                          {gameResultLabel(session.result)}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <p className="mt-2 text-xs text-[var(--sea-ink-soft)]">
                    {session.finishedAtMs
                      ? `Ended ${formatDateTime(session.finishedAtMs)}`
                      : session.startedAtMs
                        ? `Started ${formatDateTime(session.startedAtMs)}`
                        : `Created ${formatDateTime(session.createdAtMs)}`}
                  </p>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="m-0 text-xs font-semibold text-[var(--sea-ink-soft)]">
                      Score {session.myScore} • Rounds {session.roundCount}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        void navigate({
                          to: '/room/$code',
                          params: { code: session.roomCode },
                        })
                      }}
                      className="rounded-xl border border-[var(--line)] bg-[var(--mint)] px-3 py-1.5 text-xs font-extrabold"
                    >
                      Open Game
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </article>
      </section>

      {error ? (
        <section className="mt-4 rounded-2xl border-[3px] border-[var(--line)] bg-[rgba(255,136,200,0.25)] p-4 text-sm font-semibold text-[var(--line)]">
          {error}
        </section>
      ) : null}
    </main>
  )
}
