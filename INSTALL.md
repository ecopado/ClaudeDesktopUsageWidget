# Usage Widget for Claude Code

A one-line strip above the prompt box showing your context window, your plan's usage limits,
and what this chat has cost:

- **Context**: how full the window is, with the tokens in use beside it (`Context 11% 113k`).
- **5-hour / Weekly**: on a personal plan, the 5-hour and weekly (all models) windows, each with
  the time it has left (`5-hour 42% 2h left`). A model's own weekly window (such as
  `Weekly · Fable`) is left out.
- **Monthly**: on a work seat, the month's spend against its cap (`Monthly $46.50 of $150`).
  A work seat reports no 5-hour or weekly window at all, so this is the only usage limit it has.
- **This chat**: what this chat has cost so far, estimated at API rates (`$1.24 this chat`).

Each bar keeps one colour (blue for context, purple for 5-hour and monthly, teal for weekly) and
turns amber from 75% and red from 90%. The numbers beside the bars use your theme's own text and
warning colours, so they follow light and dark mode.

**Pace.** The small tick on each limit's bar marks how much of the window has gone by. Fill past
the tick means you're using it faster than it resets. When that pace would reach the limit before
the reset, the hint turns amber and says when (`limit in ~36m`). Hover a bar for its full story:
when it resets, by the clock, and where it's heading.

**Held figures.** In Plan, Default and Accept Edits mode the plan limits aren't read (see
Requirements), and the strip says so: those figures dim and a `Held · 14m` note shows how old they
are. Context and cost carry on as normal. The last plan limits read are also kept across
sessions, so a chat the app has restarted, or a new one, shows them held from the start
instead of leaving them out. They're replaced as soon as that chat reads its own. A held window
that has reset since it was read shows `—` instead of a figure that's no longer true.

**Usage pane.** Press `Details` at the end of the strip, or run `/usage-pane`, for a pane beside
the chat with each limit's reset time and projection (`~70% by reset`), a trend line of the
context window over this chat, and the cost. Its **Read now** button reads the plan limits on
the spot, even in Plan mode; there the app asks you to approve that one read. The pane comes
back with your next session if you left it open. (Claude Code's own `/usage` is a built-in, so
the widget's command is `/usage-pane`.)

The widget works out which account is signed in from the app's usage card and shows that
account's limits, switching by itself when you change account.

## Install

1. Unzip the package and put the `usage-widget` folder somewhere permanent:
   - macOS: `~/.claude/mods/usage-widget`
   - Windows: `C:\Users\<you>\.claude\mods\usage-widget`

   `.claude` is a hidden folder. On macOS, press `Cmd+Shift+.` in Finder to show it, or run:

   ```bash
   mkdir -p ~/.claude/mods && mv ~/Downloads/usage-widget ~/.claude/mods/
   ```

2. Open `~/.claude/settings.json` (Windows: `C:\Users\<you>\.claude\settings.json`; create it if
   it doesn't exist) and add this, merging into any `env` block already there:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/usage-widget"
     }
   }
   ```

   To load several mods, separate their paths with `;` on Windows or `:` on macOS.

3. Quit and reopen the Claude desktop app. The widget appears above the prompt in the Code tab
   in new sessions. Terminal sessions load it too, when `claude --version` is 2.1.288 or later.

### Upgrading

Replace your `usage-widget` folder with the new one, then open a new session or restart the app.

### Editing the widget yourself

While you change the widget's code, add `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"` to the same `env`
block. Every open session then reloads the widget whenever a file in its folder changes, with no
restart. Each reload also prints a dim `usage-widget reloaded (…)` line in every open chat, so
remove the setting again once you're done. Keep a git checkout out of the folder you load while
the watch is on: every commit or pull counts as a change.

### Uninstalling

Remove the `CLAUDE_CODE_PLUGIN_DIRS` line from `~/.claude/settings.json` (or just this mod's
path, if you load several), delete the `usage-widget` folder, and restart the app.

## What's new in 0.4.1

- The 5-hour and weekly limits (or a work seat's monthly spend) no longer drop out of the strip
  when you come back to a chat the app has restarted, or open a new one. The last reading is
  kept across sessions and shown held, with its age, until the chat reads its own.
- A held window that has reset since it was read shows `—` instead of its old percentage.

## What's new in 0.4.0

- A calmer strip: no border, one line of real text at your theme's size and colours, and thin
  bars underneath. Each bar keeps one colour, and the whole bar turns amber or red as it nears
  its limit, not just its number.
- Clearer names: the 5-hour window is `5-hour` (it was `Session`), and what this chat cost is
  `this chat` (it was `Spent` in the strip and `This Session` in Details).
- A pace tick on each limit, and a warning when you're on pace to hit a limit before it resets.
- Plan figures held in Plan, Default or Accept Edits mode are dimmed and labelled with their age,
  instead of looking live.
- `Details` now opens a Usage pane beside the chat, in place of the cards that grew the strip.
  It adds reset times, projections, a context trend line, and a Read now button. `/usage-pane`
  opens it too.

## What's new in 0.3.1

- No more approval prompts after switching from Auto to Plan mode while the session sits idle.
  The widget used to read the usage card on a 10-minute timer that could still think the session
  was in Auto. It now reads the card only when a prompt, a tool call or the end of a turn reports
  the session's current mode.

## What's new in 0.3.0

- Personal plans now show Session and Weekly in the desktop app (they were missing there).
- Switching between a personal and a work account swaps the meters within a minute, with no
  stale Monthly meter left behind.
- Reset times and totals sit after each widget's title; Monthly counts down to its reset.
- Spent is narrower, leaving the other widgets more room; per-model weekly windows are hidden.

## Requirements

Built for Claude Code 2.1.288 and tested on 2.1.299, the version the desktop app bundles as of
October 2026. Mods are an early-access feature, and their API can change between releases.

In the desktop app the plan figures (5-hour and Weekly on a personal plan, Monthly on a work
seat) come from the app's own usage card, read through
`$.mcp.call('ccd_session_mgmt', 'get_usage')`. The widget reads it on each prompt and at the end of
each turn (at most once a minute), and every 10 minutes during a long turn. It never reads it while
the session sits idle. The card is whichever account is signed in, so the meters switch by
themselves when you change account. Outside Auto and Bypass mode (Plan, Default, Accept Edits) the
app asks before it answers that call, so the widget skips it and keeps the last figures up, dimmed
and marked `Held`. Read now in the Usage pane is the one exception: you asked, so it reads the
card anyway, and the app asks you to approve that read. The widget reads the card again as soon
as the session is back in Auto. Each read happens right after a
prompt, a tool call or the end of a turn has reported the session's current mode. A mode you
switch while idle is never mistaken for the one before it. In a terminal session that server does
not exist: 5-hour and Weekly come from the engine's own rate-limit readings instead, and the
monthly meter is left out.

The card gives no reset time for a work seat's monthly cap, so Monthly counts down to the first
of next month at midnight UTC, which is when the app's usage settings show it resetting.

### If your organization manages Claude Code

The widget learns the session's permission mode from Claude Code's session events (prompt
submitted, tool used, turn ended). Where an organization manages Claude Code, those events skip
mods you installed yourself and run only for plugins the organization lists in its managed
settings. There the widget never learns the mode, so it never reads the usage card: Context and
this chat's cost still show, but 5-hour, Weekly and Monthly don't, and the widget never shows an approval
prompt either. Ask your admin to list the mod in managed settings if you need those meters.

## Checking it

`claude plugin validate` and `claude plugin test` only mean anything when the `claude` on your
PATH is the same version as the app's. Check first:

```bash
claude --version
```

An older CLI rejects this mod's manifest with errors that are not real — `Unrecognized key:
"types"`, `hooks: expected record` — because it predates the keys 2.1.288 uses. When the
versions do match:

```bash
claude plugin validate ~/.claude/mods/usage-widget
```

```bash
claude plugin test ~/.claude/mods/usage-widget
```

When they don't, on macOS the desktop app's own engine can run the same checks. It lives under
`~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude`
(or `Claude-profiles/<profile>/claude-code/…` if you use app profiles). This runs the tests
with the newest one:

```bash
"$(find ~/Library/Application\ Support/Claude* -maxdepth 8 -path '*/claude-code/*/claude.app/Contents/MacOS/claude' 2>/dev/null | sed -E 's|.*/claude-code/([^/]+)/.*|\1 &|' | sort -V | tail -1 | cut -d' ' -f2-)" plugin test ~/.claude/mods/usage-widget
```

Otherwise the live engine is the check: run the app with `--debug` and look for lines naming
`usage-widget` in the debug log.

`tsconfig.json` here extends `.claude-plugin/types/tsconfig.json`, which the engine writes
itself the first time it loads the mod — so an editor will complain about the missing file
until the app has run once with the mod installed. Nothing to create by hand.
