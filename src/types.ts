export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolDefinition {
  name: string;
  /** Shown to Gemini in the priming prompt so it knows the tool exists and its args. */
  description: string;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}
