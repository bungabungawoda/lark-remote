/**
 * Self-update module for lark-remote.
 *
 * Provides version checking (npm registry query + cache),
 * package installation (detect package manager + global install),
 * and the combined workflow for the /update command and --update CLI flag.
 */

export {
  isNewer,
  checkLatestVersion,
  formatUpdateHint,
  type VersionCheckResult,
} from './version-check.js';
export { runInstallLatest, type InstallResult } from './install.js';
