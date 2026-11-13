import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { MAX_FETCH_DOCUMENT_CHARS } from './search.constants.js';
import type {
  DocumentationSectionResult,
  FetchedDocumentation,
} from '../application/contracts/documentation-reader.contract.js';
import type { DocumentationIdentity } from '../domain/documentation.types.js';
import type { DocumentationRow } from '../application/contracts/documentation-search-store.contract.js';

export function paginateDocumentation(
  documentation: DocumentationIdentity,
  documentId: string,
  selectedRows: DocumentationRow[],
  sectionId?: string,
  cursor?: string,
): FetchedDocumentation {
  const first = selectedRows[0]!;
  const grouped = groupSections(selectedRows);

  const scopeHash = createHash('sha256')
    .update(
      JSON.stringify([
        documentation.id,
        documentation.version,
        documentId,
        sectionId ?? null,
        first.sourceRevision,
        grouped,
      ]),
    )
    .digest('hex');
  const { sectionIndex, offset: initialOffset } = resolveCursor(
    cursor,
    scopeHash,
    grouped,
  );
  let offset = initialOffset;
  let remaining = MAX_FETCH_DOCUMENT_CHARS;
  let nextCursor: string | undefined;
  const sections: DocumentationSectionResult[] = [];
  for (let index = sectionIndex; index < grouped.length; index++) {
    const section = grouped[index]!;
    const headingPath = section.headingPath || first.title;
    const framing = `\n\n## ${headingPath}\nSource: ${section.canonicalUrl}\n\n`;
    const available = remaining - framing.length;
    if (available <= 1) {
      if (remaining === MAX_FETCH_DOCUMENT_CHARS) {
        throw new BadRequestException('Section heading exceeds fetch limit');
      }
      nextCursor = `${scopeHash}:${index}:${offset}`;
      break;
    }
    const clipped = truncate(section.markdown.slice(offset), available);
    sections.push({
      headingPath,
      canonicalUrl: section.canonicalUrl,
      markdown: clipped.text,
    });
    remaining -= framing.length + clipped.text.length;
    if (clipped.truncated) {
      nextCursor = `${scopeHash}:${index}:${offset + clipped.text.length}`;
      break;
    }
    offset = 0;
  }
  const truncated = nextCursor !== undefined;

  return {
    documentId,
    title: first.title,
    sourceRevision: first.sourceRevision,
    sections,
    truncated,
    nextCursor,
  };
}

function groupSections(selectedRows: DocumentationRow[]): DocumentationRow[] {
  const grouped: DocumentationRow[] = [];
  for (const row of selectedRows) {
    const previous = grouped.at(-1);
    if (
      previous?.canonicalUrl === row.canonicalUrl &&
      previous.headingPath === row.headingPath
    ) {
      previous.markdown += `\n\n${row.markdown}`;
    } else {
      grouped.push({ ...row });
    }
  }

  return grouped;
}

function resolveCursor(
  cursor: string | undefined,
  scopeHash: string,
  grouped: DocumentationRow[],
): { sectionIndex: number; offset: number } {
  let sectionIndex = 0;
  let offset = 0;
  if (cursor) {
    const match = /^([0-9a-f]{64}):(0|[1-9]\d*):(0|[1-9]\d*)$/u.exec(cursor);
    if (!match || match[1] !== scopeHash)
      throw new BadRequestException('Invalid or stale continuation cursor');
    sectionIndex = Number(match[2]);
    offset = Number(match[3]);
    if (
      !Number.isSafeInteger(sectionIndex) ||
      !Number.isSafeInteger(offset) ||
      sectionIndex >= grouped.length ||
      offset > grouped[sectionIndex]!.markdown.length ||
      (offset > 0 && offset === grouped[sectionIndex]!.markdown.length)
    ) {
      throw new BadRequestException('Invalid continuation cursor');
    }
  }
  return { sectionIndex, offset };
}

function truncate(
  value: string,
  maxLength: number,
): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxLength) return { text: value, truncated: false };
  let end = maxLength;
  const before = value.charCodeAt(end - 1);
  const after = value.charCodeAt(end);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  ) {
    end -= 1;
  }
  return { text: value.slice(0, end), truncated: true };
}
