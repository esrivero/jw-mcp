import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handleMedicalLibraryTool,
  libraryUrl,
  parseMedicalLibraryHtml,
  resolveLibraryLink,
} from '../../src/tools/medical-library-tool.js';
import { setFetchForTesting } from '../../src/tools/fetch-cache.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ROOT = 'https://www.jw.org/en/medical-library/';
const SECTION = `${ROOT}bloodless-surgery-medicine/`;
const CARDIO = `${SECTION}cardio/`;
const HEMOST = `${CARDIO}cardio-Hemost/`;
const EVAL = `${CARDIO}cardio-PatientEval/`;

function fakeSite(pages, calls = []) {
  return async (url) => {
    calls.push(url);
    const body = pages[url];
    return {
      status: body === undefined ? 404 : 200,
      statusText: body === undefined ? 'Not Found' : 'OK',
      ok: body !== undefined,
      text: async () => body ?? 'not found',
    };
  };
}

afterEach(() => setFetchForTesting(null));

test('paths and URLs are normalized and limited to jw.org', () => {
  assert.equal(libraryUrl(), ROOT);
  assert.equal(libraryUrl('bloodless-surgery-medicine/cardio'), CARDIO);
  assert.equal(libraryUrl('/en/medical-library/bloodless-surgery-medicine/'), SECTION);
  assert.equal(libraryUrl('https://jw.org/en/medical-library/videos/#top'), `${ROOT}videos/`);
  assert.throws(() => libraryUrl('https://evil.example/en/medical-library/'), /Only https:\/\/www\.jw\.org/);
  assert.throws(() => libraryUrl('http://www.jw.org/en/medical-library/'), /Only https/);
});

test('links written without a leading slash resolve from the site root', () => {
  assert.equal(
    resolveLibraryLink('en/medical-library/bloodless-surgery-medicine/cardio/cardio-Hemost/', CARDIO),
    HEMOST,
  );
  assert.equal(resolveLibraryLink('/en/medical-library/videos/', CARDIO), `${ROOT}videos/`);
  assert.equal(
    resolveLibraryLink('https://pubmed.ncbi.nlm.nih.gov/41873655/', ROOT),
    'https://pubmed.ncbi.nlm.nih.gov/41873655/',
  );
});

test('home page: featured citations, the five sections with descriptions, and videos', () => {
  const page = parseMedicalLibraryHtml(fixture('medlib-root.html'), ROOT);
  assert.equal(page.citations.length, 2);
  assert.deepEqual(page.citations[0], {
    id: 'externalArticle-3721',
    title:
      'Impact of priming volume reduction on hematocrit retention in pediatric cardiopulmonary bypass: a retrospective analysis.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/41873655/',
    authors:
      'Hibino T, Okui Y, Toba Y, Kondo S, Ikegami H, Suzuki K, Ogura F, Masui H, Kitamoto N, Koide M, Yamazaki T',
    source: 'Paediatr Anaesth 2026;36(6):703-13.',
  });
  const titles = page.pages.map((p) => p.title);
  for (const name of [
    'Medicine and Surgery',
    'Pediatrics',
    'Diseases and Conditions',
    'Bioethics and Law',
    'Cost-Effectiveness',
  ]) {
    assert.ok(titles.includes(name), name);
  }
  assert.ok(!titles.includes('See More'));
  assert.match(page.pages.find((p) => p.title === 'Pediatrics').description, /neonatal and pediatric/);
  assert.equal(page.videos[0].url, `${ROOT}videos/blood-transfusion-alternative-strategies/`);
});

test('specialty page lists strategies, with sub-strategy anchors pointing at their parent page', () => {
  const page = parseMedicalLibraryHtml(fixture('medlib-specialty-cardio.html'), CARDIO);
  assert.equal(page.title, 'Cardiothoracic and Vascular Surgery');
  assert.equal(page.parent, 'Medicine and Surgery');
  assert.equal(page.pages.length, 8);
  assert.deepEqual(page.pages[0], {
    title: 'Preoperative Patient Evaluation and Transfusion Risk Assessment',
    url: EVAL,
  });
  const antifib = page.pages.find((p) => p.title === 'Antifibrinolytic Agents');
  assert.equal(antifib.url, `${HEMOST}#cardio-Hemost-Antifib`);
  assert.equal(antifib.parent_url, HEMOST);
});

test('strategy page citations carry their subheading and an anchor link to it', () => {
  const page = parseMedicalLibraryHtml(fixture('medlib-strategy-hemost.html'), HEMOST);
  assert.equal(page.citations.length, 4);
  const first = page.citations[0];
  assert.equal(first.section, 'Antifibrinolytic Agents');
  assert.equal(first.section_url, `${HEMOST}#cardio-Hemost-Antifib`);
  assert.equal(first.source, 'Can J Anaesth 2009;56(3):202-12.');
  assert.doesNotMatch(first.title, /opens new window/);
  assert.equal(page.citations[3].section, 'Recombinant Activated Factor VII (rFVIIa)');
});

test('information packet page exposes its download link', () => {
  const url = `${ROOT}medical-information/hematology/`;
  const page = parseMedicalLibraryHtml(fixture('medlib-packet-hematology.html'), url);
  assert.equal(page.title, 'Hematology');
  assert.equal(page.downloads.length, 1);
  assert.match(page.downloads[0].url, /GETPUBMEDIALINKS\?docid=1013837/);
  assert.match(page.description, /Download a packet/);
});

test('get_medical_library filters one page by query', async () => {
  setFetchForTesting(fakeSite({ [HEMOST]: fixture('medlib-strategy-hemost.html') }));
  const response = await handleMedicalLibraryTool({
    params: {
      name: 'get_medical_library',
      arguments: { path: 'bloodless-surgery-medicine/cardio/cardio-Hemost/', query: 'tranexamic' },
    },
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.citation_count, 4);
  assert.equal(data.returned_count, 1);
  assert.match(data.citations[0].title, /tranexamic acid/);
});

test('search walks child pages, stays in the library, and dedupes', async () => {
  const calls = [];
  setFetchForTesting(
    fakeSite(
      {
        [CARDIO]: fixture('medlib-specialty-cardio.html'),
        [HEMOST]: fixture('medlib-strategy-hemost.html'),
        [EVAL]: fixture('medlib-strategy-hemost.html'), // same citations again
      },
      calls,
    ),
  );
  const response = await handleMedicalLibraryTool({
    params: {
      name: 'get_medical_library',
      arguments: { path: CARDIO, query: 'factor VII', search: true, format: 'json' },
    },
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.pages_scanned, 3);
  assert.equal(data.result_count, 2);
  assert.ok(data.citations.every((c) => /factor VII/i.test(c.title)));
  assert.equal(new Set(calls).size, calls.length, 'no page fetched twice');
  assert.ok(calls.every((u) => u.startsWith(ROOT)));
});

test('search respects max_pages and reports what it skipped', async () => {
  setFetchForTesting(
    fakeSite({
      [CARDIO]: fixture('medlib-specialty-cardio.html'),
      [HEMOST]: fixture('medlib-strategy-hemost.html'),
    }),
  );
  const response = await handleMedicalLibraryTool({
    params: {
      name: 'get_medical_library',
      arguments: { path: CARDIO, query: 'acid', search: true, max_pages: 1 },
    },
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.pages_scanned, 1);
  assert.equal(data.pages_not_scanned, 2);
});

test('markdown output groups citations under their subheadings', async () => {
  setFetchForTesting(fakeSite({ [HEMOST]: fixture('medlib-strategy-hemost.html') }));
  const response = await handleMedicalLibraryTool({
    params: { name: 'get_medical_library', arguments: { path: HEMOST, format: 'markdown' } },
  });
  const text = response.content[0].text;
  assert.match(text, /### Antifibrinolytic Agents/);
  assert.match(text, /Source: Heart Lung Circ 2012;21\(11\):706-10\./);
});

test('bad input returns tool errors', async () => {
  for (const args of [{ search: true }, { path: 'https://evil.example/x/y/' }, { format: 'xml' }]) {
    const response = await handleMedicalLibraryTool({
      params: { name: 'get_medical_library', arguments: args },
    });
    assert.equal(response.isError, true, JSON.stringify(args));
  }
  assert.equal(await handleMedicalLibraryTool({ params: { name: 'other', arguments: {} } }), null);
});
