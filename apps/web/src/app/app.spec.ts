import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';
import { routes } from './app.routes';
import { WorkflowService } from './workflow.service';

describe('App', () => {
  const workflow = {
    accountChip: signal(''),
    mutationsEnabled: signal(false),
    mutationToggleBusy: signal(false),
    applying: signal(false),
    groupApplying: signal(false),
    setMutationsEnabled: () => Promise.resolve(),
    loadSession: () => Promise.resolve()
  };

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        { provide: WorkflowService, useValue: workflow }
      ]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('1Password 查重工具');
    expect(compiled.textContent).toContain('试写');
  });

  it('should expose the scan and analysis workflow routes', () => {
    expect(routes.map((route) => route.path)).toEqual([
      'scan',
      'analysis',
      '',
      '**'
    ]);
  });
});
