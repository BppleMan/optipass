import { Routes } from '@angular/router';
import { ScanPageComponent } from './components/scan-page/scan-page';
import { AnalysisPageComponent } from './components/analysis-page/analysis-page';

export const routes: Routes = [
  { path: 'scan', component: ScanPageComponent },
  { path: 'analysis', component: AnalysisPageComponent },
  { path: '', pathMatch: 'full', redirectTo: 'scan' },
  { path: '**', redirectTo: 'scan' }
];
