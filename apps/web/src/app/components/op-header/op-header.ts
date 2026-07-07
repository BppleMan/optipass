import { Component, input } from '@angular/core';

@Component({
  selector: 'op-header',
  standalone: true,
  templateUrl: './op-header.html'
})
export class OpHeaderComponent {
  readonly accountChip = input('');
}
