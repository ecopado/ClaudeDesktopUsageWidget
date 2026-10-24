export type UsageLimit = {
  /** `five_hour`, `seven_day`, `seven_day_opus`, `spend_limit`, or whatever the account reports. */
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type UsageSnapshot = {
  context: { window: number; tokens?: number; percent?: number }
  limits: UsageLimit[]
  costUsd?: number
  /** `$.clock.now()` when this was read; reset countdowns count from it. */
  measuredAt: number
}

/**
 * The account's monthly spend against its cap, as the app's usage card reports it
 * (`extraUsage`): the one usage limit a work seat has, and the only one reported in money.
 */
export type SpendLimit = {
  /** 0–100, and past 100 once the cap is exceeded. */
  percentUsed: number
  /** Spent this month, in `currency`. */
  spent: number
  /** The month's cap, in `currency`. */
  limit: number
  /** ISO 4217, `USD` where the card names none. */
  currency: string
}

/**
 * The account's plan limits as the app's usage card reports them: whatever account is signed
 * in now, so a personal plan's windows and a work seat's monthly cap each replace the other's.
 */
export type PlanUsage = {
  /** The card's 5-hour, weekly and per-model weekly windows, keyed as the engine's `rateLimits` are. */
  windows: UsageLimit[]
  /** The monthly spend cap; null where the account has none switched on. */
  spend: SpendLimit | null
  /** `$.clock.now()` when the card was read: how old held figures are. */
  readAt: number
}

/** One reading of the context window, for the pane's trend line. */
export type HistoryPoint = {
  at: number
  tokens: number
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-widget': {
      snapshot: UsageSnapshot | null
      plan: PlanUsage | null
      /** The context window's readings this session, oldest first, at most 60. */
      history: HistoryPoint[]
      isPaneOpen: boolean
    }
  }
}
