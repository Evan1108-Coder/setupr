import { useEffect, useMemo, useRef, useState } from "react";
import { createTerminalControlInputStripper, useTerminalInput } from "../terminalInput.js";

export interface FocusBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusItem {
  id: string;
  row: number;
  column: number;
  parentIds?: string[];
  redirectTo?: string;
  bounds?: FocusBounds;
}

interface UseFocusNavigationOptions {
  items: FocusItem[];
  initialId?: string;
  onQuit?: () => void;
}

export type FocusState = "focused" | "ancestor" | undefined;

export function useFocusNavigation({ items, initialId, onQuit }: UseFocusNavigationOptions) {
  const [requestedId, setActiveIdState] = useState(initialId || items[0]?.id || "");
  const controlStripper = useMemo(() => createTerminalControlInputStripper(), []);
  const tabItems = items.map((item) => resolveItem(items, item.id))
    .filter((item, index, resolved): item is FocusItem => Boolean(item) && resolved.findIndex((other) => other?.id === item?.id) === index);
  const activeId = (resolveItem(items, requestedId) || tabItems[0])?.id || "";
  const activeIdRef = useRef(activeId);
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId));
  const activeItem = items.find((item) => item.id === activeId);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (requestedId !== activeId) setActiveIdState(activeId);
  }, [activeId, requestedId]);

  const setActiveId = (id: string) => {
    const item = resolveItem(items, id);
    if (item) {
      activeIdRef.current = item.id;
      setActiveIdState(item.id);
    }
  };

  const setActivePanel = (index: number) => {
    const item = items[index];
    if (item) setActiveId(item.id);
  };

  useTerminalInput((input, key, raw) => {
    const chunk = controlStripper.read(raw);
    if (chunk.paste || (chunk.continuation && !chunk.mouse.length)) return;
    if (input === "\x03" || (key.ctrl && input === "c")) {
      onQuit?.();
      return;
    }

    for (const mouse of chunk.mouse) {
      if (mouse.action !== "press" || (mouse.code & 3) !== 0 || chunk.text) continue;
      const hit = findMouseHit(items, mouse.x, mouse.y);
      if (hit) setActiveId(hit.id);
    }
    if (chunk.mouse.length) return;

    if (raw === "q" && chunk.text === "q" && activeIdRef.current !== "input") {
      onQuit?.();
      return;
    }

    if (key.tab && tabItems.length > 0) {
      const index = Math.max(0, tabItems.findIndex((item) => item.id === activeIdRef.current));
      const delta = key.shift ? -1 : 1;
      activateItem(tabItems[(index + delta + tabItems.length) % tabItems.length]);
      return;
    }

    if (activeIdRef.current === "input" && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
      return;
    }

    if (key.rightArrow) {
      move("right");
      return;
    }
    if (key.leftArrow) {
      move("left");
      return;
    }
    if (key.downArrow) {
      move("down");
      return;
    }
    if (key.upArrow) {
      move("up");
    }
  });

  const move = (direction: "left" | "right" | "up" | "down") => {
    const current = resolveItem(items, activeIdRef.current);
    if (!current) return;
    const origin = navigationOrigin(items, current);
    const next = findDirectionalFocusItem(items, origin, direction, uniqueIds([current.id, origin.id, ...(current.parentIds || [])]));
    activateItem(next);
  };

  const activateItem = (item: FocusItem | undefined) => {
    if (!item) return;
    setActiveId(item.id);
  };

  const isActive = (id: string) => activeId === id;
  const isAncestor = (id: string) => activeItem?.parentIds?.includes(id) || false;
  const focusState = (id: string): FocusState => {
    if (isActive(id)) return "focused";
    if (isAncestor(id)) return "ancestor";
    return undefined;
  };

  return {
    activeId,
    activePanel: activeIndex,
    activeItem,
    focusState,
    isActive,
    isAncestor,
    setActiveId,
    setActivePanel,
  };
}

function resolveItem(items: FocusItem[], id: string): FocusItem | undefined {
  const visited = new Set<string>();
  let item = items.find((candidate) => candidate.id === id);
  while (item?.redirectTo) {
    if (visited.has(item.id)) return undefined;
    visited.add(item.id);
    item = items.find((candidate) => candidate.id === item!.redirectTo);
  }
  return item;
}

function navigationOrigin(items: FocusItem[], activeItem: FocusItem): FocusItem {
  if (activeItem.bounds) return activeItem;
  const parentId = activeItem.parentIds?.[activeItem.parentIds.length - 1];
  return items.find((item) => item.id === parentId) || activeItem;
}

export function findDirectionalFocusItem(items: FocusItem[], current: FocusItem, direction: "left" | "right" | "up" | "down", ignoreIds: string[] = [current.id]) {
  if (current.bounds && items.some((item) => item.bounds)) {
    const byBounds = nearestItemByBounds(items, current, direction, ignoreIds);
    if (byBounds) return byBounds;
  }

  const candidates = items.filter((item) => {
    if (ignoreIds.includes(item.id)) return false;
    if (direction === "right") return item.column > current.column;
    if (direction === "left") return item.column < current.column;
    if (direction === "down") return item.row > current.row;
    return item.row < current.row;
  });

  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => scoreCandidate(a, current, direction) - scoreCandidate(b, current, direction))[0];
}

function nearestItemByBounds(items: FocusItem[], current: FocusItem, direction: "left" | "right" | "up" | "down", ignoreIds: string[]) {
  if (!current.bounds) return undefined;
  const currentBox = rectMetrics(current.bounds);

  const candidates = items.filter((item) => {
    if (ignoreIds.includes(item.id) || !item.bounds) return false;
    const box = rectMetrics(item.bounds);
    if (direction === "down") {
      return box.top >= currentBox.bottom || (box.centerY > currentBox.centerY && rangesOverlap(currentBox.left, currentBox.right, box.left, box.right));
    }
    if (direction === "up") {
      return box.bottom <= currentBox.top || (box.centerY < currentBox.centerY && rangesOverlap(currentBox.left, currentBox.right, box.left, box.right));
    }
    if (direction === "right") {
      return box.left >= currentBox.right || (box.centerX > currentBox.centerX && rangesOverlap(currentBox.top, currentBox.bottom, box.top, box.bottom));
    }
    return box.right <= currentBox.left || (box.centerX < currentBox.centerX && rangesOverlap(currentBox.top, currentBox.bottom, box.top, box.bottom));
  });

  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => {
    return visualScore(a, currentBox, direction) - visualScore(b, currentBox, direction);
  })[0];
}

function visualScore(item: FocusItem, currentBox: ReturnType<typeof rectMetrics>, direction: "left" | "right" | "up" | "down") {
  const box = rectMetrics(item.bounds!);

  if (direction === "down" || direction === "up") {
    const gap = direction === "down"
      ? Math.max(0, box.top - currentBox.bottom)
      : Math.max(0, currentBox.top - box.bottom);
    const crossGap = horizontalGap(currentBox, box);
    const crossCenterDistance = Math.abs(box.centerX - currentBox.centerX);
    const forwardCenterDistance = Math.abs(box.centerY - currentBox.centerY);
    const crossAlignmentPenalty = rangesOverlap(currentBox.left, currentBox.right, box.left, box.right)
      ? 0
      : 1000000000 + crossGap * 1000000;
    return gap * 1000000 + crossAlignmentPenalty + crossCenterDistance * 100 + forwardCenterDistance;
  }

  const gap = direction === "right"
    ? Math.max(0, box.left - currentBox.right)
    : Math.max(0, currentBox.left - box.right);
  const crossGap = verticalGap(currentBox, box);
  const crossCenterDistance = Math.abs(box.centerY - currentBox.centerY);
  const forwardCenterDistance = Math.abs(box.centerX - currentBox.centerX);
  const crossAlignmentPenalty = rangesOverlap(currentBox.top, currentBox.bottom, box.top, box.bottom)
    ? 0
    : 1000000000 + crossGap * 1000000;
  return gap * 1000000 + crossAlignmentPenalty + crossCenterDistance * 100 + forwardCenterDistance;
}

function rectMetrics(bounds: FocusBounds) {
  return {
    left: bounds.x,
    right: bounds.x + bounds.width,
    top: bounds.y,
    bottom: bounds.y + bounds.height,
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2,
  };
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function horizontalGap(a: ReturnType<typeof rectMetrics>, b: ReturnType<typeof rectMetrics>): number {
  if (rangesOverlap(a.left, a.right, b.left, b.right)) return 0;
  return Math.min(Math.abs(a.left - b.right), Math.abs(b.left - a.right));
}

function verticalGap(a: ReturnType<typeof rectMetrics>, b: ReturnType<typeof rectMetrics>): number {
  if (rangesOverlap(a.top, a.bottom, b.top, b.bottom)) return 0;
  return Math.min(Math.abs(a.top - b.bottom), Math.abs(b.top - a.bottom));
}

function scoreCandidate(item: FocusItem, current: FocusItem, direction: "left" | "right" | "up" | "down") {
  const primary = direction === "left" || direction === "right"
    ? Math.abs(item.column - current.column)
    : Math.abs(item.row - current.row);
  const secondary = direction === "left" || direction === "right"
    ? Math.abs(item.row - current.row)
    : Math.abs(item.column - current.column);
  return primary * 100 + secondary;
}

function findMouseHit(items: FocusItem[], x: number, y: number) {
  return [...items].reverse().find((item) => {
    if (!item.bounds) return false;
    const { x: bx, y: by, width, height } = item.bounds;
    return x >= bx && x < bx + width && y >= by && y < by + height;
  });
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
