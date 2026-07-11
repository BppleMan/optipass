import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

import type { ExecutionPlan } from "@optimize-password/core";
import type { PlanActionPreviewView } from "../../../../core/models/workflow.models";
import { PlanActionItemComponent } from "../plan-action-item/plan-action-item";

@Component({
    selector: "op-plan-action-group",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [PlanActionItemComponent],
    templateUrl: "./plan-action-group.html",
    styleUrl: "./plan-action-group.scss",
})
export class PlanActionGroupComponent {
    public readonly actions = input.required<PlanActionPreviewView[]>();
    public readonly plan = input<ExecutionPlan | undefined>();
    public readonly summary = computed(() => {
        const actions = this.actions();
        return {
            total: actions.length,
            operations: actions.filter((action) => action.tone !== "keep" && action.tone !== "skip").length,
            destructive: actions.filter((action) => action.tone === "delete").length,
            skipped: actions.filter((action) => action.tone === "skip").length,
        };
    });
}
