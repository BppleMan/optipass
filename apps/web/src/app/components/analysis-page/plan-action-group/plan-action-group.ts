import { Component, input } from '@angular/core';
import type { PreviewGroupView } from '../../../models';
import { VaultIconComponent } from '../../vault-icon/vault-icon';

@Component({
  selector: 'op-plan-action-group',
  standalone: true,
  imports: [VaultIconComponent],
  templateUrl: './plan-action-group.html'
})
export class PlanActionGroupComponent {
  readonly group = input.required<PreviewGroupView>();
}
