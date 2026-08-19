// @vitest-environment jsdom
/**
 * What the composer does with an attachment now that a file has somewhere to
 * live.
 *
 * A non-image is SAVED first and the turn carries only the reference, so the
 * transcript never holds its bytes and the file outlives the conversation. An
 * image is untouched — it still rides the message inline, because that is how
 * the model sees a picture at all.
 *
 * Driven through the real wire server, so the client's own request is what the
 * assertions read.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("the composer saves a file and sends the reference", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  const dialog = () => screen.getByRole("dialog", { name: "Vendo assistant" });
  const uploads = () => wire.requests.filter(r => r.method === "POST" && r.path.startsWith("/files"));
  const turns = () => wire.requests.filter(r => r.method === "POST" && r.path === "/threads");

  /** Attach one file, type, send. */
  async function send(file: File, text: string): Promise<void> {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const input = dialog().querySelector("input[type=file]") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await within(dialog()).findByText(file.name);
    const composer = within(dialog()).getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(turns()).toHaveLength(1));
  }

  const partsOf = (turn: { body: unknown }): Array<Record<string, string>> =>
    (turn.body as { message: { parts: Array<Record<string, string>> } }).message.parts;

  it("uploads a spreadsheet and puts its path on the turn, not its bytes", async () => {
    await send(new File(["month,revenue\njan,31000\n"], "sales 2026.csv", { type: "text/csv" }), "make me a dashboard");

    // The file went through the drop door first, under its own media type and
    // with its name percent-encoded onto the query.
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]!.path).toBe("/files?name=sales%202026.csv");
    expect(uploads()[0]!.headers["content-type"]).toBe("text/csv");

    const file = partsOf(turns()[0]!).find(part => part.type === "file")!;
    expect(file).toMatchObject({ filename: "sales 2026.csv", url: "/user/files/sales 2026.csv" });
    // The whole point: no base64 copy of the spreadsheet in the transcript.
    expect(JSON.stringify(turns()[0]!.body)).not.toContain("base64");
  });

  it("leaves an image alone — it rides the turn inline", async () => {
    await send(new File(["PNG"], "chart.png", { type: "image/png" }), "what is this");

    expect(uploads()).toHaveLength(0);
    const file = partsOf(turns()[0]!).find(part => part.type === "file")!;
    expect(file.filename).toBe("chart.png");
    expect(file.url?.startsWith("data:image/png;base64,")).toBe(true);
  });
});
