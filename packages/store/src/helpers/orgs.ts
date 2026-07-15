import { isReservedSubject, VendoError, type IsoDateTime } from "@vendoai/core";
import { randomUUID } from "node:crypto";
import { withOrgMembershipLock } from "../db.js";
import { dbFor, type VendoStore } from "../store.js";
import { iso, text } from "./utils.js";

/** Block-actions design §C — org membership roles: members run, admins approve
    and manage, owners additionally control the owner set itself. */
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = typeof ORG_ROLES[number];

export interface OrgRow {
  id: string;
  name: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface OrgMemberRow {
  orgId: string;
  subject: string;
  role: OrgRole;
  addedAt: IsoDateTime;
}

function orgFromRow(row: Record<string, unknown>): OrgRow {
  return {
    id: text(row["id"]),
    name: text(row["name"]),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

function memberFromRow(row: Record<string, unknown>): OrgMemberRow {
  return {
    orgId: text(row["org_id"]),
    subject: text(row["subject"]),
    role: parseRole(text(row["role"])),
    addedAt: iso(row["added_at"]),
  };
}

function parseRole(value: string): OrgRole {
  if ((ORG_ROLES as readonly string[]).includes(value)) return value as OrgRole;
  throw new VendoError("validation", `org role must be one of ${ORG_ROLES.join(", ")}`);
}

/** Only real, host-resolvable subjects can hold org membership: reserved
    (runtime-minted) subjects have no session to act from, and an anonymous
    visitor's ephemeral subject evaporates with the process. */
function guardMemberSubject(subject: string): void {
  if (subject.length === 0) throw new VendoError("validation", "org member subject must be non-empty");
  if (isReservedSubject(subject) || subject.startsWith("webhook:")) {
    throw new VendoError("validation", "reserved synthetic subjects cannot hold org membership");
  }
}

/** 02-store (block-actions design §C) — the Vendo-owned org tables. All role
    enforcement beyond storage invariants (who may call what) lives at the wire;
    the two invariants owned HERE are role validity and never orphaning an org
    (the last owner can neither leave nor be demoted). */
export function orgStore(store: VendoStore): {
  create(name: string, ownerSubject: string): Promise<OrgRow>;
  get(orgId: string): Promise<OrgRow | null>;
  listByMember(subject: string): Promise<Array<OrgRow & { role: OrgRole }>>;
  members(orgId: string): Promise<OrgMemberRow[]>;
  roleOf(orgId: string, subject: string): Promise<OrgRole | null>;
  addMember(orgId: string, subject: string, role: OrgRole): Promise<OrgMemberRow>;
  setRole(orgId: string, subject: string, role: OrgRole): Promise<OrgMemberRow>;
  removeMember(orgId: string, subject: string): Promise<void>;
} {
  const db = dbFor(store);

  async function requireOrg(orgId: string): Promise<OrgRow> {
    const result = await db.query(
      "SELECT id, name, created_at, updated_at FROM vendo_orgs WHERE id = $1",
      [orgId],
    );
    if (result.rows[0] === undefined) throw new VendoError("not-found", `org not found: ${orgId}`);
    return orgFromRow(result.rows[0]);
  }

  async function roleOf(orgId: string, subject: string): Promise<OrgRole | null> {
    const result = await db.query(
      "SELECT role FROM vendo_org_members WHERE org_id = $1 AND subject = $2",
      [orgId, subject],
    );
    return result.rows[0] ? parseRole(text(result.rows[0]["role"])) : null;
  }

  return {
    async create(name, ownerSubject) {
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > 200) {
        throw new VendoError("validation", "org name must be 1-200 characters");
      }
      guardMemberSubject(ownerSubject);
      const id = `org_${randomUUID().replaceAll("-", "")}`;
      const now = new Date().toISOString();
      const result = await db.query(
        `INSERT INTO vendo_orgs (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3) RETURNING id, name, created_at, updated_at`,
        [id, trimmed, now],
      );
      await db.query(
        "INSERT INTO vendo_org_members (org_id, subject, role, added_at) VALUES ($1, $2, 'owner', $3)",
        [id, ownerSubject, now],
      );
      return orgFromRow(result.rows[0] as Record<string, unknown>);
    },

    async get(orgId) {
      const result = await db.query(
        "SELECT id, name, created_at, updated_at FROM vendo_orgs WHERE id = $1",
        [orgId],
      );
      return result.rows[0] ? orgFromRow(result.rows[0]) : null;
    },

    async listByMember(subject) {
      const result = await db.query(
        `SELECT o.id, o.name, o.created_at, o.updated_at, m.role
         FROM vendo_orgs o JOIN vendo_org_members m ON m.org_id = o.id
         WHERE m.subject = $1 ORDER BY o.created_at ASC, o.id ASC`,
        [subject],
      );
      return result.rows.map((row) => ({ ...orgFromRow(row), role: parseRole(text(row["role"])) }));
    },

    async members(orgId) {
      await requireOrg(orgId);
      const result = await db.query(
        `SELECT org_id, subject, role, added_at FROM vendo_org_members
         WHERE org_id = $1 ORDER BY added_at ASC, subject ASC`,
        [orgId],
      );
      return result.rows.map(memberFromRow);
    },

    roleOf,

    async addMember(orgId, subject, role) {
      parseRole(role);
      guardMemberSubject(subject);
      await requireOrg(orgId);
      const now = new Date().toISOString();
      const result = await db.query(
        `INSERT INTO vendo_org_members (org_id, subject, role, added_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, subject) DO NOTHING
         RETURNING org_id, subject, role, added_at`,
        [orgId, subject, role, now],
      );
      if (result.rows[0] === undefined) {
        throw new VendoError("conflict", `${subject} is already a member of ${orgId}`);
      }
      return memberFromRow(result.rows[0]);
    },

    async setRole(orgId, subject, role) {
      parseRole(role);
      await requireOrg(orgId);
      // Demoting the LAST owner would orphan the org. The count-then-write
      // guard races under READ COMMITTED (two owners each see the other and
      // both commit → zero owners), so serialize owner-set writes per org.
      // The guard also lives in the UPDATE's WHERE as a second line of defense.
      const result = await withOrgMembershipLock(db, orgId, (query) => query(
        `UPDATE vendo_org_members SET role = $3
         WHERE org_id = $1 AND subject = $2
           AND (role <> 'owner' OR $3 = 'owner'
             OR (SELECT count(*) FROM vendo_org_members WHERE org_id = $1 AND role = 'owner') > 1)
         RETURNING org_id, subject, role, added_at`,
        [orgId, subject, role],
      ));
      if (result.rows[0] === undefined) {
        const current = await roleOf(orgId, subject);
        if (current === null) throw new VendoError("not-found", `${subject} is not a member of ${orgId}`);
        throw new VendoError("conflict", "an org must keep at least one owner");
      }
      return memberFromRow(result.rows[0]);
    },

    async removeMember(orgId, subject) {
      await requireOrg(orgId);
      const result = await withOrgMembershipLock(db, orgId, (query) => query(
        `DELETE FROM vendo_org_members
         WHERE org_id = $1 AND subject = $2
           AND (role <> 'owner'
             OR (SELECT count(*) FROM vendo_org_members WHERE org_id = $1 AND role = 'owner') > 1)
         RETURNING subject`,
        [orgId, subject],
      ));
      if (result.rows[0] === undefined) {
        const current = await roleOf(orgId, subject);
        if (current === null) throw new VendoError("not-found", `${subject} is not a member of ${orgId}`);
        throw new VendoError("conflict", "an org must keep at least one owner");
      }
    },
  };
}
