---
name: agent-multiplex-ui
description: Design, implement, or review the Agent Multiplex React operator interface. Use for work in apps/web that affects layout, visual hierarchy, responsive behavior, accessibility, agent transcripts, controls, or UI copy; do not use for transport or protocol-only changes.
---

# Agent Multiplex UI

Build a calm, information-dense agent command center. The interface is an operational workspace, not a dashboard collage, marketing page, or chat toy.

Before changing UI:

1. Inspect the affected React components and the latest desktop and mobile screenshots when available.
2. State a one-sentence visual thesis and identify the primary operator workflow.
3. Read [references/style-guide.md](references/style-guide.md) for the maintained visual, responsive, interaction, and verification contract.

Preserve native agent meaning and existing wire behavior. Never infer or parse session history in presentation code beyond the repository's native-event normalization layer. Keep established `data-testid` and `data-*` hooks unless the corresponding acceptance test is deliberately migrated in the same change.

Work composition-first. Prefer unframed regions, dividers, lists, and contextual tools. Use cards only when the card is itself an interaction or repeated object. Keep the conversation as the primary workspace and make navigation, metadata, activity, and fleet state available without competing with it.

Use the existing React, Tailwind, TanStack Query, Radix, Lucide, and resizable-panel stack. Reuse primitives before adding dependencies or hand-building keyboard/focus behavior.

After implementation, run the relevant typecheck and tests, then inspect Playwright screenshots across the viewport matrix in the style guide. Critique hierarchy, density, clipping, contrast, long-content handling, and state clarity from the rendered result; make a refinement pass when the screenshot exposes a problem.

Source baseline: OpenAI's current [Frontend prompt instructions](https://developers.openai.com/api/docs/guides/frontend-prompt/) and the operational-app guidance in [Designing delightful frontends with GPT-5.4](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4/). The former targets GPT-5.5 and explicitly says its patterns generalize. Ignore landing-page hero, promotional imagery, and ornamental-motion advice for this product surface.
