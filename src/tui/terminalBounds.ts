import type { DOMElement } from "ink";

export function terminalBounds(element: DOMElement | null) {
  if (!element?.yogaNode) return undefined;
  let x = 1;
  let y = 1;
  for (let node: DOMElement | undefined = element; node; node = node.parentNode) {
    x += node.yogaNode?.getComputedLeft() || 0;
    y += node.yogaNode?.getComputedTop() || 0;
  }
  return { x, y, width: element.yogaNode.getComputedWidth(), height: element.yogaNode.getComputedHeight() };
}

export function containsTerminalPoint(element: DOMElement | null, x: number, y: number) {
  const bounds = terminalBounds(element);
  return Boolean(bounds && x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height);
}
