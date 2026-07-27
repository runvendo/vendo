knowledge-k11 — live proof transcript (2026-07-27)
==================================================

The claim under test: a host that sets VENDO_API_KEY and NOTHING else gets a
working Cloud knowledge base. The K9 whole-chain run had to hand-wire
cloudKnowledge() into Maple's composition seam to run at all (its README, D2);
that hand-wiring is what this lane deletes.

Stack (all local, throwaway, swept at the end — see SWEEP below)
---------------------------------------------------------------
- console: vendo-web @ origin/main e96964b, cloned to /tmp, `supabase start`
  + `supabase db reset` (all migrations incl. the 7 knowledge ones), dev
  server on :3001, engine = real Agentset (key from Infisical).
- project: seeded local project, storage_mode=byo → local BYO data plane
  (`k11_dataplane`), API key minted by SQL insert of the SHA-256 hash the
  console itself stores (setup only — not part of what is being proven).
- host: Maple (apps/demo-bank) from THIS worktree, production build,
  `pnpm start` on :3000. apps/demo-bank/.env.local carried exactly:
      ANTHROPIC_API_KEY, VENDO_API_KEY, VENDO_CLOUD_URL=http://localhost:3001,
      VENDO_BASE_URL=http://localhost:3000, MAPLE_STORE=local
  No cloudKnowledge() anywhere in the host. No knowledge slot passed.

1 — the mount answers the wire (bad key first)
----------------------------------------------
$ curl -s :3001/api/v1/knowledge/status -H "Authorization: Bearer vnd_0000…0000"
{"error":{"code":"unauthorized","message":"Valid API key required."}}      (401)

$ curl -s :3001/api/v1/knowledge/status -H "Authorization: Bearer $K"
{"format":"vendo/knowledge-wire@1","posture":{"fetch":true,"write":true,
 "visibility":"enforced"},"status":{"docs":0}}

2 — a corpus only Cloud has
---------------------------
Two documents pushed through the wire's own upsert route (the developer
door), deliberately containing facts that do NOT exist in Maple's built-in
in-memory corpus: travel-notice limits (60 consecutive days, filed up to 90
days ahead) and joint accounts.

$ curl -s -X POST :3001/api/v1/knowledge/upsert -H "Authorization: Bearer $K" …
{}                                                                    (200, 29s)
$ curl -s :3001/api/v1/knowledge/status -H "Authorization: Bearer $K"
{"format":"vendo/knowledge-wire@1","posture":{…},"status":{"docs":2,
 "byKind":{"docs":2},"lastSyncAt":"2026-07-27T04:10:18.809Z"}}

$ curl -s -X POST :3001/api/v1/knowledge/search -H "Authorization: Bearer $K" \
    -d '{"query":{"text":"how many consecutive days does a travel notice cover","intent":"chat"}}'
{"hits":[{"ref":{"docId":"maple-cloud#travel-notice.md",
 "chunkId":"cms2pl4jm00002185gpdp69zs#9e7d6a58-…","title":"Travel notices on a
 Maple card","source":"help/travel-notice.md"},"snippet":"# Travel notices …

3 — the seam, inside the running host
-------------------------------------
A temporary probe at the composition seam (removed before commit) printed on
Maple's first request:

    [k11-probe] knowledge composed: true configured: false key: true

configured:false = the host passed no knowledge adapter; composed:true = the
key rung built the Cloud engine. On main this line would have read
composed:false.

4 — the browser (evidence/k11-maple-cloud-knowledge-answer.png)
---------------------------------------------------------------
Signed in at localhost:3000 as yousef@maple.com, ⌘K, asked:

    "How many consecutive days does a travel notice cover on a Maple card,
     and how far ahead can I file one?"

Maple answered:

    "A travel notice covers a maximum of 60 consecutive days per trip, and you
     can file one up to 90 days before you leave. No foreign transaction fees
     apply on debit purchases during the notice period."
    SOURCES  [Travel notices on a Maple card] [Opening a joint account]

Both numbers and both citation chips come from the Cloud corpus; neither fact
is in Maple's local corpus. The console log recorded the matching
`POST /api/v1/knowledge/search 200` for the turn.

Control run (same question, before the packages were rebuilt with the fix, so
the host ran the old pass-through seam): "Maple doesn't currently expose a
travel notice feature through any available tool… I don't have a product
knowledge base tool available to search." That is the defect, reproduced in
the product.

5 — engine failure is loud (evidence/k11-maple-engine-unavailable.png)
----------------------------------------------------------------------
The console was stopped and Maple restarted against the now-dead mount. Same
question:

  UI:  amber status line — "I couldn't check the docs just now — the knowledge
       base is temporarily unreachable, so this answer isn't verified against
       the documentation." The agent did NOT report an empty corpus.
  log: [vendo] knowledge engine failed — vendo_knowledge_search answers
       "unavailable" until this is fixed: cloud-required: Vendo Cloud
       knowledge is unreachable at http://localhost:3001: fetch failed

The 401/rejected-key variant of the same path is pinned in
packages/vendo/src/knowledge-resolution.test.ts (a live 401 rerun would have
cost another console boot for the same assertion).

SWEEP (mandatory — every live resource this run created)
---------------------------------------------------------
Agentset namespace ns_cms2pl0ew000004jnrn17w1u7 (the only external resource):

    attempt 1 -> 422   (the vendor's documented settling 422)
    …
    attempt 7 -> 404

    $ curl -s "https://api.agentset.ai/v1/namespace?perPage=100" -H "Authorization: Bearer $AGENTSET"
    namespaces returned: 0
    k11 namespace present: False

Local: knowledge_sources / knowledge_namespaces / knowledge_gaps / api_keys
all deleted (verified "0 keys, 0 namespaces"), DATABASE k11_dataplane dropped,
`supabase stop --no-backup` (docker ps → 0 containers), the /tmp console clone
deleted, apps/demo-bank/.env.local deleted, both dev servers killed
(nothing listening on :3000 or :3001).

Notes for whoever runs the runbook next (not this lane's defects)
------------------------------------------------------------------
- `supabase start` rolls back on this machine unless the analytics containers
  are excluded: `supabase start -x vector,logflare,supavisor,imgproxy,edge-runtime`.
- A project left in hosted storage_mode tries to provision Neon and 503s
  locally; the runbook's BYO step is not optional. Switching an ALREADY
  provisioned project to byo also needs its `hosted_instances` row deleted —
  the pointer is what the data-plane resolver reads, not projects.storage_mode.
- In hosted mode the console's knowledge data-plane table `vendo_knowledge_docs`
  collides by name with the OSS store's generic collection table of the same
  name in the tenant schema (`column "kind" does not exist`). BYO mode uses a
  separate `vendo` schema and does not hit it. Worth a vendo-web ticket.
