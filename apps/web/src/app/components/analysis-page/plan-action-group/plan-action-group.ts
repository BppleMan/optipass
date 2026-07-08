import { Component, input } from '@angular/core';
import type { PreviewGroupView } from '../../../models';

@Component({
  selector: 'op-plan-action-group',
  standalone: true,
  templateUrl: './plan-action-group.html'
})
export class PlanActionGroupComponent {
  readonly group = input.required<PreviewGroupView>();
}
