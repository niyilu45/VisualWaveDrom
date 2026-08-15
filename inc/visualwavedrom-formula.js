(function (global) {
  'use strict';

  const UNKNOWN = Object.freeze({ unknown: true });
  const DERIVED_CACHE_PROTOCOL = 1;
  const DEFAULT_FORMULA_CHUNK_SIZE = 32768;
  const DEFAULT_PARALLEL_THRESHOLD = 16384;
  const COMPACT_DATA_LABEL_THRESHOLD = 2000;
  const MAX_DERIVED_CACHE_SAMPLES = 2000000;
  const derivedResultCache = new Map();
  let derivedResultCacheSamples = 0;
  const ALLOWED_LIBRARIES = new Set(['math', 'cmath', 'numpy']);
  const BUILTIN_FUNCTIONS = new Set([
    'abs', 'bool', 'complex', 'float', 'int', 'max', 'min', 'pow', 'round'
  ]);
  const MATH_FUNCTIONS = new Set([
    'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'ceil', 'copysign',
    'cos', 'cosh', 'degrees', 'exp', 'expm1', 'fabs', 'factorial', 'floor', 'fmod',
    'hypot', 'isfinite', 'isinf', 'isnan', 'log', 'log10', 'log1p', 'log2', 'pow',
    'radians', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'
  ]);
  const CMATH_FUNCTIONS = new Set([
    'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'cos', 'cosh', 'exp',
    'isclose', 'isfinite', 'isinf', 'isnan', 'log', 'log10', 'phase', 'polar',
    'rect', 'sin', 'sinh', 'sqrt', 'tan', 'tanh'
  ]);
  const MATH_CONSTANTS = new Set(['e', 'inf', 'nan', 'pi', 'tau']);
  const NUMPY_FUNCTIONS = new Set([
    'abs', 'absolute', 'acos', 'acosh', 'arccos', 'arccosh', 'arcsin', 'arcsinh',
    'arctan', 'arctan2', 'arctanh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
    'ceil', 'clip', 'cos', 'cosh', 'deg2rad', 'degrees', 'exp', 'expm1', 'fabs',
    'floor', 'fmod', 'hypot', 'isfinite', 'isinf', 'isnan', 'log', 'log10',
    'log1p', 'log2', 'maximum', 'minimum', 'power', 'rad2deg', 'radians', 'rint',
    'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'
  ]);
  const NUMPY_CONSTANTS = new Set(['e', 'euler_gamma', 'inf', 'nan', 'pi']);

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function isSampleSequence(value) {
    return Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value));
  }

  function stableHash(value) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    const seen = new Set();
    function update(text) {
      const source = String(text);
      for (let index = 0; index < source.length; index += 1) {
        const code = source.charCodeAt(index);
        first ^= code;
        first = Math.imul(first, 0x01000193);
        second ^= code + ((second << 6) >>> 0) + (second >>> 2);
        second = Math.imul(second, 0x85ebca6b);
      }
    }
    function visit(candidate) {
      if (candidate == null) {
        update(candidate === null ? 'null;' : 'undefined;');
        return;
      }
      const type = typeof candidate;
      if (type === 'number') {
        update(Number.isNaN(candidate) ? 'number:nan;' : ('number:' + candidate + ';'));
        return;
      }
      if (type === 'string' || type === 'boolean' || type === 'bigint') {
        update(type + ':' + String(candidate).length + ':' + String(candidate) + ';');
        return;
      }
      if (ArrayBuffer.isView(candidate)) {
        update('typed:' + candidate.constructor.name + ':' + candidate.length + '[');
        for (let index = 0; index < candidate.length; index += 1) visit(candidate[index]);
        update('];');
        return;
      }
      if (Array.isArray(candidate)) {
        update('array:' + candidate.length + '[');
        candidate.forEach(visit);
        update('];');
        return;
      }
      if (type !== 'object') {
        update(type + ':' + String(candidate) + ';');
        return;
      }
      if (seen.has(candidate)) {
        update('circular;');
        return;
      }
      seen.add(candidate);
      const keys = Object.keys(candidate).sort();
      update('object:' + keys.length + '{');
      keys.forEach((key) => {
        update(key.length + ':' + key + '=');
        visit(candidate[key]);
      });
      update('};');
      seen.delete(candidate);
    }
    visit(value);
    return (first >>> 0).toString(16).padStart(8, '0')
      + (second >>> 0).toString(16).padStart(8, '0');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function syntaxError(message, position) {
    const error = new Error(message + (Number.isInteger(position) ? '（位置 ' + (position + 1) + '）' : ''));
    error.position = Number.isInteger(position) ? position : -1;
    return error;
  }

  function normalizeDefinition(value) {
    const source = typeof value === 'string'
      ? { cycle0: value }
      : (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const cycle0 = String(
      source.cycle0 == null
        ? (source['0 cycle'] == null ? (source.at0 == null ? '' : source.at0) : source['0 cycle'])
        : source.cycle0
    );
    const cycle05 = String(
      source.cycle05 == null
        ? (source.cycle0_5 == null
          ? (source['0.5 cycle'] == null ? (source.at05 == null ? '' : source.at05) : source['0.5 cycle'])
          : source.cycle0_5)
        : source.cycle05
    );
    const libraries = Array.from(new Set(
      (Array.isArray(source.libraries) ? source.libraries : [])
        .map((name) => String(name || '').trim().toLowerCase())
        .filter(Boolean)
    ));
    const unsupported = libraries.filter((name) => !ALLOWED_LIBRARIES.has(name));
    if (unsupported.length) {
      throw new Error('不支持的依赖库：' + unsupported.join('、') + '；当前仅支持 math、cmath 和 numpy');
    }
    return { cycle0, cycle05, libraries };
  }

  class Tokenizer {
    constructor(text) {
      this.text = String(text || '');
      this.index = 0;
      this.tokens = [];
    }

    tokenize() {
      while (this.index < this.text.length) {
        const character = this.text[this.index];
        if (/\s/.test(character)) {
          this.index += 1;
          continue;
        }
        if (character === '#') {
          while (this.index < this.text.length && this.text[this.index] !== '\n') this.index += 1;
          continue;
        }
        if (character === '{') {
          this.tokens.push(this.readReference());
          continue;
        }
        if (character === '"' || character === "'") {
          this.tokens.push(this.readString());
          continue;
        }
        const numberMatch = this.text.slice(this.index).match(
          /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:[jJ])?/
        );
        if (numberMatch) {
          const start = this.index;
          this.index += numberMatch[0].length;
          this.tokens.push({ type: 'number', value: numberMatch[0], start, end: this.index });
          continue;
        }
        const identifierMatch = this.text.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (identifierMatch) {
          const start = this.index;
          this.index += identifierMatch[0].length;
          this.tokens.push({ type: 'identifier', value: identifierMatch[0], start, end: this.index });
          continue;
        }
        const operator = ['**', '//', '<=', '>=', '==', '!='].find(
          (candidate) => this.text.slice(this.index, this.index + candidate.length) === candidate
        );
        if (operator) {
          const start = this.index;
          this.index += operator.length;
          this.tokens.push({ type: 'operator', value: operator, start, end: this.index });
          continue;
        }
        if ('+-*/%<>().,'.includes(character)) {
          const start = this.index;
          this.index += 1;
          this.tokens.push({
            type: '(),.'.includes(character) ? 'punctuation' : 'operator',
            value: character,
            start,
            end: this.index
          });
          continue;
        }
        throw syntaxError('无法识别的字符 ' + JSON.stringify(character), this.index);
      }
      this.tokens.push({ type: 'eof', value: '', start: this.text.length, end: this.text.length });
      return this.tokens;
    }

    readReference() {
      const start = this.index;
      const closing = this.text.indexOf('}', start + 1);
      if (closing < 0) throw syntaxError('变量缺少右花括号 }', start);
      let body = this.text.slice(start + 1, closing).trim();
      let offsetText = null;
      const innerOffset = body.match(/^(.*)\[\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)?)\s*\]$/s);
      if (innerOffset) {
        body = innerOffset[1].trim();
        offsetText = innerOffset[2];
      }
      this.index = closing + 1;
      if (this.text[this.index] === '[') {
        if (offsetText !== null) throw syntaxError('变量偏移只能写一次', this.index);
        const offsetEnd = this.text.indexOf(']', this.index + 1);
        if (offsetEnd < 0) throw syntaxError('变量偏移缺少右方括号 ]', this.index);
        offsetText = this.text.slice(this.index + 1, offsetEnd).trim();
        this.index = offsetEnd + 1;
      }
      if (!body) throw syntaxError('变量名不能为空', start);
      const offset = offsetText == null || offsetText === '' ? 0 : Number(offsetText);
      if (!Number.isFinite(offset)) throw syntaxError('变量偏移必须是数字', start);
      if (Math.abs(offset * 2 - Math.round(offset * 2)) > 1e-9) {
        throw syntaxError('变量偏移必须以 0.5 cycle 为颗粒度', start);
      }
      return {
        type: 'reference',
        value: body,
        offset,
        start,
        end: this.index,
        raw: this.text.slice(start, this.index)
      };
    }

    readString() {
      const start = this.index;
      const quote = this.text[this.index++];
      let result = '';
      while (this.index < this.text.length) {
        const character = this.text[this.index++];
        if (character === quote) {
          return { type: 'string', value: result, start, end: this.index };
        }
        if (character !== '\\') {
          result += character;
          continue;
        }
        if (this.index >= this.text.length) break;
        const escaped = this.text[this.index++];
        const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
        result += own(escapes, escaped) ? escapes[escaped] : escaped;
      }
      throw syntaxError('字符串缺少结束引号', start);
    }
  }

  class Parser {
    constructor(text) {
      this.text = String(text || '');
      this.tokens = new Tokenizer(this.text).tokenize();
      this.index = 0;
    }

    current() {
      return this.tokens[this.index];
    }

    consume(value) {
      const token = this.current();
      if (token && token.value === value) {
        this.index += 1;
        return token;
      }
      return null;
    }

    consumeIdentifier(value) {
      const token = this.current();
      if (token && token.type === 'identifier' && token.value === value) {
        this.index += 1;
        return token;
      }
      return null;
    }

    expect(value, message) {
      const token = this.consume(value);
      if (!token) throw syntaxError(message || ('需要 ' + value), this.current().start);
      return token;
    }

    parse() {
      const expression = this.parseConditional();
      if (this.current().type !== 'eof') {
        throw syntaxError('公式末尾存在多余内容', this.current().start);
      }
      return { ast: expression, tokens: this.tokens.filter((token) => token.type !== 'eof') };
    }

    parseConditional() {
      const yes = this.parseOr();
      if (!this.consumeIdentifier('if')) return yes;
      const condition = this.parseOr();
      if (!this.consumeIdentifier('else')) {
        throw syntaxError('条件表达式缺少 else', this.current().start);
      }
      return { type: 'conditional', condition, yes, no: this.parseConditional() };
    }

    parseOr() {
      let node = this.parseAnd();
      while (this.consumeIdentifier('or')) {
        node = { type: 'binary', operator: 'or', left: node, right: this.parseAnd() };
      }
      return node;
    }

    parseAnd() {
      let node = this.parseNot();
      while (this.consumeIdentifier('and')) {
        node = { type: 'binary', operator: 'and', left: node, right: this.parseNot() };
      }
      return node;
    }

    parseNot() {
      if (this.consumeIdentifier('not')) {
        return { type: 'unary', operator: 'not', value: this.parseNot() };
      }
      return this.parseComparison();
    }

    parseComparison() {
      let node = this.parseSum();
      const comparisons = [];
      while (['<', '<=', '>', '>=', '==', '!='].includes(this.current().value)) {
        const operator = this.current().value;
        this.index += 1;
        comparisons.push({ operator, right: this.parseSum() });
      }
      if (!comparisons.length) return node;
      let combined = null;
      let left = node;
      comparisons.forEach((comparison) => {
        const next = { type: 'binary', operator: comparison.operator, left, right: comparison.right };
        combined = combined
          ? { type: 'binary', operator: 'and', left: combined, right: next }
          : next;
        left = comparison.right;
      });
      return combined;
    }

    parseSum() {
      let node = this.parseProduct();
      while (this.current().value === '+' || this.current().value === '-') {
        const operator = this.current().value;
        this.index += 1;
        node = { type: 'binary', operator, left: node, right: this.parseProduct() };
      }
      return node;
    }

    parseProduct() {
      let node = this.parseUnary();
      while (['*', '/', '//', '%'].includes(this.current().value)) {
        const operator = this.current().value;
        this.index += 1;
        node = { type: 'binary', operator, left: node, right: this.parseUnary() };
      }
      return node;
    }

    parseUnary() {
      if (this.current().value === '+' || this.current().value === '-') {
        const operator = this.current().value;
        this.index += 1;
        return { type: 'unary', operator, value: this.parseUnary() };
      }
      return this.parsePower();
    }

    parsePower() {
      let node = this.parsePostfix();
      if (this.consume('**')) {
        node = { type: 'binary', operator: '**', left: node, right: this.parseUnary() };
      }
      return node;
    }

    parsePostfix() {
      let node = this.parsePrimary();
      while (true) {
        if (this.consume('.')) {
          const property = this.current();
          if (!property || property.type !== 'identifier') {
            throw syntaxError('点号后需要名称', this.current().start);
          }
          this.index += 1;
          node = { type: 'attribute', object: node, property: property.value };
          continue;
        }
        if (this.consume('(')) {
          const args = [];
          if (!this.consume(')')) {
            do {
              args.push(this.parseConditional());
            } while (this.consume(','));
            this.expect(')', '函数调用缺少右括号 )');
          }
          node = { type: 'call', target: node, args };
          continue;
        }
        return node;
      }
    }

    parsePrimary() {
      const token = this.current();
      if (token.type === 'number') {
        this.index += 1;
        if (/[jJ]$/.test(token.value)) {
          return { type: 'literal', value: complex(0, Number(token.value.slice(0, -1))) };
        }
        return { type: 'literal', value: Number(token.value) };
      }
      if (token.type === 'string') {
        this.index += 1;
        return { type: 'literal', value: token.value };
      }
      if (token.type === 'reference') {
        this.index += 1;
        return { type: 'reference', name: token.value, offset: token.offset, token };
      }
      if (token.type === 'identifier') {
        this.index += 1;
        if (token.value === 'True') return { type: 'literal', value: true };
        if (token.value === 'False') return { type: 'literal', value: false };
        if (token.value === 'None' || token.value === 'x') return { type: 'literal', value: UNKNOWN };
        return { type: 'name', name: token.value, token };
      }
      if (this.consume('(')) {
        const node = this.parseConditional();
        this.expect(')', '公式缺少右括号 )');
        return node;
      }
      throw syntaxError('此处需要数值、变量或子表达式', token.start);
    }
  }

  function complex(real, imaginary) {
    return { complex: true, re: Number(real) || 0, im: Number(imaginary) || 0 };
  }

  function isComplex(value) {
    return !!(value && value.complex === true && Number.isFinite(value.re) && Number.isFinite(value.im));
  }

  function parseComplexText(value) {
    if (typeof value !== 'string') return null;
    let text = value.trim().replace(/\s+/g, '');
    if (text[0] === '(' && text[text.length - 1] === ')') text = text.slice(1, -1);
    if (!/[ij]$/i.test(text)) return null;
    const body = text.slice(0, -1);
    let separator = -1;
    for (let index = body.length - 1; index > 0; index -= 1) {
      if ((body[index] === '+' || body[index] === '-')
          && body[index - 1] !== 'e' && body[index - 1] !== 'E') {
        separator = index;
        break;
      }
    }
    const realText = separator >= 0 ? body.slice(0, separator) : '0';
    let imaginaryText = separator >= 0 ? body.slice(separator) : body;
    if (imaginaryText === '' || imaginaryText === '+') imaginaryText = '1';
    if (imaginaryText === '-') imaginaryText = '-1';
    const real = Number(realText);
    const imaginary = Number(imaginaryText);
    return Number.isFinite(real) && Number.isFinite(imaginary)
      ? complex(real, imaginary)
      : null;
  }

  function asComplex(value) {
    if (isComplex(value)) return value;
    const parsed = parseComplexText(value);
    if (parsed) return parsed;
    const number = Number(value);
    return Number.isFinite(number) ? complex(number, 0) : null;
  }

  function isUnknown(value) {
    return value === UNKNOWN || !!(value && value.unknown === true);
  }

  function complexAdd(a, b) {
    return complex(a.re + b.re, a.im + b.im);
  }

  function complexMultiply(a, b) {
    return complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  }

  function complexDivide(a, b) {
    const denominator = b.re * b.re + b.im * b.im;
    if (!denominator) return UNKNOWN;
    return complex(
      (a.re * b.re + a.im * b.im) / denominator,
      (a.im * b.re - a.re * b.im) / denominator
    );
  }

  function complexMagnitude(value) {
    return Math.hypot(value.re, value.im);
  }

  function complexExp(value) {
    const scale = Math.exp(value.re);
    return complex(scale * Math.cos(value.im), scale * Math.sin(value.im));
  }

  function complexLog(value) {
    return complex(Math.log(complexMagnitude(value)), Math.atan2(value.im, value.re));
  }

  function complexPow(a, b) {
    if (a.re === 0 && a.im === 0) return b.re === 0 && b.im === 0 ? complex(1, 0) : complex(0, 0);
    return complexExp(complexMultiply(complexLog(a), b));
  }

  function complexSqrt(value) {
    const magnitude = complexMagnitude(value);
    const sign = value.im < 0 ? -1 : 1;
    return complex(
      Math.sqrt(Math.max(0, (magnitude + value.re) / 2)),
      sign * Math.sqrt(Math.max(0, (magnitude - value.re) / 2))
    );
  }

  function complexSin(value) {
    return complex(Math.sin(value.re) * Math.cosh(value.im), Math.cos(value.re) * Math.sinh(value.im));
  }

  function complexCos(value) {
    return complex(Math.cos(value.re) * Math.cosh(value.im), -Math.sin(value.re) * Math.sinh(value.im));
  }

  function complexScale(value, factor) {
    return complex(value.re * factor, value.im * factor);
  }

  function complexSubtract(a, b) {
    return complex(a.re - b.re, a.im - b.im);
  }

  function complexSinh(value) {
    return complex(Math.sinh(value.re) * Math.cos(value.im), Math.cosh(value.re) * Math.sin(value.im));
  }

  function complexCosh(value) {
    return complex(Math.cosh(value.re) * Math.cos(value.im), Math.sinh(value.re) * Math.sin(value.im));
  }

  function complexAsin(value) {
    const iValue = complex(-value.im, value.re);
    const inside = complexAdd(iValue, complexSqrt(complexSubtract(
      complex(1, 0), complexMultiply(value, value)
    )));
    const logged = complexLog(inside);
    return complex(logged.im, -logged.re);
  }

  function complexAcos(value) {
    return complexSubtract(complex(Math.PI / 2, 0), complexAsin(value));
  }

  function complexAtan(value) {
    const iValue = complex(-value.im, value.re);
    const left = complexLog(complexSubtract(complex(1, 0), iValue));
    const right = complexLog(complexAdd(complex(1, 0), iValue));
    const difference = complexSubtract(left, right);
    return complexScale(complex(-difference.im, difference.re), 0.5);
  }

  function complexAsinh(value) {
    return complexLog(complexAdd(value, complexSqrt(complexAdd(
      complexMultiply(value, value), complex(1, 0)
    ))));
  }

  function complexAcosh(value) {
    return complexLog(complexAdd(value, complexMultiply(
      complexSqrt(complexAdd(value, complex(1, 0))),
      complexSqrt(complexSubtract(value, complex(1, 0)))
    )));
  }

  function complexAtanh(value) {
    return complexScale(complexSubtract(
      complexLog(complexAdd(complex(1, 0), value)),
      complexLog(complexSubtract(complex(1, 0), value))
    ), 0.5);
  }

  function validateAst(node, context, state) {
    if (!node) return;
    if (node.type === 'reference') {
      const requested = node.name === 'self' ? context.selfName : node.name;
      if (!requested || !context.knownNames.has(requested)) {
        state.errors.push('找不到变量：' + node.name);
        node.token.valid = false;
        return;
      }
      node.resolvedName = requested;
      node.token.valid = true;
      state.references.add(requested);
      if (requested !== context.selfName && context.formulaNames.has(requested)) {
        state.dependencies.add(requested);
      }
      return;
    }
    if (node.type === 'name') {
      if (!BUILTIN_FUNCTIONS.has(node.name) && !ALLOWED_LIBRARIES.has(node.name)) {
        state.errors.push('名称 ' + node.name + ' 不可用；信号变量需要写在 {} 中');
      }
      return;
    }
    if (node.type === 'attribute') {
      if (!node.object || node.object.type !== 'name'
          || !ALLOWED_LIBRARIES.has(node.object.name)) {
        state.errors.push('只允许访问 math、cmath 或 numpy 的成员');
        return;
      }
      const library = node.object.name;
      const allowed = library === 'math'
        ? (MATH_FUNCTIONS.has(node.property) || MATH_CONSTANTS.has(node.property))
        : (library === 'cmath'
          ? CMATH_FUNCTIONS.has(node.property)
          : (NUMPY_FUNCTIONS.has(node.property) || NUMPY_CONSTANTS.has(node.property)));
      if (!allowed) state.errors.push(library + ' 不支持成员 ' + node.property);
      state.libraries.add(library);
      return;
    }
    if (node.type === 'call') {
      if (node.target.type === 'name') {
        if (!BUILTIN_FUNCTIONS.has(node.target.name)) {
          state.errors.push('不支持函数 ' + node.target.name);
        }
      } else if (node.target.type === 'attribute') {
        validateAst(node.target, context, state);
      } else {
        state.errors.push('只允许调用受支持的内置函数、math、cmath 或 numpy 函数');
      }
      node.args.forEach((argument) => validateAst(argument, context, state));
      return;
    }
    ['left', 'right', 'value', 'condition', 'yes', 'no'].forEach((key) => {
      if (node[key]) validateAst(node[key], context, state);
    });
  }

  function referencePython(token) {
    const offset = Number(token.offset) || 0;
    const position = offset === 0
      ? 'cycle'
      : ('cycle ' + (offset > 0 ? '+ ' : '- ') + Math.abs(offset));
    return 'sample(' + JSON.stringify(token.value) + ', ' + position + ')';
  }

  function compileExpression(text, context) {
    const source = String(text || '').trim();
    if (!source) return null;
    const parsed = new Parser(source).parse();
    const state = {
      errors: [],
      references: new Set(),
      dependencies: new Set(),
      libraries: new Set()
    };
    validateAst(parsed.ast, context, state);
    if (state.errors.length) throw new Error(Array.from(new Set(state.errors)).join('；'));
    const references = parsed.tokens.filter((token) => token.type === 'reference');
    let cursor = 0;
    let pythonExpression = '';
    references.forEach((token) => {
      pythonExpression += source.slice(cursor, token.start) + referencePython(token);
      cursor = token.end;
    });
    pythonExpression += source.slice(cursor);
    return {
      source,
      ast: parsed.ast,
      tokens: parsed.tokens,
      references: Array.from(state.references),
      dependencies: Array.from(state.dependencies),
      libraries: Array.from(state.libraries),
      pythonExpression
    };
  }

  function analyzeDefinitions(definitions, signalNames) {
    const normalized = (Array.isArray(definitions) ? definitions : []).map((entry, index) => {
      const name = String(entry && entry.name || '').trim();
      let formula;
      let normalizeError = '';
      try {
        formula = normalizeDefinition(entry && own(entry, 'formula') ? entry.formula : entry);
      } catch (error) {
        formula = { cycle0: '', cycle05: '', libraries: [] };
        normalizeError = error.message || String(error);
      }
      return { index, id: String(entry && entry.id || index), name, formula, normalizeError };
    });
    const knownNames = new Set((Array.isArray(signalNames) ? signalNames : [])
      .map((name) => String(name || '').trim()).filter(Boolean));
    const formulaNames = new Set();
    const duplicateNames = new Set();
    normalized.forEach((entry) => {
      if (!entry.name) return;
      if (formulaNames.has(entry.name)) duplicateNames.add(entry.name);
      formulaNames.add(entry.name);
      knownNames.add(entry.name);
    });
    const items = normalized.map((entry) => {
      const errors = [];
      if (!entry.name) errors.push('公式信号名不能为空');
      if (duplicateNames.has(entry.name)) errors.push('公式信号名重复：' + entry.name);
      if (entry.normalizeError) errors.push(entry.normalizeError);
      const context = { selfName: entry.name, knownNames, formulaNames };
      let cycle0 = null;
      let cycle05 = null;
      try { cycle0 = compileExpression(entry.formula.cycle0, context); } catch (error) {
        errors.push('0 cycle：' + (error.message || String(error)));
      }
      try { cycle05 = compileExpression(entry.formula.cycle05, context); } catch (error) {
        errors.push('0.5 cycle：' + (error.message || String(error)));
      }
      const effective0 = cycle0 || cycle05;
      const effective05 = cycle05 || cycle0;
      const libraries = new Set(entry.formula.libraries);
      const references = new Set();
      const dependencies = new Set();
      [cycle0, cycle05].filter(Boolean).forEach((compiled) => {
        compiled.libraries.forEach((name) => libraries.add(name));
        compiled.references.forEach((name) => references.add(name));
        compiled.dependencies.forEach((name) => dependencies.add(name));
      });
      return Object.assign({}, entry, {
        cycle0,
        cycle05,
        effective0,
        effective05,
        libraries: Array.from(libraries).sort(),
        references: Array.from(references),
        dependencies: Array.from(dependencies),
        errors
      });
    });

    const itemByName = new Map(items.filter((item) => item.name).map((item) => [item.name, item]));
    const colors = new Map();
    const stack = [];
    const cycleMessages = new Map();
    function visit(name) {
      const color = colors.get(name) || 0;
      if (color === 2) return;
      if (color === 1) {
        const start = stack.indexOf(name);
        const cycle = stack.slice(start).concat(name);
        const message = '公式循环依赖：' + cycle.join(' -> ');
        cycle.slice(0, -1).forEach((cycleName) => cycleMessages.set(cycleName, message));
        return;
      }
      colors.set(name, 1);
      stack.push(name);
      const item = itemByName.get(name);
      (item ? item.dependencies : []).forEach((dependency) => {
        if (itemByName.has(dependency)) visit(dependency);
      });
      stack.pop();
      colors.set(name, 2);
    }
    itemByName.forEach((_item, name) => visit(name));
    items.forEach((item) => {
      if (cycleMessages.has(item.name)) item.errors.push(cycleMessages.get(item.name));
      item.errors = Array.from(new Set(item.errors));
      item.error = item.errors.join('；');
      item.valid = !item.error;
    });
    return {
      valid: items.every((item) => item.valid),
      items,
      byName: itemByName
    };
  }

  function dependencyLayers(analysis) {
    const source = analysis && Array.isArray(analysis.items) ? analysis.items : [];
    const validByName = new Map(source.filter((item) => item.valid && item.name)
      .map((item) => [item.name, item]));
    const depthByName = new Map();
    function depth(item) {
      if (!item || !item.valid) return 0;
      if (depthByName.has(item.name)) return depthByName.get(item.name);
      let value = 0;
      (item.dependencies || []).forEach((name) => {
        const dependency = validByName.get(name);
        if (dependency) value = Math.max(value, depth(dependency) + 1);
      });
      depthByName.set(item.name, value);
      return value;
    }
    const layers = [];
    source.forEach((item) => {
      if (!item.valid) return;
      const index = depth(item);
      if (!layers[index]) layers[index] = [];
      layers[index].push(item);
    });
    return layers.filter(Boolean);
  }

  function evalBinary(operator, left, right) {
    if (isUnknown(left) || isUnknown(right)) return UNKNOWN;
    if (operator === 'and') return left ? right : left;
    if (operator === 'or') return left ? left : right;
    if (['==', '!=', '<', '<=', '>', '>='].includes(operator)) {
      if (isComplex(left) || isComplex(right)) {
        const a = asComplex(left);
        const b = asComplex(right);
        if (!a || !b) return UNKNOWN;
        const equal = a.re === b.re && a.im === b.im;
        if (operator === '==') return equal;
        if (operator === '!=') return !equal;
        return UNKNOWN;
      }
      if (operator === '==') return left === right || Number(left) === Number(right);
      if (operator === '!=') return !(left === right || Number(left) === Number(right));
      if (operator === '<') return left < right;
      if (operator === '<=') return left <= right;
      if (operator === '>') return left > right;
      return left >= right;
    }
    if (isComplex(left) || isComplex(right)) {
      const a = asComplex(left);
      const b = asComplex(right);
      if (!a || !b) return UNKNOWN;
      if (operator === '+') return complexAdd(a, b);
      if (operator === '-') return complexAdd(a, complex(-b.re, -b.im));
      if (operator === '*') return complexMultiply(a, b);
      if (operator === '/') return complexDivide(a, b);
      if (operator === '**') return complexPow(a, b);
      return UNKNOWN;
    }
    const a = Number(left);
    const b = Number(right);
    if (operator === '+' && (!Number.isFinite(a) || !Number.isFinite(b))
        && (typeof left === 'string' || typeof right === 'string')) {
      return String(left) + String(right);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) return UNKNOWN;
    if (operator === '+') return a + b;
    if (operator === '-') return a - b;
    if (operator === '*') return a * b;
    if (operator === '/') return b === 0 ? UNKNOWN : a / b;
    if (operator === '//') return b === 0 ? UNKNOWN : Math.floor(a / b);
    if (operator === '%') return b === 0 ? UNKNOWN : ((a % b) + b) % b;
    if (operator === '**') return Math.pow(a, b);
    return UNKNOWN;
  }

  function factorial(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 170) return UNKNOWN;
    let result = 1;
    for (let index = 2; index <= number; index += 1) result *= index;
    return result;
  }

  function callBuiltin(name, args) {
    if (args.some(isUnknown)) return UNKNOWN;
    if (name === 'abs') {
      const value = asComplex(args[0]);
      return value ? complexMagnitude(value) : UNKNOWN;
    }
    if (name === 'bool') return !!args[0];
    if (name === 'complex') return complex(Number(args[0]) || 0, Number(args[1]) || 0);
    if (name === 'float') return Number(args[0]);
    if (name === 'int') return Math.trunc(Number(args[0]));
    if (name === 'max') return Math.max.apply(Math, args.map(Number));
    if (name === 'min') return Math.min.apply(Math, args.map(Number));
    if (name === 'pow') return evalBinary('**', args[0], args[1]);
    if (name === 'round') {
      const digits = args.length > 1 ? Math.trunc(Number(args[1])) : 0;
      const factor = Math.pow(10, digits);
      return Math.round(Number(args[0]) * factor) / factor;
    }
    return UNKNOWN;
  }

  function callMath(name, args) {
    if (args.some(isUnknown) || args.some(isComplex)) return UNKNOWN;
    const values = args.map(Number);
    if (name === 'isfinite') return Number.isFinite(values[0]);
    if (name === 'isinf') return !Number.isNaN(values[0]) && !Number.isFinite(values[0]);
    if (name === 'isnan') return Number.isNaN(values[0]);
    if (values.some((value) => !Number.isFinite(value))) return UNKNOWN;
    if (name === 'factorial') return factorial(values[0]);
    if (name === 'copysign') return Math.abs(values[0]) * (values[1] < 0 || Object.is(values[1], -0) ? -1 : 1);
    if (name === 'degrees') return values[0] * 180 / Math.PI;
    if (name === 'radians') return values[0] * Math.PI / 180;
    if (name === 'fabs') return Math.abs(values[0]);
    if (name === 'fmod') return values[0] % values[1];
    if (name === 'log' && values.length > 1) return Math.log(values[0]) / Math.log(values[1]);
    const functionName = name === 'ln' ? 'log' : name;
    return typeof Math[functionName] === 'function'
      ? Math[functionName].apply(Math, values)
      : UNKNOWN;
  }

  function callNumpy(name, args) {
    if (args.some(isUnknown)) return UNKNOWN;
    if (name === 'abs' || name === 'absolute') {
      const value = asComplex(args[0]);
      return value ? complexMagnitude(value) : UNKNOWN;
    }
    if (args.some(isComplex)) return UNKNOWN;
    const values = args.map(Number);
    if (name === 'isfinite') return Number.isFinite(values[0]);
    if (name === 'isinf') return !Number.isNaN(values[0]) && !Number.isFinite(values[0]);
    if (name === 'isnan') return Number.isNaN(values[0]);
    if (values.some((value) => !Number.isFinite(value))) return UNKNOWN;
    if (name === 'fabs') return Math.abs(values[0]);
    if (name === 'clip') return Math.min(Math.max(values[0], values[1]), values[2]);
    if (name === 'maximum') return Math.max(values[0], values[1]);
    if (name === 'minimum') return Math.min(values[0], values[1]);
    if (name === 'power') return Math.pow(values[0], values[1]);
    if (name === 'sign') return Math.sign(values[0]);
    if (name === 'rint') return Math.round(values[0]);
    if (name === 'round') {
      const digits = values.length > 1 ? Math.trunc(values[1]) : 0;
      const factor = Math.pow(10, digits);
      return Math.round(values[0] * factor) / factor;
    }
    const aliases = {
      arccos: 'acos',
      arccosh: 'acosh',
      arcsin: 'asin',
      arcsinh: 'asinh',
      arctan: 'atan',
      arctan2: 'atan2',
      arctanh: 'atanh',
      deg2rad: 'radians',
      rad2deg: 'degrees'
    };
    return callMath(aliases[name] || name, values);
  }

  function callCmath(name, args) {
    if (args.some(isUnknown)) return UNKNOWN;
    const value = asComplex(args[0]);
    if (!value && name !== 'rect') return UNKNOWN;
    if (name === 'phase') return Math.atan2(value.im, value.re);
    if (name === 'polar') return complexMagnitude(value) + ',' + Math.atan2(value.im, value.re);
    if (name === 'rect') {
      const radius = Number(args[0]);
      const angle = Number(args[1]);
      return Number.isFinite(radius) && Number.isFinite(angle)
        ? complex(radius * Math.cos(angle), radius * Math.sin(angle))
        : UNKNOWN;
    }
    if (name === 'sqrt') return complexSqrt(value);
    if (name === 'asin') return complexAsin(value);
    if (name === 'acos') return complexAcos(value);
    if (name === 'atan') return complexAtan(value);
    if (name === 'asinh') return complexAsinh(value);
    if (name === 'acosh') return complexAcosh(value);
    if (name === 'atanh') return complexAtanh(value);
    if (name === 'exp') return complexExp(value);
    if (name === 'log') {
      const result = complexLog(value);
      return args.length > 1 ? complexDivide(result, complexLog(asComplex(args[1]))) : result;
    }
    if (name === 'log10') return complexDivide(complexLog(value), complex(Math.log(10), 0));
    if (name === 'sin') return complexSin(value);
    if (name === 'cos') return complexCos(value);
    if (name === 'tan') return complexDivide(complexSin(value), complexCos(value));
    if (name === 'sinh') return complexSinh(value);
    if (name === 'cosh') return complexCosh(value);
    if (name === 'tanh') return complexDivide(complexSinh(value), complexCosh(value));
    if (name === 'isfinite') return Number.isFinite(value.re) && Number.isFinite(value.im);
    if (name === 'isinf') return !Number.isFinite(value.re) || !Number.isFinite(value.im);
    if (name === 'isnan') return Number.isNaN(value.re) || Number.isNaN(value.im);
    if (name === 'isclose') {
      const other = asComplex(args[1]);
      return !!other && complexMagnitude(complexAdd(value, complex(-other.re, -other.im))) <= 1e-9;
    }
    return UNKNOWN;
  }

  function evaluateAst(node, resolveReference) {
    if (!node) return UNKNOWN;
    if (node.type === 'literal') return node.value;
    if (node.type === 'reference') return resolveReference(node.resolvedName || node.name, node.offset);
    if (node.type === 'name') {
      if (ALLOWED_LIBRARIES.has(node.name)) return node.name;
      return UNKNOWN;
    }
    if (node.type === 'attribute') {
      if (node.object.type === 'name'
          && (node.object.name === 'math' || node.object.name === 'numpy')) {
        if (node.property === 'pi') return Math.PI;
        if (node.property === 'e') return Math.E;
        if (node.property === 'tau') return Math.PI * 2;
        if (node.property === 'euler_gamma') return 0.5772156649015329;
        if (node.property === 'inf') return Number.POSITIVE_INFINITY;
        if (node.property === 'nan') return Number.NaN;
      }
      return UNKNOWN;
    }
    if (node.type === 'unary') {
      const value = evaluateAst(node.value, resolveReference);
      if (isUnknown(value)) return UNKNOWN;
      if (node.operator === 'not') return !value;
      if (isComplex(value)) return node.operator === '-' ? complex(-value.re, -value.im) : value;
      const number = Number(value);
      return Number.isFinite(number) ? (node.operator === '-' ? -number : number) : UNKNOWN;
    }
    if (node.type === 'binary') {
      const left = evaluateAst(node.left, resolveReference);
      if (node.operator === 'and' && !isUnknown(left) && !left) return left;
      if (node.operator === 'or' && !isUnknown(left) && left) return left;
      return evalBinary(node.operator, left, evaluateAst(node.right, resolveReference));
    }
    if (node.type === 'conditional') {
      const condition = evaluateAst(node.condition, resolveReference);
      if (isUnknown(condition)) return UNKNOWN;
      return evaluateAst(condition ? node.yes : node.no, resolveReference);
    }
    if (node.type === 'call') {
      const args = node.args.map((argument) => evaluateAst(argument, resolveReference));
      if (node.target.type === 'name') return callBuiltin(node.target.name, args);
      if (node.target.type === 'attribute' && node.target.object.type === 'name') {
        if (node.target.object.name === 'math') return callMath(node.target.property, args);
        if (node.target.object.name === 'numpy') return callNumpy(node.target.property, args);
        return callCmath(node.target.property, args);
      }
    }
    return UNKNOWN;
  }

  function serializableValue(value) {
    if (isUnknown(value) || value == null) return 'x';
    if (isComplex(value)) {
      const real = Math.abs(value.re) < 1e-14 ? 0 : value.re;
      const imaginary = Math.abs(value.im) < 1e-14 ? 0 : value.im;
      return String(real) + (imaginary < 0 ? '' : '+') + String(imaginary) + 'j';
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 'x';
    return String(value);
  }

  function formulaValueIsUnknown(value) {
    return isUnknown(value) || value == null || value === ''
      || String(value).toLowerCase() === 'x';
  }

  function numericVectorScalar(value) {
    if (formulaValueIsUnknown(value)) return { valid: false, value: 0 };
    if (typeof value === 'boolean') return { valid: true, value: value ? 1 : 0 };
    if (typeof value === 'number') return { valid: true, value };
    return null;
  }

  function createNumericVector(length) {
    return {
      values: new Float64Array(length),
      valid: new Uint8Array(length),
      offset: 0,
      constant: false
    };
  }

  function numericConstant(value, valid) {
    return {
      value: Number(value),
      valid: !!valid,
      offset: 0,
      constant: true
    };
  }

  function storeNumericVectorValue(vector, index, value) {
    const parsed = numericVectorScalar(value);
    if (parsed === null) return false;
    if (parsed.valid) {
      vector.values[index] = parsed.value;
      vector.valid[index] = 1;
    }
    return true;
  }

  function vectorAttributeValue(node) {
    if (!node || node.type !== 'attribute' || !node.object || node.object.type !== 'name') return null;
    if (node.object.name !== 'math' && node.object.name !== 'numpy') return null;
    if (node.property === 'pi') return numericConstant(Math.PI, true);
    if (node.property === 'e') return numericConstant(Math.E, true);
    if (node.property === 'tau') return numericConstant(Math.PI * 2, true);
    if (node.property === 'euler_gamma') return numericConstant(0.5772156649015329, true);
    if (node.property === 'inf') return numericConstant(Number.POSITIVE_INFINITY, true);
    if (node.property === 'nan') return numericConstant(Number.NaN, true);
    return null;
  }

  function vectorCallTarget(node) {
    if (!node || node.type !== 'call' || !node.target) return null;
    if (node.target.type === 'name') {
      if (!BUILTIN_FUNCTIONS.has(node.target.name) || node.target.name === 'complex') return null;
      return (args) => callBuiltin(node.target.name, args);
    }
    if (node.target.type !== 'attribute' || !node.target.object
        || node.target.object.type !== 'name') return null;
    if (node.target.object.name === 'math') {
      return (args) => callMath(node.target.property, args);
    }
    if (node.target.object.name === 'numpy') {
      return (args) => callNumpy(node.target.property, args);
    }
    return null;
  }

  const numericKernelCache = new WeakMap();

  function numericKernelLiteral(value) {
    const parsed = numericVectorScalar(value);
    if (parsed === null) return null;
    if (!parsed.valid) return { valid: 'false', value: '0' };
    if (Number.isNaN(parsed.value)) return { valid: 'true', value: 'Number.NaN' };
    if (parsed.value === Number.POSITIVE_INFINITY) {
      return { valid: 'true', value: 'Number.POSITIVE_INFINITY' };
    }
    if (parsed.value === Number.NEGATIVE_INFINITY) {
      return { valid: 'true', value: 'Number.NEGATIVE_INFINITY' };
    }
    return { valid: 'true', value: JSON.stringify(parsed.value) };
  }

  function compileNumericKernel(compiled, lane) {
    if (!compiled || !compiled.ast) return null;
    let cached = numericKernelCache.get(compiled);
    if (!cached) {
      cached = new Map();
      numericKernelCache.set(compiled, cached);
    }
    if (cached.has(lane)) return cached.get(lane);
    const statements = [];
    const references = [];
    const calls = [];
    let sequence = 0;
    function emit(node) {
      if (!node) return null;
      const id = sequence++;
      const valid = 'k' + id;
      const value = 'v' + id;
      if (node.type === 'literal') {
        const literal = numericKernelLiteral(node.value);
        if (!literal) return null;
        statements.push('let ' + valid + '=' + literal.valid + ',' + value + '=' + literal.value + ';');
        return { valid, value };
      }
      if (node.type === 'reference') {
        const referenceIndex = references.length;
        references.push(node.resolvedName || node.name);
        const offset = Math.round((Number(node.offset) || 0) * 2);
        const target = 't' + id;
        statements.push(
          'const ' + target + '=index' + (offset ? (offset > 0 ? '+' + offset : offset) : '') + ';'
          + 'let ' + valid + '=' + target + '>=0&&' + target + '<length&&refs['
          + referenceIndex + '].valid[' + target + '];'
          + 'let ' + value + '=' + valid + '?refs[' + referenceIndex + '].values[' + target + ']:0;'
        );
        return { valid, value };
      }
      if (node.type === 'attribute') {
        const descriptor = vectorAttributeValue(node);
        if (!descriptor) return null;
        const literal = numericKernelLiteral(descriptor.valid ? descriptor.value : UNKNOWN);
        statements.push('let ' + valid + '=' + literal.valid + ',' + value + '=' + literal.value + ';');
        return { valid, value };
      }
      if (node.type === 'unary') {
        const input = emit(node.value);
        if (!input) return null;
        if (node.operator === 'not') {
          statements.push('let ' + valid + '=' + input.valid + ',' + value + '=' + valid
            + '?(!' + input.value + '?1:0):0;');
        } else {
          statements.push('let ' + valid + '=' + input.valid + '&&Number.isFinite(Number('
            + input.value + ')),' + value + '=' + valid + '?'
            + (node.operator === '-' ? '-' : '+') + input.value + ':0;');
        }
        return { valid, value };
      }
      if (node.type === 'binary') {
        const left = emit(node.left);
        const right = emit(node.right);
        if (!left || !right) return null;
        if (node.operator === 'and') {
          statements.push('let ' + valid + '=' + left.valid + '&&(!' + left.value + '||'
            + right.valid + '),' + value + '=' + left.valid + '?(!' + left.value + '?'
            + left.value + ':' + right.value + '):0;');
        } else if (node.operator === 'or') {
          statements.push('let ' + valid + '=' + left.valid + '&&(' + left.value + '||'
            + right.valid + '),' + value + '=' + left.valid + '?(' + left.value + '?'
            + left.value + ':' + right.value + '):0;');
        } else if (['==', '!=', '<', '<=', '>', '>='].includes(node.operator)) {
          const operator = node.operator === '==' ? '===' : (node.operator === '!=' ? '!==' : node.operator);
          statements.push('let ' + valid + '=' + left.valid + '&&' + right.valid + ',' + value
            + '=' + valid + '?(' + left.value + operator + right.value + '?1:0):0;');
        } else {
          let expression = left.value + node.operator + right.value;
          if (node.operator === '//') expression = 'Math.floor(' + left.value + '/' + right.value + ')';
          if (node.operator === '%') expression = '((' + left.value + '%' + right.value + ')+'
            + right.value + ')%' + right.value;
          if (node.operator === '**') expression = 'Math.pow(' + left.value + ',' + right.value + ')';
          const nonzero = ['/', '//', '%'].includes(node.operator) ? '&&' + right.value + '!==0' : '';
          statements.push('let ' + valid + '=' + left.valid + '&&' + right.valid
            + '&&Number.isFinite(' + left.value + ')&&Number.isFinite(' + right.value + ')'
            + nonzero + ',' + value + '=' + valid + '?' + expression + ':0;');
        }
        return { valid, value };
      }
      if (node.type === 'conditional') {
        const condition = emit(node.condition);
        const yes = emit(node.yes);
        const no = emit(node.no);
        if (!condition || !yes || !no) return null;
        statements.push('let ' + valid + '=' + condition.valid + '&&(' + condition.value + '?'
          + yes.valid + ':' + no.valid + '),' + value + '=' + valid + '?('
          + condition.value + '?' + yes.value + ':' + no.value + '):0;');
        return { valid, value };
      }
      if (node.type === 'call') {
        const invoke = vectorCallTarget(node);
        if (!invoke) return null;
        const args = node.args.map(emit);
        if (args.some((argument) => !argument)) return null;
        const callIndex = calls.length;
        calls.push(invoke);
        const allValid = args.length ? args.map((argument) => argument.valid).join('&&') : 'true';
        const values = args.map((argument) => argument.value).join(',');
        const raw = 'r' + id;
        statements.push('let ' + valid + '=' + allValid + ',' + value + '=0;'
          + 'if(' + valid + '){const ' + raw + '=calls[' + callIndex + ']([' + values + ']);'
          + 'if(' + raw + '===UNKNOWN||' + raw + '==null||(typeof ' + raw
          + '!=="number"&&typeof ' + raw + '!=="boolean")){' + valid + '=false;}'
          + 'else{' + value + '=typeof ' + raw + '==="boolean"?(' + raw + '?1:0):' + raw + ';}}');
        return { valid, value };
      }
      return null;
    }
    const root = emit(compiled.ast);
    if (!root) {
      cached.set(lane, null);
      return null;
    }
    const firstIndex = lane < 0
      ? 'lower'
      : (lane === 1 ? 'lower+((lower&1)?0:1)' : 'lower+(lower&1)');
    const step = lane < 0 ? 1 : 2;
    let run = null;
    try {
      run = Function('calls', 'UNKNOWN', 'return function(refs,result,length,rangeStart,rangeEnd){'
        + 'const outValues=result.values,outValid=result.valid;'
        + 'const lower=Math.max(0,Math.floor(Number(rangeStart)||0));'
        + 'const requestedEnd=rangeEnd==null?length:Math.floor(Number(rangeEnd)||0);'
        + 'const upper=Math.min(length,Math.max(lower,requestedEnd));'
        + 'for(let index=' + firstIndex + ';index<upper;index+=' + step + '){'
        + statements.join('')
        + 'if(' + root.valid + '&&Number.isFinite(' + root.value + ')){outValues[index]='
        + root.value + ';outValid[index]=1;}}}')(calls, UNKNOWN);
    } catch (_error) {
      run = null;
    }
    const kernel = run ? { run, references } : null;
    cached.set(lane, kernel);
    return kernel;
  }

  function materializeNumericVector(length, valueAt) {
    const result = createNumericVector(length);
    for (let index = 0; index < length; index += 1) {
      if (!storeNumericVectorValue(result, index, valueAt(index))) return null;
    }
    return result;
  }

  function evaluateDefinitionVector(item, halfCount, reference, options) {
    const settings = options || {};
    const chunkSize = Math.max(
      1024,
      Math.floor(Number(settings.chunkSize) || DEFAULT_FORMULA_CHUNK_SIZE)
    );
    const result = createNumericVector(halfCount);
    const sameExpression = item.effective0 && item.effective0 === item.effective05;
    const plans = sameExpression
      ? [{ compiled: item.effective0, lane: -1 }]
      : [
        { compiled: item.effective0, lane: 0 },
        { compiled: item.effective05, lane: 1 }
      ];
    for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
      const plan = plans[planIndex];
      if (!plan.compiled) continue;
      const kernel = compileNumericKernel(plan.compiled, plan.lane);
      if (!kernel) return null;
      const references = kernel.references.map((name) => reference(name));
      if (references.some((descriptor) => !descriptor)) return null;
      for (let start = 0; start < halfCount; start += chunkSize) {
        const end = Math.min(halfCount, start + chunkSize);
        kernel.run(references, result, halfCount, start, end);
        if (typeof settings.onChunk === 'function') {
          try {
            settings.onChunk({
              name: item.name,
              lane: plan.lane,
              start,
              end,
              total: halfCount
            });
          } catch (_error) { /* progress must not stop evaluation */ }
        }
      }
    }
    const values = new Array(halfCount);
    const serializedVector = createNumericVector(halfCount);
    let knownCount = 0;
    for (let index = 0; index < halfCount; index += 1) {
      const value = result.valid[index] ? result.values[index] : Number.NaN;
      if (result.valid[index] && Number.isFinite(value)) {
        values[index] = value;
        serializedVector.values[index] = value;
        serializedVector.valid[index] = 1;
        knownCount += 1;
      } else {
        values[index] = 'x';
      }
    }
    return { values, knownCount, numericVector: serializedVector };
  }

  function evaluateDefinitions(definitions, signalNames, options) {
    const settings = options || {};
    const now = () => (typeof performance !== 'undefined' && performance
      && typeof performance.now === 'function' ? performance.now() : Date.now());
    const evaluationStartedAt = now();
    const analysis = settings.analysis || analyzeDefinitions(definitions, signalNames);
    const totalColumns = Math.max(1, Math.ceil(Number(settings.totalColumns) || 1));
    const halfCount = totalColumns * 2;
    const source = typeof settings.resolveSource === 'function'
      ? settings.resolveSource
      : function (name, halfIndex) {
        const values = settings.sources && settings.sources[name];
        return values && halfIndex >= 0 && halfIndex < values.length ? values[halfIndex] : UNKNOWN;
      };
    const outputs = Object.create(null);
    const outputKnownCounts = Object.create(null);
    const reuseOutputs = settings.reuseOutputs || null;
    const reuseKnownCounts = settings.reuseKnownCounts || null;
    const recomputeNames = settings.recomputeNames == null
      ? null
      : new Set(Array.from(settings.recomputeNames).map((name) => String(name || '')));
    const reusedNames = [];
    const vectorizedNames = [];
    const scalarNames = [];
    const evaluationModes = Object.create(null);
    const numericSourceCache = new Map();
    const numericGeneratedCache = new Map();
    const numericOutputs = Object.create(null);
    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    function order(item) {
      if (!item || visited.has(item.name) || visiting.has(item.name)) return;
      visiting.add(item.name);
      item.dependencies.forEach((name) => order(analysis.byName.get(name)));
      visiting.delete(item.name);
      visited.add(item.name);
      ordered.push(item);
    }
    analysis.items.forEach(order);
    const executable = ordered.filter((item) => item.valid);
    const notify = (callback, details) => {
      if (typeof callback !== 'function') return;
      try { callback(details); } catch (_error) { /* progress must not stop evaluation */ }
    };
    const numericSource = (requestedName, itemName) => {
      const hasDirectSource = settings.sources && own(settings.sources, requestedName);
      const independent = hasDirectSource || typeof settings.resolveSource !== 'function'
        || settings.sourceIsConsumerIndependent === true;
      const key = (independent ? '*' : itemName) + '\u0000' + requestedName;
      if (numericSourceCache.has(key)) return numericSourceCache.get(key);
      const directValues = hasDirectSource ? settings.sources[requestedName] : null;
      const vector = materializeNumericVector(halfCount, (halfIndex) => {
        if (directValues) {
          return halfIndex >= 0 && halfIndex < directValues.length
            ? directValues[halfIndex]
            : UNKNOWN;
        }
        return source(requestedName, halfIndex, itemName);
      });
      numericSourceCache.set(key, vector);
      return vector;
    };
    const numericGenerated = (requestedName, itemName) => {
      if (outputKnownCounts[requestedName] > 0 && numericOutputs[requestedName]) {
        return numericOutputs[requestedName];
      }
      const key = requestedName + '\u0000' + itemName;
      if (numericGeneratedCache.has(key)) return numericGeneratedCache.get(key);
      const generated = outputs[requestedName] || [];
      const vector = materializeNumericVector(halfCount, (halfIndex) => {
        const value = halfIndex < generated.length ? generated[halfIndex] : UNKNOWN;
        if (!formulaValueIsUnknown(value)) return value;
        if (outputKnownCounts[requestedName] === 0
            && typeof settings.resolveGeneratedFallback === 'function') {
          const fallback = settings.resolveGeneratedFallback(
            requestedName,
            halfIndex,
            itemName
          );
          return formulaValueIsUnknown(fallback) ? UNKNOWN : fallback;
        }
        return UNKNOWN;
      });
      numericGeneratedCache.set(key, vector);
      return vector;
    };
    const numericReference = (item, requestedName) => {
      if (requestedName !== item.name && own(outputs, requestedName)) {
        return numericGenerated(requestedName, item.name);
      }
      return numericSource(requestedName, item.name);
    };
    executable.forEach((item, formulaIndex) => {
      const itemStartedAt = now();
      const progress = {
        name: item.name,
        index: formulaIndex + 1,
        total: executable.length
      };
      notify(settings.onFormulaStart, progress);
      const reusable = recomputeNames && !recomputeNames.has(item.name)
        && reuseOutputs && Array.isArray(reuseOutputs[item.name])
        && reuseOutputs[item.name].length === halfCount;
      if (reusable) {
        const values = reuseOutputs[item.name];
        outputs[item.name] = values;
        outputKnownCounts[item.name] = reuseKnownCounts
          && Number.isFinite(Number(reuseKnownCounts[item.name]))
          ? Number(reuseKnownCounts[item.name])
          : values.reduce((count, value) => (
            !isUnknown(value) && value != null && value !== ''
              && String(value).toLowerCase() !== 'x' ? count + 1 : count
          ), 0);
        reusedNames.push(item.name);
        evaluationModes[item.name] = 'reused';
        notify(settings.onFormulaComplete, Object.assign({
          reused: true,
          evaluationMode: 'reused',
          durationMs: now() - itemStartedAt
        }, progress));
        return;
      }
      const vectorResult = settings.vectorize === false
        ? null
        : evaluateDefinitionVector(
          item,
          halfCount,
          (requestedName) => numericReference(item, requestedName),
          {
            chunkSize: settings.chunkSize,
            onChunk: settings.onFormulaChunk
          }
        );
      let values;
      if (vectorResult) {
        values = vectorResult.values;
        outputKnownCounts[item.name] = vectorResult.knownCount;
        numericOutputs[item.name] = vectorResult.numericVector;
        vectorizedNames.push(item.name);
        evaluationModes[item.name] = 'vector';
      } else {
        values = new Array(halfCount);
        const chunkSize = Math.max(
          1024,
          Math.floor(Number(settings.chunkSize) || DEFAULT_FORMULA_CHUNK_SIZE)
        );
        for (let chunkStart = 0; chunkStart < halfCount; chunkStart += chunkSize) {
          const chunkEnd = Math.min(halfCount, chunkStart + chunkSize);
          for (let halfIndex = chunkStart; halfIndex < chunkEnd; halfIndex += 1) {
            const compiled = halfIndex % 2 === 0 ? item.effective0 : item.effective05;
            if (!compiled) {
              values[halfIndex] = 'x';
              continue;
            }
            const result = evaluateAst(compiled.ast, (requestedName, offset) => {
              const targetIndex = halfIndex + Math.round((Number(offset) || 0) * 2);
              if (targetIndex < 0 || targetIndex >= halfCount) return UNKNOWN;
              if (requestedName !== item.name && own(outputs, requestedName)) {
                const generated = outputs[requestedName];
                const generatedValue = targetIndex < generated.length
                  ? generated[targetIndex]
                  : UNKNOWN;
                const generatedUnknown = isUnknown(generatedValue)
                  || generatedValue == null
                  || generatedValue === ''
                  || String(generatedValue).toLowerCase() === 'x';
                if (!generatedUnknown) return generatedValue;
                if (outputKnownCounts[requestedName] === 0
                    && typeof settings.resolveGeneratedFallback === 'function') {
                  const fallback = settings.resolveGeneratedFallback(
                    requestedName,
                    targetIndex,
                    item.name
                  );
                  if (!isUnknown(fallback) && fallback != null && fallback !== ''
                      && String(fallback).toLowerCase() !== 'x') {
                    return fallback;
                  }
                }
                return UNKNOWN;
              }
              const raw = source(requestedName, targetIndex, item.name);
              return raw == null || raw === '' || String(raw).toLowerCase() === 'x' ? UNKNOWN : raw;
            });
            values[halfIndex] = serializableValue(result);
          }
          notify(settings.onFormulaChunk, {
            name: item.name,
            lane: -1,
            start: chunkStart,
            end: chunkEnd,
            total: halfCount
          });
        }
        outputKnownCounts[item.name] = values.reduce((count, value) => (
          !isUnknown(value) && value != null && value !== ''
            && String(value).toLowerCase() !== 'x' ? count + 1 : count
        ), 0);
        scalarNames.push(item.name);
        evaluationModes[item.name] = 'scalar';
      }
      outputs[item.name] = values;
      notify(settings.onFormulaComplete, Object.assign({
        reused: false,
        knownCount: outputKnownCounts[item.name],
        evaluationMode: evaluationModes[item.name],
        durationMs: now() - itemStartedAt
      }, progress));
    });
    return {
      analysis,
      outputs,
      totalColumns,
      knownCounts: outputKnownCounts,
      reusedNames,
      vectorizedNames,
      scalarNames,
      evaluationModes,
      layers: dependencyLayers(analysis).map((layer) => layer.map((item) => item.name)),
      evaluationDurationMs: now() - evaluationStartedAt
    };
  }

  function normalizedResultValue(value) {
    return formulaValueIsUnknown(value) ? 'x' : serializableValue(value);
  }

  function resultValueKey(value) {
    const normalized = normalizedResultValue(value);
    return typeof normalized + ':' + String(normalized);
  }

  function compressChangePoints(values, sampleStep) {
    const source = Array.isArray(values) || ArrayBuffer.isView(values) ? values : [];
    const indices = [];
    const resultValues = [];
    let previousKey = '';
    for (let index = 0; index < source.length; index += 1) {
      const value = normalizedResultValue(source[index]);
      const key = resultValueKey(value);
      if (index > 0 && key === previousKey) continue;
      indices.push(index);
      resultValues.push(value);
      previousKey = key;
    }
    if (!indices.length && source.length) {
      indices.push(0);
      resultValues.push('x');
    }
    return {
      protocol: 1,
      sampleStep: Math.max(0.5, Number(sampleStep) || 0.5),
      totalSamples: source.length,
      indices,
      values: resultValues
    };
  }

  function normalizeChangePoints(value) {
    const source = value && typeof value === 'object' ? value : {};
    const sampleStep = Math.max(0.5, Number(source.sampleStep) || 0.5);
    const rawIndices = Array.isArray(source.indices)
      ? source.indices
      : (Array.isArray(source.starts)
        ? source.starts.map((start) => Math.round(Number(start) / sampleStep))
        : []);
    const rawValues = Array.isArray(source.values) ? source.values : [];
    const pairs = [];
    const limit = Math.min(rawIndices.length, rawValues.length);
    for (let index = 0; index < limit; index += 1) {
      const pointIndex = Math.max(0, Math.floor(Number(rawIndices[index]) || 0));
      pairs.push({ index: pointIndex, value: normalizedResultValue(rawValues[index]) });
    }
    pairs.sort((left, right) => left.index - right.index);
    const indices = [];
    const values = [];
    pairs.forEach((pair) => {
      if (indices.length && indices[indices.length - 1] === pair.index) {
        values[values.length - 1] = pair.value;
        return;
      }
      if (values.length && resultValueKey(values[values.length - 1]) === resultValueKey(pair.value)) {
        return;
      }
      indices.push(pair.index);
      values.push(pair.value);
    });
    if (indices.length && indices[0] > 0) {
      indices.unshift(0);
      values.unshift('x');
    }
    const requestedTotal = Math.max(0, Math.floor(Number(source.totalSamples) || 0));
    const totalSamples = Math.max(
      requestedTotal,
      indices.length ? indices[indices.length - 1] + 1 : 0
    );
    return { protocol: 1, sampleStep, totalSamples, indices, values };
  }

  function expandChangePoints(value, requestedLength) {
    const source = normalizeChangePoints(value);
    const length = Math.max(
      0,
      Math.floor(Number(requestedLength) || source.totalSamples || 0)
    );
    const result = new Array(length).fill('x');
    for (let point = 0; point < source.indices.length; point += 1) {
      const start = Math.min(length, source.indices[point]);
      const end = point + 1 < source.indices.length
        ? Math.min(length, source.indices[point + 1])
        : length;
      for (let index = start; index < end; index += 1) result[index] = source.values[point];
    }
    return result;
  }

  function changePointValueAt(value, sampleIndex) {
    const source = normalizeChangePoints(value);
    const target = Math.floor(Number(sampleIndex) || 0);
    let low = 0;
    let high = source.indices.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (source.indices[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low > 0 ? source.values[low - 1] : 'x';
  }

  function unknownMaskFromValues(values) {
    const source = Array.isArray(values) || ArrayBuffer.isView(values) ? values : [];
    const mask = new Uint8Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      if (formulaValueIsUnknown(source[index])) mask[index] = 1;
    }
    return mask;
  }

  function unknownRunsFromMask(mask) {
    const source = mask && typeof mask.length === 'number' ? mask : [];
    const runs = [];
    for (let index = 0; index < source.length;) {
      if (!source[index]) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < source.length && source[index]) index += 1;
      runs.push([start, index - start]);
    }
    return runs;
  }

  function unknownMaskFromRuns(runs, length) {
    const mask = new Uint8Array(Math.max(0, Math.floor(Number(length) || 0)));
    (Array.isArray(runs) ? runs : []).forEach((run) => {
      const start = Math.max(0, Math.floor(Number(run && run[0]) || 0));
      const end = Math.min(mask.length, start + Math.max(0, Math.floor(Number(run && run[1]) || 0)));
      mask.fill(1, start, end);
    });
    return mask;
  }

  function sourceVersionForSignal(signal) {
    const source = signal && typeof signal === 'object' ? signal : {};
    const scope = source.scope && typeof source.scope === 'object' ? source.scope : {};
    return stableHash({
      wave: String(source.wave || ''),
      data: Array.isArray(source.data) ? source.data : [],
      samples: isSampleSequence(scope.samples)
        ? scope.samples : (isSampleSequence(source.samples) ? source.samples : []),
      values: isSampleSequence(scope.values)
        ? scope.values : (isSampleSequence(source.values) ? source.values : []),
      changePoints: scope.changePoints || source.changePoints || null,
      sampleStep: Number(scope.sampleStep || source.sampleStep || 1),
      mode: String(scope.mode || ''),
      table: scope.tbl || source.tbl || null
    });
  }

  function sourceVersionForUpdate(update) {
    const source = update && typeof update === 'object' ? update : {};
    return stableHash({
      wave: String(source.wave || ''),
      data: Array.isArray(source.data) ? source.data : [],
      samples: isSampleSequence(source.samples) ? source.samples : [],
      values: isSampleSequence(source.values) ? source.values : [],
      changePoints: source.changePoints || null,
      sampleStep: Number(source.sampleStep || 1),
      mode: String(source.sampleKind || source.mode || ''),
      table: source.tbl || null
    });
  }

  function formulaHash(item) {
    const formula = item && item.formula ? item.formula : normalizeDefinition(item || {});
    return stableHash({
      cycle0: String(formula.cycle0 || ''),
      cycle05: String(formula.cycle05 || ''),
      libraries: Array.isArray(item && item.libraries)
        ? item.libraries.slice().sort()
        : (Array.isArray(formula.libraries) ? formula.libraries.slice().sort() : [])
    });
  }

  function sourceVersionsForEvaluation(signalNames, settings) {
    const versions = Object.assign({}, settings && settings.sourceVersions || {});
    const sources = settings && settings.sources || {};
    (Array.isArray(signalNames) ? signalNames : []).forEach((name) => {
      if (versions[name]) return;
      if (own(sources, name)) versions[name] = stableHash(sources[name]);
      else if (settings && typeof settings.resolveSourceVersion === 'function') {
        versions[name] = String(settings.resolveSourceVersion(name) || '');
      }
    });
    return versions;
  }

  function buildDerivedPlan(analysis, sourceVersions, totalColumns, sampleStep) {
    const infoByName = Object.create(null);
    const layers = dependencyLayers(analysis);
    layers.forEach((layer) => {
      layer.forEach((item) => {
        const dependencyVersions = {};
        let cacheable = true;
        (item.references || []).slice().sort().forEach((name) => {
          const dependency = (item.dependencies || []).includes(name)
            ? infoByName[name] && infoByName[name].version
            : sourceVersions[name];
          if (!dependency) cacheable = false;
          dependencyVersions[name] = dependency || ('missing:' + name);
        });
        const itemFormulaHash = formulaHash(item);
        const version = stableHash({
          protocol: DERIVED_CACHE_PROTOCOL,
          name: item.name,
          formulaHash: itemFormulaHash,
          dependencyVersions,
          sampleStep,
          totalColumns
        });
        infoByName[item.name] = {
          formulaHash: itemFormulaHash,
          dependencyVersions,
          sampleStep,
          totalColumns,
          version,
          cacheable
        };
      });
    });
    return { layers, infoByName };
  }

  function cacheSampleCount(entry) {
    if (!entry) return 0;
    if (Array.isArray(entry.values) || ArrayBuffer.isView(entry.values)) return entry.values.length;
    return entry.changePoints ? Number(entry.changePoints.totalSamples || 0) : 0;
  }

  function putDerivedCache(entry) {
    if (!entry || !entry.version) return;
    const previous = derivedResultCache.get(entry.version);
    if (previous) derivedResultCacheSamples -= cacheSampleCount(previous);
    derivedResultCache.delete(entry.version);
    derivedResultCache.set(entry.version, entry);
    derivedResultCacheSamples += cacheSampleCount(entry);
    while (derivedResultCacheSamples > MAX_DERIVED_CACHE_SAMPLES && derivedResultCache.size > 1) {
      const oldestKey = derivedResultCache.keys().next().value;
      const oldest = derivedResultCache.get(oldestKey);
      derivedResultCache.delete(oldestKey);
      derivedResultCacheSamples -= cacheSampleCount(oldest);
    }
  }

  function getDerivedCache(version) {
    if (!version || !derivedResultCache.has(version)) return null;
    const entry = derivedResultCache.get(version);
    derivedResultCache.delete(version);
    derivedResultCache.set(version, entry);
    return entry;
  }

  function clearDerivedCache() {
    derivedResultCache.clear();
    derivedResultCacheSamples = 0;
  }

  function derivedEntryValues(entry, expectedLength) {
    if (!entry) return null;
    const length = Math.max(0, Math.floor(Number(expectedLength) || 0));
    if ((Array.isArray(entry.values) || ArrayBuffer.isView(entry.values))
        && entry.values.length === length) {
      return Array.isArray(entry.values) ? entry.values : Array.from(entry.values);
    }
    if (entry.changePoints) return expandChangePoints(entry.changePoints, length);
    return null;
  }

  function createDerivedEntry(item, values, knownCount, planInfo, evaluationMode) {
    const result = Array.isArray(values) ? values : Array.from(values || []);
    const unknownMask = unknownMaskFromValues(result);
    let numeric = Number(knownCount || 0) > 0;
    let binary = numeric;
    for (let index = 0; index < result.length && (numeric || binary); index += 1) {
      if (unknownMask[index]) continue;
      const number = Number(result[index]);
      if (!Number.isFinite(number)) {
        numeric = false;
        binary = false;
        break;
      }
      if (number !== 0 && number !== 1) binary = false;
    }
    const changePoints = compressChangePoints(result, planInfo.sampleStep);
    return {
      protocol: DERIVED_CACHE_PROTOCOL,
      name: item.name,
      formulaHash: planInfo.formulaHash,
      dependencyVersions: Object.assign({}, planInfo.dependencyVersions),
      sampleStep: planInfo.sampleStep,
      totalColumns: planInfo.totalColumns,
      version: planInfo.version,
      values: result,
      unknownMask,
      changePoints,
      knownCount: Number(knownCount || 0),
      sampleKind: numeric && !binary ? 'analog' : 'bus',
      evaluationMode: String(evaluationMode || '')
    };
  }

  function derivedCacheMetadata(entry) {
    if (!entry) return null;
    const mask = entry.unknownMask && typeof entry.unknownMask.length === 'number'
      ? entry.unknownMask
      : unknownMaskFromValues(entry.values || []);
    return {
      protocol: DERIVED_CACHE_PROTOCOL,
      formulaHash: String(entry.formulaHash || ''),
      dependencyVersions: Object.assign({}, entry.dependencyVersions || {}),
      sampleStep: Number(entry.sampleStep || 0.5),
      totalColumns: Number(entry.totalColumns || 0),
      resultVersion: String(entry.version || ''),
      resultKind: entry.sampleKind === 'analog' ? 'values' : 'change-points',
      totalSamples: mask.length,
      knownCount: Number(entry.knownCount || 0),
      unknownRuns: unknownRunsFromMask(mask)
    };
  }

  function restoreDerivedCacheEntry(metadata, result) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    if (Number(source.protocol) !== DERIVED_CACHE_PROTOCOL || !source.resultVersion) return null;
    const payload = result && typeof result === 'object' ? result : {};
    const changePoints = payload.changePoints ? normalizeChangePoints(payload.changePoints) : null;
    const values = Array.isArray(payload.values)
      ? payload.values.slice()
      : (changePoints ? null : []);
    const length = values
      ? values.length
      : Number(changePoints && changePoints.totalSamples || source.totalSamples || 0);
    return {
      protocol: DERIVED_CACHE_PROTOCOL,
      name: String(payload.name || ''),
      formulaHash: String(source.formulaHash || ''),
      dependencyVersions: Object.assign({}, source.dependencyVersions || {}),
      sampleStep: Number(source.sampleStep || 0.5),
      totalColumns: Number(source.totalColumns || 0),
      version: String(source.resultVersion || ''),
      values,
      changePoints,
      unknownMask: unknownMaskFromRuns(source.unknownRuns, length),
      knownCount: Number(payload.knownCount || source.knownCount || 0),
      sampleKind: source.resultKind === 'values' ? 'analog' : 'bus',
      evaluationMode: 'persistent-cache'
    };
  }

  function seededCacheEntry(cacheEntries, name, version) {
    let entry = null;
    if (cacheEntries instanceof Map) entry = cacheEntries.get(name) || cacheEntries.get(version);
    else if (cacheEntries && typeof cacheEntries === 'object') entry = cacheEntries[name] || cacheEntries[version];
    if (!entry || entry.version !== version) return null;
    return entry;
  }

  function evaluateDerivedDefinitions(definitions, signalNames, options) {
    const settings = options || {};
    const analysis = settings.analysis || analyzeDefinitions(definitions, signalNames);
    const totalColumns = Math.max(1, Math.ceil(Number(settings.totalColumns) || 1));
    const sampleStep = Math.max(0.5, Number(settings.sampleStep) || 0.5);
    const halfCount = totalColumns * 2;
    const sourceVersions = sourceVersionsForEvaluation(signalNames, settings);
    const plan = buildDerivedPlan(analysis, sourceVersions, totalColumns, sampleStep);
    const reuseOutputs = Object.create(null);
    const reuseKnownCounts = Object.create(null);
    const cacheHits = [];
    const recomputeNames = new Set();
    const cachedByName = Object.create(null);
    analysis.items.forEach((item) => {
      if (!item.valid) return;
      const info = plan.infoByName[item.name];
      let entry = info && info.cacheable
        ? seededCacheEntry(settings.cacheEntries, item.name, info.version)
        : null;
      if (!entry && info && info.cacheable) entry = getDerivedCache(info.version);
      const values = derivedEntryValues(entry, halfCount);
      if (entry && values) {
        entry.values = values;
        reuseOutputs[item.name] = values;
        reuseKnownCounts[item.name] = Number(entry.knownCount || 0);
        cachedByName[item.name] = entry;
        cacheHits.push(item.name);
      } else {
        recomputeNames.add(item.name);
      }
    });
    const evaluated = evaluateDefinitions(definitions, signalNames, Object.assign({}, settings, {
      analysis,
      totalColumns,
      reuseOutputs,
      reuseKnownCounts,
      recomputeNames
    }));
    const entries = Object.create(null);
    analysis.items.forEach((item) => {
      if (!item.valid || !own(evaluated.outputs, item.name)) return;
      const info = plan.infoByName[item.name];
      let entry = cachedByName[item.name];
      if (!entry) {
        entry = createDerivedEntry(
          item,
          evaluated.outputs[item.name],
          evaluated.knownCounts[item.name],
          info,
          evaluated.evaluationModes[item.name]
        );
      }
      entry.cacheHit = !!cachedByName[item.name];
      entries[item.name] = entry;
      if (info && info.cacheable) putDerivedCache(entry);
    });
    return Object.assign({}, evaluated, {
      entries,
      sourceVersions,
      layers: plan.layers.map((layer) => layer.map((item) => item.name)),
      cacheStats: {
        hits: cacheHits.length,
        misses: recomputeNames.size,
        hitNames: cacheHits,
        missNames: Array.from(recomputeNames)
      }
    });
  }

  class FormulaWorkerPool {
    constructor(workerUrl, workerCount) {
      this.sequence = 0;
      this.slots = [];
      try {
        for (let index = 0; index < workerCount; index += 1) {
          const worker = new global.Worker(workerUrl);
          const slot = { worker, pending: new Map() };
          worker.addEventListener('message', (event) => {
            const message = event.data || {};
            const pending = slot.pending.get(message.requestId);
            if (!pending) return;
            slot.pending.delete(message.requestId);
            if (message.ok) pending.resolve(message.result);
            else pending.reject(new Error(message.error || 'Formula worker failed'));
          });
          worker.addEventListener('error', (event) => {
            const error = new Error(event && event.message ? event.message : 'Formula worker failed');
            slot.pending.forEach((pending) => pending.reject(error));
            slot.pending.clear();
          });
          this.slots.push(slot);
        }
      } catch (error) {
        this.close();
        throw error;
      }
    }

    request(slot, type, payload) {
      const requestId = ++this.sequence;
      return new Promise((resolve, reject) => {
        slot.pending.set(requestId, { resolve, reject });
        try {
          slot.worker.postMessage(Object.assign({}, payload || {}, { type, requestId }));
        } catch (error) {
          slot.pending.delete(requestId);
          reject(error);
        }
      });
    }

    broadcast(type, payload) {
      return Promise.all(this.slots.map((slot) => this.request(slot, type, payload)));
    }

    async evaluateLayer(items, payload) {
      const results = Object.create(null);
      let nextIndex = 0;
      await Promise.all(this.slots.map(async (slot) => {
        while (nextIndex < items.length) {
          const item = items[nextIndex];
          nextIndex += 1;
          results[item.name] = await this.request(slot, 'evaluate', Object.assign({}, payload, {
            definition: { id: item.id, name: item.name, formula: item.formula }
          }));
        }
      }));
      return results;
    }

    close() {
      this.slots.forEach((slot) => {
        slot.worker.terminate();
        slot.pending.forEach((pending) => pending.reject(new Error('Formula worker closed')));
        slot.pending.clear();
      });
      this.slots = [];
    }
  }

  async function evaluateDefinitionsLayeredAsync(definitions, signalNames, options) {
    const settings = options || {};
    const now = () => (typeof performance !== 'undefined' && performance
      && typeof performance.now === 'function' ? performance.now() : Date.now());
    const startedAt = now();
    const analysis = settings.analysis || analyzeDefinitions(definitions, signalNames);
    const evaluationSignalNames = Array.from(new Set(
      (Array.isArray(signalNames) ? signalNames : [])
        .concat(analysis.items.map((item) => item.name).filter(Boolean))
    ));
    const totalColumns = Math.max(1, Math.ceil(Number(settings.totalColumns) || 1));
    const sampleStep = Math.max(0.5, Number(settings.sampleStep) || 0.5);
    const halfCount = totalColumns * 2;
    const sourceVersions = sourceVersionsForEvaluation(signalNames, settings);
    const plan = buildDerivedPlan(analysis, sourceVersions, totalColumns, sampleStep);
    const availableSources = Object.assign(Object.create(null), settings.sources || {});
    const outputs = Object.create(null);
    const entries = Object.create(null);
    const knownCounts = Object.create(null);
    const evaluationModes = Object.create(null);
    const reusedNames = [];
    const vectorizedNames = [];
    const scalarNames = [];
    const hitNames = [];
    const missNames = [];
    const largestLayer = plan.layers.reduce((maximum, layer) => Math.max(maximum, layer.length), 0);
    const hardwareCount = global.navigator && Number(global.navigator.hardwareConcurrency) || 2;
    const requestedWorkers = Math.max(1, Math.floor(Number(settings.maxWorkers) || hardwareCount - 1));
    const workerCount = Math.min(4, requestedWorkers, largestLayer);
    const canParallelize = settings.parallel !== false
      && halfCount >= Math.max(1024, Number(settings.parallelThreshold) || DEFAULT_PARALLEL_THRESHOLD)
      && largestLayer > 1
      && workerCount > 1
      && typeof global.Worker === 'function'
      && settings.workerUrl;
    let pool = null;
    let usedParallelWorkerCount = 0;
    if (canParallelize) {
      try {
        pool = new FormulaWorkerPool(settings.workerUrl, workerCount);
        await pool.broadcast('reset', { sources: availableSources });
      } catch (_error) {
        if (pool) pool.close();
        pool = null;
      }
    }

    const evaluateLocal = (item) => {
      const evaluated = evaluateDefinitions(
        [{ id: item.id, name: item.name, formula: item.formula }],
        evaluationSignalNames,
        {
          sources: availableSources,
          sourceIsConsumerIndependent: true,
          totalColumns,
          chunkSize: settings.chunkSize,
          onFormulaChunk: settings.onFormulaChunk
        }
      );
      return {
        values: evaluated.outputs[item.name] || new Array(halfCount).fill('x'),
        knownCount: Number(evaluated.knownCounts[item.name] || 0),
        evaluationMode: evaluated.evaluationModes[item.name] || 'scalar'
      };
    };

    try {
      for (let layerIndex = 0; layerIndex < plan.layers.length; layerIndex += 1) {
        const layer = plan.layers[layerIndex];
        if (typeof settings.onLayerStart === 'function') {
          settings.onLayerStart({ index: layerIndex + 1, total: plan.layers.length, names: layer.map((item) => item.name) });
        }
        const missing = [];
        layer.forEach((item) => {
          const info = plan.infoByName[item.name];
          let entry = info && info.cacheable
            ? seededCacheEntry(settings.cacheEntries, item.name, info.version)
            : null;
          if (!entry && info && info.cacheable) entry = getDerivedCache(info.version);
          const values = derivedEntryValues(entry, halfCount);
          if (!entry || !values) {
            missing.push(item);
            missNames.push(item.name);
            return;
          }
          entry.values = values;
          entry.cacheHit = true;
          entries[item.name] = entry;
          outputs[item.name] = values;
          knownCounts[item.name] = Number(entry.knownCount || 0);
          evaluationModes[item.name] = 'reused';
          reusedNames.push(item.name);
          hitNames.push(item.name);
        });

        let calculated = Object.create(null);
        missing.forEach((item, itemIndex) => {
          if (typeof settings.onFormulaStart !== 'function') return;
          settings.onFormulaStart({
            name: item.name,
            index: itemIndex + 1,
            total: missing.length,
            layer: layerIndex + 1,
            layerTotal: plan.layers.length
          });
        });
        if (missing.length > 1 && pool) {
          try {
            calculated = await pool.evaluateLayer(missing, {
              signalNames: evaluationSignalNames,
              totalColumns,
              chunkSize: settings.chunkSize
            });
            usedParallelWorkerCount = Math.max(usedParallelWorkerCount, workerCount);
          } catch (_error) {
            pool.close();
            pool = null;
            missing.forEach((item) => { calculated[item.name] = evaluateLocal(item); });
          }
        } else {
          missing.forEach((item) => { calculated[item.name] = evaluateLocal(item); });
        }

        missing.forEach((item, itemIndex) => {
          const result = calculated[item.name] || evaluateLocal(item);
          const info = plan.infoByName[item.name];
          const entry = createDerivedEntry(
            item,
            result.values,
            result.knownCount,
            info,
            result.evaluationMode
          );
          entry.cacheHit = false;
          entries[item.name] = entry;
          outputs[item.name] = entry.values;
          knownCounts[item.name] = entry.knownCount;
          evaluationModes[item.name] = entry.evaluationMode;
          if (entry.evaluationMode === 'vector') vectorizedNames.push(item.name);
          else scalarNames.push(item.name);
          if (info && info.cacheable) putDerivedCache(entry);
          if (typeof settings.onFormulaComplete === 'function') {
            settings.onFormulaComplete({
              name: item.name,
              index: itemIndex + 1,
              total: missing.length,
              knownCount: entry.knownCount,
              evaluationMode: entry.evaluationMode,
              layer: layerIndex + 1
            });
          }
        });

        const layerOutputs = {};
        layer.forEach((item) => {
          if (!own(outputs, item.name)) return;
          availableSources[item.name] = outputs[item.name];
          layerOutputs[item.name] = outputs[item.name];
        });
        if (pool && Object.keys(layerOutputs).length) await pool.broadcast('update', { sources: layerOutputs });
        if (typeof settings.onLayerComplete === 'function') {
          settings.onLayerComplete({ index: layerIndex + 1, total: plan.layers.length, names: layer.map((item) => item.name) });
        }
      }
    } finally {
      if (pool) pool.close();
    }
    return {
      analysis,
      outputs,
      entries,
      totalColumns,
      knownCounts,
      reusedNames,
      vectorizedNames,
      scalarNames,
      evaluationModes,
      sourceVersions,
      layers: plan.layers.map((layer) => layer.map((item) => item.name)),
      parallelWorkerCount: usedParallelWorkerCount,
      cacheStats: {
        hits: hitNames.length,
        misses: missNames.length,
        hitNames,
        missNames
      },
      evaluationDurationMs: now() - startedAt
    };
  }

  function flattenDocumentSignals(signals, result) {
    const rows = result || [];
    if (!Array.isArray(signals)) return rows;
    signals.forEach((entry) => {
      if (Array.isArray(entry)) {
        flattenDocumentSignals(entry.slice(1), rows);
      } else if (entry && typeof entry === 'object') {
        const hasChildren = Array.isArray(entry.children);
        const hasSignalField = ['name', 'wave', 'node', 'data', 'period', 'phase']
          .some((key) => own(entry, key));
        if (!hasChildren || hasSignalField) rows.push(entry);
        if (Array.isArray(entry.children)) flattenDocumentSignals(entry.children, rows);
      }
    });
    return rows;
  }

  function repeatedSamples(values, step, totalColumns) {
    const halfCount = Math.max(2, totalColumns * 2);
    const result = new Array(halfCount).fill('x');
    const halfStep = Math.max(1, Math.round((Number(step) || 1) * 2));
    let previous = 'x';
    (isSampleSequence(values) ? values : []).forEach((raw, index) => {
      const continuation = typeof raw === 'string' && raw.trim() === '.';
      const value = continuation ? previous : (raw == null || raw === '' ? 'x' : raw);
      previous = value;
      const start = index * halfStep;
      for (let half = start; half < Math.min(halfCount, start + halfStep); half += 1) result[half] = value;
    });
    return result;
  }

  function repeatedChangePointSamples(value, totalColumns) {
    const changePoints = normalizeChangePoints(value);
    return repeatedSamples(
      expandChangePoints(changePoints, changePoints.totalSamples),
      changePoints.sampleStep,
      totalColumns
    );
  }

  function hasUsableSamples(values) {
    if (!isSampleSequence(values) || !values.length) return false;
    let hasPrevious = false;
    return values.some((raw) => {
      if (typeof raw === 'string' && raw.trim() === '.') return hasPrevious;
      if (raw == null || (typeof raw === 'string' && !raw.trim())) return false;
      const number = Number(raw);
      if (!Number.isFinite(number)) return false;
      hasPrevious = true;
      return true;
    });
  }

  function signalSourceKind(signal) {
    const localScope = signal && signal.scope && typeof signal.scope === 'object' ? signal.scope : {};
    if (localScope.changePoints && typeof localScope.changePoints === 'object') return 'change-points';
    if (isSampleSequence(localScope.values) && localScope.values.length) return 'values';
    if (hasUsableSamples(localScope.samples)) return 'samples';
    return 'wave';
  }

  function waveValues(signal, totalColumns) {
    const localScope = signal && signal.scope && typeof signal.scope === 'object' ? signal.scope : {};
    if (localScope.changePoints && typeof localScope.changePoints === 'object') {
      return repeatedChangePointSamples(localScope.changePoints, totalColumns);
    }
    if (isSampleSequence(localScope.values) && localScope.values.length) {
      return repeatedSamples(localScope.values, localScope.sampleStep || 1, totalColumns);
    }
    if (hasUsableSamples(localScope.samples)) {
      return repeatedSamples(localScope.samples, localScope.sampleStep || 1, totalColumns);
    }
    const wave = String(signal && signal.wave || '');
    const labels = Array.isArray(signal && signal.data) ? signal.data : [];
    const result = new Array(Math.max(2, totalColumns * 2)).fill('x');
    let current = 'x';
    let dataIndex = 0;
    let clock = '';
    for (let column = 0; column < wave.length && column < totalColumns; column += 1) {
      const character = wave[column];
      const lower = character.toLowerCase();
      let left = current;
      let right = current;
      if ((character === '.' || character === '|' || character === ' ') && clock) {
        left = clock.toLowerCase() === 'p' ? 0 : 1;
        right = clock.toLowerCase() === 'p' ? 1 : 0;
        current = right;
      } else if (character === '.' || character === '|' || character === ' ') {
        left = current;
        right = current;
      } else if (lower === 'p' || lower === 'n') {
        clock = character;
        left = lower === 'p' ? 0 : 1;
        right = lower === 'p' ? 1 : 0;
        current = right;
      } else if (/[2-9=]/.test(character)) {
        clock = '';
        current = labels[dataIndex] == null ? character : labels[dataIndex];
        dataIndex += 1;
        left = current;
        right = current;
      } else {
        clock = '';
        current = lower === 'h' ? 1 : (lower === 'l' ? 0 : lower);
        left = current;
        right = current;
      }
      result[column * 2] = left;
      result[column * 2 + 1] = right;
    }
    return result;
  }

  function valueLengthFromSignal(signal) {
    const localScope = signal && signal.scope && typeof signal.scope === 'object' ? signal.scope : {};
    if (localScope.changePoints && typeof localScope.changePoints === 'object') {
      const changePoints = normalizeChangePoints(localScope.changePoints);
      return Math.ceil(changePoints.totalSamples * changePoints.sampleStep);
    }
    if (isSampleSequence(localScope.values) && localScope.values.length) {
      return Math.ceil(localScope.values.length * (Number(localScope.sampleStep) || 1));
    }
    if (hasUsableSamples(localScope.samples)) {
      return Math.ceil(localScope.samples.length * (Number(localScope.sampleStep) || 1));
    }
    return Math.max(1, String(signal && signal.wave || '').length);
  }

  function sourcesFromDocument(documentValue, updates, options) {
    const settings = options || {};
    const source = typeof documentValue === 'string' ? JSON.parse(documentValue) : (documentValue || {});
    const signals = flattenDocumentSignals(source.signal, []);
    let totalColumns = Math.max(1, Math.ceil(Number(settings.minimumTotalColumns) || 1));
    signals.forEach((signal) => { totalColumns = Math.max(totalColumns, valueLengthFromSignal(signal)); });
    (Array.isArray(updates) ? updates : []).forEach((update) => {
      if (isSampleSequence(update.values) && update.values.length) {
        totalColumns = Math.max(totalColumns, Math.ceil(update.values.length * (Number(update.sampleStep) || 1)));
      } else if (update.changePoints) {
        const changePoints = normalizeChangePoints(update.changePoints);
        totalColumns = Math.max(
          totalColumns,
          Math.ceil(changePoints.totalSamples * changePoints.sampleStep)
        );
      } else if (hasUsableSamples(update.samples)) {
        totalColumns = Math.max(totalColumns, Math.ceil(update.samples.length * (Number(update.sampleStep) || 1)));
      } else {
        totalColumns = Math.max(totalColumns, String(update.wave || '').length || 1);
      }
    });
    const sources = Object.create(null);
    const sourceKinds = Object.create(null);
    const sourceVersions = Object.create(null);
    const cacheEntries = Object.create(null);
    const descriptors = Object.create(null);
    const names = [];
    const knownNames = new Set();
    signals.forEach((signal) => {
      const name = String(signal && signal.name || '').trim();
      if (!name || knownNames.has(name)) return;
      knownNames.add(name);
      names.push(name);
      sourceKinds[name] = signalSourceKind(signal);
      descriptors[name] = { kind: 'signal', value: signal };
      const localScope = signal && signal.scope && typeof signal.scope === 'object'
        ? signal.scope : null;
      if (localScope && localScope.derivedCache) {
        const restored = restoreDerivedCacheEntry(localScope.derivedCache, {
          name,
          values: isSampleSequence(localScope.values) ? localScope.values : null,
          changePoints: localScope.changePoints || null,
          knownCount: Number(localScope.derivedCache.knownCount || 0)
        });
        if (restored) cacheEntries[name] = restored;
      }
    });
    (Array.isArray(updates) ? updates : []).forEach((update) => {
      const name = String(update && update.signal || '').trim();
      if (!name) return;
      if (!knownNames.has(name)) {
        knownNames.add(name);
        names.push(name);
      }
      const kind = isSampleSequence(update.values) && update.values.length
        ? 'values'
        : (update.changePoints
          ? 'change-points'
          : (hasUsableSamples(update.samples) ? 'samples' : 'wave'));
      sourceKinds[name] = kind;
      descriptors[name] = { kind: 'update', value: update, sourceKind: kind };
    });
    const materializeVersions = (requiredNames) => {
      const required = requiredNames == null
        ? null
        : new Set(Array.from(requiredNames).map((name) => String(name || '')));
      names.forEach((name) => {
        if ((required && !required.has(name)) || sourceVersions[name]) return;
        const descriptor = descriptors[name];
        if (!descriptor) return;
        sourceVersions[name] = descriptor.kind === 'signal'
          ? sourceVersionForSignal(descriptor.value)
          : sourceVersionForUpdate(descriptor.value);
      });
      return sourceVersions;
    };
    const materialize = (requiredNames) => {
      const required = requiredNames == null
        ? null
        : new Set(Array.from(requiredNames).map((name) => String(name || '')));
      names.forEach((name) => {
        if (required && !required.has(name)) return;
        const descriptor = descriptors[name];
        if (!descriptor) return;
        if (descriptor.kind === 'signal') {
          sources[name] = waveValues(descriptor.value, totalColumns);
        } else if (descriptor.sourceKind === 'values') {
          sources[name] = repeatedSamples(
            descriptor.value.values,
            descriptor.value.sampleStep || 1,
            totalColumns
          );
        } else if (descriptor.sourceKind === 'change-points') {
          sources[name] = repeatedChangePointSamples(
            descriptor.value.changePoints,
            totalColumns
          );
        } else if (descriptor.sourceKind === 'samples') {
          sources[name] = repeatedSamples(
            descriptor.value.samples,
            descriptor.value.sampleStep || 1,
            totalColumns
          );
        } else {
          sources[name] = waveValues(descriptor.value, totalColumns);
        }
      });
      return sources;
    };
    if (!settings.deferVersions) materializeVersions(null);
    if (!settings.deferSources) materialize(null);
    return {
      source,
      signals,
      sources,
      sourceKinds,
      sourceVersions,
      cacheEntries,
      names,
      totalColumns,
      materializeVersions,
      materialize
    };
  }

  function waveFromHalfValues(values, totalColumns, includeData) {
    let wave = '';
    const data = [];
    let previous = null;
    for (let column = 0; column < totalColumns; column += 1) {
      const value = values[column * 2] == null ? 'x' : values[column * 2];
      const text = String(value);
      if (previous !== null && text === String(previous)) {
        wave += '.';
      } else if (text === '0' || text === '1' || /^(x|z)$/i.test(text)) {
        wave += text.toLowerCase();
      } else {
        wave += '=';
        if (includeData !== false) data.push(text);
      }
      previous = value;
    }
    return { wave, data };
  }

  function prepareFormulaBuild(documentValue, importedUpdates, definitions, options) {
    const settings = options || {};
    const sourceData = sourcesFromDocument(documentValue, importedUpdates, {
      deferSources: true,
      deferVersions: true,
      minimumTotalColumns: settings.totalColumns
    });
    const analysis = analyzeDefinitions(definitions, sourceData.names);
    const requiredSourceNames = new Set();
    analysis.items.forEach((item) => {
      if (!item.valid) return;
      const formulaDependencies = new Set(item.dependencies || []);
      item.references.forEach((name) => {
        if (!formulaDependencies.has(name)) requiredSourceNames.add(name);
      });
    });
    sourceData.materializeVersions(requiredSourceNames);
    sourceData.materialize(requiredSourceNames);
    return { sourceData, analysis };
  }

  function packageFormulaUpdates(sourceData, analysis, evaluated, options) {
    const settings = options || {};
    const updates = [];
    const allUnknown = [];
    const validItems = analysis.items.filter((item) => (
      item.valid && own(evaluated.outputs, item.name)
    ));
    let packageIndex = 0;
    analysis.items.forEach((item) => {
      if (!item.valid || !own(evaluated.outputs, item.name)) return;
      packageIndex += 1;
      if (typeof settings.onFormulaPackageStart === 'function') {
        try {
          settings.onFormulaPackageStart({
            name: item.name,
            index: packageIndex,
            total: validItems.length
          });
        } catch (_error) { /* progress must not stop packaging */ }
      }
      const values = evaluated.outputs[item.name];
      const entry = evaluated.entries && evaluated.entries[item.name];
      const knownCount = Number(evaluated.knownCounts[item.name] || 0);
      if (!knownCount) allUnknown.push(item.name);
      const sampleKind = entry ? entry.sampleKind : 'bus';
      const compactThreshold = Math.max(
        1,
        Math.floor(Number(settings.compactDataThreshold) || COMPACT_DATA_LABEL_THRESHOLD)
      );
      const built = waveFromHalfValues(
        values,
        sourceData.totalColumns,
        sourceData.totalColumns < compactThreshold
      );
      const update = {
        signal: item.name,
        wave: built.wave,
        data: built.data,
        sampleStep: 0.5,
        sampleKind,
        createIfMissing: true,
        formula: item.formula,
        derivedCache: entry ? derivedCacheMetadata(entry) : null
      };
      if (sampleKind === 'analog') update.values = values;
      else update.changePoints = entry ? entry.changePoints : compressChangePoints(values, 0.5);
      updates.push(update);
    });
    return {
      updates,
      analysis,
      totalColumns: sourceData.totalColumns,
      allUnknown,
      sourceKinds: sourceData.sourceKinds,
      cacheStats: evaluated.cacheStats || null,
      layers: evaluated.layers || [],
      parallelWorkerCount: Number(evaluated.parallelWorkerCount || 0),
      evaluationDurationMs: Number(evaluated.evaluationDurationMs || 0)
    };
  }

  function buildFormulaUpdates(documentValue, importedUpdates, definitions, options) {
    const settings = options || {};
    const prepared = prepareFormulaBuild(documentValue, importedUpdates, definitions, settings);
    const evaluated = evaluateDerivedDefinitions(definitions, prepared.sourceData.names, {
      analysis: prepared.analysis,
      sources: prepared.sourceData.sources,
      sourceVersions: prepared.sourceData.sourceVersions,
      cacheEntries: prepared.sourceData.cacheEntries,
      totalColumns: prepared.sourceData.totalColumns,
      sampleStep: 0.5,
      chunkSize: settings.chunkSize,
      onFormulaStart: settings.onFormulaStart,
      onFormulaComplete: settings.onFormulaComplete,
      onFormulaChunk: settings.onFormulaChunk
    });
    return packageFormulaUpdates(
      prepared.sourceData,
      prepared.analysis,
      evaluated,
      settings
    );
  }

  async function buildFormulaUpdatesAsync(documentValue, importedUpdates, definitions, options) {
    const settings = options || {};
    const prepared = prepareFormulaBuild(documentValue, importedUpdates, definitions, settings);
    const evaluated = await evaluateDefinitionsLayeredAsync(
      definitions,
      prepared.sourceData.names,
      {
        analysis: prepared.analysis,
        sources: prepared.sourceData.sources,
        sourceVersions: prepared.sourceData.sourceVersions,
        cacheEntries: prepared.sourceData.cacheEntries,
        totalColumns: prepared.sourceData.totalColumns,
        sampleStep: 0.5,
        chunkSize: settings.chunkSize,
        parallel: settings.parallel,
        workerUrl: settings.workerUrl,
        maxWorkers: settings.maxWorkers,
        parallelThreshold: settings.parallelThreshold,
        onFormulaStart: settings.onFormulaStart,
        onFormulaComplete: settings.onFormulaComplete,
        onFormulaChunk: settings.onFormulaChunk,
        onLayerStart: settings.onLayerStart,
        onLayerComplete: settings.onLayerComplete
      }
    );
    return packageFormulaUpdates(
      prepared.sourceData,
      prepared.analysis,
      evaluated,
      settings
    );
  }

  function highlightExpression(text, compiled, knownNames, selfName) {
    const source = String(text || '');
    let tokens = compiled && Array.isArray(compiled.tokens) ? compiled.tokens : [];
    if (!tokens.length && source.trim()) {
      try { tokens = new Tokenizer(source).tokenize().filter((token) => token.type !== 'eof'); }
      catch (_error) { return escapeHtml(source); }
    }
    const known = new Set((knownNames || []).map((name) => String(name || '')));
    if (selfName) known.add(selfName);
    let cursor = 0;
    let result = '';
    tokens.filter((token) => token.type === 'reference').forEach((token) => {
      result += escapeHtml(source.slice(cursor, token.start));
      const resolved = token.value === 'self' ? selfName : token.value;
      const valid = !!resolved && known.has(resolved);
      result += '<span class="scope-formula-variable ' + (valid ? 'is-valid' : 'is-invalid')
        + '" title="' + escapeHtml(valid ? ('有效变量：' + resolved) : ('找不到变量：' + token.value))
        + '">' + escapeHtml(source.slice(token.start, token.end)) + '</span>';
      cursor = token.end;
    });
    return result + escapeHtml(source.slice(cursor));
  }

  function pythonPreview(item) {
    if (!item) return '';
    const libraries = Array.from(new Set(item.libraries || [])).sort();
    const imports = libraries.map((name) => 'import ' + name);
    const left = item.cycle0 ? item.cycle0.pythonExpression : '';
    const right = item.cycle05 ? item.cycle05.pythonExpression : '';
    return imports.concat([
      imports.length ? '' : null,
      'def value_at_cycle(cycle):',
      '    return ' + (left || right || "'x'"),
      '',
      'def value_at_half_cycle(cycle):',
      '    return ' + (right || left || "'x'")
    ].filter((line) => line !== null)).join('\n');
  }

  const api = {
    UNKNOWN,
    DERIVED_CACHE_PROTOCOL,
    normalizeDefinition,
    compileExpression,
    analyzeDefinitions,
    dependencyLayers,
    evaluateDefinitions,
    evaluateDerivedDefinitions,
    evaluateDefinitionsLayeredAsync,
    sourcesFromDocument,
    buildFormulaUpdates,
    buildFormulaUpdatesAsync,
    stableHash,
    sourceVersionForSignal,
    sourceVersionForUpdate,
    compressChangePoints,
    normalizeChangePoints,
    expandChangePoints,
    changePointValueAt,
    derivedCacheMetadata,
    restoreDerivedCacheEntry,
    clearDerivedCache,
    highlightExpression,
    pythonPreview,
    serializableValue,
    isUnknown
  };

  global.VisualWaveDromFormula = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
