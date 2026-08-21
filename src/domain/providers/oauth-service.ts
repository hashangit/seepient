/**
 * 013 T039 / Phase 9 — Domain-level OAuth service.
 *
 * Exposes available OAuth flows and loader routines to the transport layer,
 * isolating vendor auth adapters within the Domain layer.
 */
import {
  AVAILABLE_OAUTH_FLOWS,
  getOAuthFlow,
  isOAuthSupported,
} from "../../vendors/pi-ai/pi-auth-adapter.js";

export { AVAILABLE_OAUTH_FLOWS, getOAuthFlow, isOAuthSupported };

export async function getAvailableOAuthFlows(): Promise<readonly string[]> {
  return AVAILABLE_OAUTH_FLOWS;
}
