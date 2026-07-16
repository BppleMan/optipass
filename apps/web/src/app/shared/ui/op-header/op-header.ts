import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { DryRunSpeedMultiplier } from "@optimize-password/core";
import { AuthState } from "../../../core/models/workflow.models";

@Component({
    selector: "op-header",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: "./op-header.html",
    styleUrl: "./op-header.scss",
})
export class OpHeaderComponent {
    protected readonly AuthState = AuthState;
    public readonly accountChip = input("");
    public readonly accountAuthorizationState = input(AuthState.Idle, { transform: authState });
    public readonly dryRunSpeedMultiplier = input<DryRunSpeedMultiplier>(DryRunSpeedMultiplier.One);
    public readonly dryRunSpeedDisabled = input(false);
    public readonly mutationsEnabled = input(false);
    public readonly mutationToggleDisabled = input(false);

    public readonly dryRunSpeedOptions: readonly DryRunSpeedMultiplier[] = [
        DryRunSpeedMultiplier.One,
        DryRunSpeedMultiplier.Five,
        DryRunSpeedMultiplier.Ten,
    ];
    public readonly dryRunSpeedMultiplierChange = output<DryRunSpeedMultiplier>();
    public readonly mutationsEnabledChange = output<boolean>();

    public readonly accountAuthorizationLabel = computed(() => {
        switch (this.accountAuthorizationState()) {
            case AuthState.Authorizing:
                return "正在授权的 1Password 账户";
            case AuthState.Authorized:
                return "已授权的 1Password 账户";
            case AuthState.Failed:
                return "授权失败的 1Password 账户";
            default:
                return "尚未授权的 1Password 账户";
        }
    });

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

function authState(value: unknown): AuthState {
    if (value === AuthState.Authorizing) return AuthState.Authorizing;
    if (value === AuthState.Authorized) return AuthState.Authorized;
    if (value === AuthState.Failed) return AuthState.Failed;
    return AuthState.Idle;
}
