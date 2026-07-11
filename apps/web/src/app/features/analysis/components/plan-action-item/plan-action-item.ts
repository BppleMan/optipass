import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import type { PlanActionPreviewView } from "../../../../core/models/workflow.models";
import { DividerComponent } from "../../../../shared/ui/divider/divider";
import { VaultIconComponent } from "../../../../shared/ui/vault-icon/vault-icon";

@Component({
    selector: "op-plan-action-item",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [DividerComponent, VaultIconComponent],
    templateUrl: "./plan-action-item.html",
    styleUrl: "./plan-action-item.scss",
})
export class PlanActionItemComponent {
    public readonly action = input.required<PlanActionPreviewView>();
}
