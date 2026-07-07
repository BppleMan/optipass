import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { WorkflowService } from './workflow.service';

describe('App', () => {
  const workflow = {
    accountChip: signal(''),
    loadSession: () => Promise.resolve()
  };

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
    expect(compiled.textContent).toContain('Optipass');
  });

  it('should expose the three-step workflow routes', () => {
    expect(routes.map((route) => route.path)).toEqual([
      'scan',
      'analysis',
      'preview',
      '',
      '**'
    ]);
  });
});
