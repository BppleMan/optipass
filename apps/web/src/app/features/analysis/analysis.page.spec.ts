import { describe, expect, it, vi } from "vitest";
import type { DuplicateItemView } from "../../core/models/workflow.models";
import { AnalysisPageComponent } from "./analysis.page";

describe("AnalysisPageComponent item decisions", () => {
    it("updates both keep state and removal action for a removed item", () => {
        const workflow = {
            updateKeep: vi.fn(),
            updateRemoveAction: vi.fn(),
        };
        const component = new AnalysisPageComponent(workflow as never);
        const item = { id: "item-1" } as DuplicateItemView;

        component.onItemDecisionChange(item, "delete");

        expect(workflow.updateKeep).toHaveBeenCalledWith("item-1", false);
        expect(workflow.updateRemoveAction).toHaveBeenCalledWith("item-1", "delete");
    });
});
