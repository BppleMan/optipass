import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OpProgressComponent } from './op-progress';

describe('OpProgressComponent', () => {
  let component: OpProgressComponent;
  let fixture: ComponentFixture<OpProgressComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OpProgressComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OpProgressComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
