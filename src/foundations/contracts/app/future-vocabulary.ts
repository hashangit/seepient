/**
 * Application Future Vocabulary — Foundations (spec 029, M02 S05, FR-013).
 *
 * Type-level vocabulary for `Project, Membership, Session, Team, Revision` —
 * names, relations, and ID links ONLY, sufficient for the P1/P2/P3/P10
 * consumers that arrive after this spec. NO schema, NO behavior, NO UI: a
 * review grep must find no method bodies beyond pure relation accessors, and
 * any growth beyond vocabulary invalidates this module (spec review rule).
 *
 * `Team` and `Revision` IDs are minted here as vocabulary brands; they are
 * deliberately NOT part of the S05 14-kind identity map (identity.ts), which
 * covers only kinds with trusted-resolution rules today.
 */

import type { DisplayName, IdBrand, MembershipId, OrgSpaceId, PrincipalId, ProjectId, SessionId } from "./identity.js";

export type TeamId = IdBrand<"team">;
export type RevisionId = IdBrand<"revision">;

/** Opaque membership role label — vocabulary only; values are owned by the membership service later. */
export type MembershipRole = IdBrand<"membershipRole">;

/** A project groups sessions inside an organization/space. */
export interface ProjectRef {
  readonly id: ProjectId;
  readonly orgSpaceId: OrgSpaceId;
  readonly displayName: DisplayName;
}

/** A principal's membership in an organization/space (future: project-scoped memberships). */
export interface MembershipRef {
  readonly id: MembershipId;
  readonly principalId: PrincipalId;
  readonly orgSpaceId: OrgSpaceId;
  readonly role: MembershipRole;
}

/** A conversation session; may belong to a project once projects exist (ID link only). */
export interface SessionRef {
  readonly id: SessionId;
  readonly orgSpaceId: OrgSpaceId;
  readonly projectId?: ProjectId;
}

/** A team is a named group of memberships inside an organization/space. */
export interface TeamRef {
  readonly id: TeamId;
  readonly orgSpaceId: OrgSpaceId;
  readonly displayName: DisplayName;
}

/** Point-in-time revision of an owned resource (documents, prompts, configs). */
export interface RevisionRef {
  readonly id: RevisionId;
  readonly orgSpaceId: OrgSpaceId;
  readonly createdAt: string;
}

/** Team roster — pure relation: which memberships belong to a team. */
export interface TeamRoster {
  readonly teamId: TeamId;
  readonly memberIds: ReadonlyArray<MembershipId>;
}
