import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

type DryRunSpeedMultiplier = 1 | 5 | 10;

@Component({
    selector: "op-header",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: "./op-header.html",
    styleUrl: "./op-header.scss",
})
export class OpHeaderComponent {
    public readonly accountChip = input("");
    public readonly dryRunSpeedMultiplier = input<DryRunSpeedMultiplier>(1);
    public readonly dryRunSpeedDisabled = input(false);
    public readonly mutationsEnabled = input(false);
    public readonly mutationToggleDisabled = input(false);

    public readonly dryRunSpeedOptions: readonly DryRunSpeedMultiplier[] = [1, 5, 10];
    public readonly dryRunSpeedMultiplierChange = output<DryRunSpeedMultiplier>();
    public readonly mutationsEnabledChange = output<boolean>();

    public selectDryRunSpeed(multiplier: DryRunSpeedMultiplier): void {
        if (this.dryRunSpeedDisabled()) {
            return;
        }
        this.dryRunSpeedMultiplierChange.emit(multiplier);
    }

    public toggleMutations(): void {
        if (this.mutationToggleDisabled()) {
            return;
        }
        this.mutationsEnabledChange.emit(!this.mutationsEnabled());
    }
}
