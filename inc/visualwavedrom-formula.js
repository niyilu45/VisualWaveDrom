(function (global) {
  'use strict';

  const UNKNOWN = Object.freeze({ unknown: true });
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

  function evaluateDefinitions(definitions, signalNames, options) {
    const settings = options || {};
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
    executable.forEach((item, formulaIndex) => {
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
        notify(settings.onFormulaComplete, Object.assign({ reused: true }, progress));
        return;
      }
      const values = new Array(halfCount);
      for (let halfIndex = 0; halfIndex < halfCount; halfIndex += 1) {
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
      outputs[item.name] = values;
      outputKnownCounts[item.name] = values.reduce((count, value) => (
        !isUnknown(value) && value != null && value !== ''
          && String(value).toLowerCase() !== 'x' ? count + 1 : count
      ), 0);
      notify(settings.onFormulaComplete, Object.assign({
        reused: false,
        knownCount: outputKnownCounts[item.name]
      }, progress));
    });
    return {
      analysis,
      outputs,
      totalColumns,
      knownCounts: outputKnownCounts,
      reusedNames
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
    (Array.isArray(values) ? values : []).forEach((raw, index) => {
      const continuation = typeof raw === 'string' && raw.trim() === '.';
      const value = continuation ? previous : (raw == null || raw === '' ? 'x' : raw);
      previous = value;
      const start = index * halfStep;
      for (let half = start; half < Math.min(halfCount, start + halfStep); half += 1) result[half] = value;
    });
    return result;
  }

  function hasUsableSamples(values) {
    if (!Array.isArray(values) || !values.length) return false;
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
    if (Array.isArray(localScope.values) && localScope.values.length) return 'values';
    if (hasUsableSamples(localScope.samples)) return 'samples';
    return 'wave';
  }

  function waveValues(signal, totalColumns) {
    const localScope = signal && signal.scope && typeof signal.scope === 'object' ? signal.scope : {};
    if (Array.isArray(localScope.values) && localScope.values.length) {
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
    if (Array.isArray(localScope.values) && localScope.values.length) {
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
    let totalColumns = 1;
    signals.forEach((signal) => { totalColumns = Math.max(totalColumns, valueLengthFromSignal(signal)); });
    (Array.isArray(updates) ? updates : []).forEach((update) => {
      if (Array.isArray(update.values) && update.values.length) {
        totalColumns = Math.max(totalColumns, Math.ceil(update.values.length * (Number(update.sampleStep) || 1)));
      } else if (hasUsableSamples(update.samples)) {
        totalColumns = Math.max(totalColumns, Math.ceil(update.samples.length * (Number(update.sampleStep) || 1)));
      } else {
        totalColumns = Math.max(totalColumns, String(update.wave || '').length || 1);
      }
    });
    const sources = Object.create(null);
    const sourceKinds = Object.create(null);
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
    });
    (Array.isArray(updates) ? updates : []).forEach((update) => {
      const name = String(update && update.signal || '').trim();
      if (!name) return;
      if (!knownNames.has(name)) {
        knownNames.add(name);
        names.push(name);
      }
      const kind = Array.isArray(update.values) && update.values.length
        ? 'values'
        : (hasUsableSamples(update.samples) ? 'samples' : 'wave');
      sourceKinds[name] = kind;
      descriptors[name] = { kind: 'update', value: update, sourceKind: kind };
    });
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
    if (!settings.deferSources) materialize(null);
    return { source, signals, sources, sourceKinds, names, totalColumns, materialize };
  }

  function waveFromHalfValues(values, totalColumns) {
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
        data.push(text);
      }
      previous = value;
    }
    return { wave, data };
  }

  function buildFormulaUpdates(documentValue, importedUpdates, definitions, options) {
    const settings = options || {};
    const sourceData = sourcesFromDocument(documentValue, importedUpdates, { deferSources: true });
    const analysis = analyzeDefinitions(definitions, sourceData.names);
    const requiredSourceNames = new Set();
    analysis.items.forEach((item) => {
      if (!item.valid) return;
      item.references.forEach((name) => requiredSourceNames.add(name));
    });
    sourceData.materialize(requiredSourceNames);
    const evaluated = evaluateDefinitions(definitions, sourceData.names, {
      analysis,
      sources: sourceData.sources,
      totalColumns: sourceData.totalColumns,
      onFormulaStart: settings.onFormulaStart,
      onFormulaComplete: settings.onFormulaComplete
    });
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
      const built = waveFromHalfValues(values, sourceData.totalColumns);
      const knownCount = Number(evaluated.knownCounts[item.name] || 0);
      if (!knownCount) allUnknown.push(item.name);
      let numeric = knownCount > 0;
      let binary = numeric;
      for (let index = 0; index < values.length && (numeric || binary); index += 1) {
        const value = values[index];
        if (String(value).toLowerCase() === 'x') continue;
        const number = Number(value);
        if (!Number.isFinite(number)) {
          numeric = false;
          binary = false;
          break;
        }
        if (number !== 0 && number !== 1) binary = false;
      }
      updates.push({
        signal: item.name,
        wave: built.wave,
        data: built.data,
        values,
        sampleStep: 0.5,
        sampleKind: numeric && !binary ? 'analog' : 'bus',
        createIfMissing: true,
        formula: item.formula
      });
    });
    return {
      updates,
      analysis,
      totalColumns: sourceData.totalColumns,
      allUnknown,
      sourceKinds: sourceData.sourceKinds
    };
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
    normalizeDefinition,
    compileExpression,
    analyzeDefinitions,
    evaluateDefinitions,
    sourcesFromDocument,
    buildFormulaUpdates,
    highlightExpression,
    pythonPreview,
    serializableValue,
    isUnknown
  };

  global.VisualWaveDromFormula = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
