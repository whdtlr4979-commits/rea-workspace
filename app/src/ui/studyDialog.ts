import type { StudyInputs } from '../protocol/messages';
import type { StudySource } from '../model/study';

/** Minimal settings dialog for indicator inputs. Applying sends `modify_study` (spec §8.3.1). */
export function openStudyDialog(study: StudySource, onApply: (inputs: StudyInputs) => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  const dialog = document.createElement('form');
  dialog.className = 'dialog';
  const title = document.createElement('h2');
  title.textContent = study.meta.description;
  dialog.appendChild(title);

  const current = study.getInputs();
  const fields: { id: string; read: () => StudyInputs[string] }[] = [];
  for (const input of study.meta.inputs) {
    const row = document.createElement('label');
    row.className = 'dialog-row';
    row.append(input.name);
    if (input.options) {
      const select = document.createElement('select');
      for (const option of input.options) select.add(new Option(option, option));
      select.value = String(current[input.id]?.v ?? input.defval);
      row.appendChild(select);
      fields.push({ id: input.id, read: () => ({ v: select.value, t: input.type }) });
    } else {
      const field = document.createElement('input');
      field.type = 'number';
      field.step = input.type === 'integer' ? '1' : 'any';
      if (input.min !== undefined) field.min = String(input.min);
      if (input.max !== undefined) field.max = String(input.max);
      field.value = String(current[input.id]?.v ?? input.defval);
      field.required = true;
      row.appendChild(field);
      fields.push({ id: input.id, read: () => ({ v: input.type === 'integer' ? Math.round(Number(field.value)) : Number(field.value), t: input.type }) });
    }
    dialog.appendChild(row);
  }

  const buttons = document.createElement('div');
  buttons.className = 'dialog-buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.textContent = 'Apply';
  ok.className = 'primary';
  buttons.append(cancel, ok);
  dialog.appendChild(buttons);

  const close = () => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    const inputs: StudyInputs = { ...current };
    for (const field of fields) inputs[field.id] = field.read();
    close();
    onApply(inputs);
  });

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  (dialog.querySelector('input, select') as HTMLElement | null)?.focus();
}
