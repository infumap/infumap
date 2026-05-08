/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import type { SearchPathElement, SearchResult, SearchSemanticMatch } from "../server";
import type { ItemPathSegment } from "./item-path";
import { EMPTY_UID, Uid } from "./uid";


const PDF_MARKDOWN_FRAGMENT_SOURCE_KIND = "pdf_markdown";
const PDF_CATALOG_OMITTED_LABELS = new Set(["document", "context", "section"]);

export interface CatalogSemanticMatchDisplay {
  text: string,
  href: string,
  pageLabel: string | null,
}

export interface CatalogSearchResultDisplay {
  pathSegments: Array<ItemPathSegment>,
  semanticMatch: CatalogSemanticMatchDisplay | null,
}

function fallbackPathTitle(itemType: string): string {
  return `[${itemType}]`;
}

export function searchResultPathSegmentsFromPath(path: Array<SearchPathElement>): Array<ItemPathSegment> {
  return path.map(segment => ({
    id: segment.id,
    itemType: segment.itemType,
    title: segment.title ?? fallbackPathTitle(segment.itemType),
  }));
}

export function searchResultPathSegments(result: SearchResult): Array<ItemPathSegment> {
  return searchResultPathSegmentsFromPath(result.path);
}

export function searchResultTargetId(result: SearchResult): Uid | null {
  const targetId = result.path[result.path.length - 1]?.id;
  if (!targetId || targetId == EMPTY_UID) {
    return null;
  }
  return targetId;
}

export function semanticMatchPageLabel(pageStart?: number, pageEnd?: number): string | null {
  if (pageStart == null || pageEnd == null) {
    return null;
  }
  return pageStart == pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`;
}

const flattenCatalogSemanticMatchText = (text: string): string =>
  text.replace(/\r\n|\r|\n/g, " | ");

const isPdfCatalogOmittedLine = (line: string): boolean => {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) {
    return false;
  }
  return PDF_CATALOG_OMITTED_LABELS.has(line.slice(0, separatorIndex).trim().toLowerCase());
};

const formatPdfMarkdownCatalogSemanticMatchText = (text: string): string =>
  text
    .split(/\r\n|\r|\n/g)
    .map(line => line.trim())
    .filter(line => line != "" && !isPdfCatalogOmittedLine(line))
    .join(" | ");

export function formatCatalogSemanticMatchText(sourceKind: string, text: string): string {
  switch (sourceKind) {
    case PDF_MARKDOWN_FRAGMENT_SOURCE_KIND:
      return formatPdfMarkdownCatalogSemanticMatchText(text);
    default:
      return flattenCatalogSemanticMatchText(text);
  }
}

export function catalogSemanticMatchDisplayFromMatch(
  targetId: Uid | null | undefined,
  match: SearchSemanticMatch | null | undefined,
): CatalogSemanticMatchDisplay | null {
  if (!targetId || targetId == EMPTY_UID || !match) {
    return null;
  }

  const formattedText = formatCatalogSemanticMatchText(match.sourceKind, match.text);
  if (formattedText.trim() == "") {
    return null;
  }

  return {
    text: match.textTruncated ? `${formattedText}...` : formattedText,
    href: `/files/${targetId}/fragments/${match.fragmentOrdinal}`,
    pageLabel: semanticMatchPageLabel(match.pageStart, match.pageEnd),
  };
}

export function catalogSearchResultDisplay(result: SearchResult): CatalogSearchResultDisplay {
  return {
    pathSegments: searchResultPathSegments(result),
    semanticMatch: catalogSemanticMatchDisplayFromMatch(searchResultTargetId(result), result.semanticMatch),
  };
}
