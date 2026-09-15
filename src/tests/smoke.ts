/**
 * Lightweight smoke tests, no framework — `npm test` runs this with tsx.
 *
 * These cover everything that does NOT require a logged-in Gemini session:
 * the tool-call parser, the local tools, and the full agent loop wired
 * against a fake driver. They do NOT touch selectors.ts or prove the real
 * Gemini DOM automation works — that step still needs your own login and
 * selector calibration (see README.md).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGeminiReply, looksLikeAbandonedWork } from "../agent/toolCallParser.js";
import { formatToolResult, buildContextDocument, buildSystemPrimer } from "../agent/promptTemplate.js";
import { AgentSession } from "../agent/loop.js";
import type { IGeminiDriver, GeminiResponse } from "../driver/IGeminiDriver.js";
import { readFileTool } from "../tools/readFile.js";
import { editFileTool } from "../tools/editFile.js";
import { searchCodeTool } from "../tools/searchCode.js";
import { gitStatusTool, gitDiffTool } from "../tools/git.js";
import { writeFileTool } from "../tools/writeFile.js";
import { bashTool, checkOutputTool, killProcessTool, looksLongRunning } from "../tools/bash.js";
import { fetchUrlTool } from "../tools/fetchUrl.js";
import { resolveModel, DEFAULT_MODEL_ALIAS, EXTENDED_THINKING } from "../driver/models.js";
import { buildProjectTree } from "../context/projectTree.js";
import { ensureMemoryFile, appendMemory, readMemory, MEMORY_FILENAME } from "../context/memory.js";
import { collectProjectDocs } from "../context/projectDocs.js";
import { isImagePath, normalizeDroppedPath } from "../context/clipboard.js";
import { CheckpointStore } from "../context/checkpoint.js";
import { confirmAction } from "../tools/confirm.js";
import { setAsker } from "../ui/prompt.js";
import { PlanJournal, readPlan, findResumablePlan, clearPlan } from "../context/plan.js";
import { runParallelTasks, createDelegateTool, MAX_WORKER_REPORT_CHARS } from "../agent/workers.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${(err as Error).stack ?? err}`);
  }
}

// --- Builders that mimic what GeminiDriver.getLastResponse() actually
// extracts from the rendered DOM: a tool call arrives as JSON inside a
// code block, with NO surviving backtick fence, often alongside chrome
// text the UI itself injects (e.g. Gemini's own "Code snippet" label) —
// exactly what real usage surfaced. See toolCallParser.ts for why.
function toolCallResponse(name: string, args: Record<string, unknown>): GeminiResponse {
  const json = JSON.stringify({ name, args });
  return { text: `Code snippet\n${json}`, codeBlocks: [json] };
}
function malformedToolResponse(rawJsonish: string): GeminiResponse {
  return { text: `Code snippet\n${rawJsonish}`, codeBlocks: [rawJsonish] };
}
function finalResponse(text: string): GeminiResponse {
  return { text, codeBlocks: [] };
}

// --- A fake driver that stands in for a real Gemini web session ---------
class FakeDriver implements IGeminiDriver {
  public sentMessages: string[] = [];
  public attachedFiles: (string | undefined)[] = [];
  private replies: GeminiResponse[];

  constructor(scriptedReplies: GeminiResponse[]) {
    this.replies = [...scriptedReplies];
  }

  async sendPrompt(text: string, opts?: { attachFile?: string }): Promise<void> {
    this.sentMessages.push(text);
    this.attachedFiles.push(opts?.attachFile);
  }

  async waitForResponseComplete(): Promise<void> {
    // Instant in the fake — no real generation to wait on.
  }

  async getLastResponse(): Promise<GeminiResponse> {
    const next = this.replies.shift();
    if (next === undefined) throw new Error("FakeDriver ran out of scripted replies");
    return next;
  }
}

async function main() {
  const tmpDir = path.resolve(process.cwd(), ".tmp-test");
  await mkdir(tmpDir, { recursive: true });

  // This whole suite is non-interactive (no TTY on stdin), so auto-approve
  // the confirm gates that write_file/run_bash would otherwise block on.
  process.env.GEMINI_CODE_AUTO_APPROVE = "1";

  console.log("Parser:");
  await test("parses a tool call out of a rendered code block", () => {
    const result = parseGeminiReply(toolCallResponse("read_file", { path: "x.txt" }));
    assert.equal(result.kind, "tool_call");
    if (result.kind === "tool_call") {
      assert.equal(result.call.name, "read_file");
      assert.deepEqual(result.call.args, { path: "x.txt" });
    }
  });

  await test("ignores UI chrome text (e.g. \"Code snippet\" label) around the code block", () => {
    // Regression test for the real bug: .text carries rendering chrome the
    // UI adds, but codeBlocks should still parse cleanly regardless.
    const result = parseGeminiReply({
      text: 'Code snippet\n{"name": "run_bash", "args": {"command": "ls -la"}}',
      codeBlocks: ['{"name": "run_bash", "args": {"command": "ls -la"}}'],
    });
    assert.equal(result.kind, "tool_call");
    if (result.kind === "tool_call") assert.equal(result.call.name, "run_bash");
  });

  await test("flags malformed JSON inside a code block as an attempted tool call", () => {
    const result = parseGeminiReply(malformedToolResponse('{"name": "read_file", "args": {oops}'));
    assert.equal(result.kind, "malformed");
  });

  await test("treats plain text with no code block as final", () => {
    const result = parseGeminiReply(finalResponse("Here's my answer: 42."));
    assert.equal(result.kind, "final");
    if (result.kind === "final") assert.equal(result.text, "Here's my answer: 42.");
  });

  await test("still recognizes a literal ```tool fence as a fallback", () => {
    const result = parseGeminiReply(
      finalResponse('```tool\n{"name": "read_file", "args": {"path": "x.txt"}}\n```')
    );
    assert.equal(result.kind, "tool_call");
  });

  await test("formatToolResult never starts with a ``` fence", () => {
    // Regression guard for the live-UI bug: a message starting with a fence
    // flips the composer into code-block mode and silently never sends.
    const formatted = formatToolResult('{"some": "json"}');
    assert.ok(!formatted.trimStart().startsWith("```"), "must not lead with a code fence");
    assert.match(formatted, /TOOL_RESULT/);
  });

  console.log("Tools:");
  const testFile = path.join(".tmp-test", "hello.txt");
  await test("write_file then read_file round-trips content", async () => {
    const writeResult = await writeFileTool.run({ path: testFile, content: "hello gemini-code" });
    assert.equal(writeResult.ok, true);
    const readResult = await readFileTool.run({ path: testFile });
    assert.equal(readResult.ok, true);
    assert.equal(readResult.output, "hello gemini-code");
  });

  await test("write_file/read_file refuse to escape the project root", async () => {
    const result = await writeFileTool.run({ path: "../outside.txt", content: "nope" });
    assert.equal(result.ok, false);
    assert.match(result.output, /escapes the project root/);
  });

  await test("run_bash executes and returns stdout (auto-approved)", async () => {
    const result = await bashTool.run({ command: "echo hello-from-bash" });
    assert.equal(result.ok, true);
    assert.match(result.output, /hello-from-bash/);
  });

  console.log("Protocol drift (long threads):");
  await test("spots a reply that pasted code instead of calling a tool", () => {
    assert.ok(looksLikeAbandonedWork({
      text: "Sure! I'll create the file for you.\n\ndef add(a,b): return a+b",
      codeBlocks: ["def add(a,b): return a+b"],
    }));
    assert.ok(looksLikeAbandonedWork({
      text: "Here's the code — you can save it as app.py:",
      codeBlocks: ["print('hi')"],
    }));
  });

  await test("does not mistake a genuine answer that quotes code for drift", () => {
    assert.ok(!looksLikeAbandonedWork({
      text: "The bug is on line 4, where `add` returns a string.",
      codeBlocks: ["return str(a+b)"],
    }));
    assert.ok(!looksLikeAbandonedWork({ text: "The version is 1.2.3.", codeBlocks: [] }));
  });

  await test("nudges a drifted reply back to tool calls instead of stopping", async () => {
    const driver = new FakeDriver([
      // Gemini forgets the protocol and pastes code...
      { text: "I'll create the file now.\n\nprint('hi')", codeBlocks: ["print('hi')"] },
      // ...then complies after the reminder.
      toolCallResponse("write_file", { path: ".tmp-test/drift.py", content: "print('hi')" }),
      finalResponse("Created it."),
    ]);
    const answer = await new AgentSession(driver).runTask("create a script");
    assert.equal(answer, "Created it.", "must recover rather than ending with nothing done");
    assert.match(driver.sentMessages[1], /REMINDER/, "should restate the contract");
    assert.equal(driver.sentMessages.length, 3);
  });

  await test("gives up nudging so it can't loop forever on a real answer", async () => {
    const stubborn = { text: "I'll do it: x=1", codeBlocks: ["x=1"] };
    const driver = new FakeDriver([stubborn, stubborn, stubborn, stubborn]);
    const answer = await new AgentSession(driver).runTask("do it");
    assert.match(answer, /I'll do it/, "accepts it as final once the nudges are spent");
    assert.ok(driver.sentMessages.length <= 4, "bounded, not an infinite nudge loop");
  });

  console.log("Long-running commands:");
  await test("recognises commands that never exit", () => {
    for (const cmd of ["npm run dev", "pnpm dev", "vite", "npx nodemon app.js", "uvicorn main:app",
                       "python3 -m http.server 8000", "tail -f log.txt", "next dev", "tsc --watch"]) {
      assert.ok(looksLongRunning(cmd), `should flag: ${cmd}`);
    }
    for (const cmd of ["npm run build", "ls -la", "pytest", "git status", "vite build", "npm test"]) {
      assert.ok(!looksLongRunning(cmd), `should NOT flag: ${cmd}`);
    }
  });

  await test("a server command is backgrounded instead of blocking the agent", async () => {
    const started = Date.now();
    const result = await bashTool.run({ command: "python3 -m http.server 8911" });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.match(result.output, /background/i, "must say it was backgrounded");
    assert.ok(elapsed < 5_000, `must return immediately, took ${elapsed}ms`);

    const id = String(result.output.match(/"(bg_[a-z0-9]+)"/)?.[1]);
    assert.ok(id.startsWith("bg_"), "returns a handle to read later");

    // It should actually be serving.
    await new Promise((r) => setTimeout(r, 1500));
    const alive = await fetch("http://localhost:8911").then((r) => r.ok).catch(() => false);
    assert.ok(alive, "the backgrounded server should really be running");

    const logs = await checkOutputTool.run({ id });
    assert.match(logs.output, /running/);

    // And killing it must take down the whole tree, not just the shell.
    await killProcessTool.run({ id });
    await new Promise((r) => setTimeout(r, 1500));
    const stillAlive = await fetch("http://localhost:8911").then((r) => r.ok).catch(() => false);
    assert.equal(stillAlive, false, "killing must stop the server, leaving no orphan holding the port");
  });

  await test("check_output lists processes and rejects unknown ids", async () => {
    const list = await checkOutputTool.run({});
    assert.ok(typeof list.output === "string");
    const bad = await checkOutputTool.run({ id: "bg_nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /No background process/);
  });

  console.log("Confirmation prompts:");
  await test("asks through the REPL's reader, not a second one on stdin", async () => {
    // Two readlines on one stdin echo every keystroke twice ("yy") and both
    // receive the line, so the answer also reached the REPL and was sent to
    // Gemini as a task. Confirmations must go through the registered asker.
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    const asked: string[] = [];
    setAsker(async (question) => {
      asked.push(question);
      return "y";
    });
    try {
      const approved = await confirmAction("Do the thing?", "details here");
      assert.equal(approved, true);
      assert.equal(asked.length, 1, "must ask exactly once, through the owner");
      assert.match(asked[0], /Do the thing\?/);
      assert.match(asked[0], /\(y\/N\)/);
    } finally {
      setAsker(undefined);
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
    }
  });

  await test("treats anything other than y as a refusal", async () => {
    delete process.env.GEMINI_CODE_AUTO_APPROVE;
    try {
      for (const reply of ["n", "", "no", "yes please", "Y "]) {
        setAsker(async () => reply);
        const approved = await confirmAction("Run?", "rm -rf /");
        assert.equal(approved, reply.trim().toLowerCase() === "y", `reply ${JSON.stringify(reply)}`);
      }
    } finally {
      setAsker(undefined);
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
    }
  });

  await test("auto-approve skips the prompt entirely", async () => {
    let askedAnything = false;
    setAsker(async () => {
      askedAnything = true;
      return "n";
    });
    try {
      process.env.GEMINI_CODE_AUTO_APPROVE = "1";
      assert.equal(await confirmAction("Run?", "ls"), true);
      assert.equal(askedAnything, false, "must not prompt when auto-approving");
    } finally {
      setAsker(undefined);
    }
  });

  console.log("Checkpoints (/undo):");
  await test("restores overwritten files and deletes newly-created ones", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    const store = new CheckpointStore(root);
    const existing = path.join(root, "keep.txt");
    const fresh = path.join(root, "new.txt");
    await writeFileTool.run({ path: path.join(".tmp-test", "keep.txt"), content: "ORIGINAL" });

    store.begin("do some damage");
    await store.recordBeforeWrite(existing);
    await writeFile(existing, "CLOBBERED", "utf8");
    await store.recordBeforeWrite(fresh);
    await writeFile(fresh, "brand new", "utf8");
    await store.commit();

    const result = await store.undoLast();
    assert.equal(result.ok, true, result.message);
    assert.equal(await readFile(existing, "utf8"), "ORIGINAL", "overwritten file must be restored");
    const stillThere = await readFile(fresh, "utf8").catch(() => undefined);
    assert.equal(stillThere, undefined, "a file created by the task must be removed again");
  });

  await test("keeps the FIRST version of a file edited repeatedly in one task", async () => {
    // Undo should go back to before the task, not to the second-to-last edit.
    const root = path.resolve(process.cwd(), ".tmp-test");
    const store = new CheckpointStore(root);
    const f = path.join(root, "multi.txt");
    await writeFile(f, "v1", "utf8");

    store.begin("edit twice");
    await store.recordBeforeWrite(f);
    await writeFile(f, "v2", "utf8");
    await store.recordBeforeWrite(f);
    await writeFile(f, "v3", "utf8");
    await store.commit();

    await store.undoLast();
    assert.equal(await readFile(f, "utf8"), "v1", "must restore the pre-task state");
  });

  await test("undo with nothing recorded says so instead of failing", async () => {
    const store = new CheckpointStore(path.resolve(process.cwd(), ".tmp-test", "empty"));
    const r = await store.undoLast();
    assert.equal(r.ok, false);
    assert.match(r.message, /Nothing to undo/);
  });

  console.log("Editing, search and git:");
  await test("edit_file changes only the targeted text", async () => {
    const f = path.join(".tmp-test", "edit.ts");
    await writeFileTool.run({ path: f, content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" });
    const r = await editFileTool.run({ path: f, old_text: "const b = 2;", new_text: "const b = 20;" });
    assert.equal(r.ok, true, r.output);
    const after = await readFile(path.resolve(f), "utf8");
    assert.equal(after, "const a = 1;\nconst b = 20;\nconst c = 3;\n", "surrounding lines must be untouched");
  });

  await test("edit_file REFUSES an ambiguous match rather than guessing", async () => {
    // The whole safety property: picking "the first one" would silently
    // edit a line the model didn't mean.
    const f = path.join(".tmp-test", "dup.ts");
    await writeFileTool.run({ path: f, content: "x = 1;\nx = 1;\n" });
    const r = await editFileTool.run({ path: f, old_text: "x = 1;", new_text: "x = 2;" });
    assert.equal(r.ok, false);
    assert.match(r.output, /appears 2 times/);
    const untouched = await readFile(path.resolve(f), "utf8");
    assert.equal(untouched, "x = 1;\nx = 1;\n", "the file must not be modified on an ambiguous edit");

    const all = await editFileTool.run({ path: f, old_text: "x = 1;", new_text: "x = 2;", replace_all: true });
    assert.equal(all.ok, true);
    assert.equal(await readFile(path.resolve(f), "utf8"), "x = 2;\nx = 2;\n");
  });

  await test("edit_file explains a miss instead of corrupting the file", async () => {
    const f = path.join(".tmp-test", "edit.ts");
    const before = await readFile(path.resolve(f), "utf8");
    const r = await editFileTool.run({ path: f, old_text: "not in the file", new_text: "y" });
    assert.equal(r.ok, false);
    assert.match(r.output, /match character for character/);
    assert.equal(await readFile(path.resolve(f), "utf8"), before, "file unchanged after a failed edit");
  });

  await test("read_file returns verbatim text that edit_file can match", async () => {
    // Line numbers in read_file output would make every edit fail, since
    // the model copies from it into old_text.
    const f = path.join(".tmp-test", "verbatim.ts");
    await writeFileTool.run({ path: f, content: "alpha\nbeta\ngamma\n" });
    const read = await readFileTool.run({ path: f });
    assert.ok(!/^\s*\d+\s/m.test(read.output), "must not prefix lines with numbers");
    const edit = await editFileTool.run({ path: f, old_text: "beta", new_text: "delta" });
    assert.equal(edit.ok, true, "text copied from read_file must match");
  });

  await test("read_file windows a large file instead of dumping it", async () => {
    const f = path.join(".tmp-test", "big.txt");
    await writeFileTool.run({ path: f, content: Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n") });
    const head = await readFileTool.run({ path: f });
    assert.match(head.output, /more lines/, "should say there's more rather than returning everything");
    assert.ok(!head.output.includes("line 900"), "must not dump the whole file");

    const windowed = await readFileTool.run({ path: f, offset: 500, limit: 3 });
    assert.match(windowed.output, /line 500/);
    assert.match(windowed.output, /line 502/);
    assert.ok(!windowed.output.includes("line 503"));
  });

  await test("search_code finds matches and skips noise directories", async () => {
    const r = await searchCodeTool.run({ pattern: "looksLikeAbandonedWork", glob: "*.ts" });
    assert.equal(r.ok, true);
    assert.match(r.output, /toolCallParser\.ts:\d+/);
    assert.ok(!r.output.includes("node_modules"), "must not search dependencies");

    // Built at runtime so the literal never appears in this file — the
    // first version of this test matched its own source and "failed".
    const absent = ["zq7", "nope", "marker"].join("_");
    const none = await searchCodeTool.run({ pattern: absent });
    assert.match(none.output, /No matches/);

    const bad = await searchCodeTool.run({ pattern: "([unclosed" });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /invalid regular expression/);
  });

  await test("git_status and git_diff report on the working tree", async () => {
    const status = await gitStatusTool.run({});
    assert.equal(status.ok, true, status.output);
    assert.match(status.output, /On branch/);
    const diff = await gitDiffTool.run({ stat: true });
    assert.equal(diff.ok, true, diff.output);
  });

  console.log("Agent loop (against a fake driver, no real browser):");
  await test("runs a tool call then returns the final answer", async () => {
    const targetPath = path.join(".tmp-test", "loop-output.txt");
    const driver = new FakeDriver([
      toolCallResponse("write_file", { path: targetPath, content: "written by the agent loop" }),
      finalResponse("Done — I created the file."),
    ]);
    const session = new AgentSession(driver);

    const answer = await session.runTask("create a test file");

    assert.equal(answer, "Done — I created the file.");
    assert.equal(driver.sentMessages.length, 2, "expected one prompt, then one tool result reply");
    assert.match(driver.sentMessages[0], /TASK:\ncreate a test file/);
    // Plain delimiter, NOT a ``` fence — see formatToolResult's comment: a
    // message starting with a fence silently never sends in the real UI.
    assert.match(driver.sentMessages[1], /TOOL_RESULT >>>/);
    assert.ok(!driver.sentMessages[1].startsWith("```"), "must not start with a code fence");
    assert.match(driver.sentMessages[1], /Wrote \d+ bytes/);

    const written = await readFile(path.resolve(process.cwd(), targetPath), "utf8");
    assert.equal(written, "written by the agent loop");
  });

  await test("retries once when Gemini emits malformed tool JSON", async () => {
    const driver = new FakeDriver([
      malformedToolResponse('{"name": "read_file", "args": {oops}'),
      finalResponse("Understood, here's my final answer instead."),
    ]);
    const session = new AgentSession(driver);
    const answer = await session.runTask("do something");
    assert.equal(answer, "Understood, here's my final answer instead.");
    assert.match(driver.sentMessages[1], /wasn't valid/);
  });

  await test("uploads oversized tool output as a file instead of pasting it", async () => {
    // Write a file bigger than the inline limit, then have the agent read it.
    const bigPath = path.join(".tmp-test", "big.txt");
    const bigContent = "x".repeat(9_000);
    await writeFileTool.run({ path: bigPath, content: bigContent });

    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: bigPath }),
      finalResponse("Got the big file."),
    ]);
    const session = new AgentSession(driver);
    await session.runTask("read the big file");

    // The second message must NOT contain the payload — it should say the
    // result was attached, and carry an actual attachment path.
    assert.ok(!driver.sentMessages[1].includes(bigContent), "payload must not be pasted inline");
    assert.match(driver.sentMessages[1], /ATTACHED/);
    assert.ok(driver.attachedFiles[1], "expected an attached file on the tool-result turn");
    assert.match(String(driver.attachedFiles[1]), /big\.txt$/);
  });

  await test("keeps small tool output inline (no attachment)", async () => {
    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: testFile }),
      finalResponse("Read it."),
    ]);
    const session = new AgentSession(driver);
    await session.runTask("read the small file");
    assert.match(driver.sentMessages[1], /hello gemini-code/);
    assert.equal(driver.attachedFiles[1], undefined);
  });

  await test("fetch_url validates the URL and refuses non-http schemes", async () => {
    assert.match((await fetchUrlTool.run({})).output, /'url' is required/);
    assert.match((await fetchUrlTool.run({ url: "not a url" })).output, /not a valid URL/);
    assert.match((await fetchUrlTool.run({ url: "file:///etc/passwd" })).output, /only http\/https/);
    assert.match((await fetchUrlTool.run({ url: "ftp://example.com" })).output, /only http\/https/);
  });

  console.log("Context document:");
  await test("collects project .md docs, excluding GEMINI.md and noise dirs", async () => {
    const docs = await collectProjectDocs();
    const paths = docs.map((d) => d.path);
    assert.ok(paths.includes("README.md"), `expected README.md, got ${paths.join(", ")}`);
    assert.ok(!paths.includes(MEMORY_FILENAME), "GEMINI.md is carried separately as memory");
    assert.ok(!paths.some((p) => p.includes("node_modules")), "must skip node_modules");
  });

  await test("context document carries tree, memory and docs", () => {
    const doc = buildContextDocument({
      tree: "proj/\n└── a.ts",
      memory: "- uses pnpm",
      docs: [{ path: "README.md", content: "# Hello" }],
    });
    assert.match(String(doc), /Project structure/);
    assert.match(String(doc), /a\.ts/);
    assert.match(String(doc), /uses pnpm/);
    assert.match(String(doc), /README\.md/);
    assert.match(String(doc), /# Hello/);
    assert.equal(buildContextDocument({}), undefined, "nothing to send -> undefined");
  });

  await test("large context is attached as a file, not pasted inline", async () => {
    const bigTree = Array.from({ length: 500 }, (_, i) => `├── file-${i}.ts`).join("\n");
    const driver = new FakeDriver([finalResponse("ok")]);
    const session = new AgentSession(driver, { tree: bigTree });
    await session.runTask("say hi");

    const first = driver.sentMessages[0];
    // Rules must stay inline — Gemini can't emit a valid tool call without
    // them, so they must not depend on it opening the attachment first.
    assert.match(first, /RULES FOR USING TOOLS/);
    assert.ok(!first.includes("file-499.ts"), "bulk context must not be pasted inline");
    assert.match(first, /ATTACHED/);
    assert.ok(driver.attachedFiles[0], "expected a context attachment");
    // Short, stable filename on purpose — the attachment chip ellipsizes
    // long names, which broke the upload-succeeded check against the UI.
    assert.match(String(driver.attachedFiles[0]), /context\.md$/);
  });

  await test("small context stays inline (no attachment)", async () => {
    const driver = new FakeDriver([finalResponse("ok")]);
    const session = new AgentSession(driver, { tree: "proj/\n└── a.ts" });
    await session.runTask("say hi");
    assert.match(driver.sentMessages[0], /a\.ts/);
    assert.equal(driver.attachedFiles[0], undefined);
  });

  await test("mid-task input is injected as steering on the next turn", async () => {
    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: "package.json" }),
      finalResponse("done"),
    ]);
    const session = new AgentSession(driver);
    // Simulates the user typing AFTER the task is already under way:
    // nothing queued on turn 1, something queued by turn 2.
    let turn = 0;
    await session.runTask("build a thing", {
      getSteering: () => (turn++ === 0 ? [] : ["actually use TypeScript, not JS"]),
    });
    assert.ok(!driver.sentMessages[0].includes("USER UPDATE"), "nothing to steer with yet on turn 1");
    assert.match(driver.sentMessages[1], /USER UPDATE/);
    assert.match(driver.sentMessages[1], /use TypeScript, not JS/);
    // Steering leads the message so the model reads the correction first.
    assert.ok(
      driver.sentMessages[1].indexOf("USER UPDATE") < driver.sentMessages[1].indexOf("TOOL_RESULT"),
      "steering should precede the tool result"
    );
  });

  await test("a failed turn is retried by RE-SENDING, not just re-waiting", async () => {
    // The real-world failure is Gemini accepting a message then never
    // replying — so a retry that only waits again can never recover. The
    // retry must re-send.
    let sends = 0;
    let waits = 0;
    const flaky: IGeminiDriver = {
      async sendPrompt() {
        sends++;
      },
      async waitForResponseComplete() {
        waits++;
        if (waits < 2) throw new Error("no new response ever appeared");
      },
      async getLastResponse() {
        return finalResponse("recovered");
      },
    } as unknown as IGeminiDriver;

    const answer = await new AgentSession(flaky).runTask("do it");
    assert.equal(answer, "recovered");
    assert.equal(waits, 2, "waited twice");
    assert.equal(sends, 2, "must have re-sent the message, not just waited again");
  });

  console.log("Attachments (images & screenshots):");
  await test("a tool that returns an attachment gets it sent with the result", async () => {
    const shot = path.join(".tmp-test", "shot.png");
    await writeFileTool.run({ path: shot, content: "fake-png" });
    const fakeTool = {
      name: "screenshot_page",
      description: "screenshot_page(args) -> attaches an image",
      run: async () => ({ ok: true, output: "Screenshot attached.", attachment: path.resolve(shot) }),
    };
    const driver = new FakeDriver([
      toolCallResponse("screenshot_page", { url: "http://localhost:3000" }),
      finalResponse("looks good"),
    ]);
    await new AgentSession(driver, {}, [fakeTool]).runTask("check the page");
    assert.deepEqual(driver.attachedFiles[1], [path.resolve(shot)], "the image must ride along with the result");
    assert.match(driver.sentMessages[1], /Screenshot attached/);
  });

  await test("user-supplied images are attached to the first message", async () => {
    const img = path.resolve(".tmp-test", "mine.png");
    await writeFileTool.run({ path: path.join(".tmp-test", "mine.png"), content: "x" });
    const driver = new FakeDriver([finalResponse("ok")]);
    await new AgentSession(driver).runTask("what is in this image?", { attachments: [img] });
    assert.deepEqual(driver.attachedFiles[0], [img]);
  });

  await test("NEVER deletes a user's own file after sending it", async () => {
    // Attachments we generate live in .gemini-code-tmp and are cleaned up;
    // a file the user pointed at is theirs and must survive.
    const mine = path.join(".tmp-test", "keep-me.png");
    await writeFileTool.run({ path: mine, content: "precious" });
    const absolute = path.resolve(mine);
    const driver = new FakeDriver([finalResponse("ok")]);
    await new AgentSession(driver).runTask("look at this", { attachments: [absolute] });
    const survived = await readFile(absolute, "utf8").catch(() => undefined);
    assert.equal(survived, "precious", "the user's file must still exist after being sent");
  });

  await test("recognises image paths, including dragged-in quoted ones", () => {
    assert.ok(isImagePath("/tmp/a.png"));
    assert.ok(isImagePath("shot.JPEG"));
    assert.ok(!isImagePath("notes.txt"));
    assert.equal(normalizeDroppedPath("'/tmp/my shot.png'"), "/tmp/my shot.png");
    assert.equal(normalizeDroppedPath("/tmp/my\\ shot.png"), "/tmp/my shot.png");
  });

  console.log("Orchestrator / worker roles:");
  await test("orchestrator is told to delegate, not to write code itself", () => {
    const primer = buildSystemPrimer([], "orchestrator");
    assert.match(primer, /ORCHESTRATOR/);
    assert.match(primer, /DO NOT write application code yourself/);
    assert.match(primer, /VALIDATE/);
    assert.match(primer, /CORRECTION round/);
  });

  await test("worker is told to report briefly, never paste code back", () => {
    const primer = buildSystemPrimer([], "worker");
    assert.match(primer, /WORKER/);
    assert.match(primer, /SHORT REPORT/);
    assert.match(primer, /Never paste full file contents/);
    assert.ok(!/ORCHESTRATOR \(main thread\)/.test(primer), "worker must not get orchestrator rules");
  });

  await test("a worker report that ignores instructions is truncated anyway", async () => {
    const fakeParent = {
      async spawnTab() {
        return { setModel: async () => "Flash", close: async () => {} };
      },
    } as unknown as Parameters<typeof runParallelTasks>[1]["parent"];
    const huge = "x".repeat(MAX_WORKER_REPORT_CHARS + 5_000);
    const [result] = await runParallelTasks([{ name: "w", prompt: "p" }], {
      parent: fakeParent,
      context: {},
      log: () => {},
      createSession: () => ({ runTask: async () => huge }),
    });
    assert.ok(
      result.result.length < huge.length,
      "the orchestrator's context must be protected even from a misbehaving worker"
    );
    assert.match(result.result, /report truncated/);
  });

  console.log("Plan journal (crash resumability):");
  await test("journals task, steps and progress to disk as it goes", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    const journal = new PlanJournal(root);
    await journal.begin("build an API");
    await journal.setSteps([{ title: "create app", done: true }, { title: "add tests", done: false }]);
    await journal.log("write_file(app.py) -> ok");

    const mid = await readPlan(root);
    assert.equal(mid?.status, "in_progress", "an unfinished task stays in_progress on disk");
    assert.match(String(mid?.raw), /build an API/);
    assert.match(String(mid?.raw), /- \[x\] create app/);
    assert.match(String(mid?.raw), /- \[ \] add tests/);
    assert.match(String(mid?.raw), /write_file\(app\.py\)/);

    // Written progressively, so a crash right here still leaves it resumable.
    const resumable = await findResumablePlan(root);
    assert.ok(resumable, "an in_progress plan must be offered for resume");

    await journal.complete("done");
    assert.equal((await readPlan(root))?.status, "completed");
    assert.equal(await findResumablePlan(root), undefined, "a finished plan is not resumed");
  });

  await test("an interrupted plan is marked and stays resumable", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    await clearPlan(root);
    const journal = new PlanJournal(root);
    await journal.begin("long task");
    await journal.markInterrupted("session terminated");
    const plan = await readPlan(root);
    assert.equal(plan?.status, "interrupted");
    assert.ok(await findResumablePlan(root), "interrupted work must be resumable");
    await clearPlan(root);
  });

  await test("the agent loop journals automatically, without model cooperation", async () => {
    const root = path.resolve(process.cwd(), ".tmp-test");
    await clearPlan(root);
    const journal = new PlanJournal(root);
    const driver = new FakeDriver([
      toolCallResponse("read_file", { path: "package.json" }),
      finalResponse("all done"),
    ]);
    await new AgentSession(driver, {}, [], journal).runTask("inspect the project");
    const plan = await readPlan(root);
    assert.match(String(plan?.raw), /inspect the project/, "records the task");
    assert.match(String(plan?.raw), /read_file\(package\.json\)/, "records tool calls even if the model never calls update_plan");
    assert.equal(plan?.status, "completed");
    await clearPlan(root);
  });

  await test("a resumable plan is carried into the primer as unfinished work", () => {
    const doc = buildContextDocument({ resumePlan: "- [x] step one\n- [ ] step two" });
    assert.match(String(doc), /UNFINISHED WORK/);
    assert.match(String(doc), /Do NOT start over/);
    assert.match(String(doc), /step two/);
  });

  console.log("Parallel workers:");
  // Stagger/retries are read at call time so tests can pin them.
  process.env.GEMINI_CODE_WORKER_STAGGER_MS = "0";
  await test("runs subtasks concurrently, each in its own tab", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    let liveTabs = 0;
    let peakConcurrency = 0;

    const fakeParent = {
      async spawnTab() {
        const id = `tab-${opened.length + 1}`;
        opened.push(id);
        liveTabs++;
        peakConcurrency = Math.max(peakConcurrency, liveTabs);
        return {
          setModel: async () => "Flash",
          close: async () => {
            liveTabs--;
            closed.push(id);
          },
        };
      },
    } as unknown as Parameters<typeof runParallelTasks>[1]["parent"];

    const results = await runParallelTasks(
      [
        { name: "a", prompt: "do a" },
        { name: "b", prompt: "do b" },
        { name: "c", prompt: "do c" },
      ],
      {
        parent: fakeParent,
        context: {},
        log: () => {},
        createSession: () => ({
          runTask: async (task: string) => {
            await new Promise((r) => setTimeout(r, 30));
            return `result of ${task}`;
          },
        }),
      }
    );

    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.name), ["a", "b", "c"], "results keep input order");
    assert.ok(results.every((r) => r.ok));
    assert.match(results[1].result, /do b/);
    assert.ok(peakConcurrency > 1, `expected real concurrency, peaked at ${peakConcurrency}`);
    assert.equal(closed.length, 3, "every worker tab must be closed");
  });

  await test("one failing worker doesn't sink the others", async () => {
    let closedCount = 0;
    const fakeParent = {
      async spawnTab() {
        return { setModel: async () => "Flash", close: async () => void closedCount++ };
      },
    } as unknown as Parameters<typeof runParallelTasks>[1]["parent"];

    const results = await runParallelTasks(
      [
        { name: "good", prompt: "ok" },
        { name: "bad", prompt: "boom" },
      ],
      {
        parent: fakeParent,
        context: {},
        log: () => {},
        createSession: () => ({
          runTask: async (task: string) => {
            if (task === "boom") throw new Error("worker exploded");
            return "fine";
          },
        }),
      }
    );

    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].result, /worker exploded/);
    assert.match(results[1].result, /attempt/, "records how many attempts were made");
    // 1 good worker + the failing one retried once = 3 tabs, all closed.
    assert.equal(closedCount, 3, "tabs must be closed even when the task throws, including retries");
  });

  await test("delegate tool validates its input", async () => {
    const tool = createDelegateTool({
      parent: {} as never,
      context: {},
      log: () => {},
      createSession: () => ({ runTask: async () => "x" }),
    });
    assert.match((await tool.run({})).output, /non-empty array/);
    assert.match((await tool.run({ tasks: [{ name: "a" }] })).output, /has no prompt/);
  });

  await test("workers cannot delegate further (no recursive spawning)", async () => {
    // The main session gets delegate_tasks injected; worker sessions are
    // built without it, so a worker can't spawn its own workers.
    const driver = new FakeDriver([finalResponse("ok")]);
    const delegate = createDelegateTool({
      parent: {} as never,
      context: {},
      log: () => {},
      createSession: () => ({ runTask: async () => "x" }),
    });
    const main = new AgentSession(driver, {}, [delegate]);
    await main.runTask("hi");
    assert.match(driver.sentMessages[0], /delegate_tasks/, "main session advertises delegation");

    const workerDriver = new FakeDriver([finalResponse("ok")]);
    const worker = new AgentSession(workerDriver, {});
    await worker.runTask("hi");
    assert.ok(
      !workerDriver.sentMessages[0].includes("delegate_tasks"),
      "worker session must NOT advertise delegation"
    );
  });

  console.log("Model selection:");
  await test("resolves friendly aliases, and 'fast' is the default", () => {
    assert.equal(resolveModel("fast")?.name, "Flash");
    assert.equal(resolveModel("pro")?.name, "Pro");
    assert.equal(resolveModel("fastest")?.name, "Flash-Lite");
    assert.equal(resolveModel("nonsense"), undefined);
    assert.equal(resolveModel(DEFAULT_MODEL_ALIAS)?.name, "Flash");
    // Extended thinking is a toggle stacked on the base model, not a model
    // of its own (the picker reads e.g. "Flash Extended") — verified live.
    assert.equal(resolveModel("thinking"), undefined, "thinking is a toggle, not a model");
  });

  await test("matches live menu labels despite version-number drift", () => {
    // The picker shows e.g. "3.6 Flash", which Google bumps over time —
    // matching must be keyword-based, not exact-label.
    const flash = resolveModel("fast")!;
    const lite = resolveModel("fastest")!;
    assert.ok(flash.matches("3.6 Flash\nAll-around help"), "should match current label");
    assert.ok(flash.matches("4.0 Flash\nAll-around help"), "should survive a version bump");
    assert.ok(!flash.matches("3.5 Flash-Lite\nFastest answers"), "must not swallow Flash-Lite");
    assert.ok(lite.matches("3.5 Flash-Lite\nFastest answers"));
    assert.ok(resolveModel("pro")!.matches("3.1 Pro\nAdvanced reasoning"));
    assert.ok(EXTENDED_THINKING.matches("Extended thinking\nComplex problem solving"));
    // The toggle's on/off state is read from the picker label suffix.
    assert.ok(EXTENDED_THINKING.labelMarker.test("Flash Extended"));
    assert.ok(!EXTENDED_THINKING.labelMarker.test("Flash"));
  });

  console.log("Context (tree + memory):");
  await test("project tree renders and excludes noise directories", async () => {
    const tree = await buildProjectTree();
    assert.match(tree, /src\//);
    assert.ok(!tree.includes("node_modules"), "node_modules must be excluded");
    assert.ok(!tree.includes(".gemini-code-profile"), "browser profile must be excluded");
  });

  await test("GEMINI.md is created once and appended to, never clobbered", async () => {
    const memRoot = path.resolve(process.cwd(), ".tmp-test");
    const created = await ensureMemoryFile("fake-tree/", memRoot);
    assert.equal(created, true, "first call should create it");

    const createdAgain = await ensureMemoryFile("different-tree/", memRoot);
    assert.equal(createdAgain, false, "second call must not recreate/clobber");

    await appendMemory("uses pnpm, not npm", memRoot);
    const memory = await readMemory(memRoot);
    assert.match(String(memory), /fake-tree\//, "original content preserved");
    assert.match(String(memory), /uses pnpm, not npm/, "note appended");
  });

  await rm(tmpDir, { recursive: true, force: true });
  await rm(path.resolve(process.cwd(), ".gemini-code-tmp"), { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
