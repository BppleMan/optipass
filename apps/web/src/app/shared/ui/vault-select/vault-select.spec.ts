import { ComponentFixture, TestBed } from '@angular/core/testing';

import { VaultSelectComponent } from './vault-select';

describe('VaultSelectComponent', () => {
  let component: VaultSelectComponent;
  let fixture: ComponentFixture<VaultSelectComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VaultSelectComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(VaultSelectComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
