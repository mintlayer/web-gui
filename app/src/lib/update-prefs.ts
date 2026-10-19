import { getPref, setPref } from '@/lib/prefs-db';

/**
 * Update preferences, stored in the local prefs DB (never leaves the host).
 *
 * - auto-install: when on, a release check that finds a newer applicable
 *   version queues the upgrade for the enabler sidecar (lazy, on the next
 *   status GET — no cron, no telemetry). Default OFF: unattended upgrades
 *   restart the whole stack, so this must be an explicit decision.
 * - include-prereleases: rc/beta tags count as "newer". Default OFF. Auto
 *   installs never jump to a pre-release unless this is also on.
 *
 * Changing either setting requires step-up (the toggle is the trust anchor:
 * auto mode means future upgrades happen without anyone at the keyboard).
 */

export const UPDATE_AUTO_INSTALL_KEY = 'ml_update_auto_install';
export const UPDATE_INCLUDE_PRERELEASES_KEY = 'ml_update_include_prereleases';

export function isAutoInstallEnabled(): boolean {
  return getPref<boolean>(UPDATE_AUTO_INSTALL_KEY) === true;
}

export function isIncludePrereleasesEnabled(): boolean {
  return getPref<boolean>(UPDATE_INCLUDE_PRERELEASES_KEY) === true;
}

export function setAutoInstallEnabled(value: boolean): void {
  setPref(UPDATE_AUTO_INSTALL_KEY, value === true);
}

export function setIncludePrereleasesEnabled(value: boolean): void {
  setPref(UPDATE_INCLUDE_PRERELEASES_KEY, value === true);
}
