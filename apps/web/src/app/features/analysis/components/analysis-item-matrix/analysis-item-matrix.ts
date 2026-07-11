import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import type { DuplicateGroupView, DuplicateItemView } from "../../../../core/models/workflow.models";
import type { SegmentedControlItem } from "../../../../shared/ui/segmented-control/segmented-control";
import { AnalysisItemCard, type AnalysisTagScopePrompt } from "../analysis-item-card/analysis-item-card";

export interface AnalysisItemDecisionChange {
    item: DuplicateItemView;
    value: string;
}

export interface AnalysisItemVaultChange {
    itemId: string;
    value: string;
}

export interface AnalysisItemTagRemoval {
    item: DuplicateItemView;
    tag: string;
}

@Component({
    selector: "op-analysis-item-matrix",
    imports: [AnalysisItemCard],
    templateUrl: "./analysis-item-matrix.html",
    styleUrl: "./analysis-item-matrix.scss",
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalysisItemMatrix {
    public readonly group = input.required<DuplicateGroupView>();
    public readonly decisionItems = input.required<SegmentedControlItem[]>();
    public readonly tagPrompt = input<AnalysisTagScopePrompt>();

    public readonly decisionChange = output<AnalysisItemDecisionChange>();
    public readonly vaultChange = output<AnalysisItemVaultChange>();
    public readonly tagRemovalRequested = output<AnalysisItemTagRemoval>();
    public readonly tagScopeApplied = output<"item" | "group">();

}
