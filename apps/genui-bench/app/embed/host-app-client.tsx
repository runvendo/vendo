"use client";
import dynamic from "next/dynamic";

/**
 * Generated apps mount CLIENT-SIDE ONLY, the way a host embed mounts one
 * (never during SSR). Server-rendering them hydration-mismatches by
 * construction: the island jail stamps a fresh per-mount nonce into its iframe
 * srcDoc, so the server's HTML can never equal the client's.
 */
export const ClientHostApp = dynamic(() => import("./host-app").then((m) => m.HostApp), {
  ssr: false,
});
