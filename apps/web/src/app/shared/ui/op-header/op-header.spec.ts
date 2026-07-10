import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OpHeaderComponent } from './op-header';

describe('OpHeaderComponent', () => {
  let component: OpHeaderComponent;
  let fixture: ComponentFixture<OpHeaderComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OpHeaderComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OpHeaderComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
