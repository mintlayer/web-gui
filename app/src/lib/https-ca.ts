/**
 * Shared constants for the LAN HTTPS gateway (Caddy local CA).
 * Used by the root-CA download route, the Settings page, and tests so the
 * paths/filename never drift apart.
 */

/** Where the caddy container publishes the CA root (ca-public volume, ro). */
export const ROOT_CA_PATH = '/certs/root.crt';

/** Filename offered for the download (matches the Settings page instructions). */
export const DOWNLOAD_FILENAME = 'mintlayer-gui-local-root-ca.crt';
