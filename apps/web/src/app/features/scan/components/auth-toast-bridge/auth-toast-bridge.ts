import { Component, effect } from '@angular/core';
import { opToast } from '../../../../shared/ui/op-toast/op-toast';
import { WorkflowService } from '../../../analysis/state/workflow.service';
import { AuthState } from '../../../../core/models/workflow.models';

const AUTH_TOAST_ID = 'scan-auth-hint';

@Component({
  selector: 'op-auth-toast-bridge',
  standalone: true,
  template: '',
  styles: [':host { display: none; }']
})
export class AuthToastBridgeComponent {
  private lastAuthToastKey = '';
  private pendingToastKey = '';

  constructor(readonly wf: WorkflowService) {
    effect(() => {
      const message = this.wf.authHint();
      const state = this.wf.authState();
      const toastKey = `${state}:${message}`;
      if (toastKey === this.lastAuthToastKey) {
        return;
      }
      this.lastAuthToastKey = toastKey;
      this.pendingToastKey = toastKey;

      queueMicrotask(() => {
        if (this.pendingToastKey === toastKey) {
          this.syncAuthToast(message ?? '', state);
        }
      });
    });
  }

  private syncAuthToast(message: string, state: AuthState): void {
    if (!message) {
      opToast.dismiss(AUTH_TOAST_ID);
      return;
    }

    const options = {
      id: AUTH_TOAST_ID,
      duration: state === AuthState.Failed ? 14000 : 10000
    };

    if (state === 'failed') {
      opToast.error(message, options);
      return;
    }

    if (state === 'authorizing') {
      opToast.warning(message, options);
      return;
    }

    opToast.success(message, options);
  }
}
