/**
 * Lane E proof: the display hint reaching the client, through the REAL render
 * seam (no test doubles of the seam itself — only a memory workspace standing in
 * for the store, exactly what the runtime hands it).
 *
 *   pnpm --filter @vendoai/harnesses build   # dist is what this imports
 *   node docs/superpowers/evidence/2026-08-03-ui-redesign/lane-e/proof-seam.mjs
 *
 * Prints the `data-vendo-view` part the wire would carry for the same plan
 * written three ways: display="stage", display="inline", and no display at all.
 * That part shape IS the contract lane C's ThreadAppCard reads
 * (payload.display === "stage" | "inline" | undefined).
 */
// The built package, by path: this file lives outside every workspace package,
// so a bare specifier has nothing to resolve against.
import { viewForWrite } from "../../../../../packages/harnesses/dist/index.js";
import { toVendoWirePart, vendoViewWirePartSchema } from "../../../../../packages/core/dist/index.js";

const PLAN = (head) => `<${head}>
  <Query id="accounts" tool="maple_accounts_list" input={{ limit: 20 }}/>
  <Group tab="Overview" title="Where the money is" layout="grid">
    <Leaf component="Stat" query="accounts" purpose="Total across every account" col="1"/>
    <Leaf component="BarChart" query="accounts" purpose="Balance per account" col="2"/>
  </Group>
  <Group tab="Spending">
    <Leaf component="DataTable" query="accounts" purpose="Every transaction this month, newest first"/>
  </Group>
</Plan>`;

const heads = [
  'Plan name="Money HQ" display="stage"',
  'Plan name="Money HQ" display="inline"',
  'Plan name="Money HQ"',
];

for (const head of heads) {
  const view = await viewForWrite("/user/apps/app_moneyhq/plan.vendo", PLAN(head), {
    emit: () => undefined,
  });
  const payload = view?.part.payload ?? {};
  console.log(`<${head}>`);
  console.log(`  streamId          ${view?.streamId}`);
  console.log(`  part.type         ${view?.part.type}`);
  console.log(`  part.appId        ${view?.part.appId}`);
  console.log(`  payload.display   ${JSON.stringify(payload.display)}${"display" in payload ? "" : "   (key absent)"}`);
  console.log(`  payload keys      ${Object.keys(payload).join(", ")}`);
  console.log(`  skeleton nodes    ${payload.nodes?.length} (tabs: ${payload.nodes?.find((n) => n.id === "tabs")?.props?.tabs?.map((t) => t.label).join(" / ")})`);
  console.log("");
}

// The hop the client actually makes: the flat part is nested into its ai-SDK
// wire envelope and parsed on the way in. A schema that dropped unknown payload
// fields would swallow the hint before lane C's card ever saw it.
const staged = await viewForWrite("/user/apps/app_moneyhq/plan.vendo", PLAN(heads[0]), { emit: () => undefined });
const wire = toVendoWirePart(staged.part, staged.streamId);
const reparsed = vendoViewWirePartSchema.safeParse(wire);
console.log(`wire envelope     data.payload.display = ${JSON.stringify(reparsed.data?.data.payload.display)} (schema parse ok: ${reparsed.success})`);
console.log("");

// The law that must survive the new field: a plan that does not parse emits
// NOTHING, so the last good view stays on screen.
const broken = await viewForWrite("/user/apps/app_moneyhq/plan.vendo", "there is no plan document here", {
  emit: () => undefined,
});
console.log(`unparseable plan → ${broken === undefined ? "no part emitted (law holds)" : "EMITTED SOMETHING — law broken"}`);
