import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import type { DuplicateGroupView, DuplicateItemView } from "../../../../core/models/workflow.models";
import { AnalysisItemCard } from "./analysis-item-card";

describe("AnalysisItemCard", () => {
    it("renders complete wrapping values and identifies group differences", async () => {
        const firstItem = item("item-1", "https://example.com/a/very/long/path", "alice");
        const secondItem = item("item-2", "https://example.com/short", "bob");
        const group = { id: "group-1", skipped: false, items: [firstItem, secondItem] } as unknown as DuplicateGroupView;
        const fixture = TestBed.createComponent(AnalysisItemCard);
        fixture.componentRef.setInput("group", group);
        fixture.componentRef.setInput("item", firstItem);
        fixture.componentRef.setInput("decisionItems", []);
        await fixture.whenStable();

        expect(fixture.nativeElement.textContent).toContain(firstItem.url);
        expect(fixture.nativeElement.querySelector(".title-row").textContent).toContain(firstItem.title);
        expect(fixture.nativeElement.querySelector(".username-row").textContent).toContain(firstItem.username);
        expect(fixture.nativeElement.querySelectorAll(".field-marker")).toHaveLength(3);
        expect(fixture.nativeElement.querySelector(".username-marker").textContent).toBe("@");
        expect(fixture.nativeElement.querySelector(".url-marker").textContent).toBe("↗");
        expect(fixture.nativeElement.querySelector(".url-row").classList).not.toContain("different");
        expect(fixture.nativeElement.querySelectorAll(".credential-row")).toHaveLength(3);
        expect(fixture.nativeElement.textContent).toContain("密码");
        expect(fixture.nativeElement.textContent).toContain("一次性");
        expect(fixture.nativeElement.textContent).toContain("通行证");
        const rows = Array.from(fixture.nativeElement.children as HTMLCollectionOf<HTMLElement>).map((element) => element.className);
        expect(rows).toEqual([
            "field-row title-row",
            "field-row username-row",
            "field-row url-row",
            "field-row credential-row password-row",
            "field-row credential-row totp-row",
            "field-row credential-row passkey-row",
            "field-row time-row",
            "action-row",
            "field-row vault-row",
            "field-row tag-row",
        ]);
    });

    it("renders removed items with the same disabled vault selector", async () => {
        const removedItem = item("item-1", "https://example.com", "alice");
        removedItem.keep = false;
        const group = { id: "group-1", skipped: false, items: [removedItem] } as unknown as DuplicateGroupView;
        const fixture = TestBed.createComponent(AnalysisItemCard);
        fixture.componentRef.setInput("group", group);
        fixture.componentRef.setInput("item", removedItem);
        fixture.componentRef.setInput("decisionItems", []);
        await fixture.whenStable();

        expect(fixture.nativeElement.querySelector("op-vault-select button").disabled).toBe(true);
        expect(fixture.nativeElement.textContent).not.toContain("当前处置不会更新标签");
    });
});

function item(id: string, url: string, username: string): DuplicateItemView {
    return {
        id,
        title: "Example login",
        username,
        url,
        category: "login",
        categoryLabel: "登录",
        updated: "2026-07-10",
        vaultId: "vault-1",
        vaultName: "Private",
        keep: true,
        notKeep: false,
        targetVault: "vault-1",
        removeAction: "archive",
        rowBg: "#292929",
        secretVisible: false,
        credentialSignature: username,
        credChips: [],
        tags: [],
        removedTags: [],
        remainingTagCount: 0,
        detailRows: [
            { key: "created", label: "创建", value: "2026-01-01" },
            { key: "updated", label: "更新", value: "2026-07-10" },
            { key: "tags", label: "标签", value: "—" },
        ],
        vaultOptions: [],
    } as unknown as DuplicateItemView;
}
