/**
 * settings-migration.ts — Seeds the prefs DB from .env on first startup.
 *
 * Runs as a module-level side effect (imported once per Node process).
 * Only writes a key if it is absent from the DB — idempotent on every
 * subsequent startup.
 */

import { getPref, setPref } from './prefs-db';

const MIGRATIONS: Array<{ key: string; envVar: string }> = [
  { key: 'auth.password_hash',  envVar: 'UI_PASSWORD_HASH' },
  { key: 'auth.totp_secret',    envVar: 'UI_TOTP_SECRET'   },
  { key: 'ipfs.provider',       envVar: 'IPFS_PROVIDER'    },
  { key: 'ipfs.filebase_token', envVar: 'FILEBASE_TOKEN'   },
  { key: 'ipfs.pinata_jwt',     envVar: 'PINATA_JWT'       },
];

for (const { key, envVar } of MIGRATIONS) {
  if (getPref<string>(key) === null) {
    const val = process.env[envVar] ?? '';
    if (val) {
      setPref(key, val);
      console.log(`[settings-migration] seeded ${key} from ${envVar}`);
    }
  }
}
