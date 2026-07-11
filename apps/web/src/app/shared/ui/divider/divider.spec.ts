import { ComponentFixture, TestBed } from "@angular/core/testing";

import { DividerComponent } from "./divider";

describe("DividerComponent", () => {
    let fixture: ComponentFixture<DividerComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [DividerComponent] }).compileComponents();

        fixture = TestBed.createComponent(DividerComponent);
        await fixture.whenStable();
    });

    it("renders horizontally by default", () => {
        expect(fixture.nativeElement.getAttribute("aria-orientation")).toBe("horizontal");
    });

    it("supports a vertical orientation", async () => {
        fixture.componentRef.setInput("orientation", "vertical");
        await fixture.whenStable();

        expect(fixture.nativeElement.getAttribute("aria-orientation")).toBe("vertical");
    });
});
