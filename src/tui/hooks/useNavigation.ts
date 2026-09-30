import { useState } from "react";
import { useSafeInput as useInput } from "../terminalInput.js";

interface UseNavigationOptions {
  panelCount: number;
  onQuit?: () => void;
}

export function useNavigation({ panelCount, onQuit }: UseNavigationOptions) {
  const [activePanel, setActivePanel] = useState(0);

  useInput((input, key) => {
    if (key.tab || (key.rightArrow && !key.shift)) {
      setActivePanel((p) => (p + 1) % panelCount);
    }
    if (key.shift && key.tab) {
      setActivePanel((p) => (p - 1 + panelCount) % panelCount);
    }
    if (key.leftArrow) {
      setActivePanel((p) => (p - 1 + panelCount) % panelCount);
    }
    if (input === "q" && !key.ctrl) {
      onQuit?.();
    }
  });

  return { activePanel, setActivePanel };
}
