import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

const MAX_SKILL_CHARS = 20_000;

/** Project folders first, so a project can override a personal skill of the same name. */
function skillDirs(root = process.cwd()): string[] {
  return [
    path.join(root, ".gemini-code", "skills"),
    path.join(root, ".claude", "skills"),
    path.join(homedir(), ".gemini-code", "skills"),
  ];
}

function description(content: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  return /^description:\s*(.+)$/m.exec(frontmatter)?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
}

/** A skill is <dir>/<name>/SKILL.md, or just <dir>/<name>.md. */
async function findSkills(root?: string): Promise<Map<string, { file: string; content: string }>> {
  const skills = new Map<string, { file: string; content: string }>();
  for (const dir of skillDirs(root)) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const isFile = entry.isFile() && entry.name.endsWith(".md");
      if (!isFile && !entry.isDirectory()) continue;
      const name = isFile ? entry.name.slice(0, -3) : entry.name;
      const file = path.join(dir, entry.name, ...(isFile ? [] : ["SKILL.md"]));
      if (skills.has(name)) continue;
      const content = await readFile(file, "utf8").catch(() => undefined);
      if (content !== undefined) skills.set(name, { file, content });
    }
  }
  return skills;
}

export const useSkillTool: ToolDefinition = {
  name: "use_skill",
  description:
    `use_skill(args: {name?: string}) -> reusable instructions for a kind of task, kept in the project's ` +
    `.gemini-code/skills or .claude/skills folder, or in ~/.gemini-code/skills. Call it with no name to list them, ` +
    `then with a name to read one and follow it.`,
  async run(args) {
    const skills = await findSkills();
    const name = String(args.name ?? "").trim();
    if (!name) {
      if (!skills.size) return { ok: true, output: "No skills are set up for this project." };
      const list = [...skills].map(([n, s]) => `- ${n}${description(s.content) ? `: ${description(s.content)}` : ""}`);
      return { ok: true, output: list.join("\n") };
    }
    const skill = skills.get(name);
    if (!skill) {
      return { ok: false, output: `No skill "${name}". Available: ${[...skills.keys()].join(", ") || "(none)"}` };
    }
    const cut = skill.content.length > MAX_SKILL_CHARS;
    return { ok: true, output: skill.content.slice(0, MAX_SKILL_CHARS) + (cut ? "\n[skill cut short]" : "") };
  },
};
