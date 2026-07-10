import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

@Component({
  selector: "op-header",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./op-header.html",
  styleUrl: "./op-header.scss",
})
export class OpHeaderComponent {
  public readonly accountChip = input("");
  public readonly mutationsEnabled = input(false);
  public readonly mutationToggleDisabled = input(false);

  public readonly mutationsEnabledChange = output<boolean>();

  public toggleMutations(): void {
    if (this.mutationToggleDisabled()) {
      return;
    }
    this.mutationsEnabledChange.emit(!this.mutationsEnabled());
  }
}
