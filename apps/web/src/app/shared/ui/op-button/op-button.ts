import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

export enum OpButtonVariant {
  Primary = "primary", Ghost = "ghost",
}

export enum OpButtonSize {
  Small = "sm", Medium = "md",
}

export enum OpButtonType {
  Button = "button", Submit = "submit",
}

@Component({
  selector: "op-button",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./op-button.html",
  styleUrl: "./op-button.scss",
})
export class OpButtonComponent {
  public readonly label = input("");
  public readonly variant = input(OpButtonVariant.Primary, { transform: opButtonVariant });
  public readonly size = input(OpButtonSize.Medium, { transform: opButtonSize });
  public readonly type = input(OpButtonType.Button, { transform: opButtonType });
  public readonly disabled = input(false);

  public readonly pressed = output<MouseEvent>();
}

function opButtonVariant(value: unknown): OpButtonVariant {
  return value === OpButtonVariant.Ghost ? OpButtonVariant.Ghost : OpButtonVariant.Primary;
}

function opButtonSize(value: unknown): OpButtonSize {
  return value === OpButtonSize.Small ? OpButtonSize.Small : OpButtonSize.Medium;
}

function opButtonType(value: unknown): OpButtonType {
  return value === OpButtonType.Submit ? OpButtonType.Submit : OpButtonType.Button;
}
