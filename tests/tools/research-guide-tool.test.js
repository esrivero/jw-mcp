import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handleResearchGuideTool,
  parseIndexEdition,
  parseIndexTopicHtml,
  parseResearchGuideTopicHtml,
  parseTopicListHtml,
  rankTopics,
  scoreTopic,
} from '../../src/tools/research-guide-tool.js';
import { setFetchForTesting } from '../../src/tools/fetch-cache.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const RSG = 'https://wol.jw.org/en/wol/publication/r1/lp-e/rsg';
const INDEX = 'https://wol.jw.org/en/wol/library/r1/lp-e/all-publications/index/publications-index';
const INDEX_LANDING = `<html><body><article id="article">
  <a href="/en/wol/library/r1/lp-e/all-publications/index/publications-index/introduction">Introduction</a>
  <a href="/en/wol/library/r1/lp-e/all-publications/index/publications-index/index-1986-2026">Index 1986-2026</a>
  <a href="/en/wol/library/r1/lp-e/all-publications/index/publications-index/index-1930-1985">Index 1930-1985</a>
</article></body></html>`;

function fakeSite(pages, calls = []) {
  return async (url) => {
    calls.push(url);
    const body = pages[url];
    return {
      status: body === undefined ? 404 : 200,
      statusText: body === undefined ? 'Not Found' : 'OK',
      ok: body !== undefined,
      text: async () => body ?? 'not found',
      json: async () => JSON.parse(body),
    };
  };
}

afterEach(() => setFetchForTesting(null));

test('topic list parser reads letter pages and topic cards', () => {
  const { pageLinks, topics } = parseTopicListHtml(fixture('rsg-toc-b.html'));
  assert.equal(pageLinks.length, 5);
  assert.deepEqual(pageLinks[2], { title: 'B', url: `${RSG}/98` });
  assert.equal(topics.length, 5);
  assert.deepEqual(topics[0], { title: 'Baal', url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1200030011' });
  assert.equal(topics[1].title, 'Baasha (King of Israel)');
});

test('index letter page cards without navCard class are still read', () => {
  const { topics } = parseTopicListHtml(fixture('dx-toc-m.html'));
  assert.deepEqual(
    topics.map((t) => t.title),
    [
      'Maacah (Aram-maacah)',
      'Maacah (Wife of Rehoboam)',
      'Medical Directives',
      'Medical Science',
      'Medical Treatment',
      'Medicine',
    ],
  );
});

test('scoring prefers exact titles, folds plurals and ignores parenthetical qualifiers', () => {
  assert.equal(scoreTopic('Baal', 'Baal'), 100);
  assert.equal(scoreTopic('baby', 'Babies'), 100);
  assert.equal(scoreTopic('Baasha', 'Baasha (King of Israel)'), 95);
  assert.ok(scoreTopic('medical', 'Medical Treatment') > scoreTopic('medical', 'Medicine'));
  assert.equal(scoreTopic('zebra', 'Baal'), 0);
  const ranked = rankTopics('medical treatment', parseTopicListHtml(fixture('dx-toc-m.html')).topics, 3);
  assert.equal(ranked[0].title, 'Medical Treatment');
  assert.ok(ranked.every((t) => t.score >= 25));
});

test('research guide topic parser groups article titles and citations by subheading', () => {
  const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/1200030011';
  const topic = parseResearchGuideTopicHtml(fixture('rsg-topic-baal.html'), url);
  assert.equal(topic.title, 'Baal');
  assert.equal(topic.sections.length, 2);
  assert.equal(topic.sections[0].heading, 'Bible Accuracy and Archaeology');
  assert.deepEqual(topic.sections[0].entries[1], {
    title: 'Ancient Potsherds Confirm the Biblical Record',
    citation: 'w07 11/15 p. 13',
    url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1200030011/1/0',
  });
  assert.equal(topic.sections[1].entries[0].citation, 'mwb22.09 p. 9');
  assert.equal(topic.entry_count, 5);
});

test('research guide "See:" links and bold sub-subheadings are kept apart from references', () => {
  const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/1200030002';
  const topic = parseResearchGuideTopicHtml(fixture('rsg-topic-babies.html'), url);
  assert.deepEqual(
    topic.see_also.map((s) => s.topic),
    ['Breastfeeding', 'Child Training', 'Pregnancy (Teens)'],
  );
  assert.equal(topic.sections.length, 1);
  assert.equal(topic.sections[0].heading, 'Family › Child Training');
  assert.deepEqual(topic.sections[0].entries, [
    {
      title: '“The Most Powerful Learning Machine in the Universe”',
      citation: 'g 10/11 pp. 4-6',
      url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1200030002/0/0',
    },
  ]);
});

test('index centered headings (ss) group the lines below them', () => {
  const html = `<article id="article">
    <p data-pid="1" class="st"><strong>MEDICAL TREATMENT</strong></p>
    <p data-pid="2" class="sa">(See also <a class="it" href="/en/wol/tc/r1/lp-e/9/0">Doctors</a>)</p>
    <p data-pid="3" class="sa">(Note centered headings below: Conditions; Methods)</p>
    <p data-pid="4" class="su">ambulance services: <a href="/en/wol/pc/r1/lp-e/9/0/0">g 3/10 11</a></p>
    <p data-pid="5" class="ss">Conditions</p>
    <p data-pid="6" class="su">anemia: <a href="/en/wol/pc/r1/lp-e/9/1/0">g 1/22 5</a></p>
    <p data-pid="7" class="ss">Methods</p>
    <p data-pid="8" class="su">cell salvage: <a href="/en/wol/pc/r1/lp-e/9/2/0">hb 17</a></p>
    <p data-pid="9" class="sb"> </p>
  </article>`;
  const topic = parseIndexTopicHtml(html, 'https://wol.jw.org/en/wol/d/r1/lp-e/9');
  assert.deepEqual(topic.notes, ['Note centered headings below: Conditions; Methods']);
  assert.equal(topic.see_also.length, 1);
  assert.equal(topic.entries[0].group, undefined);
  assert.equal(topic.entries[1].group, 'Conditions');
  assert.equal(topic.entries[2].group, 'Methods');
  assert.equal(topic.entries[2].path, 'cell salvage');
});

test('index subject parser keeps levels, labels, see-also links and every citation', () => {
  const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/1200270631';
  const topic = parseIndexTopicHtml(fixture('dx-topic-babies.html'), url);
  assert.equal(topic.title, 'BABIES');
  assert.equal(topic.see_also.length, 11);
  assert.equal(topic.see_also[0].topic, 'Abortion');
  const abandoned = topic.entries[0];
  assert.equal(abandoned.level, 1);
  assert.equal(abandoned.label, 'abandoned');
  assert.deepEqual(
    abandoned.references.map((r) => r.citation),
    ['g 1/07 15', 'w98 12/1 32', 'g96 7/22 29'],
  );
  const caffeine = topic.entries.find((e) => e.label === 'caffeine');
  assert.equal(caffeine.level, 2);
  assert.equal(caffeine.path, 'addicted to › caffeine');
  const accidents = topic.entries.find((e) => e.label === 'accidents');
  assert.deepEqual(accidents.references, []);
});

test('index edition is read from the landing page so a new year does not break the URL', () => {
  assert.equal(parseIndexEdition(INDEX_LANDING), 'index-1986-2026');
  assert.equal(parseIndexEdition('<article id="article"></article>'), null);
});

test('search_research_guide searches both sources and opens the top matches', async () => {
  const calls = [];
  const guideToc = fixture('rsg-toc-b.html');
  setFetchForTesting(
    fakeSite(
      {
        [RSG]: guideToc,
        [`${RSG}/0`]: '<article id="article"></article>',
        [`${RSG}/4`]: '<article id="article"></article>',
        [`${RSG}/98`]: guideToc,
        [`${RSG}/164`]: '<article id="article"></article>',
        [`${RSG}/260`]: '<article id="article"></article>',
        'https://wol.jw.org/en/wol/d/r1/lp-e/1200030002': fixture('rsg-topic-baal.html'),
        [INDEX]: INDEX_LANDING,
        [`${INDEX}/index-1986-2026/subject-index/b`]: `<article id="article"><ul class="navCard">
          <li class="row card"><a href="/en/wol/d/r1/lp-e/1200270631"><div class="cardLine1">Babies</div></a></li>
          <li class="row card"><a href="/en/wol/d/r1/lp-e/1200270637"><div class="cardLine1">Babysitters</div></a></li>
        </ul></article>`,
        'https://wol.jw.org/en/wol/d/r1/lp-e/1200270631': fixture('dx-topic-babies.html'),
      },
      calls,
    ),
  );
  const response = await handleResearchGuideTool({
    params: { name: 'search_research_guide', arguments: { topic: 'babies' } },
  });
  assert.equal(response.isError, undefined);
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.research_guide.matches[0].title, 'Babies');
  assert.equal(data.research_guide.result.sections.length, 2);
  assert.equal(data.publications_index.matches[0].title, 'Babies');
  assert.equal(data.publications_index.result.entries[0].label, 'abandoned');
  assert.ok(calls.every((url) => url.startsWith('https://wol.jw.org/')));
});

test('topic_url opens a specific topic and detects an index page by its markup', async () => {
  const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/1200270631';
  setFetchForTesting(fakeSite({ [url]: fixture('dx-topic-babies.html') }));
  const response = await handleResearchGuideTool({
    params: {
      name: 'search_research_guide',
      arguments: { topic_url: `${url}#h=3`, format: 'markdown', page_size: 2 },
    },
  });
  const text = response.content[0].text;
  assert.match(text, /## Publications Index: \[BABIES\]/);
  assert.match(
    text,
    /- abandoned: \[g 1\/07 15\]\(https:\/\/wol\.jw\.org\/en\/wol\/pc\/r1\/lp-e\/1200270631\/0\/0\)/,
  );
  assert.doesNotMatch(text, /in hospitals/); // page_size 2 stops before it
});

test('bad input returns a tool error instead of throwing', async () => {
  for (const args of [{}, { topic: 'x', source: 'bogus' }, { topic_url: 'https://evil.example/wol/d/1' }]) {
    const response = await handleResearchGuideTool({
      params: { name: 'search_research_guide', arguments: args },
    });
    assert.equal(response.isError, true, JSON.stringify(args));
  }
});

test('a bot challenge on wol.jw.org is reported clearly', async () => {
  setFetchForTesting(async () => ({
    status: 202,
    ok: true,
    statusText: 'Accepted',
    text: async () => '<script>AwsWafIntegration.saveReferrer()</script>',
  }));
  const response = await handleResearchGuideTool({
    params: { name: 'search_research_guide', arguments: { topic: 'Baal', source: 'research_guide' } },
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /bot challenge/);
});

test('handler ignores other tool names', async () => {
  assert.equal(await handleResearchGuideTool({ params: { name: 'get_bible_verse', arguments: {} } }), null);
});
