/**
 * Pinned Fetch Mechanism — Domain Network (Spec 021-2 / FR-015, D11)
 *
 * Direct socket lookup-override mechanism. Connects only to caller-validated
 * IP addresses, never re-resolves DNS. Preserves original Host header and TLS SNI.
 * Contains NO policy, redirect logic, or range validation (those belong in the caller).
 */

export {
  pinnedFetch,
  type PinnedFetchRequest,
  type PinnedFetchResponse,
} from "../../capabilities/execution/pinned-fetch.js";
