import { Component, computed, input } from '@angular/core';
import { toast, type ExternalToast } from 'ngx-sonner';

export enum OpToastTone {
  Success = 'success', Error = 'error', Warning = 'warning', Info = 'info',
}

const toneStyles: Record<OpToastTone, { color: string; border: string; tint: string }> = {
  [OpToastTone.Success]: { color: '#c3e88d', border: 'rgba(195, 232, 141, 0.35)', tint: 'rgba(195, 232, 141, 0.08)' },
  [OpToastTone.Error]: { color: '#f07178', border: 'rgba(240, 113, 120, 0.45)', tint: 'rgba(240, 113, 120, 0.09)' },
  [OpToastTone.Warning]: { color: '#ffcb6b', border: 'rgba(255, 203, 107, 0.4)', tint: 'rgba(255, 203, 107, 0.07)' },
  [OpToastTone.Info]: { color: '#82aaff', border: 'rgba(130, 170, 255, 0.4)', tint: 'rgba(130, 170, 255, 0.08)' }
};

@Component({
  selector: 'op-toast',
  standalone: true,
  template: `
    <div class="op-toast" [style.border-color]="style().border" [style.background-image]="backgroundImage()">
      <span class="op-toast-icon" [style.color]="style().color" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          @switch (tone()) {
            @case ('success') {
              <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.6" />
              <path d="M6.2 10.3 L8.8 12.9 L13.8 7.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            }
            @case ('error') {
              <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.6" />
              <path d="M10 5.6 V11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <circle cx="10" cy="14" r="1.1" fill="currentColor" />
            }
            @case ('warning') {
              <path d="M10 2.8 L18 16.4 H2 Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M10 8 V11.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              <circle cx="10" cy="14" r="1" fill="currentColor" />
            }
            @case ('info') {
              <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.6" />
              <path d="M10 9 V14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <circle cx="10" cy="6" r="1.1" fill="currentColor" />
            }
          }
        </svg>
      </span>
      <span class="op-toast-message" [style.color]="style().color">{{ message() }}</span>
      <button type="button" class="op-toast-close" [style.--toast-accent]="style().color" aria-label="关闭" (click)="dismiss()">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: min(420px, calc(100vw - 32px));
    }

    .op-toast {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 14px 16px;
      border: 1px solid;
      border-radius: 12px;
      background-color: #292929;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }

    .op-toast-icon {
      display: inline-flex;
      flex: 0 0 auto;
    }

    .op-toast-message {
      flex: 1;
      min-width: 0;
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.45;
    }

    .op-toast-close {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      margin-left: 2px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #727272;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .op-toast-close:hover {
      background: #1a1a1a;
      color: var(--toast-accent);
    }
  `]
})
export class OpToastComponent {
  readonly id = input.required<string>();
  readonly tone = input.required<OpToastTone>();
  readonly message = input.required<string>();

  readonly style = computed(() => toneStyles[this.tone()]);
  readonly backgroundImage = computed(() => `linear-gradient(${this.style().tint}, ${this.style().tint})`);

  dismiss(): void {
    toast.dismiss(this.id());
  }
}

function showOpToast(tone: OpToastTone, message: string, options: ExternalToast = {}): string {
  const id = String(options.id ?? crypto.randomUUID());
  toast.custom(OpToastComponent, {
    ...options,
    id,
    closeButton: true,
    unstyled: true,
    componentProps: {
      ...(options.componentProps ?? {}),
      id,
      tone,
      message
    }
  });
  return id;
}

export const opToast = {
  success: (message: string, options?: ExternalToast) => showOpToast(OpToastTone.Success, message, options),
  error: (message: string, options?: ExternalToast) => showOpToast(OpToastTone.Error, message, options),
  warning: (message: string, options?: ExternalToast) => showOpToast(OpToastTone.Warning, message, options),
  info: (message: string, options?: ExternalToast) => showOpToast(OpToastTone.Info, message, options),
  dismiss: (id?: string) => toast.dismiss(id)
};
