import { Component, HostBinding, computed, input } from '@angular/core';

type IconShape =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean; dash?: string }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { kind: 'path'; d: string; fill?: boolean; dash?: string };

interface VaultIconDefinition {
  shapes: IconShape[];
}

const accentColors = ['#f07178', '#82aaff', '#c3e88d', '#ffcb6b', '#c792ea', '#89ddff'];
const iconDefinitions: VaultIconDefinition[] = [
  { shapes: [{ kind: 'circle', cx: 12, cy: 12, r: 7 }] },
  { shapes: [{ kind: 'path', d: 'M12 5 L19 18 L5 18 Z' }] },
  { shapes: [{ kind: 'rect', x: 6, y: 6, width: 12, height: 12, rx: 2 }] },
  { shapes: [{ kind: 'path', d: 'M12 4 L20 12 L12 20 L4 12 Z' }] },
  { shapes: [{ kind: 'path', d: 'M12 4 L18.9 8 L18.9 16 L12 20 L5.1 16 L5.1 8 Z' }] },
  { shapes: [{ kind: 'circle', cx: 9.5, cy: 12, r: 5.5 }, { kind: 'circle', cx: 14.5, cy: 12, r: 5.5 }] },
  { shapes: [{ kind: 'path', d: 'M4 9 Q8 5 12 9 T20 9' }, { kind: 'path', d: 'M4 15 Q8 11 12 15 T20 15' }] },
  { shapes: [{ kind: 'path', d: 'M9 4 V20 M15 4 V20 M4 9 H20 M4 15 H20' }] },
  { shapes: [{ kind: 'path', d: 'M5 17 A 9 9 0 0 1 19 17' }, { kind: 'circle', cx: 12, cy: 17, r: 1.6, fill: true }] },
  { shapes: [{ kind: 'path', d: 'M12 5 V19 M5 12 H19' }] },
  { shapes: [{ kind: 'path', d: 'M12 5 V19 M6 8.5 L18 15.5 M18 8.5 L6 15.5' }] },
  { shapes: [{ kind: 'circle', cx: 12, cy: 12, r: 7 }, { kind: 'path', d: 'M12 5 A 7 7 0 0 1 12 19 Z', fill: true }] },
  { shapes: [{ kind: 'path', d: 'M5 8 H19 M5 12 H19 M5 16 H19' }] },
  { shapes: [{ kind: 'circle', cx: 12, cy: 12, r: 4 }, { kind: 'circle', cx: 12, cy: 12, r: 8.5, dash: '3.2 3.6' }] },
  { shapes: [{ kind: 'path', d: 'M5 18 V13 H10 V8 H15 V5 H19' }] },
  {
    shapes: [
      { kind: 'circle', cx: 7, cy: 7, r: 1.8, fill: true },
      { kind: 'circle', cx: 7, cy: 17, r: 1.8, fill: true },
      { kind: 'circle', cx: 12, cy: 12, r: 1.8, fill: true },
      { kind: 'circle', cx: 17, cy: 7, r: 1.8, fill: true },
      { kind: 'circle', cx: 17, cy: 17, r: 1.8, fill: true }
    ]
  },
  { shapes: [{ kind: 'path', d: 'M13 4 L6.5 13.5 H11.5 L11 20 L17.5 10.5 H12.5 Z' }] },
  { shapes: [{ kind: 'path', d: 'M16.5 14.5 A 7 7 0 1 1 9.5 5.5 A 5.6 5.6 0 0 0 16.5 14.5 Z' }] },
  { shapes: [{ kind: 'circle', cx: 12, cy: 12, r: 7.5 }, { kind: 'circle', cx: 12, cy: 12, r: 2.6, fill: true }] },
  { shapes: [{ kind: 'path', d: 'M12 12 m0 -1.5 a1.5 1.5 0 0 1 1.5 1.5 a3 3 0 0 1 -3 3 a4.8 4.8 0 0 1 -4.8 -4.8 a6.8 6.8 0 0 1 6.8 -6.8 a8.4 8.4 0 0 1 8.4 8.4' }] }
];

function normalizeIndex(index: number, size: number): number {
  return ((Math.trunc(index) % size) + size) % size;
}

function hexToRgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
}

@Component({
  selector: 'op-vault-icon',
  standalone: true,
  template: `
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
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
          @case ('rect') {
            <rect
              [attr.x]="shape.x"
              [attr.y]="shape.y"
              [attr.width]="shape.width"
              [attr.height]="shape.height"
              [attr.rx]="shape.rx"
              fill="none"
              [attr.stroke]="color()"
              [attr.stroke-width]="strokeWidth()"
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
  readonly index = input(0);
  readonly strokeWidth = input(2);

  readonly color = computed(() => accentColors[normalizeIndex(this.index(), accentColors.length)]);
  readonly definition = computed(() => iconDefinitions[normalizeIndex(this.index(), iconDefinitions.length)]);

  @HostBinding('style.background')
  get tileBackground(): string {
    return `linear-gradient(rgba(${hexToRgb(this.color())}, 0.1), rgba(${hexToRgb(this.color())}, 0.1)), #323232`;
  }
}
