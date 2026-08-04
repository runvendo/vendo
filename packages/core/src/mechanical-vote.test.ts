import { describe, expect, it } from "vitest";
import {
  ASK_USER_TOOL,
  mechanicalRisk,
  projectableForRun,
  resolvedRisk,
  vendoAuthored,
  type ToolDescriptor,
} from "./index.js";

const tool = (name: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  description: "a tool",
  inputSchema: { type: "object" },
  // The declared label is deliberately the LEAST destructive value on every
  // fixture here: the mechanical vote must reach its verdict without it.
  risk: "read",
  ...extra,
});

describe("the mechanical vote is genuinely independent of the AI label", () => {
  it("does not consult descriptor.risk at all", () => {
    // Same name, three different declared labels — one mechanical verdict.
    const verdicts = (["read", "write", "destructive"] as const).map((risk) =>
      mechanicalRisk(tool("maple_payments_send", { risk })));
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe("destructive");
  });

  it("reaches read on its own, without the label saying read", () => {
    expect(mechanicalRisk(tool("maple_invoices_list", { risk: "destructive" }))).toBe("read");
  });

  it("defaults an unrecognisable name to write, never to read", () => {
    // Fail-closed: an unknown verb is not evidence of safety.
    expect(mechanicalRisk(tool("maple_frobnicate_widget"))).toBe("write");
  });
});

describe("a question is not an action (design §4, §12 'reads are silent, always')", () => {
  // The verb-shape heuristic is calibrated for extracted host API names, which
  // are `noun_verb`. `ask_user` is Vendo's OWN hand-authored door and reads the
  // other way round: the trailing token is `user`, a noun, so the read
  // short-circuit misses it and the fail-closed default calls it a `write`.
  //
  // A `write` is a MUTATING call to everything downstream of `resolvedRisk`: the
  // guard writes it an effect-ledger row, which a re-run then answers from
  // instead of re-executing.
  //
  // What answers that is PROVENANCE, not the name: this label was hand-written in
  // this repo, so the vote has no second author to check (build contract §8,
  // clarification 2026-07-31). The vote itself stays honest — it is never told
  // about names we chose ourselves, which is why it is asserted here unchanged.
  it("still votes on the shape alone — the vote knows nothing about our own names", () => {
    expect(mechanicalRisk(tool(ASK_USER_TOOL))).toBe("write");
  });

  it("resolves read because the label is Vendo-authored, not because of the name", () => {
    expect(resolvedRisk(vendoAuthored(tool(ASK_USER_TOOL)))).toBe("read");
  });

  it("still projects the question door into an away run — a read is never withheld", () => {
    // Withholding is THE LAW's destructive filter. Asking is not destructive, so
    // the descriptor survives projection; `askUserRegistry` is what refuses to
    // ask a question nobody is there to answer.
    expect(projectableForRun([vendoAuthored(tool(ASK_USER_TOOL))], { venue: "automation", presence: "away" }))
      .toHaveLength(1);
  });
});

describe("provenance scopes the second vote (build contract §8, 2026-07-31)", () => {
  it("takes a Vendo-authored label as written, in BOTH directions", () => {
    // Not a downgrade valve: the declared label is authoritative, so a
    // hand-written `destructive` stays destructive on a read-shaped name too.
    expect(resolvedRisk(vendoAuthored(tool("validate")))).toBe("read");
    expect(resolvedRisk(vendoAuthored(tool("search_components")))).toBe("read");
    expect(resolvedRisk(vendoAuthored(tool("maple_invoices_list", { risk: "destructive" }))))
      .toBe("destructive");
  });

  it("leaves every AI-assigned label to the vote, fail-closed", () => {
    expect(resolvedRisk(tool("maple_account_delete"))).toBe("destructive");
    expect(resolvedRisk(tool("maple_frobnicate_widget"))).toBe("write");
    expect(resolvedRisk(tool("validate"))).toBe("write");
  });

  it("cannot be claimed by DATA: a JSON round trip loses the brand and fails closed", () => {
    // The whole reason provenance is a symbol. Anything that arrived as data —
    // `.vendo/tools.json`, a connector catalog, an override, the wire — cannot
    // carry one, and losing it costs a false positive, never a false negative.
    const branded = vendoAuthored(tool("validate"));
    expect(resolvedRisk(branded)).toBe("read");
    expect(resolvedRisk(JSON.parse(JSON.stringify(branded)) as ToolDescriptor)).toBe("write");
    expect(resolvedRisk(structuredClone(branded))).toBe("write");
  });

  it("cannot be claimed by a look-alike FIELD on a destructive tool", () => {
    const forged = {
      ...tool("maple_customer_delete_all"),
      "vendoai.tool.authored": true,
      authored: "vendo",
      vendoAuthored: true,
    } as unknown as ToolDescriptor;
    expect(resolvedRisk(forged)).toBe("destructive");
    expect(projectableForRun([forged], { venue: "automation", presence: "away" })).toEqual([]);
  });

  it("survives an honest copy — the guard re-labels a descriptor by spreading it", () => {
    const relabelled = { ...vendoAuthored(tool("validate")), risk: "read" as const };
    expect(resolvedRisk(relabelled)).toBe("read");
  });
});

describe("destructive verbs the old vocabulary missed (verifier findings 11/12)", () => {
  for (const name of [
    "maple_wire_initiate",
    "maple_invoice_void",
    "maple_subscription_terminate",
    "maple_table_truncate",
    "maple_courier_dispatch",
    "maple_user_ban",
    "maple_payout_submit",
    "maple_account_close",
    "maple_records_purge",
    "maple_key_revoke",
    "maple_funds_withdraw",
    "maple_charge_refund",
    "maple_data_erase",
    "maple_user_deactivate",
    "maple_order_cancel",
  ]) {
    it(`treats ${name} as destructive`, () => {
      expect(mechanicalRisk(tool(name))).toBe("destructive");
    });
  }

  it("withholds every one of them from an unattended run", () => {
    const tools = ["maple_wire_initiate", "maple_invoice_void", "maple_payout_submit"].map((n) => tool(n));
    expect(projectableForRun(tools, { venue: "automation", presence: "away" })).toEqual([]);
  });
});

describe("a destructive verb in the MIDDLE of a long name is still destructive (position-vote hole)", () => {
  // The end-position-only rule missed a destructive verb at position >=3 of a
  // 4+-token name with a non-verb tail. These all resolved "write" and were
  // projected into automations.
  for (const name of [
    "maple_customer_delete_all",
    "maple_money_transfer_out",
    "gmail_api_delete_thread",
    "maple_account_close_now",
    "maple_subscription_cancel_immediately",
    "maple_records_purge_all",
    // Destructive verb at index >=2 with a non-verb tail, and NOTHING
    // destructive in the old leading-two/trailing window — so this genuinely
    // fails under the pre-fix rule (verifier caught the earlier fixture,
    // maple_payout_submit_now, passing under both fixed and reverted code
    // because `payout` sat at index 1, inside the old window).
    "maple_vendor_payout_now",
  ]) {
    it(`treats ${name} as destructive`, () => {
      expect(mechanicalRisk(tool(name))).toBe("destructive");
    });
  }

  it("withholds a mid-name destructive verb from an unattended run", () => {
    const tools = ["maple_customer_delete_all", "maple_money_transfer_out"].map((n) => tool(n));
    expect(projectableForRun(tools, { venue: "automation", presence: "away" })).toEqual([]);
  });
});

describe("mail-forward and money-move are real external shapes", () => {
  it("treats forward as destructive-external", () => {
    expect(mechanicalRisk(tool("maple_mail_forward"))).toBe("destructive");
    expect(mechanicalRisk(tool("gmail_message_forward"))).toBe("destructive");
  });

  it("treats move as destructive", () => {
    expect(mechanicalRisk(tool("maple_money_move"))).toBe("destructive");
    expect(mechanicalRisk(tool("maple_funds_move_out"))).toBe("destructive");
  });
});

describe("destructive NOUNS must not withhold a read (verifier finding 12)", () => {
  // The old vote matched any token anywhere, so a noun like "message" or
  // "payment" made an obvious read look destructive. Over-withholding is not a
  // safe default here: it silently breaks automations that only ever read.
  for (const name of [
    "gmail_message_get",
    "gmail_messages_list",
    "maple_payment_get",
    "maple_transfers_list",
    "maple_invite_show",
    "maple_email_search",
    "maple_archive_query",
  ]) {
    it(`treats ${name} as a read`, () => {
      expect(mechanicalRisk(tool(name))).toBe("read");
    });
  }

  it("still projects those reads into an unattended run", () => {
    const reads = ["gmail_message_get", "maple_payment_get"].map((n) => tool(n));
    expect(projectableForRun(reads, { venue: "automation", presence: "away" })).toHaveLength(2);
  });
});

describe("the HTTP method is the axis the name cannot fake", () => {
  // `bindingRisk` is that axis, distilled: `"destructive"` is what the actions
  // registry derives from a DELETE, `"write"` from any other mutating shape
  // (POST/PUT/PATCH, a tRPC or GraphQL mutation, a server action), and absent
  // from a read shape. There is no value meaning "read", so the axis can only
  // ever escalate.
  //
  // These are the UNIT assertions. The axis was dead in production until
  // 2026-07-31 while this block passed — the vote read a raw `method` field that
  // `descriptorOf`'s whitelist dropped, so no host tool ever carried one and only
  // a hand-built fixture like this could see it. The real-path proof therefore
  // lives at the composed path, over actual route bindings, in
  // `packages/vendo/src/law-binding-method.e2e.test.ts`; this block must never
  // again be the only place the method axis is exercised.
  it("reads DELETE as destructive whatever the name says", () => {
    expect(mechanicalRisk(tool("maple_thing_update", { bindingRisk: "destructive" })))
      .toBe("destructive");
  });

  it("does not let a read binding downgrade a destructive verb", () => {
    // A destructive action exposed over GET is still destructive — and a GET
    // carries no `bindingRisk` at all, which is what makes downgrading
    // unexpressible rather than merely unimplemented.
    expect(mechanicalRisk(tool("maple_account_delete"))).toBe("destructive");
  });

  it("treats a write method with a read-shaped name as a write, not a read", () => {
    expect(mechanicalRisk(tool("maple_report_get", { bindingRisk: "write" })))
      .toBe("write");
  });
});

describe("resolvedRisk escalates, never downgrades", () => {
  it("takes the AI label when it is the riskier of the two", () => {
    expect(resolvedRisk(tool("maple_invoices_list", { risk: "destructive" }))).toBe("destructive");
  });

  it("takes the mechanical verdict when the label understates it", () => {
    expect(resolvedRisk(tool("maple_payments_send", { risk: "write" }))).toBe("destructive");
  });

  it("agrees when both agree", () => {
    expect(resolvedRisk(tool("maple_invoices_list", { risk: "read" }))).toBe("read");
  });
});
