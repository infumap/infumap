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

import { FindDirection } from '../layout/find';
import { Uid } from '../util/uid';
import { TokenType } from './token';

export enum ExpressionType {
  Binary,
  Unary,
  Value,
  AbsoluteReference,
  RelativeReference,
  Grouping,
}

export interface Expression {
}

export interface BinaryExpression extends Expression {
  type: ExpressionType,
  operator: TokenType,
  left: Expression,
  right: Expression,
}

export interface UnaryExpression extends Expression {
  type: ExpressionType,
  operator: TokenType,
  operand: Expression,
}

export interface ValueExpression extends Expression {
  type: ExpressionType,
  value: number,
}

export interface AbsoluteReferenceExpression extends Expression {
  type: ExpressionType,
  uid: Uid,
}

export interface RelativeReferenceExpression extends Expression {
  type: ExpressionType,
  findDirection: FindDirection,
  findOffset: number,
}

export interface GroupingExpression extends Expression {
  type: ExpressionType,
  expression: Expression,
}
