import type { RealtimeFanout, SecretStore } from "@seepients/adapter-kit";
import { createSecretStore } from "@seepients/adapters";
import { resolveEncryptionKey } from "@seepients/core";

/** Worker composition without starting job hosts or database connections. */
export async function createWorkerSecretStore(
  source: NodeJS.ProcessEnv,
  realtime?: RealtimeFanout,
): Promise<SecretStore> {
  const store = createSecretStore(resolveEncryptionKey(source), source, realtime);
  await store.start();
  return store;
}
