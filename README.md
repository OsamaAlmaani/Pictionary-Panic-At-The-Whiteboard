# Panic At The Whiteboard
Bad Art Great Vibes.

This is a real-time team Pictionary game manager.
You can play either with a physical whiteboard or with the built-in online whiteboard mode.

## What The Game Is

Think of this app as your game host:

- It creates and manages rooms.
- It tracks players and teams.
- It rotates turns fairly.
- It gives one secret word to the active player only.
- It handles timing, scoring, and game flow.
- It shows leaderboard + round history at the end.

So instead of arguing about whose turn it is, everyone can focus on the fun part: bad drawings and confident wrong guesses.

## How A Match Works

1. Someone creates a room (the admin).
2. Players join.
3. Admin assigns teams and sets game options.
4. Admin starts the game.
5. Each round:
   - Next player is announced.
   - Admin starts the round.
   - Active player sees the secret word.
   - Timer runs.
   - If guessed: point awarded.
   - If timeout: round ends, no point.
6. Game ends when:
   - Team word limit is reached, or
   - Word pool is exhausted, or
   - Only one team is left active.

At the end, everyone gets a full scoreboard and word history.

## Roles

### Admin

- Creates the room.
- Manages teams and game settings.
- Starts the game and each round.
- Marks guessed words.
- Can play like everyone else.
- Does **not** see the active word unless it is their turn.

### Player

- Joins room.
- Gets assigned to a team.
- Sees secret word only on their own active turn.

## Why People Like It

- Fast setup for game nights.
- Fair turn order and clear timing.
- No repeated words in a session.
- Less confusion, more laughing.

Basically: the app runs the room, your game night runs the show.

## Developer Note: Online Whiteboard (Beta)

This project includes an optional **online whiteboard mode** using:

- `@tldraw/sync`
- `useSyncDemo` (quick start from tldraw docs)

### Important limitation (MVP phase)

During this phase, drawing sync uses the tldraw demo backend. That means:

- Room data is temporary (about 24 hours).
- Demo rooms are not for private/production-grade data handling.
- This is acceptable for short-lived game sessions only.

If this limitation is okay for your use case, great.
If you need stronger privacy/control, move to a self-hosted tldraw sync server.

### Planned production path

- Keep Convex as the game engine (rooms, turns, words, scoring).
- Replace `useSyncDemo` with `useSync` against our own hosted sync backend.
- Enforce access control with Clerk-authenticated room membership.
- Keep a strict retention policy (for example 24h or less) under our own control.
