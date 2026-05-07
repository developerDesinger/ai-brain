import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_HOME } from "./paths.js";
import { ProjectRecord } from "./projects.js";

/**
 * Generate platform service files (launchd plist on macOS, systemd unit on Linux)
 * so `brain watch` runs as a managed background service that survives reboots.
 *
 * Defaults are conservative: rendering writes the file under the user's
 * launchd / systemd directory but does NOT load it automatically. Pass
 * `install: true` (the CLI maps this to `--install`) to also bootstrap the
 * service into the user agent so it starts running immediately and at login.
 */

export type ServicePlatform = "launchd" | "systemd";

export function detectPlatform(): ServicePlatform {
  const p = platform();
  if (p === "darwin") return "launchd";
  if (p === "linux") return "systemd";
  throw new Error(
    `brain service is not supported on '${p}'. Supported: macOS (launchd), Linux (systemd).`,
  );
}

function templatesDir(): string {
  // Engine layout: <ENGINE_HOME>/service-templates/
  return join(ENGINE_HOME, "service-templates");
}

function brainCliPath(): string {
  // Resolve the compiled CLI we're currently running from. This file lives at
  // <engine>/core/dist/service.js after build, so cli.js is a sibling.
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "cli.js");
  } catch {
    return resolve(ENGINE_HOME, "core", "dist", "cli.js");
  }
}

function nodeBinary(): string {
  return process.execPath;
}

export interface ServiceLayout {
  platform: ServicePlatform;
  /** Stable identifier used in label / unit name, derived from project ID. */
  identifier: string;
  /** Absolute path of the rendered service file. */
  serviceFile: string;
  /** Directory log files will land in. */
  logDir: string;
  /** launchd-only: the Label string. */
  label?: string;
  /** systemd-only: the unit basename. */
  unitName?: string;
}

export function describeLayout(project: ProjectRecord): ServiceLayout {
  const plat = detectPlatform();
  const identifier = project.id;
  const home = homedir();
  const logDir = join(home, ".ai-brain", "logs");

  if (plat === "launchd") {
    const label = `com.ai-brain.watch.${identifier}`;
    const serviceFile = join(home, "Library", "LaunchAgents", `${label}.plist`);
    return { platform: plat, identifier, serviceFile, logDir, label };
  }

  const unitName = `ai-brain-watch-${identifier}.service`;
  const serviceFile = join(home, ".config", "systemd", "user", unitName);
  return { platform: plat, identifier, serviceFile, logDir, unitName };
}

interface RenderInputs {
  project: ProjectRecord;
  debounceMs: number;
}

function renderTemplate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`,
  );
}

function renderLaunchd(inputs: RenderInputs, layout: ServiceLayout): string {
  const tmplPath = join(templatesDir(), "launchd.plist.tmpl");
  if (!existsSync(tmplPath)) {
    throw new Error(`Missing template: ${tmplPath}`);
  }
  const tmpl = readFileSync(tmplPath, "utf8");
  return renderTemplate(tmpl, {
    LABEL: layout.label!,
    NODE_BIN: nodeBinary(),
    BRAIN_CLI: brainCliPath(),
    PROJECT_ROOT: inputs.project.root,
    DEBOUNCE_MS: String(inputs.debounceMs),
    LOG_DIR: layout.logDir,
    PATH_ENV: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME_ENV: homedir(),
    AI_BRAIN_HOME: process.env.AI_BRAIN_HOME ?? join(homedir(), ".ai-brain"),
  });
}

function renderSystemd(inputs: RenderInputs, layout: ServiceLayout): string {
  const tmplPath = join(templatesDir(), "systemd.service.tmpl");
  if (!existsSync(tmplPath)) {
    throw new Error(`Missing template: ${tmplPath}`);
  }
  const tmpl = readFileSync(tmplPath, "utf8");
  return renderTemplate(tmpl, {
    PROJECT_NAME: inputs.project.name,
    PROJECT_ID: inputs.project.id,
    PROJECT_ROOT: inputs.project.root,
    NODE_BIN: nodeBinary(),
    BRAIN_CLI: brainCliPath(),
    DEBOUNCE_MS: String(inputs.debounceMs),
    UNIT_NAME: layout.unitName!.replace(/\.service$/, ""),
    LOG_DIR: layout.logDir,
    PATH_ENV: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME_ENV: homedir(),
    AI_BRAIN_HOME: process.env.AI_BRAIN_HOME ?? join(homedir(), ".ai-brain"),
  });
}

export interface RenderOptions {
  debounceMs?: number;
}

export interface RenderResult {
  layout: ServiceLayout;
  content: string;
}

export function render(project: ProjectRecord, opts: RenderOptions = {}): RenderResult {
  const layout = describeLayout(project);
  const inputs: RenderInputs = {
    project,
    debounceMs: opts.debounceMs ?? 1000,
  };
  const content =
    layout.platform === "launchd"
      ? renderLaunchd(inputs, layout)
      : renderSystemd(inputs, layout);
  return { layout, content };
}

export interface InstallOptions extends RenderOptions {
  /** Actually load the service into launchd / systemd. Default: false (file-only). */
  load?: boolean;
}

export interface InstallResult {
  layout: ServiceLayout;
  /** True if the file was written (or rewritten). */
  wrote: boolean;
  /** True if the service was loaded into the system. */
  loaded: boolean;
  /** Human-readable next-step hints printed when load=false. */
  hints: string[];
}

export function install(project: ProjectRecord, opts: InstallOptions = {}): InstallResult {
  const { layout, content } = render(project, opts);
  mkdirSync(dirname(layout.serviceFile), { recursive: true });
  mkdirSync(layout.logDir, { recursive: true });
  writeFileSync(layout.serviceFile, content);
  if (layout.platform === "systemd") chmodSync(layout.serviceFile, 0o644);

  const hints: string[] = [];
  let loaded = false;

  if (opts.load) {
    if (layout.platform === "launchd") {
      const uid = process.getuid?.() ?? 0;
      // bootout first in case we're replacing an existing one — ignore errors.
      spawnSync("launchctl", ["bootout", `gui/${uid}/${layout.label}`], {
        stdio: "ignore",
      });
      const r = spawnSync(
        "launchctl",
        ["bootstrap", `gui/${uid}`, layout.serviceFile],
        { stdio: "inherit" },
      );
      if (r.status !== 0) {
        throw new Error(
          `launchctl bootstrap failed (exit ${r.status}). The plist is at ${layout.serviceFile}; you can load it manually.`,
        );
      }
      // Kickstart so it runs immediately.
      spawnSync(
        "launchctl",
        ["kickstart", "-k", `gui/${uid}/${layout.label}`],
        { stdio: "ignore" },
      );
      loaded = true;
    } else {
      const reload = spawnSync("systemctl", ["--user", "daemon-reload"], {
        stdio: "inherit",
      });
      if (reload.status !== 0) {
        throw new Error(
          `systemctl --user daemon-reload failed (exit ${reload.status}). Is systemd --user available?`,
        );
      }
      const enable = spawnSync(
        "systemctl",
        ["--user", "enable", "--now", layout.unitName!],
        { stdio: "inherit" },
      );
      if (enable.status !== 0) {
        throw new Error(
          `systemctl --user enable --now failed (exit ${enable.status}).`,
        );
      }
      loaded = true;
    }
  } else {
    if (layout.platform === "launchd") {
      const uid = process.getuid?.() ?? 0;
      hints.push(
        `Load it now:    launchctl bootstrap gui/${uid} ${shellQuote(layout.serviceFile)}`,
        `Start now:      launchctl kickstart -k gui/${uid}/${layout.label}`,
        `Status:         launchctl print gui/${uid}/${layout.label}`,
        `Unload:         launchctl bootout gui/${uid}/${layout.label}`,
      );
    } else {
      hints.push(
        `Reload:         systemctl --user daemon-reload`,
        `Enable + start: systemctl --user enable --now ${layout.unitName}`,
        `Status:         systemctl --user status ${layout.unitName}`,
        `Logs:           journalctl --user -u ${layout.unitName} -f`,
      );
    }
  }

  return { layout, wrote: true, loaded, hints };
}

export interface UninstallResult {
  layout: ServiceLayout;
  removedFile: boolean;
  unloaded: boolean;
}

export function uninstall(project: ProjectRecord): UninstallResult {
  const layout = describeLayout(project);
  let unloaded = false;

  if (layout.platform === "launchd") {
    const uid = process.getuid?.() ?? 0;
    const r = spawnSync("launchctl", ["bootout", `gui/${uid}/${layout.label}`], {
      stdio: "ignore",
    });
    unloaded = r.status === 0;
  } else {
    const stop = spawnSync(
      "systemctl",
      ["--user", "disable", "--now", layout.unitName!],
      { stdio: "ignore" },
    );
    unloaded = stop.status === 0;
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }

  let removedFile = false;
  if (existsSync(layout.serviceFile)) {
    rmSync(layout.serviceFile);
    removedFile = true;
  }
  return { layout, removedFile, unloaded };
}

export interface StatusResult {
  layout: ServiceLayout;
  fileExists: boolean;
  /** Best-effort short status string from the platform tool. */
  status: string;
  /** Raw output of the status command (may be long). */
  raw: string;
}

export function status(project: ProjectRecord): StatusResult {
  const layout = describeLayout(project);
  const fileExists = existsSync(layout.serviceFile);

  if (layout.platform === "launchd") {
    const uid = process.getuid?.() ?? 0;
    const r = spawnSync(
      "launchctl",
      ["print", `gui/${uid}/${layout.label}`],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      return {
        layout,
        fileExists,
        status: fileExists ? "not loaded" : "not installed",
        raw: r.stderr || r.stdout || "",
      };
    }
    const stateLine = r.stdout
      .split("\n")
      .find((l) => /^\s*state\s*=\s*/.test(l));
    const state = stateLine?.split("=")[1]?.trim() ?? "loaded";
    return { layout, fileExists, status: state, raw: r.stdout };
  }

  const r = spawnSync(
    "systemctl",
    ["--user", "is-active", layout.unitName!],
    { encoding: "utf8" },
  );
  const active = r.stdout.trim();
  const r2 = spawnSync(
    "systemctl",
    ["--user", "status", "--no-pager", layout.unitName!],
    { encoding: "utf8" },
  );
  return {
    layout,
    fileExists,
    status: active || (fileExists ? "inactive" : "not installed"),
    raw: r2.stdout || r2.stderr || "",
  };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

