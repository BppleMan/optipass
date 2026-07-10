import { Routes } from '@angular/router';
import { ScanPageComponent } from '../features/scan/scan.page';
import { AnalysisPageComponent } from '../features/analysis/analysis.page';

export const routes: Routes = [
  { path: 'scan', component: ScanPageComponent },
  { path: 'analysis', component: AnalysisPageComponent },
  { path: '', pathMatch: 'full', redirectTo: 'scan' },
  { path: '**', redirectTo: 'scan' }
];
