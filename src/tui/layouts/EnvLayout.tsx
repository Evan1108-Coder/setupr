import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, type DOMElement } from "ink";
import { containsTerminalPoint } from "../terminalBounds.js";
import { loadEnvEditorState, mergeEnvEditorValues, parseEnvPairs, saveEnvEditorEntries, type EnvEditorEntry, type EnvEditorState } from "../../env/index.js";
import { createSetuprError, errorSummary, fromUnknownError, type SetuprError } from "../../errors/index.js";
import { Panel } from "../components/Panel.js";
import { BoundedTextInput } from "../components/BoundedTextInput.js";
import { MetricText, TooSmallTerminal, TuiFooter, TuiHeader, isTerminalTooSmall } from "../components/TuiFrame.js";
import { useFocusNavigation, type FocusBounds, type FocusItem, type FocusState } from "../hooks/useFocusNavigation.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { colors, getBorderStyle, icons, layout as tuiLayout } from "../theme.js";
import { createTerminalControlInputStripper, parseSgrMouse, stripTerminalControlInput, useSafeInput as useInput } from "../terminalInput.js";

interface EnvLayoutProps {
  cwd: string;
}

interface EnvLayoutGeometry {
  width: number;
  height: number;
  bodyHeight: number;
  summaryHeight: number;
  contentHeight: number;
  stacked: boolean;
  listWidth: number;
  sideWidth: number;
  helperWidth: number;
  detailsHeight: number;
  editorHeight: number;
  explanationHeight: number;
  warningsHeight: number;
  inputMaxLines: number;
  inputBounds: FocusBounds;
  listBounds: FocusBounds;
  detailsBounds: FocusBounds;
  editorBounds: FocusBounds;
  explanationBounds: FocusBounds;
  warningsBounds: FocusBounds;
  summaryWidths: number[];
  visibleRows: number;
}

export function EnvLayout({ cwd }: EnvLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildEnvLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focus = useFocusNavigation({ items: useMemo(() => buildEnvFocusItems(layout), [layout]), initialId: "input", onQuit: () => exit() });
  const [state, setState] = useState<EnvEditorState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<SetuprError | null>(null);

  useEffect(() => {
    let alive = true;
    loadEnvEditorState(cwd)
      .then((next) => {
        if (!alive) return;
        setState(next);
        setSelectedIndex(0);
        setDraft(next.entries[0]?.value || "");
      })
      .catch((err) => {
        if (alive) setError(fromUnknownError(err, { command: "env", cwd }));
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

  const entries = state?.entries || [];
  const selected = entries[selectedIndex] || null;
  const listOffset = Math.max(0, Math.min(selectedIndex - Math.floor(layout.visibleRows / 2), Math.max(0, entries.length - layout.visibleRows)));
  const visibleEntries = entries.slice(listOffset, listOffset + layout.visibleRows);

  useEffect(() => {
    if (!selected) {
      setDraft("");
      setDirty(false);
      return;
    }
    setDraft(selected.value);
    setDirty(false);
  }, [selected?.key]);

  useInput((input, key) => {
    const mouse = parseSgrMouse(input);
    if (mouse?.action === "press" && state && pointInBounds(mouse.x, mouse.y, layout.listBounds)) {
      const nextIndex = listOffset + Math.max(0, mouse.y - layout.listBounds.y - 2);
      if (nextIndex >= 0 && nextIndex < entries.length) setSelectedIndex(nextIndex);
      return;
    }
    if (!state) return;
    if (focus.activeId === "vars") {
      if (input === "j") {
        setSelectedIndex((current) => Math.min(entries.length - 1, current + 1));
        return;
      }
      if (input === "k") {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
    }
    if (key.ctrl && input === "s") {
      void saveDraft();
    }
  });

  const updateEntries = (nextEntries: EnvEditorEntry[], nextSelectedKey?: string) => {
    setState((current) => current ? summarizeState({ ...current, entries: nextEntries, hasEnv: true, source: ".env" }) : current);
    if (nextSelectedKey) {
      const nextIndex = nextEntries.findIndex((entry) => entry.key === nextSelectedKey);
      if (nextIndex >= 0) setSelectedIndex(nextIndex);
    }
  };

  const saveDraft = async (text = draft) => {
    if (!state || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const cleanText = stripTerminalControlInput(text);
      let nextEntries = entries;
      let changed = 0;
      let selectedKey = selected?.key;

      const pastedPairs = parseEnvPairs(cleanText.includes("=") ? cleanText : "");
      if (Object.keys(pastedPairs).length > 0) {
        nextEntries = mergeEnvEditorValues(entries, pastedPairs);
        changed = Object.keys(pastedPairs).length;
        selectedKey = Object.keys(pastedPairs)[0] || selectedKey;
      } else if (selected) {
        nextEntries = mergeEnvEditorValues(entries, { [selected.key]: cleanText });
        changed = 1;
      } else if (cleanText) {
        setError(createSetuprError({
          code: "ENV_CHECK_FAILED",
          command: "env",
          cwd,
          details: ["Empty env files need KEY=value input first."],
          canContinue: true,
        }));
        return;
      }

      await saveEnvEditorEntries(cwd, nextEntries);
      updateEntries(nextEntries, selectedKey);
      setDirty(false);
      setMessage(`Saved ${changed} environment value${changed === 1 ? "" : "s"} to .env.`);
    } catch (err) {
      setError(fromUnknownError(err, { command: "env", cwd, code: "ENV_WRITE_FAILED" }));
    } finally {
      setSaving(false);
    }
  };

  const footer = dirty ? "unsaved" : saving ? "saving..." : message ? "saved" : state ? `${entries.length} vars` : "loading";

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr env" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box key={`${terminal.width}x${terminal.height}`} flexDirection="column" width={terminal.width} height={terminal.height}>
      <TuiHeader command="setupr env" cwd={cwd} status={footer} statusColor={dirty ? colors.warning : error ? colors.error : colors.success} right={footer} width={terminal.width} />

      {!state && !error && (
        <Box flexGrow={1}>
          <Text color={colors.textDim}>Loading .env...</Text>
        </Box>
      )}

      {state && (
        <Box flexDirection="column" height={layout.bodyHeight} width="100%" flexGrow={1} overflow="hidden" gap={layout.stacked ? 0 : tuiLayout.panelGap}>
          {!layout.stacked && (
            <Box flexDirection="row" width="100%" height={layout.summaryHeight} gap={tuiLayout.panelGap}>
              <Panel title="Env File" focusState={focus.focusState("envfile")} width={layout.summaryWidths[0]} height="100%">
                <MetricText value={state.hasEnv ? ".env" : "none"} label={`${entries.length} vars loaded`} color={state.hasEnv ? colors.success : colors.warning} />
              </Panel>
              <Panel title="Template" focusState={focus.focusState("template")} width={layout.summaryWidths[1]} height="100%">
                <MetricText value={state.hasExample ? ".env.example" : "missing"} label="source template" color={state.hasExample ? colors.success : colors.warning} />
              </Panel>
              <Panel title="Missing" focusState={focus.focusState("missing")} width={layout.summaryWidths[2]} height="100%">
                <MetricText value={state.missing.length} label="vars" color={state.missing.length ? colors.error : colors.success} />
              </Panel>
              <Panel title="Sensitive" focusState={focus.focusState("sensitive")} width={layout.summaryWidths[3]} height="100%">
                <MetricText value={entries.filter((entry) => entry.sensitive).length} label="masked values" color={colors.warning} />
              </Panel>
            </Box>
          )}
          <Box flexDirection={layout.stacked ? "column" : "row"} height={layout.contentHeight} width="100%" flexGrow={1} overflow="hidden" gap={tuiLayout.panelGap}>
            <Panel title="Variables" focusState={focus.focusState("vars")} width={layout.stacked ? "100%" : layout.listWidth} height={layout.stacked ? layout.listBounds.height : "100%"}>
              <VariableList entries={visibleEntries} offset={listOffset} selectedIndex={selectedIndex} />
            </Panel>

            <Box flexDirection="column" width={layout.stacked ? "100%" : layout.sideWidth} height={layout.stacked ? layout.detailsHeight + layout.editorHeight + tuiLayout.panelGap : "100%"} gap={tuiLayout.panelGap}>
              <Panel title="Details" focusState={focus.focusState("details")} width="100%" height={layout.detailsHeight}>
                <DetailsPanel state={state} selected={selected} message={message} error={error} compact={layout.stacked} />
              </Panel>
              <Panel title="Editor" focusState={focus.focusState("editor")} width="100%" height={layout.editorHeight}>
                <EditorPanel
                  key={selected?.key || "new"}
                  selected={selected}
                  draft={draft}
                  dirty={dirty}
                  focusState={focus.focusState("input")}
                  width={layout.stacked ? layout.width - 4 : layout.sideWidth - 4}
                  maxLines={layout.inputMaxLines}
                  scrollBounds={layout.inputBounds}
                  onChange={(value) => {
                    setDraft(value);
                    setDirty(true);
                  }}
                  onSubmit={(value) => void saveDraft(value)}
                />
              </Panel>
            </Box>

            {!layout.stacked && (
              <Box flexDirection="column" width={layout.helperWidth} height="100%" gap={tuiLayout.panelGap}>
                <Panel title="Explanation" focusState={focus.focusState("explanation")} width="100%" height={layout.explanationHeight}>
                  <ExplanationPanel selected={selected} state={state} />
                </Panel>
                <Panel title="Warnings" focusState={focus.focusState("warnings")} width="100%" height={layout.warningsHeight}>
                  <WarningsPanel state={state} selected={selected} error={error} />
                </Panel>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {!state && error && (
        <Box flexGrow={1}>
          <Panel title="Env Error" focusState="focused" width="100%" height="100%">
            <Text color={colors.error} wrap="wrap">{errorSummary(error)}</Text>
          </Panel>
        </Box>
      )}

      <TuiFooter width={terminal.width} left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ navigate · Enter save · j/k select · paste KEY=value lines" right={footer} />
    </Box>
  );
}

function VariableList({ entries, offset, selectedIndex }: { entries: EnvEditorEntry[]; offset: number; selectedIndex: number }) {
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={colors.warning}>No variables yet.</Text>
        <Text color={colors.textDim} wrap="wrap">Paste KEY=value lines into the editor and press Enter.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {entries.map((entry, visibleIndex) => {
        const index = offset + visibleIndex;
        const selected = index === selectedIndex;
        return (
          <Text key={`${entry.key}-${index}`} color={selected ? colors.textBright : statusColor(entry.status)} bold={selected} wrap="truncate">
            {selected ? icons.arrowRight : statusIcon(entry.status)} {entry.key}
            <Text color={colors.textDim}> {entry.sensitive && entry.value ? maskValue(entry.value) : entry.value || "(empty)"}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function DetailsPanel({ state, selected, message, error, compact = false }: { state: EnvEditorState; selected: EnvEditorEntry | null; message: string | null; error: SetuprError | null; compact?: boolean }) {
  if (compact) return <Box flexDirection="column" flexShrink={0}>
    <Text wrap="truncate" color={colors.heading}>{selected?.key || "No variable selected"} · {selected?.status || "empty"}</Text>
    <Text wrap="truncate" color={error ? colors.error : colors.textDim}>{error ? `${error.code}: ${error.title}` : message || `${state.missing.length} missing/empty · ${state.hasExample ? ".env.example present" : "no template"}`}</Text>
  </Box>;
  return (
    <Box flexDirection="column">
      <Text color={state.hasEnv ? colors.success : colors.warning}>{state.hasEnv ? "✓ .env present" : "△ .env not loaded"}</Text>
      <Text color={state.hasExample ? colors.success : colors.warning}>{state.hasExample ? "✓ .env.example present" : "△ no .env.example"}</Text>
      <Text color={state.missing.length ? colors.warning : colors.textDim} wrap="truncate">Missing/empty: {state.missing.length ? state.missing.join(", ") : "none"}</Text>
      <Text color={state.extra.length ? colors.info : colors.textDim} wrap="truncate">Extra: {state.extra.length ? state.extra.join(", ") : "none"}</Text>
      {selected && <Text> </Text>}
      {selected && <Text color={colors.heading} bold wrap="truncate">{selected.key}</Text>}
      {selected && <Text color={statusColor(selected.status)}>Status: {selected.status}</Text>}
      {selected?.templateValue && <Text color={colors.textDim} wrap="truncate">Template: {selected.sensitive ? maskValue(selected.templateValue) : selected.templateValue}</Text>}
      {selected?.sensitive && <Text color={colors.warning}>Sensitive value: masked by default.</Text>}
      {message && <Text color={colors.success} wrap="truncate">{message}</Text>}
      {error && <Text color={colors.error} wrap="truncate">{error.code}: {error.title}</Text>}
    </Box>
  );
}

function ExplanationPanel({ state, selected }: { state: EnvEditorState; selected: EnvEditorEntry | null }) {
  if (!selected) {
    return (
      <Box flexDirection="column">
        <Text color={colors.textDim}>Select a variable to view source, sensitivity, and local-development guidance.</Text>
        <Text color={state.hasExample ? colors.success : colors.warning}>
          {state.hasExample ? "Template-driven values are available." : "No template is available."}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.heading} bold wrap="truncate">{selected.key}</Text>
      <Text color={selected.sensitive ? colors.warning : colors.success}>
        {selected.sensitive ? "Sensitive value" : "Normal value"}
      </Text>
      <Text color={colors.textDim} wrap="wrap">
        {selected.sensitive
          ? "Set this from the real service or a local test credential. It is masked in the TUI."
          : "Use a local development value when possible. Paste KEY=value lines to batch-fill related vars."}
      </Text>
      {selected.templateValue && (
        <Text color={colors.label} wrap="truncate">Template: {selected.sensitive ? maskValue(selected.templateValue) : selected.templateValue}</Text>
      )}
    </Box>
  );
}

function WarningsPanel({ state, selected, error }: { state: EnvEditorState; selected: EnvEditorEntry | null; error: SetuprError | null }) {
  const warnings: string[] = [];
  if (!state.hasExample) warnings.push("No .env.example template found.");
  if (state.missing.length > 0) warnings.push(`${state.missing.length} missing or empty vars.`);
  if (selected?.sensitive) warnings.push("Do not commit real credentials.");
  if (state.extra.length > 0) warnings.push(`${state.extra.length} extra vars not in template.`);
  if (error) warnings.push(`${error.code}: ${error.title}`);

  if (warnings.length === 0) return <Text color={colors.success}>✓ Env state looks clean.</Text>;
  return (
    <Box flexDirection="column">
      {warnings.slice(0, 6).map((warning) => (
        <Text key={warning} color={warning.includes("Do not") ? colors.error : colors.warning} wrap="truncate">△ {warning}</Text>
      ))}
    </Box>
  );
}

function EditorPanel({
  selected,
  draft,
  dirty,
  focusState,
  width,
  maxLines,
  scrollBounds,
  onChange,
  onSubmit,
}: {
  selected: EnvEditorEntry | null;
  draft: string;
  dirty: boolean;
  focusState?: FocusState;
  width: number;
  maxLines: number;
  scrollBounds: FocusBounds;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const inputWidth = Math.max(1, width - 6);
  const [revealed, setRevealed] = useState(false);
  const revealButton = useRef<DOMElement>(null);
  const revealControls = useRef(createTerminalControlInputStripper());
  useEffect(() => { if (focusState !== "focused") setRevealed(false); }, [focusState]);
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(false), 30000);
    return () => clearTimeout(timer);
  }, [revealed]);
  useInput((input, key, raw) => {
    if (!selected?.sensitive) return;
    const chunk = revealControls.current.read(raw);
    if (chunk.paste) return;
    if ((focusState === "focused" && key.ctrl && input === "r") ||
      chunk.mouse.some(mouse => mouse.code === 0 && mouse.action === "press" && containsTerminalPoint(revealButton.current, mouse.x, mouse.y))) {
      setRevealed((value) => !value);
    }
  });
  return (
    <Box flexDirection="column" width="100%" height="100%" justifyContent="flex-end">
      <Box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" flexDirection="column">
        <Box flexDirection="column" flexShrink={0}>
          <Text color={colors.textBright} bold wrap="truncate">{selected ? selected.key : "New variable"}</Text>
          <Text color={colors.textDim} wrap="wrap">
            {selected
              ? "Edit the value below. Paste KEY=value lines to update several variables at once."
              : "Paste KEY=value lines below to create variables."}
          </Text>
          {dirty && <Text color={colors.warning}>Unsaved changes. Press Enter to save.</Text>}
        </Box>
      </Box>
      {selected?.sensitive && <Box flexShrink={0} height={1} justifyContent="flex-end">
        <Box ref={revealButton}><Text color={colors.primary} underline>{revealed ? "Hide" : "Show"} (Ctrl+R)</Text></Box>
      </Box>}
      <Box borderStyle={getBorderStyle("input")} borderColor={focusState === "focused" ? colors.borderActive : colors.border} paddingX={1} width={Math.max(12, width)} flexShrink={0}>
        <Text color={colors.primary}>{icons.arrowRight} </Text>
        <BoundedTextInput
          value={draft}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focusState === "focused"}
          placeholder={selected ? "value" : "KEY=value"}
          mask={selected?.sensitive && !(revealed && focusState === "focused") ? "•" : undefined}
          width={inputWidth}
          maxLines={maxLines}
          scrollBounds={scrollBounds}
        />
      </Box>
    </Box>
  );
}

export function buildEnvLayout(width: number, height: number): EnvLayoutGeometry {
  const bodyHeight = Math.max(8, height - 2);
  const stacked = width < 96 || bodyHeight < 20;
  const gap = tuiLayout.panelGap;
  const summaryHeight = stacked ? 0 : clamp(Math.floor(bodyHeight * 0.18), 5, 6);
  const contentHeight = Math.max(8, bodyHeight - summaryHeight - (stacked ? 0 : gap));
  if (stacked) {
    const compact = bodyHeight < 20;
    const available = Math.max(8, bodyHeight - gap * 2);
    const editorHeight = compact
      ? 7
      : clamp(Math.floor(bodyHeight * 0.34), 7, Math.max(7, Math.floor(bodyHeight * 0.42)));
    const inputMaxLines = clamp(Math.floor(editorHeight / 4), 1, 4);
    const detailsHeight = compact
      ? Math.max(3, available - editorHeight - 5)
      : clamp(Math.floor(bodyHeight * 0.28), 6, Math.max(6, bodyHeight - editorHeight - 5));
    const listHeight = Math.max(compact ? 4 : 5, bodyHeight - detailsHeight - editorHeight - gap * 2);
    const inputY = Math.max(4, height - inputMaxLines - 2);
    return {
      width,
      height,
      bodyHeight,
      summaryHeight,
      contentHeight: bodyHeight,
      stacked,
      listWidth: width,
      sideWidth: width,
      helperWidth: width,
      detailsHeight,
      editorHeight,
      explanationHeight: 0,
      warningsHeight: 0,
      inputMaxLines,
      inputBounds: { x: 4, y: inputY, width: Math.max(8, width - 10), height: inputMaxLines + 2 },
      listBounds: { x: 1, y: 2, width, height: listHeight },
      detailsBounds: { x: 1, y: 2 + listHeight + gap, width, height: detailsHeight },
      editorBounds: { x: 1, y: 2 + listHeight + detailsHeight + gap * 2, width, height: editorHeight },
      explanationBounds: { x: 1, y: 2, width: 0, height: 0 },
      warningsBounds: { x: 1, y: 2, width: 0, height: 0 },
      summaryWidths: [],
      visibleRows: Math.max(1, listHeight - 3),
    };
  }
  const editorHeight = Math.max(10, Math.floor(contentHeight * 0.28));
  const inputMaxLines = clamp(Math.floor(editorHeight / 4), 1, 4);
  const listWidth = Math.max(30, Math.floor(width * 0.30));
  const helperWidth = clamp(Math.floor(width * 0.26), 28, 40);
  const sideWidth = Math.max(24, width - listWidth - helperWidth - gap * 2);
  const detailsHeight = Math.max(8, contentHeight - editorHeight - gap);
  const helperContentHeight = Math.max(8, contentHeight - gap);
  const explanationHeight = clamp(Math.floor(helperContentHeight * 0.56), 8, Math.max(8, helperContentHeight - 5));
  const warningsHeight = Math.max(5, helperContentHeight - explanationHeight);
  const inputY = Math.max(4, 2 + summaryHeight + detailsHeight + editorHeight - inputMaxLines - 2);
  return {
    width,
    height,
    bodyHeight,
    summaryHeight,
    contentHeight,
    stacked,
    listWidth,
    sideWidth,
    helperWidth,
    detailsHeight,
    editorHeight,
    explanationHeight,
    warningsHeight,
    inputMaxLines,
    inputBounds: { x: listWidth + 4, y: inputY, width: Math.max(8, sideWidth - 10), height: inputMaxLines + 2 },
    listBounds: { x: 1, y: 2 + summaryHeight, width: listWidth, height: contentHeight },
    detailsBounds: { x: listWidth + gap + 1, y: 2 + summaryHeight + gap, width: sideWidth, height: detailsHeight },
    editorBounds: { x: listWidth + gap + 1, y: 2 + summaryHeight + detailsHeight + gap * 2, width: sideWidth, height: editorHeight },
    explanationBounds: { x: listWidth + sideWidth + gap * 2 + 1, y: 2 + summaryHeight + gap, width: helperWidth, height: explanationHeight },
    warningsBounds: { x: listWidth + sideWidth + gap * 2 + 1, y: 2 + summaryHeight + explanationHeight + gap * 2, width: helperWidth, height: warningsHeight },
    summaryWidths: distributeWidths(Math.max(1, width - gap * 3), [1, 1, 1, 1], [20, 20, 18, 18]),
    visibleRows: Math.max(1, contentHeight - 3),
  };
}

export function buildEnvFocusItems(layout: EnvLayoutGeometry): FocusItem[] {
  if (layout.stacked) {
    return [
      { id: "vars", row: 0, column: 0, bounds: layout.listBounds },
      { id: "details", row: 1, column: 0, bounds: layout.detailsBounds },
      { id: "editor", row: 2, column: 0, redirectTo: "input", bounds: layout.editorBounds },
      { id: "input", row: 3, column: 0, parentIds: ["editor"], bounds: layout.inputBounds },
    ];
  }
  return [
    { id: "envfile", row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.summaryWidths[0], height: layout.summaryHeight } },
    { id: "template", row: 0, column: 1, bounds: { x: layout.summaryWidths[0] + tuiLayout.panelGap + 1, y: 2, width: layout.summaryWidths[1], height: layout.summaryHeight } },
    { id: "missing", row: 0, column: 2, bounds: { x: layout.summaryWidths[0] + layout.summaryWidths[1] + tuiLayout.panelGap * 2 + 1, y: 2, width: layout.summaryWidths[2], height: layout.summaryHeight } },
    { id: "sensitive", row: 0, column: 3, bounds: { x: layout.summaryWidths[0] + layout.summaryWidths[1] + layout.summaryWidths[2] + tuiLayout.panelGap * 3 + 1, y: 2, width: layout.summaryWidths[3], height: layout.summaryHeight } },
    { id: "vars", row: 1, column: 0, bounds: layout.listBounds },
    { id: "details", row: 1, column: 1, bounds: layout.detailsBounds },
    { id: "editor", row: 2, column: 1, redirectTo: "input", bounds: layout.editorBounds },
    { id: "input", row: 3, column: 1, parentIds: ["editor"], bounds: layout.inputBounds },
    { id: "explanation", row: 1, column: 2, bounds: layout.explanationBounds },
    { id: "warnings", row: 2, column: 2, bounds: layout.warningsBounds },
  ];
}

function summarizeState(state: EnvEditorState): EnvEditorState {
  return {
    ...state,
    missing: state.entries.filter((entry) => entry.status === "missing" || entry.status === "empty").map((entry) => entry.key),
    extra: state.entries.filter((entry) => entry.status === "extra").map((entry) => entry.key),
  };
}

function statusColor(status: EnvEditorEntry["status"]): string {
  if (status === "filled") return colors.success;
  if (status === "extra") return colors.info;
  return colors.warning;
}

function statusIcon(status: EnvEditorEntry["status"]): string {
  if (status === "filled") return icons.check;
  if (status === "extra") return icons.info;
  return icons.warning;
}

function maskValue(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

function pointInBounds(x: number, y: number, bounds: FocusBounds): boolean {
  return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distributeWidths(total: number, weights: number[], mins: number[]): number[] {
  const minTotal = mins.reduce((sum, item) => sum + item, 0);
  if (total <= minTotal) return fitWidths(total, mins.length);
  const extra = total - minTotal;
  const weightTotal = weights.reduce((sum, item) => sum + item, 0);
  const widths = mins.map((min, index) => min + Math.floor(extra * (weights[index] / weightTotal)));
  widths[widths.length - 1] += total - widths.reduce((sum, item) => sum + item, 0);
  return widths;
}

function fitWidths(total: number, count: number): number[] {
  const base = Math.max(1, Math.floor(total / count));
  const widths = Array.from({ length: count }, () => base);
  widths[widths.length - 1] += total - widths.reduce((sum, item) => sum + item, 0);
  return widths;
}
