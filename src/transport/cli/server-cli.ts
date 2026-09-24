/**
 * Shared Server CLI Arguments Parser
 *
 * Single truth for server command-line options across:
 * - `seepient-server` (standalone binary)
 * - `seepient server` (CLI subcommand)
 */

export interface ServerCliArgs {
  port?: number;
  host?: string;
  generateApiKey?: boolean;
  /** Operator provider config file (overlay shape), loaded once at boot */
  providersFile?: string;
  /** API keys file path (default: SEEPIENT_API_KEYS_FILE or ~/.seepient/server-keys.json) */
  apiKeysFile?: string;
}
export const SERVER_CLI_FLAGS = ['--port', '--host', '--generate-api-key', '--providers-file', '--api-keys-file', '--help', '-h', '--version', '-v'] as const;

export function parseServerCliArgs(argv: string[]): ServerCliArgs {
  const result: ServerCliArgs = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--port') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        throw new Error('Option "--port" requires an argument');
      }
      const parsed = parseInt(argv[i + 1], 10);
      if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error(`Invalid port: "${argv[i + 1]}"`);
      }
      result.port = parsed;
      i += 2;
    } else if (arg.startsWith('--port=')) {
      const val = arg.slice('--port='.length);
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error(`Invalid port: "${val}"`);
      }
      result.port = parsed;
      i += 1;
    } else if (arg === '--host') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        throw new Error('Option "--host" requires an argument');
      }
      result.host = argv[i + 1];
      i += 2;
    } else if (arg.startsWith('--host=')) {
      result.host = arg.slice('--host='.length);
      i += 1;
    } else if (arg === '--generate-api-key') {
      result.generateApiKey = true;
      i += 1;
    } else if (arg === '--providers-file') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        throw new Error('Option "--providers-file" requires an argument');
      }
      result.providersFile = argv[i + 1];
      i += 2;
    } else if (arg.startsWith('--providers-file=')) {
      result.providersFile = arg.slice('--providers-file='.length);
      i += 1;
    } else if (arg === '--api-keys-file') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        throw new Error('Option "--api-keys-file" requires an argument');
      }
      result.apiKeysFile = argv[i + 1];
      i += 2;
    } else if (arg.startsWith('--api-keys-file=')) {
      result.apiKeysFile = arg.slice('--api-keys-file='.length);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      // Allow help flags
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: "${arg}"`);
    } else {
      i += 1;
    }
  }

  // Precedence: CLI flag > SEEPIENT_PORT/PORT, SEEPIENT_HOST > default
  if (result.port === undefined) {
    const envPort = process.env.SEEPIENT_PORT ?? process.env.PORT;
    if (envPort) {
      const parsed = parseInt(envPort, 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        result.port = parsed;
      }
    }
  }

  if (result.host === undefined) {
    if (process.env.SEEPIENT_HOST) {
      result.host = process.env.SEEPIENT_HOST;
    }
  }

  return result;
}
