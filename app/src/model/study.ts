import type { ChartSession, SourceEvent } from '../api/chartApi';
import type { StudyInputs } from '../protocol/messages';
import { PlotList } from './plotList';
import type { MainSeries } from './series';
import type { StudyMeta } from './studyMeta';

export type StudyStatus = 'creating' | 'loading' | 'ready' | 'error' | 'removed';

function randomStudyId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

/**
 * Client view of a server-computed indicator (spec §8.1). It holds plot rows only;
 * `modify` resends every input with a new turnaround, `remove` waits for `study_deleted`.
 */
export class StudySource {
  readonly id = randomStudyId();
  readonly data = new PlotList();
  private status: StudyStatus = 'creating';
  private turnaroundCounter = 1;
  private dataTurnaround: string | null = null;
  private errorMessage = '';

  constructor(
    readonly meta: StudyMeta,
    private inputs: StudyInputs,
    private readonly session: ChartSession,
    private readonly series: MainSeries,
    private readonly onChange: () => void,
  ) {}

  getInputs(): StudyInputs {
    return this.inputs;
  }

  getStatus(): StudyStatus {
    return this.status;
  }

  getError(): string {
    return this.errorMessage;
  }

  private turnaround(): string {
    return `st${this.turnaroundCounter}`;
  }

  /** Server replies use `<series turnaround>_<study turnaround>` (spec §6.5). */
  private expectedTurnaround(): string {
    return `${this.series.turnaround()}_${this.turnaround()}`;
  }

  create(): void {
    this.session.createStudy(this.id, this.turnaround(), this.series.id, this.meta.wireName, this.inputs, (e) => this.onEvent(e));
  }

  modify(inputs: StudyInputs): void {
    this.inputs = inputs;
    this.turnaroundCounter++;
    this.status = 'loading';
    this.session.modifyStudy(this.id, this.turnaround(), inputs);
    this.onChange();
  }

  remove(): void {
    this.status = 'removed';
    this.session.removeStudy(this.id);
  }

  private onEvent(event: SourceEvent): void {
    if (this.status === 'removed' && event.kind !== 'deleted') return;
    if (event.kind !== 'deleted' && event.turnaround !== this.expectedTurnaround()) return;
    switch (event.kind) {
      case 'loading':
        this.status = 'loading';
        break;
      case 'data':
        if (this.dataTurnaround !== event.turnaround) {
          this.data.clear();
          this.dataTurnaround = event.turnaround;
        }
        this.data.merge(event.rows);
        break;
      case 'completed':
        this.status = 'ready';
        break;
      case 'error':
        this.status = 'error';
        this.errorMessage = event.message;
        break;
      case 'deleted':
        this.status = 'removed';
        break;
    }
    this.onChange();
  }
}
