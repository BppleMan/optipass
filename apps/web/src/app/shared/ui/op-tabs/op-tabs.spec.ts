import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OpTabsComponent } from './op-tabs';

describe('OpTabsComponent', () => {
  let component: OpTabsComponent;
  let fixture: ComponentFixture<OpTabsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OpTabsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OpTabsComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
