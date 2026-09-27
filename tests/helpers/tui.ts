import { act, type ReactElement } from "react";
import { cleanup as cleanupInk, render as renderInk } from "ink-testing-library";

export const flushTui = async () => { await act(async () => {}); };

export function cleanup() {
  act(() => cleanupInk());
}

export function render(tree: ReactElement) {
  let ui!: ReturnType<typeof renderInk>;
  act(() => { ui = renderInk(tree); });
  return {
    ...ui,
    // Keep stdin.write available for deliberate unflushed keystroke bursts.
    write: (text: string) => act(() => { ui.stdin.write(text); }),
    rerender: (next: ReactElement) => act(() => { ui.rerender(next); }),
    unmount: () => act(() => { ui.unmount(); }),
  };
}
