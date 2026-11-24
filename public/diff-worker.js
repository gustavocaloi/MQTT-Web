import { diffLines } from '/vendor/diff/index.js';

function format(message) {
  if (!message) return '';
  if (message.payloadFormat === 'json') {
    try { return JSON.stringify(JSON.parse(message.payload), null, 2); } catch {}
  }
  return message.payload;
}
self.onmessage = ({ data }) => {
  const { token, message, previous, view } = data;
  const current = format(message);
  const old = format(previous);
  const compare = view === 'diff' && !!previous;
  const parts = compare ? diffLines(old, current, { timeout: 80, maxEditLength: 2000 }) : [{ value: current }];
  let oldLine = 0, newLine = 0, added = 0, removed = 0;
  const lines = [];
  let note = '';
  if (!parts) note = 'Comparacao extensa demais. Exibindo o payload atual.';
  for (const part of parts || [{ value: current }]) {
    const values = part.value.split('\n');
    if (values.at(-1) === '') values.pop();
    for (const text of values) {
      if (part.added) added++;
      if (part.removed) removed++;
      if (!part.added) oldLine++;
      if (!part.removed) newLine++;
      if (lines.length < 1500) lines.push({ text, kind: part.added ? 'add' : part.removed ? 'remove' : '', old: compare && !part.added ? oldLine : '', current: part.removed ? '' : newLine });
    }
  }
  if (oldLine > 1500 || newLine > 1500) note += ' Preview limitado a 1500 linhas; copiar preserva o payload recebido.';
  if (message.truncated || previous?.truncated) note += ' Comparacao parcial: payload limitado pelo servidor.';
  if (compare && parts && !added && !removed) note = 'Nenhuma alteracao no payload.' + note;
  self.postMessage({ token, lines, note, stats: compare && parts ? '+' + added + ' / -' + removed : '' });
};
