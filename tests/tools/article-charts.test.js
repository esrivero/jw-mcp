// Charts and tables in WOL articles. Fixtures are trimmed real pages:
// si-study10-chart.html is from "All Scripture Is Inspired of God and Beneficial", Study 10
// (wol.jw.org/en/wol/d/r1/lp-e/1101990137), and it-weights-table.html is from the
// Insight article "Weights and Measures" (wol.jw.org/en/wol/d/r1/lp-e/1200004596).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseArticleHtml } from '../../src/tools/research-tools.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SI = 'https://wol.jw.org/en/wol/d/r1/lp-e/1101990137';
const IT = 'https://wol.jw.org/en/wol/d/r1/lp-e/1200004596';

test('fixed-width chart rows wrapped in a data-pid div keep every line', () => {
  const article = parseArticleHtml(fixture('si-study10-chart.html'), SI);
  const rows = article.paragraphs.filter((paragraph) => paragraph.kind === 'chart');
  assert.deepEqual(
    rows.map((row) => row.source_pid),
    ['91', '92', '93', '94', '95', '96'],
  );
  const tribe = rows.find((row) => row.source_pid === '93');
  assert.equal(
    tribe.text,
    [
      'Gen. 49:10       Born of the tribe of     Matt. 1:2-16;',
      '                 Judah                    Luke 3:23-33;',
      '                                          Heb. 7:14',
    ].join('\n'),
  );
  assert.equal(tribe.source_url, `${SI}#p93`);
  assert.equal(tribe.links.length, 4);
  assert.match(
    tribe.markdown,
    /^\[Gen\. 49:10\]\(https:\/\/wol\.jw\.org\/en\/wol\/bc\/r1\/lp-e\/1101990137\/71\/0\)       Born/,
  );
  const david = rows.find((row) => row.source_pid === '94');
  assert.equal(david.text.split('\n').length, 11);
  assert.match(david.text, /Rom\. 1:3; 15:8, 12$/);
});

test('chart header keeps its column spacing and plain prose is unchanged', () => {
  const article = parseArticleHtml(fixture('si-study10-chart.html'), SI);
  const header = article.paragraphs.find((paragraph) => paragraph.source_pid === '92');
  assert.equal(header.text, 'Prophecy         Event                    Fulfillment');
  const prose = article.paragraphs.find((paragraph) => paragraph.source_pid === '64');
  assert.equal(prose.kind, undefined);
  assert.equal(
    prose.text,
    'c The Historical Evidences of the Truth of the Scripture Records, pages 225, 227-8.',
  );
});

test('HTML table rows come through as one paragraph per row with cells', () => {
  const article = parseArticleHtml(fixture('it-weights-table.html'), IT);
  const rows = article.paragraphs.filter((paragraph) => paragraph.kind === 'table_row');
  assert.equal(rows.length, 6);
  const finger = rows.find((row) => row.source_pid === '8');
  assert.deepEqual(finger.cells, ['1 fingerbreadth', '= 1⁄4 handbreadth', '1.85 cm (0.72 in.)']);
  assert.equal(finger.text, '1 fingerbreadth | = 1⁄4 handbreadth | 1.85 cm (0.72 in.)');
  assert.equal(finger.markdown, '| 1 fingerbreadth | = 1⁄4 handbreadth | 1.85 cm (0.72 in.) |');
  assert.equal(finger.source_url, `${IT}#p8`);
  const shortCubit = rows.find((row) => row.source_pid === '23');
  assert.deepEqual(shortCubit.cells, ['1 short cubit', '', '38 cm (15 in.)']);
  const note = rows.find((row) => row.source_pid === '32');
  assert.match(
    note.markdown,
    /\[2Ch 3:3\]\(https:\/\/wol\.jw\.org\/en\/wol\/bc\/r1\/lp-e\/1200004596\/0\/0\)/,
  );
  assert.equal(note.links[0].type, 'cross_reference');
});

test('paragraphs around a table stay in document order', () => {
  const article = parseArticleHtml(fixture('it-weights-table.html'), IT);
  assert.deepEqual(
    article.paragraphs.map((paragraph) => paragraph.source_pid),
    ['2', '3', '4', '7', '8', '11', '23', '32', '33'],
  );
  assert.equal(article.paragraphs.at(-1).kind, undefined);
  assert.match(article.paragraphs.at(-1).text, /\[xref:Judges 3:16\]/);
});
