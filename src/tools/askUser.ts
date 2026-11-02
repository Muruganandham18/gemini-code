import type { ToolDefinition } from "../types.js";
import { askQuestion } from "./confirm.js";

const MAX_OPTIONS = 6;

export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    `ask_user(args: {question: string, options?: string[]}) -> asks the user something and waits for the reply. Use ` +
    `it only for a decision that is theirs to make and that you can't settle from the code, not for permission to ` +
    `act: writes and commands already ask for approval. 'options' offers up to ${MAX_OPTIONS} choices, and they can ` +
    `still type something else.`,
  async run(args) {
    const question = String(args.question ?? "").trim();
    if (!question) return { ok: false, output: "Error: 'question' is required." };
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, MAX_OPTIONS) : [];

    const answer = await askQuestion(question, options);
    if (answer === undefined) {
      return { ok: false, output: "Nobody is available to answer. Decide for yourself and say what you chose." };
    }
    return { ok: true, output: answer ? `The user answered: ${answer}` : "The user gave no answer." };
  },
};
