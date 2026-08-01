import type {
  ImageRequestFormat,
  LegacyModelProvider,
  ModelRequestFormat,
  TextRequestFormat
} from '../types';

export const DEFAULT_TEXT_BASE_URL: Record<TextRequestFormat, string> = {
  'openai-responses': 'https://api.openai.com/v1',
  'openai-chat-completions': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  'gemini-interactions': 'https://generativelanguage.googleapis.com',
  'gemini-generate-content': 'https://generativelanguage.googleapis.com'
};

export const DEFAULT_IMAGE_BASE_URL: Record<ImageRequestFormat, string> = {
  'openai-images': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-chat-completions': 'https://api.openai.com/v1',
  'gemini-interactions': 'https://generativelanguage.googleapis.com',
  'gemini-generate-content': 'https://generativelanguage.googleapis.com'
};

export const TEXT_REQUEST_FORMATS: TextRequestFormat[] = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
  'gemini-interactions',
  'gemini-generate-content'
];

export const IMAGE_REQUEST_FORMATS: ImageRequestFormat[] = [
  'openai-images',
  'openai-responses',
  'openai-chat-completions',
  'gemini-interactions',
  'gemini-generate-content'
];

export const normalizeTextRequestFormat = (
  value?: string | null
): TextRequestFormat => {
  if (value && TEXT_REQUEST_FORMATS.includes(value as TextRequestFormat)) {
    return value as TextRequestFormat;
  }
  const legacy = value as LegacyModelProvider | undefined;
  if (legacy === 'claude') return 'anthropic-messages';
  if (legacy === 'gemini') return 'gemini-generate-content';
  if (legacy === 'openai') return 'openai-responses';
  if (legacy === 'doubao' || legacy === 'grok') return 'openai-chat-completions';
  return 'gemini-generate-content';
};

export const normalizeImageRequestFormat = (
  value?: string | null
): ImageRequestFormat => {
  if (value && IMAGE_REQUEST_FORMATS.includes(value as ImageRequestFormat)) {
    return value as ImageRequestFormat;
  }
  const legacy = value as LegacyModelProvider | undefined;
  if (legacy === 'gemini' || legacy === 'claude') return 'gemini-generate-content';
  if (legacy === 'openai' || legacy === 'doubao' || legacy === 'grok') {
    return 'openai-images';
  }
  return 'gemini-generate-content';
};

export const normalizeBaseUrl = (value?: string | null) =>
  (value || '').trim().replace(/\/+$/, '');

export const resolveBaseUrlForFormat = (
  format: ModelRequestFormat,
  value?: string | null
) => {
  const configured = normalizeBaseUrl(value);
  if (configured) return configured;
  if (format === 'openai-images') return DEFAULT_IMAGE_BASE_URL[format];
  return DEFAULT_TEXT_BASE_URL[format as TextRequestFormat]
    || DEFAULT_IMAGE_BASE_URL[format as ImageRequestFormat]
    || '';
};

const appendEndpoint = (baseUrl: string, endpoint: string) => {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = endpoint.replace(/^\/+/, '');
  if (base.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)) return base;
  return `${base}/${suffix}`;
};

const geminiEndpoint = (baseUrl: string, endpoint: string) => {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/v1(?:beta2?|alpha)?$/i.test(base)) {
    return appendEndpoint(base, endpoint);
  }
  return appendEndpoint(base, `v1beta/${endpoint}`);
};

export const getGeminiSdkHttpOptions = (baseUrl?: string | null) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return undefined;
  const versionMatch = normalized.match(/\/(v1(?:beta2?|alpha)?)$/i);
  if (!versionMatch) {
    return { baseUrl: normalized };
  }
  return {
    baseUrl: normalized.slice(0, -versionMatch[0].length),
    apiVersion: versionMatch[1]
  };
};

const readError = async (response: Response, label: string) => {
  const detail = await response.text();
  throw new Error(detail
    ? `${label} failed (HTTP ${response.status}): ${detail}`
    : `${label} failed (HTTP ${response.status}).`);
};

export type RequestTrace = {
  requestId?: string;
  responseModel?: string;
  usage?: Record<string, any>;
};

export type TextPingResult = RequestTrace & { text: string };
export type ImageGenerationResult = RequestTrace & {
  base64?: string;
  mimeType?: string;
  url?: string;
};

const getRequestTrace = (response: Response, data: any): RequestTrace => ({
  requestId: response.headers.get('x-generation-id')
    || response.headers.get('x-request-id')
    || response.headers.get('request-id')
    || response.headers.get('x-goog-request-id')
    || (typeof data?.id === 'string' ? data.id : undefined),
  responseModel: typeof data?.model === 'string'
    ? data.model
    : typeof data?.modelVersion === 'string'
      ? data.modelVersion
      : undefined,
  usage: data?.usage || data?.usageMetadata || data?.total_usage
});

export const extractGeminiInteractionText = (data: any) => {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  return (Array.isArray(data?.steps) ? data.steps : [])
    .filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => Array.isArray(step?.content) ? step.content : [])
    .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: any) => part.text)
    .join('')
    .trim();
};

export const extractGeminiInteractionImage = (data: any) => {
  if (data?.output_image?.data) {
    return {
      base64: String(data.output_image.data),
      mimeType: String(data.output_image.mime_type || 'image/png')
    };
  }
  const part = (Array.isArray(data?.steps) ? data.steps : [])
    .filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => Array.isArray(step?.content) ? step.content : [])
    .find((content: any) => content?.type === 'image' && content?.data);
  return part
    ? { base64: String(part.data), mimeType: String(part.mime_type || 'image/png') }
    : null;
};

export const callGeminiInteractionsJson = async (params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  prompt: string;
  schema?: Record<string, any>;
}) => {
  const response = await fetch(geminiEndpoint(params.baseUrl, 'interactions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': params.apiKey
    },
    body: JSON.stringify({
      model: params.model,
      system_instruction: params.system,
      input: params.prompt,
      store: false,
      ...(params.schema ? {
        response_format: [{
          type: 'text',
          mime_type: 'application/json',
          schema: params.schema
        }]
      } : {})
    })
  });
  if (!response.ok) await readError(response, 'Gemini Interactions request');
  const data = await response.json();
  const content = extractGeminiInteractionText(data);
  if (!content) throw new Error('Gemini Interactions response contained no text output.');
  return { content, ...getRequestTrace(response, data), raw: data };
};

const callGeminiGenerateContentText = async (params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  system?: string;
  prompt: string;
}) => {
  const response = await fetch(
    geminiEndpoint(params.baseUrl, `models/${encodeURIComponent(params.model)}:generateContent`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey
      },
      body: JSON.stringify({
        ...(params.system ? { systemInstruction: { parts: [{ text: params.system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }]
      })
    }
  );
  if (!response.ok) await readError(response, 'Gemini GenerateContent request');
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((part: any) => typeof part?.text === 'string')
    .map((part: any) => part.text)
    .join('')
    .trim();
  if (!text) throw new Error('Gemini GenerateContent response contained no text output.');
  return { text, ...getRequestTrace(response, data) };
};

export const pingTextModel = async (params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  format: TextRequestFormat;
  language: 'en' | 'zh';
}) => {
  const expected = params.language === 'zh' ? '你好，避难所监督者' : 'Hello Overseer';
  const instruction = `Reply with exactly this text and nothing else: ${expected}`;
  const baseUrl = resolveBaseUrlForFormat(params.format, params.baseUrl);

  if (params.format === 'gemini-interactions') {
    const result = await callGeminiInteractionsJson({
      apiKey: params.apiKey,
      baseUrl,
      model: params.model,
      system: instruction,
      prompt: instruction
    });
    return {
      text: result.content,
      requestId: result.requestId,
      responseModel: result.responseModel,
      usage: result.usage
    };
  }
  if (params.format === 'gemini-generate-content') {
    return callGeminiGenerateContentText({
      apiKey: params.apiKey,
      baseUrl,
      model: params.model,
      system: instruction,
      prompt: instruction
    });
  }

  if (params.format === 'anthropic-messages') {
    const response = await fetch(appendEndpoint(baseUrl, 'messages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: 64,
        system: instruction,
        messages: [{ role: 'user', content: instruction }]
      })
    });
    if (!response.ok) await readError(response, 'Anthropic Messages ping');
    const data = await response.json();
    const text = data?.content?.find((part: any) => part?.type === 'text')?.text;
    if (!text) throw new Error('Anthropic Messages ping returned no text.');
    return { text: String(text).trim(), ...getRequestTrace(response, data) };
  }

  const isResponses = params.format === 'openai-responses';
  const response = await fetch(
    appendEndpoint(baseUrl, isResponses ? 'responses' : 'chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify(isResponses
        ? { model: params.model, instructions: instruction, input: instruction }
        : { model: params.model, messages: [{ role: 'system', content: instruction }, { role: 'user', content: instruction }] })
    }
  );
  if (!response.ok) {
    await readError(response, isResponses ? 'OpenAI Responses ping' : 'OpenAI Chat Completions ping');
  }
  const data = await response.json();
  const text = isResponses
    ? (data?.output_text || (data?.output || []).flatMap((item: any) => item?.content || []).map((part: any) => part?.text || '').join(''))
    : data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Text ping returned no output.');
  return { text: String(text).trim(), ...getRequestTrace(response, data) };
};

export const generateImageByFormat = async (params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  format: ImageRequestFormat;
  prompt: string;
  aspectRatio?: '1:1' | '16:9';
}): Promise<ImageGenerationResult> => {
  const baseUrl = resolveBaseUrlForFormat(params.format, params.baseUrl);
  const aspectRatio = params.aspectRatio || '1:1';

  if (params.format === 'openai-images') {
    const response = await fetch(appendEndpoint(baseUrl, 'images/generations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        prompt: params.prompt,
        size: aspectRatio === '16:9' ? '1536x1024' : '1024x1024'
      })
    });
    if (!response.ok) await readError(response, 'OpenAI Images request');
    const data = await response.json();
    const item = data?.data?.[0];
    const trace = getRequestTrace(response, data);
    if (item?.b64_json) return { base64: String(item.b64_json), mimeType: String(item.media_type || 'image/png'), ...trace };
    if (item?.url) return { url: String(item.url), ...trace };
    throw new Error('OpenAI Images response contained no image.');
  }

  if (params.format === 'openai-responses') {
    const response = await fetch(appendEndpoint(baseUrl, 'responses'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        input: params.prompt,
        tools: [{ type: 'image_generation' }]
      })
    });
    if (!response.ok) await readError(response, 'OpenAI Responses image request');
    const data = await response.json();
    const call = (data?.output || []).find((item: any) => item?.type === 'image_generation_call' && item?.result);
    if (!call?.result) throw new Error('OpenAI Responses returned no generated image.');
    return { base64: String(call.result), mimeType: 'image/png', ...getRequestTrace(response, data) };
  }

  if (params.format === 'openai-chat-completions') {
    const response = await fetch(appendEndpoint(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: params.prompt }],
        modalities: ['image', 'text'],
        image_config: { aspect_ratio: aspectRatio }
      })
    });
    if (!response.ok) await readError(response, 'OpenAI Chat Completions image request');
    const data = await response.json();
    const imageUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
      || data?.choices?.[0]?.message?.images?.[0]?.url;
    if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) return { base64: match[2], mimeType: match[1], ...getRequestTrace(response, data) };
    }
    if (typeof imageUrl === 'string' && imageUrl) return { url: imageUrl, ...getRequestTrace(response, data) };
    throw new Error('OpenAI Chat Completions returned no generated image.');
  }

  if (params.format === 'gemini-interactions') {
    const response = await fetch(geminiEndpoint(baseUrl, 'interactions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey
      },
      body: JSON.stringify({
        model: params.model,
        input: params.prompt,
        store: false,
        response_format: {
          type: 'image',
          mime_type: 'image/jpeg',
          aspect_ratio: aspectRatio
        }
      })
    });
    if (!response.ok) await readError(response, 'Gemini Interactions image request');
    const data = await response.json();
    const image = extractGeminiInteractionImage(data);
    if (!image) throw new Error('Gemini Interactions response contained no image.');
    return { ...image, ...getRequestTrace(response, data) };
  }

  const response = await fetch(
    geminiEndpoint(baseUrl, `models/${encodeURIComponent(params.model)}:generateContent`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio }
        }
      })
    }
  );
  if (!response.ok) await readError(response, 'Gemini GenerateContent image request');
  const data = await response.json();
  const part = (data?.candidates?.[0]?.content?.parts || []).find((item: any) => item?.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error('Gemini GenerateContent response contained no image.');
  return {
    base64: String(part.inlineData.data),
    mimeType: String(part.inlineData.mimeType || 'image/png'),
    ...getRequestTrace(response, data)
  };
};

export const pingImageModel = async (params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  format: ImageRequestFormat;
}) => generateImageByFormat({
  ...params,
  aspectRatio: '1:1',
  prompt: 'A deliberately low-resolution 64x64 pixel-art portrait of Vault Boy, the cheerful blond retro-futuristic vault mascot, facing forward and giving one clear thumbs-up. Limited green-and-amber Pip-Boy palette, chunky pixels, crisp silhouette, plain dark background, no text.'
});
