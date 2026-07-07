import { Component, EventEmitter, input, Output } from '@angular/core';

@Component({
  selector: 'op-button',
  standalone: true,
  templateUrl: './op-button.html'
})
export class OpButtonComponent {
  readonly label = input('');
  readonly variant = input<'primary' | 'ghost'>('primary');
  readonly size = input<'sm' | 'md'>('md');
  readonly type = input<'button' | 'submit'>('button');
  readonly disabled = input(false);

  @Output() readonly pressed = new EventEmitter<MouseEvent>();
}
