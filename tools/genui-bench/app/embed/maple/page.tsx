import { Inter } from "next/font/google";
import { mapleFixture } from "../../../fixtures/maple";
import { EmbedNote } from "../host-app";
import { ClientHostApp } from "../host-app-client";
import { embedDocument, type EmbedSearchParams } from "../embed-run";
import "./host.css";

export const dynamic = "force-dynamic";

// Maple's own font (examples/demo-bank/src/app/layout.tsx). The root layout is
// shared with the cockpit, so the variable lands on the wrapper instead of
// <html>; `font-sans` (= var(--font-sans) = var(--font-inter)) then resolves
// for the whole subtree, exactly as it does on Maple's own pages.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

/** GET /embed/maple?run=<id>[&mode=readonly] — the Maple host document the
 *  cockpit's Vendo pane frames. */
export default async function MapleEmbedPage({
  searchParams,
}: {
  searchParams: Promise<EmbedSearchParams>;
}) {
  const { run, mode } = await searchParams;
  const document = embedDocument(run);
  return (
    <div className={`${inter.variable} font-sans antialiased`} style={{ padding: 16 }}>
      {document === null ? (
        <EmbedNote>No Vendo document for run {run ?? "(none)"}.</EmbedNote>
      ) : (
        <ClientHostApp host="maple" theme={mapleFixture.theme} document={document} readOnly={mode === "readonly"} />
      )}
    </div>
  );
}
