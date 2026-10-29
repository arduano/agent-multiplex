import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useCodexView } from "../../src/codex/react/index.js";
import type { CodexViewPort } from "../../src/codex/client/index.js";
import { fixture, run, until } from "./fixture.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
test("native headless hook is inert during render and preserves receiver-dependent borrowed stores under StrictMode", async () => {
  const f = fixture(),
    retained = f.workspace.view(run);
  class Borrowed {
    readonly view = retained;
    getSnapshot() {
      return this.view.getSnapshot();
    }
    subscribe(listener: () => void) {
      return this.view.subscribe(listener);
    }
    commit() {
      return this.view.commit();
    }
  }
  const methods = new Borrowed();
  const view: CodexViewPort = Object.assign(methods, {
    run: retained.run,
    threadId: retained.threadId,
    anchor: retained.anchor,
    pin: retained.pin.bind(retained),
    readThread: retained.readThread.bind(retained),
    readTurns: retained.readTurns.bind(retained),
    readItems: retained.readItems.bind(retained),
    close: retained.close.bind(retained),
  });
  function Consumer() {
    return h("p", null, useCodexView(view).entry.freshness);
  }
  assert.match(renderToString(h(Consumer)), /unobserved/);
  assert.equal(f.opens + f.reads.length, 0);
  let rendered: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      rendered = create(h(StrictMode, null, h(Consumer)));
    });
    await act(async () => {
      await until(() => f.watchers === 1);
    });
    assert.equal(f.watchers, 1);
    assert.match(JSON.stringify(rendered!.toJSON()), /current/);
  } finally {
    if (rendered)
      await act(async () => {
        rendered!.unmount();
      });
    await f.close();
  }
  assert.equal(f.watchers + f.effects, 0);
});
