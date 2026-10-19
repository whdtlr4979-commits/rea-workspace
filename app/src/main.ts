import { ChartApi } from './api/chartApi';
import { ChartStyle } from './core/types';
import { ChartModel } from './model/chartModel';
import { LocalDrawingStorage } from './drawing/storage';
import { ChartWidget } from './render/chartWidget';
import { MockDataServer } from './server/mockServer';
import { bindDrawingShortcuts, buildDrawingToolbar, buildFloatingToolbar } from './ui/drawingToolbar';
import { openStudyDialog } from './ui/studyDialog';
import { buildFooter, buildHeader } from './ui/toolbar';
import './styles.css';

const server = new MockDataServer({ latencyMs: 30, tickIntervalMs: 1000 });
const api = new ChartApi(server.connect());
const session = api.createChartSession();
const model = new ChartModel(session, {
  ticker: 'MOCK:BTCUSD',
  resolution: 'D',
  style: ChartStyle.Candle,
  drawingStorage: new LocalDrawingStorage(),
});

new ChartWidget(document.getElementById('chart')!, model, {
  editStudy: (study) => openStudyDialog(study, (inputs) => model.modifyStudy(study, inputs)),
  removeStudy: (study) => model.removeStudy(study),
});
buildHeader(document.getElementById('header')!, model);
buildFooter(document.getElementById('footer')!, model);
buildDrawingToolbar(document.getElementById('drawing-toolbar')!, model.drawings);
buildFloatingToolbar(document.getElementById('chart')!, model.drawings);
bindDrawingShortcuts(model.drawings);

model.start();
model.addStudy('Volume');

// Exposed for manual poking in the devtools console.
Object.assign(window, { chartModel: model });
