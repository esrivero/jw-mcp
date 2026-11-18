// Ported from prreobby/jw-research-mcp tests/research-tools.test.ts (MIT).
import assert from 'node:assert/strict';
import test from 'node:test';
import { TTLCache } from '../../src/tools/fetch-cache.js';
import { wolPath } from '../../src/tools/wol-language.js';
import {
  paragraphSlice,
  parseArticleHtml,
  parseArticleMediaHtml,
  parseFootnotesHtml,
  parseRelatedContentHtml,
} from '../../src/tools/research-tools.js';
test('footnotes are parsed separately from study notes and cross-references', () => {
  const html = `
    <div class="section" data-key="43-3-19">
      <div class="studyNoteGroup"><li class="item studyNote"><p>A study note</p></li></div>
      <div class="group marginal"><li class="item marginal"><p>A cross-reference</p></li></div>
      <div class="group footnote">
        <li class="item footnote" data-extract-id="verseFootnote-4">
          <span class="marker">*</span><p>Or \u201Cpeople.\u201D</p>
        </li>
      </div>
    </div>`;
  assert.deepEqual(parseFootnotesHtml(html, 43, 3, 19), [
    { marker: '*', id: '4', text: 'Or \u201Cpeople.\u201D' },
  ]);
});
test('full article parser numbers paragraphs and preserves inline markers', () => {
  const html = `
    <article id="article">
      <h1 data-pid="1">Research title</h1>
      <p id="p2" data-pid="2">Text<a class="fn" data-fnid="7" href="/en/wol/fn/test">*</a>
        with <a class="b" href="/en/wol/bc/test">John 1:1</a> references.</p>
      <p data-pid="3">Second paragraph.</p>
    </article>`;
  const article = parseArticleHtml(html, 'https://wol.jw.org/en/wol/d/r1/lp-e/1');
  assert.equal(article.title, 'Research title');
  assert.equal(article.paragraph_count, 3);
  assert.match(article.full_text, /¶2 Text\[fn:7\] with \[xref:John 1:1\] references\./);
  assert.match(article.full_markdown, /\[John 1:1\]\(https:\/\/wol\.jw\.org\/en\/wol\/bc\/test\)/);
  assert.equal(article.paragraphs[1].source_url, 'https://wol.jw.org/en/wol/d/r1/lp-e/1#p2');
  assert.equal(article.paragraphs[1].links[0].type, 'footnote');
});
test('article media parser returns full image links, captions, and source anchors', () => {
  const html = `
    <article id="article">
      <h1 data-pid="1">Illustrated article</h1>
      <div id="f1">
        <figure>
          <img src="/en/wol/mp/full" data-img-small-src="/en/wol/mp/thumb"
            alt="Alternative description" width="900" height="506" />
          <figcaption><p id="p8" data-pid="8">A detailed caption (See paragraphs 4-6)</p></figcaption>
        </figure>
      </div>
    </article>`;
  const media = parseArticleMediaHtml(html, 'https://wol.jw.org/en/wol/d/r1/lp-e/2');
  assert.equal(media.images.length, 1);
  assert.equal(media.images[0].image_url, 'https://wol.jw.org/en/wol/mp/full');
  assert.equal(media.images[0].thumbnail_url, 'https://wol.jw.org/en/wol/mp/thumb');
  assert.equal(media.images[0].source_url, 'https://wol.jw.org/en/wol/d/r1/lp-e/2#p8');
  assert.deepEqual(media.images[0].referenced_paragraphs, ['4-6']);
});
test('related-content parser returns clickable subheadings and similar articles', () => {
  const html = `
    <div id="subheadings"><a href="#p4">First section</a></div>
    <div id="similarMaterial"><li class="simDoc">
      <a href="/en/wol/dsim/r1/lp-e/3">
        <img src="/wol/publication/thumb" />
        <div class="cardLine1">Related article</div>
        <div class="cardLine2">The Watchtower\u20142026</div>
      </a>
    </li></div>`;
  const related = parseRelatedContentHtml(html, 'https://wol.jw.org/en/wol/d/r1/lp-e/2');
  assert.equal(related.subheadings[0].url, 'https://wol.jw.org/en/wol/d/r1/lp-e/2#p4');
  assert.equal(related.similar_material[0].title, 'Related article');
  assert.equal(
    related.similar_material[0].thumbnail_url,
    'https://wol.jw.org/wol/publication/thumb',
  );
});
test('pagination enforces a small bounded response', () => {
  assert.deepEqual(paragraphSlice({}, 1000), {
    start: 1,
    end: 15,
    page: 1,
    pageSize: 15,
  });
  assert.deepEqual(paragraphSlice({ page: 2, page_size: 25 }, 1000), {
    start: 26,
    end: 50,
    page: 2,
    pageSize: 25,
  });
  assert.throws(
    () => paragraphSlice({ page_size: 26 }, 1000),
    /page_size must be an integer from 1 to 25/,
  );
});
test('TTL cache reports cache hits and avoids duplicate loads', async () => {
  const cache = new TTLCache(10_000);
  let loads = 0;
  const first = await cache.getOrLoad('key', 'https://example.test/source', async () => {
    loads += 1;
    return 'value';
  });
  const second = await cache.getOrLoad('key', 'https://example.test/source', async () => {
    loads += 1;
    return 'different';
  });
  assert.equal(first.metadata.cache_hit, false);
  assert.equal(second.metadata.cache_hit, true);
  assert.equal(second.value, 'value');
  assert.equal(loads, 1);
});
test('WOL language codes create the correct localized route', () => {
  assert.equal(wolPath('s', '', 'S'), 'https://wol.jw.org/es/wol/s/r4/lp-s');
  assert.equal(wolPath('h', '2026/7/28', 'F'), 'https://wol.jw.org/fr/wol/h/r30/lp-f/2026/7/28');
});
