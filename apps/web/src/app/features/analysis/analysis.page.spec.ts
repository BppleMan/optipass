import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuplicateGroupView, DuplicateItemView } from "../../core/models/workflow.models";
import { AnalysisPageComponent } from "./analysis.page";

describe("AnalysisPageComponent tag popover", () => {
    afterEach(() => vi.useRealTimers());

    it("closes immediately after the pointer leaves the tag for outside", () => {
        const component = new AnalysisPageComponent({} as never);
        const trigger = {
            getBoundingClientRect: () => ({ left: 80, top: 100, bottom: 128 }),
        } as HTMLElement;

        component.enterTagPopoverTrigger({ currentTarget: trigger } as unknown as MouseEvent, group(), item());
        component.leaveTagPopoverTrigger({ relatedTarget: null } as unknown as MouseEvent);

        expect(component.tagPopover).toBeUndefined();
    });

    it("keeps the popover when the pointer leaves its tag directly into the overlay", () => {
        const component = new AnalysisPageComponent({} as never);
        const trigger = {
            getBoundingClientRect: () => ({ left: 80, top: 100, bottom: 128 }),
        } as HTMLElement;

        const overlay = document.createElement("div");
        Object.defineProperty(component, "tagPopoverOverlay", { value: { nativeElement: overlay } });
        component.enterTagPopoverTrigger({ currentTarget: trigger } as unknown as MouseEvent, group(), item());
        component.leaveTagPopoverTrigger({ relatedTarget: overlay } as unknown as MouseEvent);

        expect(component.tagPopover).toMatchObject({ top: 128, above: false });
    });
});

function group(): DuplicateGroupView {
    return { id: "group-1", items: [] } as unknown as DuplicateGroupView;
}

function item(): DuplicateItemView {
    return { id: "item-1" } as DuplicateItemView;
}
