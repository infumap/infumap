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

import { FindDirection, findDirectionFromLetterPrefix } from "../layout/find";
import { EMPTY_UID } from "../util/uid";


export enum ExpressionTokenType {
  AbsoluteReference,
  RelativeReference,
  Operator,
}

// TODO (LOW): something not flat.
export interface ExpressionToken {
  tokenType: ExpressionTokenType,
  operator: string | null,
  referenceFindDirection: FindDirection | null,
  referenceFindOffset: number | null,
  reference: string | null,
}

export function tokenize(expression: string): Array<ExpressionToken> | null {
  if (!expression.startsWith("=")) { return null; }
  expression = expression.substring(1);

  const parts = expression.split(/[\+\-\*\/]/).map(part => part.replace(" ", ""));
  const operator = (() => {
    if (expression.indexOf("-") != -1) { return "-"; }
    if (expression.indexOf("+") != -1) { return "+"; }
    if (expression.indexOf("*") != -1) { return "*"; }
    if (expression.indexOf("/") != -1) { return "/"; }
    return null;
  })();

  try {
    return [
      createReferenceToken(parts[0]),
      {
        tokenType: ExpressionTokenType.Operator,
        operator,
        reference: null,
        referenceFindDirection: null,
        referenceFindOffset: null
      },
      createReferenceToken(parts[1])
    ];
  }
  catch (_) {
    return null;
  }
}

function createReferenceToken(s: string): ExpressionToken {
  if (!s.startsWith("$")) { throw new Error("invalid reference"); }
  s = s.substring(1);
  if (s.length == EMPTY_UID.length) {
    return ({
      tokenType: ExpressionTokenType.AbsoluteReference,
      operator: null,
      referenceFindDirection: null,
      referenceFindOffset: null,
      reference: s
    });
  }
  if (s.length < 2) { throw new Error("invalid reference - not long enough"); }
  return ({
    tokenType: ExpressionTokenType.RelativeReference,
    operator: null,
    reference: null,
    referenceFindDirection: findDirectionFromLetterPrefix(s[0]),
    referenceFindOffset: parseInt(s.substring(1))
  });
}
