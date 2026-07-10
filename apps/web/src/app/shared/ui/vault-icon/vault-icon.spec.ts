import { ComponentFixture, TestBed } from '@angular/core/testing';

import { VaultIconComponent } from './vault-icon';

describe('VaultIconComponent', () => {
  let component: VaultIconComponent;
  let fixture: ComponentFixture<VaultIconComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VaultIconComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(VaultIconComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
