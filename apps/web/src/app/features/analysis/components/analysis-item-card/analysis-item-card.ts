import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { CredentialFieldKind, ItemDetailFieldKey, TagRemovalScope, type CredentialChipView, type DuplicateGroupView,
    type DuplicateItemView } from "../../../../core/models/workflow.models";
import { SegmentedControlComponent, type SegmentedControlItem } from "../../../../shared/ui/segmented-control/segmented-control";
import { VaultSelectComponent } from "../../../../shared/ui/vault-select/vault-select";

export interface AnalysisTagScopePrompt {
    itemId: string;
    tag: string;
    eligibleCount: number;
}

@Component({
    selector: "op-analysis-item-card",
    imports: [SegmentedControlComponent, VaultSelectComponent],
    templateUrl: "./analysis-item-card.html",
    styleUrls: ["./analysis-item-card.scss", "./analysis-item-card-tags.scss"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        role: "article",
    },
})
export class AnalysisItemCard {
    protected readonly TagRemovalScope = TagRemovalScope;
    public readonly group = input.required<DuplicateGroupView>();
    public readonly item = input.required<DuplicateItemView>();
    public readonly decisionItems = input.required<SegmentedControlItem[]>();
    public readonly tagPrompt = input<AnalysisTagScopePrompt>();

    public readonly decisionChange = output<string>();
    public readonly vaultChange = output<string>();
    public readonly titleChange = output<string>();
    public readonly tagRemovalRequested = output<string>();
    public readonly tagScopeApplied = output<TagRemovalScope>();

    public commitTitle(event: Event): void {
        const input = event.currentTarget as HTMLInputElement;
        const title = input.value.trim();
        if (!title) {
            input.value = this.item().title;
            return;
        }
        input.value = title;
        this.titleChange.emit(title);
    }

    public readonly decisionValue = computed(() => {
        const item = this.item();
        return item.keep ? "keep" : item.removeAction;
    });

    public credentialSlots(): AnalysisCredentialSlot[] {
        const chips = this.item().credChips;
        return [
            credentialSlot(AnalysisCredentialSlotKind.Password, "密码", chips, [CredentialFieldKind.Password, CredentialFieldKind.Secret]),
            credentialSlot(AnalysisCredentialSlotKind.Totp, "一次性", chips, [CredentialFieldKind.Totp]),
            credentialSlot(AnalysisCredentialSlotKind.Passkey, "通行证", chips, [CredentialFieldKind.Passkey]),
        ];
    }

    public detailTimeParts(): string[] {
        const item = this.item();
        return [detailRowValue(item, ItemDetailFieldKey.Created), detailRowValue(item, ItemDetailFieldKey.Updated)];
    }

    public tagSharedAcrossGroup(tag: string): boolean {
        const group = this.group();
        return group.items.length > 1 && group.items.every((item) => item.tags.includes(tag));
    }

    public tagPromptVisible(tag: string): boolean {
        const prompt = this.tagPrompt();
        return prompt?.itemId === this.item().id && prompt.tag === tag;
    }
}

enum AnalysisCredentialSlotKind {
    Password = "password",
    Totp = "totp",
    Passkey = "passkey",
}

interface AnalysisCredentialSlot {
    kind: AnalysisCredentialSlotKind;
    label: string;
    text: string;
    empty: boolean;
}

function credentialSlot(
    kind: AnalysisCredentialSlot["kind"],
    label: string,
    chips: CredentialChipView[],
    matchingKinds: CredentialChipView["kind"][],
): AnalysisCredentialSlot {
    const chip = chips.find((candidate) => matchingKinds.includes(candidate.kind));
    return {
        kind,
        label,
        text: chip?.text ?? "空",
        empty: !chip || chip.kind === "missing",
    };
}

function detailRowValue(item: DuplicateItemView, key: ItemDetailFieldKey): string {
    return item.detailRows.find((row) => row.key === key)?.value || "—";
}
