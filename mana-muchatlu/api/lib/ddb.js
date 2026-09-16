/**
 * Minimal DynamoDB attribute-value marshalling.
 *
 * Why hand-rolled instead of @aws-sdk/lib-dynamodb: the Lambda Node runtime
 * bundles @aws-sdk/client-dynamodb, but the convenience wrappers are not
 * guaranteed to be there. Hand-marshalling the five types this app actually
 * uses keeps the deploy artifact at zero dependencies, which means CI never
 * runs npm install and the function cold-starts in single-digit milliseconds.
 */

function marshall(value) {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot marshall non-finite number');
    return { N: String(value) };
  }
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshall) };
  if (typeof value === 'object') return { M: marshallItem(value) };
  throw new Error(`cannot marshall value of type ${typeof value}`);
}

function marshallItem(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined) continue; // DynamoDB has no "undefined"
    out[key] = marshall(value);
  }
  return out;
}

function unmarshall(attr) {
  if (!attr || typeof attr !== 'object') return null;
  if ('NULL' in attr) return null;
  if ('S' in attr) return attr.S;
  if ('N' in attr) return Number(attr.N);
  if ('BOOL' in attr) return attr.BOOL;
  if ('L' in attr) return attr.L.map(unmarshall);
  if ('M' in attr) return unmarshallItem(attr.M);
  return null;
}

function unmarshallItem(item) {
  const out = {};
  for (const [key, value] of Object.entries(item || {})) {
    out[key] = unmarshall(value);
  }
  return out;
}

module.exports = { marshall, marshallItem, unmarshall, unmarshallItem };
