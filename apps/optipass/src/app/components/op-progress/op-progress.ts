import { Component, input } from '@angular/core';

@Component({
  selector: 'op-progress',
  standalone: true,
  templateUrl: './op-progress.html'
})
export class OpProgressComponent {
  readonly value = input(0);
  readonly color = input('#f07178');
}
