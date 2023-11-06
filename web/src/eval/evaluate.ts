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

import { asNoteItem, isNote } from "../items/note-item";
import { findClosest } from "../layout/find";
import { VesCache } from "../layout/ves-cache";
import { VisualElementPath } from "../layout/visual-element";
import { panic } from "../util/lang";
import { ExpressionToken, ExpressionTokenType, tokenize } from "./tokenize";


export function evaluate() {
  for (let path of VesCache.getEvaluationRequired()) {
    const ves = VesCache.get(path)!;
    const ve = ves.get();
    const noteItem = asNoteItem(ve.displayItem);
    const equation = noteItem.title;
    const tokens = tokenize(equation);
    if (tokens == null) { continue; }
    const leftValue = evaluateCell(path, tokens[0]);
    const rightValue = evaluateCell(path, tokens[2]);
    let result = 0;
    if (tokens[1].operator == "-") { result = leftValue - rightValue; }
    if (tokens[1].operator == "+") { result = leftValue + rightValue; }
    if (tokens[1].operator == "*") { result = leftValue * rightValue; }
    if (tokens[1].operator == "/") { result = leftValue / rightValue; }
    ve.evaluatedTitle = result.toString();
    ves.set(ve);
  }
}

function evaluateCell(path: VisualElementPath, token: ExpressionToken): number {
  if (token.tokenType == ExpressionTokenType.RelativeReference) {
    for (let i=0; i<token.referenceFindOffset!; ++i) {
      const pathMaybe = findClosest(path, token.referenceFindDirection!, true);
      if (pathMaybe == null) { return 0; }
      path = pathMaybe;
    }
    const ve = VesCache.get(path)!.get();
    if (!isNote(ve.displayItem)) { return 0; }
    return parseFloat(asNoteItem(ve.displayItem).title);
  } else if (token.tokenType == ExpressionTokenType.AbsoluteReference) {
    const vesMaybe = VesCache.get(token.reference!);
    if (vesMaybe == null) { return 0; }
    const ve = vesMaybe.get();
    if (!isNote(ve.displayItem)) { return 0; }
    return parseFloat(asNoteItem(ve.displayItem).title);
  } else {
    panic("evaluateCell: unknown token type.");
  }
}
