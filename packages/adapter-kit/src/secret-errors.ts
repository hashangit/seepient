export class SecretStoreUnavailableError extends Error {
  readonly code = "SECRET_STORE_UNAVAILABLE";
  constructor(
    readonly status?: number,
    message = "Secret storage is unavailable; retry later",
  ) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}
export class SecretNotFoundError extends Error {
  readonly code = "SECRET_NOT_FOUND";
  constructor() {
    super("Secret reference does not resolve");
    this.name = "SecretNotFoundError";
  }
}
/** Fail-closed tenant credential resolution (029 FR-004): no stored credential
 * for the requested model and no operator-trusted platform account applies.
 * Never fall back to ambient env keys or another principal's account. */
export class ModelCredentialRequiredError extends Error {
  readonly code = "CREDENTIAL_REQUIRED";
  constructor(message = "No credential resolves for the requested model") {
    super(message);
    this.name = "ModelCredentialRequiredError";
  }
}
