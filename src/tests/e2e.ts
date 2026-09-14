/**
 * REAL end-to-end test against a live, logged-in Gemini session.
 *
 * Requires `npm run open-chrome` to be running with you signed in. Unlike
 * the other suites this one actually sends prompts to Gemini in your own
 * account — it's read-only (it never executes a tool, just checks what
 * comes back), but it does create a conversation thread.
 *
 * Run with: npm run test:e2e
 */
import assert from "node:assert/strict";
import { GeminiDriver } from "../driver/GeminiDriver.js";
import { parseGeminiReply } from "../agent/toolCallParser.js";
import { buildSystemPrimer, buildContextDocument } from "../agent/promptTemplate.js";
import { tools } from "../tools/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${(err as Error).message}`);
  }
}

async function main() {
  const driver = new GeminiDriver();
  console.log("Attaching to your logged-in Chrome...");
  await driver.attach();
  await driver.ensureLoggedIn();
  console.log("ok - attached and authenticated\n");

  console.log("Round trip:");

  await test("sends a prompt and reads the response back", async () => {
    await driver.newConversation();
    await driver.sendPrompt("Reply with exactly the word PONG and nothing else.");
    await driver.waitForResponseComplete();
    const reply = await driver.getLastResponse();
    console.log(`    [got ${reply.text.length} chars: ${JSON.stringify(reply.text.slice(0, 120))}]`);
    assert.match(reply.text, /PONG/i, `expected PONG in response, got: ${reply.text.slice(0, 200)}`);
  });

  await test("second send in the same thread works (the send-button bug)", async () => {
    await driver.sendPrompt("Now reply with exactly the word PONG2 and nothing else.");
    await driver.waitForResponseComplete();
    const reply = await driver.getLastResponse();
    console.log(`    [got: ${JSON.stringify(reply.text.slice(0, 120))}]`);
    assert.match(reply.text, /PONG2/i, `expected PONG2, got: ${reply.text.slice(0, 200)}`);
  });

  console.log("\nTool-call protocol (does real Gemini actually comply?):");

  await test("emits a parseable tool call when primed", async () => {
    await driver.newConversation();
    // Rules inline + a small context doc inline (the loop attaches it as a
    // file instead once it grows past the composer's practical budget).
    const primer = buildSystemPrimer(tools);
    const context = buildContextDocument({ tree: "demo/\n└── package.json" });
    await driver.sendPrompt(`${primer}\n\n---\n\n${context}\n\n---\n\nTASK:\nRead the file package.json.`);
    await driver.waitForResponseComplete();
    const reply = await driver.getLastResponse();
    console.log(`    [text: ${JSON.stringify(reply.text.slice(0, 150))}]`);
    console.log(`    [codeBlocks: ${JSON.stringify(reply.codeBlocks).slice(0, 200)}]`);

    const parsed = parseGeminiReply(reply);
    console.log(`    [parsed as: ${parsed.kind}]`);
    assert.equal(parsed.kind, "tool_call", `expected a tool_call, got ${parsed.kind}`);
    if (parsed.kind === "tool_call") {
      assert.equal(parsed.call.name, "read_file");
      // Accept either bare or tree-qualified path — we hand it a tree showing
      // demo/package.json, so resolving to that is correct behavior, not a bug.
      assert.match(String(parsed.call.args.path), /(^|\/)package\.json$/);
    }
  });

  await test("treats a plain prose answer as final (no false tool call)", async () => {
    await driver.newConversation();
    await driver.sendPrompt("In one short sentence, what is TypeScript?");
    await driver.waitForResponseComplete();
    const reply = await driver.getLastResponse();
    const parsed = parseGeminiReply(reply);
    console.log(`    [parsed as: ${parsed.kind}]`);
    assert.equal(parsed.kind, "final");
  });

  await driver.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
