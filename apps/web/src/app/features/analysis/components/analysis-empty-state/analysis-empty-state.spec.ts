import { ComponentFixture, TestBed } from "@angular/core/testing";
import { AnalysisEmptyStateComponent } from "./analysis-empty-state";

describe("AnalysisEmptyStateComponent", () => {
    let component: AnalysisEmptyStateComponent;
    let fixture: ComponentFixture<AnalysisEmptyStateComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AnalysisEmptyStateComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(AnalysisEmptyStateComponent);
        component = fixture.componentInstance;
        await fixture.whenStable();
    });

    it("renders the scan guidance", () => {
        expect(fixture.nativeElement.textContent).toContain("先完成一次扫描");
        expect(component).toBeTruthy();
    });
});
