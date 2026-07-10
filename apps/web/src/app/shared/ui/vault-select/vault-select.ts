import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, input, Output, ViewChild } from "@angular/core";
import type { VaultOptionView } from '../../../core/models/workflow.models';
import { VaultIconComponent } from '../vault-icon/vault-icon';

@Component({
  selector: 'op-vault-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VaultIconComponent],
  templateUrl: './vault-select.html',
  styleUrl: './vault-select.scss'
})
export class VaultSelectComponent {
  public readonly options = input<VaultOptionView[]>([]);
  public readonly value = input('');
  public readonly disabled = input(false);
  public readonly ariaLabel = input('选择保险库');

  @Output() readonly valueChange = new EventEmitter<string>();

  public open = false;
  public menuFrame = { top: 0, left: 0, width: 180 };

  @ViewChild('trigger') private readonly trigger?: ElementRef<HTMLButtonElement>;

  public selectedOption(): VaultOptionView | undefined {
    return this.options().find((option) => option.id === this.value()) ?? this.options()[0];
  }

  public toggle(event: MouseEvent): void {
    event.stopPropagation();
    if (this.disabled()) {
      return;
    }
    if (this.open) {
      this.open = false;
      return;
    }

    const rect = this.trigger?.nativeElement.getBoundingClientRect();
    if (rect) {
      const width = Math.max(176, rect.width);
      const menuHeight = Math.min(264, this.options().length * 34 + 10);
      const top = rect.bottom + 6 + menuHeight <= window.innerHeight
        ? rect.bottom + 6
        : Math.max(8, rect.top - menuHeight - 6);
      this.menuFrame = {
        top,
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        width
      };
    }
    this.open = true;
  }

  public choose(option: VaultOptionView, event: MouseEvent): void {
    event.stopPropagation();
    this.valueChange.emit(option.id);
    this.open = false;
  }

  public close(event?: MouseEvent): void {
    event?.stopPropagation();
    this.open = false;
  }
}
