import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { ChatInput } from "../components/ChatInput.js";
import { EnvInput } from "../components/EnvInput.js";
import { Panel } from "../components/Panel.js";
import { PromptCard } from "../components/PromptCard.js";
import { TooSmallTerminal, TuiFooter, TuiHeader, isTerminalTooSmall } from "../components/TuiFrame.js";
import { Timeline, type TimelineEvent } from "../components/Timeline.js";
import { useAppStore } from "../hooks/useStore.js";
import { useFocusNavigation, type FocusBounds, type FocusItem } from "../hooks/useFocusNavigation.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useAiRequest } from "../hooks/useAiRequest.js";
import { colors, icons, layout as tuiLayout } from "../theme.js";
import { hasProjectSignals } from "../projectSignals.js";
import type { AgentPrompt, AppMessage, AppStore, LogEntry, NoticeInfo } from "../../state/store.js";
import { handleDirectorInput } from "../../ai/director.js";
import { sanitizeForAI } from "../../ai/directorContext.js";
import { contextToDSL } from "../../ai/dsl.js";
import * as os from "os";

interface SetupLayoutProps {
  store: AppStore;
}

export function SetupLayout({ store }: SetupLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();

  const steps = useAppStore(store, (s) => s.steps);
  const scan = useAppStore(store, (s) => s.scan);
  const isComplete = useAppStore(store, (s) => s.isComplete);
  const currentStepIndex = useAppStore(store, (s) => s.currentStepIndex);
  const logs = useAppStore(store, (s) => s.logs);
  const messages = useAppStore(store, (s) => s.messages);
  const pendingPrompt = useAppStore(store, (s) => s.pendingPrompt);
  const envVars = useAppStore(store, (s) => s.envVars);
  const envPromptKey = useAppStore(store, (s) => s.envPromptKey);
  const ports = useAppStore(store, (s) => s.ports);
  const keyDeps = useAppStore(store, (s) => s.keyDeps);
  const services = useAppStore(store, (s) => s.services);
  const notices = useAppStore(store, (s) => s.notices);
  const checkpointSaved = useAppStore(store, (s) => s.checkpointSaved);
  const totalPackages = useAppStore(store, (s) => s.totalPackages);
  const installedPackages = useAppStore(store, (s) => s.installedPackages);
  const deprecatedCount = useAppStore(store, (s) => s.deprecatedCount);
  const vulnerabilities = useAppStore(store, (s) => s.vulnerabilities);
  const lockSynced = useAppStore(store, (s) => s.lockSynced);
  const projectName = useAppStore(store, (s) => s.projectName);

  const [elapsed, setElapsed] = useState(0);
  const ai = useAiRequest({
    onError: (error) => store.getState().addMessage({ role: "assistant", content: `AI request failed: ${sanitizeForAI(error instanceof Error ? error.message : "Unknown error")}. You can retry your message.` }),
    onCancel: () => store.getState().addMessage({ role: "system", content: "AI reply cancelled. Setup execution was not cancelled; you can send another message." }),
  });

  useEffect(() => {
    const start = store.getState().startTime;
    const timer = setInterval(() => {
      setElapsed(Date.now() - start);
    }, 1000);
    return () => clearInterval(timer);
  }, [store]);

  const layout = useMemo(() => buildLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focusItems = useMemo(() => buildFocusItems(layout), [layout]);
  const focus = useFocusNavigation({
    items: focusItems,
    onQuit: () => exit(),
  });

  useEffect(() => {
    if (envPromptKey || pendingPrompt) focus.setActiveId("input");
  }, [envPromptKey, pendingPrompt]);

  const handleChat = useCallback(async (text: string) => {
    await ai.run(async (request) => {
      store.getState().addMessage({ role: "user", content: sanitizeForAI(text) });
      const state = store.getState();
      if (state.scan && state.context) {
        const dsl = contextToDSL(state.context);
        await handleDirectorInput({
          text,
          cwd: state.cwd,
          scan: state.scan,
          contextDSL: dsl,
          store,
          ...request,
        });
      } else {
        store.getState().addMessage({
          role: "assistant",
          content: state.scan && !hasProjectSignals(state.scan)
            ? "No project files were detected in this directory. Open a project folder or run setupr setup --cwd <project-folder>. No instruction has been executed."
            : "Project context is still loading. Please send your message again when scanning finishes; no instruction has been executed.",
        });
      }
    });
  }, [store, ai.run]);

	  const handleEnvSubmit = useCallback((value: string) => {
	    const key = store.getState().envPromptKey;
	    if (!key) return;
	    const vars = store.getState().envVars.map((v) =>
	      v.key === key ? { ...v, value, status: "filled" as const } : v
	    );
	    store.getState().setEnvVars(vars);
	    store.getState().addLog({ content: `✓ ${key} = ${formatManualEnvLogValue(key, value)} (manual)`, type: "success" });
	    const nextPending = vars.find((v) => v.status === "pending");
	    store.getState().setEnvPrompt(nextPending?.key || null);
	  }, [store]);

  const handleEnvSkip = useCallback(() => {
    const key = store.getState().envPromptKey;
    if (!key) return;
    const vars = store.getState().envVars.map((v) =>
      v.key === key ? { ...v, status: "skipped" as const } : v
    );
    store.getState().setEnvVars(vars);
    store.getState().addLog({ content: `○ ${key} - skipped`, type: "info" });
    const nextPending = vars.find((v) => v.status === "pending");
    store.getState().setEnvPrompt(nextPending?.key || null);
  }, [store]);

  const handlePromptSubmit = useCallback((value: string, option?: { id: string }) => {
    const prompt = store.getState().pendingPrompt;
    if (!prompt) return;
    store.getState().answerPrompt({
      promptId: prompt.id,
      value,
      optionId: option?.id,
    });
  }, [store]);

  const currentStep = steps[currentStepIndex];
  const noProject = scan !== null && !hasProjectSignals(scan);
  const stack = buildStackString(scan);
  const stepLabel = noProject ? "No project detected" : isComplete ? "Complete" : (currentStep?.label || "Scanning");
  const doneCount = steps.filter((s) => s.status === "done").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const autoFilled = envVars.filter((v) => v.status === "auto" || v.status === "filled").length;
  const needInput = envVars.filter((v) => v.status === "pending").length;
  const remainingEnv = envVars.filter((v) => v.status === "pending").length;

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr setup" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <Header
        cwd={store.getState().cwd}
        elapsed={elapsed}
        stack={stack}
        status={stepLabel}
        checkpointSaved={checkpointSaved}
        failedCount={failedCount}
        isComplete={isComplete}
        noProject={noProject}
        width={terminal.width}
      />

      {layout.stacked ? (
        <StackedSetup
          layout={layout}
          focus={focus.focusState}
          projectName={projectName}
          cwd={store.getState().cwd}
          scan={scan}
          steps={steps}
          logs={logs}
          messages={messages}
          noProject={noProject}
          currentStepIndex={currentStepIndex}
          currentStepLabel={stepLabel}
          totalPackages={totalPackages}
          installedPackages={installedPackages}
          envVars={envVars}
          autoFilled={autoFilled}
          needInput={needInput}
          ports={ports}
          keyDeps={keyDeps}
          notices={notices}
          pendingPrompt={pendingPrompt}
          envPromptKey={envPromptKey}
          remainingEnv={remainingEnv}
          onEnvSubmit={handleEnvSubmit}
          onEnvSkip={handleEnvSkip}
          onPromptSubmit={handlePromptSubmit}
          chatActive={focus.isActive("input")}
          onChat={handleChat}
          chatPending={ai.pending}
          chatProgress={ai.label}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
        />
      ) : (
        <WideSetup
          layout={layout}
          focus={focus.focusState}
          projectName={projectName}
          cwd={store.getState().cwd}
          scan={scan}
          steps={steps}
          logs={logs}
          messages={messages}
          noProject={noProject}
          currentStepIndex={currentStepIndex}
          currentStepLabel={stepLabel}
          doneCount={doneCount}
          failedCount={failedCount}
          totalPackages={totalPackages}
          installedPackages={installedPackages}
          deprecatedCount={deprecatedCount}
          vulnerabilities={vulnerabilities}
          lockSynced={lockSynced}
          envVars={envVars}
          autoFilled={autoFilled}
          needInput={needInput}
          ports={ports}
          keyDeps={keyDeps}
          services={services}
          notices={notices}
          pendingPrompt={pendingPrompt}
          envPromptKey={envPromptKey}
          remainingEnv={remainingEnv}
          onEnvSubmit={handleEnvSubmit}
          onEnvSkip={handleEnvSkip}
          onPromptSubmit={handlePromptSubmit}
          chatActive={focus.isActive("input")}
          onChat={handleChat}
          chatPending={ai.pending}
          chatProgress={ai.label}
          inputMaxLines={inputLinesForPanel(layout.mainHeight)}
          inputWidth={layout.mainWidth}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
        />
      )}

      <Footer width={terminal.width} />
    </Box>
  );
}

interface Layout {
  width: number;
  height: number;
  stacked: boolean;
  infoHeight: number;
  mainHeight: number;
  footerY: number;
  infoWidths: number[];
  mainWidth: number;
  sideWidth: number;
}

export function buildLayout(width: number, height: number): Layout {
  const stacked = width < 118 || height < 24;
  const gap = tuiLayout.panelGap;
  const infoHeight = stacked ? 0 : clamp(Math.floor(height * 0.27), 8, 12);
  const footerY = height;
  const mainHeight = Math.max(8, height - infoHeight - 2 - (stacked ? 0 : gap));
  const pairTotal = stacked ? width : Math.max(1, width - gap);
  const sideWidth = stacked ? width : clamp(Math.floor(width * 0.26), 28, 42);
  const mainWidth = stacked ? width : pairTotal - sideWidth;
  const infoWidths = stacked
    ? []
    : distributeWidths(Math.max(1, width - gap * 5), [1.1, 1.05, 1.15, 1, 1, 1.3], [20, 20, 22, 20, 20, 24]);

  return { width, height, stacked, infoHeight, mainHeight, footerY, infoWidths, mainWidth, sideWidth };
}

export function buildFocusItems(layout: Layout): FocusItem[] {
  if (layout.stacked) {
    const { projectHeight, stepHeight, diaryHeight, noticesHeight } = stackedSectionHeights(layout.height);
    const projectY = 2;
    const stepsY = projectY + projectHeight;
    const diaryY = stepsY + stepHeight;
    const noticesY = diaryY + diaryHeight;
    const inputHeight = inputBoundsHeightForPanel(diaryHeight);
    const inputY = Math.max(diaryY + 2, diaryY + diaryHeight - inputHeight - 1);

    return [
      { id: "project", row: 0, column: 0, bounds: { x: 1, y: projectY, width: layout.width, height: projectHeight } },
      { id: "steps", row: 1, column: 0, bounds: { x: 1, y: stepsY, width: layout.width, height: stepHeight } },
      { id: "diary", row: 2, column: 0, redirectTo: "input", bounds: { x: 1, y: diaryY, width: layout.width, height: diaryHeight } },
      { id: "input", row: 3, column: 0, parentIds: ["diary"], bounds: { x: 3, y: inputY, width: layout.width - 4, height: inputHeight } },
      { id: "side", row: 4, column: 0, bounds: { x: 1, y: noticesY, width: layout.width, height: noticesHeight } },
    ];
  }

  const [stepsW, projectW, depsW, envW, servicesW, currentW] = layout.infoWidths;
  const infoY = 2;
  const mainY = 2 + layout.infoHeight + tuiLayout.panelGap;
  const inputHeight = inputBoundsHeightForPanel(layout.mainHeight);
  const inputY = Math.max(mainY + 3, layout.height - inputHeight - 1);
  const sideX = layout.mainWidth + tuiLayout.panelGap + 1;

  let x = 1;
  const items: FocusItem[] = [
    { id: "steps", row: 0, column: 0, bounds: { x, y: infoY, width: stepsW, height: layout.infoHeight } },
  ];
  x += stepsW + tuiLayout.panelGap;
  items.push({ id: "project", row: 0, column: 1, bounds: { x, y: infoY, width: projectW, height: layout.infoHeight } });
  x += projectW + tuiLayout.panelGap;
  items.push({ id: "deps", row: 0, column: 2, bounds: { x, y: infoY, width: depsW, height: layout.infoHeight } });
  x += depsW + tuiLayout.panelGap;
  items.push({ id: "env", row: 0, column: 3, bounds: { x, y: infoY, width: envW, height: layout.infoHeight } });
  x += envW + tuiLayout.panelGap;
  items.push({ id: "services", row: 0, column: 4, bounds: { x, y: infoY, width: servicesW, height: layout.infoHeight } });
  x += servicesW + tuiLayout.panelGap;
  items.push({ id: "current", row: 0, column: 5, bounds: { x, y: infoY, width: currentW, height: layout.infoHeight } });
  items.push({ id: "diary", row: 1, column: 0, redirectTo: "input", bounds: { x: 1, y: mainY, width: layout.mainWidth, height: layout.mainHeight } });
  items.push({ id: "input", row: 2, column: 0, parentIds: ["diary"], bounds: { x: 3, y: inputY, width: layout.mainWidth - 4, height: inputHeight } });
  items.push({ id: "side", row: 1, column: 1, bounds: { x: sideX, y: mainY, width: layout.sideWidth, height: layout.mainHeight } });
  return items;
}

function Header({
  cwd,
  elapsed,
  stack,
  status,
  checkpointSaved,
  failedCount,
  isComplete,
  noProject,
  width,
}: {
  cwd: string;
  elapsed: number;
  stack: string;
  status: string;
  checkpointSaved: boolean;
  failedCount: number;
  isComplete: boolean;
  noProject: boolean;
  width: number;
}) {
  const statusColor = noProject ? colors.warning : isComplete ? colors.success : failedCount > 0 ? colors.error : colors.text;
  return (
    <TuiHeader
      command="setupr setup"
      cwd={cwd}
      stack={stack}
      status={status}
      statusColor={statusColor}
      right={`${status}  ${formatTime(elapsed)}${checkpointSaved ? "  checkpoint saved" : ""}`}
      width={width}
    />
  );
}

function WideSetup(props: WideSetupProps) {
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.infoHeight + props.layout.mainHeight + tuiLayout.panelGap} gap={tuiLayout.panelGap}>
      <Box flexDirection="row" width={props.layout.width} height={props.layout.infoHeight} gap={tuiLayout.panelGap}>
        <Panel title="STEPS" focusState={props.focus("steps")} width={props.layout.infoWidths[0]} height="100%">
          <StepList steps={props.steps} noProject={props.noProject} limit={props.layout.infoHeight - 3} />
        </Panel>
        <Panel title="PROJECT" focusState={props.focus("project")} width={props.layout.infoWidths[1]} height="100%">
          <ProjectInfo projectName={props.projectName} cwd={props.cwd} scan={props.scan} noProject={props.noProject} />
        </Panel>
        <Panel title="DEPENDENCIES" focusState={props.focus("deps")} width={props.layout.infoWidths[2]} height="100%">
          <KVRow label="Total" value={props.noProject ? "—" : String(props.totalPackages)} />
          <KVRow label="Installed" value={props.noProject ? "—" : `${props.installedPackages}/${props.totalPackages}`} />
          <KVRow label="Deprecated" value={props.noProject ? "—" : String(props.deprecatedCount)} color={props.deprecatedCount > 0 ? colors.warning : undefined} />
          <KVRow label="Audit" value={props.noProject ? "—" : vulnStr(props.vulnerabilities)} color={props.vulnerabilities.high > 0 ? colors.error : colors.warning} />
          <KVRow label="Lock" value={props.lockSynced ? "synced" : "—"} color={props.lockSynced ? colors.success : undefined} />
        </Panel>
        <Panel title="ENVIRONMENT" focusState={props.focus("env")} width={props.layout.infoWidths[3]} height="100%">
          <KVRow label="Vars" value={props.noProject ? "—" : String(props.envVars.length)} />
          <KVRow label="Filled" value={props.noProject ? "—" : String(props.autoFilled)} />
          <KVRow label="Need" value={props.noProject ? "—" : String(props.needInput)} color={props.needInput > 0 ? colors.warning : undefined} />
          <KVRow label=".env" value={props.envVars.length > 0 ? "ready" : "—"} color={props.envVars.length > 0 ? colors.success : undefined} />
        </Panel>
        <Panel title="SERVICES" focusState={props.focus("services")} width={props.layout.infoWidths[4]} height="100%">
          {props.services.length > 0 ? props.services.slice(0, props.layout.infoHeight - 3).map((svc) => (
            <Box key={svc.name} justifyContent="space-between" width="100%" minWidth={0}>
              <Box flexShrink={1} minWidth={0} marginRight={1}>
                <Text color={colors.label} wrap="truncate">{svc.name}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={svc.status === "ready" || svc.status === "running" ? colors.success : svc.status === "starting" ? colors.warning : colors.textDim} wrap="truncate">{svc.status}</Text>
              </Box>
            </Box>
          )) : <Text color={colors.textDim}>{props.noProject ? "No project" : "None detected"}</Text>}
        </Panel>
        <Panel title="CURRENT" focusState={props.focus("current")} width={props.layout.infoWidths[5]} height="100%">
          <KVRow label="Step" value={props.noProject ? "—" : `${props.currentStepIndex + 1}/${props.steps.length || "?"}`} />
          <Text color={props.noProject ? colors.warning : colors.text} wrap="truncate">{props.currentStepLabel}</Text>
          <KVRow label="Done" value={props.noProject ? "—" : String(props.doneCount)} color={props.doneCount > 0 ? colors.success : undefined} />
          <KVRow label="Failed" value={props.noProject ? "—" : String(props.failedCount)} color={props.failedCount > 0 ? colors.error : undefined} />
        </Panel>
      </Box>

      <Box flexDirection="row" width={props.layout.width} flexGrow={1} minHeight={8} gap={tuiLayout.panelGap}>
        <DiaryPanel
          width={props.layout.mainWidth}
          focus={props.focus}
          logs={props.logs}
          messages={props.messages}
          notices={props.notices}
          noProject={props.noProject}
          currentStepLabel={props.currentStepLabel}
          pendingPrompt={props.pendingPrompt}
          envPromptKey={props.envPromptKey}
          remainingEnv={props.remainingEnv}
          onEnvSubmit={props.onEnvSubmit}
          onEnvSkip={props.onEnvSkip}
          onPromptSubmit={props.onPromptSubmit}
          chatActive={props.chatActive}
          onChat={props.onChat}
          chatPending={props.chatPending}
          chatProgress={props.chatProgress}
          inputMaxLines={props.inputMaxLines}
          inputWidth={Math.max(12, props.inputWidth - 4)}
          inputBounds={props.inputBounds}
          maxLogLines={Math.max(1, props.layout.mainHeight - props.inputMaxLines - 5)}
        />
        <SetupSideRail
          width={props.layout.sideWidth}
          focusState={props.focus("side")}
          height={props.layout.mainHeight}
          ports={props.ports}
          keyDeps={props.keyDeps}
          notices={props.notices}
          noProject={props.noProject}
        />
      </Box>
    </Box>
  );
}

function StackedSetup(props: StackedSetupProps) {
  const { projectHeight, stepHeight, diaryHeight, noticesHeight } = stackedSectionHeights(props.layout.height);
  const inputMaxLines = inputLinesForPanel(diaryHeight);
  const maxLogLines = Math.max(1, diaryHeight - inputMaxLines - 5);

  return (
    <>
      <Panel title="PROJECT" focusState={props.focus("project")} width="100%" height={projectHeight}>
        {projectHeight <= 5 ? (
          <CompactProjectInfo projectName={props.projectName} cwd={props.cwd} scan={props.scan} noProject={props.noProject} rows={projectHeight - 3} />
        ) : (
          <ProjectInfo projectName={props.projectName} cwd={props.cwd} scan={props.scan} noProject={props.noProject} />
        )}
      </Panel>
      <Panel title="STEPS" focusState={props.focus("steps")} width="100%" height={stepHeight}>
        <StepList steps={props.steps} noProject={props.noProject} limit={stepHeight - 3} />
      </Panel>
      <DiaryPanel
        width="100%"
        flexGrow={1}
        focus={props.focus}
        logs={props.logs}
        messages={props.messages}
        notices={props.notices}
        noProject={props.noProject}
        currentStepLabel={props.currentStepLabel}
        pendingPrompt={props.pendingPrompt}
        envPromptKey={props.envPromptKey}
        remainingEnv={props.remainingEnv}
        onEnvSubmit={props.onEnvSubmit}
        onEnvSkip={props.onEnvSkip}
        onPromptSubmit={props.onPromptSubmit}
        chatActive={props.chatActive}
        onChat={props.onChat}
        chatPending={props.chatPending}
        chatProgress={props.chatProgress}
        inputMaxLines={inputMaxLines}
        inputWidth={Math.max(12, props.layout.width - 4)}
        inputBounds={props.inputBounds}
        maxLogLines={maxLogLines}
      />
      <Panel title="NOTICES" focusState={props.focus("side")} width="100%" height={noticesHeight}>
        <SideDetails ports={props.ports} keyDeps={props.keyDeps} notices={props.notices} noProject={props.noProject} compact />
      </Panel>
    </>
  );
}

function DiaryPanel({
  width,
  flexGrow,
  focus,
  logs,
  messages,
  notices,
  noProject,
  currentStepLabel,
  pendingPrompt,
  envPromptKey,
  remainingEnv,
  onEnvSubmit,
  onEnvSkip,
  onPromptSubmit,
  chatActive,
  onChat,
  chatPending,
  chatProgress,
  inputMaxLines,
  inputWidth,
  inputBounds,
  maxLogLines,
}: DiaryPanelProps) {
  const events = useMemo(
    () => buildTimelineEvents(logs, messages, notices, noProject),
    [logs, messages, notices, noProject]
  );
  const promptActive = Boolean(pendingPrompt && focus("input") === "focused");

  return (
    <Panel title="TERMINAL DIARY" focusState={focus("diary")} width={width} flexGrow={flexGrow} height={flexGrow ? undefined : "100%"}>
      <Box flexDirection="column" flexGrow={1}>
        <Box marginBottom={0}>
          <Text color={noProject ? colors.warning : colors.accent} bold wrap="truncate">
            {noProject ? "No project files detected in this directory" : currentStepLabel}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
          <Timeline
            fill
            events={events}
            maxItems={maxLogLines}
            active={focus("diary") !== undefined}
            width={typeof inputWidth === "number" ? inputWidth : 80}
            emptyText={noProject ? "Nothing to run here." : "Waiting for execution to begin..."}
          />
        </Box>
        <Box flexShrink={0}>
          {pendingPrompt ? (
            <PromptCard
              title={pendingPrompt.title}
              message={pendingPrompt.message}
              options={pendingPrompt.options}
              includeOther={pendingPrompt.includeOther}
              otherLabel={pendingPrompt.otherLabel}
              sensitiveInput={pendingPrompt.sensitive || pendingPrompt.type === "secret"}
              placeholder={pendingPrompt.placeholder}
              active={promptActive}
              focusState={focus("input")}
              onSubmit={onPromptSubmit}
              width={inputWidth}
              maxInputLines={inputMaxLines}
              scrollBounds={inputBounds}
            />
          ) : envPromptKey ? (
            <EnvInput
              varKey={envPromptKey}
              remainingCount={remainingEnv - 1}
              onSubmit={onEnvSubmit}
              onSkip={onEnvSkip}
              focusState={focus("input")}
              width={inputWidth}
              maxLines={inputMaxLines}
              scrollBounds={inputBounds}
            />
          ) : (
            <ChatInput
              active={chatActive}
              focusState={focus("input")}
              onSubmit={onChat}
              disabled={chatPending}
              disabledText={chatProgress}
              placeholder={noProject ? "Open a project folder, then run setup again..." : "Ask anything or paste a value..."}
              width={inputWidth}
              maxLines={inputMaxLines}
              scrollBounds={inputBounds}
            />
          )}
        </Box>
      </Box>
    </Panel>
  );
}

function StepList({ steps, noProject, limit }: { steps: Array<{ id: string; label: string; status: string }>; noProject: boolean; limit: number }) {
  if (noProject) {
    return <Text color={colors.textDim}>No setup plan because this folder has no project signals.</Text>;
  }
  if (steps.length === 0) {
    return <Text color={colors.textDim}>Scanning...</Text>;
  }
  if (limit <= 1) {
    const step = steps.find(item => item.status === "running" || item.status === "failed") || steps.at(-1)!;
    return <Text color={step.status === "failed" ? colors.error : colors.text} wrap="truncate">{step.label} ({steps.filter(item => item.status === "done").length}/{steps.length} done)</Text>;
  }
  const visible = Math.max(1, steps.length > limit ? limit - 1 : limit);
  return (
    <>
      {steps.slice(0, visible).map((step) => {
        const icon = step.status === "done" ? icons.check
          : step.status === "running" ? icons.arrowRight
          : step.status === "failed" ? icons.cross
          : icons.circle;
        const col = step.status === "done" ? colors.success
          : step.status === "running" ? colors.accent
          : step.status === "failed" ? colors.error
          : colors.textDim;
        return (
          <Text key={step.id} color={col} wrap="truncate">
            {icon} {step.label}
          </Text>
        );
      })}
      {steps.length > visible && <Text color={colors.textDim}>… {steps.length - visible} more</Text>}
    </>
  );
}

function ProjectInfo({
  projectName,
  cwd,
  scan,
  noProject,
}: {
  projectName: string;
  cwd: string;
  scan: { framework?: string | null; language?: string | null; packageManager?: string | null } | null;
  noProject: boolean;
}) {
  if (noProject) {
    return (
      <>
        <Text color={colors.warning} bold>No project detected</Text>
        <Text color={colors.textDim} wrap="truncate">{shortPath(cwd, 70)}</Text>
      </>
    );
  }

  return (
    <>
      <KVRow label="Name" value={projectName} />
      <KVRow label="Root" value={truncPath(cwd)} />
      <KVRow label="Stack" value={[scan?.framework, scan?.language].filter(Boolean).join(" / ") || "Detecting"} />
      <KVRow label="PM" value={scan?.packageManager || "—"} />
    </>
  );
}

function CompactProjectInfo({
  projectName,
  cwd,
  scan,
  noProject,
  rows = 2,
}: {
  projectName: string;
  cwd: string;
  scan: { framework?: string | null; language?: string | null; packageManager?: string | null } | null;
  noProject: boolean;
  rows?: number;
}) {
  if (rows <= 1) return <Text color={noProject ? colors.warning : colors.text} wrap="truncate">{noProject ? "No project detected" : [projectName, scan?.language, scan?.packageManager].filter(Boolean).join(" · ")}</Text>;
  if (noProject) {
    return (
      <>
        <Text color={colors.warning} bold>No project detected</Text>
        <Text color={colors.textDim} wrap="truncate">{shortPath(cwd, 70)}</Text>
      </>
    );
  }

  return (
    <>
      <Text color={colors.value} wrap="truncate">{projectName}  {scan?.packageManager || "—"}</Text>
      <Text color={colors.textDim} wrap="truncate">{[scan?.framework, scan?.language].filter(Boolean).join(" / ") || truncPath(cwd)}</Text>
    </>
  );
}

function buildTimelineEvents(
  logs: LogEntry[],
  messages: AppMessage[],
  notices: NoticeInfo[],
  noProject: boolean
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (noProject) {
    events.push({
      id: "no-project",
      kind: "notice",
      tone: "warning",
      title: "No project files",
      content: "Open a project directory before running setup.",
    });
  }

  for (const message of messages) {
    events.push({
      id: `message-${message.id}`,
      kind: message.role,
      content: message.content,
      timestamp: message.timestamp,
      tone: message.role === "system" ? "muted" : undefined,
      detail: message.level ? `AI level: ${message.level}${message.cost ? ` · ${message.cost} tokens` : ""}` : undefined,
    });
  }

  for (const log of logs) {
    events.push({
      id: `log-${log.id}`,
      kind: "log",
      content: log.content,
      timestamp: log.timestamp,
      tone: timelineToneForLog(log.type),
    });
  }

  notices.forEach((notice, index) => {
    events.push({
      id: `notice-${index}-${notice.message}`,
      kind: "notice",
      content: notice.message,
      tone: notice.type === "error" ? "error" : notice.type === "warning" ? "warning" : "info",
    });
  });

  return events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function timelineToneForLog(type: LogEntry["type"]): TimelineEvent["tone"] {
  switch (type) {
    case "success": return "success";
    case "warning": return "warning";
    case "error": return "error";
    case "command": return "muted";
    case "progress": return "info";
    case "info": return "info";
  }
}

function SideDetails({
  ports,
  keyDeps,
  notices,
  noProject,
  compact = false,
}: {
  ports: Array<{ service: string; port: number; status: "free" | "in_use" }>;
  keyDeps: Array<{ name: string; version: string }>;
  notices: Array<{ type: "warning" | "error" | "info"; message: string }>;
  noProject: boolean;
  compact?: boolean;
}) {
  if (noProject) {
    return (
      <>
        <Text color={colors.textDim}>Expected files include package.json, pyproject.toml, Cargo.toml, go.mod, or similar.</Text>
      </>
    );
  }

  if (compact) {
    return (
      <>
        {notices.length > 0 ? notices.slice(0, 1).map((n, i) => (
          <Text key={i} color={n.type === "error" ? colors.error : n.type === "warning" ? colors.warning : colors.info} wrap="truncate">
            {n.type === "error" ? "●" : n.type === "warning" ? "△" : "i"} {n.message}
          </Text>
        )) : <Text color={colors.textDim}>No issues</Text>}
      </>
    );
  }

  return (
    <>
      <PortRows ports={ports} limit={compact ? 2 : 5} />
      <Text> </Text>
      <KeyDependencyRows keyDeps={keyDeps} limit={7} />
      <Text> </Text>
      <NoticeRows notices={notices} limit={5} />
    </>
  );
}

function SetupSideRail({
  width,
  height,
  focusState,
  ports,
  keyDeps,
  notices,
  noProject,
}: {
  width: number;
  height: number;
  focusState?: "focused" | "ancestor";
  ports: Array<{ service: string; port: number; status: "free" | "in_use" }>;
  keyDeps: Array<{ name: string; version: string }>;
  notices: Array<{ type: "warning" | "error" | "info"; message: string }>;
  noProject: boolean;
}) {
  const gap = tuiLayout.panelGap;
  const availableHeight = Math.max(5, height - gap * 2);
  const portHeight = clamp(Math.floor(availableHeight * 0.30), 7, Math.max(7, availableHeight - 12));
  const depsHeight = clamp(Math.floor(availableHeight * 0.34), 8, Math.max(8, availableHeight - portHeight - 5));
  const noticesHeight = Math.max(5, availableHeight - portHeight - depsHeight);

  if (noProject) {
    return (
      <Panel title="Notices" focusState={focusState} width={width} height="100%">
        <Text color={colors.warning} bold>Open a project directory before running setup.</Text>
        <Text color={colors.textDim}>Expected files include package.json, pyproject.toml, Cargo.toml, go.mod, or similar.</Text>
      </Panel>
    );
  }

  return (
    <Box flexDirection="column" width={width} height="100%" gap={gap}>
      <Panel title="Port Map" focusState={focusState} width="100%" height={portHeight}>
        <PortRows ports={ports} limit={portHeight - 3} />
      </Panel>
      <Panel title="Key Dependencies" focusState={focusState} width="100%" height={depsHeight}>
        <KeyDependencyRows keyDeps={keyDeps} limit={depsHeight - 3} />
      </Panel>
      <Panel title="Notices" focusState={focusState} width="100%" height={noticesHeight}>
        <NoticeRows notices={notices} limit={noticesHeight - 3} />
      </Panel>
    </Box>
  );
}

function PortRows({ ports, limit }: { ports: Array<{ service: string; port: number; status: "free" | "in_use" }>; limit: number }) {
  return (
    <>
      {ports.length > 0 ? ports.slice(0, Math.max(1, limit)).map((p) => (
        <Box key={p.service} justifyContent="space-between" width="100%" minWidth={0}>
          <Box flexShrink={1} minWidth={0} marginRight={1}>
            <Text color={colors.label} wrap="truncate">{p.service}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={p.status === "free" ? colors.success : colors.error} wrap="truncate">:{p.port} {p.status === "free" ? "free" : "in use"}</Text>
          </Box>
        </Box>
      )) : <Text color={colors.textDim}>No ports detected</Text>}
      {ports.length > limit && <Text color={colors.textDim}>… {ports.length - limit} more ports</Text>}
    </>
  );
}

function KeyDependencyRows({ keyDeps, limit }: { keyDeps: Array<{ name: string; version: string }>; limit: number }) {
  return (
    <>
      {keyDeps.length > 0 ? keyDeps.slice(0, Math.max(1, limit)).map((dep) => (
        <Box key={dep.name} justifyContent="space-between" width="100%" minWidth={0}>
          <Box flexShrink={1} minWidth={0} marginRight={1}>
            <Text color={colors.label} wrap="truncate">{dep.name}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={colors.value} wrap="truncate">{dep.version}</Text>
          </Box>
        </Box>
      )) : <Text color={colors.textDim}>None found</Text>}
      {keyDeps.length > limit && <Text color={colors.textDim}>… {keyDeps.length - limit} more deps</Text>}
    </>
  );
}

function NoticeRows({ notices, limit }: { notices: Array<{ type: "warning" | "error" | "info"; message: string }>; limit: number }) {
  return (
    <>
      {notices.length > 0 ? notices.slice(0, Math.max(1, limit)).map((n, i) => (
        <Text key={i} color={n.type === "error" ? colors.error : n.type === "warning" ? colors.warning : colors.info} wrap="truncate">
          {n.type === "error" ? "●" : n.type === "warning" ? "△" : "ℹ"} {n.message}
        </Text>
      )) : <Text color={colors.textDim}>No issues</Text>}
      {notices.length > limit && <Text color={colors.textDim}>… {notices.length - limit} more notices</Text>}
    </>
  );
}

function Footer({ width }: { width: number }) {
  return (
    <TuiFooter
      width={width}
      left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ navigate · Esc back · q quit outside input · Click panels where supported"
      right={`OS ${getOS()} · Node ${process.version} · ${process.env.TERM_PROGRAM || "terminal"}`}
    />
  );
}

interface WideSetupProps {
  chatPending?: boolean;
  chatProgress?: string;
  layout: Layout;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  projectName: string;
  cwd: string;
  scan: { framework?: string | null; language?: string | null; packageManager?: string | null } | null;
  steps: Array<{ id: string; label: string; status: string }>;
  logs: LogEntry[];
  messages: AppMessage[];
  noProject: boolean;
  currentStepIndex: number;
  currentStepLabel: string;
  doneCount: number;
  failedCount: number;
  totalPackages: number;
  installedPackages: number;
  deprecatedCount: number;
  vulnerabilities: { high: number; moderate: number; low: number };
  lockSynced: boolean;
  envVars: Array<{ status: string }>;
  autoFilled: number;
  needInput: number;
  ports: Array<{ service: string; port: number; status: "free" | "in_use" }>;
  keyDeps: Array<{ name: string; version: string }>;
  services: Array<{ name: string; status: string }>;
  notices: NoticeInfo[];
  pendingPrompt: AgentPrompt | null;
  envPromptKey: string | null;
  remainingEnv: number;
  onEnvSubmit: (value: string) => void;
  onEnvSkip: () => void;
  onPromptSubmit: (value: string, option?: { id: string }) => void;
  chatActive: boolean;
  onChat: (text: string) => void;
  inputMaxLines: number;
  inputWidth: number;
  inputBounds?: FocusBounds;
}

function inputLinesForPanel(panelHeight: number): number {
  return clamp(Math.floor(panelHeight / 4), 1, 6);
}

function inputBoundsHeightForPanel(panelHeight: number): number {
  return inputLinesForPanel(panelHeight) + 2;
}

function stackedSectionHeights(height: number) {
  const contentHeight = Math.max(10, height - 2);
  if (contentHeight < 18) {
    const projectHeight = 4;
    const stepHeight = 5;
    const noticesHeight = 3;
    return {
      projectHeight,
      stepHeight,
      diaryHeight: Math.max(3, contentHeight - projectHeight - stepHeight - noticesHeight),
      noticesHeight,
    };
  }

  if (contentHeight < 26) {
    const projectHeight = 4;
    const stepHeight = 4;
    const noticesHeight = 4;
    return {
      projectHeight,
      stepHeight,
      diaryHeight: Math.max(4, contentHeight - projectHeight - stepHeight - noticesHeight),
      noticesHeight,
    };
  }

  const projectHeight = 5;
  const stepHeight = clamp(Math.floor(height * 0.23), 6, 9);
  const noticesHeight = 5;
  return {
    projectHeight,
    stepHeight,
    diaryHeight: Math.max(8, contentHeight - projectHeight - stepHeight - noticesHeight),
    noticesHeight,
  };
}

interface StackedSetupProps {
  chatPending?: boolean;
  chatProgress?: string;
  layout: Layout;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  projectName: string;
  cwd: string;
  scan: { framework?: string | null; language?: string | null; packageManager?: string | null } | null;
  steps: Array<{ id: string; label: string; status: string }>;
  logs: LogEntry[];
  messages: AppMessage[];
  noProject: boolean;
  currentStepIndex: number;
  currentStepLabel: string;
  totalPackages: number;
  installedPackages: number;
  envVars: Array<{ status: string }>;
  autoFilled: number;
  needInput: number;
  ports: Array<{ service: string; port: number; status: "free" | "in_use" }>;
  keyDeps: Array<{ name: string; version: string }>;
  notices: NoticeInfo[];
  pendingPrompt: AgentPrompt | null;
  envPromptKey: string | null;
  remainingEnv: number;
  onEnvSubmit: (value: string) => void;
  onEnvSkip: () => void;
  onPromptSubmit: (value: string, option?: { id: string }) => void;
  chatActive: boolean;
  onChat: (text: string) => void;
  inputBounds?: FocusBounds;
}

interface DiaryPanelProps {
  chatPending?: boolean;
  chatProgress?: string;
  width: number | string;
  flexGrow?: number;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  logs: LogEntry[];
  messages: AppMessage[];
  notices: NoticeInfo[];
  noProject: boolean;
  currentStepLabel: string;
  pendingPrompt: AgentPrompt | null;
  envPromptKey: string | null;
  remainingEnv: number;
  onEnvSubmit: (value: string) => void;
  onEnvSkip: () => void;
  onPromptSubmit: (value: string, option?: { id: string }) => void;
  chatActive: boolean;
  onChat: (text: string) => void;
  inputMaxLines: number;
  inputWidth: number;
  inputBounds?: FocusBounds;
  maxLogLines: number;
}

function KVRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <Box justifyContent="space-between" width="100%" minWidth={0}>
      <Box flexShrink={0} marginRight={1}>
        <Text color={colors.label}>{label}</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={color || colors.value} wrap="truncate">{String(value)}</Text>
      </Box>
    </Box>
  );
}

function buildStackString(scan: { language?: string | null; framework?: string | null; services?: string[] } | null): string {
  if (!scan) return "Detecting";
  const parts: string[] = [];
  if (scan.framework) parts.push(scan.framework);
  if (scan.language) parts.push(scan.language);
  if (scan.services && scan.services.length > 0) parts.push(...scan.services.slice(0, 2));
  return parts.join(" + ") || "Unknown";
}

function truncPath(cwd: string): string {
  const home = process.env.HOME || "";
  if (cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

function shortPath(cwd: string, max: number): string {
  const path = truncPath(cwd);
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

function vulnStr(v: { high: number; moderate: number; low: number }): string {
  if (v.high === 0 && v.moderate === 0 && v.low === 0) return "none";
  const parts: string[] = [];
  if (v.high > 0) parts.push(`${v.high} high`);
  if (v.moderate > 0) parts.push(`${v.moderate} moderate`);
  if (v.low > 0) parts.push(`${v.low} low`);
  return parts.join(", ");
}

export function formatManualEnvLogValue(key: string, value: string): string {
  if (isSensitiveEnvKey(key)) return value.length > 0 ? "[hidden]" : "[empty]";
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "[empty]";
  return clean.length > 28 ? `${clean.slice(0, 25)}...` : clean;
}

function isSensitiveEnvKey(key: string): boolean {
  return /(?:SECRET|TOKEN|PASSWORD|PASS|PRIVATE|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|JWT)/i.test(key);
}

function getOS(): string {
  const platform = os.platform();
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function distributeWidths(total: number, weights: number[], mins: number[]): number[] {
  const minTotal = mins.reduce((sum, width) => sum + width, 0);
  if (total <= minTotal) return fitWidths(total, mins);

  const extra = total - minTotal;
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = mins.map((min, index) => min + Math.floor(extra * (weights[index] / weightTotal)));
  widths[widths.length - 1] += total - widths.reduce((sum, width) => sum + width, 0);
  return widths;
}

function fitWidths(total: number, mins: number[]): number[] {
  const base = Math.max(1, Math.floor(total / mins.length));
  const widths = mins.map(() => base);
  widths[widths.length - 1] += total - widths.reduce((sum, width) => sum + width, 0);
  return widths;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
