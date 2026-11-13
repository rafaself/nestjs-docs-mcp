import type {
  DocumentationSearchResult,
  FetchedDocumentation,
} from '../../application/contracts/documentation-reader.contract.js';
import type {
  FetchDocsPresentationInput,
  FetchDocsOutput,
  SearchDocsOutput,
} from '../contracts/documentation-tools.contract.js';

export function presentSearchResults(
  results: DocumentationSearchResult[],
  documentationVersion: number,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: SearchDocsOutput;
} {
  const formatted = results.length
    ? [
        `Documentation major: v${documentationVersion}`,
        ...results.map((result, index) =>
          [
            `### ${index + 1}. ${result.title}`,
            `Document ID: ${result.documentId}`,
            `Section ID: ${result.chunkId}`,
            `Source revision: ${result.sourceRevision}`,
            `Source: ${result.canonicalUrl}`,
            `Excerpt: ${result.excerpt}`,
          ].join('\n'),
        ),
      ].join('\n\n')
    : 'No matching NestJS documentation found.';

  return {
    content: [{ type: 'text', text: formatted }],
    structuredContent: { documentationVersion, results },
  };
}

export function presentFetchedDocumentation({
  document,
  documentId,
  sectionId,
  documentationVersion,
}: FetchDocsPresentationInput): {
  content: [{ type: 'text'; text: string }];
  structuredContent: FetchDocsOutput;
} {
  if (!document) {
    return {
      content: [
        {
          type: 'text',
          text: `No document or section found for ID ${documentId}.`,
        },
      ],
      structuredContent: {
        documentationVersion,
        documentId,
        sectionId: sectionId ?? null,
        found: false,
        title: null,
        sourceRevision: null,
        sections: [],
        truncated: false,
        nextCursor: null,
      },
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: formatDocument(document, documentationVersion),
      },
    ],
    structuredContent: {
      documentationVersion,
      documentId,
      sectionId: sectionId ?? null,
      found: true,
      title: document.title,
      sourceRevision: document.sourceRevision,
      sections: document.sections,
      truncated: document.truncated,
      nextCursor: document.nextCursor ?? null,
    },
  };
}

function formatDocument(
  document: FetchedDocumentation,
  documentationVersion: number,
): string {
  const sections = document.sections
    .map(
      (section) =>
        `## ${section.headingPath}\nSource: ${section.canonicalUrl}\n\n${section.markdown}`,
    )
    .join('\n\n');
  const truncationNotice = document.truncated
    ? `\n\n[Document excerpt truncated. Continue with cursor: ${document.nextCursor}]`
    : '';

  return [
    `# ${document.title}`,
    `Documentation major: v${documentationVersion}`,
    `Document ID: ${document.documentId}`,
    `Source revision: ${document.sourceRevision}`,
    '',
    sections,
    truncationNotice,
  ].join('\n');
}
