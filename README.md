# Claude Desktop Usage Widget

A Claude Code mod that adds a one-line usage strip above the prompt in the Claude desktop app's
Code tab. It shows:

- how full the context window is
- your plan's 5-hour and weekly limits (or a work seat's monthly spend), each with a pace marker
- what the chat has cost so far

**Details** opens a Usage pane with each limit's reset time, where it's heading, and a trend line
of the context window over the chat.

## Install

At the prompt of a terminal session (`claude`):

```
/plugin install usage-widget --marketplace ecopado/ClaudeDesktopUsageWidget
```

Answer `y` to add the marketplace, then choose a scope. At user scope it loads in every session,
the desktop app's Code tab included.

From a shell:

```bash
claude plugin install usage-widget --marketplace ecopado/ClaudeDesktopUsageWidget
```

In the desktop app, click **+** next to the prompt box, then **Plugins**, then **Add marketplace**.
Enter `ecopado/ClaudeDesktopUsageWidget`, then choose **Add plugin**.

### Manual install

Download `usage-widget-<version>.zip` from
[Releases](https://github.com/ecopado/ClaudeDesktopUsageWidget/releases), unzip it, and follow
[INSTALL.md](INSTALL.md). That loads the `usage-widget` folder through a setting, with no
marketplace.

It needs Claude Code 2.1.288 or later. [INSTALL.md](INSTALL.md) also covers how the widget reads your
plan's limits and what changed in each version.
