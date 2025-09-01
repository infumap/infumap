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

import { asExpressionItem, isExpression } from "../items/expression-item";
import { asNoteItem, isNote } from "../items/note-item";
import { asRatingItem, isRating } from "../items/rating-item";
import { findClosest } from "../layout/find";
import { VesCache } from "../layout/ves-cache";
import { VisualElementPath } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { AbsoluteReferenceExpression, BinaryExpression, Expression, ExpressionType, GroupingExpression, RelativeReferenceExpression, UnaryExpression, ValueExpression } from "./ast";
import { Parser } from "./parser";
import { TokenType } from "./token";


export function evaluateExpressions(virtual: boolean) {
  for (let path of VesCache.getEvaluationRequired()) {
    const ves = virtual ? VesCache.getVirtual(path)! : VesCache.get(path)!;
    const ve = ves.get();
    const expressionItem = asExpressionItem(ve.displayItem);
    const equation = expressionItem.title;
    ve.evaluatedTitle = evaluateExpression(path, equation, virtual).toString();
    ves.set(ve);
  }
}

interface Context {
  path: string,
  evaluationStack: Set<string>,
  variables?: Map<string, number>,
}

function evaluateExpression(path: VisualElementPath, text: string, virtual: boolean): string {
  if (text.trim() == "") { return ""; }
  try {
    const expr = Parser.parse(text);
    const context = { path, evaluationStack: new Set<string>(), variables: new Map<string, number>() };
    const r = evaluate(expr, context, virtual);
    return "" + r;
  } catch (e: any) {
    return "#VALUE!";
  }
}

function evaluateExpressionItem(item: any, path: VisualElementPath, context: Context, virtual: boolean): number {
  const expressionItem = asExpressionItem(item);
  const itemId = expressionItem.id;
  if (context.evaluationStack.has(itemId)) {
    return NaN;
  }
  context.evaluationStack.add(itemId);
  try {
    const equation = expressionItem.title;
    const expr = Parser.parse(equation);
    const newContext = { ...context, path };
    const result = evaluate(expr, newContext, virtual);
    return result;
  } catch (e: any) {
    return NaN;
  } finally {
    context.evaluationStack.delete(itemId);
  }
}

function evaluate(expr: Expression, context: Context, virtual: boolean): number {
  const exprType = (expr as any).type;
  if (exprType == ExpressionType.Binary) {
    const e = expr as BinaryExpression;
    if (e.operator == TokenType.Minus) { return evaluate(e.left, context, virtual) - evaluate(e.right, context, virtual); }
    if (e.operator == TokenType.Plus) { return evaluate(e.left, context, virtual) + evaluate(e.right, context, virtual); }
    if (e.operator == TokenType.Divide) { return evaluate(e.left, context, virtual) / evaluate(e.right, context, virtual); }
    if (e.operator == TokenType.Multiply) { return evaluate(e.left, context, virtual) * evaluate(e.right, context, virtual); }
    throw new Error("unexpected operator: " + e.operator);
  }
  if (exprType == ExpressionType.Unary) {
    const e = expr as UnaryExpression;
    if (e.operator == TokenType.Minus) { return -evaluate(e.operand, context, virtual); }
    throw new Error("unexpected operand: " + e.operator);
  }
  if (exprType == ExpressionType.Value) {
    const e = expr as ValueExpression;
    return e.value;
  }
  if (exprType == ExpressionType.Grouping) {
    const e = expr as GroupingExpression;
    return evaluate(e.expression, context, virtual);
  }
  if (exprType == ExpressionType.Sequence) {
    let last = NaN;
    const exprs = (expr as any).expressions as Expression[];
    for (let i=0; i<exprs.length; ++i) {
      last = evaluate(exprs[i], context, virtual);
    }
    return last;
  }
  if (exprType == ExpressionType.Assignment) {
    const name = (expr as any).name as string;
    const valueExpr = (expr as any).value as Expression;
    const value = evaluate(valueExpr, context, virtual);
    if (!context.variables) { context.variables = new Map<string, number>(); }
    context.variables.set(name, value);
    return value;
  }
  if (exprType == ExpressionType.VariableReference) {
    const name = (expr as any).name as string;
    if (context.variables && context.variables.has(name)) {
      return context.variables.get(name)!;
    }
    return NaN;
  }
  if (exprType == ExpressionType.AbsoluteReference) {
    const e = expr as AbsoluteReferenceExpression;
    const item = itemState.get(e.uid)!;
    if (item == null) { throw new Error("item doesn't exist"); }
    if (isNote(item)) {
      return parseFloat(asNoteItem(item).title);
    } else if (isRating(item)) {
      return asRatingItem(item).rating;
    } else if (isExpression(item)) {
      const pathsForItem = VesCache.getPathsForDisplayId(e.uid);
      if (pathsForItem && pathsForItem.length > 0) {
        return evaluateExpressionItem(item, pathsForItem[0], context, virtual);
      } else {
        throw new Error("no path found for expression item");
      }
    } else {
      return NaN;
    }
  }
  if (exprType == ExpressionType.RelativeReference) {
    const e = expr as RelativeReferenceExpression;
    let path = context.path;
    for (let i=0; i<e.findOffset; ++i) {
      const pathMaybe = findClosest(path, e.findDirection, true, virtual);
      if (pathMaybe == null) { return NaN; }
      path = pathMaybe;
    }

    let ve = virtual ? VesCache.getVirtual(path)!.get() : VesCache.get(path)!.get();

    if (isNote(ve.displayItem)) {
      try {
        return parseFloat(asNoteItem(ve.displayItem).title);
      } catch (e) {
        return NaN;
      }
    } else if (isRating(ve.displayItem)) {
      return asRatingItem(ve.displayItem).rating;
    } else if (isExpression(ve.displayItem)) {
      return evaluateExpressionItem(ve.displayItem, path, context, virtual);
    }

    return NaN;
  }
  throw new Error("unexpected expression type: " + exprType);
};
