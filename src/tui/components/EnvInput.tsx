import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { colors, getBorderStyle, icons } from "../theme.js";
import { BoundedTextInput } from "./BoundedTextInput.js";
import type { FocusBounds, FocusState } from "../hooks/useFocusNavigation.js";
import { createTerminalControlInputStripper, useSafeInput as useInput } from "../terminalInput.js";

interface EnvInputProps {
  varKey: string;
  remainingCount: number;
  onSubmit: (value: string) => void;
  onSkip: () => void;
  isSensitive?: boolean;
  focusState?: FocusState;
  width?: number;
  maxLines?: number;
  scrollBounds?: FocusBounds;
}

export function EnvInput({ varKey, remainingCount, onSubmit, onSkip, isSensitive = false, focusState, width, maxLines = 4, scrollBounds }: EnvInputProps) {
  const [value, setValue] = useState("");
  const controlStripper = useMemo(() => createTerminalControlInputStripper(), []);
  const focused = focusState === "focused";
  const boxWidth = Math.max(12, width || 80);
  const inputWidth = Math.max(1, boxWidth - 4);

  useInput((input, key) => {
    if (key.escape) {
      onSkip();
    }
  }, { isActive: focused });

  const handleSubmit = (text: string) => {
    const cleanText = controlStripper.strip(text);
    if (cleanText.trim().length === 0) {
      onSkip();
      setValue("");
      return;
    }
    onSubmit(cleanText);
    setValue("");
  };

  const handleChange = (text: string) => {
    setValue(controlStripper.strip(text));
  };

  const sensitive = isSensitive || varKey.includes("SECRET") || varKey.includes("KEY") || varKey.includes("TOKEN") || varKey.includes("PASSWORD");

  return (
    <Box flexDirection="column" width="100%">
      <Box width={boxWidth} minWidth={0}>
        <Text color={colors.accent}>{icons.arrowRight} </Text>
        <Text color={colors.textBright} bold>{varKey}</Text>
        <Text color={colors.textDim}> (paste key or press Enter to skip — {remainingCount} more vars after this)</Text>
      </Box>
      <Box
        borderStyle={getBorderStyle("input")}
        borderColor={focused ? colors.borderActive : colors.border}
        paddingX={1}
        width={boxWidth}
        flexShrink={1}
      >
        <BoundedTextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          focus={focused}
          placeholder=""
          mask={sensitive ? "•" : undefined}
          width={inputWidth}
          maxLines={maxLines}
          scrollBounds={scrollBounds}
        />
      </Box>
      <Box>
        <Text color={colors.textDim}>[Enter] confirm  [Esc] skip</Text>
      </Box>
    </Box>
  );
}
