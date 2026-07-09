import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NgxSonnerToaster } from 'ngx-sonner';
import { OpHeaderComponent } from './components/op-header/op-header';
import { WorkflowService } from './workflow.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NgxSonnerToaster, OpHeaderComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  constructor(readonly wf: WorkflowService) {}

  ngOnInit(): void {
    void this.wf.loadSession();
  }
}
