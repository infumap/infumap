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

import { findDirectionFromLetterPrefix } from '../layout/find';
import { Expression, ExpressionType, } from './ast';
import { Lexer } from './lexer';
import { Token, TokenType } from './token';


// parser implementation inspired by: https://craftinginterpreters.com/parsing-expressions.html

// Language grammar:
//
// expression     → term ;
// term           → factor ( ( "-" | "+" ) factor )* ;
// factor         → unary ( ( "/" | "*" ) unary )* ;
// unary          → ( "-" ) unary
//                | primary ;
// primary        → NUMBER | ABSOLUTE_REFERENCE | RELATIVE_REFERENCE
//                | "(" expression ")" ;

let tokens: Array<Token>;
let current: number;

export let Parser = {
  parse(text: string): Expression {
    Lexer.init(text);
    tokens = [];
    while (true) {
      const token = Lexer.next();
      tokens.push(token);
      if (token.type == TokenType.EOF) { break; }
      if (tokens.length > 1000) {
        console.debug("Expression too long. Tokens: ", tokens);
        throw new Error("Expression too long.");
      }
    }
    current = 0;
    return expression();
  }
}


function expression(): Expression {
  return term();
}

function term(): Expression {
  let expr = factor();

  while (match([TokenType.Minus, TokenType.Plus])) {
    let operator = previous();
    let right = factor();
    expr = { type: ExpressionType.Binary, left: expr, operator: operator.type, right };
  }

  return expr;
}

function factor(): Expression {
  let expr = unary();

  while (match([TokenType.Divide, TokenType.Multiply])) {
    let operator = previous();
    let right = unary();
    expr = { type: ExpressionType.Binary, left: expr, operator: operator.type, right };
  }

  return expr;
}

function unary(): Expression {
  if (match([TokenType.Minus])) {
    let operator = previous();
    let right = unary();
    return { type: ExpressionType.Unary, operator: operator.type, operand: right };
  }

  return primary();
}

function primary(): Expression {
  const literal = peek().literal;
  if (match([TokenType.AbsoluteReference])) { return { type: ExpressionType.AbsoluteReference, uid: literal.substring(1) }; }
  if (match([TokenType.RelativeReference])) { return { type: ExpressionType.RelativeReference, findDirection: findDirectionFromLetterPrefix(literal[1]), findOffset: parseInt(literal.substring(2)) }; }
  if (match([TokenType.Number])) { return { type: ExpressionType.Value, value: parseFloat(literal) }; }
  if (match([TokenType.LeftParenthesis])) {
    let expr = expression();
    consume(TokenType.RightParenthesis, "Expect ')' after expression.");
    return { type: ExpressionType.Grouping, expression: expr };
  }
  throw new Error("unexpected token");
}

function consume(type: TokenType, message: string): Token {
  if (check(type)) return advance();
  throw new Error(message);
}

function match(types: Array<TokenType>): boolean {
  for (let i=0; i<types.length; ++i) {
    if (check(types[i])) {
      advance();
      return true;
    }
  }
  return false;
}

function check(type: TokenType): boolean {
  if (isAtEnd()) return false;
  return peek().type == type;
}

function advance(): Token {
  if (!isAtEnd()) current++;
  return previous();
}

function isAtEnd(): boolean {
  return peek().type == TokenType.EOF;
}

function peek(): Token {
  return tokens[current];
}

function previous(): Token {
  return tokens[current - 1];
}
