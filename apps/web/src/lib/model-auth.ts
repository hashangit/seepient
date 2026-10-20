import { waitForModelOAuthCompletion } from "@seepients/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@seepients/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@seepients/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
