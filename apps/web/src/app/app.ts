import { ChangeDetectionStrategy, Component, OnInit } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { NgxSonnerToaster } from "ngx-sonner";
import { OpHeaderComponent } from "./shared/ui/op-header/op-header";
import { WorkflowService } from "./features/analysis/state/workflow.service";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, NgxSonnerToaster, OpHeaderComponent],
  templateUrl: "./app.html",
  styleUrl: "./app.scss",
})
export class App implements OnInit {
  public constructor(public readonly wf: WorkflowService) {}

  public ngOnInit(): void {
    void this.wf.loadSession();
  }
}
