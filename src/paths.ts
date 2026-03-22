import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Root of the checked-out repo or installed package. */
export const PACKAGE_ROOT = resolve(MODULE_DIR, "..");

/** Base directory for all Max user data: ~/.max */
export const MAX_HOME = join(homedir(), ".max");

/** Path to Max's user-owned workspace */
export const WORKSPACE_DIR = join(MAX_HOME, "workspace");

/** Path to assistant profile markdown files */
export const PROFILE_DIR = join(WORKSPACE_DIR, "profile");

/** Bundled default markdown files that seed the workspace profile during setup/startup. */
export const DEFAULT_PROFILE_TEMPLATES_DIR = join(PACKAGE_ROOT, "defaults", "profile");

/** Bootstrap file shipped with the repo/package. */
export const BOOTSTRAP_SOURCE_PATH = join(DEFAULT_PROFILE_TEMPLATES_DIR, "BOOTSTRAP.md");

/** One-time marker so repo bootstrap is only seeded once per local profile. */
export const BOOTSTRAP_SEEDED_MARKER_PATH = join(PROFILE_DIR, ".bootstrap-seeded");

/** Detect local git checkouts so the shipped bootstrap can be removed after seeding. */
export const LOCAL_GIT_DIR_PATH = join(PACKAGE_ROOT, ".git");

/** Path to the SQLite database */
export const DB_PATH = join(MAX_HOME, "max.db");

/** Path to the user .env file */
export const ENV_PATH = join(MAX_HOME, ".env");

/** Path to user-local skills */
export const SKILLS_DIR = join(MAX_HOME, "skills");

/** Path to Max's isolated session state (keeps CLI history clean) */
export const SESSIONS_DIR = join(MAX_HOME, "sessions");

/** Path to TUI readline history */
export const HISTORY_PATH = join(MAX_HOME, "tui_history");

/** Path to optional TUI debug log */
export const TUI_DEBUG_LOG_PATH = join(MAX_HOME, "tui-debug.log");

/** Path to the API bearer token file */
export const API_TOKEN_PATH = join(MAX_HOME, "api-token");

/** Ensure ~/.max/ exists */
export function ensureMaxHome(): void {
  mkdirSync(MAX_HOME, { recursive: true });
}
