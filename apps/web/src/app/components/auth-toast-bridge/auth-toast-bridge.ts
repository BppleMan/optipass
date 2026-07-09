import { Component, effect, untracked } from '@angular/core';
import { toast } from 'ngx-sonner';
import { WorkflowService } from '../../workflow.service';

const AUTH_TOAST_ID = 'scan-auth-hint';

@Component({
  selector: 'op-auth-toast-bridge',
  standalone: true,
  template: ''
})
export class AuthToastBridgeComponent {
  private lastAuthToastKey = '';

  constructor(readonly wf: WorkflowService) {
    effect(() => {
      const message = this.wf.authHint();
      const state = this.wf.authState();
      const toastKey = `${state}:${message}`;
      if (toastKey === this.lastAuthToastKey) {
        return;
      }
      this.lastAuthToastKey = toastKey;

      // ngx-sonner stores toasts in Angular signals and reads them while updating.
      // Keep that third-party signal store out of this effect's dependency graph.
      untracked(() => this.syncAuthToast(message, state));
    });
  }

  private syncAuthToast(message: string | undefined, state: string): void {
    if (!message) {
      toast.dismiss(AUTH_TOAST_ID);
      return;
    }

    const options = {
      id: AUTH_TOAST_ID,
      duration: state === 'failed' ? 14000 : 10000
    };

    if (state === 'failed') {
      toast.error(message, options);
      return;
    }

    if (state === 'authorizing') {
      toast.warning(message, options);
      return;
    }

    toast.success(message, options);
  }
}
