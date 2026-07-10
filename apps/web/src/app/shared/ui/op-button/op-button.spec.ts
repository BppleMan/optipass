import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OpButtonComponent } from './op-button';

describe('OpButtonComponent', () => {
  let component: OpButtonComponent;
  let fixture: ComponentFixture<OpButtonComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OpButtonComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OpButtonComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
