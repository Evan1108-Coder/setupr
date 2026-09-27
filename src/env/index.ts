import { access, link, lstat, open, readFile, rename, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { join } from "path";

export interface EnvInitResult {
  created: boolean;
  skipped: boolean;
  source: ".env.example" | "empty";
  reason?: "exists" | "missing-example";
}

export interface EnvEditorEntry {
  key: string;
  value: string;
  templateValue?: string;
  fromTemplate: boolean;
  fromEnv: boolean;
  sensitive: boolean;
  status: "filled" | "missing" | "empty" | "extra";
}

export interface EnvEditorState {
  hasEnv: boolean;
  hasExample: boolean;
  entries: EnvEditorEntry[];
  missing: string[];
  extra: string[];
  source: ".env" | ".env.example" | "empty";
}

// Preserve the load-time baseline across merges without adding secret metadata to UI state.
const editorSnapshots = new WeakMap<EnvEditorEntry, { value: string; fromEnv: boolean }>();

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initEnvFile(
  cwd: string,
  options: { overwrite?: boolean } = {}
): Promise<EnvInitResult> {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");

  if (!options.overwrite && await fileExists(envPath)) {
    return { created: false, skipped: true, source: await fileExists(examplePath) ? ".env.example" : "empty", reason: "exists" };
  }

  if (await fileExists(examplePath)) {
    const content = await readFile(examplePath, "utf-8");
    try {
      await writeEnvFile(envPath, content, Boolean(options.overwrite));
    } catch (error) {
      if (!options.overwrite && (error as NodeJS.ErrnoException).code === "EEXIST") {
        return { created: false, skipped: true, source: ".env.example", reason: "exists" };
      }
      throw error;
    }
    return { created: true, skipped: false, source: ".env.example" };
  }

  if (!options.overwrite) {
    return { created: false, skipped: true, source: "empty", reason: "missing-example" };
  }

  try {
    // Force without a template may create a file, but must not erase existing data.
    await writeEnvFile(envPath, "# Environment variables\n", false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { created: false, skipped: true, source: "empty", reason: "exists" };
    }
    throw error;
  }
  return { created: true, skipped: false, source: "empty" };
}

export async function parseEnvKeysFromFile(path: string): Promise<string[]> {
  return parseEnvKeys(await readFile(path, "utf-8"));
}

export async function loadEnvEditorState(cwd: string): Promise<EnvEditorState> {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");
  const hasEnv = await fileExists(envPath);
  const hasExample = await fileExists(examplePath);
  const envContent = hasEnv ? await readFile(envPath, "utf-8") : "";
  const exampleContent = hasExample ? await readFile(examplePath, "utf-8") : "";
  const envPairs = parseEnvPairs(envContent);
  const examplePairs = parseEnvPairs(exampleContent);
  const envKeys = parseEnvKeys(envContent);
  const exampleKeys = parseEnvKeys(exampleContent);
  const orderedKeys = unique([...exampleKeys, ...envKeys]);

  const entries = orderedKeys.map((key) => {
    const fromTemplate = exampleKeys.includes(key);
    const fromEnv = envKeys.includes(key);
    const value = fromEnv ? envPairs[key] || "" : examplePairs[key] || "";
    const status: EnvEditorEntry["status"] = !fromTemplate
      ? "extra"
      : !fromEnv
        ? "missing"
        : value.trim()
          ? "filled"
          : "empty";
    const entry = {
      key,
      value,
      templateValue: fromTemplate ? examplePairs[key] || "" : undefined,
      fromTemplate,
      fromEnv,
      sensitive: isSensitiveEnvKey(key) || hasUrlCredentials(value) || hasUrlCredentials(examplePairs[key] || ""),
      status,
    };
    editorSnapshots.set(entry, { value, fromEnv });
    return entry;
  });

  return {
    hasEnv,
    hasExample,
    entries,
    missing: entries.filter((entry) => entry.status === "missing" || entry.status === "empty").map((entry) => entry.key),
    extra: entries.filter((entry) => entry.status === "extra").map((entry) => entry.key),
    source: hasEnv ? ".env" : hasExample ? ".env.example" : "empty",
  };
}

export async function saveEnvEditorEntries(cwd: string, entries: EnvEditorEntry[]): Promise<void> {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");
  const hasExample = await fileExists(examplePath);
  const hasEnv = await fileExists(envPath);
  const templateContent = hasExample ? await readFile(examplePath, "utf-8") : "";
  const envContent = hasEnv ? await readFile(envPath, "utf-8") : "";
  const currentPairs = parseEnvPairs(envContent);
  const updates = entries.filter((entry) => {
    if (!entry.key || normalizeEnvKey(entry.key) !== entry.key) {
      throw new Error("Invalid environment variable name.");
    }
    const snapshot = editorSnapshots.get(entry);
    if (!snapshot) return true;
    const present = Object.hasOwn(currentPairs, entry.key);
    if (entry.value === snapshot.value) return !present && !snapshot.fromEnv;
    const changedOnDisk = present !== snapshot.fromEnv || (present && currentPairs[entry.key] !== snapshot.value);
    if (changedOnDisk && (!present || currentPairs[entry.key] !== entry.value)) {
      throw new Error("Environment values changed on disk. Reload the editor before saving.");
    }
    return true;
  });
  const content = serializeEnvEntries(updates, hasEnv ? envContent : templateContent);
  if (!hasEnv || content !== envContent) await writeEnvFile(envPath, content, hasEnv, envContent);
  const saved = parseEnvPairs(content);
  for (const entry of entries) {
    if (Object.hasOwn(saved, entry.key) && saved[entry.key] === entry.value) {
      editorSnapshots.set(entry, { value: entry.value, fromEnv: true });
    }
  }
}

export function mergeEnvEditorValues(entries: EnvEditorEntry[], values: Record<string, string>): EnvEditorEntry[] {
  const normalized = new Map<string, string>();
  for (const [rawKey, value] of Object.entries(values)) {
    const key = normalizeEnvKey(rawKey);
    if (!key) throw new Error("Invalid environment variable name.");
    normalized.set(key, value);
  }
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const next = entries.map((entry) => {
    if (!normalized.has(entry.key)) return entry;
    const value = normalized.get(entry.key)!;
    const updated = {
      ...entry,
      value,
      sensitive: entry.sensitive || hasUrlCredentials(value),
      fromEnv: true,
      status: entry.fromTemplate ? value.trim() ? "filled" as const : "empty" as const : "extra" as const,
    };
    const snapshot = editorSnapshots.get(entry);
    if (snapshot) editorSnapshots.set(updated, snapshot);
    return updated;
  });

  for (const [key, value] of normalized) {
    if (byKey.has(key)) continue;
    next.push({
      key,
      value,
      fromTemplate: false,
      fromEnv: true,
      sensitive: isSensitiveEnvKey(key) || hasUrlCredentials(value),
      status: "extra",
    });
  }

  return next;
}

export function parseEnvKeys(content: string): string[] {
  return unique(parseEnvRecords(content).flatMap((record) => record.key ? [record.key] : []));
}

export function parseEnvPairs(content: string): Record<string, string> {
  const pairs: Record<string, string> = Object.create(null);
  for (const record of parseEnvRecords(content)) {
    if (record.key) pairs[record.key] = record.value!;
  }
  return pairs;
}

export function normalizeEnvKey(key: string): string {
  const normalized = key.trim().replace(/^export[ \t]+/, "").trim();
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(normalized) ? normalized : "";
}

interface EnvRecord {
  raw: string;
  key?: string;
  value?: string;
  prefix?: string;
  suffix?: string;
  malformed?: boolean;
}

function parseEnvRecords(content: string): EnvRecord[] {
  const records: EnvRecord[] = [];
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/y;
  let offset = 0;
  while (offset < content.length) {
    linePattern.lastIndex = offset;
    const raw = linePattern.exec(content)![0];
    const line = raw.replace(/(?:\r\n|\n|\r)$/, "");
    const assignment = /^[ \t\uFEFF]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/.exec(line);
    if (!assignment) {
      records.push({ raw });
      offset += raw.length;
      continue;
    }
    const prefix = assignment[0];
    const key = assignment[1];
    const start = offset + prefix.length;
    const quote = content[start];
    if (quote === '"' || quote === "'" || quote === "`") {
      let end = start;
      let suffix: string | undefined;
      while ((end = content.indexOf(quote, end + 1)) !== -1) {
        linePattern.lastIndex = end + 1;
        const tail = linePattern.exec(content)![0];
        if (/^[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r)?$/.test(tail)) {
          suffix = tail;
          break;
        }
        if (content[end - 1] !== "\\") break;
      }
      if (suffix === undefined) {
        records.push({ raw, malformed: true });
        offset += raw.length;
        continue;
      }
      let value = content.slice(start + 1, end).replace(/\r\n?/g, "\n");
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      const next = end + 1 + suffix.length;
      records.push({ raw: content.slice(offset, next), key, value, prefix, suffix });
      offset = next;
    } else {
      const tail = line.slice(prefix.length);
      const comment = tail.indexOf("#");
      const value = (comment < 0 ? tail : tail.slice(0, comment)).trimEnd();
      records.push({ raw, key, value, prefix, suffix: raw.slice(prefix.length + value.length) });
      offset += raw.length;
    }
  }
  return records;
}

export function serializeEnvEntries(entries: EnvEditorEntry[], source: string): string {
  if (entries.some(entry => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(entry.key))) {
    throw new Error("Invalid environment variable name. The file was not changed.");
  }
  const values = new Map<string, string>();
  for (const entry of entries) {
    values.set(entry.key, entry.value);
  }
  const records = parseEnvRecords(source);
  const last = new Map<string, EnvRecord>();
  for (const record of records) if (record.key) last.set(record.key, record);
  let output = records.map((record) => {
    if (!record.key || !values.has(record.key) || last.get(record.key) !== record) return record.raw;
    const value = values.get(record.key)!;
    return value === record.value ? record.raw : `${record.prefix}${serializeEnvValue(value)}${record.suffix}`;
  }).join("");
  const newline = source.match(/\r\n|\n|\r/)?.[0] || "\n";
  for (const [key, value] of values) {
    if (last.has(key)) continue;
    if (output && !/[\r\n]$/.test(output)) output += newline;
    output += `${key}=${serializeEnvValue(value)}${newline}`;
  }
  if (output !== source && records.some((record) => record.malformed)) {
    throw new Error("Cannot safely update an environment file with an unterminated or malformed quoted value.");
  }
  return output;
}

function serializeEnvValue(value: string): string {
  if (value.includes("\0")) throw new Error("Environment values cannot contain NUL characters.");
  if (!/[#\r\n]/.test(value) && value.trim() === value && !/^["'`]/.test(value)) return value;
  // Pick a delimiter absent from the value instead of inventing shell/JSON escapes.
  const candidates: string[] = [];
  if (!value.includes('"') && !/\\[nr]/.test(value)) {
    candidates.push(`"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`);
  }
  if (!value.includes("'")) candidates.push(`'${value}'`);
  if (!value.includes("`")) candidates.push(`\`${value}\``);
  for (const candidate of candidates) {
    if (parseEnvPairs(`VALUE=${candidate}`).VALUE === value) return candidate;
  }
  throw new Error("Environment value cannot be represented safely with dotenv quoting. The file was not changed.");
}

async function writeEnvFile(path: string, content: string, overwrite: boolean, expectedContent?: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !overwrite) {
    throw Object.assign(new Error("Environment file already exists."), { code: "EEXIST" });
  }
  if (existing && !existing.isFile()) throw new Error("Refusing to replace a non-regular environment file.");
  if (!existing && overwrite && expectedContent !== undefined) {
    throw new Error("Environment file changed while saving. Reload the editor before saving.");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf-8");
    if (existing) await handle.chmod(existing.mode & 0o777);
    await handle.sync();
    await handle.close();
    if (existing && expectedContent !== undefined && await readFile(path, "utf-8") !== expectedContent) {
      throw new Error("Environment file changed while saving. Reload the editor before saving.");
    }
    if (overwrite) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function isSensitiveEnvKey(key: string): boolean {
  return /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|AUTH|CONNECTION_?STRING|DSN)/i.test(key);
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
