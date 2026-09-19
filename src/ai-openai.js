'use strict';

// Chat Completions over plain fetch, for OpenAI-compatible APIs: Groq's free
// tier by default, or any endpoint set with AI_BASE_URL (OpenRouter, Mistral,
// a self-hosted Ollama, ...).

class HttpError extends Error {
  constructor(status, body, retryAfter) {
    super(`AI service responded ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = String(body || '').slice(0, 2000);
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

function parseRetryAfter(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// Models that take reasoning_effort low/medium/high (Groq's Qwen models use
// other values, so they're left on their defaults), and models known to do
// strict JSON-schema output. Others get JSON mode with the schema in the prompt.
const REASONING_MODEL_RE = /gpt-oss|(?:^|\/)o\d/i;
const STRICT_SCHEMA_MODEL_RE = /gpt-oss|qwen3|gpt-4o|gpt-4\.1|gpt-5/i;

// OpenAI-style strict schemas spell "string or null" as a type list.
function toOpenAiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toOpenAiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const nullable =
    Array.isArray(schema.anyOf) &&
    schema.anyOf.length === 2 &&
    schema.anyOf.some((s) => s.type === 'null') &&
    schema.anyOf.some((s) => s.type === 'string');
  if (nullable) {
    const rest = { ...schema };
    delete rest.anyOf;
    return { ...rest, type: ['string', 'null'] };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) out[key] = toOpenAiSchema(value);
  return out;
}

/** Rough token count; errs high for non-Latin scripts so we stay under limits. */
function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3.6 + other / 1.1) + 4;
}

class OpenAiCompatibleClient {
  constructor({ provider, baseUrl, apiKey, model, reasoningEffort = 'low', structuredOutput = 'auto', fetchImpl = globalThis.fetch }) {
    this.provider = provider;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey || null;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.reasoning = REASONING_MODEL_RE.test(model);
    this.strict = structuredOutput === 'strict' || (structuredOutput === 'auto' && STRICT_SCHEMA_MODEL_RE.test(model));
    this.fetch = fetchImpl;
  }

  /** Extra system text needed when the API can't enforce the schema itself. */
  schemaInstructions(schema, strict = this.strict) {
    return strict ? '' : `\n\nRespond with only a JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  }

  body({ system, prompt, schema, schemaName, maxTokens, strict }) {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: `${system}${this.schemaInstructions(schema, strict)}` },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: maxTokens,
      response_format: strict
        ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: toOpenAiSchema(schema) } }
        : { type: 'json_object' }
    };
    if (this.reasoning && this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    // Groq returns the model's reasoning unless told not to; we only want JSON.
    if (this.reasoning && this.provider === 'groq') body.include_reasoning = false;
    return body;
  }

  async complete({ system, prompt, schema, schemaName, maxTokens, signal }) {
    let strict = this.strict;
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(this.body({ system, prompt, schema, schemaName, maxTokens, strict })),
        signal
      });
      const text = await response.text();
      if (!response.ok) {
        const err = new HttpError(response.status, text, response.headers.get('retry-after'));
        // Some models or gateways don't do strict schemas: fall back to JSON mode once.
        if (strict && attempt === 0 && response.status === 400 && /response_format|json_schema|structured/i.test(text)) {
          strict = false;
          continue;
        }
        throw err;
      }
      const json = JSON.parse(text);
      const choice = json.choices?.[0] || {};
      return {
        content: typeof choice.message?.content === 'string' ? choice.message.content : '',
        refusal: choice.message?.refusal || null,
        finishReason: choice.finish_reason || null,
        model: json.model || this.model,
        usage: json.usage || null
      };
    }
  }
}

function mapHttpError(err) {
  if (err instanceof HttpError) {
    const { status, body } = err;
    if (status === 401 || status === 403) return { code: 'auth', retryable: false, error: 'The AI service rejected this server’s credentials.' };
    if (status === 413) return { code: 'too-large', retryable: true, error: 'This meeting was too long for the AI service’s limits.' };
    if (status === 429) return { code: 'rate-limited', retryable: true, error: 'The AI service is busy. Please try again shortly.' };
    if (status === 404) return { code: 'bad-request', retryable: false, error: 'The configured AI model isn’t available.' };
    if (status === 400 && /json_validate_failed|failed to generate json|invalid json/i.test(body)) {
      return { code: 'invalid-output', retryable: true, error: 'The AI returned an unexpected response.' };
    }
    if (status === 400 || status === 422) return { code: 'bad-request', retryable: false, error: 'The AI service could not process this meeting.' };
    return { code: 'unavailable', retryable: true, error: 'The AI service is temporarily unavailable.' };
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { code: 'timeout', retryable: true, error: 'The AI took too long to respond.' };
  }
  if (err instanceof SyntaxError) return { code: 'invalid-output', retryable: true, error: 'The AI returned an unexpected response.' };
  if (err instanceof TypeError) return { code: 'network', retryable: true, error: 'Could not reach the AI service.' };
  return { code: 'internal', retryable: true, error: 'Something went wrong while generating notes.' };
}

module.exports = { OpenAiCompatibleClient, HttpError, mapHttpError, toOpenAiSchema, estimateTokens, parseRetryAfter };
