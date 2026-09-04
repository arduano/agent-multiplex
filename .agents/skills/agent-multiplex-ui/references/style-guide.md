# Agent Multiplex UI style guide

## Product and visual thesis

Agent Multiplex is a focused multi-agent operations workspace. An operator should be able to scan agent state, enter a session, read its work, respond to it, and inspect context without losing orientation.

- Mood: graphite, precise, quiet, dependable.
- Primary surface: the selected agent conversation.
- Navigation: compact session and fleet rail.
- Secondary context: collapsible inspector.
- Signature: an execution spine that groups reasoning, tools, and subagents by lifecycle.
- Copy: short, active, sentence case, and operational. Labels orient; errors state the next useful action.

## Tokens

Use semantic CSS variables rather than repeating raw colors.

| Role | Value |
| --- | --- |
| Background | `#0b0d10` |
| Shell | `#0f1216` |
| Surface | `#14181e` |
| Raised surface | `#191e25` |
| Divider | `#2a3039` |
| Primary text | `#f3f4f6` |
| Secondary text | `#a7afba` |
| Muted text | `#7f8996` |
| Action accent | `#46b8ff` |
| Success | `#47c98b` |
| Waiting | `#e6ad52` |
| Error | `#f06e78` |

- Use Geist Variable for interface text and Geist Mono only for paths, IDs, models, commands, logs, and JSON.
- Working text is at least 14px; compact supporting text is at least 12px.
- Use a 4px spacing grid. Keep routine radii at or below 8px.
- Use one action accent per view. Semantic colors must include an icon or text label, never color alone.
- Avoid gradients, glows, ornamental shadows, letter-spaced uppercase microcopy, nested cards, and metric-card mosaics.

## Responsive composition

- `>=1280px`: three horizontal, resizable panes. Navigation defaults to 288px (240–420px); inspector defaults to 360px (320–520px); conversation has a 520px minimum. Both side panes can collapse, and layout preferences persist locally.
- `768–1279px`: collapsible navigation plus conversation; inspector opens as an accessible sheet.
- `<768px`, or short landscape below 500px tall and 960px wide: conversation-first single pane; navigation/fleet and inspector use full-height sheets.
- Persistent controls respect safe-area insets. Nothing important is hidden solely because the viewport is narrow.
- Touch targets are at least 44px under coarse pointers. Desktop density may use 36px controls.

## Components and behavior

### App shell and navigation

- Before authentication, show a compact, explicitly labelled connection surface.
- Once connected, replace token entry with a small health/reconnect control.
- Agent rows show human title, harness, machine, and text-plus-icon state in a stable-height row.
- Defer filtering and apply `content-visibility` to large lists. Truncate long titles without hiding full values from accessible names/tooltips.
- Present runtimes and selected/suppressed sources as plain fleet rows, not cards.

### Large fleets

- Treat 100 sessions across 10 runtimes as the baseline scale fixture. Keep runtime health in an independently scrollable, pinned fleet region so the session list cannot push it out of reach.
- Keep session rows stable-height. Preserve selected session, query/filter state, and list scroll while data refreshes; preserve per-session transcript position when navigation makes that practical.
- Default order is waiting-for-input, running, active, then resumable; sort by newest activity inside each group. Always expose text search across title, harness, workspace, session ID, and runtime.
- Add state/harness/runtime facets only when the product needs more than search; keep the unfiltered default usable. If DOM and interaction measurements regress at 100 sessions, virtualize the session list without changing its accessible semantics or selectors.
- For a 100-session acceptance, verify search feedback and selection render within one animation frame after React commits, fleet remains directly reachable, and scrolling does not block the conversation stream.

### Conversation

- Header shows title, workspace, harness, runtime state, stream/history health, and current settings summary. Show Interrupt there only while work is running.
- Constrain message measure to about 70–75 characters. Assistant content is flat; user content may use one subtle bubble.
- Render Markdown/GFM without raw HTML. Code and command output scroll horizontally.
- Collapse completed reasoning/tool/subagent activity into the execution spine; open running and failed entries automatically.
- Auto-follow only when already near the bottom or immediately after the local user sends. Otherwise show a Jump to latest control with an unread count.
- Pin pending approvals and questions above the composer.
- Keep the prompt dominant. Put model, mode, and effort in Agent settings; preserve explicit, separately acknowledged mutations.

### Inspector and forms

- Inspector tabs are Metadata, Session, and Activity, with Metadata initially selected.
- Keep the raw JSON metadata editor until a schema-backed form exists. Give it sufficient width, disable soft wrapping, validate inline, retain CAS semantics, and warn before discarding dirty state.
- Use Radix primitives for dialogs, sheets, tabs, popovers, and tooltips. Do not implement focus trapping, inert backgrounds, Escape handling, or focus restoration by hand.
- Async status uses an appropriate live region. Errors appear beside the action that failed and state what the operator can do next.

## Motion and accessibility

- Limit state transitions to 120–180ms and animate only opacity or transform.
- Honor `prefers-reduced-motion` and avoid persistent decorative animation.
- Provide visible `:focus-visible` treatment, semantic elements, explicit form labels, icon-button labels, and logical keyboard order.
- Routine text must meet WCAG AA contrast. Do not use color as the only state signal.
- Protect layout from long paths, identifiers, commands, metadata values, and streamed output.

## Verification contract

Preserve all existing functional selectors and run the relevant protocol/browser flows. Inspect at:

- 1720×1180 acceptance viewport
- 1440×900 desktop
- 1024×768 compact desktop
- 768×1024 tablet portrait
- 390×844 phone portrait
- 844×390 phone landscape

Check no horizontal overflow, overlap, clipping, inaccessible feature, or mobile-keyboard trap. Exercise empty, disconnected, connecting, live, streaming, running-command, waiting-for-input, interrupted, history-recovered, metadata-conflict, long-content, and reconnecting states. Keyboard-test every dialog, sheet, popover, and tab; restore focus on close. Run axe and accept no serious or critical violations. Verify reduced-motion behavior.

Use deterministic fixtures for rare states: mock-adapter snapshots for empty/error/reconnecting/long-content and the 100-session fleet; the live four-container receipt for Codex/Copilot lifecycle, interactions, interrupt, history recovery, and renewal. At short landscape heights, keep the composer and at least 120px of transcript visible by compacting nonessential header/help chrome.
