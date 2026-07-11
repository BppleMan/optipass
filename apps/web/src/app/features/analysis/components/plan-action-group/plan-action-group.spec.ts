import { ComponentFixture, TestBed } from "@angular/core/testing";

import type { PlanActionPreviewView } from "../../../../core/models/workflow.models";
import { PlanActionGroupComponent } from "./plan-action-group";

describe("PlanActionGroupComponent", () => {
    let component: PlanActionGroupComponent;
    let fixture: ComponentFixture<PlanActionGroupComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [PlanActionGroupComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(PlanActionGroupComponent);
        fixture.componentRef.setInput("actions", actions());
        component = fixture.componentInstance;
        await fixture.whenStable();
    });

    it("summarizes plan changes and destructive actions", () => {
        expect(component.summary()).toEqual({ total: 2, operations: 1, destructive: 1, skipped: 0 });
        expect(fixture.nativeElement.textContent).toContain("2 条执行计划");
        expect(fixture.nativeElement.textContent).toContain("1 项永久删除");
    });

    function actions(): PlanActionPreviewView[] {
        return [
            {
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
            },
            {
                id: "delete:item-2",
                itemId: "item-2",
                title: "旧账号",
                username: "old@example.com",
                url: "https://example.com/old",
                created: "2024-01-01",
                updated: "2024-02-01",
                vaultName: "Private",
                opLabel: "删除",
                targetLabel: "永久删除",
                detail: "从 1Password 永久删除，不进入归档",
                tone: "delete",
                removedTags: [],
                retainedTags: [],
                color: "#FF5370",
                bg: "rgba(255, 83, 112, 0.1)",
                border: "rgba(255, 83, 112, 0.42)",
            },
        ];
    }
});
