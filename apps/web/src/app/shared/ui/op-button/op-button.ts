import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

@Component({
  selector: "op-button",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./op-button.html",
  styleUrl: "./op-button.scss",
})
export class OpButtonComponent {
  public readonly label = input("");
  public readonly variant = input<"primary" | "ghost">("primary");
  public readonly size = input<"sm" | "md">("md");
  public readonly type = input<"button" | "submit">("button");
  public readonly disabled = input(false);

  public readonly pressed = output<MouseEvent>();
}
