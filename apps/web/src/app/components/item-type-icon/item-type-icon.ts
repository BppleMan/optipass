import { Component, computed, input } from '@angular/core';
import { resolveItemTypeIcon } from '../icon-library';

@Component({
  selector: 'op-item-type-icon',
  standalone: true,
  template: `
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
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
export class ItemTypeIconComponent {
  readonly type = input('other');
  readonly strokeWidth = input(2);

  private readonly resolved = computed(() => resolveItemTypeIcon(this.type()));
  readonly color = computed(() => this.resolved().color);
  readonly definition = computed(() => this.resolved().definition);
}
