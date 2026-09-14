import type { ToolDefinition } from "../types.js";
import type { PlanJournal, PlanStep } from "../context/plan.js";
import { PLAN_FILENAME } from "../context/plan.js";

/**
 * Built per-session (like delegate_tasks) because it writes into the live
 * journal for the task currently running.
 */
export function createUpdatePlanTool(journal: PlanJournal): ToolDefinition {
  return {
    name: "update_plan",
    description:
      `update_plan(args: {steps: [{title: string, done?: boolean}]}) -> records your plan for this task in ` +
      `${PLAN_FILENAME}. Call it EARLY for any multi-step task with the steps you intend to take, then call it ` +
      `again as you finish each one (same list, flipping done to true). The file survives crashes and ` +
      `interruptions, so if this session dies the next one resumes from it instead of starting over.`,
    async run(args) {
      const raw = args.steps;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, output: "Error: 'steps' must be a non-empty array of {title, done?}." };
      }
      const steps: PlanStep[] = raw.slice(0, 40).map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          title: String(item?.title ?? item ?? "").slice(0, 200),
          done: Boolean(item?.done),
        };
      });
      if (steps.some((s) => !s.title)) {
        return { ok: false, output: "Error: every step needs a non-empty 'title'." };
      }

      await journal.setSteps(steps);
      const done = steps.filter((s) => s.done).length;
      return { ok: true, output: `Plan saved to ${PLAN_FILENAME} (${done}/${steps.length} steps done).` };
    },
  };
}
