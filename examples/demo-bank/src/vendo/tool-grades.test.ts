import { promises as fs } from "node:fs"
import path from "node:path"
import {
  applyJudgment,
  bindingIdentity,
  judgmentsFileSchema,
  overridesFileSchema,
  pruneJudgments,
  toolsFileSchema,
} from "@vendoai/actions"
import { mergeOverrides } from "@vendoai/actions/sync"
import { describe, expect, it } from "vitest"

/**
 * Maple's committed grades have to still apply, because on this demo nothing
 * else can supply them: `predev` runs `vendo sync . --no-ai`, which cannot grade
 * without a model key, so `.vendo/judgments.json` is the ONLY grade source on
 * the keyless BYO path this repo documents.
 *
 * Live 2026-08-08 (#1056): every generated view rendered empty, in the thread
 * and pinned to the home hero, because all 22 grades had gone inert. Maple moved
 * its `/maple` prefix out of the OpenAPI paths into the spec's `servers` url, so
 * `tools.json` regenerated as `GET /api/goals` while the judgments still said
 * `GET /maple/api/goals`. `applyJudgment` holds a judgment inert when its
 * recorded binding no longer matches the tool's — correct, so a handler that
 * moved never inherits someone else's grade, and silent. The tools fell back to
 * `ungraded`, which the guard withholds exactly like `destructive`, so plain
 * reads parked as `pending-approval` and everything bound to them rendered
 * empty. `vendo doctor` said "19/22 tools ungraded" and still exited 0.
 *
 * Both checks run the REAL functions — `pruneJudgments`, and `applyJudgment` then
 * `mergeOverrides` (the composition the runtime's `effectiveHostTool` performs).
 * A test that reimplemented the binding comparison could only ever agree with
 * itself.
 */

const vendoDir = path.join(process.cwd(), ".vendo")

const readVendoFile = async (file: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(path.join(vendoDir, file), "utf8")) as unknown

const readLayers = async () => ({
  tools: toolsFileSchema.parse(await readVendoFile("tools.json")).tools,
  judgments: judgmentsFileSchema.parse(await readVendoFile("judgments.json")),
  overrides: overridesFileSchema.parse(await readVendoFile("overrides.json")),
})

describe("Maple's committed grades still reach its tools", () => {
  /** The #1056 defect itself. Asserted on the judgment layer ALONE, because
   *  `overrides.json` is keyed by tool NAME and so never drifted — the three
   *  tools carrying a `risk` there were exactly the three that still looked
   *  graded while the other 19 were stranded, which is how this stayed hidden. */
  it("strands no standing judgment on a binding that moved", async () => {
    const { tools, judgments } = await readLayers()
    const live = pruneJudgments(judgments, tools).tools
    const identityByName = new Map(tools.map(tool => [tool.name, bindingIdentity(tool.binding)]))
    const stranded = Object.entries(judgments.tools)
      .filter(([name]) => live[name] === undefined)
      .map(([name, judgment]) =>
        `${name}: graded against "${judgment.binding}", tool is now "${identityByName.get(name) ?? "absent from the catalog"}"`)
    expect(stranded).toEqual([])
  })

  it("leaves no tool ungraded, so a read runs instead of asking", async () => {
    const { tools, judgments, overrides } = await readLayers()
    const judged = tools.map(tool => applyJudgment({ ...tool }, judgments.tools[tool.name]))
    const ungraded = mergeOverrides(judged, overrides)
      .filter(tool => tool.risk === "ungraded")
      .map(tool => tool.name)
    expect(ungraded).toEqual([])
  })
})
