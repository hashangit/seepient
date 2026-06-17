#!/usr/bin/env node
/**
 * zoe-channels standalone entry.
 *
 * Boots the channels gateway from merged config and runs until SIGINT/SIGTERM.
 */
import { runChannelsBinary } from "./bin.js";

runChannelsBinary().catch((err) => {
  console.error("[zoe-channels] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
