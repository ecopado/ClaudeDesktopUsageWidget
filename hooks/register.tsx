import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ElementConstructor,
  EngineInterface,
  McpToolResult,
  PluginOptions,
  Register,
  SessionUsage,
  TextProps,
} from 'claude-code'

import type {
  HistoryPoint,
  MonthSpend,
  PaneChoice,
  PaneChoices,
  PlanUsage,
  SpendLimit,
  UsageLimit,
  UsageSnapshot,
} from '../types'

const snapshot = atom({ plugin: 'usage-widget', key: 'snapshot' } as const, null)
const plan = atom({ plugin: 'usage-widget', key: 'plan' } as const, null)
const history = atom({ plugin: 'usage-widget', key: 'history' } as const, [])
const isPaneOpen = atom({ plugin: 'usage-widget', key: 'isPaneOpen' } as const, false)
const monthSpend = atom({ plugin: 'usage-widget', key: 'monthSpend' } as const, null)
const choices = atom({ plugin: 'usage-widget', key: 'choices' } as const, {})
const settingError = atom({ plugin: 'usage-widget', key: 'settingError' } as const, null)

const STORE_PANE = 'isPaneOpen'
// The card last read, kept across sessions under `plan:<account>` (accountOf): a session the app
// starts afresh (coming back to a chat, a new one) shows its account's limits from its first draw,
// held, until it reads its own. Earlier builds kept one under `plan` for every account.
const STORE_PLAN = 'plan'
// What each conversation has cost in each UTC month, under `spend:<month>:<account>:<startedAt>`
// as a SpendRecord: one key a conversation, which only it writes, so chats running side by side
// never overwrite each other, and a work profile's never count toward a personal one's month.
// `startedAt` holds across a resume, whose cost carries on from the run before, and starts over on
// /clear, whose cost does too; a session id would count a resumed chat twice.
const SPEND = 'spend:'

/**
 * One conversation's month: its running cost (from its first launch) where the month's count
 * began, and where it was last read. The month's share is the difference.
 */
type SpendRecord = { from: number; to: number }
// When the widget first counted spend: a month that began before it is counted from there.
const STORE_SPEND_SINCE = 'spendSince'
// The Customize section's choices (PaneChoices), shared by every chat.
const STORE_CHOICES = 'choices'
const REFRESH_MS = 60_000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// The pane the band's button and `/usage-pane` open. Claude Code's own `/usage` is a built-in,
// and a built-in's name is refused.
const PANE = 'usage'
const PANE_TITLE = 'Usage'
const COMMAND = 'usage-pane'

// Which plan limits each choice of `strip` shows; `All` shows every one the account reports.
// The manifest's `strip` options list the same choices, in this order.
const STRIP_GROUPS: Record<string, readonly Group[]> = {
  '5-hour and weekly': ['five', 'weekly'],
  '5-hour and monthly': ['five', 'monthly'],
  'Weekly and monthly': ['weekly', 'monthly'],
  '5-hour only': ['five'],
  'Weekly only': ['weekly'],
  'Monthly only': ['monthly'],
}
const STRIP_CHOICES = ['All', ...Object.keys(STRIP_GROUPS)]

type Group = 'five' | 'weekly' | 'monthly' | 'other'

// What the strip shows: the options `register` receives, as the manifest's `userConfig` declares
// them (from /config, or the install screen), each overridden by the Usage pane's choice for it.
// The pane keeps its choices in the store rather than writing the options: a session the desktop
// app hosts has no /config rows for a plugin, so `$.config.set` has nothing to write there.
type Prefs = {
  strip: string
  showContext: boolean
  showCost: boolean
  /** In US dollars; 0 for none. */
  monthlyBudget: number
}

// The trend line keeps this many readings: enough for a long chat, little enough to redraw.
const HISTORY_MAX = 60

// Under this share of a window gone, a projection is mostly noise: the tick shows, the pace doesn't.
const MIN_PACE_ELAPSED = 10

// The usage card the desktop app's settings draw, read through the engine's own MCP connection.
// In the app it is the one reliable source of the account's plan limits: `$.session.usage()`
// answers an empty `rateLimits` there on a personal plan and a work seat alike, while the card
// carries a personal plan's 5-hour and weekly `windows` and a work seat's monthly `extraUsage`.
const CARD_SERVER = 'ccd_session_mgmt'
const CARD_TOOL = 'get_usage'
// The card moves with the month, not the minute: a long turn's tools read it at most this often.
const CARD_MS = 600_000
// Each prompt and each turn's end read it at most this often, so a switch of account shows by
// the next prompt.
const PROMPT_CARD_MS = 60_000

// The app approves the card's server itself, outside Claude Code's permission rules, and no
// setting makes that approval stick. Only in these modes does it answer without asking: in Auto it
// approves a read-only call on its own, and Bypass asks nothing. In every other mode (Plan,
// Default, Accept Edits) it would put an approval in front of the person on each read.
const UNASKED_MODES: ReadonlySet<string> = new Set(['auto', 'bypassPermissions'])

// The mode the main thread last named. The engine names it on its classic events; until one has
// (a fresh start, a reload) it is unknown and the card waits, since an unknown mode may ask.
// A mode switched while the session sits idle names itself to no event, so the card is read only
// as an event names the mode, never on a timer that would read it on the mode before.
let permissionMode: string | undefined

// When the card was last asked for, and whether an ask is still out, so events never stack a
// second ask on one the app has not answered.
let cardAskedAt: number | undefined
let isAskingCard = false

// The figures last drawn, so a redraw is asked for only when they move.
let shown: string | undefined

// The session's account (accountOf), read once: the environment it comes from never changes.
let accountTag: string | undefined

// Each meter keeps one hue, drawn only in its bar: mid-tones that read on the app's light and
// dark themes alike, since an Svg is drawn as an image and cannot follow the theme. Amber and red
// take the whole bar over as it nears its limit; the figures beside it use the theme's own
// warning and error colors.
const HUE = {
  context: '#378ADD',
  purple: '#7F77DD',
  teal: '#1D9E75',
  pink: '#D4537E',
  green: '#639922',
  warning: '#EF9F27',
  danger: '#E24B4A',
  neutral: '#888780',
}

// Known rate-limit windows. Personal plans report five_hour + seven_day (and per-model weekly
// windows); Team / Enterprise seats report a spend_limit. Anything else is titled from its kind.
// `span` is the window's length, for the pace tick; a monthly cap's is the month's own.
const WINDOWS: Record<string, { title: string; short: string; rank: number; color: string; span?: number }> = {
  five_hour: { title: '5-hour limit', short: '5-hour', rank: 0, color: HUE.purple, span: 5 * HOUR },
  seven_day: { title: 'Weekly limit', short: 'Weekly', rank: 1, color: HUE.teal, span: 7 * DAY },
  seven_day_opus: { title: 'Weekly limit · Opus', short: 'Opus', rank: 2, color: HUE.teal, span: 7 * DAY },
  seven_day_sonnet: { title: 'Weekly limit · Sonnet', short: 'Sonnet', rank: 3, color: HUE.teal, span: 7 * DAY },
  spend_limit: { title: 'Monthly limit', short: 'Monthly', rank: 4, color: HUE.pink },
}

const TOGGLE_OPEN = 'Details'
const TOGGLE_CLOSE = 'Hide details'

// Where a monthly meter was chosen and the account reports no monthly figure of its own.
const MONTHLY_MISSING = 'Monthly: set a budget in Details'

// The desktop's footnote type is narrower than a cell: about this many cells a letter.
const CELLS_PER_CHAR = 0.9

// Between meters, and between the meters and the button.
const GAP_CELLS = 2

// A bar's thickness in the band and in the pane, and how far its pace tick stands proud of it.
const BAND_BAR = 4
const PANE_BAR = 6
const TICK_PROUD = 3

// The trend line's height, and the width its markup is drawn at: wider than any pane, so the
// desktop always narrows it to the pane's width, never centers it in a gap.
const SPARK_HEIGHT = 36
const SPARK_WIDTH = 4000

type Meter = {
  key: string
  /** The band's name for it: `5-hour`, `Weekly`, `Context`. */
  short: string
  /** The pane's and the tooltip's: `5-hour limit`. */
  title: string
  /** 0–100 (or past 100 on an exceeded spend limit); absent for meters with no bar. */
  percent?: number
  value: string
  /** What the value is out of, drawn beside it: `of $150`. */
  of?: string
  /** The band's hint after the figures: `2h left`, `limit in ~36m`, `84k`. */
  hint?: string
  /** The pace reaches the limit before the window resets. */
  isUrgent?: boolean
  /** How far through its window the meter is, 0–100: where the pace tick stands. */
  elapsed?: number
  /** `Resets 6:40 PM · in 2h` */
  resets?: string
  /** `~70% by reset`, `Limit in ~36m` */
  pace?: string
  /** The bar's hue while the meter is calm. */
  color: string
  /** Where the figure came from: the app's card is held back in some modes, the engine's never. */
  source: 'engine' | 'card'
  /** One sentence for the bar's tooltip and for a reader that cannot see it. */
  detail: string
  /** A line the pane draws under the meter: where an estimated figure comes from. */
  note?: string
}

export const register: Register = (on, options) => {
  const fromOptions = prefsOf(options)

  on('session.start', async ($, e, next) => {
    accountTag = undefined
    // Keeps the reset countdowns current between measurements; the read itself is free,
    // and a missed one just leaves the last figures up until the next. A choice made in another
    // chat's pane reaches this one on the same beat.
    $.clock.every(REFRESH_MS, () => {
      void refresh($).catch(() => undefined)
      void restoreChoices($, fromOptions).catch(() => undefined)
    })
    await restoreChoices($, fromOptions).catch(() => undefined)
    await restorePlan($).catch(() => undefined)
    await refresh($)
    // The band draws without either: a command or a pane that will not come up costs only itself.
    await Promise.all([
      $.command.register({ name: COMMAND, description: 'Show plan limits, context and cost in a pane', immediate: true }),
      restorePane($),
    ]).catch(() => undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await save($, e)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isOpen = await openPane($).then(
      () => true,
      () => false,
    )

    return { text: isOpen ? 'Usage pane opened.' : "Couldn't open the usage pane." }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)

    // An unload is the engine's, not the person's: the pane comes back with the next session.
    // Either way the close itself has gone through; a note that fails to keep costs nothing more.
    if (e.id === PANE) {
      await notePaneClosed($, e.origin.kind !== 'unload').catch(() => undefined)
    }

    return closed
  })

  // A session's start, each prompt, each tool a turn runs and the turn's end name its permission
  // mode: entering plan mode is seen by the prompt that starts planning, leaving it by the next.
  // These are the only reads of the card, each on the mode its event has just named.
  on('classic.SessionStart', async ($, e, next) => {
    noteMode($, e)

    // A cleared chat starts its trend over; a compacted one keeps it, its drop being part of it.
    if (e.source === 'clear') {
      await update($, history, () => []).catch(() => undefined)
    }

    return next(e)
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    noteMode($, e, PROMPT_CARD_MS)

    return next(e)
  })

  on('classic.PostToolUse', ($, e, next) => {
    noteMode($, e, CARD_MS)

    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    noteMode($, e, PROMPT_CARD_MS)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const usage = await read($, snapshot)

    if (e.props.hasSurvey || usage === null) {
      return next(e)
    }

    const account = await read($, plan)
    const paneOpen = await read($, isPaneOpen)
    const spend = await read($, monthSpend)
    const prefs = prefsWith(fromOptions, await read($, choices))
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The desktop draws each bar as a small vector strip, so it can be thin and carry a tick;
    // the terminal has no Svg (its table's entry draws an empty fragment) and draws cells.
    const Svg = e.surface === 'terminal' || !('Svg' in elements) ? undefined : elements.Svg
    const strip = stripOf(metersOf(usage, account, isCardHeld(), budgetOf(prefs, spend)), prefs)
    const meters = strip.shown
    const barred = meters.filter(hasBar)
    const cost = meters.find(meter => meter.key === 'cost')
    const held = heldFor(meters, usage, account)
    const missing = strip.isMonthlyMissing ? MONTHLY_MISSING : undefined
    const columns = e.props.bodyColumns
    // On the desktop the button's words are a footnote Text, the size of the figures beside it,
    // not the Button's own larger type.
    const toggleLabel = paneOpen ? TOGGLE_CLOSE : TOGGLE_OPEN

    const toggle = () => void (paneOpen ? closePane($) : openPane($)).catch(() => undefined)

    if (Svg !== undefined) {
      // The meters fill the row up to what follows them, each growing from what its own line
      // needs (desktopFit), its bar drawn in percentages of whatever width that comes to. Too
      // narrow for even the plainest lines side by side, they wrap onto a row of their own rather
      // than run into each other; what follows them keeps its place at the row's end.
      const fit = desktopFit(barred, columns, { cost, held, missing, toggleLabel })

      return (
        <Box flexDirection="row" alignItems="flex-start" columnGap={GAP_CELLS} paddingX={1}>
          <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1} minWidth={0} columnGap={GAP_CELLS} rowGap="xs">
            {barred.map(meter => {
              const isHeld = held !== undefined && meter.source === 'card'
              const hasHint = fit.hasHints && meter.hint !== undefined && !isHeld
              const of = fit.hasTotals ? meter.of : undefined

              return (
                <Box key={meter.key} flexDirection="column" flexGrow={1} flexShrink={1} width={0} minWidth={lineCells(meter, of, hasHint)}>
                  <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                    <Box flexDirection="row" columnGap={1}>
                      <Text size="footnote" dimColor wrap="truncate">
                        {meter.short}
                      </Text>
                      <Text size="footnote" weight="medium" tabular {...emphasis(meter, isHeld)}>
                        {meter.value}
                      </Text>
                      {of !== undefined && (
                        <Text size="footnote" dimColor wrap="truncate">
                          {of}
                        </Text>
                      )}
                    </Box>
                    {hasHint && (
                      <Text size="footnote" tabular wrap="truncate" {...hintStyle(meter)}>
                        {meter.hint}
                      </Text>
                    )}
                  </Box>
                  <Svg source={barSvg(meter, BAND_BAR, isHeld)} alt={meter.detail} isInteractive height={stripHeight(BAND_BAR)} />
                </Box>
              )
            })}
          </Box>
          <Box flexDirection="row" flexShrink={0} columnGap={GAP_CELLS}>
            {held !== undefined && (
              <Text size="footnote" dimColor>
                {fit.isTailShort ? 'Held' : held}
              </Text>
            )}
            {missing !== undefined && !fit.isTailShort && (
              <Text size="footnote" dimColor>
                {missing}
              </Text>
            )}
            {cost !== undefined && (
              <Box flexDirection="row" columnGap={1}>
                <Text size="footnote" weight="medium" tabular>
                  {cost.value}
                </Text>
                {!fit.isTailShort && (
                  <Text size="footnote" dimColor>
                    {cost.short}
                  </Text>
                )}
              </Box>
            )}
            <Button key="toggle" plain dimColor label={toggleLabel} onPress={toggle}>
              <Text size="footnote" dimColor>
                {toggleLabel}
              </Text>
            </Button>
          </Box>
        </Box>
      )
    }

    const layout = compactLayout(meters, columns, toggleLabel, [held, missing])

    return (
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {meters.map(meter => {
            const isHeld = held !== undefined && meter.source === 'card'

            if (!hasBar(meter)) {
              return (
                <Box key={meter.key} flexDirection="row" columnGap={1}>
                  <Text weight="semibold">{meter.value}</Text>
                  <Text dimColor>{meter.short}</Text>
                </Box>
              )
            }

            return (
              <Box key={meter.key} flexDirection="row" columnGap={1}>
                <Text dimColor>{meter.short}</Text>
                {layout.barWidth > 0 && cells(Text, Box, meter, layout.barWidth, isHeld)}
                <Text weight="semibold" {...emphasis(meter, isHeld)}>
                  {meter.value}
                </Text>
                {meter.of !== undefined && <Text dimColor>{meter.of}</Text>}
                {layout.hasHints && !isHeld && meter.hint !== undefined && <Text {...hintStyle(meter)}>{meter.hint}</Text>}
              </Box>
            )
          })}
          {held !== undefined && <Text dimColor>{held}</Text>}
          {missing !== undefined && <Text dimColor>{missing}</Text>}
        </Box>
        <Button key="toggle" plain dimColor label={toggleLabel} onPress={toggle} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Svg = e.surface === 'terminal' || !('Svg' in elements) ? undefined : elements.Svg
    const usage = await read($, snapshot)

    if (usage === null) {
      return <Text dimColor>No usage read yet.</Text>
    }

    const account = await read($, plan)
    const points = await read($, history)
    const spend = await read($, monthSpend)
    const prefs = prefsWith(fromOptions, await read($, choices))
    const error = await read($, settingError)
    const meters = metersOf(usage, account, isCardHeld(), budgetOf(prefs, spend))
    const limits = meters.filter(hasBar).filter(meter => meter.key !== 'context')
    // Pickers and fields where the surface draws them; the mobile app draws neither yet.
    const Select = 'Select' in elements ? elements.Select : undefined
    const Input = 'Input' in elements ? elements.Input : undefined
    const ownMonthly = meters.find(meter => meter.key === 'spend_limit')
    // Extra usage switched off is the account's figure until a budget stands in for it; one
    // switched on (a work seat's cap) always stands, and leaves no budget to set.
    const isOwnOff = account?.spend?.isOn === false
    const isOwnOn = ownMonthly !== undefined && !isOwnOff
    const cost = meters.find(meter => meter.key === 'cost')
    const held = heldFor(meters, usage, account)
    const isCard = meters.some(meter => meter.source === 'card')
    const columns = Math.max(e.props.bodyColumns, 12)
    const { context } = usage
    const age = account === null ? undefined : ago(usage.measuredAt - account.readAt)
    const header = age === undefined ? undefined : held !== undefined ? `Held · read ${age}` : `Updated ${age}`
    const footer = !isCard
      ? undefined
      : held === undefined
        ? 'Plan limits refresh with each prompt in Auto mode.'
        : permissionMode === undefined
          ? 'These are your plan limits as last read. They refresh with your first prompt in Auto mode.'
          : 'Plan limits are held in this mode, so the app never asks you to approve a read. They refresh when you switch back to Auto.'

    // The card's server is the desktop app's; a terminal has none to read.
    const canRead = isCard && e.surface !== 'terminal'

    // Each row below with a figure at either end wraps in a narrow pane, its right end going under
    // its left, rather than the two running into each other.
    const section = (title: string) => (
      <Text size="footnote" dimColor>
        {title}
      </Text>
    )

    // A change is kept for every chat and drawn at once. One that could not be kept says so,
    // under the controls, until the next goes in.
    const choose = <K extends keyof Prefs>(field: K, value: Prefs[K]) =>
      void keepChoice($, fromOptions, field, value)
        .then(() => update($, settingError, () => null))
        .catch(() => update($, settingError, () => "Couldn't save that setting."))

    const saveBudget = (text: string) => {
      const amount = budgetFrom(text)

      if (amount === undefined) {
        void update($, settingError, () => 'Enter an amount above $0, or leave it empty for none.').catch(() => undefined)
      } else {
        choose('monthlyBudget', amount)
      }
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {header !== undefined && (
          <Text size="footnote" dimColor>
            {header}
          </Text>
        )}
        {limits.length > 0 && section('Plan limits')}
        {limits.map(meter => {
          const isHeld = held !== undefined && meter.source === 'card'

          return (
            <Box key={`pane-${meter.key}`} flexDirection="column">
              <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="flex-end" columnGap={1}>
                <Text>{meter.title}</Text>
                <Box flexDirection="row" columnGap={1}>
                  <Text size="heading" weight="semibold" tabular {...emphasis(meter, isHeld)}>
                    {meter.value}
                  </Text>
                  {meter.of !== undefined && <Text dimColor>{meter.of}</Text>}
                </Box>
              </Box>
              {Svg === undefined ? (
                cells(Text, Box, meter, columns, isHeld)
              ) : (
                <Svg source={barSvg(meter, PANE_BAR, isHeld)} alt={meter.detail} isInteractive height={stripHeight(PANE_BAR)} />
              )}
              <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={1}>
                <Text size="footnote" dimColor wrap="truncate">
                  {meter.resets ?? 'Plan limit'}
                </Text>
                {meter.pace !== undefined && !isHeld && (
                  <Text size="footnote" {...hintStyle(meter)}>
                    {meter.pace}
                  </Text>
                )}
              </Box>
              {meter.note !== undefined && (
                <Text size="footnote" dimColor wrap="wrap">
                  {meter.note}
                </Text>
              )}
            </Box>
          )
        })}
        {section('This chat')}
        <Box key="pane-context" flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="flex-end" columnGap={1}>
            <Text>Context</Text>
            <Box flexDirection="row" columnGap={1}>
              <Text size="heading" weight="semibold" tabular {...emphasis(meters[0], false)}>
                {context.tokens === undefined ? `${Math.round(context.percent ?? 0)}%` : tokens(context.tokens)}
              </Text>
              <Text dimColor>of {tokens(context.window)}</Text>
            </Box>
          </Box>
          {points.length > 1 &&
            (Svg === undefined ? (
              <Text color={HUE.context}>{sparkCells(points, columns)}</Text>
            ) : (
              <Svg source={sparkSvg(points, context.window)} alt={trendOf(points)} height={SPARK_HEIGHT} />
            ))}
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={1}>
            <Text size="footnote" dimColor>
              {context.tokens === undefined ? `${tokens(context.window)} window` : `${tokens(Math.max(context.window - context.tokens, 0))} free`}
            </Text>
            <Text size="footnote" dimColor>
              {Math.round(context.percent ?? 0)}% used
            </Text>
          </Box>
        </Box>
        {cost !== undefined && (
          <Box key="pane-cost" flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="flex-end" columnGap={1}>
              <Text>Cost</Text>
              <Text size="heading" weight="semibold" tabular>
                {cost.value}
              </Text>
            </Box>
            <Text size="footnote" dimColor>
              Estimated at API rates
            </Text>
          </Box>
        )}
        {footer !== undefined && (
          <Text size="footnote" dimColor wrap="wrap">
            {footer}
          </Text>
        )}
        {canRead && (
          <Box flexDirection="row">
            <Button key="read-now" label="Read now" onPress={() => void refreshCard($, 0, true).catch(() => undefined)} />
          </Box>
        )}
        {Select === undefined ? (
          <Text size="footnote" dimColor wrap="wrap">
            Choose what the strip shows in this pane on your computer.
          </Text>
        ) : (
          <Box key="pane-customize" flexDirection="column" rowGap={1}>
            {section('Customize')}
            <Select
              key="strip"
              label="Strip shows"
              options={stripChoicesFor(meters, prefs.strip).map(value => ({ value }))}
              value={prefs.strip}
              onSelect={value => choose('strip', value)}
            />
            <Select
              key="show-context"
              label="Context"
              options={SHOWN_CHOICES}
              value={prefs.showContext ? 'shown' : 'hidden'}
              onSelect={value => choose('showContext', value === 'shown')}
            />
            <Select
              key="show-cost"
              label="This chat's cost"
              options={SHOWN_CHOICES}
              value={prefs.showCost ? 'shown' : 'hidden'}
              onSelect={value => choose('showCost', value === 'shown')}
            />
            {isOwnOn && ownMonthly !== undefined && (
              <Text size="footnote" dimColor wrap="wrap">
                {ownMonthly.of === undefined
                  ? "Monthly budget: using your account's own monthly limit."
                  : `Monthly budget: using your account's own budget ${ownMonthly.of}.`}
              </Text>
            )}
            {!isOwnOn && Input !== undefined && (
              <Input
                key="budget"
                label="Monthly budget ($)"
                placeholder="None"
                value={prefs.monthlyBudget > 0 ? String(prefs.monthlyBudget) : ''}
                submitLabel="save"
                onSubmit={saveBudget}
              />
            )}
            {isOwnOff && (
              <Text size="footnote" dimColor wrap="wrap">
                {prefs.monthlyBudget > 0
                  ? "Your account's extra usage is off, so Monthly shows this budget, estimated from this account's Claude Code chats. Clear it to show the account's own figure."
                  : "Monthly shows your account's extra usage, which is off. A budget here shows an estimate of what this account's Claude Code chats cost instead."}
              </Text>
            )}
            {error !== null && (
              <Text size="footnote" color="error" wrap="wrap">
                {error}
              </Text>
            )}
            {prefs.strip !== 'All' && (
              <Text size="footnote" dimColor wrap="wrap">
                A limit you've hidden comes back into the strip while it needs attention.
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}

/** A pane the person left open comes back with the session; one already up (a reload) stays. */
async function restorePane($: EngineInterface) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  const wanted = (await $.store.get(STORE_PANE)) === true
  await update($, isPaneOpen, () => isUp || wanted)

  // Opened unasked, it waits undrawn on a window too narrow for it, until the person asks.
  if (wanted && !isUp) {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  await update($, isPaneOpen, () => true)
  await $.store.set(STORE_PANE, true)
}

/** A close of the mod's own reaches no hook of its own: it notes the close itself. */
async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await notePaneClosed($, true)
}

/** The pane is gone: the band's button says so, and a close the person meant is remembered. */
async function notePaneClosed($: EngineInterface, isMeant: boolean) {
  await update($, isPaneOpen, () => false)

  if (isMeant) {
    await $.store.set(STORE_PANE, false)
  }
}

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  await save($, usage)
  await tallySpend($, usage).catch(() => undefined)
}

/**
 * Records what this conversation has cost this month, then totals the month across every
 * conversation the widget ran in on this account: the figure a monthly budget is measured against.
 *
 * A conversation's cost runs on from its first launch, months included, so each month counts
 * only what it added from where the month's count began (openingCost). Months before last are
 * dropped. A conversation the widget never ran in, a claude.ai chat among them, is not counted.
 */
async function tallySpend($: EngineInterface, usage: SessionUsage) {
  const now = await $.clock.now()
  const month = monthKey(now)
  const tag = await accountOf($)
  const mine = `${SPEND}${month}:${tag}:`
  const cost = usage.cost?.usd

  if (cost !== undefined && cost > 0) {
    const own = `${mine}${usage.startedAt}`
    const kept = spendRecordOf(await $.store.get(own))
    const from = Math.min(kept?.from ?? (await openingCost($, `:${tag}:${usage.startedAt}`, usage.startedAt, month, cost)), cost)

    if (kept?.from !== from || kept.to !== cost) {
      await $.store.set(own, { from, to: cost })
    }

    if (typeof (await $.store.get(STORE_SPEND_SINCE)) !== 'number') {
      await $.store.set(STORE_SPEND_SINCE, now)
    }
  }

  const oldest = monthKey(monthStart(now) - 1)
  let usd = 0

  for (const key of await $.store.keys()) {
    if (!key.startsWith(SPEND)) {
      continue
    }

    const keyMonth = key.slice(SPEND.length, SPEND.length + 7)

    if (keyMonth < oldest) {
      await $.store.delete(key)
    } else if (key.startsWith(mine)) {
      const record = spendRecordOf(await $.store.get(key))
      usd += record === undefined ? 0 : Math.max(record.to - record.from, 0)
    }
  }

  const since = await $.store.get(STORE_SPEND_SINCE)
  const total: MonthSpend = { month, usd: Math.round(usd * 1e6) / 1e6, since: typeof since === 'number' ? since : undefined }

  // Asked for every minute in every chat: a redraw only when the month's figure moves.
  await update($, monthSpend, last =>
    last !== null && last.month === total.month && last.usd === total.usd && last.since === total.since ? last : total,
  )
}

/**
 * Where a conversation's count for `month` begins, the first time it is read in the month. One
 * begun in the month starts from nothing: all it has cost is the month's. One begun before starts
 * from where it was last read in an earlier month (its keys end in `ending`); read in none, from
 * what it costs now, since how much of that fell in this month can't be told.
 */
async function openingCost($: EngineInterface, ending: string, startedAt: number, month: string, cost: number) {
  if (monthKey(startedAt) >= month) {
    return 0
  }

  const earlier = (await $.store.keys())
    .filter(key => key.startsWith(SPEND) && key.endsWith(ending) && key.slice(SPEND.length, SPEND.length + 7) < month)
    .sort()
  const last = earlier[earlier.length - 1]
  const record = last === undefined ? undefined : spendRecordOf(await $.store.get(last))

  return record?.to ?? cost
}

/** A SpendRecord as the store holds it; anything else (an earlier build's bare amount) is none. */
function spendRecordOf(value: unknown): SpendRecord | undefined {
  if (typeof value !== 'object' || value === null || !('from' in value) || !('to' in value)) {
    return undefined
  }

  const { from, to } = value

  return typeof from === 'number' && Number.isFinite(from) && typeof to === 'number' && Number.isFinite(to) ? { from, to } : undefined
}

/** `2026-10`: the UTC month a figure belongs to, as a monthly cap resets on the first at midnight UTC. */
function monthKey(at: number) {
  return new Date(at).toISOString().slice(0, 7)
}

const SHOWN_CHOICES = [
  { value: 'shown', label: 'Shown' },
  { value: 'hidden', label: 'Hidden' },
]

/** A budget as typed: dollars, with or without a `$` or thousands commas; empty for none. */
function budgetFrom(text: string): number | undefined {
  const typed = text.trim().replace(/^\$/, '').replace(/,/g, '')

  if (typed === '') {
    return 0
  }

  const amount = Number(typed)

  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : undefined
}

/** The options as `register` received them, each checked: a value of the wrong kind is its default. */
function prefsOf(options: PluginOptions | undefined): Prefs {
  const strip = options?.strip
  const budget = options?.monthlyBudget

  return {
    strip: typeof strip === 'string' && STRIP_CHOICES.includes(strip) ? strip : 'All',
    showContext: options?.showContext !== false,
    showCost: options?.showCost !== false,
    monthlyBudget: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : 0,
  }
}

const DEFAULT_PREFS = prefsOf(undefined)

/** The options, each overridden by the pane's choice while the option holds what it was made over. */
function prefsWith(base: Prefs, chosen: PaneChoices): Prefs {
  const pick = <K extends keyof Prefs>(field: K): Prefs[K] => {
    const choice = chosen[field] as PaneChoice<Prefs[K]> | undefined

    return choice !== undefined && choice.over === base[field] ? choice.value : base[field]
  }

  return { strip: pick('strip'), showContext: pick('showContext'), showCost: pick('showCost'), monthlyBudget: pick('monthlyBudget') }
}

/** The choices as the store holds them, each checked: one of the wrong kind is left out. */
function choicesOf(stored: unknown): PaneChoices {
  const isPref = (field: keyof Prefs, value: unknown) =>
    typeof value === typeof DEFAULT_PREFS[field] && prefsOf({ [field]: value as string | number | boolean })[field] === value
  const kept: Record<string, PaneChoice<unknown>> = {}

  if (typeof stored === 'object' && stored !== null) {
    for (const [field, choice] of Object.entries(stored)) {
      if (
        field in DEFAULT_PREFS &&
        typeof choice === 'object' &&
        choice !== null &&
        isPref(field as keyof Prefs, choice.value) &&
        isPref(field as keyof Prefs, choice.over)
      ) {
        kept[field] = { value: choice.value, over: choice.over }
      }
    }
  }

  return kept as PaneChoices
}

/**
 * Brings in the pane's choices as the store keeps them, whichever chat made them. One whose option
 * has changed since (in /config, or settings) is dropped: the newer word wins.
 */
async function restoreChoices($: EngineInterface, base: Prefs) {
  const stored = await $.store.get(STORE_CHOICES)
  const current = Object.fromEntries(
    Object.entries(choicesOf(stored)).filter(([field, choice]) => choice.over === base[field as keyof Prefs]),
  ) as PaneChoices

  if (stored !== undefined && JSON.stringify(current) !== JSON.stringify(stored)) {
    await $.store.set(STORE_CHOICES, current)
  }

  await update($, choices, before => (JSON.stringify(before) === JSON.stringify(current) ? before : current))
}

/** Keeps one choice from the pane, beside what other chats kept, and draws it at once. */
async function keepChoice<K extends keyof Prefs>($: EngineInterface, base: Prefs, field: K, value: Prefs[K]) {
  const kept = { ...choicesOf(await $.store.get(STORE_CHOICES)), [field]: { value, over: base[field] } } as PaneChoices

  await $.store.set(STORE_CHOICES, kept)
  await update($, choices, () => kept)
}

function groupOf(key: string): Group {
  if (key === 'five_hour') return 'five'
  if (key.startsWith('seven_day')) return 'weekly'
  if (key === 'spend_limit' || key === 'budget') return 'monthly'

  return 'other'
}

/**
 * The strip choices this account can show: each whose limits it reports, so an account with no
 * 5-hour window (a work seat, some plans) is offered no 5-hour choice. Monthly is always on offer,
 * a budget standing in where the account has no monthly figure. Until the account reports any
 * limit, every choice is offered; the one in effect always is, so the picker can show it.
 */
function stripChoicesFor(meters: Meter[], current: string) {
  const reported = new Set(meters.filter(meter => meter.key !== 'context' && meter.key !== 'cost').map(meter => groupOf(meter.key)))

  if (reported.size === 0) {
    return STRIP_CHOICES
  }

  reported.add('monthly')

  return STRIP_CHOICES.filter(choice => choice === 'All' || choice === current || STRIP_GROUPS[choice]?.every(group => reported.has(group)))
}

/** A limit the person should see whatever they chose: near it, or on pace to reach it. */
function needsAttention(meter: Meter) {
  return (meter.percent ?? 0) >= 75 || meter.isUrgent === true
}

/**
 * What the strip shows, in order: the context, the plan limits the person chose, and this chat's
 * cost, each as the options say. A chosen kind the account does not report leaves its place to
 * the ones it does, so a work seat's monthly budget still shows under `5-hour and weekly`; a
 * hidden limit comes back while it needs attention. `isMonthlyMissing` asks for a budget where a
 * monthly meter was chosen and the account has no monthly figure of its own.
 */
function stripOf(meters: Meter[], prefs: Prefs) {
  const context = meters.filter(meter => meter.key === 'context')
  const cost = meters.filter(meter => meter.key === 'cost')
  const limits = meters.filter(meter => meter.key !== 'context' && meter.key !== 'cost')
  const wanted = STRIP_GROUPS[prefs.strip]
  const chosen = wanted === undefined ? limits : limits.filter(meter => wanted.includes(groupOf(meter.key)))
  const shown = chosen.length === 0 ? limits : limits.filter(meter => chosen.includes(meter) || needsAttention(meter))

  return {
    shown: [...(prefs.showContext ? context : []), ...shown, ...(prefs.showCost ? cost : [])],
    isMonthlyMissing: wanted?.includes('monthly') === true && !limits.some(meter => groupOf(meter.key) === 'monthly'),
  }
}

/**
 * Reads the app's usage card for the signed-in account's plan limits.
 *
 * A card that reads replaces the last one whole, so switching account swaps the meters; one
 * that will not read leaves the last figures up. A session with no such server (a terminal,
 * an app that serves no card) rejects the call, and asking again on each event costs one local
 * call: cheaper than remembering a refusal that a client attaching later would make wrong.
 *
 * Outside the modes the app answers without asking, or before any mode is known, it is not asked
 * at all: the app would put an approval in front of the person on each read, so the last figures
 * stay up until the main thread names such a mode. `atMostEveryMs` skips the ask when the last
 * one was that recent. `isForced` is the person's own Read now: it asks in any mode, and the app
 * may put its approval in front of them for that one read.
 */
async function refreshCard($: EngineInterface, atMostEveryMs = 0, isForced = false) {
  if ((!isForced && isCardHeld()) || isAskingCard) {
    return
  }

  isAskingCard = true
  let result: McpToolResult
  let now = 0

  try {
    now = await $.clock.now()

    // The mode can change while the clock answers.
    if (!isForced && (isCardHeld() || (cardAskedAt !== undefined && now - cardAskedAt < atMostEveryMs))) {
      return
    }

    cardAskedAt = now
    result = await $.mcp.call(CARD_SERVER, CARD_TOOL)
  } catch {
    return
  } finally {
    isAskingCard = false
  }

  const card = planOf(result, now)

  if (card === undefined) {
    return
  }

  await update($, plan, () => card)
  // Kept for the account's next session; one that will not keep costs only that.
  await $.store.set(`${STORE_PLAN}:${await accountOf($)}`, card).catch(() => undefined)

  // The card answers after the band's first draw, so its meters would otherwise wait for
  // whatever redraws the band next. Asked for only on a change, at most once a cycle.
  const latest = JSON.stringify(card)

  if (latest !== shown) {
    shown = latest
    $.ui.invalidate('ui.render')
  }
}

/**
 * Brings back the card the account's last session read, where this one has none yet: its figures
 * show held, with their age, until this session reads its own. A stored `null` (an account with no
 * plan limits) brings nothing back, so an older card never stands in for it. The one card earlier
 * builds kept for every account is dropped: it may be another account's.
 */
async function restorePlan($: EngineInterface) {
  await $.store.delete(STORE_PLAN).catch(() => undefined)

  if ((await read($, plan)) !== null) {
    return
  }

  const stored = storedPlanOf(await $.store.get(`${STORE_PLAN}:${await accountOf($)}`))

  if (stored !== undefined) {
    await update($, plan, () => stored)
  }
}

/**
 * The session's account as a short tag. The desktop app names the signed-in account and its
 * organization in each session's environment, so a work profile's chats and a personal one's,
 * which share this store, are told apart in any mode, before the card is read. A terminal names
 * neither, and its one login is `default`. Hashed, so the store never holds the ids themselves.
 */
async function accountOf($: EngineInterface) {
  if (accountTag === undefined) {
    const id = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID').catch(() => undefined)
    const organization = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID').catch(() => undefined)

    accountTag = id === undefined && organization === undefined ? 'default' : hashOf(`${organization ?? ''}/${id ?? ''}`)
  }

  return accountTag
}

/** FNV-1a, 32 bits, in hex: plenty to tell one person's few accounts apart. */
function hashOf(text: string) {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

/** A stored card, checked field by field: the store holds whatever an older version wrote. */
function storedPlanOf(value: unknown): PlanUsage | undefined {
  if (!isRecord(value) || !Array.isArray(value.windows) || typeof value.readAt !== 'number') {
    return undefined
  }

  const windows = value.windows.flatMap((window: unknown) =>
    isRecord(window) && typeof window.kind === 'string' && typeof window.percentUsed === 'number'
      ? [{ kind: window.kind, percentUsed: window.percentUsed, resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : undefined }]
      : [],
  )
  const spend = value.spend

  return {
    windows,
    spend:
      isRecord(spend) &&
      typeof spend.percentUsed === 'number' &&
      typeof spend.spent === 'number' &&
      typeof spend.limit === 'number' &&
      typeof spend.currency === 'string'
        ? {
            percentUsed: spend.percentUsed,
            spent: spend.spent,
            limit: spend.limit,
            currency: spend.currency,
            // Earlier builds kept a cap only while it was switched on.
            isOn: spend.isOn !== false,
          }
        : null,
    readAt: value.readAt,
  }
}

/** Whether the card must wait: the app would ask in this mode, or no event has named one yet. */
function isCardHeld() {
  return permissionMode === undefined || !UNASKED_MODES.has(permissionMode)
}

/**
 * Keeps the permission mode the main thread last named, and reads the card on it: at once where
 * it ends a mode that held the card, so the meters it held back catch up; otherwise only when the
 * last read is `atMostEveryMs` old, and never where that is left out. A subagent's events carry
 * its loop's `agent_id` and are left out: whether the app asks before it answers the card is the
 * session's mode, not a subagent's.
 */
function noteMode($: EngineInterface, e: { permission_mode?: string; agent_id?: string }, atMostEveryMs?: number) {
  if (e.agent_id !== undefined || e.permission_mode === undefined) {
    return
  }

  const wasHeld = isCardHeld()
  permissionMode = e.permission_mode

  // Entering a mode that holds the card says so on the band at once; leaving one reads the card,
  // which redraws it.
  if (!wasHeld && isCardHeld()) {
    $.ui.invalidate('ui.render')
  }

  if (wasHeld || atMostEveryMs !== undefined) {
    void refreshCard($, wasHeld ? 0 : atMostEveryMs).catch(() => undefined)
  }
}

/**
 * The card's plan limits: its windows and monthly cap when it reads, null where plan limits do
 * not apply (an API key, a gateway), undefined where it could not be read now.
 */
function planOf(result: McpToolResult, readAt: number): PlanUsage | null | undefined {
  if (result.isError) {
    return undefined
  }

  const text = result.content.find(block => block.type === 'text')?.text
  const card = text === undefined ? undefined : parse(text)
  const limits = isRecord(card) && isRecord(card.plan) ? card.plan : undefined

  if (limits?.status === 'not_applicable') {
    return null
  }

  if (limits?.status !== 'ok') {
    return undefined
  }

  return { windows: windowsOf(limits.windows), spend: spendOf(limits.extraUsage), readAt }
}

/**
 * The card's windows, keyed as the engine's `rateLimits` are; any without a figure dropped, and
 * a model's own weekly window (`Weekly · Fable`) left out: the all-models weekly is the one shown.
 */
function windowsOf(windows: unknown): UsageLimit[] {
  if (!Array.isArray(windows)) {
    return []
  }

  return windows.flatMap(window => {
    if (!isRecord(window) || typeof window.label !== 'string' || !Number.isFinite(Number(window.percentUsed))) {
      return []
    }

    const kind = kindOf(window.label)

    if (kind.startsWith('seven_day_')) {
      return []
    }

    const resetsAt = typeof window.resetsAt === 'string' ? window.resetsAt : undefined

    return [{ kind, percentUsed: Number(window.percentUsed), resetsAt }]
  })
}

/**
 * The engine's name for a card's window: `5-hour limit` is `five_hour`, `Weekly · all models`
 * is `seven_day`, and `Weekly · Fable` is `seven_day_fable`, as `seven_day_opus` is Opus's.
 */
function kindOf(label: string) {
  const name = label.trim().toLowerCase()
  const weekly = /^weekly(?:\s*·\s*(.+))?$/.exec(name)

  if (/^5[\s-]?hour/.test(name)) {
    return 'five_hour'
  }

  if (weekly !== null) {
    const model = weekly[1]

    return model === undefined || model === 'all models' ? 'seven_day' : `seven_day_${snake(model)}`
  }

  return snake(name)
}

function snake(text: string) {
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/**
 * The card's `extraUsage` as a meter's figures, switched on or off, or null where it reports none:
 * a seat with no spend limit, or a figure the card left out.
 */
function spendOf(extra: unknown): SpendLimit | null {
  if (!isRecord(extra)) {
    return null
  }

  const percentUsed = Number(extra.percentUsed)
  const spent = Number(extra.spent)
  const limit = Number(extra.monthlyLimit)

  if (![percentUsed, spent, limit].every(Number.isFinite) || limit <= 0) {
    return null
  }

  return { percentUsed, spent, limit, currency: typeof extra.currency === 'string' ? extra.currency : 'USD', isOn: extra.enabled === true }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function save($: EngineInterface, usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>) {
  const value: UsageSnapshot = {
    context: {
      window: usage.context.window,
      tokens: usage.context.tokens,
      percent: usage.context.percent,
    },
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    costUsd: usage.cost?.usd,
    measuredAt: await $.clock.now(),
  }

  await update($, snapshot, () => value)

  const count = value.context.tokens

  if (count === undefined) {
    return
  }

  // The countdowns' minute refresh reads the same figures again: only a change is a new point.
  await update($, history, points => {
    const last = points[points.length - 1]

    if (last !== undefined && last.tokens === count && last.costUsd === value.costUsd) {
      return points
    }

    const point: HistoryPoint = { at: value.measuredAt, tokens: count, costUsd: value.costUsd }

    return [...points, point].slice(-HISTORY_MAX)
  })
}

/** A budget the person set, and this month's spend to measure against it. */
type Budget = { limit: number; spend: MonthSpend | null }

function budgetOf(prefs: Prefs, spend: MonthSpend | null): Budget | undefined {
  return prefs.monthlyBudget > 0 ? { limit: prefs.monthlyBudget, spend } : undefined
}

/**
 * The meters, in order. `isHeld` says the card's figures are held back: one of them whose window
 * has reset since it was read says nothing true any more, and shows no figure. Monthly is the
 * account's own figure where it reports one; `budget` stands in for it where the account reports
 * none, or reports extra usage switched off. One switched on is always the truer, and stands.
 */
function metersOf(usage: UsageSnapshot, account: PlanUsage | null, isHeld = false, budget?: Budget): Meter[] {
  const reportedSpend = account?.spend ?? null
  const spend = reportedSpend !== null && (reportedSpend.isOn || budget === undefined) ? reportedSpend : null
  const { context, measuredAt: now } = usage
  const percent = context.percent === undefined ? '—' : `${Math.round(context.percent)}%`
  const meters: Meter[] = [
    {
      key: 'context',
      short: 'Context',
      title: 'Context window',
      percent: context.percent ?? 0,
      value: percent,
      hint: context.tokens === undefined ? undefined : tokens(context.tokens),
      color: HUE.context,
      source: 'engine',
      detail:
        context.tokens === undefined
          ? `Context window: ${tokens(context.window)} available. This chat only.`
          : `Context window: ${tokens(context.tokens)} of ${tokens(context.window)} tokens (${percent}). This chat only.`,
    },
  ]

  // The engine's reading of a window is the latest response's; the card fills in any it lacks.
  const reported = new Set(usage.limits.map(limit => limit.kind))
  const limits = [
    ...usage.limits.map(limit => ({ limit, source: 'engine' as const })),
    ...(account?.windows ?? []).filter(window => !reported.has(window.kind)).map(limit => ({ limit, source: 'card' as const })),
  ]
    // The card's money says everything a reported `spend_limit` percentage does; never both.
    .filter(({ limit }) => spend === null || limit.kind !== 'spend_limit')
    .sort((a, b) => windowOf(a.limit.kind).rank - windowOf(b.limit.kind).rank)

  for (const { limit, source } of limits) {
    const { title, short, color, span } = windowOf(limit.kind)
    const resetAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
    const left = resetAt - now

    if (source === 'card' && isHeld && resetAt <= now) {
      meters.push(lapsed(limit.kind, short, title, color))
      continue
    }
    const value = `${Math.round(limit.percentUsed)}%`
    const pace = Number.isFinite(left)
      ? paceOf(limit.percentUsed, left, limit.kind === 'spend_limit' ? monthEnd(now) - monthStart(now) : span)
      : undefined
    const resets = !Number.isFinite(left) ? undefined : left > 0 ? `Resets ${clockTime(resetAt, now)} · in ${countdown(left)}` : 'Resetting now'
    const ahead = pace?.projected === undefined ? undefined : `~${Math.round(Math.min(pace.projected, 999))}% by reset`

    meters.push({
      key: limit.kind,
      short,
      title,
      percent: limit.percentUsed,
      value,
      ...timing(left, pace, ahead),
      resets,
      color,
      source,
      detail: [`${title}: ${value} used.`, resets === undefined ? undefined : `${resets}.`, paceText(pace, ahead)].filter(Boolean).join(' '),
    })
  }

  // What the month has cost against the seat's cap: a work account's only usage limit, and
  // the one its settings page shows. Reported in money, so the figure reads as the card's.
  // A personal plan's extra usage switched off still reports its cap: the account's own figure,
  // shown as it stands, with no pace, since nothing spends against it.
  if (spend !== null && account !== null && isHeld && monthEnd(account.readAt) <= now) {
    meters.push({ ...lapsed('spend_limit', 'Monthly', 'Monthly spend', HUE.pink), of: `of ${money(spend.limit, spend.currency)}` })
  } else if (spend !== null && !spend.isOn) {
    const value = money(spend.spent, spend.currency)
    const of = `of ${money(spend.limit, spend.currency)}`

    meters.push({
      key: 'spend_limit',
      short: 'Monthly',
      title: 'Monthly spend',
      percent: spend.percentUsed,
      value,
      of,
      hint: 'off',
      pace: 'Extra usage is off',
      color: HUE.pink,
      source: 'card',
      detail: `Monthly spend: ${value} ${of}. Extra usage is switched off, so nothing is spent past your plan's limits.`,
    })
  } else if (spend !== null) {
    const end = monthEnd(now)
    const left = end - now
    const pace = paceOf(spend.percentUsed, left, end - monthStart(now))
    const resets = `Resets ${clockTime(end, now)} · in ${countdown(left)}`
    const value = money(spend.spent, spend.currency)
    const of = `of ${money(spend.limit, spend.currency)}`
    const ahead = pace?.projected === undefined ? undefined : `~${money(Math.round(spend.spent / (pace.elapsed / 100)), spend.currency)} by reset`

    meters.push({
      key: 'spend_limit',
      short: 'Monthly',
      title: 'Monthly spend',
      percent: spend.percentUsed,
      value,
      of,
      ...timing(left, pace, ahead),
      ...overBudget(spend.percentUsed),
      resets,
      color: HUE.pink,
      source: 'card',
      detail: [`Monthly spend: ${value} ${of}.`, `${resets}.`, paceText(pace, ahead)].filter(Boolean).join(' '),
    })
  }

  // A budget the person set, measured against what this account's chats cost this month: only
  // where the account has no monthly figure of its own switched on, which is always the truer one.
  const hasMonthly = meters.some(meter => groupOf(meter.key) === 'monthly')

  if (!hasMonthly && budget !== undefined && budget.limit > 0) {
    const month = monthKey(now)
    const spent = budget.spend?.month === month ? budget.spend.usd : 0
    const since = budget.spend?.since
    const percent = (spent / budget.limit) * 100
    const end = monthEnd(now)
    const left = end - now
    const pace = paceOf(percent, left, end - monthStart(now))
    const resets = `Resets ${clockTime(end, now)} · in ${countdown(left)}`
    const value = money(spent, 'USD')
    const of = `of ${money(budget.limit, 'USD')}`
    const ahead = pace?.projected === undefined ? undefined : `~${money(Math.round(spent / (pace.elapsed / 100)), 'USD')} by reset`
    const counted = since !== undefined && since > monthStart(now) ? ` since ${dayOf(since)}` : ' this month'

    meters.push({
      key: 'budget',
      short: 'Monthly',
      title: 'Monthly budget (estimate)',
      percent,
      value,
      of,
      ...timing(left, pace, ahead),
      ...overBudget(percent),
      resets,
      color: HUE.pink,
      source: 'engine',
      note: `Estimated at API rates across this account's Claude Code chats${counted}. Not what you're billed.`,
      detail: [`Monthly budget: ${value} ${of}, estimated at API rates across this account's Claude Code chats${counted}.`, `${resets}.`, paceText(pace, ahead)]
        .filter(Boolean)
        .join(' '),
    })
  }

  // What this chat itself has cost, beside the account's own figures.
  if (usage.costUsd !== undefined) {
    meters.push({
      key: 'cost',
      short: 'this chat',
      title: 'This chat',
      value: `$${usage.costUsd.toFixed(2)}`,
      color: HUE.neutral,
      source: 'engine',
      detail: `This chat has cost $${usage.costUsd.toFixed(2)} so far, estimated at API rates.`,
    })
  }

  return meters
}

/** A monthly figure past its budget says so, in place of the time left or the pace. */
function overBudget(percent: number): Pick<Meter, 'hint' | 'isUrgent' | 'pace'> {
  return percent >= 100 ? { hint: 'over budget', isUrgent: true, pace: 'Over budget' } : {}
}

/** `Oct 12`, as the person's calendar reads it. */
function dayOf(at: number) {
  const date = new Date(at)

  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** A held window that has reset since it was read: named, with no figure and an empty bar. */
function lapsed(key: string, short: string, title: string, color: string): Meter & { percent: number } {
  return {
    key,
    short,
    title,
    percent: 0,
    value: '—',
    resets: 'Reset since it was read',
    color,
    source: 'card',
    detail: `${title}: reset since it was last read.`,
  }
}

/** A limit's band hint and pace line: the time left, or the time to the limit where the pace reaches it first. */
function timing(left: number, pace: Pace | undefined, ahead: string | undefined): Pick<Meter, 'hint' | 'isUrgent' | 'elapsed' | 'pace'> {
  if (!Number.isFinite(left)) {
    return {}
  }

  if (left <= 0) {
    return { hint: 'resetting' }
  }

  if (pace?.hitIn !== undefined) {
    return { hint: `limit in ~${countdown(pace.hitIn)}`, isUrgent: true, elapsed: pace.elapsed, pace: `Limit in ~${countdown(pace.hitIn)}` }
  }

  return { hint: `${countdown(left)} left`, elapsed: pace?.elapsed, pace: ahead }
}

function paceText(pace: Pace | undefined, ahead: string | undefined) {
  if (pace?.hitIn !== undefined) return `At this pace you reach the limit in ~${countdown(pace.hitIn)}.`
  if (ahead !== undefined) return `On pace for ${ahead}.`

  return undefined
}

type Pace = {
  /** How much of the window has gone, 0–100. */
  elapsed: number
  /** Where the figure ends the window at its pace so far, in percent; absent early in a window. */
  projected?: number
  /** How long until the figure reaches 100% at that pace, where that comes before the reset. */
  hitIn?: number
}

/**
 * How a window is going: how much of it has passed, where its figure ends at the pace so far,
 * and, where that is past the limit, how soon it gets there. Nothing for a window of no known
 * length, or one whose reset says it is longer than that.
 */
function paceOf(percent: number, left: number, span: number | undefined): Pace | undefined {
  if (span === undefined || left <= 0 || left > span) {
    return undefined
  }

  const passed = span - left
  const elapsed = (passed / span) * 100

  if (elapsed < MIN_PACE_ELAPSED || percent <= 0) {
    return { elapsed }
  }

  const projected = (percent * 100) / elapsed

  // At the pace so far the figure passes 100 before the reset exactly when its projection does.
  if (percent >= 100 || projected <= 100) {
    return { elapsed, projected }
  }

  return { elapsed, projected, hitIn: ((100 - percent) / percent) * passed }
}

/**
 * The band's held note, `Held · 14m`, where the card's figures are on screen and its mode holds
 * them back; undefined otherwise. The engine's own readings are never held.
 */
function heldFor(meters: Meter[], usage: UsageSnapshot, account: PlanUsage | null) {
  if (account === null || !isCardHeld() || !meters.some(meter => meter.source === 'card')) {
    return undefined
  }

  const age = usage.measuredAt - account.readAt

  return age < MINUTE ? 'Held' : `Held · ${countdown(age - (age % MINUTE))}`
}

/**
 * Fits the one-line row to the band: bars shrink, then the hints drop, then the bars. `notes` are
 * the plain lines drawn after the meters (`Held · 14m`, a missing budget), each taking its room.
 */
function compactLayout(meters: Meter[], columns: number, toggleLabel: string, notes: (string | undefined)[]) {
  const toggle = toggleLabel.length + 2
  const chrome =
    2 + toggle + 3 * (meters.length - 1) + notes.reduce((sum, note) => sum + (note === undefined ? 0 : note.length + 3), 0)
  const barred = meters.filter(hasBar).length

  for (const hasHints of [true, false]) {
    const text = meters.reduce(
      (sum, meter) =>
        sum +
        meter.short.length +
        1 +
        meter.value.length +
        (meter.of === undefined ? 0 : meter.of.length + 1) +
        (hasHints && meter.hint ? meter.hint.length + 1 : 0),
      0,
    )
    const room = columns - chrome - text - barred
    const barWidth = Math.min(Math.floor(room / Math.max(barred, 1)), 12)

    if (barWidth >= 4) {
      return { barWidth, hasHints }
    }
  }

  return { barWidth: 0, hasHints: false }
}

/** About how many cells a desktop footnote of `text` takes. */
function textCells(text: string) {
  return Math.ceil(text.length * CELLS_PER_CHAR)
}

/** The cells a meter's line needs on the desktop: its name, figure, total and hint as shown, and the gaps between. */
function lineCells(meter: Meter, of: string | undefined, hasHint: boolean) {
  return textCells([meter.short, meter.value, of, hasHint ? meter.hint : undefined].filter(Boolean).join(' ')) + 2
}

/** What the desktop band draws after its meters. */
type Tail = { cost: Meter | undefined; held: string | undefined; missing: string | undefined; toggleLabel: string }

/**
 * Fits the desktop band's row to its width, as the terminal's does: the hints drop first, then
 * what follows the meters shortens (`Held` for `Held · 14m`, the chat's cost without its name,
 * no budget prompt, which the pane has), then the totals (`of $150`) drop. Past that the meters
 * keep their plainest lines and wrap, which the row's minimum widths make them do.
 */
function desktopFit(meters: Meter[], columns: number, tail: Tail) {
  const tailCells = (isShort: boolean) =>
    [
      tail.held === undefined ? undefined : isShort ? 'Held' : tail.held,
      isShort ? undefined : tail.missing,
      tail.cost === undefined ? undefined : isShort ? tail.cost.value : `${tail.cost.value} ${tail.cost.short}`,
      tail.toggleLabel,
    ].reduce((sum, text) => (text === undefined ? sum : sum + textCells(text) + GAP_CELLS), 0)
  const plainest = { hasHints: false, isTailShort: true, hasTotals: false }
  const tiers = [
    { hasHints: true, isTailShort: false, hasTotals: true },
    { hasHints: false, isTailShort: false, hasTotals: true },
    { hasHints: false, isTailShort: true, hasTotals: true },
    plainest,
  ]
  const fits = (tier: (typeof tiers)[number]) =>
    meters.reduce((sum, meter) => sum + lineCells(meter, tier.hasTotals ? meter.of : undefined, tier.hasHints) + GAP_CELLS, 2) +
      tailCells(tier.isTailShort) <=
    columns

  return tiers.find(fits) ?? plainest
}

/**
 * A capsule in block cells, filled in the meter's color, with the pace tick standing where the
 * window has got to.
 */
function cells(
  Text: ElementConstructor<TextProps>,
  Box: ElementConstructor<BoxProps>,
  meter: Meter & { percent: number },
  width: number,
  isHeld: boolean,
) {
  const share = Math.min(Math.max(meter.percent, 0), 100) / 100
  // Like an iOS progress view: any use at all shows at least a sliver of fill.
  const filled = meter.percent > 0 ? Math.max(1, Math.round(share * width)) : 0
  const tick = meter.elapsed === undefined ? -1 : Math.min(width - 1, Math.floor((meter.elapsed / 100) * width))
  const runs: { kind: 'fill' | 'track' | 'tick'; count: number }[] = []

  for (let at = 0; at < width; at += 1) {
    const kind = at === tick ? 'tick' : at < filled ? 'fill' : 'track'
    const last = runs[runs.length - 1]

    if (last?.kind === kind) {
      last.count += 1
    } else {
      runs.push({ kind, count: 1 })
    }
  }

  const color = barColor(meter, isHeld)

  return (
    <Box flexDirection="row" overflow="hidden">
      {runs.map(run =>
        run.kind === 'fill' ? (
          <Text color={color}>{'█'.repeat(run.count)}</Text>
        ) : run.kind === 'track' ? (
          <Text dimColor>{'█'.repeat(run.count)}</Text>
        ) : (
          <Text>{'┃'}</Text>
        ),
      )}
    </Box>
  )
}

/**
 * A meter's bar for the desktop: a translucent track, a fill in the meter's hue with round ends,
 * and the pace tick standing a little proud of it, all under one tooltip. No text: the figures
 * beside it are the theme's own Text.
 *
 * Laid out in percentages of the strip's width, with no viewBox: the desktop never stretches a
 * drawing to its frame, it centers it, so a bar drawn at a guessed width stopped short of its
 * label at each end. In percentages it runs the frame's whole width, whatever that turns out to be.
 */
function barSvg(meter: Meter & { percent: number }, thickness: number, isHeld: boolean) {
  const height = stripHeight(thickness)
  const share = Math.min(Math.max(meter.percent, 0), 100)
  const shape = (width: string, paint: string) =>
    `<rect x="0" y="${TICK_PROUD}" width="${width}" height="${thickness}" rx="${thickness / 2}" ${paint}/>`
  // Kept a pixel in from either end, so the tick is never half cut off.
  const tick = meter.elapsed === undefined ? undefined : Math.min(Math.max(meter.elapsed, 1), 99)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">`,
    `<g><title>${xml(meter.detail)}</title>`,
    // Catches the pointer over the whole strip, not only where it is painted.
    `<rect width="100%" height="${height}" fill="#000" fill-opacity="0"/>`,
    shape('100%', `fill="${HUE.neutral}" fill-opacity="0.28"`),
    // Any use at all shows as at least a round dot, never a sliver: a dot beneath the share's own
    // fill, the two faded together where held, so they never darken where they overlap.
    meter.percent > 0
      ? `<g fill="${barColor(meter, isHeld)}"${isHeld ? ' opacity="0.55"' : ''}>${shape(String(thickness), '')}${shape(`${round(share)}%`, '')}</g>`
      : '',
    tick === undefined
      ? ''
      : `<rect x="${round(tick)}%" y="0" width="2" height="${height}" rx="1" transform="translate(-1 0)" fill="${HUE.neutral}"/>`,
    '</g>',
    '</svg>',
  ].join('')
}

/**
 * A bar strip's height in CSS pixels. The desktop draws an interactive Svg in a frame of its own,
 * which takes a frame's default height (about 150px) unless told otherwise, the bar floating in
 * the middle of it: each bar names its height, so the band stays one line of text and a strip.
 */
function stripHeight(thickness: number) {
  return thickness + TICK_PROUD * 2
}

/**
 * The pane's trend line: the context window's readings this chat, as a filled line against the
 * whole window, so it reads as how full the window has been. Drawn wide and stretched to the
 * pane (the line's own stroke kept from stretching), so it spans the pane whatever its width.
 */
function sparkSvg(points: HistoryPoint[], window: number) {
  const width = SPARK_WIDTH
  const height = SPARK_HEIGHT
  const step = width / Math.max(points.length - 1, 1)
  const at = points.map(
    (point, index) => `${round(index * step)},${round(height - 1 - (Math.min(point.tokens, window) / Math.max(window, 1)) * (height - 2))}`,
  )

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`,
    `<path d="M0,${height} L${at.join(' L')} L${width},${height} Z" fill="${HUE.context}" fill-opacity="0.18"/>`,
    `<polyline fill="none" stroke="${HUE.context}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${at.join(' ')}"/>`,
    '</svg>',
  ].join('')
}

/** The terminal's trend line: one eighth-block per reading, the latest at the right. */
function sparkCells(points: HistoryPoint[], width: number) {
  const steps = '▁▂▃▄▅▆▇█'
  const shown = points.slice(-width)
  const top = Math.max(...shown.map(point => point.tokens), 1)

  return shown.map(point => steps[Math.min(steps.length - 1, Math.floor((point.tokens / top) * (steps.length - 1)))]).join('')
}

/** What the trend line says, for a reader that cannot see it. */
function trendOf(points: HistoryPoint[]) {
  const first = points[0]?.tokens ?? 0
  const last = points[points.length - 1]?.tokens ?? 0

  return `Context went from ${tokens(first)} to ${tokens(last)} tokens over ${points.length} readings.`
}

function hasBar(meter: Meter): meter is Meter & { percent: number } {
  return meter.percent !== undefined
}

function windowOf(kind: string) {
  return WINDOWS[kind] ?? { title: titleCase(kind), short: titleCase(kind), rank: 99, color: HUE.green }
}

function titleCase(kind: string) {
  const words = kind.split('_').join(' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The bar's fill: the meter's hue, amber from 75%, red from 90%; grey while held. */
function barColor(meter: Meter, isHeld: boolean) {
  if (isHeld) return HUE.neutral
  if (meter.percent === undefined || meter.percent < 75) return meter.color

  return meter.percent >= 90 ? HUE.danger : HUE.warning
}

/** A figure keeps the theme's text color until it needs attention; a held one is dimmed. */
function emphasis(meter: Meter | undefined, isHeld: boolean): { color?: 'warning' | 'error'; dimColor?: true } {
  if (isHeld) return { dimColor: true }

  const percent = meter?.percent

  if (percent === undefined || percent < 75) return {}

  return { color: percent >= 90 ? 'error' : 'warning' }
}

/** A hint warns in the theme's warning color where the pace reaches the limit first; otherwise it is dim. */
function hintStyle(meter: Meter): { color?: 'warning'; dimColor?: true } {
  return meter.isUrgent === true ? { color: 'warning' } : { dimColor: true }
}

function xml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

/** `$46.50`, and `$150` where the figure is whole; a currency other than USD is named. */
function money(amount: number, currency: string) {
  const figure = amount.toFixed(2).replace(/\.00$/, '')

  return currency === 'USD' ? `$${figure}` : `${figure} ${currency}`
}

function tokens(count: number) {
  if (count >= 1_000_000) return `${short(count / 1_000_000)}M`
  if (count >= 1_000) return `${short(count / 1_000)}k`

  return String(count)
}

function short(value: number) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}

/**
 * When a monthly spend cap resets: the first of next month at midnight UTC, as the usage settings
 * page shows it (the evening of the 31st across the Americas). The card reports no reset time for the cap itself.
 */
function monthEnd(now: number) {
  const date = new Date(now)

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

/** When the month whose cap `monthEnd` resets began, for the pace tick. */
function monthStart(now: number) {
  const date = new Date(now)

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A reset as the person's clock reads it: `6:40 PM` today, `Tue 9:00 AM` this week, `Oct 31, 5:00 PM` after. */
function clockTime(at: number, now: number) {
  const date = new Date(at)
  const hours = date.getHours()
  const time = `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`

  if (date.toDateString() === new Date(now).toDateString()) return time
  if (at - now < 6 * DAY) return `${WEEKDAYS[date.getDay()]} ${time}`

  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`
}

/** How long ago something was read: `just now`, `2m ago`. */
function ago(ms: number) {
  return ms < MINUTE ? 'just now' : `${countdown(ms - (ms % MINUTE))} ago`
}

function countdown(ms: number) {
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const rest = minutes % 60

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`

  return `${rest}m`
}
