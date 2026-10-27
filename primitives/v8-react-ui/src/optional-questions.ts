import { createElement as h } from 'react';
import type { CodexOptionalQuestion } from '../../v8-history/src/native/codex/questions.js';
import { Button } from './ui/index.js';

/** Optional native suggestions stage ordinary draft text. They are not answers
 * to an interaction request and own no submission or retained form state. */
export type OptionalReply = (question: CodexOptionalQuestion, answer?: string) => void;

export function OptionalQuestions({ questions, omitted = 0, onReply }: Readonly<{
  questions: readonly CodexOptionalQuestion[];
  omitted?: number;
  onReply?: OptionalReply;
}>) {
  return h('section', { className: 'mpx-chat__optional-questions', 'aria-label': 'Optional questions', 'data-action': 'optional-questions' },
    h('small', { className: 'mpx-chat__optional-label' }, 'Optional reply'),
    ...questions.map((question, index) => h('div', { key: index, className: 'mpx-chat__optional-question', role: 'group', 'aria-label': question.title },
      h('p', { className: 'mpx-chat__optional-title' }, question.title),
      onReply ? h('div', { className: 'mpx-chat__optional-choices' },
        ...question.options.map((option, choice) => h(Button, { key: choice, type: 'button', variant: 'outline', 'data-action': 'optional-reply', onClick: () => onReply(question, option) }, option)),
        h(Button, { type: 'button', variant: 'ghost', 'data-action': 'optional-write-reply', onClick: () => onReply(question) }, 'Write a reply'))
        : question.options.length ? h('ul', null, ...question.options.map((option, choice) => h('li', { key: choice }, option))) : null)),
    omitted > 0 ? h('p', { className: 'mpx-chat__optional-omitted' }, 'Some optional questions could not be shown. You can reply in the message box.') : null);
}
