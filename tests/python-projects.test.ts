import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanProject } from "../src/scanner/index.js";
import { detectPackageManager } from "../src/scanner/packageManager.js";
import { detectRuntime } from "../src/scanner/runtimeDetector.js";
import { planStepsHeuristic } from "../src/ai/planner.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "setupr python-projects-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function pyproject(content: string): Promise<void> {
  await writeFile(join(cwd, "pyproject.toml"), content);
}

describe("standard Python projects", () => {
  it.each(["'", '"'])("detects and plans a pyproject-only FastAPI project using %s quotes", async (quote) => {
    await pyproject(`[project]\nname = 'fastapi-fixture'\nversion = '0.1.0'\nrequires-python = ${quote}>=3.11, <4${quote}\ndependencies = ['fastapi', 'uvicorn']\n`);
    await writeFile(join(cwd, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");

    const scan = await scanProject(cwd);
    expect(scan).toMatchObject({ language: "Python", framework: "FastAPI", packageManager: "pip", runtime: { name: "python", version: ">=3.11, <4" } });
    const steps = planStepsHeuristic(scan);
    expect(steps.find((step) => step.id === "runtime")?.command).toBe("python3 --version");
    expect(steps.find((step) => step.id === "deps")?.command).toBe("pip install .");
    expect(steps.some((step) => step.command?.includes("requirements.txt"))).toBe(false);
  });

  it("keeps requirements installs when both manifests exist", async () => {
    await pyproject("[project]\nname = 'demo'\nversion = '0.1.0'\nrequires-python = '>=3.11'\n");
    await writeFile(join(cwd, "requirements.txt"), "fastapi==0.115.0\n");
    const scan = await scanProject(cwd);
    expect(planStepsHeuristic(scan).find((step) => step.id === "deps")?.command).toBe("pip install -r requirements.txt");
  });

  it.each(["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock", "setup.py", "setup.cfg"])("retains Python with unknown version for %s", async (filename) => {
    await writeFile(join(cwd, filename), filename === "pyproject.toml" ? "[project]\nname = 'demo'\nversion = '0.1.0'\n" : "");
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: null });
  });

  it("detects a build-system-only Python package without a requirements file", async () => {
    await pyproject('[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n');
    const scan = await scanProject(cwd);
    expect(scan.packageManager).toBe("pip");
    expect(planStepsHeuristic(scan).find((step) => step.id === "deps")?.command).toBe("pip install .");
  });

  it("does not infer a pip installation from a tool-only pyproject", async () => {
    await pyproject('[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\naddopts = "-q"\n');
    const scan = await scanProject(cwd);
    expect(scan.packageManager).toBeNull();
    expect(planStepsHeuristic(scan).some((step) => step.id === "deps")).toBe(false);
  });

  it.each([["poetry.lock", "poetry"], ["Pipfile", "pipenv"]])("preserves the existing %s package-manager signal", async (filename, manager) => {
    await pyproject("[project]\nname = 'demo'\nversion = '0.1.0'\n");
    await writeFile(join(cwd, filename), "");
    expect(await detectPackageManager(cwd)).toBe(manager);
  });
});

describe("Python runtime constraints", () => {
  it("accepts whitespace and trailing comments on a standard one-line field", async () => {
    await pyproject("[project] # metadata\n  requires-python = '>=3.10,!=3.11.0' # supported versions\n");
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: ">=3.10,!=3.11.0" });
  });

  it("ignores commented and unrelated tool-table python keys", async () => {
    await pyproject('# requires-python = ">=2.7"\n[tool.example]\npython = "not-a-runtime"\nrequires-python = "also-not-a-runtime"\n[project]\nname = "demo"\nversion = "0.1.0"\n');
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: null });
  });

  it("prefers project requires-python over a legacy Poetry constraint", async () => {
    await pyproject('[tool.poetry.dependencies]\npython = "^3.9"\n[project]\nrequires-python = ">=3.11"\n');
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: ">=3.11" });
  });

  it.each(["'", '"'])("retains ordinary legacy Poetry constraints with %s quotes", async (quote) => {
    await pyproject(`[tool.poetry.dependencies]\npython = ${quote}^3.10${quote}\n`);
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: "^3.10" });
  });

  it.each([[".python-version", "3.12.2\n"], [".tool-versions", "python 3.12.2\n"]])("preserves %s precedence over project constraints", async (filename, contents) => {
    await pyproject('[project]\nrequires-python = ">=3.10"\n');
    await writeFile(join(cwd, filename), contents);
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: "3.12.2" });
  });

  it("does not parse multiline TOML string contents as runtime declarations", async () => {
    await pyproject('[tool.docs]\nexample = """\n[project]\nrequires-python = ">=9.9"\n"""\n');
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: null });
    expect(await detectPackageManager(cwd)).toBeNull();
  });

  it("leaves unsupported escaped constraint syntax unknown", async () => {
    await pyproject('[project]\nrequires-python = ">=3.\\u0031\\u0031"\n');
    expect(await detectRuntime(cwd)).toEqual({ name: "python", version: null });
  });

  it("does not invent Python for an empty directory", async () => {
    expect(await detectRuntime(cwd)).toBeNull();
    expect(await detectPackageManager(cwd)).toBeNull();
  });
});
