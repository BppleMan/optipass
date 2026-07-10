import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import type { DuplicateGroupView, DuplicateItemView } from "../../../../core/models/workflow.models";
import { AnalysisItemMatrix } from "./analysis-item-matrix";

describe("AnalysisItemMatrix", () => {
    it("renders one aligned card column per item", async () => {
        const group = {
            id: "group-1",
            site: "example.com",
            skipped: false,
            items: [item("item-1"), item("item-2")],
        } as unknown as DuplicateGroupView;
        const fixture = TestBed.createComponent(AnalysisItemMatrix);
        fixture.componentRef.setInput("group", group);
        fixture.componentRef.setInput("decisionItems", []);
        await fixture.whenStable();

        expect(fixture.nativeElement.querySelectorAll("op-analysis-item-card")).toHaveLength(2);
        expect(fixture.nativeElement.querySelector(".field-labels")).toBeNull();
        expect(fixture.nativeElement.querySelector(".matrix-viewport").getAttribute("tabindex")).toBe("0");
    });
});

function item(id: string): DuplicateItemView {
    return {
        id,
        title: id,
        username: id,
        url: `https://example.com/${ id }`,
        category: "login",
        categoryLabel: "登录",
        vaultName: "Private",
        keep: true,
        targetVault: "vault-1",
        removeAction: "archive",
        rowBg: "#292929",
        secretVisible: false,
        credentialSignature: id,
        credChips: [],
        tags: [],
        removedTags: [],
        remainingTagCount: 0,
        detailRows: [],
        vaultOptions: [],
    } as unknown as DuplicateItemView;
}
