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
        expect(element.querySelector(".header-context > op-divider")).not.toBeNull();
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

    it("uses account colors only after authorization succeeds", async () => {
        fixture.componentRef.setInput("accountChip", "BppleMan");
        await fixture.whenStable();

        const account = (fixture.nativeElement as HTMLElement).querySelector(".account-chip")!;
        expect(account.classList.contains("authorized")).toBe(false);
        expect(account.getAttribute("title")).toBe("尚未授权的 1Password 账户");

        fixture.componentRef.setInput("accountAuthorizationState", "authorizing");
        await fixture.whenStable();
        expect(account.classList.contains("authorizing")).toBe(true);
        expect(account.getAttribute("title")).toBe("正在授权的 1Password 账户");

        fixture.componentRef.setInput("accountAuthorizationState", "authorized");
        await fixture.whenStable();
        expect(account.classList.contains("authorized")).toBe(true);
        expect(account.getAttribute("title")).toBe("已授权的 1Password 账户");

        fixture.componentRef.setInput("accountAuthorizationState", "failed");
        await fixture.whenStable();
        expect(account.classList.contains("failed")).toBe(true);
        expect(account.getAttribute("title")).toBe("授权失败的 1Password 账户");
    });
});
