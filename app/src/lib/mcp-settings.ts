/**
 * MCP settings decision logic, extracted from the Management → Settings page so
 * the security-critical rule (enabling AI write/spend access requires a valid
 * current TOTP code) is unit-testable independently of the Astro page.
 */
import { verifyTOTP } from '@/lib/auth';
import { getStringPref } from '@/lib/prefs-db';

export interface McpSettingsInput {
  enabled: boolean;
  allowActions: boolean;
  allowSpend: boolean;
  totpCode: string;
}

export type McpSettingsDecision =
  | { ok: true; prefs: { 'mcp.enabled': boolean; 'mcp.allow_actions': boolean; 'mcp.allow_spend': boolean } }
  | { ok: false; error: string };

/**
 * Decide the MCP permission prefs to persist. Write and fund-moving access are
 * only ever granted alongside `enabled`, and granting either is privileged:
 * it requires a configured 2FA secret and a valid current authenticator code,
 * so a hijacked session alone cannot hand an AI client spend access.
 */
export function resolveMcpSettings(input: McpSettingsInput): McpSettingsDecision {
  const allowActions = input.enabled && input.allowActions;
  const allowSpend = input.enabled && input.allowSpend;
  const grantsPrivilege = allowActions || allowSpend;

  if (grantsPrivilege) {
    const totpSecret = getStringPref('auth.totp_secret');
    if (!totpSecret) {
      return { ok: false, error: '2FA must be configured before enabling MCP write access.' };
    }
    if (!verifyTOTP(input.totpCode, totpSecret)) {
      return {
        ok: false,
        error: 'A valid authenticator code is required to enable wallet actions or fund-moving operations.',
      };
    }
  }

  return {
    ok: true,
    prefs: {
      'mcp.enabled': input.enabled,
      'mcp.allow_actions': allowActions,
      'mcp.allow_spend': allowSpend,
    },
  };
}
