/**
 * Prompt assembly's two independent waits, and the bytes they must not change.
 *
 * `guard.directions()` and the knowledge resolver answer different questions of
 * different backends; the assembler used to await them one after the other, so a
 * turn paid the sum. They run together now — and because the section ORDER is
 * fixed by the `sections.push` sequence rather than by which promise settled
 * first, the assembled string is the byte-for-byte one it always was. The second
 * test is the guardrail for that: it pins the whole prompt, not a substring, so a
 * reordering shows up as a diff rather than as a passing test.
 */
import type { Guard, RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../src/prompt.js";

const ctx = (): RunContext => ({
  principal: { kind: "user", subject: "user_prompt_parallel" },
  venue: "chat",
}) as RunContext;

const guardWith = (directions: () => Promise<string[]>): Guard =>
  ({ directions }) as unknown as Guard;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("assembleSystemPrompt", () => {
  it("waits for the guard's directions and the knowledge index AT THE SAME TIME", async () => {
    // Each side is slow enough that a sequential assembler could not finish
    // under the sum, and the assertion is against the SUM rather than a fixed
    // number — a busy machine slows both waits equally, so the margin holds
    // without a wall-clock budget of its own.
    const delayMs = 150;
    const guard = guardWith(async () => {
      await sleep(delayMs);
      return ["Never move money without asking."];
    });
    const knowledge = async (): Promise<string> => {
      await sleep(delayMs);
      return "Knowledge\nThe host has a product knowledge base of 3 documents.";
    };

    const startedAt = Date.now();
    const prompt = await assembleSystemPrompt(guard, ctx(), { knowledge });
    const elapsed = Date.now() - startedAt;

    // Both waits are in the prompt, so neither was skipped to win the race.
    expect(prompt).toContain("Never move money without asking.");
    expect(prompt).toContain("The host has a product knowledge base of 3 documents.");
    expect(elapsed).toBeLessThan(delayMs * 2);
  });

  it("assembles the SAME BYTES as the sequential assembler, with every section present", async () => {
    // The sequential reference: the two independent reads resolved by hand, in
    // the order the old assembler awaited them, then handed to the assembler as
    // already-settled values. If parallelising ever moved a section, or let a
    // resolver's settle order pick the order, this diverges.
    const directions = ["Never move money without asking.", "Escalate refunds over $500."];
    const knowledgeText = "Knowledge\nThe host has a product knowledge base of 3 documents.";
    const sequential = await assembleSystemPrompt(
      guardWith(async () => directions),
      ctx(),
      {
        product: "Maple is a bank.",
        theme: "Theme\nMaple is green.",
        knowledge: knowledgeText,
        instructions: "Host instructions\nBe brief.",
      },
      true,
      "find-tools",
    );

    // The same inputs, but every one of them slow and resolving out of order:
    // knowledge settles FIRST here and the directions last, the reverse of the
    // await order the sections are pushed in.
    const parallel = await assembleSystemPrompt(
      guardWith(async () => {
        await sleep(80);
        return directions;
      }),
      ctx(),
      {
        product: "Maple is a bank.",
        theme: "Theme\nMaple is green.",
        knowledge: async () => {
          await sleep(10);
          return knowledgeText;
        },
        instructions: "Host instructions\nBe brief.",
      },
      true,
      "find-tools",
    );

    expect(parallel).toBe(sequential);
    // The order the guardrail actually protects, stated so a failure names the
    // section that moved.
    const order = ["You are Vendo's agent.", "How you work", "Presentation",
      "When the user's ask cannot be fulfilled:", "Discovery budget", "Product",
      "Directions", "Theme", "Knowledge", "Host instructions"];
    expect(order.map((section) => parallel.indexOf(section)))
      .toEqual([...order.map((section) => parallel.indexOf(section))].sort((a, b) => a - b));
    expect(order.every((section) => parallel.includes(section))).toBe(true);
  });
});
