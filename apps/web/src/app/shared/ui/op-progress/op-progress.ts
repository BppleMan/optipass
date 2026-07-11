import { ChangeDetectionStrategy, Component, input } from "@angular/core";

@Component({
  selector: "op-progress",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./op-progress.html",
  styleUrl: "./op-progress.scss",
})
export class OpProgressComponent {
  public readonly value = input(0);
  public readonly color = input("#F07178");
}
