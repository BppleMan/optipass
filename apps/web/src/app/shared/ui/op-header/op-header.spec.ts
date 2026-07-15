import { ComponentFixture, TestBed } from "@angular/core/testing";

import { OpHeaderComponent } from "./op-header";

describe("OpHeaderComponent", () => {
    let component: OpHeaderComponent;
    let fixture: ComponentFixture<OpHeaderComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [OpHeaderComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(OpHeaderComponent);
        component = fixture.componentInstance;
        await fixture.whenStable();
    });

    it("renders the dry-run speed segments and emits the selected multiplier", async () => {
        const emitted: number[] = [];
        component.dryRunSpeedMultiplierChange.subscribe((value) => emitted.push(value));

        const element = fixture.nativeElement as HTMLElement;
        expect(element.querySelector(".account-chip.empty")).not.toBeNull();
        expect(element.textContent).not.toContain("试写倍率");
        const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>(".dry-run-speed-segments button"));
        expect(buttons.map((button) => button.textContent?.trim())).toEqual(["1x", "5x", "10x"]);
        expect(buttons[0].getAttribute("aria-pressed")).toBe("true");

        buttons[1].click();
        await fixture.whenStable();

        expect(emitted).toEqual([5]);
    });

    it("hides the dry-run speed selector in write mode", async () => {
        fixture.componentRef.setInput("mutationsEnabled", true);
        await fixture.whenStable();

        const element = fixture.nativeElement as HTMLElement;
        expect(element.querySelector(".dry-run-speed-control")).toBeNull();
        expect(element.textContent).toContain("可写模式");
    });
});
