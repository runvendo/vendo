import { Inter, Spline_Sans_Mono } from "next/font/google";
import { cadenceFixture } from "../../../fixtures/cadence";
import { EmbedNote } from "../host-app";
import { ClientHostApp } from "../host-app-client";
import { embedDocument, type EmbedSearchParams } from "../embed-run";
import "./host.css";

export const dynamic = "force-dynamic";

// Cadence's own fonts (apps/demo-accounting/src/app/layout.tsx); see the
// wrapper note in ../maple/page.tsx.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono" });

/** GET /embed/cadence?run=<id>[&mode=readonly] — the Cadence host document the
 *  cockpit's Vendo pane frames. */
export default async function CadenceEmbedPage({
  searchParams,
}: {
  searchParams: Promise<EmbedSearchParams>;
}) {
  const { run, mode } = await searchParams;
  const document = embedDocument(run);
  return (
    <div
      className={`${inter.variable} ${splineMono.variable} font-sans antialiased`}
      style={{ padding: 16 }}
    >
      {document === null ? (
        <EmbedNote>No Vendo document for run {run ?? "(none)"}.</EmbedNote>
      ) : (
        <ClientHostApp host="cadence" theme={cadenceFixture.theme} document={document} readOnly={mode === "readonly"} />
      )}
    </div>
  );
}
