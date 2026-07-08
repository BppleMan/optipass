import { Component, EventEmitter, input, Output } from '@angular/core';

@Component({
  selector: 'op-header',
  standalone: true,
  templateUrl: './op-header.html'
})
export class OpHeaderComponent {
  readonly accountChip = input('');
  readonly mutationsEnabled = input(false);
  readonly mutationToggleDisabled = input(false);

  @Output() readonly mutationsEnabledChange = new EventEmitter<boolean>();

  toggleMutations(): void {
    if (this.mutationToggleDisabled()) {
      return;
    }
    this.mutationsEnabledChange.emit(!this.mutationsEnabled());
  }
}
