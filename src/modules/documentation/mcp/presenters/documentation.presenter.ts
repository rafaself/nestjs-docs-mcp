import type {
  DocumentationSearchResult,
  FetchedDocumentation,
} from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import type { DocumentationIdentity } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import type {
  FetchDocsInput,
  FetchDocsOutput,
  SearchDocsOutput,
} from '../contracts/documentation-tools.contract.js';

interface FetchDocsPresentationInput extends FetchDocsInput {
  documentationId: string;
  documentationVersion: string;
  document: FetchedDocumentation | null;
}

export function presentSearchResults(
  results: DocumentationSearchResult[],
  documentation: DocumentationIdentity,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: SearchDocsOutput;
} {
  const formatted = results.length
    ? [
        `Documentation: ${documentation.id}@${documentation.version}`,
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
    : 'No matching documentation found.';

  return {
    content: [{ type: 'text', text: formatted }],
    structuredContent: {
      documentationId: documentation.id,
      documentationVersion: documentation.version,
      results,
    },
  };
}

export function presentFetchedDocumentation({
  document,
  documentId,
  documentationId,
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
        documentationId,
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
        text: formatDocument(document, documentationId, documentationVersion),
      },
    ],
    structuredContent: {
      documentationId,
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
  documentationId: string,
  documentationVersion: string,
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
    `Documentation: ${documentationId}@${documentationVersion}`,
    `Document ID: ${document.documentId}`,
    `Source revision: ${document.sourceRevision}`,
    '',
    sections,
    truncationNotice,
  ].join('\n');
}
