import chalk from "chalk";
import { readFile, writeFile, mkdir, lstat, rename, unlink, link, open } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { createSetuprError, printPlainError, type SetuprError } from "../../errors/index.js";
import { mergeEnvEditorValues, parseEnvPairs, serializeEnvEntries } from "../../env/index.js";

interface SecretsFlags {
  force?: boolean;
  args?: string[];
  key?: string;
  [key: string]: unknown;
}

function isSetuprError(error: unknown): error is SetuprError {
  const value = error as Partial<SetuprError> | undefined;
  return Boolean(value?.code && value.title && value.explanation && value.timestamp);
}

const SECRETS_DIR = ".setupr";
const SECRETS_FILE = "secrets.enc";
const KEY_FILE = "secrets.key";
const ALGORITHM = "aes-256-gcm";

export async function cmdSecrets(sub: string | undefined, cwd: string, flags: SecretsFlags): Promise<void> {
  try {
    switch (sub) {
      case "init": return await secretsInit(cwd, flags);
      case "set": return await secretsSet(cwd, flags);
      case "get": return await secretsGet(cwd, flags);
      case "list": return await secretsList(cwd);
      case "remove": return await secretsRemove(cwd, flags);
      case "export": return await secretsExport(cwd, flags);
      case "import": return await secretsImport(cwd, flags);
      case "rotate": return await secretsRotate(cwd);
      default:
        printPlainError(createSetuprError({
          code: "UNKNOWN_SUBCOMMAND",
          command: "secrets",
          subcommand: sub,
          cwd,
          details: ["Valid: init, set, get, list, remove, export, import, rotate"],
        }));
    }
  } catch (err) {
    printPlainError(isSetuprError(err) ? err : createSetuprError({
      code: sub === "get" || sub === "list" ? "SECRETS_DECRYPTION_FAILED" : "SECRETS_ENCRYPTION_FAILED",
      command: "secrets",
      subcommand: sub,
      cwd,
      details: [err instanceof Error ? err.message : "The secrets operation failed."],
    }));
  }
}

async function secretsInit(cwd: string, flags: SecretsFlags): Promise<void> {
  const dir = join(cwd, SECRETS_DIR);
  await mkdir(dir, { recursive: true });

  const keyPath = join(dir, KEY_FILE);
  if (existsSync(keyPath) && !flags.force) {
    console.log(chalk.yellow("Encryption key already exists. Use --force to regenerate (will invalidate existing secrets)."));
    return;
  }

  const key = randomBytes(32).toString("hex");
  await writeFile(keyPath, key, { mode: 0o600 });
  console.log(chalk.green("✓ Generated encryption key"));
  console.log(chalk.dim("  Values are encrypted in .setupr/secrets.enc. Keep secrets.key private and backed up."));

  const gitignorePath = join(cwd, ".gitignore");
  const content = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf-8") : "";
  if (!content.includes(".setupr/secrets.key")) {
    const next = content.trimEnd()
      ? `${content.trimEnd()}\n.setupr/secrets.key\n`
      : ".setupr/secrets.key\n";
    await writeFile(gitignorePath, next);
    console.log(chalk.green("  ✓ Added secrets.key to .gitignore"));
  }
}

async function secretsSet(cwd: string, flags: SecretsFlags): Promise<void> {
  const name = requireSecretName(flags.args?.[0], cwd, "set");
  let value = flags.args?.[1];
  const secrets = await loadSecrets(cwd, true);
  if (value === undefined && process.stdin.isTTY) value = await promptSecret(name, cwd);
  if (value === undefined || value.length === 0) {
    throw createSetuprError({
      code: "SECRETS_ENCRYPTION_FAILED", command: "secrets", subcommand: "set", cwd,
      details: ["No value was provided. Rerun interactively for a hidden prompt. Nothing was saved."],
    });
  }
  secrets[name] = value;
  await saveSecrets(cwd, secrets);
  console.log(chalk.green(`✓ Set secret: ${name}`));
}

async function secretsGet(cwd: string, flags: SecretsFlags): Promise<void> {
  const name = requireSecretName(flags.args?.[0], cwd, "get");

  const secrets = await loadSecrets(cwd);
  if (Object.hasOwn(secrets, name)) {
    console.log(secrets[name]);
  } else {
    throw createSetuprError({
      code: "SECRETS_DECRYPTION_FAILED", command: "secrets", subcommand: "get", cwd,
      details: [`Secret "${name}" was not found.`],
    });
  }
}

async function secretsList(cwd: string): Promise<void> {
  const secrets = await loadSecrets(cwd);
  const keys = Object.keys(secrets);

  if (keys.length === 0) {
    console.log(chalk.dim("No secrets stored."));
    return;
  }

  console.log(chalk.blue.bold("\n  Stored Secrets\n"));
  for (const key of keys) {
    console.log(`  ${chalk.green(key.padEnd(30))} ${chalk.dim("[hidden]")}`);
  }
  console.log(chalk.dim(`\n  ${keys.length} secret(s) stored`));
}

async function secretsRemove(cwd: string, flags: SecretsFlags): Promise<void> {
  const name = requireSecretName(flags.args?.[0], cwd, "remove");

  const secrets = await loadSecrets(cwd);
  if (!Object.hasOwn(secrets, name)) {
    throw createSetuprError({
      code: "SECRETS_DECRYPTION_FAILED", command: "secrets", subcommand: "remove", cwd,
      details: [`Secret "${name}" was not found. Nothing was removed.`],
    });
  }

  delete secrets[name];
  await saveSecrets(cwd, secrets);
  console.log(chalk.green(`✓ Removed secret: ${name}`));
}

async function secretsExport(cwd: string, flags: SecretsFlags): Promise<void> {
  const secrets = await loadSecrets(cwd);
  if (Object.keys(secrets).some((name) => !isValidSecretName(name))) {
    throw new Error("Some stored names are not valid environment identifiers. Rename those secrets before exporting; no files were changed.");
  }
  const target = flags.args?.[0] || ".env";
  const envPath = resolve(cwd, target);
  if ([KEY_FILE, SECRETS_FILE].some((name) => envPath === resolve(cwd, SECRETS_DIR, name))) {
    throw new Error("Cannot export plaintext over the encryption key or encrypted secrets file.");
  }
  const existing = await readFile(envPath, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const content = serializeEnvEntries(mergeEnvEditorValues([], secrets), existing || "");
  await writeExportFile(envPath, content, existing);
  console.log(chalk.green(`✓ Exported ${Object.keys(secrets).length} secrets to ${target}`));
}

async function secretsImport(cwd: string, flags: SecretsFlags): Promise<void> {
  const source = flags.args?.[0] || ".env";
  const envPath = resolve(cwd, source);

  const content = await readFile(envPath, "utf-8");
  const imported = Object.entries(parseEnvPairs(content)).filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|AUTH|CONNECTION_?STRING|DSN/i.test(key));
  if (imported.length === 0 || imported.some(([key, value]) => !isValidSecretName(key) || value.length === 0)) {
    throw new Error("Import requires valid, nonempty secret assignments. Nothing was saved.");
  }
  const secrets = await loadSecrets(cwd, true);
  for (const [key, value] of imported) secrets[key] = value;
  await saveSecrets(cwd, secrets);
  console.log(chalk.green(`✓ Imported ${imported.length} secrets from ${source}`));
}

async function secretsRotate(cwd: string): Promise<void> {
  const secrets = await loadSecrets(cwd);
  const keyPath = join(cwd, SECRETS_DIR, KEY_FILE);

  const newKey = randomBytes(32).toString("hex");
  await writeFile(keyPath, newKey, { mode: 0o600 });
  await saveSecrets(cwd, secrets);
  console.log(chalk.green("✓ Rotated encryption key and re-encrypted all secrets"));
}

function getEncryptionKey(cwd: string): Buffer {
  const keyPath = join(cwd, SECRETS_DIR, KEY_FILE);
  if (!existsSync(keyPath)) {
    throw createSetuprError({ code: "SECRETS_KEY_MISSING", command: "secrets", cwd });
  }
  const hex = readFileSync(keyPath, "utf-8").trim();
  return scryptSync(hex, "setupr-salt", 32);
}

async function loadSecrets(cwd: string, allowMissing = false): Promise<Record<string, string>> {
  const filePath = join(cwd, SECRETS_DIR, SECRETS_FILE);
  const key = getEncryptionKey(cwd);
  const raw = await readFile(filePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && allowMissing) return undefined;
    throw createSetuprError({
      code: "SECRETS_DECRYPTION_FAILED", command: "secrets", cwd,
      details: ["The encrypted secrets file is missing or cannot be read."],
    });
  });
  if (raw === undefined) return Object.create(null);

  try {
    const { iv, tag, data } = JSON.parse(raw);

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    let decrypted = decipher.update(data, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    const parsed: unknown = JSON.parse(decrypted);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid secrets payload.");
    const secrets: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(parsed)) {
      if (!isSafeSecretName(name) || typeof value !== "string") throw new Error("Invalid stored secret.");
      secrets[name] = value;
    }
    return secrets;
  } catch {
    throw createSetuprError({
      code: "SECRETS_FILE_CORRUPT",
      command: "secrets",
      cwd,
      details: ["The secrets file could not be authenticated or does not contain valid named string values."],
    });
  }
}

async function saveSecrets(cwd: string, secrets: Record<string, string>): Promise<void> {
  const dir = join(cwd, SECRETS_DIR);
  await mkdir(dir, { recursive: true });

  const key = getEncryptionKey(cwd);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(JSON.stringify(secrets), "utf-8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  const payload = JSON.stringify({ iv: iv.toString("hex"), tag, data: encrypted });
  await writeFile(join(dir, SECRETS_FILE), payload, { mode: 0o600 });
}

function isValidSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function isSafeSecretName(name: string): boolean {
  return Boolean(name) && !/[\p{Cc}\p{Cf}]/u.test(name);
}

function requireSecretName(name: string | undefined, cwd: string, subcommand: string): string {
  if (!name || !(subcommand === "set" ? isValidSecretName(name) : isSafeSecretName(name))) {
    throw createSetuprError({
      code: subcommand === "set" ? "SECRETS_ENCRYPTION_FAILED" : "SECRETS_DECRYPTION_FAILED",
      command: "secrets", subcommand, cwd,
      details: ["Provide a secret name containing only letters, digits and underscores, starting with a letter or underscore."],
    });
  }
  return name;
}

async function promptSecret(name: string, cwd: string): Promise<string> {
  const { createInterface } = await import("readline");
  const { Writable } = await import("stream");
  return new Promise((resolve, reject) => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    const onClose = () => {
      output.end();
      reject(createSetuprError({ code: "COMMAND_ABORTED", command: "secrets", subcommand: "set", cwd, exitCode: 130 }));
    };
    rl.on("SIGINT", () => rl.close());
    rl.once("close", onClose);
    process.stdout.write(`  Value for ${name}: `);
    rl.question("", (answer) => {
      rl.off("close", onClose);
      rl.close();
      output.end();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function writeExportFile(path: string, content: string, expected: string | undefined): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isFile()) throw new Error("Refusing to export over a non-regular file.");
  if (Boolean(existing) !== (expected !== undefined)) throw new Error("Export destination changed; retry after reviewing it.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    if (expected !== undefined) {
      if (await readFile(path, "utf8") !== expected) throw new Error("Export destination changed; retry after reviewing it.");
      await rename(temporary, path);
    } else {
      await link(temporary, path);
    }
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
