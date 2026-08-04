import { createStore } from "@vendoai/store";
const store = createStore({ dataDir: ".vendo/data" });
const row = await store.records("vendo_apps").get(process.argv[2]);
const doc = row.data.doc;
console.log("doc keys:", Object.keys(doc));
for (const k of Object.keys(doc)) {
  const v = doc[k];
  console.log(k, typeof v, Array.isArray(v) ? `len=${v.length}` : (typeof v === "object" && v ? Object.keys(v).slice(0,8) : String(v).slice(0,80)));
}
