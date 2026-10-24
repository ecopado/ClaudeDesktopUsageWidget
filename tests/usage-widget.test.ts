import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const SURFACES = ['terminal', 'desktop'] as const

const fromNow = (ms: number) => new Date(NOW + ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const CONTEXT = { tokens: 84_000, window: 200_000, percent: 42 }

// The bars' hues, as the widget draws them on both surfaces.
const HUE = { context: '#378ADD', purple: '#7F77DD', teal: '#1D9E75', pink: '#D4537E', warning: '#EF9F27', danger: '#E24B4A', neutral: '#888780' }

/** The app's usage card as a work seat reports it: no rate-limit window, a monthly cap. */
const WORK_CARD = {
  plan: {
    status: 'ok',
    plan: 'Team',
    windows: [],
    extraUsage: { enabled: true, percentUsed: 31, spent: '46.50', monthlyLimit: '150.00', currency: 'USD' },
  },
  context: { session: 'self', status: 'ok' },
}

/**
 * The app's usage card as a personal plan reports it: the 5-hour, weekly and per-model
 * weekly windows, and extra usage switched off. In the app the engine's own `rateLimits`
 * come back empty for this account, so the card is the only place these windows appear.
 */
const PERSONAL_CARD = {
  plan: {
    status: 'ok',
    plan: 'Pro',
    windows: [
      { label: '5-hour limit', percentUsed: 4, resetsAt: fromNow(3 * HOUR + 40 * MINUTE), resetsIn: '3h 40m' },
      { label: 'Weekly · all models', percentUsed: 1, resetsAt: fromNow(5 * DAY + 20 * HOUR), resetsIn: '5d 20h' },
      { label: 'Weekly · Fable', percentUsed: 0, resetsAt: fromNow(5 * DAY + 20 * HOUR), resetsIn: '5d 20h' },
    ],
    extraUsage: { enabled: false, percentUsed: 0, spent: '0.00', monthlyLimit: '50.00', currency: 'USD' },
  },
  context: { session: 'self', status: 'ok' },
}

const band = (bodyColumns = 140) => ({
  plugin: 'usage-widget',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
})

const pane = (bodyColumns = 48) => ({
  plugin: 'usage-widget',
  component: 'Pane' as const,
  requestId: 'usage',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
})

/**
 * The engine's end of the widget's panes and command: what is open, kept as the engine keeps it.
 */
const withPanes = (on: On) => {
  const open = new Set<string>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    open.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    open.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: 'Usage', isShown: true, isFocused: false, isPlaced: true })),
  }))

  return open
}

// The engine's end of each noun the widget reaches: a clock and store in memory, and measurements echoed.
const setup = (on: On) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))

  return withPanes(on)
}

/** What `$.session.start` takes: the widget reads the card from its own session.start hook. */
const START = { cwd: '/', surface: 'desktop' as const, isInteractive: true }

/** No settings hook beneath: the classic events pass with nothing to add. */
const withClassic = (on: On) => {
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
}

/**
 * The engine a desktop session gives the widget: usage with `rateLimits`, and the app's
 * usage-card server answering `get_usage` with `card`.
 */
const withCard = (on: On, card: unknown, rateLimits: SessionRateLimit[] = []) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits, cost: { usd: 1.5 } } }))
  on('mcp.call', ($, e, next) =>
    e.server === 'ccd_session_mgmt' && e.tool === 'get_usage'
      ? { value: { content: [{ type: 'text', text: JSON.stringify(card) }], isError: false } }
      : next(e),
  )
  withClassic(on)
}

/** How often a long turn's tools read the card; an idle session reads it never. */
const CARD_CYCLE = 10 * 60_000

/**
 * A desktop session whose usage card counts each time it is asked for; `card` may be swapped
 * between reads.
 */
const countingCard = (on: On, card: unknown = PERSONAL_CARD) => {
  const asked = { reads: 0, card }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: [], cost: { usd: 1.5 } } }))
  on('mcp.call', ($, e, next) => {
    if (e.server !== 'ccd_session_mgmt' || e.tool !== 'get_usage') {
      return next(e)
    }

    asked.reads += 1

    return { value: { content: [{ type: 'text', text: JSON.stringify(asked.card) }], isError: false } }
  })
  withClassic(on)

  return asked
}

/** A session in Auto mode: it starts, and its first prompt names the mode, reading the card. */
const begin = async ($: Engine) => {
  await $.session.start(START)
  await $.classic.UserPromptSubmit({ prompt: 'hello', permission_mode: 'auto' })
}

type Found = { text: string; key?: unknown; props: Record<string, unknown> }

type Drawing = {
  findAll: (query: { type: string; text?: RegExp }) => Promise<Found[]>
}

/** What a drawing says, in order: each Text's words, and on the desktop each bar's description. */
const words = async (ui: Drawing) => {
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const bars = (await ui.findAll({ type: 'Svg' })).map(found => String(found.props.alt))

  return [...texts, ...bars].join(' | ')
}

/** The colors the terminal's capsules are filled in, left to right. */
const fills = async (ui: Drawing) =>
  (await ui.findAll({ type: 'Text', text: /^█+$/ }))
    .filter(found => found.props.dimColor !== true)
    .map(found => found.props.color)

/** The desktop's bar for a meter, by the start of its description. */
const bar = async (ui: Drawing, title: string) =>
  String((await ui.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith(title))?.props.source)

/** The label of the band's Details button. */
const toggleLabel = async (ui: Drawing) => (await ui.findAll({ type: 'Button' })).find(found => found.key === 'toggle')?.props.label

describe('usage widget', () => {
  test('personal plan: 5-hour and weekly windows with the time each has left', async ($, on) => {
    setup(on)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'seven_day', percentUsed: 8, resetsAt: fromNow(3 * DAY + 4 * HOUR) },
        { kind: 'five_hour', percentUsed: 23.5, resetsAt: fromNow(2 * HOUR + 14 * MINUTE) },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      for (const figure of ['Context', '42%', '84k', '5-hour', '24%', '2h 14m left', 'Weekly', '3d 4h left', '$1.50', 'this chat']) {
        expect(shown).toContain(figure)
      }
      // One name for one thing: the 5-hour window is no longer called a session.
      expect(shown).not.toContain('Session')
      expect(shown).not.toContain('Spent')
      expect(shown).not.toContain('Monthly')
      // 5-hour sorts before Weekly even though the account reported it second.
      expect(shown.indexOf('5-hour')).toBeLessThan(shown.indexOf('Weekly'))
      await ui.unmount()
    }
  })

  // What the app does for a personal plan: the engine reports no window, the card reports them all.
  test('personal plan in the app: the card’s 5-hour and weekly windows when the engine reports none', async ($, on) => {
    setup(on)
    withCard(on, PERSONAL_CARD)
    await begin($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      for (const figure of ['Context', '5-hour', '4%', '3h 40m left', 'Weekly', '1%', '5d 20h left', '$1.50', 'this chat']) {
        expect(shown).toContain(figure)
      }
      // Extra usage is switched off on this account: no monthly cap to show.
      expect(shown).not.toContain('Monthly')
      // A model's own weekly window is left out: the all-models weekly is the one shown.
      expect(shown).not.toContain('Fable')
      expect(shown.indexOf('5-hour')).toBeLessThan(shown.indexOf('Weekly'))
      await ui.unmount()
    }
  })

  // The figures are the theme's own Text, so they follow light and dark and stay one size;
  // the bar is a strip with no type in it, its description a tooltip.
  test('desktop draws figures as text and each bar as a strip with a tooltip', async ($, on) => {
    setup(on)
    withCard(on, PERSONAL_CARD)
    await begin($)

    for (const columns of [100, 220]) {
      const ui = await $.ui.mount({ ...band(columns), surface: 'desktop' })
      const bars = await ui.findAll({ type: 'Svg' })

      expect(bars.length).toBe(3)

      for (const found of bars) {
        const source = String(found.props.source)

        expect(found.props.isInteractive).toBe(true)
        // An interactive Svg is drawn in a frame that takes a frame's default height unless told
        // its own: the band's bars name theirs, a 4px bar and its tick, and stay one strip tall.
        expect(found.props.height).toBe(10)
        expect(source).toMatch(/^<svg [^>]*height="10"/)
        // The desktop centers a drawing in its frame rather than stretch it: a bar laid out in
        // percentages with no viewBox runs the frame's whole width, however wide it turns out.
        expect(source).toMatch(/^<svg [^>]*width="100%"/)
        expect(source).not.toContain('viewBox')
        expect(source).toContain(`<title>${String(found.props.alt)}</title>`)
        expect(source).not.toContain('<text')
        expect(source).not.toContain('<script')
      }

      expect(String((await ui.find({ type: 'Text', text: '4%' }))?.props.size)).toBe('footnote')
      expect(await bar(ui, '5-hour limit')).toContain('<title>5-hour limit: 4% used. Resets ')
      // No text-drawn bars on the desktop.
      expect(await words(ui)).not.toMatch(/[█┃]/)
      await ui.unmount()
    }
  })

  test('what this chat cost sits beside the meters, with no bar of its own', async ($, on) => {
    setup(on)
    withCard(on, PERSONAL_CARD)
    await begin($)

    const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
    const slots = (await ui.findAll({ type: 'Box' })).map(found => String(found.key))

    expect(slots).toContain('five_hour')
    expect(slots).not.toContain('cost')
    expect((await ui.findAll({ type: 'Svg' })).some(found => String(found.props.alt).startsWith('This chat'))).toBe(false)
    expect(await words(ui)).toContain('$1.50 | this chat')
    await ui.unmount()
  })

  // The usage settings page shows the cap resetting at the end of the month (the evening of the 31st across the Americas:
  // November 1st, midnight UTC). The card carries no reset time of its own for it. 31% spent
  // five and a half days into a 31-day month is on pace to pass the cap well before then.
  test('work plan: the monthly cap resets on the first of next month, UTC, and warns of its pace', async ($, on) => {
    setup(on)
    withCard(on, WORK_CARD)
    await begin($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      expect(shown).toContain('Monthly')
      expect(shown).toContain('$46.50')
      expect(shown).toContain('of $150')
      expect(shown).toContain('limit in ~12d 5h')
      expect((await ui.find({ type: 'Text', text: 'limit in ~12d 5h' }))?.props.color).toBe('warning')
      await ui.unmount()

      const details = await $.ui.mount({ ...pane(), surface })
      const spelled = await words(details)

      expect(spelled).toContain('Monthly spend')
      expect(spelled).toMatch(/Resets \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M · in 25d 12h/)
      expect(spelled).toContain('Limit in ~12d 5h')
      await details.unmount()
    }
  })

  test('the engine’s own reading of a window wins over the card’s, and the card fills in the rest', async ($, on) => {
    setup(on)
    withCard(on, PERSONAL_CARD, [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: fromNow(2 * HOUR) }])
    await begin($)

    const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
    const shown = await words(ui)

    expect(shown).toContain('24%')
    expect((await ui.findAll({ type: 'Text', text: /^5-hour$/ })).length).toBe(1)
    expect(shown).toContain('Weekly')
    expect(shown).not.toContain('Fable')
    await ui.unmount()
  })

  test('switching accounts mid-session swaps the meters on the next card read', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    const asked = countingCard(on, WORK_CARD)
    await begin($)
    await clock.advance(0)

    const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
    let shown = await words(ui)
    expect(shown).toContain('Monthly')
    expect(shown).not.toContain('5-hour')

    // Work to personal: the monthly cap leaves with the work account, the windows arrive with
    // the next read, the turn's end.
    asked.card = PERSONAL_CARD
    await clock.advance(60_000)
    await $.classic.Stop({ stop_hook_active: false, permission_mode: 'auto' })
    await clock.advance(0)
    shown = await words(ui)
    expect(shown).not.toContain('Monthly')
    expect(shown).toContain('5-hour')
    expect(shown).toContain('Weekly')

    // And back again: a prompt a minute after the last read reads the card itself.
    asked.card = WORK_CARD
    await clock.advance(60_000)
    await $.classic.UserPromptSubmit({ prompt: 'next', permission_mode: 'auto' })
    await clock.advance(0)
    shown = await words(ui)
    expect(shown).toContain('Monthly')
    expect(shown).not.toContain('5-hour')
    expect(shown).not.toContain('Weekly')
    await ui.unmount()
  })

  // In plan mode the app asks the person before it answers `get_usage`, a prompt each cycle.
  test('plan mode holds the card back, and leaving it for auto reads the card at once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await $.session.start(START)
    // No event has named the mode yet, and it may be plan: the card waits.
    expect(asked.reads).toBe(0)

    await $.classic.UserPromptSubmit({ prompt: 'plan the change', permission_mode: 'plan' })
    await clock.advance(2 * CARD_CYCLE)
    expect(asked.reads).toBe(0)

    // The plan approved: the tool that ends planning reports the mode the session moves to.
    await $.classic.PostToolUse({
      tool_name: 'ExitPlanMode',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'toolu_exit',
      permission_mode: 'auto',
    })
    await clock.advance(0)
    expect(asked.reads).toBe(1)

    // Back in Auto, the turn's end a minute on reads it as any other.
    await clock.advance(60_000)
    await $.classic.Stop({ stop_hook_active: false, permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(2)
  })

  // The app asks before every call in these modes, and no setting makes its approval stick.
  test('default and accept-edits modes never read the card; auto reads it at once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await $.session.start(START)

    for (const mode of ['default', 'acceptEdits']) {
      await $.classic.UserPromptSubmit({ prompt: 'work', permission_mode: mode })
      await clock.advance(2 * CARD_CYCLE)
      await $.classic.UserPromptSubmit({ prompt: 'more work', permission_mode: mode })
      await clock.advance(0)
    }
    expect(asked.reads).toBe(0)

    await $.classic.UserPromptSubmit({ prompt: 'switched to auto', permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(1)
  })

  // A fresh session, or one whose mod just reloaded, has seen no mode: it may be one that asks.
  test('a session that has named no mode asks for nothing, however long it sits', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await $.session.start(START)
    await clock.advance(3 * CARD_CYCLE)
    expect(asked.reads).toBe(0)

    // The first prompt in Auto mode reads it at once.
    await $.classic.UserPromptSubmit({ prompt: 'hello', permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(1)
  })

  // A mode switched in the app's picker names itself to no event: a read on a timer would go out
  // on the mode before it, and in plan mode the app would ask the person to approve it.
  test('a mode switched while the session sits idle is never read on the mode before it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await begin($)
    await clock.advance(0)
    expect(asked.reads).toBe(1)

    // Switched from Auto to Plan with no prompt since: nothing reads the card, however long it sits.
    await clock.advance(3 * CARD_CYCLE)
    expect(asked.reads).toBe(1)

    // The next prompt names plan, and the card still waits.
    await $.classic.UserPromptSubmit({ prompt: 'plan the change', permission_mode: 'plan' })
    await clock.advance(0)
    expect(asked.reads).toBe(1)
  })

  // Each read goes out as an event names the mode the session is in now.
  test('the turn’s end and a long turn’s tools read the card on the mode they name', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await begin($)
    await clock.advance(0)
    expect(asked.reads).toBe(1)

    // A twenty-minute turn: its tools read the card once a cycle, not on every call.
    for (let call = 0; call < 10; call += 1) {
      await clock.advance(2 * 60_000)
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: `toolu_long_${call}`,
        permission_mode: 'auto',
      })
      await clock.advance(0)
    }
    expect(asked.reads).toBe(3)

    // The turn's end, a minute on, reads it again: the figures the turn used show as it ends.
    await clock.advance(60_000)
    await $.classic.Stop({ stop_hook_active: false, permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(4)
  })

  // A background agent's tool calls report its own loop's mode; the app asks by the session's.
  test('a subagent’s events never read the card while the session plans', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await $.session.start(START)
    await $.classic.UserPromptSubmit({ prompt: 'plan the change', permission_mode: 'plan' })

    for (let call = 0; call < 5; call += 1) {
      await $.classic.PostToolUse({
        tool_name: 'Grep',
        tool_input: {},
        tool_response: {},
        tool_use_id: `toolu_sub_${call}`,
        permission_mode: 'auto',
        agent_id: 'agent-explore',
      })
      await clock.advance(60_000)
    }
    await clock.advance(CARD_CYCLE)
    expect(asked.reads).toBe(0)
  })

  test('prompts read the card at most once a minute', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const asked = countingCard(on)
    await begin($)
    await clock.advance(0)
    expect(asked.reads).toBe(1)

    await $.classic.UserPromptSubmit({ prompt: 'again', permission_mode: 'auto' })
    await clock.advance(30_000)
    await $.classic.UserPromptSubmit({ prompt: 'and again', permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(1)

    await clock.advance(30_000)
    await $.classic.UserPromptSubmit({ prompt: 'a minute on', permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(2)
  })

  // A work seat reports no rate-limit window at all — `$.session.usage()` answers an empty
  // `rateLimits` — so the account's only usage limit is the card's monthly spend.
  test('work plan: the monthly spend the app’s usage card reports, in money', async ($, on) => {
    setup(on)
    withCard(on, WORK_CARD)
    await begin($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      expect(shown).toContain('Monthly')
      expect(shown).toContain('$46.50')
      expect(shown).toContain('of $150')
      // Beside it: the context window and what this chat has cost.
      expect(shown).toContain('Context')
      expect(shown).toContain('this chat')
      expect(shown).toContain('$1.50')
      await ui.unmount()
    }
  })

  test('the card’s money replaces a reported spend_limit percentage', async ($, on) => {
    setup(on)
    withCard(on, WORK_CARD, [{ kind: 'spend_limit', percentUsed: 61.5, resetsAt: fromNow(25 * DAY) }])
    await begin($)

    const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
    const shown = await words(ui)

    expect(shown).toContain('$46.50')
    expect(shown).not.toContain('62%')
    expect((await ui.findAll({ type: 'Text', text: /^Monthly$/ })).length).toBe(1)
    await ui.unmount()
  })

  test('a seat with no spend limit shows the context window and what this chat cost', async ($, on) => {
    setup(on)
    withCard(on, { plan: { status: 'ok', plan: 'Pro', windows: [], extraUsage: { enabled: false } } })
    await begin($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      expect(shown).not.toContain('Monthly')
      expect(shown).toContain('Context')
      expect(shown).toContain('this chat')
      expect(shown).toContain('$1.50')
      await ui.unmount()
    }
  })

  test('a card the server could not read leaves the figures it has', async ($, on) => {
    setup(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: [], cost: { usd: 1.5 } } }))
    on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'unavailable' }], isError: true } }))
    withClassic(on)
    await begin($)

    const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
    const shown = await words(ui)

    expect(shown).not.toContain('Monthly')
    expect(shown).toContain('Context')
    expect(shown).toContain('this chat')
    await ui.unmount()
  })

  // 80% three hours into a five-hour window reaches the limit 45 minutes on: the band says so
  // in place of the time left. 20% two days into the week ends it near 70%: no warning.
  test('the pace tick marks how much of a window has gone, and the hint warns when the pace reaches the limit first', async ($, on) => {
    setup(on)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 80, resetsAt: fromNow(2 * HOUR) },
        { kind: 'seven_day', percentUsed: 20, resetsAt: fromNow(5 * DAY) },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      expect(shown).toContain('limit in ~45m')
      expect(shown).not.toContain('2h left')
      expect(shown).toContain('5d left')
      expect((await ui.find({ type: 'Text', text: 'limit in ~45m' }))?.props.color).toBe('warning')
      expect((await ui.find({ type: 'Text', text: '5d left' }))?.props.dimColor).toBe(true)

      if (surface === 'terminal') {
        expect((await ui.findAll({ type: 'Text', text: /^┃$/ })).length).toBe(2)
      } else {
        const fiveHour = await bar(ui, '5-hour limit')

        // Three fifths of the way along, centered on its own two pixels.
        expect(fiveHour).toContain('<rect x="60%" y="0" width="2"')
        expect(fiveHour).toContain('transform="translate(-1 0)"')
        expect(fiveHour).toContain('At this pace you reach the limit in ~45m.')
        expect(await bar(ui, 'Weekly limit')).toContain('On pace for ~70% by reset.')
      }
      await ui.unmount()

      const details = await $.ui.mount({ ...pane(), surface })
      const spelled = await words(details)

      expect(spelled).toContain('Limit in ~45m')
      expect(spelled).toContain('~70% by reset')
      await details.unmount()
    }
  })

  test('a window barely begun shows its tick but makes no projection', async ($, on) => {
    setup(on)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: fromNow(4 * HOUR + 50 * MINUTE) }],
      changed: ['context', 'rateLimits'],
    })

    const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
    expect(await words(ui)).toContain('4h 50m left')
    expect(await bar(ui, '5-hour limit')).toContain('y="0" width="2"')
    expect(await bar(ui, '5-hour limit')).not.toContain('by reset')
    await ui.unmount()

    const details = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect(await words(details)).not.toContain('by reset')
    await details.unmount()
  })

  // Plan mode holds the card back: its figures stay up dimmed, with how old they are, while
  // the engine's own context reading carries on.
  test('plan mode dims the card’s figures and says how long they have been held', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    countingCard(on)
    await begin($)
    await clock.advance(0)

    await $.classic.UserPromptSubmit({ prompt: 'plan the change', permission_mode: 'plan' })
    await clock.advance(14 * MINUTE)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      expect(shown).toContain('Held · 14m')
      expect((await ui.find({ type: 'Text', text: '4%' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Text', text: '42%' }))?.props.dimColor).toBeUndefined()
      // A held window shows no time left: the reset it counts to may have come and gone.
      expect(shown).not.toContain('left')

      if (surface === 'desktop') {
        expect(await bar(ui, '5-hour limit')).toContain(`<g fill="${HUE.neutral}" opacity="0.55">`)
        expect(await bar(ui, 'Context window')).toContain(`fill="${HUE.context}"`)
      }
      await ui.unmount()

      const details = await $.ui.mount({ ...pane(), surface })
      expect(await words(details)).toContain('Held · read 14m ago')
      await details.unmount()
    }
  })

  // Read now is the person's own ask: it reads the card in any mode, and the app may ask them
  // to approve that one read.
  test('Read now reads the card while plan mode holds it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    const asked = countingCard(on)
    await begin($)
    await clock.advance(0)
    await $.classic.UserPromptSubmit({ prompt: 'plan the change', permission_mode: 'plan' })
    await clock.advance(5 * MINUTE)
    expect(asked.reads).toBe(1)

    const details = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect(await words(details)).toContain('Held · read 5m ago')
    await details.press({ key: 'read-now' })
    await clock.advance(0)
    expect(asked.reads).toBe(2)
    expect(await words(details)).toContain('Held · read just now')
    await details.unmount()

    // The terminal has no card server to read: no button there.
    const terminal = await $.ui.mount({ ...pane(), surface: 'terminal' })
    expect((await terminal.findAll({ type: 'Button' })).some(found => found.key === 'read-now')).toBe(false)
    await terminal.unmount()
  })

  // Coming back to a chat the app has restarted, or opening a new one: a fresh session has read
  // no card and named no mode yet. The last card read comes back, held, so the plan's limits
  // never drop out of the band, until this session's first prompt in Auto reads its own.
  test('the last plan limits read come back with a fresh session, held, until it reads its own', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on, {
      plan: {
        windows: [
          { kind: 'five_hour', percentUsed: 4, resetsAt: fromNow(3 * HOUR + 40 * MINUTE) },
          { kind: 'seven_day', percentUsed: 29, resetsAt: fromNow(DAY + 16 * HOUR) },
        ],
        spend: null,
        readAt: NOW - 2 * HOUR,
      },
    })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    const asked = countingCard(on)
    await $.session.start(START)
    expect(asked.reads).toBe(0)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      for (const figure of ['5-hour', '4%', 'Weekly', '29%', 'Held · 2h']) {
        expect(shown).toContain(figure)
      }
      expect((await ui.find({ type: 'Text', text: '29%' }))?.props.dimColor).toBe(true)
      await ui.unmount()

      const details = await $.ui.mount({ ...pane(), surface })
      const spelled = await words(details)

      expect(spelled).toContain('Held · read 2h ago')
      expect(spelled).toContain('These are your plan limits as last read. They refresh with your first prompt in Auto mode.')
      await details.unmount()
    }

    // The first prompt in Auto reads the card: its figures replace the stored ones, live.
    await $.classic.UserPromptSubmit({ prompt: 'hello', permission_mode: 'auto' })
    await clock.advance(0)
    expect(asked.reads).toBe(1)

    const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
    const shown = await words(ui)

    expect(shown).toContain('1%')
    expect(shown).not.toContain('29%')
    expect(shown).not.toContain('Held')
    await ui.unmount()
  })

  test('each card read is kept for the next session, and an account with no plan limits keeps none', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const saved = new Map<string, unknown>()
    on('store.get', (_, e) => ({ value: saved.get(e.key) }))
    on('store.set', (_, e) => {
      saved.set(e.key, e.value)

      return { value: undefined }
    })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    const asked = countingCard(on)
    await begin($)
    await clock.advance(0)

    expect(saved.get('plan')).toEqual({
      windows: [
        { kind: 'five_hour', percentUsed: 4, resetsAt: fromNow(3 * HOUR + 40 * MINUTE) },
        { kind: 'seven_day', percentUsed: 1, resetsAt: fromNow(5 * DAY + 20 * HOUR) },
      ],
      spend: null,
      readAt: NOW,
    })

    // Signed in with an API key: no plan limits apply, and no older card may stand in for them.
    asked.card = { plan: { status: 'not_applicable' } }
    await clock.advance(60_000)
    await $.classic.Stop({ stop_hook_active: false, permission_mode: 'auto' })
    await clock.advance(0)
    expect(saved.get('plan')).toBeNull()
  })

  // A 5-hour window read before it reset says nothing true about the one running now.
  test('a held window that has reset since it was read shows no figure', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on, {
      plan: {
        windows: [
          { kind: 'five_hour', percentUsed: 95, resetsAt: fromNow(-10 * MINUTE) },
          { kind: 'seven_day', percentUsed: 29, resetsAt: fromNow(DAY) },
        ],
        spend: null,
        readAt: NOW - 3 * HOUR,
      },
    })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    countingCard(on)
    await $.session.start(START)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      const shown = await words(ui)

      expect(shown).toContain('5-hour')
      expect(shown).not.toContain('95%')
      expect((await ui.find({ type: 'Text', text: '—' }))?.props.dimColor).toBe(true)
      expect(shown).toContain('29%')
      await ui.unmount()

      const details = await $.ui.mount({ ...pane(), surface })
      expect(await words(details)).toContain('Reset since it was read')
      await details.unmount()
    }
  })

  test('a held monthly cap read last month shows no figure', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on, {
      plan: { windows: [], spend: { percentUsed: 80, spent: 160, limit: 200, currency: 'USD' }, readAt: Date.parse('2026-09-28T12:00:00Z') },
    })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    withPanes(on)
    countingCard(on, WORK_CARD)
    await $.session.start(START)

    const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
    const shown = await words(ui)

    expect(shown).toContain('Monthly')
    expect(shown).toContain('—')
    expect(shown).toContain('of $200')
    expect(shown).not.toContain('$160')
    await ui.unmount()
  })

  test('the pane spells out each limit’s reset and pace, and what this chat has used', async ($, on) => {
    setup(on)
    withCard(on, PERSONAL_CARD)
    await begin($)

    for (const surface of SURFACES) {
      const details = await $.ui.mount({ ...pane(), surface })
      const spelled = await words(details)

      for (const figure of ['Plan limits', '5-hour limit', 'Weekly limit', 'This chat', 'Context', '84k', 'of 200k', '116k free', '42% used', 'Cost', '$1.50', 'Estimated at API rates']) {
        expect(spelled).toContain(figure)
      }
      // 4% eighty minutes into five hours ends the window near 15%.
      expect(spelled).toMatch(/Resets (\w{3} )?\d{1,2}:\d{2} [AP]M · in 3h 40m/)
      expect(spelled).toContain('~15% by reset')
      expect(spelled).toContain('Plan limits refresh with each prompt in Auto mode.')
      expect(spelled).not.toContain('Fable')
      expect((await details.findAll({ type: 'Button' })).some(found => found.key === 'read-now')).toBe(surface === 'desktop')

      // The pane's bars name their height too, a 6px bar and its tick.
      for (const found of (await details.findAll({ type: 'Svg' })).filter(svg => svg.props.isInteractive === true)) {
        expect(found.props.height).toBe(12)
      }
      await details.unmount()
    }
  })

  test('the trend line keeps the context’s readings, only its changes, at most 60', async ($, on) => {
    setup(on)
    on('classic.SessionStart', () => ({}))

    for (let reading = 1; reading <= 70; reading += 1) {
      const context = { tokens: reading * 1_000, window: 200_000, percent: reading / 2 }

      await $.session.measure({ context, rateLimits: [], changed: ['context'] })
      // The same figures read again, as the countdowns' minute refresh does: no new point.
      await $.session.measure({ context, rateLimits: [], changed: ['context'] })
    }

    const details = await $.ui.mount({ ...pane(), surface: 'desktop' })
    const trend = (await details.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Context went'))

    expect(String(trend?.props.alt)).toBe('Context went from 11k to 70k tokens over 60 readings.')
    expect(String(trend?.props.source).match(/points="([^"]+)"/)?.[1]?.split(' ').length).toBe(60)
    // Drawn wider than any pane and stretched to its height, so it spans the pane edge to edge.
    expect(trend?.props.height).toBe(36)
    expect(String(trend?.props.source)).toContain('preserveAspectRatio="none"')
    expect(String(trend?.props.source)).toContain('vector-effect="non-scaling-stroke"')
    await details.unmount()

    const terminal = await $.ui.mount({ ...pane(), surface: 'terminal' })
    expect((await terminal.findAll({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]{48}$/ })).length).toBe(1)
    await terminal.unmount()

    // /clear starts a new chat, and its trend with it.
    await $.classic.SessionStart({ source: 'clear' })
    await $.session.measure({ context: { tokens: 3_000, window: 200_000, percent: 1.5 }, rateLimits: [], changed: ['context'] })

    const cleared = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect((await cleared.findAll({ type: 'Svg' })).some(found => String(found.props.alt).startsWith('Context went'))).toBe(false)
    await cleared.unmount()
  })

  test('Details opens the Usage pane and Hide details closes it', async ($, on) => {
    const open = setup(on)
    withCard(on, PERSONAL_CARD)
    await begin($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })
      expect(await toggleLabel(ui)).toBe('Details')

      // On the desktop its words are the size of the figures beside it.
      if (surface === 'desktop') {
        expect((await ui.find({ type: 'Text', text: 'Details' }))?.props.size).toBe('footnote')
      }

      await ui.press({ key: 'toggle' })
      expect(open.has('usage')).toBe(true)
      expect(await toggleLabel(ui)).toBe('Hide details')

      await ui.press({ key: 'toggle' })
      expect(open.has('usage')).toBe(false)
      expect(await toggleLabel(ui)).toBe('Details')
      await ui.unmount()
    }
  })

  test('/usage-pane opens the pane', async ($, on) => {
    const open = setup(on)
    withCard(on, PERSONAL_CARD)
    await begin($)

    const { text } = await $.command.run({
      command: 'usage-pane',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
    expect(text).toBe('Usage pane opened.')
    expect(open.has('usage')).toBe(true)
  })

  test('a pane left open comes back with the next session, and one closed stays closed', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on, { isPaneOpen: true })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const open = withPanes(on)
    withCard(on, PERSONAL_CARD)
    await begin($)
    expect(open.has('usage')).toBe(true)

    const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
    expect(await toggleLabel(ui)).toBe('Hide details')
    await ui.press({ key: 'toggle' })
    await ui.unmount()

    await $.session.start(START)
    expect(open.has('usage')).toBe(false)
  })

  test('each bar keeps its kind’s hue, turning amber from 75% and red from 90%', async ($, on) => {
    setup(on)
    // Each window further gone than it is used, so each tick stands past its fill, not inside it.
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 92, resetsAt: fromNow(15 * MINUTE) },
        { kind: 'seven_day', percentUsed: 80, resetsAt: fromNow(25 * HOUR) },
      ],
      changed: ['context', 'rateLimits'],
    })

    const desktop = await $.ui.mount({ ...band(), surface: 'desktop' })
    expect(await bar(desktop, 'Context window')).toContain(`fill="${HUE.context}"`)
    expect(await bar(desktop, '5-hour limit')).toContain(`fill="${HUE.danger}"`)
    expect(await bar(desktop, 'Weekly limit')).toContain(`fill="${HUE.warning}"`)
    await desktop.unmount()

    const terminal = await $.ui.mount({ ...band(), surface: 'terminal' })
    expect(await fills(terminal)).toEqual([HUE.context, HUE.danger, HUE.warning])
    await terminal.unmount()

    // The figures beside them take the theme's own colors, so they follow light and dark.
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(), surface })

      expect((await ui.find({ type: 'Text', text: '92%' }))?.props.color).toBe('error')
      expect((await ui.find({ type: 'Text', text: '80%' }))?.props.color).toBe('warning')
      expect((await ui.find({ type: 'Text', text: '42%' }))?.props.color).toBeUndefined()
      await ui.unmount()
    }
  })

  test('calm bars keep one hue per kind, and no window is drawn in amber or red while calm', async ($, on) => {
    setup(on)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'seven_day', percentUsed: 30 },
        { kind: 'spend_limit', percentUsed: 30 },
        { kind: 'seven_day_haiku', percentUsed: 30 },
        { kind: 'daily_tokens', percentUsed: 30 },
      ],
      changed: ['rateLimits'],
    })

    const ui = await $.ui.mount({ ...band(200), surface: 'terminal' })
    expect(await fills(ui)).toEqual([HUE.context, HUE.teal, HUE.purple, HUE.pink, HUE.pink])
    expect(await words(ui)).toContain('Daily tokens')
    await ui.unmount()
  })

  test('desktop meters share the whole row, and each bar runs its whole share', async ($, on) => {
    setup(on)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: fromNow(2 * HOUR) },
        { kind: 'seven_day', percentUsed: 8, resetsAt: fromNow(50 * HOUR) },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    })

    for (const columns of [60, 120, 220]) {
      const ui = await $.ui.mount({ ...band(columns), surface: 'desktop' })
      const slots = (await ui.findAll({ type: 'Box' })).filter(found => ['context', 'five_hour', 'seven_day'].includes(String(found.key)))

      expect(slots.length).toBe(3)
      expect(slots.every(slot => slot.props.flexGrow === 1 && slot.props.width === 0 && slot.props.minWidth === 0)).toBe(true)
      expect((await ui.findAll({ type: 'Box' })).some(found => found.props.flexWrap === 'wrap')).toBe(false)

      // No width guessed from the column count: each bar is its share's whole width, end to end.
      for (const found of await ui.findAll({ type: 'Svg' })) {
        expect(String(found.props.source)).toMatch(/^<svg [^>]*width="100%"/)
        expect(String(found.props.source)).toContain('<rect x="0" y="3" width="100%"')
        expect(found.props.width).toBeUndefined()
      }
      await ui.unmount()
    }
  })

  test('reads usage at start and keeps countdowns ticking', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({
      value: {
        startedAt: NOW,
        context: CONTEXT,
        rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: fromNow(2 * HOUR) }],
      },
    }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
    expect(await words(ui)).toContain('2h left')

    await clock.advance(60_000)
    expect(await words(ui)).toContain('1h 59m left')
    await ui.unmount()
  })

  test('narrow bands drop hints and bars but keep every figure', async ($, on) => {
    setup(on)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: fromNow(2 * HOUR) },
        { kind: 'seven_day', percentUsed: 8, resetsAt: fromNow(30 * HOUR) },
      ],
      changed: ['context', 'rateLimits'],
    })

    const terminal = await $.ui.mount({ ...band(48), surface: 'terminal' })
    let shown = await words(terminal)

    expect(shown).toContain('42%')
    expect(shown).toContain('23%')
    expect(shown).toContain('8%')
    expect(shown).not.toContain('left')
    expect(shown).not.toContain('█')
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...band(60), surface: 'desktop' })
    shown = (await desktop.findAll({ type: 'Text' })).map(found => found.text).join(' | ')

    expect(shown).toContain('23%')
    expect(shown).toContain('8%')
    expect(shown).not.toContain('left')
    await desktop.unmount()
  })
})
