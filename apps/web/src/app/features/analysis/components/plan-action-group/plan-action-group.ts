import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import type { PreviewGroupView } from '../../../../core/models/workflow.models';
import { VaultIconComponent } from '../../../../shared/ui/vault-icon/vault-icon';

@Component({
  selector: 'op-plan-action-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VaultIconComponent],
  templateUrl: './plan-action-group.html',
  styleUrl: './plan-action-group.scss'
})
export class PlanActionGroupComponent {
  public readonly group = input.required<PreviewGroupView>();
}
