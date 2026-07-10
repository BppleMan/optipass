import { ComponentFixture, TestBed } from "@angular/core/testing";

import type { PreviewGroupView } from "../../../../core/models/workflow.models";
import { PlanActionGroupComponent } from "./plan-action-group";

describe('PlanActionGroupComponent', () => {
    let component: PlanActionGroupComponent;
    let fixture: ComponentFixture<PlanActionGroupComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [PlanActionGroupComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(PlanActionGroupComponent);
        fixture.componentRef.setInput("group", { actions: [] } as unknown as PreviewGroupView);
        component = fixture.componentInstance;
        await fixture.whenStable();
    });

    it("should create", () => {
        expect(component).toBeTruthy();
    });
});
