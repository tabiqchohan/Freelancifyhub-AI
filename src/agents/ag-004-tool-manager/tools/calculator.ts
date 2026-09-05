import { z } from 'zod';

import { ToolCategory, ToolSecurityLevel } from '../enums/index.js';
import type { ToolSpecification } from '../types/index.js';
import type { ToolHandler } from '../types/index.js';
import { ToolValidationError, ToolExecutionError } from '../errors/index.js';

/**
 * AG-004 calculator tool — a genuinely executable, safe internal tool.
 *
 * Supports addition, subtraction, multiplication, division, parentheses,
 * exponentiation (**), and unary plus/minus over non-negative integer/rational
 * operands. Detects arithmetic overflow and errors.
 *
 * SECURITY: No eval, no Function(...), no shell, no arbitrary JS. Uses a small
 * bounded recursive-descent parser over a safe grammar.
 */

export const CALCULATOR_TOOL_NAME = 'calculator';

/** Max expression length (bounded input). */
const MAX_EXPRESSION_LENGTH = 256;
/** Max digits in a numeric literal (prevents pathological huge numbers). */
const MAX_NUMBER_LENGTH = 20;
/** Max result magnitude (prevents overflow). */
const MAX_RESULT_MAGNITUDE = 1e15;

const inputSchema = z.object({
  /** Arithmetic expression, e.g. "2 + 3 * 4". */
  expression: z
    .string()
    .min(1)
    .max(MAX_EXPRESSION_LENGTH)
    .regex(
      /^[0-9+\-*/().\s^]+$/,
      'Expression may only contain digits and + - * / ( ) . ^ operators',
    ),
});

const outputSchema = z.object({
  result: z.number().finite(),
  operation: z.string(),
});

const handler: ToolHandler = {
  name: CALCULATOR_TOOL_NAME,
  invoke(input: unknown): unknown {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolValidationError('Invalid calculator input', {
        code: 'INVALID_CALCULATOR_INPUT',
        details: { issues: parsed.error.issues.map((i) => i.message) },
      });
    }
    const expression = parsed.data.expression;
    const result = evaluateArithmetic(expression);
    return { result, operation: expression };
  },
};

/** The calculator tool specification. */
export function createCalculatorSpecification(): ToolSpecification {
  return {
    name: CALCULATOR_TOOL_NAME,
    description: 'Performs bounded, deterministic arithmetic (add, subtract, multiply, divide).',
    version: '1.0.0',
    category: ToolCategory.Computation,
    inputSchema,
    outputSchema,
    handler,
    securityLevel: ToolSecurityLevel.Internal,
    permissions: [],
    executionPolicy: {
      timeoutMs: 1_000,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      retryPolicy: { maxRetries: 0, backoffBaseMs: 50, backoffMaxMs: 500 },
      concurrencyLimit: 64,
      securityLevel: ToolSecurityLevel.Internal,
    },
    metadata: {
      kind: 'safe-arithmetic',
    },
  };
}

/** Evaluates a bounded arithmetic expression to a deterministic number. */
function evaluateArithmetic(expression: string): number {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const value = parser.parse();
  if (!Number.isFinite(value)) {
    throw new ToolExecutionError('Calculator produced a non-finite result', {
      code: 'CALCULATOR_NON_FINITE',
    });
  }
  if (Math.abs(value) > MAX_RESULT_MAGNITUDE) {
    throw new ToolExecutionError('Calculator result exceeds maximum magnitude', {
      code: 'CALCULATOR_OVERFLOW',
    });
  }
  return Math.round(value * 1e9) / 1e9;
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; op: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' };
type OpToken = Extract<Token, { kind: 'op' }>;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const src = expression.replace(/\s+/g, '');
  while (i < src.length) {
    const ch = src[i]!;
    if (ch >= '0' && ch <= '9') {
      let j = i;
      let hasDot = false;
      while (j < src.length && ((src[j]! >= '0' && src[j]! <= '9') || src[j] === '.')) {
        if (src[j] === '.') {
          if (hasDot) {
            throw new ToolValidationError('Malformed number literal', {
              code: 'CALCULATOR_MALFORMED',
            });
          }
          hasDot = true;
        }
        j += 1;
      }
      const literal = src.slice(i, j);
      if (literal.length > MAX_NUMBER_LENGTH) {
        throw new ToolValidationError('Number literal too long', {
          code: 'CALCULATOR_NUMBER_TOO_LONG',
        });
      }
      const value = Number(literal);
      if (!Number.isFinite(value)) {
        throw new ToolExecutionError('Number literal out of range', {
          code: 'CALCULATOR_OVERFLOW',
        });
      }
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    throw new ToolValidationError(`Unexpected character '${ch}'`, {
      code: 'CALCULATOR_UNEXPECTED_CHARACTER',
    });
  }
  if (tokens.length === 0) {
    throw new ToolValidationError('Empty expression', { code: 'CALCULATOR_EMPTY' });
  }
  if (tokens.length > 200) {
    throw new ToolValidationError('Expression too complex', { code: 'CALCULATOR_TOO_COMPLEX' });
  }
  return tokens;
}

/** Recursive-descent parser: precedence-climbing for + - * / ^ ( ) unary -/+. */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.parseExpression();
    if (this.pos !== this.tokens.length) {
      throw new ToolValidationError('Unexpected trailing tokens', {
        code: 'CALCULATOR_UNEXPECTED_TOKEN',
      });
    }
    return value;
  }

  private parseExpression(): number {
    let left = this.parseTerm();
    while (this.peekOp('+') || this.peekOp('-')) {
      const op = this.consume().op;
      const right = this.parseTerm();
      left = op === '+' ? left + right : left - right;
      this.checkMagnitude(left);
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    while (this.peekOp('*') || this.peekOp('/')) {
      const op = this.consume().op;
      const right = this.parseFactor();
      if (op === '/') {
        if (right === 0) {
          throw new ToolExecutionError('Division by zero', { code: 'CALCULATOR_DIVISION_BY_ZERO' });
        }
        left = left / right;
      } else {
        left = left * right;
      }
      this.checkMagnitude(left);
    }
    return left;
  }

  private parseFactor(): number {
    if (this.peekOp('+') || this.peekOp('-')) {
      const sign = this.consume().op === '-' ? -1 : 1;
      return sign * this.parseFactor();
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parseAtom();
    if (this.peekOp('^')) {
      this.consume();
      const exponent = this.parsePower();
      if (exponent < 0 || !Number.isInteger(exponent) || exponent > 10) {
        throw new ToolExecutionError('Invalid exponent', { code: 'CALCULATOR_INVALID_EXPONENT' });
      }
      const result = Math.pow(base, exponent);
      this.checkMagnitude(result);
      return result;
    }
    return base;
  }

  private parseAtom(): number {
    const token = this.tokens[this.pos];
    if (token === undefined) {
      throw new ToolValidationError('Unexpected end of expression', {
        code: 'CALCULATOR_UNEXPECTED_END',
      });
    }
    if (token.kind === 'num') {
      this.pos += 1;
      return token.value;
    }
    if (token.kind === 'lparen') {
      this.pos += 1;
      const value = this.parseExpression();
      if (!this.peekKind('rparen')) {
        throw new ToolValidationError('Missing closing parenthesis', {
          code: 'CALCULATOR_MISSING_PAREN',
        });
      }
      this.pos += 1;
      return value;
    }
    throw new ToolValidationError('Unexpected token', { code: 'CALCULATOR_UNEXPECTED_TOKEN' });
  }

  private peekOp(op: string): boolean {
    const token = this.tokens[this.pos];
    return token !== undefined && token.kind === 'op' && token.op === op;
  }

  private consume(): OpToken {
    const token = this.tokens[this.pos];
    if (token === undefined || token.kind !== 'op') {
      throw new ToolValidationError('Expected operator', { code: 'CALCULATOR_EXPECTED_OPERATOR' });
    }
    this.pos += 1;
    return token;
  }

  private peekKind(kind: 'rparen'): boolean {
    return this.tokens[this.pos]?.kind === kind;
  }

  private checkMagnitude(value: number): void {
    if (!Number.isFinite(value)) {
      throw new ToolExecutionError('Calculator overflow', { code: 'CALCULATOR_OVERFLOW' });
    }
    if (Math.abs(value) > MAX_RESULT_MAGNITUDE) {
      throw new ToolExecutionError('Calculator result exceeds maximum magnitude', {
        code: 'CALCULATOR_OVERFLOW',
      });
    }
  }
}
