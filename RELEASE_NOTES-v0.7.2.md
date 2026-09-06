# Seepient 0.7.2

This patch release stops tool crashes on multiline model output, adds self-healing feedback when models produce bad JSON, and ensures the terminal interface tells the visual truth when a tool fails or gets denied.

## Models fix their own malformed arguments

When models generated large file writes or patches, they occasionally emitted unescaped literal newlines or wrapped JSON arguments in markdown code blocks. In 0.7.1, Node's parser threw a syntax error, the agent loop packaged the raw string as `{ raw: ... }`, and downstream path checks crashed with `TypeError: The "path" argument must be of type string. Received undefined`.

Seepient now handles this in two stages. First, a lightweight sanitizer strips surrounding markdown fences and repairs unescaped control characters inside string literals before parsing. Second, if the payload is still invalid JSON, Seepient stops execution immediately and returns a structured contract violation error directly to the model. The model receives clear guidance on what went wrong and re-issues the tool call with valid JSON. Your session stays alive, and broken arguments never reach the disk or execution brokers.

## Analyzers validate parameters up front

Tool analyzers now check required arguments and validate types before calling path utilities. Missing or empty paths in `write_file` or `read_file` raise explicit model contract violations instead of unhandled runtime errors. This separates schema-level mistakes from security policy denials, so logs and audit events report the real reason a tool call stopped.

## Terminal status glyphs show real outcomes

In the terminal UI, tool calls previously rendered with a green checkmark even when execution failed or security policy denied the action. The feed hook now inspects tool results and assigns a red cross whenever an error or denial occurs. We also tightened the denial matcher to prevent false positives when commands or file reads legitimately contain the word "denied".

## Documentation and build fixes

* The documentation site now lives as a workspace member in `pnpm-workspace.yaml`, ensuring automated CI deployments install site dependencies cleanly.
* Added domain root serving and CNAME configuration for `seepient.zyntopia.com`.
