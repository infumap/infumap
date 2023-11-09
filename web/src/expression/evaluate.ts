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
import { itemState } from "../store/ItemState";
import { AbsoluteReferenceExpression, BinaryExpression, Expression, ExpressionType, GroupingExpression, RelativeReferenceExpression, UnaryExpression, ValueExpression } from "./ast";
import { Parser } from "./parser";
import { TokenType } from "./token";


export function evaluateExpressions() {
  for (let path of VesCache.getEvaluationRequired()) {
    const ves = VesCache.get(path)!;
    const ve = ves.get();
    const noteItem = asNoteItem(ve.displayItem);
    const equation = noteItem.title;
    ve.evaluatedTitle = evaluateExpression(path, equation).toString();
    ves.set(ve);
  }
}

interface Context {
  path: string,
}

function evaluateExpression(path: VisualElementPath, text: string): string {
  try {
    const expr = Parser.parse(text.substring(1));
    const context = { path };
    const r = evaluate(expr, context);
    return "" + r;
  } catch (e: any) {
    console.debug(e);
    return text;
  }
}

function evaluate(expr: Expression, context: Context): number {
  const exprType = (expr as any).type;
  if (exprType == ExpressionType.Binary) {
    const e = expr as BinaryExpression;
    if (e.operator == TokenType.Minus) { return evaluate(e.left, context) - evaluate(e.right, context); }
    if (e.operator == TokenType.Plus) { return evaluate(e.left, context) + evaluate(e.right, context); }
    if (e.operator == TokenType.Divide) { return evaluate(e.left, context) / evaluate(e.right, context); }
    if (e.operator == TokenType.Multiply) { return evaluate(e.left, context) * evaluate(e.right, context); }
    throw new Error("unexpected operator: " + e.operator);
  }
  if (exprType == ExpressionType.Unary) {
    const e = expr as UnaryExpression;
    if (e.operator == TokenType.Minus) { return -evaluate(e.operand, context); }
    throw new Error("unexpected operand: " + e.operator);
  }
  if (exprType == ExpressionType.Value) {
    const e = expr as ValueExpression;
    return e.value;
  }
  if (exprType == ExpressionType.Grouping) {
    const e = expr as GroupingExpression;
    return evaluate(e.expression, context);
  }
  if (exprType == ExpressionType.AbsoluteReference) {
    const e = expr as AbsoluteReferenceExpression;
    const item = itemState.get(e.uid)!;
    if (item == null) { throw new Error("item doesn't exist"); }
    if (!isNote(item)) { throw new Error("referenced item is not note."); }
    return parseFloat(asNoteItem(item).title);
  }
  if (exprType == ExpressionType.RelativeReference) {
    const e = expr as RelativeReferenceExpression;
    let path = context.path;
    for (let i=0; i<e.findOffset; ++i) {
      const pathMaybe = findClosest(path, e.findDirection, true);
      if (pathMaybe == null) { return 0; }
      path = pathMaybe;
    }
    const ve = VesCache.get(path)!.get();
    if (!isNote(ve.displayItem)) { return 0; }
    return parseFloat(asNoteItem(ve.displayItem).title);
  }
  throw new Error("unexpected expression type: " + exprType);
};
