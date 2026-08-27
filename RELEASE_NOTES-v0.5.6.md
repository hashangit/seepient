# Seepient v0.5.6 Release Notes

Seepient v0.5.6 repairs outbound socket resolution for Node 20+, finishes brokered HTTP tool execution with output formatting, hardens settings validation and autonomous mode confirmation, removes dead legacy code, and adds retry resilience to the agent loop.

---

### Key changes

#### 1. Network and DNS resolution
* Fixed DNS lookup callback handling in `NodeNetworkAdapter`. On Node 20 and later, `net` requests lookups with `{ all: true }`. The adapter now returns an array of `{ address, family }` objects instead of a single string, preventing `ERR_INVALID_IP_ADDRESS` failures on outbound HTTP and HTTPS socket connections.

#### 2. Brokered tool execution and output formatting
* Connected `BrokerExecutor` to the shared `PreparationArtifactStore` so models receive tool response text instead of raw artifact identifiers.
* Corrected destination keys in tool analyzers from `path` to `pathPrefix`, ensuring outbound requests target intended endpoints such as `/search` and `/v1/chat/completions`.
* Corrected the Tavily search parameter from `depth` to `search_depth` and formatted search responses as clean Markdown.
* `read_website` strips HTML scripts and styles, limits output to 150,000 characters, and includes the HTTP status code in the response.
* Added skill discovery for `~/.agents/skills` alongside `~/.seepient/skills` and workspace skill directories.

#### 3. Consent mode and settings hardening
* Removed the legacy `permissions.autonomousMode` setting, unifying prompt-free execution under `permissions.consentMode: "autonomous"`.
* Added `permissions.autonomousWarned` to store one-time warning confirmations in workspace configuration.
* Added validation in `SettingsManager` for boolean and numeric values, with transactional rollback on failed mode switches.
* Added `/mode autonomous --confirm` confirmation requirements in the interactive readline REPL.
* Added error handling around slash-command skill launching in the TUI to prevent unhandled exceptions.

#### 4. Tool contracts and dead-code removal
* Made `ToolModule.handler` optional in contracts to support broker-only tools without dummy handlers.
* Removed direct HTTP fetch handlers from `SearchTool`, routing all web searches through the permission pipeline.
* Removed the unused `legacyHandlerBoundary` helper.
* Updated `executeTool` to throw an explicit error when invoked on tools without handlers.

#### 5. Agent loop resilience and file editing
* Added automatic retries with backoff (up to 2 retries) when providers return empty text responses without tool calls.
* Added extraction of in-band XML and Markdown tool calls when providers return text instead of structured calls.
* Added capture of reasoning tokens in canonical message history.
* Routed `edit_file` through `TrustedHostExecutor` to run hashline patches while preserving policy risk classification and audit logging.
* Added end-to-end integration tests for file editing through the permission pipeline.
