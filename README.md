# Panic At The Whiteboard
Bad Art Great Vibes.

This is a real-time team Pictionary room manager for a physical whiteboard game.
No drawing tools in the app. The chaos happens on the board in real life.

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

Basically: the app runs the room, your whiteboard runs the show.
