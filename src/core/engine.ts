import { collectContext } from "../context/collector.js";
import { collectDashboardStatus, type DashboardStatus } from "../status/collector.js";
import { evaluateCommandSafety, type SafetyEvaluation } from "../agent/safety.js";
import { loadAgentWorkflowCheckpoint, type AgentWorkflowCheckpoint } from "../agent/workflowCheckpoint.js";
import { getCommand, type CommandEntry } from "../cli/commandRegistry.js";
import { sanitizeSecret, fromUnknownError, type SetuprError } from "../errors/index.js";
import type { ProjectContext } from "../ai/dsl.js";
import type { ScanResult } from "../scanner/index.js";
import { scanProject } from "../scanner/index.js";
import { loadConfig, type UserConfig } from "../state/config.js";
import {
  appendHistoryEvent,
  appendLogEvent,
  readRecentHistoryEvents,
  type JsonValue,
  type ProjectEvent,
} from "../state/project.js";
import { loadCheckpoint, type Checkpoint } from "../state/checkpoint.js";

export type EngineMode = "auto" | "plain" | "tui";

export interface ProjectEngineOptions {
  cwd: string;
  command: string;
  subcommand?: string;
  args?: string[];
  mode?: EngineMode;
  flags?: Record<string, unknown>;
}

export interface EngineCommandIdentity {
  command: string;
  subcommand?: string;
  display: string;
  entry?: CommandEntry;
}

export interface EngineCheckpoints {
  setup: Checkpoint | null;
  agent: AgentWorkflowCheckpoint | null;
}

export interface EngineCommandRecord {
  type: "command.start" | "command.finish" | "command.error";
  message?: string;
  error?: unknown;
  exitCode?: number;
  extra?: Record<string, unknown>;
}

export interface EngineContextSnapshot {
  cwd: string;
  command: EngineCommandIdentity;
  mode: EngineMode;
  elapsedMs: number;
  scan?: ScanResult;
  context?: ProjectContext;
  status?: DashboardStatus;
  history: ProjectEvent[];
  checkpoints: EngineCheckpoints;
}

export class ProjectEngine {
  readonly cwd: string;
  readonly command: EngineCommandIdentity;
  readonly mode: EngineMode;
  readonly flags: Record<string, unknown>;
  readonly startedAt = Date.now();

  private scanValue: ScanResult | null | undefined;
  private contextValue: ProjectContext | null | undefined;
  private statusValue: DashboardStatus | null | undefined;
  private configValue: UserConfig | null | undefined;
  private setupCheckpointValue: Checkpoint | null | undefined;
  private agentCheckpointValue: AgentWorkflowCheckpoint | null | undefined;

  constructor(options: ProjectEngineOptions) {
    const entry = getCommand(options.command);
    this.cwd = options.cwd;
    this.mode = options.mode || "auto";
    this.flags = options.flags || {};
    this.command = {
      command: options.command,
      subcommand: options.subcommand,
      display: formatCommandDisplay(options.command, options.subcommand, options.args),
      entry,
    };
  }

  async scan(): Promise<ScanResult> {
    if (this.scanValue) return this.scanValue;
    this.scanValue = await scanProject(this.cwd);
    return this.scanValue;
  }

  async context(): Promise<ProjectContext> {
    if (this.contextValue) return this.contextValue;
    const scan = await this.scan();
    this.contextValue = await collectContext(this.cwd, scan);
    return this.contextValue;
  }

  async status(): Promise<DashboardStatus> {
    if (this.statusValue) return this.statusValue;
    this.statusValue = await collectDashboardStatus(this.cwd);
    return this.statusValue;
  }

  async config(): Promise<UserConfig> {
    if (this.configValue) return this.configValue;
    this.configValue = await loadConfig();
    return this.configValue;
  }

  async checkpoints(): Promise<EngineCheckpoints> {
    if (this.setupCheckpointValue === undefined) {
      this.setupCheckpointValue = await loadCheckpoint(this.cwd);
    }
    if (this.agentCheckpointValue === undefined) {
      this.agentCheckpointValue = await loadAgentWorkflowCheckpoint(this.cwd);
    }
    return {
      setup: this.setupCheckpointValue,
      agent: this.agentCheckpointValue,
    };
  }

  async history(limit = 50): Promise<ProjectEvent[]> {
    return readRecentHistoryEvents(this.cwd, limit);
  }

  evaluateShellCommand(command: string): SafetyEvaluation {
    return evaluateCommandSafety(command, { force: Boolean(this.flags.force) });
  }

  evaluateCommandIntent(): SafetyEvaluation {
    const reasons: string[] = [];
    const risk = this.command.entry?.risk || "none";
    if (this.command.entry?.writes) reasons.push("This command can write project or Setupr state.");
    if (this.command.entry?.aiCapable) reasons.push("This command may use configured AI providers when smart behavior is enabled.");
    if (risk === "high") reasons.push("This command can remove files or change important project state.");
    if (risk === "medium") reasons.push("This command can install, configure, or modify development state.");
    return {
      decision: risk === "high" || risk === "medium" ? "confirm" : "allow",
      risk: risk === "none" ? "none" : risk,
      reasons,
      // Consistent with agent/safety.ts: --force only skips the medium-risk confirmation;
      // high risk always confirms.
      forceCanSkipConfirmation: risk === "medium",
    };
  }

  async snapshot(options: {
    includeScan?: boolean;
    includeContext?: boolean;
    includeStatus?: boolean;
    historyLimit?: number;
  } = {}): Promise<EngineContextSnapshot> {
    const [history, checkpoints] = await Promise.all([
      this.history(options.historyLimit ?? 25),
      this.checkpoints(),
    ]);
    return {
      cwd: this.cwd,
      command: this.command,
      mode: this.mode,
      elapsedMs: Date.now() - this.startedAt,
      scan: options.includeScan ? await this.scan().catch(() => undefined as unknown as ScanResult) : undefined,
      context: options.includeContext ? await this.context().catch(() => undefined as unknown as ProjectContext) : undefined,
      status: options.includeStatus ? await this.status().catch(() => undefined as unknown as DashboardStatus) : undefined,
      history,
      checkpoints,
    };
  }

  async recordCommand(record: EngineCommandRecord): Promise<void> {
    const data: Record<string, unknown> = {
      command: this.command.command,
      subCommand: this.command.subcommand || null,
      mode: this.mode,
      elapsedMs: Date.now() - this.startedAt,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.error ? { error: normalizeErrorMessage(record.error) } : {}),
      ...(record.extra || {}),
    };
    await appendHistoryEvent(this.cwd, {
      type: record.type,
      message: record.message || defaultRecordMessage(record.type, this.command.display, record.exitCode),
      data: toJsonValue(redactObject(data)),
    }).catch(() => undefined);
  }

  async log(type: string, message: string, data?: Record<string, unknown>): Promise<void> {
    await appendLogEvent(this.cwd, {
      type,
      message: sanitizeSecret(message),
      data: data ? toJsonValue(redactObject(data)) : undefined,
    }).catch(() => undefined);
  }

  error(error: unknown, details?: Partial<SetuprError>): SetuprError {
    return fromUnknownError(error, {
      command: this.command.command,
      subcommand: this.command.subcommand,
      cwd: this.cwd,
      ...details,
    });
  }
}

export function createProjectEngine(options: ProjectEngineOptions): ProjectEngine {
  return new ProjectEngine(options);
}

export function redactText(value: string): string {
  return sanitizeSecret(value)
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)([^\s]+)/gi, "$1****")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/g, "Bearer ****");
}

export function redactObject(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/(key|token|secret|password|credential|auth)/i.test(key)) {
        const redacted = typeof item === "string" ? redactText(item) : "****";
        return [key, redacted === item ? "****" : redacted];
      }
      return [key, redactObject(item)];
    })
  );
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)])
  ) as JsonValue;
}

export function redactCommandArguments(command: string, subcommand: string | undefined, args: string[]): string[] {
  return args.map((value, index) => command === "secrets" && subcommand === "set" && index >= 1 ? "****" : redactText(value));
}

function formatCommandDisplay(command: string, subcommand?: string, args: string[] = []): string {
  const parts = ["setupr", command === "dashboard" ? "" : command, subcommand, ...redactCommandArguments(command, subcommand, args)]
    .filter((part): part is string => Boolean(part));
  return redactText(parts.join(" ").trim() || "setupr");
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactText(error.message);
  return redactText(String(error || "unknown error"));
}

function defaultRecordMessage(type: EngineCommandRecord["type"], display: string, exitCode?: number): string {
  if (type === "command.start") return display;
  if (type === "command.finish") return `${display} finished${exitCode ? ` with exit ${exitCode}` : ""}`;
  return `${display} failed`;
}
