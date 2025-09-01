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

import { EMPTY_UID } from '../util/uid';
import { Token, TokenType } from './token';


let position: number = 0;
let text: string = "";

export let Lexer = {
  init: (t: string) => {
    position = 0;
    text = t;
  },

  next: (): Token => {
    skipWhiteSpace();
    if (position >= text.length) { return { type: TokenType.EOF, literal: '\0', position }; }

    const tokenStartPosition = position;
    const tokenFirstChar = text[tokenStartPosition];
    position += 1;
    if (tokenFirstChar == '+') { return { type: TokenType.Plus, literal: '+', position: tokenStartPosition }; }
    if (tokenFirstChar == '-') { return { type: TokenType.Minus, literal: '-', position: tokenStartPosition }; }
    if (tokenFirstChar == '*') { return { type: TokenType.Multiply, literal: '*', position: tokenStartPosition }; }
    if (tokenFirstChar == '/') { return { type: TokenType.Divide, literal: '/', position: tokenStartPosition }; }
    if (tokenFirstChar == '=') { return { type: TokenType.Equal, literal: '=', position: tokenStartPosition }; }
    if (tokenFirstChar == ';') { return { type: TokenType.Semicolon, literal: ';', position: tokenStartPosition }; }
    if (tokenFirstChar == '(') { return { type: TokenType.LeftParenthesis, literal: '(', position: tokenStartPosition }; }
    if (tokenFirstChar == ')') { return { type: TokenType.RightParenthesis, literal: ')', position: tokenStartPosition }; }

    if (isNumber(tokenFirstChar) || tokenFirstChar == '.') { return readNumber(); }
    if (tokenFirstChar == '$') { return readReferenceOrVariable(); }
    if (isLetter(tokenFirstChar)) { return readIdentifier(tokenStartPosition); }

    return { type: TokenType.Illegal, literal: tokenFirstChar, position };
  }
}

function skipWhiteSpace(): void {
  while (position < text.length && isWhiteSpace(text[position])) { position += 1; };
}

function readReferenceOrVariable(): Token {
  const startPos = position - 1;
  while (position < text.length && (isNumber(text[position]) || isLetter(text[position]) || text[position] == '_')) {
    position += 1;
  }
  const token = text.substring(startPos, position);

  // Absolute
  if (token.length == EMPTY_UID.length + 1) {
    for (let i=1; i<token.length; ++i) {
      if (!isHexChar(token[i])) {
        return { type: TokenType.Illegal, literal: token, position: startPos };
      }
    }
    return { type: TokenType.AbsoluteReference, literal: token, position: startPos };
  }

  // Relative
  if (token.length >= 3 &&
      (token[1].toUpperCase() == 'L' || token[1].toUpperCase() == 'R' || token[1].toUpperCase() == 'U' || token[1].toUpperCase() == 'D')) {
    let allDigits = true;
    for (let i=2; i<token.length; ++i) {
      if (!isNumber(token[i])) { allDigits = false; break; }
    }
    if (allDigits) {
      return { type: TokenType.RelativeReference, literal: token, position: startPos };
    }
    // else fall through to variable handling
  }

  // Variable reference: $name (name must start with a letter; may contain letters/digits/_)
  if (token.length >= 2 && isLetter(token[1])) {
    for (let i=2; i<token.length; ++i) {
      if (!isLetter(token[i]) && !isNumber(token[i]) && token[i] != '_') {
        return { type: TokenType.Illegal, literal: token, position: startPos };
      }
    }
    return { type: TokenType.VariableReference, literal: token.substring(1), position: startPos };
  }

  return { type: TokenType.Illegal, literal: token, position: startPos };
}

function readNumber(): Token {
  position -= 1;
  const startPos = position;
  let haveDecimal = false;
  while (position < text.length && isNumber(text[position]) || (text[position] == '.') && !haveDecimal) {
    if (text[position] == '.') { haveDecimal = true; }
    position += 1;
  }
  const literal = text.substring(startPos, position);
  return { type: TokenType.Number, literal, position: startPos };
}

function readIdentifier(startPos: number): Token {
  // first char already consumed and is a letter
  while (position < text.length && (isLetter(text[position]) || isNumber(text[position]) || text[position] == '_')) {
    position += 1;
  }
  const literal = text.substring(startPos, position);
  return { type: TokenType.Identifier, literal, position: startPos };
}

function isWhiteSpace(charStr: string): boolean {
  const code = charStr.charCodeAt(0);
  return (
    code === 0x09 || // '\t'
    code === 0x0a || // '\n'
    code === 0x0d || // '\r'
    code === 0x20 // ' '
  );
}

function isNumber(charStr: string): boolean {
  const code = charStr.charCodeAt(0);
  return code >= 0x30 && code <= 0x39; // '0'-'9'
}

function isLetter(charStr: string): boolean {
  const code = charStr.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

function isHexChar(charStr: string): boolean {
  if (isNumber(charStr)) { return true; }
  const code = charStr.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x46) || // A-Z
    (code >= 0x61 && code <= 0x66) // a-z
  );
}
