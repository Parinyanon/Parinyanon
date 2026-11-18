// Preserve PostgreSQL JSONB decimal values before the browser converts them to numbers.
export function financialJsonText(text) {
  JSON.parse(text);
  const chunks = [];
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let index = 0; index < text.length;) {
    const start = index;
    if (text[index] === '"') {
      index++;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index++] === '"') break;
      }
      chunks.push(text.slice(start, index));
    } else if (text[index] === '-' || /\d/.test(text[index])) {
      number.lastIndex = index;
      const token = number.exec(text)[0];
      const [coefficient, exponent = '0'] = token.toLowerCase().split('e');
      const scale = Number(exponent);
      if (!Number.isInteger(scale) || Math.abs(scale) > 1000)
        throw new Error('Financial number is outside the supported range');
      const sign = coefficient.startsWith('-') ? '-' : '';
      const [whole, fraction = ''] = coefficient.replace(/^-/, '').split('.');
      const digits = whole + fraction;
      const point = whole.length + scale;
      let decimal;
      if (point <= 0) decimal = '0.' + '0'.repeat(-point) + digits;
      else if (point >= digits.length) decimal = digits + '0'.repeat(point - digits.length);
      else decimal = digits.slice(0, point) + '.' + digits.slice(point);
      chunks.push(JSON.stringify(sign + decimal));
      index += token.length;
    } else {
      chunks.push(text[index++]);
    }
  }
  return chunks.join('');
}
