import React, { useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { colors, getBorderStyle, icons } from "../theme.js";
import type { FocusBounds, FocusState } from "../hooks/useFocusNavigation.js";
import { createTerminalControlInputStripper, useSafeInput as useInput } from "../terminalInput.js";
import { BoundedTextInput } from "./BoundedTextInput.js";

export interface PromptOption {
  id: string;
  label: string;
  description?: string;
  sensitive?: boolean;
}

interface PromptCardProps {
  title: string;
  message?: string;
  options?: PromptOption[];
  includeOther?: boolean;
  otherLabel?: string;
  active?: boolean;
  focusState?: FocusState;
  sensitiveInput?: boolean;
  placeholder?: string;
  width?: number;
  maxInputLines?: number;
  scrollBounds?: FocusBounds;
  onSubmit: (value: string, option?: PromptOption) => void;
}

const OTHER_OPTION_ID = "__other__";

export function PromptCard({
  title,
  message,
  options = [],
  includeOther = false,
  otherLabel = "Other...",
  active = false,
  focusState,
  sensitiveInput = false,
  placeholder = "Type a response...",
  width = 80,
  maxInputLines = 3,
  scrollBounds,
  onSubmit,
}: PromptCardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [freeformValue, setFreeformValue] = useState("");
  const suppressNextFreeformPrefix = useRef<string | null>(null);
  const controlStripper = useMemo(() => createTerminalControlInputStripper(), []);
  const focused = active || focusState === "focused";
  const cardWidth = Math.max(14, width);
  const inputWidth = Math.max(1, cardWidth - 6);
  const messageLines = useMemo(() => clampLines(message || "", 5), [message]);
  const visibleOptions = useMemo(
    () => includeOther ? [...options, { id: OTHER_OPTION_ID, label: otherLabel }] : options,
    [includeOther, options, otherLabel],
  );
  const selected = visibleOptions[selectedIndex];
  const isOtherSelected = selected?.id === OTHER_OPTION_ID || visibleOptions.length === 0;

  useInput((input, key) => {
    if (!focused) return;
    const cleanInput = controlStripper.strip(input);

    if (key.tab || key.leftArrow || key.rightArrow) {
      return;
    }

    if (!isOtherSelected && (key.upArrow || key.downArrow)) {
      const delta = key.upArrow ? -1 : 1;
      setSelectedIndex((current) => (current + delta + visibleOptions.length) % visibleOptions.length);
      return;
    }

    if (key.return && !isOtherSelected && selected) {
      onSubmit(selected.sensitive ? selected.id : selected.label, selected);
      return;
    }

    const numericChoice = Number(cleanInput);
    if (Number.isInteger(numericChoice) && numericChoice > 0 && numericChoice <= visibleOptions.length) {
      if (visibleOptions[numericChoice - 1]?.id === OTHER_OPTION_ID) {
        suppressNextFreeformPrefix.current = cleanInput;
      }
      setSelectedIndex(numericChoice - 1);
      return;
    }

    if (!isOtherSelected && (cleanInput === "o" || cleanInput === "O") && includeOther) {
      suppressNextFreeformPrefix.current = cleanInput;
      setSelectedIndex(visibleOptions.length - 1);
      return;
    }

    if (!isOtherSelected && includeOther && cleanInput && !key.return && !key.backspace && !key.delete && !key.escape) {
      setSelectedIndex(visibleOptions.length - 1);
      setFreeformValue((current) => current + stripCoalescedOtherShortcut(cleanInput, visibleOptions.length));
    }
  }, { isActive: focused });

  const submitFreeform = (value: string) => {
    const cleanValue = controlStripper.strip(value).trim();
    if (!cleanValue) return;
    onSubmit(cleanValue);
    setFreeformValue("");
  };

  const handleFreeformChange = (value: string) => {
    const cleanValue = controlStripper.strip(value);
    const suppress = suppressNextFreeformPrefix.current;
    if (suppress && cleanValue.startsWith(suppress)) {
      suppressNextFreeformPrefix.current = null;
      setFreeformValue(cleanValue.slice(suppress.length));
      return;
    }
    suppressNextFreeformPrefix.current = null;
    setFreeformValue(cleanValue);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle={getBorderStyle("panel")}
      borderColor={focused ? colors.borderActive : colors.border}
      paddingX={1}
      width={cardWidth}
      flexShrink={1}
      minWidth={0}
    >
      <Text color={focused ? colors.textBright : colors.heading} bold wrap="truncate">
        {title}
      </Text>
      {messageLines.map((line, index) => (
        <Text key={`${index}-${line}`} color={colors.text} wrap="truncate">
          {line}
        </Text>
      ))}
      {visibleOptions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {visibleOptions.map((option, index) => (
            <PromptOptionLine
              key={option.id}
              option={option}
              index={index}
              selected={index === selectedIndex}
            />
          ))}
        </Box>
      )}
      {isOtherSelected && (
        <Box marginTop={1} borderStyle={getBorderStyle("input")} borderColor={focused ? colors.accent : colors.border} paddingX={1} flexShrink={1} width={Math.max(10, cardWidth - 2)}>
          <Text color={colors.primary}>{icons.arrowRight} </Text>
          <BoundedTextInput
            value={freeformValue}
            onChange={handleFreeformChange}
            onSubmit={submitFreeform}
            focus={focused}
            placeholder={placeholder}
            mask={sensitiveInput ? "•" : undefined}
            width={inputWidth}
            maxLines={maxInputLines}
            scrollBounds={scrollBounds}
          />
        </Box>
      )}
    </Box>
  );
}

function PromptOptionLine({
  option,
  index,
  selected,
}: {
  option: PromptOption;
  index: number;
  selected: boolean;
}) {
  const marker = selected ? icons.arrowRight : " ";
  const color = selected ? colors.accent : colors.textDim;
  const label = option.sensitive ? maskOption(option.label) : option.label;

  return (
    <Box minWidth={0}>
      <Text color={color} bold={selected}>
        {marker} {index + 1}.{" "}
      </Text>
      <Text color={selected ? colors.textBright : colors.text} bold={selected} wrap="truncate">
        {label}
      </Text>
      {option.description && (
        <Text color={colors.textDim} wrap="truncate">
          {" "}· {option.description}
        </Text>
      )}
    </Box>
  );
}

function maskOption(label: string): string {
  if (label.length === 0) return "";
  return "•".repeat(Math.min(12, Math.max(4, label.length)));
}

export function stripCoalescedOtherShortcut(value: string, optionCount: number): string {
  if (optionCount > 0 && value.startsWith(String(optionCount)) && looksLikeEnvAssignment(value.slice(String(optionCount).length))) {
    return value.slice(String(optionCount).length);
  }
  if (/^o[A-Z_][A-Z0-9_]*=/.test(value)) {
    return value.slice(1);
  }
  return value;
}

function looksLikeEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function clampLines(value: string, maxLines: number): string[] {
  if (!value.trim()) return [];
  const lines = value.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more lines in the diary above`];
}
