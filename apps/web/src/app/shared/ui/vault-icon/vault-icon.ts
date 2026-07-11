import { Component, HostBinding, computed, input } from '@angular/core';
import { hexToRgb, resolveVaultIcon } from '../../library/icon-library';

@Component({
  selector: 'op-vault-icon',
  standalone: true,
  template: `
    <svg [attr.width]="glyphSize()" [attr.height]="glyphSize()" viewBox="0 0 24 24" aria-hidden="true">
      @for (shape of definition().shapes; track $index) {
        @switch (shape.kind) {
          @case ('circle') {
            <circle
              [attr.cx]="shape.cx"
              [attr.cy]="shape.cy"
              [attr.r]="shape.r"
              [attr.fill]="shape.fill ? color() : 'none'"
              [attr.stroke]="shape.fill ? 'none' : color()"
              [attr.stroke-width]="shape.fill ? null : strokeWidth()"
              [attr.stroke-dasharray]="shape.dash ?? null"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          }
          @case ('ellipse') {
            <ellipse
              [attr.cx]="shape.cx"
              [attr.cy]="shape.cy"
              [attr.rx]="shape.rx"
              [attr.ry]="shape.ry"
              [attr.fill]="shape.fill ? color() : 'none'"
              [attr.stroke]="shape.fill ? 'none' : color()"
              [attr.stroke-width]="shape.fill ? null : strokeWidth()"
              [attr.stroke-dasharray]="shape.dash ?? null"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          }
          @case ('rect') {
            <rect
              [attr.x]="shape.x"
              [attr.y]="shape.y"
              [attr.width]="shape.width"
              [attr.height]="shape.height"
              [attr.rx]="shape.rx"
              [attr.fill]="shape.fill ? color() : 'none'"
              [attr.stroke]="shape.fill ? 'none' : color()"
              [attr.stroke-width]="shape.fill ? null : strokeWidth()"
              [attr.stroke-dasharray]="shape.dash ?? null"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          }
          @case ('path') {
            <path
              [attr.d]="shape.d"
              [attr.fill]="shape.fill ? color() : 'none'"
              [attr.stroke]="shape.fill ? 'none' : color()"
              [attr.stroke-width]="shape.fill ? null : strokeWidth()"
              [attr.stroke-dasharray]="shape.dash ?? null"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          }
        }
      }
    </svg>
  `
})
export class VaultIconComponent {
  readonly name = input('');
  readonly index = input(0);
  readonly size = input(20);
  readonly strokeWidth = input(2);

  private readonly resolved = computed(() => resolveVaultIcon(this.name(), this.index()));
  readonly color = computed(() => this.resolved().color);
  readonly definition = computed(() => this.resolved().definition);
  readonly glyphSize = computed(() => this.definition().name === 'archive' ? Math.min(this.size(), 10) : this.size());

  @HostBinding('style.background')
  get tileBackground(): string {
    return `linear-gradient(rgba(${hexToRgb(this.color())}, 0.1), rgba(${hexToRgb(this.color())}, 0.1)), #323232`;
  }
}
