import { ComponentFixture, TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControlComponent, type SegmentedControlItem } from "./segmented-control";

describe("SegmentedControlComponent", () => {
    const items: SegmentedControlItem[] = [
        { value: "keep", label: "保留", icon: "keep" },
        { value: "archive", label: "归档", icon: "archive" },
        { value: "delete", label: "删除", icon: "delete", activeColor: "#FFB8C3" },
    ];

    it("emits an enabled click selection and supports arrow-key selection", () => {
        const fixture = createComponent();
        const component = fixture.componentInstance;
        const emit = vi.spyOn(component.valueChange, "emit");
        const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll("button")) as HTMLButtonElement[];

        buttons[1].click();
        buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenNthCalledWith(1, "archive");
        expect(emit).toHaveBeenNthCalledWith(2, "archive");
    });

    it("does not emit for the selected or disabled segment", () => {
        const fixture = createComponent();
        const component = fixture.componentInstance;
        const emit = vi.spyOn(component.valueChange, "emit");

        component.select(items[0]);
        fixture.componentRef.setInput("disabled", true);
        component.select(items[1]);

        expect(emit).not.toHaveBeenCalled();
    });

    it("marks the host for equal-width layout when requested", () => {
        const fixture = createComponent();
        fixture.componentRef.setInput("fullWidth", true);
        fixture.detectChanges();

        expect(fixture.nativeElement.getAttribute("data-full-width")).toBe("true");
    });

    function createComponent(): ComponentFixture<SegmentedControlComponent> {
        TestBed.configureTestingModule({ imports: [SegmentedControlComponent] });
        const fixture = TestBed.createComponent(SegmentedControlComponent);
        fixture.componentRef.setInput("items", items);
        fixture.componentRef.setInput("value", "keep");
        fixture.componentRef.setInput("ariaLabel", "处置方式");
        fixture.detectChanges();
        return fixture;
    }
});
