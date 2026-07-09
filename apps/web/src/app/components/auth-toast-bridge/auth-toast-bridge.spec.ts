import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { toastState } from 'ngx-sonner';
import { AuthToastBridgeComponent } from './auth-toast-bridge';
import { WorkflowService } from '../../workflow.service';

describe('AuthToastBridgeComponent', () => {
  const authHint = signal('');
  const authState = signal('idle');

  beforeEach(async () => {
    toastState.reset();
    authHint.set('');
    authState.set('idle');

    await TestBed.configureTestingModule({
      imports: [AuthToastBridgeComponent],
      providers: [
        {
          provide: WorkflowService,
          useValue: {
            authHint,
            authState
          }
        }
      ]
    }).compileComponents();
  });

  afterEach(() => {
    toastState.reset();
  });

  it('does not subscribe the auth effect to the toast store', async () => {
    const fixture = TestBed.createComponent(AuthToastBridgeComponent);
    fixture.detectChanges();
    await Promise.resolve();

    authState.set('authorized');
    authHint.set('✓ 授权成功 · 已连接 9 个 vault，正在扫描');
    fixture.detectChanges();
    await Promise.resolve();

    expect(toastState.toasts()).toHaveLength(1);
    expect(toastState.toasts()[0]?.componentProps).toEqual(expect.objectContaining({
      id: 'scan-auth-hint',
      tone: 'success'
    }));

    toastState.dismiss('scan-auth-hint');
    fixture.detectChanges();

    expect(toastState.toasts()).toHaveLength(0);
  });
});
