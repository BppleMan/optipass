import { ChangeDetectionStrategy, Component, output } from "@angular/core";
import { OpButtonComponent } from "../../../../shared/ui/op-button/op-button";

@Component({
    selector: "op-analysis-empty-state",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [OpButtonComponent],
    templateUrl: "./analysis-empty-state.html",
    styleUrl: "./analysis-empty-state.scss",
})
export class AnalysisEmptyStateComponent {
    public readonly back = output<void>();
}
