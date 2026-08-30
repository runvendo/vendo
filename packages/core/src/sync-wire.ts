/**
 * The sync wire's one shape: what changing a tool would touch.
 *
 * `GET /sync/impact` computes it against a live deployment's store
 * (@vendoai/vendo's sync-impact.ts) and `vendo sync` reads it back off the
 * response (the CLI's sync-flow.ts). Producer and consumer are in
 * different packages, so the shape lives here — the one place both may speak.
 */
export interface ToolImpact {
  tool: string;
  apps: { id: string; title: string }[];
  automations: { id: string; title: string }[];
  grants: number;
}
