import { useEffect, useState, type FormEvent } from "react";
import { useVendoContext } from "../context.js";
import { useOrgs } from "../hooks/use-orgs.js";
import type { OrgMember, OrgRole } from "../wire-types.js";
import { ChromeRoot } from "./chrome-root.js";

const ROLES: OrgRole[] = ["member", "admin", "owner"];

function roleLabel(role: OrgRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

function MemberRow(props: {
  orgId: string;
  member: OrgMember;
  canManage: boolean;
  onRole(role: OrgRole): Promise<void>;
  onRemove(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (action: () => Promise<void>) => {
    setError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fl-auto-head" style={{ alignItems: "center", gap: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div className="fl-auto-title" style={{ overflowWrap: "anywhere" }}>{props.member.subject}</div>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
      </div>
      {props.canManage ? (
        <>
          <label style={{ marginLeft: "auto" }}>
            <span className="fl-visually-hidden" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              Role for {props.member.subject}
            </span>
            <select
              className="fl-btn"
              value={props.member.role}
              disabled={busy}
              onChange={(event) => void act(() => props.onRole(event.target.value as OrgRole))}
            >
              {ROLES.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
            </select>
          </label>
          <button
            className="fl-btn fl-btn-ceremony"
            type="button"
            disabled={busy}
            aria-label={`Remove ${props.member.subject}`}
            onClick={() => void act(props.onRemove)}
          >Remove</button>
        </>
      ) : (
        <span className="fl-auto-sub" style={{ marginLeft: "auto" }}>{roleLabel(props.member.role)}</span>
      )}
    </div>
  );
}

function OrgCard(props: { orgId: string; name: string; role: OrgRole }) {
  const { client } = useVendoContext();
  const { addMember, setRole, removeMember } = useOrgs();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invite, setInvite] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [error, setError] = useState<string>();
  const canManage = props.role === "admin" || props.role === "owner";

  const load = async () => {
    try {
      setMembers((await client.orgs.get(props.orgId)).members);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  useEffect(() => { void load(); }, [client, props.orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (invite.trim().length === 0) return;
    setError(undefined);
    try {
      await addMember(props.orgId, invite.trim(), inviteRole);
      setInvite("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <article className="fl-automation" aria-label={`Org ${props.name}`}>
      <div className="fl-auto-head">
        <div>
          <div className="fl-auto-title">{props.name}</div>
          <div className="fl-auto-sub">
            {members.length === 1 ? "1 member" : `${members.length} members`} · you are {roleLabel(props.role).toLowerCase()}
          </div>
        </div>
      </div>
      {error ? <div role="alert" className="fl-error">{error}</div> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {members.map(member => (
          <MemberRow
            key={member.subject}
            orgId={props.orgId}
            member={member}
            canManage={canManage}
            onRole={async role => { await setRole(props.orgId, member.subject, role); await load(); }}
            onRemove={async () => { await removeMember(props.orgId, member.subject); await load(); }}
          />
        ))}
      </div>
      {canManage ? (
        <form onSubmit={(event) => void submitInvite(event)} style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            className="fl-input"
            aria-label={`Invite member to ${props.name}`}
            placeholder="user subject (e.g. user_ada)"
            value={invite}
            onChange={event => setInvite(event.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <label>
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Invite role</span>
            <select className="fl-btn" value={inviteRole} onChange={event => setInviteRole(event.target.value as OrgRole)}>
              {ROLES.filter(role => role !== "owner" || props.role === "owner").map(role => (
                <option key={role} value={role}>{roleLabel(role)}</option>
              ))}
            </select>
          </label>
          <button className="fl-btn fl-btn-primary" type="submit">Invite</button>
        </form>
      ) : null}
    </article>
  );
}

/** block-actions design §C / 08-ui §4 — minimal org management chrome:
 * create, invite, roles. Key-gated: without an entitled VENDO_API_KEY the
 * wire posture-errors and this panel renders the honest upgrade state. */
export function OrgsPanel() {
  const { orgs, gated, create } = useOrgs();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0) return;
    setError(undefined);
    try {
      await create(name.trim());
      setName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <ChromeRoot>
      <section aria-labelledby="vendo-orgs-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-orgs-heading" className="fl-auto-title" style={{ margin: 0 }}>Organizations</h2>
        {gated !== undefined ? (
          <p className="fl-auto-sub" role="status" data-testid="orgs-gated" style={{ margin: 0 }}>
            {gated}
          </p>
        ) : (
          <>
            {error ? <div role="alert" className="fl-error">{error}</div> : null}
            <form onSubmit={(event) => void submit(event)} style={{ display: "flex", gap: 8 }}>
              <input
                className="fl-input"
                aria-label="New organization name"
                placeholder="Organization name"
                value={name}
                onChange={event => setName(event.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button className="fl-btn fl-btn-primary" type="submit">Create org</button>
            </form>
            {orgs.length === 0 ? (
              <p className="fl-auto-sub" style={{ margin: 0 }}>
                No organizations yet. Create one to share apps and automations with your team —
                members run, admins approve and manage.
              </p>
            ) : null}
            {orgs.map(org => <OrgCard key={org.id} orgId={org.id} name={org.name} role={org.role} />)}
          </>
        )}
      </section>
    </ChromeRoot>
  );
}
