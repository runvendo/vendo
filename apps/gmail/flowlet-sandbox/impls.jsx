/**
 * React adapters binding the clone's REAL components to their registered
 * descriptors (ENG-184 3-file path, step 2). Compiled into the sandbox bundle
 * only — never imported by the CRA app itself.
 *
 * Sandbox constraints honored here: the app's gstatic <img> icons can't load
 * (egress-jailed CSP), so the star and the multicolor plus are inline SVG; the
 * styled-components styles ship inside the bundle (CSS-in-JS ports as-is).
 */
import React from "react";
import { bindHostImpl } from "@flowlet/components";
import {
  MessageTemplateContainer,
  Star,
  MessageBody,
  MessageBodyFirst,
  MessageTitle,
  MessageName,
  MessageContent,
  Dash,
  Date as RowDate,
} from "../src/components/message-template/message-template.styles";
import { ComposeButton } from "../src/components/sidebar/sidebar.styles";
import { emailRowDescriptor, composeChipDescriptor } from "../src/flowlet/host-components";

const StarSvg = ({ filled }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
    fill={filled ? "#f4b400" : "none"} stroke={filled ? "#f4b400" : "#5f6368"} strokeWidth="1.6">
    <path d="M12 3.5l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.9l6.1-.8z" />
  </svg>
);

const GmailEmailRow = bindHostImpl(emailRowDescriptor, (p) => (
  <MessageTemplateContainer style={{ background: p.unread ? "#ffffff" : "#f6f7f8" }}>
    <Star className="star" style={{ display: "flex", alignItems: "center" }}>
      <StarSvg filled={p.starred === true} />
    </Star>
    <MessageName style={p.unread ? { fontWeight: 700 } : undefined}>{p.sender}</MessageName>
    <MessageBody>
      <MessageBodyFirst>
        <MessageTitle style={p.unread ? { fontWeight: 700 } : undefined}>{p.subject}</MessageTitle>
        {p.snippet ? <Dash>-</Dash> : null}
        {p.snippet ? <MessageContent>{p.snippet}</MessageContent> : null}
      </MessageBodyFirst>
      {p.date ? <RowDate className="date">{p.date}</RowDate> : null}
    </MessageBody>
  </MessageTemplateContainer>
));

const PlusSvg = () => (
  <svg width="22" height="22" viewBox="0 0 36 36" aria-hidden="true">
    <path fill="#4285f4" d="M16 16v14h4V20z" />
    <path fill="#34a853" d="M30 16H20l-4 4h14z" />
    <path fill="#fbbc05" d="M6 16v4h10l4-4z" />
    <path fill="#ea4335" d="M20 16V6h-4v14z" />
    <path fill="none" d="M0 0h36v36H0z" />
  </svg>
);

const GmailComposeChip = bindHostImpl(composeChipDescriptor, (p) => (
  <ComposeButton as="button" type="button" style={{ gap: 10, justifyContent: "flex-start" }}>
    <PlusSvg />
    <div>{p.label ?? "Compose"}</div>
  </ComposeButton>
));

export const gmailHostImpls = {
  GmailEmailRow,
  GmailComposeChip,
};
