import { log } from "@vendoai/core";
import qrcode from "qrcode-generator";
import type { ChannelDoor, InboundEvent, TextChannelInvite } from "../channels.js";
import { timingSafeEqual } from "./misc.js";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The text channel's three surfaces: the link anchor a host drops in its own
    UI, the machine door Vendo Cloud delivers to, and the API-only
    status/unlink pair. */

/** Phone or not — the ONE thing the link route branches on. A phone opens the
    `sms:` deep link straight into its messages app; anything else gets the page
    with the number, the code and a QR to jump to a phone. */
function isPhone(userAgent: string | null): boolean {
  return userAgent !== null && /iPhone|iPod|iPad|Android|Mobile/i.test(userAgent);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The desktop fallback. The copy is load-bearing, not decoration: on the org's
    DEDICATED router linking is ONE text, because the router keeps the connect
    message in its own transcript and Cloud reads the code off it — so the person
    sends the prefilled message and is done. Telling them to retype a code here
    would be telling them to do work the router already did. */
function linkPage(invite: TextChannelInvite): string {
  const qr = qrcode(0, "M");
  qr.addData(invite.url);
  qr.make();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Text your assistant</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 30rem; padding: 2rem 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  ol { padding-left: 1.15rem; margin: 0 0 1.5rem; }
  li { margin-bottom: 0.75rem; }
  code { font: 500 1rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 0.15em 0.35em; border-radius: 0.3em; background: rgba(127,127,127,0.18); }
  .code { display: inline-block; font-size: 1.6rem; letter-spacing: 0.18em; padding: 0.4rem 0.7rem; }
  /* A QR is a contrast contract, not decoration: pin the plate white and the
     modules black so dark mode does not hand a phone an inverted code. */
  svg { width: 10rem; height: 10rem; border-radius: 0.4rem; }
  svg rect { fill: #fff; }
  svg path { fill: #000; }
  p { margin: 0 0 0.75rem; opacity: 0.8; }
</style>
</head>
<body><main>
<h1>Text your assistant</h1>
<ol>
<li>From your phone, text <code>${escapeHtml(invite.command)}</code> to <code>${escapeHtml(invite.number)}</code>.</li>
<li>That's it. A contact card comes back — save it, and text that contact from now on.</li>
</ol>
<p>One message links your account. The code is already in it, so send it as it is
rather than retyping anything.</p>
${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}
<p>Scan to open it on your phone. The code expires in 30 minutes.</p>
</main></body>
</html>`;
}

/** The ACK-then-run leg: a delivery is answered 202 and the turn takes as long
    as it takes. A failure is the operator's to see — the person texting already
    got their ack from the vendor, and a 500 here would only earn a retry that
    runs the same turn again. */
function runInboundDetached(door: ChannelDoor, event: InboundEvent): void {
  void door.inbound(event).catch((error: unknown) => {
    log({
      code: "vendo.channel-turn-failed",
      level: "error",
      message: `[vendo] inbound text ${event.eventId} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
}

export const channelRoutes: RouteEntry[] = [
  // BEFORE /channels/text: this is the surface a person opens, and the grouped
  // arm below would otherwise never see it fall through.
  route("GET", "/channels/text/link", async ({ request, deps, context }) => {
    const ctx = await context("chat");
    const invite = await deps.channels.invite(ctx.principal);
    if (isPhone(request.headers.get("user-agent"))) {
      return new Response(null, { status: 302, headers: { location: invite.url } });
    }
    return new Response(linkPage(invite), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }),

  // The machine door. Bearer-authenticated against the derived inbound secret,
  // never a principal: the caller is Vendo Cloud, and WHO the text is from is
  // the link binding's answer, not the session's. ACK first — the turn runs
  // detached, because a text conversation takes as long as it takes and the
  // delivery must not wait on it (nor be retried because it did).
  route("POST", "/channels/text/inbound", async ({ request, deps }) => {
    const secret = await deps.channelInboundSecret();
    const presented = request.headers.get("authorization") ?? "";
    if (secret === undefined || !await timingSafeEqual(presented, `Bearer ${secret}`)) {
      return json({ error: { code: "blocked", message: "invalid channel credential" } }, 401);
    }
    const body = await requestJson(request);
    // Two shapes on one door. `kind: "link"` carries the connect tail Cloud read
    // off the router transcript and has no text and no conversation of its own;
    // anything else is a message. Dispatching on the field rather than on a
    // second route keeps the frozen contract one URL and one bearer.
    if (body["kind"] === "link") {
      // AWAITED, unlike a turn. Cloud relays the link and then the person's first
      // text, and it waits for this response in between — so answering 202 before
      // the binding is persisted is what makes the two race. The text would find
      // no link, be served as a stranger's, and vanish: the exact message the
      // one-text flow exists to answer. A claim is a handful of store writes with
      // no model in the path, so it is cheap enough to hold the delivery open for,
      // and a failure answers 503 so the queue redelivers instead of dropping it.
      try {
        await deps.channels.inbound({
          eventId: string(body["eventId"], "eventId"),
          channel: "text",
          kind: "link",
          from: string(body["from"], "from"),
          code: string(body["code"], "code"),
          receivedAt: string(body["receivedAt"], "receivedAt"),
        });
      } catch (error) {
        log({
          code: "vendo.channel-link-failed",
          level: "error",
          message: `[vendo] inbound link failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return json({ error: { code: "unavailable", message: "could not claim the link" } }, 503);
      }
      return json({ ok: true }, 202);
    }
    runInboundDetached(deps.channels, {
      eventId: string(body["eventId"], "eventId"),
      channel: "text",
      from: string(body["from"], "from"),
      text: string(body["text"], "text"),
      conversationId: string(body["conversationId"], "conversationId"),
      receivedAt: string(body["receivedAt"], "receivedAt"),
    });
    return json({ ok: true }, 202);
  }),

  // Grouped like the /connections/:id arm: any method resolves context first,
  // and an unhandled one falls through to the table's not-found.
  route("*", "/channels/text", async ({ request, deps, context }) => {
    const ctx = await context("chat");
    if (request.method === "GET") return json(await deps.channels.status(ctx.principal));
    if (request.method === "DELETE") {
      await deps.channels.unlink(ctx.principal);
      return json({});
    }
    return undefined;
  }),
];
