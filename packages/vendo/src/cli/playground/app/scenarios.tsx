/**
 * The scenario registry: each entry is one linkable URL (`#<id>`) mounting a
 * REAL chrome surface against scripted data. The nav renders from this list;
 * the harness (main.tsx) supplies the provider, fake client, scripted
 * transport, and the auto-sent opening turn.
 */
import type { DirectorScript } from "@vendoai/ui";
import { VendoActivities, VendoOverlay, VendoPage, VendoSlot, VendoThread } from "@vendoai/ui/chrome";
import { useMemo, type ReactElement } from "react";
import {
  approvalScript,
  brokenViewPayload,
  connectScript,
  emptyActivitiesFixtures,
  renewalsViewPayload,
  streamingScript,
  viewScript,
  type PlaygroundFixtures,
} from "./fixtures.js";

export interface PlaygroundScenario {
  id: string;
  group: "Overlay" | "Thread" | "Approvals" | "Activities" | "Slot" | "Page" | "Mobile";
  title: string;
  description: string;
  /** Scripted turns this scenario's sends play (ScriptedTransport). */
  script?: DirectorScript;
  /** ScriptedTransport pacing multiplier (1 = authored pacing). */
  speed?: number;
  /** The opening user turn the harness auto-sends into the composer. */
  autoSend?: string;
  /** Wire fixture override; defaults to the shared populated set. */
  fixtures?: () => PlaygroundFixtures;
  render(): ReactElement;
}

/** Stand-in for the host's own markup: the slot's fallback/exit frame. */
function HostOriginalCard() {
  return (
    <div
      style={{
        border: "1px solid #e3e0da",
        borderRadius: 12,
        padding: "18px 20px",
        background: "#fffdf9",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 650, color: "#14151a", marginBottom: 6 }}>Quarterly summary</div>
      <div style={{ fontSize: 12.5, color: "#6b6c72", lineHeight: 1.5 }}>
        This is the host product’s original component. When a generated view cannot render,
        Vendo falls back to exactly this markup — the host surface is never sacrificed.
      </div>
    </div>
  );
}

/** The phone-viewport iframe. Its src is fixed at mount (carrying the theme
 * the page loaded with); later theme edits stream in over postMessage from the
 * harness, so slider scrubbing never reloads the frame. */
function PhoneEmbed() {
  const src = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("embed", "1");
    return `/?${params.toString()}#overlay-open`;
  }, []);
  return (
    <iframe
      title="Vendo playground — phone viewport"
      src={src}
      style={{ width: "100%", height: "100%", border: "none" }}
    />
  );
}

function ThreadPane() {
  return (
    <div style={{ height: "min(680px, 78vh)", display: "flex", flexDirection: "column" }}>
      <VendoThread
        greeting="What can I help you build?"
        suggestions={["Which renewals are at risk?", "Build me a renewals view", "Post the digest to #renewals"]}
      />
    </div>
  );
}

export const scenarios: PlaygroundScenario[] = [
  {
    id: "overlay-launcher",
    group: "Overlay",
    title: "Closed, with launcher",
    description: "The default drop-in: a brand-styled launcher pill in the corner. Click it — the overlay opens on a fresh conversation.",
    script: viewScript(),
    render: () => <VendoOverlay />,
  },
  {
    id: "overlay-open",
    group: "Overlay",
    title: "Open, mid-conversation",
    description: "The overlay mid-build: tool beats, then a generated view lands inline and the turn wraps up.",
    script: viewScript(),
    autoSend: "Build me a view of my upcoming renewals.",
    render: () => <VendoOverlay defaultOpen />,
  },
  {
    id: "overlay-streaming",
    group: "Overlay",
    title: "Streaming turn",
    description: "A long answer streaming into the overlay at authored pacing — the state you see while the agent is talking.",
    script: streamingScript(),
    autoSend: "Where do my renewals stand this month?",
    render: () => <VendoOverlay defaultOpen />,
  },
  {
    id: "thread-streaming",
    group: "Thread",
    title: "Streaming text",
    description: "The bare thread surface while a reply streams: tool chip, live text, stop affordance.",
    script: streamingScript(),
    autoSend: "Where do my renewals stand this month?",
    render: () => <ThreadPane />,
  },
  {
    id: "thread-view",
    group: "Thread",
    title: "Generated view arriving",
    description: "A build turn: the agent reads host data, then a vendo-genui view streams into the transcript and finishes.",
    script: viewScript(),
    autoSend: "Build me a view of my upcoming renewals.",
    render: () => <ThreadPane />,
  },
  {
    id: "thread-connect",
    group: "Thread",
    title: "Connect card",
    description: "A connector call that needs the user's own account first: the turn ends with an inline connect card (04-actions §3).",
    script: connectScript(),
    autoSend: "Post this week's renewals digest to #renewals.",
    render: () => <ThreadPane />,
  },
  {
    id: "approval-flow",
    group: "Approvals",
    title: "Pending → approved → resumed",
    description: "A write action parks the turn on an in-thread approval card. Approve it and the SAME turn resumes: the tool runs and the agent confirms.",
    script: approvalScript(),
    autoSend: "Give my team a heads-up about the at-risk renewals.",
    render: () => <ThreadPane />,
  },
  {
    id: "activities",
    group: "Activities",
    title: "Approvals queue + activity feed",
    description: "The shelf's VendoActivities piece: pending approvals as actionable cards on top, the humanized recent-activity feed below (ui-usage-dx §2).",
    render: () => <VendoActivities pollMs={0} />,
  },
  {
    id: "activities-empty",
    group: "Activities",
    title: "Empty state",
    description: "The same piece before the agent has done anything: a quiet one-liner instead of an invisible component — hosts place this in their own pages.",
    fixtures: emptyActivitiesFixtures,
    render: () => <VendoActivities pollMs={0} />,
  },
  {
    id: "slot-empty",
    group: "Slot",
    title: "Empty ghost",
    description: "A VendoSlot with nothing pinned: the ghost skeleton with a real “Design a view” CTA.",
    render: () => <VendoSlot id="playground-empty" />,
  },
  {
    id: "slot-filled",
    group: "Slot",
    title: "Filled with a pinned view",
    description: "The same slot holding a pinned generated view — the user's own “Renewals radar” mounted in the host page.",
    render: () => (
      <VendoSlot id="playground-filled" pin={{ payload: renewalsViewPayload() }}>
        <HostOriginalCard />
      </VendoSlot>
    ),
  },
  {
    id: "slot-broken",
    group: "Slot",
    title: "Broken view → host fallback",
    description: "A pinned view that cannot render. The error boundary keeps the host's original component visible — never a blank hole (06-apps §8).",
    render: () => (
      <VendoSlot id="playground-broken" pin={{ payload: brokenViewPayload() }}>
        <HostOriginalCard />
      </VendoSlot>
    ),
  },
  {
    id: "page",
    group: "Page",
    title: "Workspace console",
    description: "The full VendoPage: conversations with history, the waiting-on-you approval strip, apps, automations, accounts, and activity.",
    script: viewScript(),
    render: () => <VendoPage />,
  },
  {
    id: "mobile",
    group: "Mobile",
    title: "Phone viewport",
    description: "The overlay's Intercom-style full-bleed takeover at a phone viewport (390×760), embedded live below.",
    script: viewScript(),
    render: () => (
      <div style={{ display: "flex", justifyContent: "center", padding: "12px 0" }}>
        <div
          style={{
            width: 390,
            height: 760,
            border: "10px solid #14151a",
            borderRadius: 34,
            overflow: "hidden",
            boxShadow: "0 18px 50px rgba(20, 21, 26, 0.25)",
            background: "#fff",
          }}
        >
          <PhoneEmbed />
        </div>
      </div>
    ),
  },
];
