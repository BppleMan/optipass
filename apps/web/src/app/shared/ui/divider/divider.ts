import { ChangeDetectionStrategy, Component, input } from "@angular/core";

@Component({
    selector: "op-divider",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [],
    host: {
        role: "separator",
        "[attr.aria-orientation]": "orientation()",
    },
    templateUrl: "./divider.html",
    styleUrl: "./divider.scss",
})
export class DividerComponent {
    public readonly orientation = input<"horizontal" | "vertical">("horizontal");
}
