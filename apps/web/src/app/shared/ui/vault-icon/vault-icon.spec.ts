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

  it('uses the requested compact SVG size', async () => {
    fixture.componentRef.setInput('size', 11);
    await fixture.whenStable();

    const icon = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(icon.getAttribute('width')).toBe('11');
    expect(icon.getAttribute('height')).toBe('11');
  });

  it('renders the archive glyph at 10px inside its requested tile size', async () => {
    fixture.componentRef.setInput('name', 'archive');
    fixture.componentRef.setInput('size', 18);
    await fixture.whenStable();

    const icon = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(icon.getAttribute('width')).toBe('10');
    expect(icon.getAttribute('height')).toBe('10');
  });
});
