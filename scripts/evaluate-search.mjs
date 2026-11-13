import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DocumentationSearchService } from '../dist/search/search.service.js';

const LIMIT = 10;
const weights = {
  baseline: [8, 4, 1],
  titleHeading: [12, 8, 1],
  headingBalanced: [8, 8, 1],
  balanced: [6, 6, 1],
  lowerMetadata: [4, 2, 1],
};
const cases = [
  {
    query: 'ExecutionContext',
    target: 'fundamentals/execution-context#executioncontext-class',
    group: 'identifier',
  },
  { query: 'HttpException', target: 'exception-filters', group: 'identifier' },
  {
    query: 'execution context class',
    target: 'fundamentals/execution-context#executioncontext-class',
    group: 'identifier wording',
  },
  {
    query: 'HTTP exception filter handling',
    target: 'exception-filters',
    group: 'identifier wording',
  },
  {
    query: 'StreamableFile',
    targetByVersion: {
      11: 'techniques/streaming-files',
      12: 'http/file-upload',
    },
    group: 'identifier',
  },
  {
    query: '@Injectable()',
    target: 'guards#role-based-authentication',
    group: 'decorator',
  },
  {
    query: '@UseGuards()',
    target: 'guards#binding-guards',
    group: 'decorator',
  },
  {
    query: '@OnEvent()',
    targetByVersion: {
      11: 'techniques/events#listening-to-events',
      12: 'application/events#listening-to-events',
    },
    group: 'decorator',
  },
  {
    query: 'request scoped providers',
    target: 'fundamentals/injection-scopes',
    group: 'technical concept',
  },
  {
    query: 'custom parameter decorators',
    targetByVersion: {
      11: 'custom-decorators',
      12: 'application/validation#validating-custom-decorators',
    },
    group: 'technical concept',
  },
  {
    query: 'circular dependency forwardRef',
    target: 'fundamentals/circular-dependency',
    group: 'technical concept',
  },
  {
    query: 'streamable file response headers',
    targetByVersion: {
      11: 'techniques/streaming-files',
      12: 'http/file-upload',
    },
    group: 'technical concept',
  },
  {
    query: 'HTTP request lifecycle',
    target: 'faq/request-lifecycle#request-lifecycle',
    group: 'technical concept',
  },
  {
    query: 'dynamic module configuration',
    target: 'fundamentals/dynamic-modules#module-configuration',
    group: 'technical concept',
  },
  {
    query: 'How can I stream a file from a controller?',
    targetByVersion: {
      11: 'techniques/streaming-files',
      12: 'http/file-upload',
    },
    group: 'natural language',
  },
  {
    query: 'Where do I register a global validation pipe?',
    target: 'pipes#global-scoped-pipes',
    group: 'natural language',
  },
  {
    query: 'How can a guard access the current request user?',
    target: 'guards#authorization-guard',
    group: 'natural language',
  },
  {
    query: 'How can I make a provider request scoped?',
    target: 'fundamentals/injection-scopes',
    group: 'natural language',
  },
  {
    query: 'How do I resolve a circular dependency?',
    target: 'fundamentals/circular-dependency',
    group: 'natural language',
  },
  {
    query: 'How are middleware guards and interceptors ordered?',
    target: 'faq/request-lifecycle',
    group: 'natural language',
  },
  {
    query: 'middleware versus interceptor request order',
    target: 'faq/request-lifecycle',
    group: 'overlapping concepts',
  },
  {
    query: 'guard versus middleware request handling',
    target: 'faq/request-lifecycle',
    group: 'overlapping concepts',
  },
  {
    query: 'pipe versus interceptor execution order',
    target: 'faq/request-lifecycle',
    group: 'overlapping concepts',
  },
  {
    query: 'exception filter versus interceptor lifecycle',
    target: 'faq/request-lifecycle',
    group: 'overlapping concepts',
  },
  {
    query: 'request context versus application context',
    target: 'fundamentals/execution-context',
    group: 'overlapping concepts',
  },
];

function queryTerms(query) {
  return [...new Set(query.trim().match(/[\p{L}\p{N}_]+/gu) ?? [])];
}

function quote(term) {
  return `"${term.replaceAll('"', '""')}"`;
}

function camelParts(term) {
  return term
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

function combine(...lists) {
  const rows = [];
  const seen = new Set();
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row.chunkId)) continue;
      rows.push(row);
      seen.add(row.chunkId);
      if (rows.length === LIMIT) return rows;
    }
  }
  return rows;
}

function queryDatabase(
  database,
  version,
  expression,
  rankWeights = weights.baseline,
) {
  return database
    .prepare(
      `
    SELECT chunk_id AS chunkId, document_id AS documentId,
      canonical_url AS canonicalUrl,
      bm25(documentation_search, ?, ?, ?) AS rank
    FROM documentation_search
    WHERE documentation_search MATCH ? AND documentation_version = ?
    ORDER BY rank ASC, document_id ASC, chunk_id ASC
    LIMIT ?
  `,
    )
    .all(...rankWeights, expression, version, LIMIT);
}

function targetFor(test, version) {
  const prefix = test.targetByVersion?.[version] ?? test.target;
  return version === 11 ? `/v11/${prefix}` : `/${prefix}`;
}

function relevantRank(results, target) {
  const index = results.findIndex((row) => {
    const url = new URL(row.canonicalUrl);
    return `${url.pathname}${url.hash}`.includes(target);
  });
  return index < 0 ? null : index + 1;
}

function metrics(rows) {
  return {
    cases: rows.length,
    top1: rows.filter((row) => row.rank === 1).length,
    top3: rows.filter((row) => row.rank !== null && row.rank <= 3).length,
    top5: rows.filter((row) => row.rank !== null && row.rank <= 5).length,
    mrrAt10: Number(
      (
        rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) /
        rows.length
      ).toFixed(3),
    ),
  };
}

const root = fileURLToPath(new URL('../', import.meta.url));
const report = {};
for (const version of [11, 12]) {
  const databasePath = join(root, 'data', `documentation-v${version}.sqlite`);
  const service = new DocumentationSearchService(databasePath, version);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const comparisons = {
    baseline: [],
    current: [],
    andFirst: [],
    phraseFirst: [],
    phraseBoost: [],
    bigramBoost: [],
    camelAware: [],
    titleHeading: [],
    headingBalanced: [],
    balanced: [],
    lowerMetadata: [],
  };
  try {
    for (const test of cases) {
      const terms = queryTerms(test.query);
      const orExpression = terms.map(quote).join(' OR ');
      const andExpression = terms.map(quote).join(' AND ');
      const phraseExpression = `"${terms.join(' ').replaceAll('"', '""')}"`;
      const bigrams = terms
        .slice(0, -1)
        .map((_, index) => quote(terms.slice(index, index + 2).join(' ')));
      const phraseBoostRows = queryDatabase(
        database,
        version,
        `${phraseExpression} OR ${orExpression}`,
      );
      const bigramBoostRows = queryDatabase(
        database,
        version,
        `${bigrams.length ? `${bigrams.join(' OR ')} OR ` : ''}${orExpression}`,
      );
      const camelAwareExpression = terms
        .map((term) => {
          const parts = camelParts(term);
          return parts.length > 1
            ? `(${quote(term)} OR ${quote(parts.join(' '))})`
            : quote(term);
        })
        .join(' OR ');
      const target = targetFor(test, version);
      const baseline = queryDatabase(database, version, orExpression);
      const current = service.search(test.query, LIMIT);
      const andRows = queryDatabase(database, version, andExpression);
      const phraseRows = queryDatabase(database, version, phraseExpression);
      const orRows = queryDatabase(database, version, orExpression);
      const titleHeadingRows = queryDatabase(
        database,
        version,
        orExpression,
        weights.titleHeading,
      );
      const headingBalancedRows = queryDatabase(
        database,
        version,
        orExpression,
        weights.headingBalanced,
      );
      const balancedRows = queryDatabase(
        database,
        version,
        orExpression,
        weights.balanced,
      );
      const lowerMetadataRows = queryDatabase(
        database,
        version,
        orExpression,
        weights.lowerMetadata,
      );
      const camelAwareRows = queryDatabase(
        database,
        version,
        camelAwareExpression,
      );
      comparisons.baseline.push({
        ...test,
        rank: relevantRank(baseline, target),
      });
      comparisons.current.push({
        ...test,
        rank: relevantRank(current, target),
      });
      comparisons.andFirst.push({
        ...test,
        rank: relevantRank(combine(andRows, orRows), target),
      });
      comparisons.phraseFirst.push({
        ...test,
        rank: relevantRank(combine(phraseRows, orRows), target),
      });
      comparisons.phraseBoost.push({
        ...test,
        rank: relevantRank(phraseBoostRows, target),
      });
      comparisons.bigramBoost.push({
        ...test,
        rank: relevantRank(bigramBoostRows, target),
      });
      comparisons.titleHeading.push({
        ...test,
        rank: relevantRank(titleHeadingRows, target),
      });
      comparisons.headingBalanced.push({
        ...test,
        rank: relevantRank(headingBalancedRows, target),
      });
      comparisons.balanced.push({
        ...test,
        rank: relevantRank(balancedRows, target),
      });
      comparisons.lowerMetadata.push({
        ...test,
        rank: relevantRank(lowerMetadataRows, target),
      });
      comparisons.camelAware.push({
        ...test,
        rank: relevantRank(camelAwareRows, target),
      });
    }
  } finally {
    database.close();
    service.onModuleDestroy();
  }
  report[version] = Object.fromEntries(
    Object.entries(comparisons).map(([name, rows]) => [name, metrics(rows)]),
  );
  report[version].regressions = Object.fromEntries(
    Object.entries(comparisons)
      .filter(([name]) => name !== 'baseline')
      .map(([name, rows]) => [
        name,
        rows.flatMap((row, index) => {
          const baselineRank = comparisons.baseline[index].rank;
          return baselineRank !== null &&
            (row.rank === null || row.rank > baselineRank)
            ? [
                {
                  query: row.query,
                  baseline: baselineRank,
                  candidate: row.rank,
                },
              ]
            : [];
        }),
      ]),
  );
  report[version].cases = comparisons.baseline.map((row, index) => ({
    group: row.group,
    query: row.query,
    expected: targetFor(row, version),
    baseline: row.rank,
    current: comparisons.current[index].rank,
    andFirst: comparisons.andFirst[index].rank,
    phraseFirst: comparisons.phraseFirst[index].rank,
    phraseBoost: comparisons.phraseBoost[index].rank,
    bigramBoost: comparisons.bigramBoost[index].rank,
    camelAware: comparisons.camelAware[index].rank,
    titleHeading: comparisons.titleHeading[index].rank,
    headingBalanced: comparisons.headingBalanced[index].rank,
    balanced: comparisons.balanced[index].rank,
    lowerMetadata: comparisons.lowerMetadata[index].rank,
  }));
}
report.baselineDefinition = {
  query: 'unicode61 token extraction; quoted terms joined by OR',
  bm25Weights: { title: 8, headingPath: 4, markdown: 1 },
  limit: LIMIT,
  indexRevisions: Object.fromEntries(
    [11, 12].map((version) => {
      const database = new DatabaseSync(
        join(root, 'data', `documentation-v${version}.sqlite`),
        { readOnly: true },
      );
      try {
        return [
          version,
          database
            .prepare(
              'SELECT DISTINCT source_revision AS revision FROM documentation_search',
            )
            .get()?.revision,
        ];
      } finally {
        database.close();
      }
    }),
  ),
};
console.log(JSON.stringify(report, null, 2));
