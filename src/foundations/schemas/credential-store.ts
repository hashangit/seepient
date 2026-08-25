import Type from "typebox";

// ── Credential Reference Grammar ──────────────────────────────────────────
export const CredentialRefSchema = Type.Union([
  Type.Object({ kind: Type.Literal("env"), name: Type.String() }),
  Type.Object({ kind: Type.Literal("seepient"), id: Type.String() }),
  Type.Object({
    kind: Type.Literal("keychain"),
    account: Type.String(),
    service: Type.Optional(Type.String()),
  }),
  Type.Object({ kind: Type.Literal("externalsecret"), ref: Type.String() }),
  Type.Object({ kind: Type.Literal("none") }),
]);
export type CredentialRef = Type.Static<typeof CredentialRefSchema>;

// ── Credential Metadata ───────────────────────────────────────────────────
export const CredentialMetaSchema = Type.Object({
  description: Type.Optional(Type.String()),
  providerAccountHint: Type.Optional(Type.String()),
  source: Type.Optional(
    Type.Union([
      Type.Literal("env"),
      Type.Literal("disk"),
      Type.Literal("keychain"),
      Type.Literal("migration"),
    ]),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
});
export type CredentialMeta = Type.Static<typeof CredentialMetaSchema>;

// ── Persisted Record Shapes (no secrets returned in metadata/list) ────────
export const CredentialRecordSchema = Type.Object({
  id: Type.String(),
  materialKind: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  meta: Type.Optional(CredentialMetaSchema),
});
export type CredentialRecord = Type.Static<typeof CredentialRecordSchema>;

export const PersistedCredentialRecordSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("api_key"),
    keyValue: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("oauth"),
    refresh: Type.String(),
    access: Type.String(),
    expires: Type.Number(),
  }),
]);
export type PersistedCredentialRecord = Type.Static<typeof PersistedCredentialRecordSchema>;
