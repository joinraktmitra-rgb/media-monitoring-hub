#!/usr/bin/env bun
/**
 * Ampio Media Intelligence — CLI API Key Manager
 * Usage:
 *   bun run src/cli/auth.ts create --client "Piyush ChatGPT" --topics "*" --rate-limit 120
 *   bun run src/cli/auth.ts list
 *   bun run src/cli/auth.ts revoke --id <key_id>
 */
import { createApiKey, listApiKeys, revokeApiKey } from '../mcp/db.ts';

function parseFlags(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    }
  }
  return flags;
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (cmd) {
  case 'create': {
    const client = String(flags.client || 'Default Client');
    const topics = String(flags.topics || '*');
    const rateLimit = Number(flags['rate-limit'] || 120);
    const created = createApiKey(client, topics, rateLimit);
    console.log('\n✅ API Key Created (Save this now — raw key is only shown once):');
    console.log(JSON.stringify(created, null, 2));
    console.log(`\nHeader: Authorization: Bearer ${created.api_key}\n`);
    break;
  }
  case 'list': {
    const keys = listApiKeys();
    console.log(JSON.stringify(keys, null, 2));
    break;
  }
  case 'revoke': {
    const id = String(flags.id || '');
    if (!id) {
      console.error('Usage: bun run src/cli/auth.ts revoke --id <key_id>');
      process.exit(1);
    }
    const ok = revokeApiKey(id);
    console.log(ok ? `✅ Revoked key ${id}` : `⚠️ Key ${id} not found`);
    break;
  }
  default:
    console.log(`Usage:
  bun run src/cli/auth.ts create --client "Client Name" [--topics "*"] [--rate-limit 120]
  bun run src/cli/auth.ts list
  bun run src/cli/auth.ts revoke --id <key_id>`);
}
