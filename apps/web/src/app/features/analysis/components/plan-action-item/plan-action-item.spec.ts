import { ComponentFixture, TestBed } from "@angular/core/testing";

import type { PlanActionPreviewView } from "../../../../core/models/workflow.models";
import { PlanActionItemComponent } from "./plan-action-item";

describe("PlanActionItemComponent", () => {
    let fixture: ComponentFixture<PlanActionItemComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [PlanActionItemComponent] }).compileComponents();

        fixture = TestBed.createComponent(PlanActionItemComponent);
        fixture.componentRef.setInput("action", action());
        await fixture.whenStable();
    });

    it("renders all execution fields without an interactive disclosure", () => {
        const element = fixture.nativeElement as HTMLElement;
        const text = element.textContent;

        expect(text).toContain("示例账号");
        expect(text).toContain("user@example.com");
        expect(text).toContain("https://example.com");
        expect(text).not.toContain("保留在 iCloud");
        expect(text).toContain("2025-01-01");
        expect(text).toContain("2025-02-01");
        expect(text).toContain("个人");
        expect(element.querySelector("button")).toBeNull();
        expect(element.querySelectorAll("op-vault-icon")).toHaveLength(2);
        expect(element.querySelectorAll("op-divider")).toHaveLength(3);
        expect(element.querySelector(".divider")).toBeNull();
        const operationIconStyle = getComputedStyle(element.querySelector(".operation-icon svg")!);
        const vaultIcons = Array.from(element.querySelectorAll("op-vault-icon svg"));
        const actionStyle = getComputedStyle(element.querySelector(".plan-action")!);
        expect(operationIconStyle.width).toBe("18px");
        expect(operationIconStyle.height).toBe("18px");
        expect(vaultIcons.every((icon) => icon.getAttribute("width") === "18" && icon.getAttribute("height") === "18")).toBe(true);
        expect(actionStyle.fontSize).toBe("10px");
        expect(actionStyle.lineHeight).toBe("14px");
    });

    it("renders an archive target as a dedicated archive label", async () => {
        fixture.componentRef.setInput("action", {
            ...action(),
            id: "archive:item-1",
            opLabel: "归档",
            targetLabel: "归档",
            tone: "archive",
            color: "#FFCB6B",
            bg: "rgba(255, 203, 107, 0.09)",
            border: "rgba(255, 203, 107, 0.34)",
        });
        await fixture.whenStable();

        const element = fixture.nativeElement as HTMLElement;
        const archiveIcon = element.querySelector(".archive-label op-vault-icon svg");
        expect(archiveIcon?.getAttribute("width")).toBe("10");
        expect(archiveIcon?.getAttribute("height")).toBe("10");
        expect(element.querySelectorAll("op-vault-icon")).toHaveLength(2);
    });

    it("renders a group skip without item-level fields", async () => {
        fixture.componentRef.setInput("action", {
            ...action(),
            id: "skip:group-1",
            itemId: "group-1",
            title: "本组 2 个项目",
            username: "",
            url: "",
            created: "",
            updated: "",
            vaultName: "",
            opLabel: "跳过",
            targetLabel: "",
            detail: "",
            tone: "skip",
            removedTags: [],
            retainedTags: [],
            color: "#78909C",
            bg: "rgba(120, 144, 156, 0.1)",
            border: "rgba(120, 144, 156, 0.32)",
        });
        await fixture.whenStable();

        const element = fixture.nativeElement as HTMLElement;
        expect(element.textContent).toContain("跳过");
        expect(element.textContent).toContain("本组 2 个项目");
        expect(element.querySelector(".action-meta")).toBeNull();
        expect(element.querySelector(".action-route")).toBeNull();
        expect(element.querySelectorAll("op-divider")).toHaveLength(1);
    });

    function action(): PlanActionPreviewView {
        return {
            id: "keep:item-1",
            itemId: "item-1",
            title: "示例账号",
            username: "user@example.com",
            url: "https://example.com",
            created: "2025-01-01",
            updated: "2025-02-01",
            vaultName: "iCloud",
            opLabel: "保留",
            targetLabel: "iCloud",
            detail: "保留在 iCloud",
            tone: "keep",
            removedTags: [],
            retainedTags: ["个人"],
            color: "#C3E88D",
            bg: "rgba(195, 232, 141, 0.08)",
            border: "rgba(195, 232, 141, 0.32)",
        };
    }
});
