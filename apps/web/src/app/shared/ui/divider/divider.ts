import { ChangeDetectionStrategy, Component, input } from "@angular/core";

export enum DividerOrientation {
    Horizontal = "horizontal",
    Vertical = "vertical",
}

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
    public readonly orientation = input<DividerOrientation>(DividerOrientation.Horizontal);
}
